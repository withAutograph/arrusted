import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { proposeAuthSchemaMigration } from "./auth-schema-proposal-plan";
import { proposeEmptyAuthSchemaMigration } from "./auth-schema-history";

// Replace physical database transport only. The returned role, SQL effects and
// digests still come from the real source-owned Auth schema definition/planner.
vi.mock("pg", () => ({
  Pool: class {
    async end() {}
  },
}));
vi.mock("./auth-schema-history", async (original) => {
  const actual = await original<typeof import("./auth-schema-history")>();
  return {
    ...actual,
    planAuthSchemaMigration: async (input: Parameters<typeof actual.planAuthSchemaMigration>[0]) =>
      (await actual.proposeEmptyAuthSchemaMigration(input)).schemaPlan,
  };
});

afterEach(() => vi.unstubAllEnvs());

it("binds an explicit Production operator into an existing-resource proposal without inferring one", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "auth-proposal-role-"));
  try {
    const resource = {
      version: 1 as const,
      environment: "production" as const,
      hostname: "ep-fixture.us-east-1.aws.neon.tech",
      port: 5432,
      database: "auth_fixture",
      schema: "public" as const,
      runtimeRole: "auth_runtime",
      migratorRole: "auth_migrator",
      neon: { projectId: "project-fixture", branchId: "br-fixture" },
    };
    const directMigrationUrlFile = path.join(directory, "migration-url");
    const connection = `postgres://auth_migrator:private-test-secret@${resource.hostname}/auth_fixture?sslmode=verify-full`;
    await writeFile(directMigrationUrlFile, connection, { mode: 0o600 });
    const input = { resource, catalogAppIds: ["fixture-app"], directMigrationUrlFile };
    vi.stubEnv("AUTH_MANAGED_OPERATOR_ROLE", "not_implicit_authority");
    const legacy = await proposeAuthSchemaMigration(input);
    expect(legacy.schemaPlan).toEqual((await proposeEmptyAuthSchemaMigration(input)).schemaPlan);
    expect(legacy.schemaPlan).not.toHaveProperty("authOperatorRole");
    expect(legacy.schemaPlan.effects.some((effect) => effect.owner === "operator-privileges")).toBe(
      false,
    );

    const approved = { ...input, authOperatorRole: "auth_operator" };
    const proposal = await proposeAuthSchemaMigration(approved);
    expect(proposal).not.toHaveProperty("proposal");
    expect(proposal.schemaPlan).toEqual(
      (await proposeEmptyAuthSchemaMigration(approved)).schemaPlan,
    );
    expect(proposal.schemaPlan.authOperatorRole).toBe("auth_operator");
    const effect = proposal.schemaPlan.effects.find(
      (effect) => effect.owner === "operator-privileges",
    );
    expect(effect?.sql).toContain('to "auth_operator"');
    expect(proposal.schemaPlan.targetDigest).not.toBe(legacy.schemaPlan.targetDigest);
    expect(proposal.schemaPlan.planDigest).not.toBe(legacy.schemaPlan.planDigest);
    expect(JSON.stringify(proposal)).not.toContain("private-test-secret");
    for (const authOperatorRole of ["auth_runtime", "auth_migrator", "AuthOperator"])
      await expect(proposeAuthSchemaMigration({ ...input, authOperatorRole })).rejects.toThrow(
        "invalid_auth_operator_role",
      );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
