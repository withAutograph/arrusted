// @vitest-environment node
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { expect, test, vi } from "vitest";
import { readIntegrationActivationAuthority } from "../integration-activation-authority";

const url = process.env.AUTH_ACTIVATION_TEST_DATABASE_URL;

test("rejects invalid authority identifiers without querying the database", async () => {
  const query = vi.fn(async () => ({ rows: [{ allowed: true }] }));
  for (const input of [
    { actorId: "", organizationId: "tenant", appId: "vendor" },
    { actorId: "actor", organizationId: "x".repeat(257), appId: "vendor" },
    { actorId: "actor", organizationId: "tenant", appId: "" },
  ]) {
    expect(await readIntegrationActivationAuthority(input, query)).toBe(false);
  }
  expect(query).not.toHaveBeenCalled();
});

test("fails closed on malformed database results and propagates database failures", async () => {
  const input = { actorId: "actor", organizationId: "tenant", appId: "vendor" };
  expect(await readIntegrationActivationAuthority(input, async () => ({ rows: [] }))).toBe(false);
  expect(
    await readIntegrationActivationAuthority(input, async () => ({ rows: [{ allowed: "true" }] })),
  ).toBe(false);
  await expect(
    readIntegrationActivationAuthority(input, async () => {
      throw new Error("database unavailable");
    }),
  ).rejects.toThrow("database unavailable");
});

test.skipIf(!url)(
  "current manager authority requires membership, organization app assignment and active actor grant",
  async () => {
    const pool = new Pool({ connectionString: url });
    const schema = `activation_auth_${randomUUID().replaceAll("-", "")}`;
    const client = await pool.connect();
    try {
      await client.query(
        `CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"; CREATE TABLE "organization" ("id" text PRIMARY KEY, "appIds" jsonb); CREATE TABLE "member" ("organizationId" text, "userId" text, "role" text); CREATE TABLE "app_actor_assignment" ("organizationId" text, "actorId" text, "appId" text, "active" boolean)`,
      );
      await client.query(
        `INSERT INTO "organization" VALUES ('tenant', '["vendor"]'); INSERT INTO "member" VALUES ('tenant', 'actor', 'admin'); INSERT INTO "app_actor_assignment" VALUES ('tenant', 'actor', 'vendor', true)`,
      );
      const check = (actorId = "actor", organizationId = "tenant", appId = "vendor") =>
        readIntegrationActivationAuthority({ actorId, organizationId, appId }, (sql, params) =>
          client.query(sql, [...params]),
        );
      expect(await check()).toBe(true);
      expect(await check("other")).toBe(false);
      expect(await check("actor", "other")).toBe(false);
      expect(await check("actor", "tenant", "other")).toBe(false);
      await client.query(`UPDATE "member" SET "role"='member'`);
      expect(await check()).toBe(false);
      await client.query(
        `UPDATE "member" SET "role"='owner'; UPDATE "app_actor_assignment" SET "active"=false`,
      );
      expect(await check()).toBe(false);
      await client.query(
        `UPDATE "app_actor_assignment" SET "active"=true; UPDATE "organization" SET "appIds"='[]'`,
      );
      expect(await check()).toBe(false);
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      client.release();
      await pool.end();
    }
  },
);
