/** Trusted Auth host only: re-read all authority in one database snapshot. */
export async function readIntegrationActivationAuthority(
  input: { actorId: string; organizationId: string; appId: string },
  query: (
    sql: string,
    parameters: readonly string[],
  ) => Promise<{ rows: Array<Record<string, unknown>> }>,
): Promise<boolean> {
  if (
    ![input.actorId, input.organizationId, input.appId].every(
      (value) => typeof value === "string" && value.length > 0 && value.length <= 256,
    )
  )
    return false;
  const result = await query(
    `SELECT EXISTS (
      SELECT 1 FROM "organization" o
      JOIN "member" m ON m."organizationId"=o."id" AND m."userId"=$1
      WHERE o."id"=$2 AND m."role" IN ('owner','admin')
        AND jsonb_typeof(o."appIds")='array' AND o."appIds" @> jsonb_build_array($3::text)
        AND EXISTS (SELECT 1 FROM "app_actor_assignment" a
          WHERE a."actorId"=$1 AND a."organizationId"=$2 AND a."appId"=$3 AND a."active"=true)
    ) AS allowed`,
    [input.actorId, input.organizationId, input.appId],
  );
  return result.rows.length === 1 && result.rows[0]?.allowed === true;
}
