import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vite-plus/test";
import type { Pool, PoolClient } from "pg";
import {
  encodeEmailForCredentialFilename,
  runAuthCli,
  writeGeneratedPasswordFile,
} from "../src/cli";
import { addPerson, createAppAuth, removePerson } from "../src/server";

function createFakePool(options?: { existingAccountId?: string; deleteMemberCount?: number }) {
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      if (sql.includes('insert into "user"')) {
        return { rows: [{ id: "user-123" }], rowCount: 1 };
      }
      if (sql.includes('select "id" from "account"') && options?.existingAccountId) {
        return { rows: [{ id: options.existingAccountId }], rowCount: 1 };
      }
      if (sql.includes('select "id" from "user"')) {
        return { rows: [{ id: "user-123" }], rowCount: 1 };
      }
      if (sql.includes('delete from "member"')) {
        return { rows: [], rowCount: options?.deleteMemberCount ?? 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  } as unknown as PoolClient;

  const pool = {
    connect: async () => client,
    query: async (sql: string, values?: unknown[]) => client.query(sql, values),
  } as unknown as Pool;

  return { pool, queries };
}

describe("@arrusted/auth server & people helpers", () => {
  test("createAppAuth defaults allowSignUp to false and validates secret + authSchema", () => {
    const { pool } = createFakePool();
    const instance = createAppAuth({
      database: pool,
      authSchema: "auth_crm",
      origin: "http://localhost:3000",
      secret: "0123456789abcdef0123456789abcdef",
      appId: "sunlight-crm",
      organizationId: "sunlight",
      name: "Sunlight CRM",
    });
    expect(instance.allowSignUp).toBe(false);

    expect(() =>
      createAppAuth({
        database: pool,
        authSchema: "invalid_schema",
        origin: "http://localhost:3000",
        secret: "0123456789abcdef0123456789abcdef",
        appId: "sunlight-crm",
        organizationId: "sunlight",
        name: "Sunlight CRM",
      }),
    ).toThrow(/Auth schema/);
  });

  test("addPerson scopes transactions to authSchema and hashes credentials", async () => {
    const { pool, queries } = createFakePool();
    const result = await addPerson({
      database: pool,
      authSchema: "auth_crm",
      organizationId: "sunlight",
      email: "Alice@Sunlight.test",
      name: "Alice",
    });

    expect(result.email).toBe("alice@sunlight.test");
    expect(result.userId).toBe("user-123");
    expect(result.generatedPassword).toBeTruthy();
    expect(queries.some((q) => q.sql.includes("set_config('search_path'"))).toBe(true);
    const userUpsert = queries.find((q) => q.sql.includes('insert into "user"'));
    expect(userUpsert?.values?.[3]).toBe(true);
    expect(queries.some((q) => q.sql.includes('insert into "account"'))).toBe(true);
    expect(queries.some((q) => q.sql.includes('insert into "member"'))).toBe(true);

    const { pool: poolNoName, queries: queriesNoName } = createFakePool({
      existingAccountId: "acct-existing",
    });
    const reAdded = await addPerson({
      database: poolNoName,
      authSchema: "auth_crm",
      organizationId: "sunlight",
      email: "alice@sunlight.test",
    });
    const noNameUpsert = queriesNoName.find((q) => q.sql.includes('insert into "user"'));
    expect(noNameUpsert?.values?.[3]).toBe(false);
    expect(reAdded.generatedPassword).toBeUndefined();
    expect(queriesNoName.some((q) => q.sql.includes('update "account"'))).toBe(false);
    expect(queriesNoName.some((q) => q.sql.includes('insert into "account"'))).toBe(false);

    const { pool: poolExplicitReset, queries: queriesExplicitReset } = createFakePool({
      existingAccountId: "acct-existing",
    });
    await addPerson({
      database: poolExplicitReset,
      authSchema: "auth_crm",
      organizationId: "sunlight",
      email: "alice@sunlight.test",
      password: "NewPassword123!",
    });
    expect(queriesExplicitReset.some((q) => q.sql.includes('update "account"'))).toBe(true);

    const { pool: poolTooLong, queries: queriesTooLong } = createFakePool();
    await expect(
      addPerson({
        database: poolTooLong,
        authSchema: "auth_crm",
        organizationId: "sunlight",
        email: "alice@sunlight.test",
        password: "a".repeat(129),
      }),
    ).rejects.toThrow(/at most 128 characters/);
    expect(queriesTooLong).toHaveLength(0);
  });

  test("removePerson deletes member and active sessions inside authSchema", async () => {
    const { pool, queries } = createFakePool();
    const removed = await removePerson({
      database: pool,
      authSchema: "auth_crm",
      organizationId: "sunlight",
      email: "alice@sunlight.test",
    });

    expect(removed).toEqual({ removed: true, userId: "user-123" });
    expect(queries.some((q) => q.sql.includes('delete from "member"'))).toBe(true);
    expect(queries.some((q) => q.sql.includes('delete from "session"'))).toBe(true);

    const { pool: nonMemberPool, queries: nonMemberQueries } = createFakePool({
      deleteMemberCount: 0,
    });
    const notRemoved = await removePerson({
      database: nonMemberPool,
      authSchema: "auth_crm",
      organizationId: "other-org",
      email: "alice@sunlight.test",
    });
    expect(notRemoved).toEqual({ removed: false, userId: "user-123" });
    expect(nonMemberQueries.some((q) => q.sql.includes('delete from "session"'))).toBe(false);
  });

  test("writeGeneratedPasswordFile scopes filenames by authSchema, writes .local/.gitignore, allows symlinked cwd parents, refuses symlinks inside .local, and CLI rejects --password/--password-file", async () => {
    const outer = mkdtempSync(path.join(tmpdir(), "arrusted-auth-cred-"));
    try {
      const realProjectRoot = path.join(outer, "real-project");
      mkdirSync(realProjectRoot, { recursive: true });
      const symlinkedCwd = path.join(outer, "linked-project");
      symlinkSync(realProjectRoot, symlinkedCwd);

      // Default schema ('public') writes public--<email>.txt and creates .local/.gitignore
      const defaultPath = writeGeneratedPasswordFile(
        "Alice@Sunlight.test",
        "SecretPass123!",
        undefined,
        symlinkedCwd,
      );
      expect(defaultPath).toBe(
        path.join(symlinkedCwd, ".local/credentials/public--alice@sunlight.test.txt"),
      );
      expect(readFileSync(defaultPath, "utf8")).toBe("SecretPass123!\n");
      expect(statSync(defaultPath).mode & 0o777).toBe(0o600);
      expect(statSync(path.dirname(defaultPath)).mode & 0o777).toBe(0o700);
      expect(readFileSync(path.join(symlinkedCwd, ".local/.gitignore"), "utf8")).toBe("*\n");

      // Multi-app provisioning from the same directory keeps distinct credential files per authSchema
      const crmPath = writeGeneratedPasswordFile(
        "alice@sunlight.test",
        "CrmSecret111!",
        "auth_crm",
        symlinkedCwd,
      );
      const companyDataPath = writeGeneratedPasswordFile(
        "alice@sunlight.test",
        "CompanyDataSecret222!",
        "auth_company_data",
        symlinkedCwd,
      );
      expect(crmPath).toBe(
        path.join(symlinkedCwd, ".local/credentials/auth_crm--alice@sunlight.test.txt"),
      );
      expect(companyDataPath).toBe(
        path.join(symlinkedCwd, ".local/credentials/auth_company_data--alice@sunlight.test.txt"),
      );
      expect(readFileSync(crmPath, "utf8")).toBe("CrmSecret111!\n");
      expect(readFileSync(companyDataPath, "utf8")).toBe("CompanyDataSecret222!\n");
      expect(readFileSync(defaultPath, "utf8")).toBe("SecretPass123!\n");

      // Symlinked target file inside .local/credentials is refused without touching victim
      const victimFile = path.join(outer, "victim.txt");
      writeFileSync(victimFile, "preserve-me");
      const linkTarget = path.join(
        symlinkedCwd,
        ".local/credentials/auth_crm--eve@sunlight.test.txt",
      );
      symlinkSync(victimFile, linkTarget);
      expect(() =>
        writeGeneratedPasswordFile("eve@sunlight.test", "ShouldNotWrite", "auth_crm", symlinkedCwd),
      ).toThrow(/symbolic link/);
      expect(readFileSync(victimFile, "utf8")).toBe("preserve-me");

      // Symlinked .local directory beneath cwd is also refused
      const symlinkLocalProject = path.join(outer, "bad-local-project");
      mkdirSync(symlinkLocalProject, { recursive: true });
      const outsideDir = path.join(outer, "outside-local");
      mkdirSync(outsideDir, { recursive: true });
      symlinkSync(outsideDir, path.join(symlinkLocalProject, ".local"));
      expect(() =>
        writeGeneratedPasswordFile(
          "mallory@sunlight.test",
          "ShouldNotEscape",
          "auth_crm",
          symlinkLocalProject,
        ),
      ).toThrow(/symbolic link/);

      // Pre-existing .local/.gitignore without credentials/ coverage (or negating credentials/) appends credentials/ idempotently
      const customGitignoreProject = path.join(outer, "custom-gitignore-project");
      mkdirSync(path.join(customGitignoreProject, ".local"), { recursive: true });
      writeFileSync(
        path.join(customGitignoreProject, ".local/.gitignore"),
        "# custom rules\nrestore-points/\n*\n!credentials/\n",
      );
      writeGeneratedPasswordFile(
        "alice@sunlight.test",
        "CustomIgnorePass1!",
        "auth_crm",
        customGitignoreProject,
      );
      expect(readFileSync(path.join(customGitignoreProject, ".local/.gitignore"), "utf8")).toBe(
        "# custom rules\nrestore-points/\n*\n!credentials/\ncredentials/\n",
      );
      writeGeneratedPasswordFile(
        "bob@sunlight.test",
        "CustomIgnorePass2!",
        "auth_crm",
        customGitignoreProject,
      );
      expect(readFileSync(path.join(customGitignoreProject, ".local/.gitignore"), "utf8")).toBe(
        "# custom rules\nrestore-points/\n*\n!credentials/\ncredentials/\n",
      );

      // Symlinked .local/.gitignore is refused without modifying victim
      const symlinkGitignoreProject = path.join(outer, "bad-gitignore-project");
      mkdirSync(path.join(symlinkGitignoreProject, ".local"), { recursive: true });
      symlinkSync(victimFile, path.join(symlinkGitignoreProject, ".local/.gitignore"));
      expect(() =>
        writeGeneratedPasswordFile(
          "mallory@sunlight.test",
          "ShouldNotTouchGitignoreTarget",
          "auth_crm",
          symlinkGitignoreProject,
        ),
      ).toThrow(/symbolic link/);
      expect(readFileSync(victimFile, "utf8")).toBe("preserve-me");

      // Distinct valid emails (+ vs _) map to distinct files without overwriting one another
      const plusPath = writeGeneratedPasswordFile(
        "a+b@sunlight.test",
        "PlusPass123!",
        "auth_crm",
        symlinkedCwd,
      );
      const underscorePath = writeGeneratedPasswordFile(
        "a_b@sunlight.test",
        "UnderscorePass456!",
        "auth_crm",
        symlinkedCwd,
      );
      expect(encodeEmailForCredentialFilename("a+b@sunlight.test")).toBe("a%2bb@sunlight.test");
      expect(plusPath).not.toBe(underscorePath);
      expect(readFileSync(plusPath, "utf8")).toBe("PlusPass123!\n");
      expect(readFileSync(underscorePath, "utf8")).toBe("UnderscorePass456!\n");

      // Failed onGeneratedPassword rolls back addPerson before COMMIT so a retry succeeds cleanly
      const { pool: rollbackPool, queries: rollbackQueries } = createFakePool();
      await expect(
        addPerson({
          database: rollbackPool,
          authSchema: "auth_crm",
          organizationId: "sunlight",
          email: "retry@sunlight.test",
          onGeneratedPassword: () => {
            throw new Error("disk write failed");
          },
        }),
      ).rejects.toThrow(/disk write failed/);
      expect(rollbackQueries.some((q) => q.sql === "COMMIT")).toBe(false);
      expect(rollbackQueries.some((q) => q.sql === "ROLLBACK")).toBe(true);

      await expect(
        runAuthCli(["people", "add", "alice@sunlight.test", "--password", "Password1234!"]),
      ).rejects.toThrow(/Unknown option: --password/);
      await expect(
        runAuthCli(["people", "add", "alice@sunlight.test", "--password-file", "out.txt"]),
      ).rejects.toThrow(/Unknown option: --password-file/);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });
});
