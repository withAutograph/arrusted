import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { mapImportCsv, readImportCsv, externalKeyColumn } from "@autograph/csv-workspace/mapping";
import { applyRecordImport } from "@autograph/work-session-tools/records";
import { createLabelIndex, WorkSessionToolInputError } from "@autograph/work-session-tools/labels";
import { createGeneratedAppRuntime } from "../../packages/generated-app-runtime/server";
import type { DataDefinition } from "../../packages/generated-app-runtime/data";
import { verifyCheckedRelease } from "../../packages/generated-app-runtime/release-verification";
import { validateMatchingRuntimeDatabaseUrl } from "./migrate";

const validAuthSchema = /^(?:public|auth_[a-z0-9_]{1,57})$/;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

/** Builder-terminal command: the owner connection delegates an ordinary member write. */
export async function importRecords(input: {
  databaseUrl: string;
  runtimeDatabaseUrl?: string;
  releaseDirectory: string;
  table: string;
  csv: string;
  key?: string;
  authSchema?: string;
}) {
  const authSchema = input.authSchema?.trim() || "public";
  if (!validAuthSchema.test(authSchema)) {
    throw new Error(
      "Invalid authSchema: expected 'public' or an 'auth_<app>' identifier (lowercase alphanumeric/underscore).",
    );
  }
  const trimmedRuntimeUrl = input.runtimeDatabaseUrl?.trim() || undefined;
  const effectiveRuntimeUrl = trimmedRuntimeUrl
    ? validateMatchingRuntimeDatabaseUrl(input.databaseUrl, trimmedRuntimeUrl)
    : input.databaseUrl;
  const memberTable = `${quote(authSchema)}.member`;
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
    databaseUrl: effectiveRuntimeUrl,
    releaseDirectory: input.releaseDirectory,
    appId: schema.app_id,
    customerId: schema.customer_id,
  });
  try {
    // The single-organization starter has no owner role; its first signup is the builder.
    const members = await owner.query(
      `select "userId" from ${memberTable} where "organizationId"=$1 order by "createdAt", id limit 1`,
      [schema.customer_id],
    );
    const actorId = members.rows[0]?.userId;
    if (!actorId) throw new Error("Sign up as the builder before importing records.");
    return await applyRecordImport(
      definition,
      runtime.dataContext({
        actorId,
        sourceKind: "builder-import",
        authorize: async () => {
          const member = await owner.query(
            `select 1 from ${memberTable} where "organizationId"=$1 and "userId"=$2`,
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
  try {
    const [table, file, flag, key, ...extra] = process.argv.slice(2);
    if (!table || !file || (flag !== undefined && (flag !== "--key" || !key)) || extra.length)
      throw new Error("Usage: bun run records:import <table> <file.csv> [--key column]");
    if (!process.env.MIGRATION_DATABASE_URL)
      throw new Error("MIGRATION_DATABASE_URL is required (deployment owner connection).");
    const result = await importRecords({
      databaseUrl: process.env.MIGRATION_DATABASE_URL,
      runtimeDatabaseUrl: process.env.APP_DATABASE_URL?.trim() || undefined,
      releaseDirectory: path.resolve(".generated/release"),
      table,
      csv: readFileSync(file, "utf8"),
      key,
      authSchema: process.env.AUTH_SCHEMA?.trim() || undefined,
    });
    console.log(`Imported ${result.count} records (change set ${result.changeSetId}).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Import failed.");
    process.exitCode = 1;
  }
}
