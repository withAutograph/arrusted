import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { compileSchema } from "../../packages/generated-app-runtime/compile-schema";
import { ResilientPool } from "../../packages/generated-app-runtime/pool";
import { createDataClient, type DataDefinition } from "../../packages/generated-app-runtime/data";
import { createGeneratedAppRuntime } from "../../packages/generated-app-runtime/server";
import { createSingleOrganizationAuth } from "../../packages/auth/single-organization";
import { migrate, rehearse, runtimeRoles, undo } from "./migrate";
import { PgDumpRestorePoints } from "./restore-points";

const databaseURL = process.env.KERNEL_TEST_DATABASE_URL;
if (process.env.CI && !databaseURL) {
  throw new Error(
    "KERNEL_TEST_DATABASE_URL is required in CI to exercise multi-app-shared-db.test.ts.",
  );
}
const suite = databaseURL ? test : test.skip;

const scratchDir = mkdtempSync(path.join(tmpdir(), "multi-app-shared-db-"));
const database = `sunlight_${randomUUID().replaceAll("-", "").slice(0, 14)}`;
const rehearsalDatabase = `${database}_rehearse`;
const crmRole = `${database}_crm_app`;
const companyDataRole = `${database}_cd_app`;
const rolePassword = "local-runtime-password-at-least-32-characters";

const adminUrl = new URL(databaseURL ?? "postgres://postgres@127.0.0.1:5432/postgres");
if (adminUrl.hostname === "localhost") adminUrl.hostname = "127.0.0.1";
const admin = new Pool({ connectionString: adminUrl.toString() });

const ownerUrl = new URL(adminUrl.toString());
ownerUrl.pathname = `/${database}`;
if (!ownerUrl.searchParams.has("sslmode")) ownerUrl.searchParams.set("sslmode", "disable");
const ownerConnectionString = ownerUrl.toString();

const makeRuntimeUrl = (role: string) => {
  const u = new URL(ownerConnectionString);
  u.username = role;
  u.password = rolePassword;
  return u.toString();
};
const crmDatabaseUrl = makeRuntimeUrl(crmRole);
const companyDataDatabaseUrl = makeRuntimeUrl(companyDataRole);

const ownerPool = new Pool({ connectionString: ownerConnectionString });
const restorePoints = new PgDumpRestorePoints({ directory: path.join(scratchDir, "backups") });
let createdPrimaryDb = false;
let createdRehearsalDb = false;

function sharedCueSchema(extraCompanyFields = "") {
  const grantLinkedin =
    Boolean(extraCompanyFields) && !extraCompanyFields.includes('lifecycle: "retired"');
  return `package schema

manifest: #AppManifest & {
  app_id: "sunlight"
  customer_id: "sunlight"
  version: "ignored-authored-version"
  label: "Sunlight Shared Workspace"
  models: [
    {
      id: "company"
      kind: "entity"
      label: "Company"
      fields: [
        {id: "name", label: "Name", type: "text", required: true},
        {id: "domain", label: "Domain", type: "text"}${extraCompanyFields}
      ]
    },
    {
      id: "deal"
      kind: "entity"
      label: "Deal"
      fields: [
        {id: "title", label: "Title", type: "text", required: true},
        {id: "company", label: "Company", type: "relation", target_model: "company", required: true},
        {id: "deal_stage", label: "Deal Stage", type: "text"}
      ]
    },
    {
      id: "company_financials"
      kind: "entity"
      label: "Company Financials"
      fields: [
        {id: "company", label: "Company", type: "relation", target_model: "company", required: true},
        {id: "arr_usd", label: "ARR (USD)", type: "number", required: true},
        {id: "notes", label: "Notes", type: "text"}
      ]
    }
  ]
  authorization: {
    roles: [
      {id: "crm_user", label: "CRM User"},
      {id: "company_data_user", label: "Company Data User"}
    ]
    grants: [
      {
        role: "crm_user"
        model: "company"
        operations: ["read", "create", "update", "history"]
        read_fields: ["$id", "$externalKey", "$version", "$effectiveStart", "$effectiveEnd", "$metadata", "name", "domain"${grantLinkedin ? ', "linkedin_url"' : ""}]
        write_fields: ["name", "domain"${grantLinkedin ? ', "linkedin_url"' : ""}]
        record: {kind: "all"}
      },
      {
        role: "crm_user"
        model: "deal"
        operations: ["read", "create", "update", "delete", "history"]
        read_fields: ["$id", "$version", "title", "company", "deal_stage"]
        write_fields: ["title", "company", "deal_stage"]
        record: {kind: "all"}
      },
      {
        role: "company_data_user"
        model: "company"
        operations: ["read", "create", "update", "history"]
        read_fields: ["$id", "$externalKey", "$version", "$effectiveStart", "$effectiveEnd", "$metadata", "name", "domain"]
        write_fields: ["name", "domain"]
        record: {kind: "all"}
      },
      {
        role: "company_data_user"
        model: "company_financials"
        operations: ["read", "create", "update", "delete", "history"]
        read_fields: ["$id", "$version", "company", "arr_usd", "notes"]
        write_fields: ["company", "arr_usd", "notes"]
        record: {kind: "all"}
      }
    ]
  }
}
`;
}

beforeAll(async () => {
  if (!databaseURL) return;
  await admin.query(`create database "${database}"`);
  createdPrimaryDb = true;
  await admin.query(`create database "${rehearsalDatabase}"`);
  createdRehearsalDb = true;
  // Simulate Neon / PG14+ non-superuser cluster observer & provider admin logins:
  // migrate & --rebind-runtime-login must never false-positive on elevated cluster roles!
  await admin.query(
    `create role "${database}_observer" login password '${rolePassword}' nosuperuser nocreatedb nocreaterole`,
  );
  await admin.query(`grant pg_read_all_data, pg_write_all_data to "${database}_observer"`);
  await admin.query(
    `create role "${database}_provider_admin" login createdb createrole password '${rolePassword}' nosuperuser`,
  );
}, 120_000);

afterAll(async () => {
  const cleanupErrors: unknown[] = [];
  await ownerPool.end().catch((err) => cleanupErrors.push(err));
  if (createdPrimaryDb) {
    await admin
      .query(`drop database if exists "${database}" with (force)`)
      .catch((err) => cleanupErrors.push(err));
  }
  if (createdRehearsalDb) {
    await admin
      .query(`drop database if exists "${rehearsalDatabase}" with (force)`)
      .catch((err) => cleanupErrors.push(err));
  }
  if (createdPrimaryDb || createdRehearsalDb) {
    try {
      const roles = (
        await admin.query("select rolname from pg_roles where starts_with(rolname, $1)", [
          `${database}_`,
        ])
      ).rows;
      for (const { rolname } of roles) {
        await admin
          .query(`drop role if exists "${String(rolname).replaceAll('"', '""')}"`)
          .catch((err) => cleanupErrors.push(err));
      }
    } catch (err) {
      cleanupErrors.push(err);
    }
  }
  await admin.end().catch((err) => cleanupErrors.push(err));
  try {
    rmSync(scratchDir, { recursive: true, force: true });
  } catch (err) {
    cleanupErrors.push(err);
  }
  if (cleanupErrors.length > 0) throw cleanupErrors[0];
});

suite(
  "two apps share company on one Postgres DB with isolated auth_* users, DB-enforced private tables, portable compile, sibling additive continuity, and auth-preserving undo",
  async () => {
    const v1SchemaDir = path.join(scratchDir, "schema-v1");
    mkdirSync(v1SchemaDir, { recursive: true });
    writeFileSync(path.join(v1SchemaDir, "app.cue"), sharedCueSchema());

    // Both apps compile the shared schema independently and get the identical portable buildHash
    const crmV1Out = path.join(scratchDir, "crm-v1", "release");
    const cdV1Out = path.join(scratchDir, "cd-v1", "release");
    const crmCompiledV1 = compileSchema({
      schemaPath: v1SchemaDir,
      outDir: crmV1Out,
      packageVersion: "0.1.0-alpha.1",
      sourceCommit: "commit-v1",
      sourceDirty: false,
    });
    const cdCompiledV1 = compileSchema({
      schemaPath: v1SchemaDir,
      outDir: cdV1Out,
      packageVersion: "0.1.0-alpha.1",
      sourceCommit: "commit-v1",
      sourceDirty: false,
    });

    // Output safety, CRLF line-ending normalization, sibling release metadata isolation, and missing provenance check
    expect(() =>
      compileSchema({
        schemaPath: v1SchemaDir,
        outDir: v1SchemaDir,
        packageVersion: "0.1.0-alpha.1",
      }),
    ).toThrow(/Refusing to overwrite non-empty directory/);
    const crlfSchemaDir = path.join(scratchDir, "schema-crlf");
    mkdirSync(crlfSchemaDir, { recursive: true });
    writeFileSync(path.join(crlfSchemaDir, "app.cue"), sharedCueSchema().replace(/\n/gu, "\r\n"));
    const siblingDirRoot = path.join(scratchDir, "shared-parent");
    const siblingCrmCompiled = compileSchema({
      schemaPath: crlfSchemaDir,
      outDir: path.join(siblingDirRoot, "crm"),
      packageVersion: "0.1.0-alpha.1",
      sourceCommit: "commit-sibling-crm",
      sourceDirty: false,
    });
    expect(siblingCrmCompiled.buildHash).toBe(crmCompiledV1.buildHash);
    const siblingNoCommitOut = path.join(siblingDirRoot, "support");
    compileSchema({
      schemaPath: v1SchemaDir,
      outDir: siblingNoCommitOut,
      packageVersion: "0.1.0-alpha.1",
    });
    expect(
      JSON.parse(readFileSync(`${siblingCrmCompiled.directory}.build.json`, "utf8")).sourceCommit,
    ).toBe("commit-sibling-crm");
    await expect(
      migrate({
        databaseUrl: ownerConnectionString,
        releaseDirectory: siblingNoCommitOut,
        restorePoints,
      }),
    ).rejects.toThrow(/Build provenance is missing/);
    // Differently-named schema directories (schema-v1 vs alt-cue-dir) still produce identical portable buildHash & releaseHash
    const altSchemaDir = path.join(scratchDir, "alt-cue-dir");
    mkdirSync(altSchemaDir, { recursive: true });
    writeFileSync(path.join(altSchemaDir, "app.cue"), sharedCueSchema());
    const altCompiled = compileSchema({
      schemaPath: altSchemaDir,
      outDir: path.join(scratchDir, "alt-v1", "release"),
      packageVersion: "0.1.0-alpha.1",
      sourceCommit: "commit-v1",
      sourceDirty: false,
    });
    expect(crmCompiledV1.buildHash).toBe(cdCompiledV1.buildHash);
    expect(crmCompiledV1.buildHash).toBe(altCompiled.buildHash);
    expect(crmCompiledV1.releaseHash).toBe(altCompiled.releaseHash);
    expect(crmCompiledV1.version).toBe(`build-${crmCompiledV1.buildHash}`);

    // Leftover unpinned ../schema-compiler binary beside hashless build.json is ignored by migrate,
    // while an explicit mismatched compilerBinary is rejected before touching PostgreSQL!
    const staleAdjacentCompiler = path.join(path.dirname(crmV1Out), "schema-compiler");
    writeFileSync(staleAdjacentCompiler, "#!/bin/sh\nexit 99\n", { mode: 0o755 });
    const fakeMismatchCompiler = path.join(scratchDir, "fake-mismatch-compiler.sh");
    writeFileSync(
      fakeMismatchCompiler,
      '#!/bin/sh\necho \'{"checksum":"sha256:0000000000000000000000000000000000000000000000000000000000000000"}\'\n',
      { mode: 0o755 },
    );
    await expect(
      migrate({
        databaseUrl: ownerConnectionString,
        releaseDirectory: crmV1Out,
        restorePoints,
        sourceCommit: "commit-v1",
        sourceDirty: false,
        runtimeRole: crmRole,
        authRole: crmRole,
        authSchema: "auth_crm",
        kernelRole: "crm_user",
        compilerBinary: fakeMismatchCompiler,
        runtimeLogins: [{ role: crmRole, password: rolePassword }],
      }),
    ).rejects.toThrow(/migration compiler differs from the build/);

    // 0. Omitting kernelRole when CUE policy omits 'member' fails fast, and rehearse() succeeds with partial CUE read_fields
    await expect(
      migrate({
        databaseUrl: ownerConnectionString,
        releaseDirectory: crmV1Out,
        restorePoints,
        sourceCommit: "commit-v1",
        sourceDirty: false,
        runtimeRole: crmRole,
        authRole: crmRole,
        authSchema: "auth_crm",
        runtimeLogins: [{ role: crmRole, password: rolePassword }],
      }),
    ).rejects.toThrow(/authorization policy does not declare role 'member'/);

    const rehearsalOwnerUrl = new URL(ownerConnectionString);
    rehearsalOwnerUrl.pathname = `/${rehearsalDatabase}`;
    const rehearsalRuntimeUrl = new URL(rehearsalOwnerUrl.toString());
    rehearsalRuntimeUrl.username = `${database}_reh_crm`;
    rehearsalRuntimeUrl.password = rolePassword;
    const rehearsalSeparateAuthRole = `${database}_reh_crm_auth`;
    await rehearse({
      databaseUrl: rehearsalOwnerUrl.toString(),
      runtimeDatabaseUrl: rehearsalRuntimeUrl.toString(),
      productionDatabaseUrl: ownerConnectionString,
      releaseDirectory: crmV1Out,
      restorePoints: new PgDumpRestorePoints({
        directory: path.join(scratchDir, "rehearsal-backups"),
      }),
      sourceCommit: "commit-v1",
      sourceDirty: false,
      authRole: rehearsalSeparateAuthRole,
      runtimeLogins: [{ role: rehearsalSeparateAuthRole, password: rolePassword }],
      authSchema: "auth_crm",
      kernelRole: "crm_user",
    });

    // Verify Neon -pooler runtime/auth/production URL handling while keeping MIGRATION_DATABASE_URL direct:
    expect(
      runtimeRoles(
        "postgres://neondb_owner:ownerpass@ep-sunlight-123.us-east-2.aws.neon.tech/sunlight?sslmode=verify-full",
        `postgres://crm_app:${rolePassword}@ep-sunlight-123-pooler.us-east-2.aws.neon.tech/sunlight?sslmode=verify-full`,
        `postgres://crm_auth:${rolePassword}@ep-sunlight-123-pooler.us-east-2.aws.neon.tech/sunlight?sslmode=verify-full`,
      ),
    ).toEqual({
      runtimeRole: "crm_app",
      authRole: "crm_auth",
      runtimeLogins: [
        { role: "crm_app", password: rolePassword },
        { role: "crm_auth", password: rolePassword },
      ],
    });
    expect(() =>
      runtimeRoles(
        "postgres://neondb_owner:ownerpass@ep-sunlight-123-pooler.us-east-2.aws.neon.tech/sunlight?sslmode=verify-full",
        `postgres://crm_app:${rolePassword}@ep-sunlight-123-pooler.us-east-2.aws.neon.tech/sunlight?sslmode=verify-full`,
      ),
    ).toThrow(/protected_installer_identity_mismatch/);
    await expect(
      rehearse({
        databaseUrl:
          "postgres://neondb_owner:ownerpass@ep-sunlight-123.us-east-2.aws.neon.tech/sunlight?sslmode=verify-full",
        runtimeDatabaseUrl: `postgres://crm_app:${rolePassword}@ep-sunlight-123-pooler.us-east-2.aws.neon.tech/sunlight?sslmode=verify-full`,
        productionDatabaseUrl: `postgres://crm_app:${rolePassword}@ep-sunlight-123-pooler.us-east-2.aws.neon.tech/sunlight?sslmode=verify-full`,
        releaseDirectory: crmV1Out,
        sourceCommit: "commit-v1",
        sourceDirty: false,
        authSchema: "auth_crm",
        kernelRole: "crm_user",
      }),
    ).rejects.toThrow(/must not target the production database during rehearsal/);

    // Also prove on rehearsal DB that a separate authRole bound to public."user" cannot be reused on an auth_* schema,
    // AND reverse exclusivity: a second login cannot bind onto an already-bound public or auth_* schema!
    const publicAuthRole = `${database}_pub_auth`;
    const publicRuntimeRole = `${database}_pub_rt`;
    await migrate({
      databaseUrl: rehearsalOwnerUrl.toString(),
      releaseDirectory: crmV1Out,
      restorePoints: new PgDumpRestorePoints({
        directory: path.join(scratchDir, "rehearsal-backups"),
      }),
      sourceCommit: "commit-v1",
      sourceDirty: false,
      runtimeRole: publicRuntimeRole,
      authRole: publicAuthRole,
      authSchema: "public",
      kernelRole: "crm_user",
      runtimeLogins: [
        { role: publicRuntimeRole, password: rolePassword },
        { role: publicAuthRole, password: rolePassword },
      ],
    });
    await expect(
      migrate({
        databaseUrl: rehearsalOwnerUrl.toString(),
        releaseDirectory: cdV1Out,
        restorePoints: new PgDumpRestorePoints({
          directory: path.join(scratchDir, "rehearsal-backups"),
        }),
        sourceCommit: "commit-v1",
        sourceDirty: false,
        runtimeRole: `${database}_reh_cd`,
        authRole: publicAuthRole,
        authSchema: "auth_company_data",
        kernelRole: "company_data_user",
        runtimeLogins: [
          { role: `${database}_reh_cd`, password: rolePassword },
          { role: publicAuthRole, password: rolePassword },
        ],
      }),
    ).rejects.toThrow(/already has access to auth schema 'public'/);
    await expect(
      migrate({
        databaseUrl: rehearsalOwnerUrl.toString(),
        releaseDirectory: cdV1Out,
        restorePoints: new PgDumpRestorePoints({
          directory: path.join(scratchDir, "rehearsal-backups"),
        }),
        sourceCommit: "commit-v1",
        sourceDirty: false,
        runtimeRole: `${database}_reh_cd`,
        authRole: `${database}_reh_cd`,
        authSchema: "public",
        kernelRole: "company_data_user",
        runtimeLogins: [{ role: `${database}_reh_cd`, password: rolePassword }],
      }),
    ).rejects.toThrow(/Auth schema 'public' is already bound to runtime login/);

    // 1. Migrate CRM app first (provisions crm_app login + auth_crm schema + crm_user trigger)
    const crmMigrateV1 = await migrate({
      databaseUrl: ownerConnectionString,
      releaseDirectory: crmV1Out,
      restorePoints,
      sourceCommit: "commit-v1",
      sourceDirty: false,
      runtimeRole: crmRole,
      authRole: crmRole,
      authSchema: "auth_crm",
      kernelRole: "crm_user",
      runtimeLogins: [{ role: crmRole, password: rolePassword }],
    });
    expect(crmMigrateV1.applied).toBe(true);

    // Reusing CRM's runtime/auth login for Company Data's auth_company_data schema is refused before changing the DB
    await expect(
      migrate({
        databaseUrl: ownerConnectionString,
        releaseDirectory: cdV1Out,
        restorePoints,
        sourceCommit: "commit-v1",
        sourceDirty: false,
        runtimeRole: crmRole,
        authRole: crmRole,
        authSchema: "auth_company_data",
        kernelRole: "company_data_user",
      }),
    ).rejects.toThrow(/already bound to auth schema 'auth_crm'/);

    // Reverse exclusivity: a second app/login attempting to reuse CRM's auth_crm schema is also refused before changing the DB
    await expect(
      migrate({
        databaseUrl: ownerConnectionString,
        releaseDirectory: cdV1Out,
        restorePoints,
        sourceCommit: "commit-v1",
        sourceDirty: false,
        runtimeRole: companyDataRole,
        authRole: companyDataRole,
        authSchema: "auth_crm",
        kernelRole: "company_data_user",
        runtimeLogins: [{ role: companyDataRole, password: rolePassword }],
      }),
    ).rejects.toThrow(/Auth schema 'auth_crm' is already bound to runtime login/);
    await expect(
      migrate({
        databaseUrl: ownerConnectionString,
        releaseDirectory: cdV1Out,
        restorePoints,
        sourceCommit: "commit-v1",
        sourceDirty: false,
        runtimeRole: crmRole,
        authRole: companyDataRole,
        authSchema: "auth_crm",
        kernelRole: "crm_user",
        runtimeLogins: [{ role: companyDataRole, password: rolePassword }],
      }),
    ).rejects.toThrow(/Auth schema 'auth_crm' already grants Auth access to login/);

    // 2. Migrate Company Data app second against the same DB (idempotent schema, provisions company_data_app + auth_company_data + company_data_user trigger)
    const cdMigrateV1 = await migrate({
      databaseUrl: ownerConnectionString,
      releaseDirectory: cdV1Out,
      restorePoints,
      sourceCommit: "commit-v1",
      sourceDirty: false,
      runtimeRole: companyDataRole,
      authRole: companyDataRole,
      authSchema: "auth_company_data",
      kernelRole: "company_data_user",
      runtimeLogins: [{ role: companyDataRole, password: rolePassword }],
    });
    expect(cdMigrateV1.applied).toBe(false);

    // 3. Provision isolated Better Auth instances in auth_crm and auth_company_data
    const crmAuthPool = new ResilientPool({
      connectionString: crmDatabaseUrl,
      searchPath: "auth_crm",
      max: 2,
    });
    // Plain pg.Pool (without ResilientPool searchPath) exercises createSingleOrganizationAuth's authSchema search_path binding
    const cdAuthPool = new Pool({
      connectionString: companyDataDatabaseUrl,
      max: 2,
    });
    const crmRawPool = new ResilientPool({ connectionString: crmDatabaseUrl, max: 2 });
    const cdRawPool = new ResilientPool({ connectionString: companyDataDatabaseUrl, max: 2 });

    const crmRuntimeV1 = createGeneratedAppRuntime({
      databaseUrl: crmDatabaseUrl,
      releaseDirectory: crmV1Out,
      appId: "sunlight",
      customerId: "sunlight",
    });
    const cdRuntimeV1 = createGeneratedAppRuntime({
      databaseUrl: companyDataDatabaseUrl,
      releaseDirectory: cdV1Out,
      appId: "sunlight",
      customerId: "sunlight",
    });

    try {
      const authSecret = "0123456789abcdef0123456789abcdef";
      const crmAuth = createSingleOrganizationAuth({
        database: crmAuthPool,
        authSchema: "auth_crm",
        origin: "http://crm.localhost:3000",
        secret: authSecret,
        appId: "sunlight-crm",
        organizationId: "sunlight",
        name: "Sunlight CRM",
        allowSignUp: true,
      });
      const cdAuth = createSingleOrganizationAuth({
        database: cdAuthPool,
        authSchema: "auth_company_data",
        origin: "http://company-data.localhost:3001",
        secret: authSecret,
        appId: "sunlight-company-data",
        organizationId: "sunlight",
        name: "Sunlight Company Data",
        allowSignUp: true,
      });

      const aliceSignup = await crmAuth.auth.api.signUpEmail({
        body: { email: "alice@crm.test", password: "Password1234!", name: "Alice CRM" },
        returnHeaders: true,
      });
      const bobSignup = await cdAuth.auth.api.signUpEmail({
        body: { email: "bob@companydata.test", password: "Password1234!", name: "Bob Data" },
        returnHeaders: true,
      });
      const aliceId = aliceSignup.response.user.id;
      const bobId = bobSignup.response.user.id;

      // Users and sessions are completely isolated per app auth_* schema
      const aliceCookie = aliceSignup.headers.get("set-cookie") ?? "";
      const aliceSession = await crmAuth.session(new Headers({ cookie: aliceCookie }));
      expect(aliceSession).toEqual({ actorId: aliceId, customerId: "sunlight" });
      await expect(cdAuth.session(new Headers({ cookie: aliceCookie }))).rejects.toMatchObject({
        status: 401,
      });
      await expect(crmRawPool.query('select * from auth_company_data."user"')).rejects.toThrow(
        /permission denied/i,
      );
      await expect(cdRawPool.query('select * from auth_crm."user"')).rejects.toThrow(
        /permission denied/i,
      );

      // 4. Shared company + DB-enforced private tables
      const v1Def = JSON.parse(
        readFileSync(path.join(crmV1Out, "operation-manifest.json"), "utf8"),
      ) as DataDefinition;
      const crmOps = createDataClient(
        v1Def,
        crmRuntimeV1.dataContext({
          actorId: aliceId,
          sourceKind: "human",
          authorize: async () => {},
        }),
      );
      const cdOps = createDataClient(
        v1Def,
        cdRuntimeV1.dataContext({
          actorId: bobId,
          sourceKind: "human",
          authorize: async () => {},
        }),
      );

      const asOf = "2026-11-26";
      const acmeId = randomUUID();
      const dealId = randomUUID();
      const finId = randomUUID();
      const companySelect = ["id", "$version", "name", "domain"] as const;
      const dealSelect = ["id", "$version", "title", "company", "dealStage"] as const;
      const finSelect = ["id", "$version", "company", "arrUsd", "notes"] as const;

      // Alice (CRM) creates shared company + private deal
      await crmOps.apply({
        effectiveStart: asOf,
        idempotencyKey: "crm-create-acme-and-deal",
        writes: [
          crmOps.company!.writes.create(
            { name: "Acme Corp", domain: "acme.example" },
            { id: acmeId },
          ),
          crmOps.deal!.writes.create(
            {
              title: "Acme Enterprise",
              company: { type: "record_id", value: acmeId },
              dealStage: "qualified",
            },
            { id: dealId },
          ),
        ],
      });

      // Bob (Company Data) sees Acme Corp, updates it, and writes private company_financials
      const cdCompanies = await cdOps.company!.list({ asOf, select: companySelect });
      expect(cdCompanies).toMatchObject([
        { id: acmeId, name: "Acme Corp", domain: "acme.example" },
      ]);

      await cdOps.apply({
        effectiveStart: asOf,
        idempotencyKey: "cd-update-acme-and-create-fin",
        writes: [
          cdOps.company!.writes.update(acmeId, { domain: "acme.io" }),
          cdOps.companyFinancials!.writes.create(
            {
              company: { type: "record_id", value: acmeId },
              arrUsd: "12500000",
              notes: "Audited Q3",
            },
            { id: finId },
          ),
        ],
      });

      // Alice sees Bob's update on shared company
      expect(await crmOps.company!.list({ asOf, select: companySelect })).toMatchObject([
        { id: acmeId, name: "Acme Corp", domain: "acme.io" },
      ]);

      // Cross-app private table reads fail with clear grant_not_authorized error (ported 6d010829e)
      await expect(
        crmOps.companyFinancials!.list({ asOf, select: finSelect }),
      ).rejects.toMatchObject({
        envelope: {
          code: "authorization_denied",
          message: "Read is not authorized by the current grants",
          details: [expect.objectContaining({ code: "grant_not_authorized" })],
        },
      });
      await expect(cdOps.deal!.list({ asOf, select: dealSelect })).rejects.toMatchObject({
        envelope: {
          code: "authorization_denied",
          message: "Read is not authorized by the current grants",
          details: [expect.objectContaining({ code: "grant_not_authorized" })],
        },
      });

      // Cross-app private table writes fail
      await expect(
        crmOps.apply({
          effectiveStart: asOf,
          idempotencyKey: "crm-forbidden-fin-write",
          writes: [
            crmOps.companyFinancials!.writes.create({
              company: { type: "record_id", value: acmeId },
              arrUsd: "999",
            }),
          ],
        }),
      ).rejects.toMatchObject({ envelope: { code: "authorization_denied" } });

      await expect(
        cdOps.apply({
          effectiveStart: asOf,
          idempotencyKey: "cd-forbidden-deal-write",
          writes: [
            cdOps.deal!.writes.create({
              title: "Forbidden Deal",
              company: { type: "record_id", value: acmeId },
            }),
          ],
        }),
      ).rejects.toMatchObject({ envelope: { code: "authorization_denied" } });

      // Raw SQL & actor-spoofing attacks from crm_app connection are blocked by Postgres
      await expect(crmRawPool.query("select * from company_financials_version")).rejects.toThrow(
        /permission denied/i,
      );
      await expect(cdRawPool.query("select * from deal_version")).rejects.toThrow(
        /permission denied/i,
      );
      const spoofedCrmOps = createDataClient(
        v1Def,
        crmRuntimeV1.dataContext({
          actorId: bobId, // Bob is valid in company_data_app, NOT in crm_app!
          sourceKind: "human",
          authorize: async () => {},
        }),
      );
      await expect(
        spoofedCrmOps.company!.list({ asOf, select: companySelect }),
      ).rejects.toMatchObject({
        envelope: { code: "authorization_denied" },
      });

      // Seed a fenced inactive membership BEFORE v2's restore point (RP2) so undo() exercises fenced replay!
      const fencedSignup = await crmAuth.auth.api.signUpEmail({
        body: { email: "fenced@crm.test", password: "Password1234!", name: "Fenced Member" },
      });
      await ownerPool.query(
        `update public.kernel_actor_membership set active = false, fence_generation = 1
          where principal_name = $1::name and actor_id = $2`,
        [crmRole, fencedSignup.user.id],
      );

      // 5. Additive shared-schema evolution (CRM deploys v2 adding CRM-only optional linkedin_url on company while Company Data stays on v1 build!)
      const v2SchemaDir = path.join(scratchDir, "schema-v2");
      mkdirSync(v2SchemaDir, { recursive: true });
      writeFileSync(
        path.join(v2SchemaDir, "app.cue"),
        sharedCueSchema(',\n        {id: "linkedin_url", label: "LinkedIn URL", type: "text"}'),
      );
      const crmV2Out = path.join(scratchDir, "crm-v2", "release");
      compileSchema({
        schemaPath: v2SchemaDir,
        outDir: crmV2Out,
        packageVersion: "0.1.0-alpha.1",
        sourceCommit: "commit-v2",
        sourceDirty: false,
      });

      const crmMigrateV2 = await migrate({
        databaseUrl: ownerConnectionString,
        releaseDirectory: crmV2Out,
        restorePoints,
        sourceCommit: "commit-v2",
        sourceDirty: false,
        runtimeRole: crmRole,
        authRole: crmRole,
        authSchema: "auth_crm",
        kernelRole: "crm_user",
      });
      expect(crmMigrateV2.applied).toBe(true);

      // Running migrate from Company Data's stale v1 checkout after v2 added linkedin_url is refused without --allow-retire
      await expect(
        migrate({
          databaseUrl: ownerConnectionString,
          releaseDirectory: cdV1Out,
          restorePoints,
          sourceCommit: "commit-v1",
          sourceDirty: false,
          runtimeRole: companyDataRole,
          authRole: companyDataRole,
          authSchema: "auth_company_data",
          kernelRole: "company_data_user",
        }),
      ).rejects.toThrow(
        /Refusing to archive existing schema elements \(company\.linkedin_url\) without --allow-retire/,
      );

      // Explicit `lifecycle: "retired"` on an existing field is ALSO refused without --allow-retire
      const explicitRetireSchemaDir = path.join(scratchDir, "schema-explicit-retire");
      mkdirSync(explicitRetireSchemaDir, { recursive: true });
      writeFileSync(
        path.join(explicitRetireSchemaDir, "app.cue"),
        sharedCueSchema(
          ',\n        {id: "linkedin_url", label: "LinkedIn URL", type: "text", lifecycle: "retired"}',
        ),
      );
      const explicitRetireOut = path.join(scratchDir, "explicit-retire", "release");
      compileSchema({
        schemaPath: explicitRetireSchemaDir,
        outDir: explicitRetireOut,
        packageVersion: "0.1.0-alpha.1",
        sourceCommit: "commit-retire",
        sourceDirty: false,
      });
      await expect(
        migrate({
          databaseUrl: ownerConnectionString,
          releaseDirectory: explicitRetireOut,
          restorePoints,
          sourceCommit: "commit-retire",
          sourceDirty: false,
          runtimeRole: crmRole,
          authRole: crmRole,
          authSchema: "auth_crm",
          kernelRole: "crm_user",
        }),
      ).rejects.toThrow(
        /Refusing to archive existing schema elements \(company\.linkedin_url\) without --allow-retire/,
      );

      // Exact idempotency-key replay of a v1 write AFTER v2 migration returns the original v1 receipt!
      const replayedV1Receipt = await cdOps.apply({
        effectiveStart: asOf,
        idempotencyKey: "cd-update-acme-and-create-fin",
        writes: [
          cdOps.company!.writes.update(acmeId, { domain: "acme.io" }),
          cdOps.companyFinancials!.writes.create(
            {
              company: { type: "record_id", value: acmeId },
              arrUsd: "12500000",
              notes: "Audited Q3",
            },
            { id: finId },
          ),
        ],
      });
      expect(replayedV1Receipt.id).toBeTruthy();

      // CRM on v2 populates the CRM-only optional field linkedin_url on shared company!
      const v2Def = JSON.parse(
        readFileSync(path.join(crmV2Out, "operation-manifest.json"), "utf8"),
      ) as DataDefinition;
      const crmRuntimeV2 = createGeneratedAppRuntime({
        databaseUrl: crmDatabaseUrl,
        releaseDirectory: crmV2Out,
        appId: "sunlight",
        customerId: "sunlight",
      });
      try {
        const crmOpsV2 = createDataClient(
          v2Def,
          crmRuntimeV2.dataContext({
            actorId: aliceId,
            sourceKind: "human",
            authorize: async () => {},
          }),
        );
        await crmOpsV2.company!.update(
          acmeId,
          { linkedinUrl: "https://linkedin.com/company/acme" },
          { effectiveStart: asOf, idempotencyKey: "crm-v2-set-linkedin" },
        );

        // Company Data (STILL on v1 definition & runtime!) continues reading (both selected AND unselected full-record list()/get()!)
        // and writing seamlessly even though linkedin_url is NOT granted to company_data_user!
        expect(await cdOps.company!.list({ asOf, select: companySelect })).toMatchObject([
          { id: acmeId, name: "Acme Corp", domain: "acme.io" },
        ]);
        const cdFullCompanies = await cdOps.company!.list({ asOf });
        expect(cdFullCompanies).toHaveLength(1);
        expect(cdFullCompanies[0]).toMatchObject({
          id: acmeId,
          name: "Acme Corp",
          domain: "acme.io",
        });
        expect(cdFullCompanies[0]).not.toHaveProperty("linkedinUrl");
        expect(
          await crmOpsV2.company!.list({
            asOf,
            select: ["id", "domain", "linkedinUrl"],
          }),
        ).toEqual([
          {
            id: acmeId,
            domain: "acme.io",
            linkedinUrl: "https://linkedin.com/company/acme",
          },
        ]);
        // Branded full ModelRecord from unselected additive retry works directly as an update target with $version precondition,
        // and preserves the v2-only linkedinUrl value untouched!
        await cdOps.company!.update(
          cdFullCompanies[0]!,
          { domain: "acme.global" },
          {
            effectiveStart: asOf,
            idempotencyKey: "cd-v1-full-record-update-during-v2",
            ifVersion: String((cdFullCompanies[0] as { $version?: unknown }).$version),
          },
        );
        expect(
          await crmOpsV2.company!.list({
            asOf,
            select: ["id", "domain", "linkedinUrl"],
          }),
        ).toEqual([
          {
            id: acmeId,
            domain: "acme.global",
            linkedinUrl: "https://linkedin.com/company/acme",
          },
        ]);
      } finally {
        await crmRuntimeV2.close();
      }
      expect(
        await cdOps.company!.get({ key: { type: "record_id", value: acmeId }, asOf }),
      ).toMatchObject({
        id: acmeId,
        name: "Acme Corp",
        domain: "acme.global",
      });
      await cdOps.apply({
        effectiveStart: asOf,
        idempotencyKey: "cd-v1-write-during-v2-schema",
        writes: [cdOps.companyFinancials!.writes.update(finId, { notes: "Audited Q4" })],
      });
      expect(await cdOps.companyFinancials!.list({ asOf, select: finSelect })).toMatchObject([
        { id: finId, arrUsd: "12500000", notes: "Audited Q4" },
      ]);

      // Simulate Neon PgBouncer transaction pooling (-pooler) on createSingleOrganizationAuth (authSchema: "auth_crm")
      // sharing two backend connections (crmRole) with kernel_data_query: every transaction resets search_path on commit!
      const { Client: PgClient } = await import("pg");
      const muxBackendA = new PgClient({ connectionString: crmDatabaseUrl });
      const muxBackendB = new PgClient({ connectionString: crmDatabaseUrl });
      let muxConnectedA = false;
      let muxConnectedB = false;
      try {
        await muxBackendA.connect();
        muxConnectedA = true;
        await muxBackendB.connect();
        muxConnectedB = true;
        const baselineSearchPath = (
          await muxBackendA.query<{ search_path: string }>("show search_path")
        ).rows[0]?.search_path;
        let muxIdx = 0;
        let muxPinned: InstanceType<typeof PgClient> | undefined;
        const muxRawClient = {
          query: async (sql: string, values?: unknown[]) => {
            const trimmed = sql.trimStart();
            if (/^(?:begin|start\s+transaction)\b/iu.test(trimmed)) {
              muxPinned = muxIdx++ % 2 === 0 ? muxBackendA : muxBackendB;
              return await muxPinned.query(sql, values);
            }
            if (
              /^(?:commit|end|rollback)\b/iu.test(trimmed) &&
              !/^rollback(?:\s+(?:work|transaction))?\s+to\b/iu.test(trimmed)
            ) {
              const target = muxPinned ?? muxBackendA;
              muxPinned = undefined;
              const res = await target.query(sql, values);
              expect(
                (await target.query<{ search_path: string }>("show search_path")).rows[0]
                  ?.search_path,
              ).toBe(baselineSearchPath);
              await target.query("reset search_path");
              return res;
            }
            const target = muxPinned ?? (muxIdx++ % 2 === 0 ? muxBackendA : muxBackendB);
            const res = await target.query(sql, values);
            if (!muxPinned) {
              await target.query("reset search_path");
            }
            return res;
          },
          release: () => {},
          on: () => muxRawClient,
          once: () => muxRawClient,
          removeListener: () => muxRawClient,
        };
        const fakePlainPool = {
          connect(cb?: (err?: Error, client?: unknown, done?: () => void) => void) {
            if (cb) {
              cb(undefined, muxRawClient, () => {});
              return;
            }
            return Promise.resolve(muxRawClient);
          },
          query(sql: string, values?: unknown[]) {
            return muxRawClient.query(sql, values);
          },
        } as unknown as Pool;

        const muxCrmAuth = createSingleOrganizationAuth({
          database: fakePlainPool,
          authSchema: "auth_crm",
          origin: "http://localhost:3101",
          secret: authSecret,
          appId: "sunlight",
          organizationId: "sunlight",
          name: "Sunlight CRM",
          allowSignUp: true,
        });
        const daveSignup = await muxCrmAuth.auth.api.signUpEmail({
          body: { email: "dave@crm.test", password: "Password1234!", name: "Dave Pooler" },
          returnHeaders: true,
        });
        const daveCookie = daveSignup.headers.get("set-cookie") ?? "";
        for (let i = 0; i < 4; i++) {
          expect(await muxCrmAuth.session(new Headers({ cookie: daveCookie }))).toEqual({
            actorId: daveSignup.response.user.id,
            customerId: "sunlight",
          });
          // Unqualified public kernel function on the SAME backend connections still resolves public!
          expect(
            (
              await muxBackendA.query<{ ok: boolean }>(
                "select (kernel_read_runtime_release_observability($1::jsonb)->>'ok')::boolean as ok",
                [JSON.stringify({ app_id: "sunlight", customer_id: "sunlight" })],
              )
            ).rows[0]?.ok,
          ).toBe(true);
        }
      } finally {
        const muxErrs: unknown[] = [];
        if (muxConnectedA) await muxBackendA.end().catch((e) => muxErrs.push(e));
        if (muxConnectedB) await muxBackendB.end().catch((e) => muxErrs.push(e));
        if (muxErrs.length > 0) throw muxErrs[0];
      }

      // Bind a third app (auth_ops) AFTER RP2 was captured, and rotate its login with --rebind-runtime-login!
      const opsInitialRole = `${database}_ops_init`;
      const opsRole = `${database}_ops_app`;
      await migrate({
        databaseUrl: ownerConnectionString,
        releaseDirectory: crmV2Out,
        restorePoints,
        sourceCommit: "commit-v2",
        sourceDirty: false,
        runtimeRole: opsInitialRole,
        authRole: opsInitialRole,
        authSchema: "auth_ops",
        kernelRole: "company_data_user",
        runtimeLogins: [{ role: opsInitialRole, password: rolePassword }],
      });
      // Cross-app kernelRole hijack is STILL refused even with rebindRuntimeLogin: true (both when changing runtimeRole AND when rotating authRole only)!
      await expect(
        migrate({
          databaseUrl: ownerConnectionString,
          releaseDirectory: crmV2Out,
          restorePoints,
          sourceCommit: "commit-v2",
          sourceDirty: false,
          runtimeRole: opsRole,
          authRole: opsRole,
          authSchema: "auth_ops",
          kernelRole: "crm_user",
          rebindRuntimeLogin: true,
          runtimeLogins: [{ role: opsRole, password: rolePassword }],
        }),
      ).rejects.toThrow(/Auth schema 'auth_ops' is already bound to runtime login/);
      await expect(
        migrate({
          databaseUrl: ownerConnectionString,
          releaseDirectory: crmV2Out,
          restorePoints,
          sourceCommit: "commit-v2",
          sourceDirty: false,
          authRole: opsRole,
          authSchema: "auth_ops",
          kernelRole: "crm_user",
          rebindRuntimeLogin: true,
          runtimeLogins: [{ role: opsRole, password: rolePassword }],
        }),
      ).rejects.toThrow(/Auth schema 'auth_ops' already grants Auth access to login/);
      // Group-inherited Auth grant on auth_ops."user" blocks rotation until the group grant is revoked,
      // while explicit ACLs to elevated cluster observer roles never false-positive!
      await ownerPool.query(`grant select on auth_ops."user" to "${database}_observer"`);
      const opsGroupRole = `${database}_ops_grp`;
      await admin.query(`create role "${opsGroupRole}" nologin`);
      await ownerPool.query(`grant select on auth_ops."user" to "${opsGroupRole}"`);
      await admin.query(`grant "${opsGroupRole}" to "${opsInitialRole}"`);
      await expect(
        migrate({
          databaseUrl: ownerConnectionString,
          releaseDirectory: crmV2Out,
          restorePoints,
          sourceCommit: "commit-v2",
          sourceDirty: false,
          runtimeRole: opsRole,
          authRole: opsRole,
          authSchema: "auth_ops",
          kernelRole: "company_data_user",
          rebindRuntimeLogin: true,
          runtimeLogins: [{ role: opsRole, password: rolePassword }],
        }),
      ).rejects.toThrow(
        /still grants inherited Auth access to login .* via role membership\. Revoke that group grant before rotating logins\./,
      );
      await ownerPool.query(`revoke select on auth_ops."user" from "${opsGroupRole}"`);

      // Seed a fenced-revoked member + fenced actor_access on opsInitialRole BEFORE rotating logins:
      // --rebind-runtime-login must carry fenced state forward to opsRole and revoke runtime capability from opsInitialRole!
      await ownerPool.query(`
        insert into auth_ops."user" (id, name, email, "emailVerified")
          values ('ops-fenced', 'Ops Fenced', 'ops-fenced@ops.test', true);
        insert into auth_ops.organization (id, name, slug, "createdAt")
          values ('sunlight', 'Sunlight Ops', 'sunlight', now())
          on conflict (id) do nothing;
        insert into auth_ops.member (id, "organizationId", "userId", role, "createdAt")
          values ('ops-fenced-m', 'sunlight', 'ops-fenced', 'member', now());
      `);
      await ownerPool.query(
        `update public.kernel_actor_membership set active = false, fence_generation = 2
          where principal_name = $1::name and actor_id = 'ops-fenced'`,
        [opsInitialRole],
      );
      await ownerPool.query(
        `insert into public.kernel_actor_access
           (principal_name, app_id, customer_id, actor_id, active, actor_kind, fence_generation)
         values ($1::name, 'sunlight', 'sunlight', 'ops-fenced', false, 'human', 2)`,
        [opsInitialRole],
      );
      await ownerPool.query(
        `insert into public.kernel_actor_membership
           (principal_name, app_id, customer_id, actor_id, role, actor_kind, active, fence_generation)
         values ($1::name, 'sunlight', 'sunlight', 'ops-sync-worker', 'company_data_user', 'service', true, 0)`,
        [opsInitialRole],
      );

      // Same-app credential rotation succeeds with rebindRuntimeLogin: true, revokes the old login's Auth + runtime access, and preserves fenced revocations!
      await migrate({
        databaseUrl: ownerConnectionString,
        releaseDirectory: crmV2Out,
        restorePoints,
        sourceCommit: "commit-v2",
        sourceDirty: false,
        runtimeRole: opsRole,
        authRole: opsRole,
        authSchema: "auth_ops",
        kernelRole: "company_data_user",
        rebindRuntimeLogin: true,
        runtimeLogins: [{ role: opsRole, password: rolePassword }],
      });
      expect(
        (
          await ownerPool.query<{ active: boolean; fence_generation: string }>(
            "select active, fence_generation::text from public.kernel_actor_membership where principal_name = $1::name and actor_id = 'ops-fenced'",
            [opsRole],
          )
        ).rows,
      ).toEqual([{ active: false, fence_generation: "2" }]);
      expect(
        (
          await ownerPool.query<{ active: boolean; fence_generation: string }>(
            "select active, fence_generation::text from public.kernel_actor_access where principal_name = $1::name and actor_id = 'ops-fenced'",
            [opsRole],
          )
        ).rows,
      ).toEqual([{ active: false, fence_generation: "2" }]);
      expect(
        (
          await ownerPool.query<{ active: boolean; actor_kind: string; fence_generation: string }>(
            "select active, actor_kind, fence_generation::text from public.kernel_actor_membership where principal_name = $1::name and actor_id = 'ops-sync-worker'",
            [opsRole],
          )
        ).rows,
      ).toEqual([{ active: true, actor_kind: "service", fence_generation: "0" }]);
      expect(
        (
          await ownerPool.query<{ active: boolean }>(
            "select active from public.kernel_actor_membership where principal_name = $1::name and actor_id = 'ops-sync-worker'",
            [opsInitialRole],
          )
        ).rows,
      ).toEqual([{ active: false }]);
      expect(
        (
          await ownerPool.query<{ has_cap: boolean }>(
            "select pg_has_role($1, kernel_installer_capability_role('runtime'), 'MEMBER') as has_cap",
            [opsInitialRole],
          )
        ).rows[0]?.has_cap,
      ).toBe(false);
      const opsDatabaseUrl = (() => {
        const u = new URL(ownerConnectionString);
        u.username = opsRole;
        u.password = rolePassword;
        return u.toString();
      })();
      const opsAuthPool = new ResilientPool({
        connectionString: opsDatabaseUrl,
        searchPath: "auth_ops",
        max: 1,
      });
      let erinId = "";
      try {
        const opsAuth = createSingleOrganizationAuth({
          database: opsAuthPool,
          authSchema: "auth_ops",
          origin: "http://localhost:3103",
          secret: authSecret,
          appId: "sunlight",
          organizationId: "sunlight",
          name: "Sunlight Ops",
          allowSignUp: true,
        });
        const erinSignup = await opsAuth.auth.api.signUpEmail({
          body: { email: "erin@ops.test", password: "Password1234!", name: "Erin Post-RP2 App" },
        });
        erinId = erinSignup.user.id;
      } finally {
        await opsAuthPool.end();
      }

      // Verify live trigger updates on the pre-RP2 fenced inactive member do not fail, and undo() preserves its fenced inactive state!
      await ownerPool.query('update auth_crm.member set "userId" = "userId" where "userId" = $1', [
        fencedSignup.user.id,
      ]);

      // 6. Post-restore-point sign-up (Carol) AND post-restore-point membership revocation (Alice) in auth_crm:
      // migrate:undo preserves auth_crm, auth_company_data & auth_ops, activates Carol & Erin, and keeps revoked Alice & fenced member inactive!
      const carolSignup = await crmAuth.auth.api.signUpEmail({
        body: { email: "carol@crm.test", password: "Password1234!", name: "Carol After Backup" },
        returnHeaders: true,
      });
      const carolId = carolSignup.response.user.id;
      await crmAuthPool.query('delete from "member" where "userId" = $1', [aliceId]);

      const undone = await undo({
        databaseUrl: ownerConnectionString,
        releaseDirectory: crmV2Out,
        restorePoints,
      });
      expect(undone.sourceCommit).toBe("commit-v1");
      expect(
        (
          await ownerPool.query<{ active: boolean; fence_generation: string }>(
            "select active, fence_generation::text from public.kernel_actor_membership where principal_name = $1::name and actor_id = $2",
            [crmRole, fencedSignup.user.id],
          )
        ).rows,
      ).toEqual([{ active: false, fence_generation: "1" }]);
      // Post-RP2 fenced revocation ('ops-fenced' at generation 2), fenced actor_access, and service membership on opsRole also survive undo()!
      expect(
        (
          await ownerPool.query<{ active: boolean; fence_generation: string }>(
            "select active, fence_generation::text from public.kernel_actor_membership where principal_name = $1::name and actor_id = 'ops-fenced'",
            [opsRole],
          )
        ).rows,
      ).toEqual([{ active: false, fence_generation: "2" }]);
      expect(
        (
          await ownerPool.query<{ active: boolean; fence_generation: string }>(
            "select active, fence_generation::text from public.kernel_actor_access where principal_name = $1::name and actor_id = 'ops-fenced'",
            [opsRole],
          )
        ).rows,
      ).toEqual([{ active: false, fence_generation: "2" }]);
      expect(
        (
          await ownerPool.query<{ active: boolean; actor_kind: string; fence_generation: string }>(
            "select active, actor_kind, fence_generation::text from public.kernel_actor_membership where principal_name = $1::name and actor_id = 'ops-sync-worker'",
            [opsRole],
          )
        ).rows,
      ).toEqual([{ active: true, actor_kind: "service", fence_generation: "0" }]);

      const opsRuntimeV1 = createGeneratedAppRuntime({
        databaseUrl: opsDatabaseUrl,
        releaseDirectory: cdV1Out,
        appId: "sunlight",
        customerId: "sunlight",
      });
      try {
        // Post-RP2 third app (auth_ops / opsRole) also survives undo() and reads company cleanly!
        const erinOps = createDataClient(
          v1Def,
          opsRuntimeV1.dataContext({
            actorId: erinId,
            sourceKind: "human",
            authorize: async () => {},
          }),
        );
        expect(await erinOps.company!.list({ asOf })).toMatchObject([
          { id: acmeId, name: "Acme Corp", domain: "acme.io" },
        ]);
      } finally {
        await opsRuntimeV1.close();
      }

      // Revoked Alice stays deactivated in kernel_actor_membership even though restorePoint 2 had Alice active!
      await expect(crmOps.company!.list({ asOf, select: companySelect })).rejects.toMatchObject({
        envelope: { code: "authorization_denied" },
      });

      // Carol's login in auth_crm AND her kernel_actor_membership in public survive undo!
      const carolCookie = carolSignup.headers.get("set-cookie") ?? "";
      expect(await crmAuth.session(new Headers({ cookie: carolCookie }))).toEqual({
        actorId: carolId,
        customerId: "sunlight",
      });

      const carolOps = createDataClient(
        v1Def,
        crmRuntimeV1.dataContext({
          actorId: carolId,
          sourceKind: "human",
          authorize: async () => {},
        }),
      );
      expect(await carolOps.company!.list({ asOf, select: companySelect })).toMatchObject([
        { id: acmeId, name: "Acme Corp", domain: "acme.io" },
      ]);
      expect(await carolOps.deal!.list({ asOf, select: dealSelect })).toMatchObject([
        { id: dealId, title: "Acme Enterprise", dealStage: "qualified" },
      ]);
      // Bob in auth_company_data also retains full access after undo (and v2 write rolled back cleanly to Q3!)
      expect(await cdOps.companyFinancials!.list({ asOf, select: finSelect })).toMatchObject([
        { id: finId, arrUsd: "12500000", notes: "Audited Q3" },
      ]);
    } finally {
      await crmRuntimeV1.close();
      await cdRuntimeV1.close();
      await crmRawPool.end();
      await cdRawPool.end();
      await crmAuthPool.end();
      await cdAuthPool.end();
    }
  },
  240_000,
);
