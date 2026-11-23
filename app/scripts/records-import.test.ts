import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { compileApp, repositoryRoot } from "./compile";
import { migrate, runtimeRoles } from "./migrate";
import { PgDumpRestorePoints } from "./restore-points";

const databaseURL = process.env.KERNEL_TEST_DATABASE_URL;
const suite = databaseURL ? test : test.skip;
const database = `import_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const url = new URL(databaseURL ?? "postgres://unused:unused@127.0.0.1/postgres");
const admin = new Pool({ connectionString: url.href });
url.pathname = `/${database}`;
const pool = new Pool({ connectionString: url.href });
const runtimeUrl = new URL(url);
runtimeUrl.username = `${database}_runtime`;
runtimeUrl.password = "test-runtime-password-at-least-32-characters";
mkdirSync(path.join(repositoryRoot, "app/.local"), { recursive: true });
const directory = mkdtempSync(path.join(repositoryRoot, "app/.local/import-test-"));
const releaseDirectory = path.join(directory, ".generated/release");
let created = false;
const run = (table: string, csv: string, key: string | false = "key") => {
  const file = path.join(directory, "records.csv");
  writeFileSync(file, csv);
  return spawnSync(
    "bun",
    [
      path.join(repositoryRoot, "app/scripts/records-import.ts"),
      table,
      file,
      ...(key ? ["--key", key] : []),
    ],
    {
      cwd: directory,
      env: { ...process.env, MIGRATION_DATABASE_URL: url.href },
      encoding: "utf8",
    },
  );
};
beforeAll(async () => {
  if (!databaseURL) return;
  await admin.query(`create database "${database}"`);
  created = true;
  const source = path.join(directory, "app.cue");
  writeFileSync(
    source,
    `package schema
manifest: #AppManifest & {
 app_id: "starter", customer_id: "starter", version: "import"
 models: [for modelId in ["contact", "company"] {id: modelId, kind: "entity", label: modelId, fields: [
  {id: "name", label: "Name", type: "text", required: true},
  {id: "copied", label: "Copied", type: "text"},
  {id: "code", label: "Code", type: "text"}
 ]}]
}`,
  );
  compileApp({ source, outputDirectory: releaseDirectory });
  const input = {
    databaseUrl: url.href,
    releaseDirectory,
    ...runtimeRoles(url.href, runtimeUrl.href),
    restorePoints: new PgDumpRestorePoints({ directory: path.join(directory, "backups") }),
  };
  await migrate(input);
  expect(
    (
      await pool.query(
        "select rolsuper,rolcreatedb,rolcreaterole,rolbypassrls from pg_roles where rolname=$1",
        [runtimeUrl.username],
      )
    ).rows[0],
  ).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
  expect((await migrate(input)).applied).toBe(false);
}, 240000);
afterAll(async () => {
  await pool.end();
  if (created) {
    const roles = (
      await admin.query("select rolname from pg_roles where starts_with(rolname,$1)", [
        `${database}_`,
      ])
    ).rows;
    await admin.query(`drop database "${database}" with (force)`);
    for (const { rolname } of roles)
      await admin.query(`drop role "${String(rolname).replaceAll('"', '""')}"`);
  }
  await admin.end();
  rmSync(directory, { recursive: true, force: true });
});
suite(
  "builder command imports 50 contacts / 20 companies, fills by key, and audits the member",
  async () => {
    expect(run("contact", "key,name\nc1,Before signup").stderr).toContain("Sign up as the builder");
    await pool.query(`insert into public."user" (id,name,email,"emailVerified") values ('builder','Builder','builder@test.invalid',true), ('later','Later','later@test.invalid',true);
    insert into public.organization (id,name,slug,"createdAt") values ('starter','CRM','starter',now());
    insert into public.member (id,"organizationId","userId",role,"createdAt") values ('builder','starter','builder','member','2026-01-01'), ('later','starter','later','member','2026-02-01')`);
    for (const [table, count] of [
      ["contact", 50],
      ["company", 20],
    ] as const) {
      const result = run(
        table,
        `${table === "company" ? "code" : "key"},name\n` +
          Array.from({ length: count }, (_, i) => `${table}-${i},Name ${i}`).join("\n"),
        table === "company" ? "code" : "key",
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`Imported ${count} records`);
      expect(
        (
          await pool.query(
            `select count(*)::int count from ${table}_version where effective_end is null`,
          )
        ).rows[0].count,
      ).toBe(count);
    }
    expect(
      (
        await pool.query(
          "select code from company_version where effective_end is null order by code",
        )
      ).rows,
    ).toEqual(
      Array.from({ length: 20 }, (_, i) => ({ code: `company-${i}` })).sort((a, b) =>
        a.code.localeCompare(b.code),
      ),
    );
    expect(run("company", "code,copied\ncompany-0,Updated", "code").status).toBe(0);
    expect(
      (
        await pool.query(
          "select code,copied from company_version where effective_end is null and code='company-0'",
        )
      ).rows,
    ).toEqual([{ code: "company-0", copied: "Updated" }]);
    const fill =
      "key,copied\n" + Array.from({ length: 50 }, (_, i) => `contact-${i},Name ${i}`).join("\n");
    expect(run("contact", fill).status).toBe(0);
    expect(run("contact", fill).status).toBe(0);
    expect(
      (
        await pool.query(
          "select count(*)::int count from contact_version where effective_end is null and name=copied",
        )
      ).rows[0].count,
    ).toBe(50);
    expect(
      (
        await pool.query(
          "select distinct actor_id,source_kind from change_set where source_kind='builder-import'",
        )
      ).rows,
    ).toEqual([{ actor_id: "builder", source_kind: "builder-import" }]);
    expect(run("company", "name\nNo key", false).status).toBe(0);
    expect(run("contact", "key,name\ndup,A\ndup,B").stderr).toContain("duplicate external key");
    expect(run("contact", "key,unknown\nnew,value").status).toBe(1);
    expect((await pool.query("select count(*)::int count from contact_record")).rows[0].count).toBe(
      50,
    );
  },
);
