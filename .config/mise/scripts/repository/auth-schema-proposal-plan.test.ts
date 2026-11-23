import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { createAuthSchemaOptions } from "./auth-enrolled-provision";
import { planAuthSchemaMigration, proposeEmptyAuthSchemaMigration } from "./auth-schema-history";
import { proposeAuthSchemaMigration } from "./auth-schema-proposal-plan";

it("proposes the populated existing Auth schema without applying schema or access changes", async () => {
  const root = path.resolve(import.meta.dirname, "../../../..");
  const directory = await mkdtemp(path.join(tmpdir(), "auth-existing-proposal-"));
  const password = randomUUID();
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No fixture port");
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
  const run = (cmd: string, args: string[]) => {
    const result = spawnSync(cmd, args, { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  };
  const databaseDirectory = path.join(directory, "postgres");
  const passwordFile = path.join(directory, "password");
  let pool: Pool | undefined;
  let started = false;
  try {
    await writeFile(passwordFile, password, { mode: 0o600 });
    run("initdb", [
      "-D",
      databaseDirectory,
      "--username=auth_migrator",
      "--auth=scram-sha-256",
      `--pwfile=${passwordFile}`,
      "--no-locale",
      "--encoding=UTF8",
    ]);
    run("pg_ctl", [
      "-D",
      databaseDirectory,
      "-l",
      path.join(directory, "postgres.log"),
      "-o",
      `-h 127.0.0.1 -p ${port} -k ${directory}`,
      "-w",
      "start",
    ]);
    started = true;
    const resource = {
      version: 1 as const,
      environment: "local" as const,
      hostname: "127.0.0.1",
      port,
      database: "owned_auth",
      schema: "public" as const,
      runtimeRole: "auth_runtime",
      migratorRole: "auth_migrator",
    };
    const admin = new Pool({
      connectionString: `postgres://auth_migrator:${password}@127.0.0.1:${port}/postgres?sslmode=disable`,
    });
    try {
      await admin.query("create database owned_auth");
    } finally {
      await admin.end();
    }
    const connectionString = `postgres://auth_migrator:${password}@127.0.0.1:${port}/owned_auth?sslmode=disable`;
    pool = new Pool({ connectionString, max: 2 });
    await pool.query(await readFile(path.join(root, "packages/auth/schema.sql"), "utf8"));
    await pool.query(
      `insert into "user" (id,name,email,"emailVerified") values ('existing-user','Existing User','existing@example.test',true)`,
    );
    const directMigrationUrlFile = path.join(directory, "migration-url");
    await writeFile(directMigrationUrlFile, connectionString, { mode: 0o600 });
    const input = { resource, catalogAppIds: ["spend-review"] };
    const empty = await proposeAuthSchemaMigration(input);
    expect(empty).toEqual(await proposeEmptyAuthSchemaMigration(input));
    const proposal = await proposeAuthSchemaMigration({ ...input, directMigrationUrlFile });
    const executable = path.join(directory, "auth-protected-propose");
    run("bun", [
      path.join(root, ".config/mise/scripts/repository/build-protected-auth-proposal.mjs"),
      executable,
      `bun-${process.platform}-${process.arch}`,
    ]);
    const inputFile = path.join(directory, "input.json");
    await writeFile(inputFile, JSON.stringify({ ...input, directMigrationUrlFile }), {
      mode: 0o600,
    });
    const actual = spawnSync(executable, ["--input-file", inputFile], {
      cwd: directory,
      env: {},
      encoding: "utf8",
    });
    expect(actual.status, actual.stderr).toBe(0);
    expect(JSON.parse(actual.stdout)).toEqual(proposal);
    expect(actual.stdout).not.toContain(password);
    expect(actual.stderr).not.toContain(password);
    expect(proposal).not.toHaveProperty("proposal");
    expect(proposal.schemaPlan).toEqual(
      await planAuthSchemaMigration({ ...input, pool, options: createAuthSchemaOptions(pool) }),
    );
    expect(proposal.schemaPlan.beforeSchemaHash).not.toBe(empty.schemaPlan.beforeSchemaHash);
    expect(proposal.schemaPlan.planDigest).not.toBe(empty.schemaPlan.planDigest);
    expect(
      proposal.schemaPlan.effects.some((effect) => effect.sql.includes("app_signup_policy")),
    ).toBe(true);
    expect(JSON.stringify(proposal)).not.toContain(password);
    expect((await pool.query(`select id from "user"`)).rows).toEqual([{ id: "existing-user" }]);
    expect(
      (
        await pool.query(
          "select to_regclass('public.app_signup_policy') as relation, to_regnamespace('_auth_schema_history') as history",
        )
      ).rows[0],
    ).toEqual({ relation: null, history: null });
    await expect(
      proposeAuthSchemaMigration({
        ...input,
        resource: { ...resource, database: "foreign" },
        directMigrationUrlFile,
      }),
    ).rejects.toThrow("connection identity mismatch");
  } finally {
    await pool?.end();
    if (started) run("pg_ctl", ["-D", databaseDirectory, "-m", "fast", "-w", "stop"]);
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
