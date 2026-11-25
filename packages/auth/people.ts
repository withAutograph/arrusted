import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import type { createSingleOrganizationAuth } from "./single-organization";

const LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function normalizeEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid email.");
  return email;
}

export async function addPerson(input: {
  pool: Pool;
  auth: ReturnType<typeof createSingleOrganizationAuth>["auth"];
  origin: string;
  email: string;
}): Promise<{ userId: string; email: string; token: string; link: string; created: boolean }> {
  const email = normalizeEmail(input.email);
  const ctx = await input.auth.$context;
  const existing = await ctx.internalAdapter.findUserByEmail(email);
  let userId: string;
  let created = false;
  if (existing) {
    userId = existing.user.id;
  } else {
    const user = await ctx.internalAdapter.createUser(
      { email, name: email, emailVerified: false },
      { method: "admin" },
    );
    userId = user.id;
    created = true;
  }
  await input.pool.query(
    `delete from "verification" where "identifier" like 'reset-password:%' and "value" = $1`,
    [userId],
  );
  const token = randomBytes(32).toString("base64url");
  await ctx.internalAdapter.createVerificationValue({
    identifier: `reset-password:${token}`,
    value: userId,
    expiresAt: new Date(Date.now() + LINK_TTL_MS),
  });
  const link = `${new URL(input.origin).origin}/auth/set-password#token=${token}`;
  return { userId, email, token, link, created };
}

export async function removePerson(input: {
  pool: Pool;
  organizationId: string;
  email: string;
}): Promise<boolean> {
  const email = normalizeEmail(input.email);
  const client = await input.pool.connect();
  try {
    await client.query("begin");
    const found = await client.query<{ id: string }>(
      'select id from "user" where lower(email) = $1 for update',
      [email],
    );
    const userId = found.rows[0]?.id;
    if (!userId) {
      await client.query("rollback");
      return false;
    }
    await client.query(
      `delete from "verification" where "identifier" like 'reset-password:%' and "value" = $1`,
      [userId],
    );
    await client.query(
      `delete from "verification" v
       where v."value" like '{"type":"authorization_code"%'
         and (case when v."value" like '{"type":"authorization_code"%'
               then v."value"::jsonb end) ->> 'userId' = $1`,
      [userId],
    );
    await client.query('delete from "oauthAccessToken" where "userId" = $1', [userId]);
    await client.query('delete from "oauthRefreshToken" where "userId" = $1', [userId]);
    await client.query('delete from "oauthConsent" where "userId" = $1', [userId]);
    await client.query('delete from "deviceCode" where "userId" = $1', [userId]);
    await client.query('delete from "session" where "userId" = $1', [userId]);
    await client.query('delete from "member" where "organizationId" = $1 and "userId" = $2', [
      input.organizationId,
      userId,
    ]);
    await client.query('update "oauthClient" set "userId" = null where "userId" = $1', [userId]);
    await client.query('delete from "user" where id = $1', [userId]);
    await client.query("commit");
    return true;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
