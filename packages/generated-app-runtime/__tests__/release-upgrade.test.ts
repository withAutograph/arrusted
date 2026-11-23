import { capabilityRoleFixture } from "./capability-role-fixture";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { Pool } from "pg";
import { buildGeneratedRelease } from "../../../.config/mise/scripts/repository/schema-release";
import { createDataClient, DataFieldActivationPendingError, type DataDefinition } from "../data";
import {
  createGeneratedAppRuntime,
  generatedAppLocalDatabaseUrl,
  installGeneratedAppRuntime,
  type ProtectedInstallationAuthority,
} from "../server";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const appId = "release-upgrade-fixture";
const directory = mkdtempSync(path.join(tmpdir(), "release-upgrade-fixture-"));
const compilerEnvironment = {
  ...process.env,
  CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR ?? path.join(directory, "cargo-target"),
};
const database = `release_upgrade_${randomUUID().replaceAll("-", "")}`;
const url = new URL(
  process.env.DATA_PLANE_PROOF_DATABASE_URL ??
    generatedAppLocalDatabaseUrl({ root, appId: "release-upgrade-proof" }),
);
url.pathname = "/postgres";
const admin = new Pool({ connectionString: url.toString() });
let v1Release: string;
let v2Release: string;
let v1Definition: DataDefinition;
let v2Definition: DataDefinition;
let databaseCreated = false;
let capabilityRoles: string[] = [];
let roleFixture: Awaited<ReturnType<typeof capabilityRoleFixture>> | undefined;
const tenants = ["upgrade-tenant-a", "upgrade-tenant-b"];
const recordIds = new Map<string, string>();
const continuityReceipts = new Map<
  string,
  Awaited<ReturnType<ReturnType<typeof createDataClient>["apply"]>>
>();

const continuityWrite = {
  effectiveStart: "2026-09-16",
  idempotencyKey: "release-upgrade-existing-field",
};

function compileFixture(version: string, predecessors: readonly string[] = []) {
  const cue = path.join(directory, `${version}.cue`);
  writeFileSync(
    cue,
    `package schema
manifest: #AppManifest & {
  app_id: "${appId}"
  customer_id: "fixture-template"
  version: "${version}"
  label: "Release upgrade fixture"
  models: [{
    id: "item", kind: "entity", label: "Item"
    fields: [
      {id: "title", label: "Title", type: "text", required: true},
      ${version === "upgrade-v2" ? '{id: "review_note", label: "Review note", type: "text"},' : ""}
    ]
  }]
}
`,
  );
  const release = buildGeneratedRelease(
    appId,
    directory,
    ["packages/schema-compiler/cue/app-manifest.cue", path.relative(root, cue)],
    root,
    compilerEnvironment,
    predecessors,
  );
  // Generated createOperations delegates this same emitted definition to createDataClient.
  const definition = JSON.parse(
    readFileSync(path.join(release.directory, "operation-manifest.json"), "utf8"),
  ) as DataDefinition;
  return { ...release, definition };
}

beforeAll(async () => {
  try {
    await admin.query("select 1");
  } catch {
    throw new Error(
      "Release-upgrade tests require disposable PostgreSQL in DATA_PLANE_PROOF_DATABASE_URL.",
    );
  }
  const v1 = compileFixture("upgrade-v1");
  const v2 = compileFixture("upgrade-v2", [path.join(v1.directory, "app-artifact.json")]);
  v1Release = v1.directory;
  v2Release = v2.directory;
  v1Definition = v1.definition;
  v2Definition = v2.definition;
  roleFixture = await capabilityRoleFixture(admin);
  await admin.query(`create database "${database}"`);
  databaseCreated = true;
  url.pathname = `/${database}`;
  await installGeneratedAppRuntime({
    appId,
    customerIds: tenants,
    databaseUrl: url.toString(),
    releaseDirectory: v1Release,
  });
  const installed = new Pool({ connectionString: url.toString() });
  capabilityRoles = (
    await installed.query<{ name: string }>(
      "select kernel_installer_capability_role(capability) as name from unnest(array['query','runtime','schema_admin','execution_owner']) capability",
    )
  ).rows.map((row) => row.name);
  const principal = (await installed.query("select session_user::text name")).rows[0].name;
  await roleFixture.grantRuntime(installed, capabilityRoles[1]!, String(principal));
  for (const tenant of tenants) {
    for (const [operation, payload] of [
      ["kernel_bind_principal_scope", { capability: "runtime" }],
      [
        "kernel_bind_actor_membership",
        { actor_id: "upgrade-proof", actor_kind: "human", role: "fixture" },
      ],
    ] as const) {
      const result = await installed.query(`select ${operation}($1::jsonb) result`, [
        JSON.stringify({
          principal_name: principal,
          app_id: appId,
          customer_id: tenant,
          ...payload,
        }),
      ]);
      expect(result.rows[0].result.ok).toBe(true);
    }
  }
  await installed.end();
  for (const tenant of tenants) {
    const v1Runtime = createGeneratedAppRuntime({
      appId,
      customerId: tenant,
      databaseUrl: url.toString(),
      releaseDirectory: v1Release,
    });
    try {
      const operations = createDataClient(
        v1Definition,
        v1Runtime.dataContext({
          actorId: "upgrade-proof",
          sourceKind: "upgrade-proof",
          authorize: async () => {},
        }),
      );
      const write = operations.item!.writes.create({
        title: "Upgrade persistence proof",
      });
      await operations.apply({
        effectiveStart: "2026-09-15",
        idempotencyKey: "release-upgrade-proof-v1",
        notes: "v1 persistence proof",
        writes: [write],
      });
      const records = await operations.item!.list({ asOf: "2026-09-15" });
      expect(records).toHaveLength(1);
      recordIds.set(tenant, records[0]!.id);
    } finally {
      await v1Runtime.close();
    }
  }
}, 120000);

afterAll(async () => {
  try {
    if (databaseCreated) await admin.query(`drop database if exists "${database}"`);
    await roleFixture?.cleanup(capabilityRoles);
  } finally {
    await admin.end();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("recovers a failed atomic upgrade without losing either tenant's active predecessor or its records", async () => {
  const installed = new Pool({ connectionString: url.toString() });
  try {
    // This trigger is an isolated database fault fixture. It fails the second
    // target so the first target's activation must also be rolled back.
    await installed.query(`
      create function fail_upgrade_activation_fixture() returns trigger language plpgsql as $fixture$
      begin
        if new.customer_id = 'upgrade-tenant-b' and new.activated_at is not null and old.activated_at is null then
          raise exception 'Upgrade activation fixture';
        end if;
        return new;
      end;
      $fixture$;
      create trigger fail_upgrade_activation_fixture before update of activated_at on schema_revision
        for each row execute function fail_upgrade_activation_fixture();
    `);
    const upgrade = (authority?: ProtectedInstallationAuthority) =>
      installGeneratedAppRuntime({
        appId,
        customerIds: tenants,
        databaseUrl: url.toString(),
        releaseDirectory: v2Release,
        ...(authority ? { authority } : {}),
      });
    await expect(upgrade()).rejects.toThrow("activation_failed");
    const active = await installed.query<{ customer_id: string; version: string }>(
      "select customer_id, schema->>'version' as version from schema_revision where app_id=$1 and customer_id=any($2::text[]) and activated_at is not null order by customer_id",
      [appId, tenants],
    );
    expect(active.rows).toEqual(
      tenants.map((customer_id) => ({ customer_id, version: path.basename(v1Release) })),
    );
    await installed.query(
      "drop trigger fail_upgrade_activation_fixture on schema_revision; drop function fail_upgrade_activation_fixture()",
    );
    for (const tenant of tenants) {
      const runtime = createGeneratedAppRuntime({
        appId,
        customerId: tenant,
        databaseUrl: url.toString(),
        releaseDirectory: v2Release,
      });
      try {
        const operations = createDataClient(
          v2Definition,
          runtime.dataContext({
            actorId: "upgrade-proof",
            sourceKind: "upgrade-proof",
            authorize: async () => {},
          }),
        );
        const item = operations.item!;
        const recordId = recordIds.get(tenant)!;
        expect(
          await item.get({ key: { type: "record_id", value: recordId }, asOf: "2026-09-15" }),
        ).toMatchObject({
          id: recordId,
          title: "Upgrade persistence proof",
          reviewNote: null,
        });
        expect(await item.list({ asOf: "2026-09-15", select: ["reviewNote"] })).toEqual([
          { reviewNote: null },
        ]);
        await expect(
          item.update(
            recordId,
            { reviewNote: "Written with the upgraded schema" },
            {
              effectiveStart: "2026-09-16",
              idempotencyKey: "release-upgrade-proof-v2",
            },
          ),
        ).rejects.toBeInstanceOf(DataFieldActivationPendingError);
        continuityReceipts.set(
          tenant,
          await item.update(recordId, { title: "Edited during activation" }, continuityWrite),
        );
        expect(
          await item.get({ key: { type: "record_id", value: recordId }, asOf: "2026-09-16" }),
        ).toMatchObject({
          title: "Edited during activation",
          reviewNote: null,
        });
      } finally {
        await runtime.close();
      }
    }
    const activation = Promise.withResolvers<void>();
    const commit = Promise.withResolvers<void>();
    const digest = (name: string) =>
      createHash("sha256")
        .update(readFileSync(path.join(v2Release, name)))
        .digest("hex");
    const installing = upgrade({
      releaseId: path.basename(v2Release),
      artifactHash: digest("app-artifact.json"),
      manifestHash: digest("release-manifest.json"),
      sqlBundleHash: digest("sql-bundle.sql"),
      checkConnection: async () => {},
      beforeEffect: async () => {},
      afterInstall: async () => {
        activation.resolve();
        await commit.promise;
      },
    });
    const customerId = tenants[0]!;
    const runtime = createGeneratedAppRuntime({
      appId,
      customerId,
      databaseUrl: url.toString(),
      releaseDirectory: v2Release,
    });
    try {
      await Promise.race([activation.promise, installing]);
      const operations = createDataClient(
        v2Definition,
        runtime.dataContext({
          actorId: "upgrade-proof",
          sourceKind: "upgrade-proof",
          authorize: async () => {},
        }),
      );
      const reading = operations.item!.list({ asOf: "2026-09-16" });
      try {
        await expect
          .poll(
            async () => {
              const locks = await installed.query<{ waiting: boolean }>(
                `select exists(
                   select 1 from pg_locks
                   where locktype = 'advisory' and mode = 'ShareLock' and not granted
                     and objsubid = 1 and objid = (
                       hashtext('postgres-schema:' || current_schema() ||
                         ':materialize-tenant:' || $1 || ':' || $2 || ':schema-activation')::bigint
                       & 4294967295
                     )::oid
                 ) as waiting`,
                [appId, customerId],
              );
              return locks.rows[0]?.waiting;
            },
            { timeout: 2_000, interval: 25 },
          )
          .toBe(true);
      } finally {
        commit.resolve();
      }
      await expect(reading).resolves.toMatchObject([
        { id: recordIds.get(customerId), title: "Edited during activation", reviewNote: null },
      ]);
    } finally {
      commit.resolve();
      try {
        await installing;
      } finally {
        await runtime.close();
      }
    }
    const upgraded = await installed.query<{ customer_id: string; version: string }>(
      "select customer_id, schema->>'version' as version from schema_revision where app_id=$1 and customer_id=any($2::text[]) and activated_at is not null order by customer_id",
      [appId, tenants],
    );
    expect(upgraded.rows).toEqual(
      tenants.map((customer_id) => ({ customer_id, version: path.basename(v2Release) })),
    );
  } finally {
    await installed.end();
  }
  expect(new Set(recordIds.values()).size).toBe(2);
  for (const tenant of tenants) {
    const runtime = createGeneratedAppRuntime({
      appId,
      customerId: tenant,
      databaseUrl: url.toString(),
      releaseDirectory: v2Release,
    });
    try {
      const operations = createDataClient(
        v2Definition,
        runtime.dataContext({
          actorId: "upgrade-proof",
          sourceKind: "upgrade-proof",
          authorize: async () => {},
        }),
      );
      const records = await operations.item!.list({ asOf: "2026-09-15" });
      const preserved = records.filter((record) => record.id === recordIds.get(tenant));
      expect(records).toHaveLength(1);
      expect(preserved).toHaveLength(1);
      expect(preserved[0]!.id).toBe(recordIds.get(tenant));
      expect(preserved[0]?.title).toBe("Upgrade persistence proof");
      const history = await operations.item!.history({ id: preserved[0]!.id });
      expect(history).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field_id: "title",
            value: { type: "text", value: "Upgrade persistence proof" },
            withheld: false,
            tombstones_record: false,
            untombstones_record: false,
            actor_id: "upgrade-proof",
            source_kind: "upgrade-proof",
            notes: "v1 persistence proof",
          }),
        ]),
      );
      await expect(
        operations.item!.update(
          preserved[0]!.id,
          { title: "Edited during activation" },
          continuityWrite,
        ),
      ).resolves.toEqual(continuityReceipts.get(tenant));
      const write = operations.item!.writes.update(preserved[0]!, {
        reviewNote: "Written with the upgraded schema",
      });
      await operations.apply({
        effectiveStart: "2026-09-16",
        idempotencyKey: "release-upgrade-proof-v2",
        writes: [write],
      });
      expect(await operations.item!.list({ asOf: "2026-09-16" })).toMatchObject([
        {
          id: recordIds.get(tenant),
          title: "Edited during activation",
          reviewNote: "Written with the upgraded schema",
        },
      ]);
    } finally {
      await runtime.close();
    }
  }
}, 120000);
