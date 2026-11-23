import type { Pool } from "pg";

const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

/** Cluster roles survive disposable databases. Preserve pre-existing roles and direct grants. */
export async function capabilityRoleFixture(admin: Pool) {
  const existing = new Set(
    (await admin.query<{ rolname: string }>("select rolname from pg_roles")).rows.map(
      (row) => row.rolname,
    ),
  );
  const addedGrants: { role: string; principal: string }[] = [];
  return {
    async grantRuntime(database: Pool, role: string, principal: string) {
      const membership = await database.query(
        `select 1 from pg_auth_members m join pg_roles r on r.oid=m.roleid
         join pg_roles p on p.oid=m.member where r.rolname=$1 and p.rolname=$2`,
        [role, principal],
      );
      if (membership.rowCount === 0) {
        await database.query(`grant ${identifier(role)} to ${identifier(principal)}`);
        addedGrants.push({ role, principal });
      }
    },
    async cleanup(roles: readonly string[]) {
      for (const { role, principal } of addedGrants)
        await admin.query(`revoke ${identifier(role)} from ${identifier(principal)}`);
      for (const role of roles)
        if (!existing.has(role)) await admin.query(`drop role if exists ${identifier(role)}`);
    },
  };
}
