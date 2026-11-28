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

  test("writeGeneratedPasswordFile writes 0600 credential files, refuses symlinks, and CLI rejects conflicting flags", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "arrusted-auth-cred-"));
    try {
      const defaultPath = writeGeneratedPasswordFile(
        "Alice@Sunlight.test",
        "SecretPass123!",
        undefined,
        dir,
      );
      expect(defaultPath).toBe(path.join(dir, ".local/credentials/alice@sunlight.test.txt"));
      expect(readFileSync(defaultPath, "utf8")).toBe("SecretPass123!\n");
      expect(statSync(defaultPath).mode & 0o777).toBe(0o600);
      expect(statSync(path.dirname(defaultPath)).mode & 0o777).toBe(0o700);

      const customPath = writeGeneratedPasswordFile(
        "bob@sunlight.test",
        "CustomSecret456!",
        "secrets/bob.pwd",
        dir,
      );
      expect(customPath).toBe(path.join(dir, "secrets/bob.pwd"));
      expect(readFileSync(customPath, "utf8")).toBe("CustomSecret456!\n");
      expect(statSync(customPath).mode & 0o777).toBe(0o600);

      const victimFile = path.join(dir, "victim.txt");
      writeFileSync(victimFile, "preserve-me");
      const linkTarget = path.join(dir, "secrets/link.pwd");
      symlinkSync(victimFile, linkTarget);
      expect(() =>
        writeGeneratedPasswordFile("eve@sunlight.test", "ShouldNotWrite", "secrets/link.pwd", dir),
      ).toThrow(/symbolic link/);
      expect(readFileSync(victimFile, "utf8")).toBe("preserve-me");

      // Distinct valid emails (+ vs _) map to distinct files without overwriting one another
      const plusPath = writeGeneratedPasswordFile(
        "a+b@sunlight.test",
        "PlusPass123!",
        undefined,
        dir,
      );
      const underscorePath = writeGeneratedPasswordFile(
        "a_b@sunlight.test",
        "UnderscorePass456!",
        undefined,
        dir,
      );
      expect(encodeEmailForCredentialFilename("a+b@sunlight.test")).toBe("a%2bb@sunlight.test");
      expect(plusPath).not.toBe(underscorePath);
      expect(readFileSync(plusPath, "utf8")).toBe("PlusPass123!\n");
      expect(readFileSync(underscorePath, "utf8")).toBe("UnderscorePass456!\n");

      // Symlinked ancestor outside cwd is also refused
      const outsideRoot = mkdtempSync(path.join(tmpdir(), "arrusted-auth-outside-"));
      try {
        const realOutside = path.join(outsideRoot, "real");
        mkdirSync(path.join(realOutside, "nested"), { recursive: true });
        const symlinkAncestor = path.join(outsideRoot, "link");
        symlinkSync(realOutside, symlinkAncestor);
        expect(() =>
          writeGeneratedPasswordFile(
            "mallory@sunlight.test",
            "ShouldNotEscape",
            path.join(symlinkAncestor, "nested/mallory.pwd"),
            dir,
          ),
        ).toThrow(/symbolic link/);
      } finally {
        rmSync(outsideRoot, { recursive: true, force: true });
      }

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
        runAuthCli([
          "people",
          "add",
          "alice@sunlight.test",
          "--password",
          "Password1234!",
          "--password-file",
          "out.txt",
          "--org",
          "sunlight",
        ]),
      ).rejects.toThrow(/--password and --password-file cannot be combined/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
