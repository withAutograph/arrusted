import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "@libpg-query/parser";
import { Pool, type PoolClient } from "pg";
import { ResilientPool } from "./pool";
import type { PostgresDataContext, PostgresDataContextInput } from "./postgres";
import { checkedReleaseDirectory, verifyCheckedRelease } from "./release";

export { checkedReleaseDirectory, verifyCheckedRelease } from "./release";
export { resolveGeneratedDiagnostic } from "./diagnostics";
export type { GeneratedDiagnostic } from "./diagnostics";

import { createPostgresDataContext } from "./postgres";
export { createPostgresDataContext } from "./postgres";

import {
  createPostgresKernelClient,
  type CanonicalKernelOperations,
} from "../kernel-client/postgres";

export type GeneratedAppScope = { appId: string; customerId: string };
export type GeneratedAppDataContextInput = Omit<
  PostgresDataContextInput,
  "pool" | "appId" | "customerId" | "verifyRelease"
>;
export type GeneratedAppRuntime = GeneratedAppScope & {
  operations: CanonicalKernelOperations;
  /** Verified server actor/request bindings retain the PostgreSQL transaction surface. */
  dataContext(input: GeneratedAppDataContextInput): PostgresDataContext;
  verifyRelease(): void;
  close(): Promise<void>;
};

export function createGeneratedAppRuntime(
  input: GeneratedAppScope & { databaseUrl: string; releaseDirectory: string; sourceCue?: string },
): GeneratedAppRuntime {
  const appId = input.appId;
  const customerId = input.customerId;
  const databaseUrl = input.databaseUrl;
  const releaseDirectory = input.releaseDirectory;
  const sourceCue = input.sourceCue;
  const release = () => {
    const manifest = verifyCheckedRelease(releaseDirectory, sourceCue);
    if (manifest.app !== appId) throw new Error("Generated release belongs to another application");
    return manifest;
  };
  release();
  const pool = new ResilientPool({ connectionString: databaseUrl, max: 4 });
  return {
    appId,
    customerId,
    operations: createPostgresKernelClient(pool),
    dataContext: (context) =>
      createPostgresDataContext({
        ...context,
        pool,
        appId,
        customerId,
        verifyRelease: release,
      }),
    verifyRelease: release,
    close: () => pool.end(),
  };
}

/** Resolve one generated app's local database endpoint for its repository worktree. */
export function generatedAppLocalDatabaseUrl(input: { root: string; appId: string }): string {
  const environmentName = `${input.appId.toUpperCase().replaceAll("-", "_")}_DATABASE_URL`;
  const configured = process.env[environmentName];
  if (configured) return configured;
  const dataDirectory = path.join(input.root, ".scratch", "generated-app-postgres");
  const port =
    process.env.GENERATED_APP_POSTGRES_PORT ??
    (process.env.CI === "true"
      ? "5432"
      : (existingClusterPort(dataDirectory) ?? worktreePort(input.root)));
  const database = input.appId.replaceAll("-", "_");
  return `postgres://postgres${process.env.CI === "true" ? ":postgres" : ""}@127.0.0.1:${port}/${database}?sslmode=disable`;
}

/**
 * Reset is deliberately owned by the local runtime. It removes only the
 * app's disposable local database and delegates setup back to the same generic
 * lifecycle entrypoint; application code never truncates generated tables.
 */
export async function resetGeneratedAppLocalDemo(
  input: GeneratedAppScope & { root: string; databaseUrl: string },
): Promise<void> {
  const database = new URL(input.databaseUrl).pathname.slice(1);
  if (!/^[a-z][a-z0-9_]*$/u.test(database))
    throw new Error("Local generated app database name is invalid");
  const adminUrl = new URL(input.databaseUrl);
  adminUrl.pathname = "/postgres";
  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  try {
    await admin.query(`drop database if exists ${quoteIdentifier(database)}`);
    await admin.query(`create database ${quoteIdentifier(database)}`);
  } finally {
    await admin.end();
  }
  await setupGeneratedAppLocal({
    ...input,
    releaseDirectory: checkedReleaseDirectory(input.root, input.appId),
  });
}

/** Replay missing deterministic seeds against an already active checked release. */
export async function seedGeneratedAppLocal(
  input: GeneratedAppScope & { databaseUrl: string; releaseDirectory: string; sourceCue?: string },
): Promise<void> {
  verifyCheckedRelease(input.releaseDirectory, input.sourceCue);
  const artifact = JSON.parse(
    readFileSync(path.join(input.releaseDirectory, "app-artifact.json"), "utf8"),
  ) as { extras?: { seed_change_sets?: unknown[] } };
  const pool = new Pool({ connectionString: input.databaseUrl, max: 1 });
  try {
    const active = (await callKernel(pool, "kernel_read_active_schema_revision", {
      app_id: input.appId,
      customer_id: input.customerId,
    })) as { schema_revision_id: number };
    await callKernel(pool, "kernel_apply_seed_defaults", {
      app_id: input.appId,
      customer_id: input.customerId,
      schema_revision_id: active.schema_revision_id,
      change_sets: artifact.extras?.seed_change_sets ?? [],
    });
  } finally {
    await pool.end();
  }
}

/** Install a verified immutable bundle and activate its local demo seed. */
export async function setupGeneratedAppLocal(
  input: GeneratedAppScope & { databaseUrl: string; releaseDirectory: string; sourceCue?: string },
): Promise<void> {
  await installGeneratedAppRelease(input, true, "local");
}

/** Operator-owned hosted installation never copies a source release's demo seeds. */
export async function installGeneratedAppProduction(
  input: GeneratedAppScope & { databaseUrl: string; releaseDirectory: string; sourceCue?: string },
): Promise<{ releaseId: string; artifactHash: string }> {
  return installGeneratedAppRelease(input, false, "operator");
}

/** Only the protected operator supplies these identities, independently of release files. */
export type ProtectedInstallationAuthority = {
  releaseId: string;
  artifactHash: string;
  manifestHash: string;
  sqlBundleHash: string;
  checkConnection(client: PoolClient): Promise<void>;
  beforeEffect(): Promise<void>;
  afterInstall?(client: PoolClient): Promise<void>;
};

/** Prepare an explicit tenant set before one atomic app-base activation. */
export async function installGeneratedAppRuntime(input: {
  appId: string;
  customerIds: readonly string[];
  authority?: ProtectedInstallationAuthority;
  databaseUrl: string;
  releaseDirectory: string;
  sourceCue?: string;
  /** The deploy coordinator owns BEGIN/COMMIT so activation and its record are atomic. */
  client?: PoolClient;
  /** Compiled against the predecessor read under the deploy advisory lock. */
  transitionContract?: unknown;
}): Promise<{ releaseId: string; artifactHash: string }> {
  const customerIds = [...input.customerIds];
  if (
    customerIds.length === 0 ||
    customerIds.some((customerId) => !customerId.trim()) ||
    new Set(customerIds).size !== customerIds.length
  ) {
    throw new Error("App-base installation requires a nonempty, unique tenant set");
  }
  return installGeneratedAppRelease(
    { ...input, customerId: customerIds[0]! },
    false,
    "operator",
    customerIds,
    input.authority,
    input.client,
    input.transitionContract,
  );
}

/** Compatibility name for existing operator and app-owned validation callers. */
export const installGeneratedAppProductionTargets = installGeneratedAppRuntime;

async function installGeneratedAppRelease(
  input: GeneratedAppScope & { databaseUrl: string; releaseDirectory: string; sourceCue?: string },
  includeDemoSeeds: boolean,
  materializationSource: "local" | "operator",
  customerIds?: readonly string[],
  authority?: ProtectedInstallationAuthority,
  suppliedClient?: PoolClient,
  suppliedTransitionContract?: unknown,
): Promise<{ releaseId: string; artifactHash: string }> {
  const manifest = verifyCheckedRelease(input.releaseDirectory, input.sourceCue);
  if (manifest.app !== input.appId) {
    throw new Error("Checked release does not match the requested application");
  }
  const artifactBytes = readFileSync(path.join(input.releaseDirectory, "app-artifact.json"));
  const transitionBytes = readFileSync(
    path.join(input.releaseDirectory, "transition-contract.json"),
  );
  const sqlManifestBytes = readFileSync(path.join(input.releaseDirectory, "sql-manifest.json"));
  const bundle = readFileSync(path.join(input.releaseDirectory, "sql-bundle.sql"), "utf8");
  if (authority) {
    const manifestBytes = readFileSync(path.join(input.releaseDirectory, "release-manifest.json"));
    if (
      manifest.schema_version !== authority.releaseId ||
      hashValue(sha256(artifactBytes)) !== authority.artifactHash ||
      hashValue(sha256(manifestBytes)) !== authority.manifestHash ||
      JSON.stringify(JSON.parse(manifestBytes.toString("utf8"))) !== JSON.stringify(manifest) ||
      hashValue(sha256(Buffer.from(bundle))) !== authority.sqlBundleHash ||
      sha256(transitionBytes) !== manifest.hashes.transition_contract ||
      sha256(sqlManifestBytes) !== manifest.hashes.sql_manifest
    ) {
      throw new Error("Protected release differs from operator-pinned artifact or installer");
    }
  }
  // These exact bytes are consumed below; no file is reopened after the authority checks.
  const artifact = JSON.parse(artifactBytes.toString("utf8")) as {
    schema: Record<string, unknown>;
    extras?: { seed_change_sets?: unknown[] };
  };
  if (authority && suppliedTransitionContract !== undefined)
    throw new Error("A protected installation cannot override its pinned transition contract");
  const transitionContract =
    suppliedTransitionContract ?? JSON.parse(transitionBytes.toString("utf8"));
  const sqlManifest = JSON.parse(sqlManifestBytes.toString("utf8")) as { checksum: string };
  const schemaArtifactHash = manifest.hashes.schema!;
  let transactionalBundle = bundle;
  if (customerIds) {
    const parsed = await parse(bundle);
    const transactions = (parsed.stmts ?? []).filter(
      (statement) => "TransactionStmt" in (statement.stmt ?? {}),
    );
    if (
      transactions.length !== 2 ||
      [...bundle.matchAll(/^begin;\s*$/gimu)].length !== 1 ||
      [...bundle.matchAll(/^commit;\s*$/gimu)].length !== 1
    )
      throw new Error("Protected release has an unexpected transaction boundary");
    transactionalBundle = bundle.replace(/^begin;\s*$/imu, "").replace(/^commit;\s*$/imu, "");
  }
  const pool = suppliedClient
    ? undefined
    : new Pool({ connectionString: input.databaseUrl, max: 1 });
  let client: PoolClient | undefined;
  try {
    client = suppliedClient ?? (await pool!.connect());
    await authority?.checkConnection(client);
    await authority?.beforeEffect();
    if (customerIds && !suppliedClient) await client.query("BEGIN");
    // Keep the checked bundle, preparation, activation, and protected readback atomic.
    await client.query(transactionalBundle);
    const targets: Array<{
      customer_id: string;
      schema_revision_id: number;
      effective_artifact_hash: string;
      expected_active_effective_hash: string | null;
    }> = [];
    for (const customerId of customerIds ?? [input.customerId]) {
      const schema = includeDemoSeeds
        ? artifact.schema
        : { ...artifact.schema, customer_id: customerId };
      const scopedTransitionContract = includeDemoSeeds
        ? transitionContract
        : rebindTransitionContract(transitionContract, customerId);
      const schemaHash = includeDemoSeeds
        ? hashValue(sqlManifest.checksum)
        : (
            await client.query<{ hash: string }>(
              "select kernel_admin_sha256(kernel_canonical_json($1::jsonb)) as hash",
              [JSON.stringify(schema)],
            )
          ).rows[0]?.hash;
      if (!schemaHash) throw new Error("Generated schema hash is unavailable");
      const active = await client.query<{ effective_artifact_hash: string }>(
        "select sir.effective_artifact_hash from schema_revision sr join schema_installation_revision sir on sir.schema_revision_id = sr.id where sr.app_id = $1 and sr.customer_id = $2 and sr.activated_at is not null",
        [input.appId, customerId],
      );
      const expectedActiveEffectiveHash = active.rows[0]?.effective_artifact_hash ?? null;
      const request = {
        app_id: input.appId,
        customer_id: customerId,
        version: manifest.schema_version,
        release_id: manifest.schema_version,
        activation_kind: "app_base",
        schema_hash: schemaHash,
        base_artifact_hash: hashValue(schemaArtifactHash),
        effective_artifact_hash: hashValue(schemaArtifactHash),
        materialization_plan_hash: hashValue(sha256(Buffer.from("[]"))),
        expected_active_effective_hash: expectedActiveEffectiveHash,
        materialization_source: materializationSource,
        materialization_git_sha: null,
        materialization_vercel_deployment_id: null,
        materialization_vercel_environment: null,
        materialization_vercel_git_ref: null,
        base_schema: schema,
        customer_overlay: {},
        schema,
        seed_change_sets: includeDemoSeeds ? (artifact.extras?.seed_change_sets ?? []) : [],
        phase_plan: [],
        transition_contract: scopedTransitionContract,
      };
      const prepared = (await callKernel(
        client,
        "kernel_prepare_schema_revision",
        request,
        authority ? () => authority.beforeEffect() : undefined,
      )) as {
        schema_revision_id: number;
        effective_artifact_hash: string;
      };
      try {
        await callKernel(
          client,
          "kernel_validate_schema_revision_readiness",
          {
            app_id: input.appId,
            customer_id: customerId,
            schema_revision_id: prepared.schema_revision_id,
            effective_artifact_hash: prepared.effective_artifact_hash,
            materialization_plan_hash: hashValue(sha256(Buffer.from("[]"))),
            phase_results: [],
          },
          authority ? () => authority.beforeEffect() : undefined,
        );
      } catch (error) {
        // A checked release already activated for this local database is setup's
        // idempotent success case; it must not be prepared or seeded again.
        if (error instanceof Error && error.message.includes("revision_already_active")) {
          if (!customerIds)
            return {
              releaseId: manifest.schema_version,
              artifactHash: hashValue(schemaArtifactHash),
            };
        } else throw error;
      }
      // A replayed active target retains its original CAS expectation. Reading
      // only this explicitly requested revision keeps the target set exact; the
      // kernel rejects omitted targets and partially active expansions.
      const activationExpectation = customerIds
        ? (
            await client.query<{ expected_active_effective_hash: string | null }>(
              "select expected_active_effective_hash from schema_installation_revision where schema_revision_id = $1 and app_id = $2 and customer_id = $3",
              [prepared.schema_revision_id, input.appId, customerId],
            )
          ).rows[0]
        : { expected_active_effective_hash: expectedActiveEffectiveHash };
      if (!activationExpectation) throw new Error("Prepared activation expectation is unavailable");
      targets.push({
        customer_id: customerId,
        schema_revision_id: prepared.schema_revision_id,
        effective_artifact_hash: prepared.effective_artifact_hash,
        expected_active_effective_hash: activationExpectation.expected_active_effective_hash,
      });
    }
    await callKernel(
      client,
      "kernel_activate_app_base_schema_revision",
      {
        app_id: input.appId,
        release_id: manifest.schema_version,
        base_artifact_hash: hashValue(schemaArtifactHash),
        targets,
      },
      authority ? () => authority.beforeEffect() : undefined,
    );
    if (customerIds) {
      await authority?.afterInstall?.(client);
      await authority?.beforeEffect();
      if (!suppliedClient) await client.query("COMMIT");
    }
    return { releaseId: manifest.schema_version, artifactHash: hashValue(schemaArtifactHash) };
  } catch (error) {
    if (customerIds && client && !suppliedClient) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    if (!suppliedClient) client?.release();
    await pool?.end();
  }
}

function rebindTransitionContract(value: unknown, customerId: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const contract = value as { predecessors?: Array<{ schema?: Record<string, unknown> }> };
  if (!Array.isArray(contract.predecessors)) return value;
  return {
    ...contract,
    predecessors: contract.predecessors.map((predecessor) => ({
      ...predecessor,
      schema: predecessor.schema
        ? { ...predecessor.schema, customer_id: customerId }
        : predecessor.schema,
    })),
  };
}

async function callKernel(
  pool: Pool | PoolClient,
  operation: string,
  request: unknown,
  beforeEffect?: () => Promise<void>,
): Promise<unknown> {
  await beforeEffect?.();
  const result = await pool.query(`select ${operation}($1::jsonb) as result`, [
    JSON.stringify(request),
  ]);
  const envelope = result.rows[0]?.result as {
    ok?: boolean;
    data?: unknown;
    error?: { message?: string };
  };
  if (!envelope?.ok)
    throw new Error(`${operation}: ${JSON.stringify(envelope?.error ?? "failed")}`);
  return envelope.data;
}

function sha256(value: Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
function hashValue(value: string): string {
  return value.replace(/^sha256:/u, "");
}
function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
function worktreePort(directory: string): string {
  const value = createHash("sha256").update(directory).digest().readUInt16BE(0);
  return String(45000 + (value % 10000));
}
function existingClusterPort(directory: string): string | undefined {
  const pidFile = path.join(directory, "postmaster.pid");
  if (!existsSync(pidFile)) return undefined;
  const port = readFileSync(pidFile, "utf8").split("\n")[3]?.trim();
  return port && /^[0-9]{2,5}$/u.test(port) ? port : undefined;
}
