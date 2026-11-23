import { createHash } from "node:crypto";

import { hashPassword } from "better-auth/crypto";
import { Pool } from "pg";

const databaseUrl = process.env.PLATFORM_AUTH_DATABASE_URL;
const emails = parseLocalAuthEmails(
  process.env.PLATFORM_LOCAL_AUTH_EMAILS ?? process.env.PLATFORM_LOCAL_AUTH_EMAIL,
);
const password = process.env.PLATFORM_LOCAL_AUTH_PASSWORD ?? "local-apps-admin";
const name = process.env.PLATFORM_LOCAL_AUTH_NAME?.trim() || "Autograph Local Developer";
const LOCAL_ORGANIZATION_ID = "dev";

if (!databaseUrl) {
  throw new Error("PLATFORM_AUTH_DATABASE_URL is required to bootstrap local auth.");
}
if (password.length < 8) {
  throw new Error("PLATFORM_LOCAL_AUTH_PASSWORD must be at least 8 characters.");
}

const pool = new Pool({ connectionString: databaseUrl });

await bootstrapLocalAuth().finally(() => pool.end());

async function bootstrapLocalAuth() {
  const passwordHash = await hashPassword(password);
  for (const email of emails) {
    const userId = await ensureLocalUser(email, userNameForEmail(email), passwordHash);
    await ensureMembership(userId, LOCAL_ORGANIZATION_ID);
  }
  console.log(`Bootstrapped local Better Auth users ${emails.join(", ")} with dev membership.`);
}

async function ensureLocalUser(
  email: string,
  userName: string,
  passwordHash: string,
): Promise<string> {
  const userId = localUserIdForEmail(email);
  const user = await pool.query<{ id: string }>(
    `
      insert into "user" ("id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt")
      values ($1, $2, lower($3), true, null, now(), now())
      on conflict ("email") do update
        set "name" = excluded."name",
            "updatedAt" = now()
      returning "id"
    `,
    [userId, userName, email],
  );
  const persistedUserId = user.rows[0]?.id;
  if (!persistedUserId) {
    throw new Error("Failed to create or read the local auth user.");
  }

  await pool.query(
    `
      insert into "account" (
        "id", "accountId", "providerId", "userId", "password", "createdAt", "updatedAt"
      )
      values ($1, $2, 'credential', $2, $3, now(), now())
      on conflict ("id") do update
        set "password" = excluded."password",
            "updatedAt" = now()
    `,
    [`credential:${persistedUserId}`, persistedUserId, passwordHash],
  );

  return persistedUserId;
}

async function ensureMembership(userId: string, organizationId: string) {
  await pool.query(
    `
      update "member"
      set "role" = 'owner'
      where "organizationId" = $1 and "userId" = $2
    `,
    [organizationId, userId],
  );
  await pool.query(
    `
      insert into "member" ("id", "organizationId", "userId", "role", "createdAt")
      select $1, $2, $3, 'owner', now()
      where not exists (
        select 1 from "member" where "organizationId" = $2 and "userId" = $3
      )
    `,
    [`${organizationId}:${userId}:owner`, organizationId, userId],
  );
  // Only a session without an organization adopts this one, and only when
  // the person holds an app role in it. A chosen one is the person's, and an
  // organization that opens no app for them would refuse every app: re-running
  // the bootstrap (every local runtime start does) against a realm a live
  // server shares must not move signed-in people. Left without one, each
  // app's guard picks or offers the organizations that open it.
  await pool.query(
    `
      update "session"
      set "activeOrganizationId" = $1,
          "updatedAt" = now()
      where "userId" = $2
        and "activeOrganizationId" is null
        and exists (
          select 1 from "app_actor_assignment"
          where "organizationId" = $1 and "actorId" = $2 and "active" = true
        )
    `,
    [organizationId, userId],
  );
}

function parseLocalAuthEmails(value: string | undefined): string[] {
  const emails = (value ?? "admin@apps.localhost")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0 && email.includes("@"));
  const uniqueEmails = [...new Set(emails)];
  return uniqueEmails.length > 0 ? uniqueEmails : ["admin@apps.localhost"];
}

function userNameForEmail(email: string): string {
  if (email === "admin@apps.localhost") {
    return "Autograph Local Admin";
  }
  return name;
}

function localUserIdForEmail(email: string): string {
  if (email === "admin@apps.localhost") {
    return "local_apps_admin";
  }
  const digest = createHash("sha256").update(email).digest("hex").slice(0, 16);
  return `local_apps_${digest}`;
}
