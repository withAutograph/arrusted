import { Pool } from "pg";

const databaseUrl = requireEnv("PLATFORM_AUTH_DATABASE_URL");
const email = requireEnv("PLATFORM_AUTH_USER_EMAIL").toLowerCase();
const organizationId = process.env.PLATFORM_AUTH_ORGANIZATION_ID ?? "dev";
const role = process.env.PLATFORM_AUTH_MEMBER_ROLE ?? "owner";
const setActiveOrganization = !["0", "false", "no"].includes(
  (process.env.PLATFORM_AUTH_SET_ACTIVE_ORG ?? "1").toLowerCase(),
);

const pool = new Pool({ connectionString: databaseUrl });

try {
  await grantLocalAccess();
} finally {
  await pool.end();
}

async function grantLocalAccess() {
  const client = await pool.connect();
  try {
    await client.query("begin");

    const user = await client.query<{ id: string; email: string }>(
      `select "id", "email" from "user" where lower("email") = $1 limit 1`,
      [email],
    );
    const userRow = user.rows[0];
    if (!userRow) {
      throw new Error(`No Better Auth user exists for ${email}. Sign in or sign up locally first.`);
    }

    const organization = await client.query<{ id: string }>(
      `select "id" from "organization" where "id" = $1 limit 1`,
      [organizationId],
    );
    if (!organization.rows[0]) {
      throw new Error(
        `No Better Auth organization exists for ${organizationId}. Run mise run setup first.`,
      );
    }

    const updatedMember = await client.query(
      `
        update "member"
        set "role" = $3
        where "organizationId" = $1 and "userId" = $2
      `,
      [organizationId, userRow.id, role],
    );
    let insertedMember = false;
    if (updatedMember.rowCount === 0) {
      await client.query(
        `
          insert into "member" ("id", "organizationId", "userId", "role", "createdAt")
          values ($1, $2, $3, $4, now())
        `,
        [`${organizationId}:${userRow.id}:${role}`, organizationId, userRow.id, role],
      );
      insertedMember = true;
    }

    let updatedSessions = 0;
    if (setActiveOrganization) {
      const sessionUpdate = await client.query(
        `
          update "session"
          set "activeOrganizationId" = $1,
              "updatedAt" = now()
          where "userId" = $2
        `,
        [organizationId, userRow.id],
      );
      updatedSessions = sessionUpdate.rowCount ?? 0;
    }

    await client.query("commit");

    console.log(
      [
        `Granted ${role} access to ${userRow.email} for ${organizationId}.`,
        insertedMember ? "Created membership." : "Updated existing membership.",
        setActiveOrganization
          ? `Set ${updatedSessions} active session(s) to ${organizationId}.`
          : "Left active sessions unchanged.",
      ].join(" "),
    );
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}
