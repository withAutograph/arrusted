import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { proposeEmptyAuthSchemaMigration } from "./auth-schema-history";

it("runs the real standalone producer with only a private input file and no credential environment", async () => {
  const root = path.resolve(import.meta.dirname, "../../../..");
  const directory = await mkdtemp(path.join(tmpdir(), "auth-proposal-binary-"));
  try {
    const executable = path.join(directory, "auth-protected-propose");
    const build = spawnSync(
      "bun",
      [
        path.join(root, ".config/mise/scripts/repository/build-protected-auth-proposal.mjs"),
        executable,
        `bun-${process.platform}-${process.arch}`,
      ],
      { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH, TMPDIR: directory } },
    );
    expect(build.status, build.stderr).toBe(0);
    const metadata = JSON.parse(build.stdout);
    expect(metadata.compiler).toBe("bun@1.3.14");
    expect(metadata.sha256).toBe(
      createHash("sha256")
        .update(await readFile(executable))
        .digest("hex"),
    );
    const resource = {
      version: 1 as const,
      environment: "preview" as const,
      hostname: "ep-fixture.us-east-1.aws.neon.tech",
      port: 5432,
      database: "auth_fixture",
      schema: "public" as const,
      runtimeRole: "auth_runtime",
      migratorRole: "auth_migrator",
      neon: { projectId: "project-fixture", branchId: "br-fixture" },
    };
    const input = { resource, catalogAppIds: ["spend-review"] };
    const inputFile = path.join(directory, "proposal-input.json");
    await writeFile(inputFile, JSON.stringify(input), { mode: 0o600 });
    // No checkout, URL, database process, native settings or signing secret exists
    // in the executable's execution environment. It only produces a reviewed plan.
    const result = spawnSync(executable, ["--input-file", inputFile], {
      cwd: directory,
      env: {},
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    const proposal = JSON.parse(result.stdout);
    expect(proposal).toEqual(await proposeEmptyAuthSchemaMigration(input));
    expect(proposal.schemaPlan.toolchain).toBe("better-auth@1.7.28");
    expect(proposal.schemaPlan.effects).toHaveLength(6);
    const stdin = spawnSync(executable, [], {
      cwd: directory,
      env: {},
      input: JSON.stringify(input),
      encoding: "utf8",
    });
    expect(stdin.status, stdin.stderr).toBe(0);
    expect(JSON.parse(stdin.stdout)).toEqual(proposal);

    const production = { ...input, resource: { ...resource, environment: "production" as const } };
    const withOperator = { ...production, authOperatorRole: "auth_operator" };
    await writeFile(inputFile, JSON.stringify(withOperator), { mode: 0o600 });
    const bound = spawnSync(executable, ["--input-file", inputFile], {
      cwd: directory,
      env: {},
      encoding: "utf8",
    });
    expect(bound.status, bound.stderr).toBe(0);
    const boundProposal = JSON.parse(bound.stdout);
    expect(boundProposal).toEqual(await proposeEmptyAuthSchemaMigration(withOperator));
    expect(boundProposal.schemaPlan.authOperatorRole).toBe("auth_operator");
    expect(
      boundProposal.schemaPlan.effects.some(
        (effect: { owner: string }) => effect.owner === "operator-privileges",
      ),
    ).toBe(true);
    const legacyProduction = await proposeEmptyAuthSchemaMigration(production);
    expect(boundProposal.schemaPlan.targetDigest).not.toBe(
      legacyProduction.schemaPlan.targetDigest,
    );
    expect(boundProposal.schemaPlan.planDigest).not.toBe(legacyProduction.schemaPlan.planDigest);
    for (const invalid of [
      { ...input, authOperatorRole: "auth_operator" },
      ...["AuthOperator", "auth_runtime", "auth_migrator", "operator;never-reflected"].map(
        (authOperatorRole) => ({
          ...production,
          authOperatorRole,
        }),
      ),
    ]) {
      await writeFile(inputFile, JSON.stringify(invalid), { mode: 0o600 });
      const deniedRole = spawnSync(executable, ["--input-file", inputFile], {
        cwd: directory,
        env: {},
        encoding: "utf8",
      });
      expect(deniedRole.status).toBe(1);
      expect(deniedRole.stdout).toBe("");
      expect(deniedRole.stderr).toBe("Auth schema proposal could not be produced.\n");
    }

    await writeFile(inputFile, JSON.stringify({ ...input, credential: "never-reflected" }));
    const denied = spawnSync(executable, ["--input-file", inputFile], {
      cwd: directory,
      env: {},
      encoding: "utf8",
    });
    expect(denied.status).toBe(1);
    expect(denied.stdout).toBe("");
    expect(denied.stderr).toBe("Auth schema proposal could not be produced.\n");
    expect(denied.stderr).not.toContain("never-reflected");
    const badArgs = spawnSync(executable, ["--unknown", inputFile], {
      cwd: directory,
      env: {},
      encoding: "utf8",
    });
    expect(badArgs.status).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
