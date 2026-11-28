import { describe, expect, test } from "vite-plus/test";
import type { Pool, PoolClient } from "pg";
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
});
