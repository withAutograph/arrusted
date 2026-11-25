import { productionGate, requireNonLoopback } from "./production-gate";
import { reportError, SafeError } from "./safe-output";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { ENV_MIGRATE, ENV_PROD_MIGRATE, readEnv } from "./local-secrets";
import { mapImportCsv, readImportCsv, externalKeyColumn } from "@autograph/csv-workspace/mapping";
import { applyRecordImport } from "@autograph/work-session-tools/records";
import { createLabelIndex, WorkSessionToolInputError } from "@autograph/work-session-tools/labels";
import { createGeneratedAppRuntime } from "../../packages/generated-app-runtime/server";
import type { DataDefinition } from "../../packages/generated-app-runtime/data";
import { verifyCheckedRelease } from "../../packages/generated-app-runtime/release-verification";

/** Builder-terminal command: the owner connection delegates an ordinary member write. */
export async function importRecords(input: {
  databaseUrl: string;
  releaseDirectory: string;
  table: string;
  csv: string;
  key?: string;
}) {
  verifyCheckedRelease(input.releaseDirectory);
  const definition = JSON.parse(
    readFileSync(path.join(input.releaseDirectory, "operation-manifest.json"), "utf8"),
  ) as DataDefinition;
  const { schema } = JSON.parse(
    readFileSync(path.join(input.releaseDirectory, "app-artifact.json"), "utf8"),
  );
  const { headers } = readImportCsv(input.csv);
  if (input.key && !headers.includes(input.key))
    throw new Error(`CSV has no key column: ${input.key}`);
  const rows = mapImportCsv(
    input.csv,
    Object.fromEntries(
      headers.map((header) => [header, header === input.key ? externalKeyColumn : header]),
    ),
  );
  if (input.key) {
    const labels = createLabelIndex(definition);
    const model = labels.model(input.table);
    let field;
    try {
      field = labels.field(model, input.key);
    } catch (error) {
      // An external-key-only heading is allowed; ambiguous field names are not.
      if (!(error instanceof WorkSessionToolInputError) || !error.message.startsWith("unknown "))
        throw error;
    }
    if (field) for (const row of rows) row.values = { ...row.values, [input.key]: row.externalKey };
  }
  const owner = new Pool({ connectionString: input.databaseUrl, max: 1 });
  const runtime = createGeneratedAppRuntime({
    databaseUrl: input.databaseUrl,
    releaseDirectory: input.releaseDirectory,
    appId: schema.app_id,
    customerId: schema.customer_id,
  });
  try {
    // Preserve the existing import actor convention: the earliest deployment member.
    const members = await owner.query(
      'select "userId" from public.member where "organizationId"=$1 order by "createdAt", id limit 1',
      [schema.customer_id],
    );
    const actorId = members.rows[0]?.userId;
    if (!actorId) throw new SafeError("Sign up as the builder before importing records.");
    return await applyRecordImport(
      definition,
      runtime.dataContext({
        actorId,
        sourceKind: "builder-import",
        authorize: async () => {
          const member = await owner.query(
            'select 1 from public.member where "organizationId"=$1 and "userId"=$2',
            [schema.customer_id, actorId],
          );
          if (!member.rowCount) throw new Error("The builder is no longer a member.");
        },
      }),
      {
        model: input.table,
        rows,
        asOf: new Date().toISOString().slice(0, 10),
        requestId: randomUUID(),
      },
    );
  } finally {
    await runtime.close();
    await owner.end();
  }
}

if (import.meta.main) {
  let redactEnv: Record<string, string | undefined> = process.env;
  try {
    const arguments_ = process.argv.slice(2);
    const localOnly = arguments_.includes("--local-only-repo");
    const production = arguments_.includes("--production");
    const [table, file, flag, key, ...extra] = arguments_.filter(
      (arg) => arg !== "--local-only-repo" && arg !== "--production",
    );
    if (!table || !file || (flag !== undefined && (flag !== "--key" || !key)) || extra.length)
      throw new Error(
        "Usage: bun run records:import [--production] <table> <file.csv> [--key column]",
      );
    const appDir = path.resolve(import.meta.dirname, "..");
    let databaseUrl: string | undefined;
    if (production) {
      const prodMigratePath = path.join(appDir, ENV_PROD_MIGRATE);
      if (!existsSync(prodMigratePath))
        throw new SafeError(
          `Missing ${ENV_PROD_MIGRATE}. Run bun run setup:env --production and edit it in a local editor first.`,
        );
      const prodMigrate = readEnv(prodMigratePath);
      redactEnv = { ...process.env, ...prodMigrate };
      databaseUrl = prodMigrate.MIGRATION_DATABASE_URL || undefined;
    } else {
      const localMigrate = readEnv(path.join(appDir, ENV_MIGRATE));
      redactEnv = { ...localMigrate, ...process.env };
      databaseUrl = process.env.MIGRATION_DATABASE_URL ?? localMigrate.MIGRATION_DATABASE_URL;
    }
    if (!databaseUrl)
      throw new Error("MIGRATION_DATABASE_URL is required (deployment owner connection).");
    if (production) requireNonLoopback("MIGRATION_DATABASE_URL", databaseUrl);
    await productionGate(
      databaseUrl,
      "Import CSV records through ordinary writes. Matching external keys update existing records; new keys create records.",
      localOnly,
    );
    const result = await importRecords({
      databaseUrl,
      releaseDirectory: path.resolve(".generated/release"),
      table,
      csv: readFileSync(file, "utf8"),
      key,
    });
    console.log(`Imported ${result.count} records (change set ${result.changeSetId}).`);
  } catch (error) {
    reportError(error, "Import", redactEnv);
    process.exitCode = 1;
  }
}
