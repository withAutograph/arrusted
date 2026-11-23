import { createHash } from "node:crypto";
import { lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import { z } from "zod";
import {
  assertProtectedConnection,
  protectedDatabaseResourceSchema,
  verifyProtectedConnection,
} from "./protected-installer";
import {
  tenantExportArtifactManifestSchema,
  tenantExportWorkerInputSchema,
  type TenantExportArtifactManifest,
  type TenantExportDataMember,
  type TenantExportWorkerInput,
} from "./protected-export-contract";

export const tenantExportSpoolRoot = "/tmp/autograph-tenant-export";
export const tenantExportInputRoot = "/tmp/autograph-tenant-export-input";
export const tenantExportChunkBytes = 65_536;
export const tenantExportCredentialEnvironment = "AUTOGRAPH_TENANT_EXPORT_APP_MIGRATOR_URL";
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** Private server-derived location. No caller-selected path is part of the worker wire. */
export function tenantExportSpoolDirectory(input: TenantExportWorkerInput): string {
  const parsed = tenantExportWorkerInputSchema.parse(input);
  return path.join(tenantExportSpoolRoot, parsed.exportId, parsed.attemptId);
}

export function tenantExportInputPath(input: TenantExportWorkerInput): string {
  const parsed = tenantExportWorkerInputSchema.parse(input);
  return path.join(tenantExportInputRoot, parsed.exportId, `${parsed.attemptId}.json`);
}

async function privateParent(directory: string): Promise<void> {
  await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    (stat.mode & 0o777) !== 0o700 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error("tenant_export_private_directory_invalid");
}

/** Metadata only. The caller captures manifest/member bytes over its private source port. */
export const tenantExportWorkerResultSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("tenant-export-worker-result"),
  state: z.literal("complete"),
  exportId: z.uuid(),
  attemptId: z.uuid(),
  snapshotId: z.uuid(),
  planDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  rowCount: z.string().regex(/^(?:0|[1-9][0-9]*)$/u),
  byteLength: z.string().regex(/^(?:0|[1-9][0-9]*)$/u),
});
export type TenantExportWorkerResult = z.infer<typeof tenantExportWorkerResultSchema>;

/**
 * Fixed trusted export: one exact tenant, approved installation, and read-only snapshot.
 * Provider resource IDs and approval/owner authority are verified by the operator.
 */
export async function exportProtectedTenant(
  metadata: TenantExportWorkerInput,
  appMigratorUrl: string,
): Promise<TenantExportWorkerResult> {
  const input = tenantExportWorkerInputSchema.parse(metadata);
  const { projectId: _project, branchId: _branch, ...resourceFields } = input.resource;
  const resource = protectedDatabaseResourceSchema.parse(resourceFields);
  assertProtectedConnection(appMigratorUrl, resource, "migrator");
  await privateParent(tenantExportSpoolRoot);
  await privateParent(path.join(tenantExportSpoolRoot, input.exportId));
  const directory = tenantExportSpoolDirectory(input);
  // An existing/uncertain attempt is never overwritten or silently restarted.
  await mkdir(directory, { mode: 0o700 });
  const pool = new Pool({ connectionString: appMigratorUrl, max: 1 });
  let client: PoolClient | undefined;
  const files: TenantExportDataMember[] = [];
  try {
    client = await pool.connect();
    await client.query("begin isolation level repeatable read read only");
    await client.query(
      "select set_config('kernel.app_id',$1,true), set_config('kernel.customer_id',$2,true)",
      [input.scope.appId, input.scope.customerId],
    );
    await verifyProtectedConnection(client, resource, "migrator");
    const installed = await client.query<{
      release_id: string;
      version: string;
      base_artifact_hash: string;
      effective_artifact_hash: string;
      ready: boolean;
    }>(
      `select sir.release_id, sr.version, sir.base_artifact_hash, sir.effective_artifact_hash,
         (sir.ready_at is not null and sir.activated_at is not null and sr.materialized_at is not null) as ready
       from public.schema_revision sr
       join public.schema_installation_revision sir on sir.schema_revision_id=sr.id
       where sr.app_id=$1 and sr.customer_id=$2 and sr.activated_at is not null
         and sir.app_id=$1 and sir.customer_id=$2 and sir.activation_kind='app_base'`,
      [input.scope.appId, input.scope.customerId],
    );
    const selected = installed.rows[0];
    if (
      installed.rows.length !== 1 ||
      selected?.ready !== true ||
      selected.release_id !== input.release.id ||
      selected.version !== input.release.id ||
      selected.base_artifact_hash !== input.release.artifactHash ||
      selected.effective_artifact_hash !== input.release.artifactHash
    )
      throw new Error("tenant_export_installation_mismatch");
    const catalog = await client.query<{ name: string }>(
      `select c.relname as name from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relkind in ('r','p')
         and exists(select 1 from pg_catalog.pg_attribute a where a.attrelid=c.oid and a.attname='app_id' and a.attnum>0 and not a.attisdropped)
         and exists(select 1 from pg_catalog.pg_attribute a where a.attrelid=c.oid and a.attname='customer_id' and a.attnum>0 and not a.attisdropped)
       order by c.relname collate "C"`,
    );
    for (const [position, table] of catalog.rows.entries()) {
      const name = `table-${String(position + 1).padStart(6, "0")}.ndjson`;
      const file = await open(path.join(directory, name), "wx", 0o600);
      const hash = createHash("sha256");
      const chunks: TenantExportDataMember["chunks"] = [];
      let pending = Buffer.alloc(0);
      let rowCount = 0n;
      let byteLength = 0n;
      const chunk = (bytes: Buffer) => {
        const sha256 = digest(bytes);
        chunks.push({
          index: chunks.length,
          byteLength: String(bytes.length),
          sha256,
          artifactRef: `_protected-operator/artifacts/tenant-export/${input.exportId}/${input.attemptId}/data/${sha256}`,
        });
      };
      try {
        await client.query(
          `declare tenant_export cursor for select row_to_json(t)::text as json from public.${identifier(table.name)} t where app_id=$1 and customer_id=$2`,
          [input.scope.appId, input.scope.customerId],
        );
        for (;;) {
          const batch = await client.query<{ json: string }>(
            "fetch forward 500 from tenant_export",
          );
          if (batch.rows.length === 0) break;
          for (const row of batch.rows) {
            const bytes = Buffer.from(`${row.json}\n`);
            await file.writeFile(bytes);
            hash.update(bytes);
            rowCount += 1n;
            byteLength += BigInt(bytes.length);
            let offset = 0;
            while (offset < bytes.length) {
              const take = Math.min(tenantExportChunkBytes - pending.length, bytes.length - offset);
              pending = Buffer.concat([pending, bytes.subarray(offset, offset + take)]);
              offset += take;
              if (pending.length === tenantExportChunkBytes) {
                chunk(pending);
                pending = Buffer.alloc(0);
              }
            }
          }
        }
        await client.query("close tenant_export");
        if (pending.length > 0) chunk(pending);
        await file.sync();
      } finally {
        await file.close();
      }
      files.push({
        kind: "data",
        name,
        table: { schema: "public", name: table.name },
        rowCount: String(rowCount),
        byteLength: String(byteLength),
        sha256: hash.digest("hex"),
        chunks,
      });
    }
    await client.query("commit");
    const manifest: TenantExportArtifactManifest = tenantExportArtifactManifestSchema.parse({
      version: 1,
      kind: "tenant-export",
      exportId: input.exportId,
      attemptId: input.attemptId,
      snapshotId: input.snapshotId,
      planDigest: input.planDigest,
      scope: input.scope,
      resource: input.resource,
      release: input.release,
      format: "ndjson",
      files,
      rowCount: String(files.reduce((sum, member) => sum + BigInt(member.rowCount), 0n)),
      byteLength: String(files.reduce((sum, member) => sum + BigInt(member.byteLength), 0n)),
    });
    const bytes = Buffer.from(JSON.stringify(manifest));
    const file = await open(path.join(directory, "manifest.json"), "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    return {
      version: 1,
      kind: "tenant-export-worker-result",
      state: "complete",
      exportId: input.exportId,
      attemptId: input.attemptId,
      snapshotId: input.snapshotId,
      planDigest: input.planDigest,
      manifestSha256: digest(bytes),
      rowCount: manifest.rowCount,
      byteLength: manifest.byteLength,
    };
  } catch (error) {
    await client?.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client?.release();
    await pool.end();
  }
}
