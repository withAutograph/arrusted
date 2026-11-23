import { z } from "zod";
import type { Pool, PoolClient } from "pg";

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const base = z.strictObject({
  version: z.literal(1),
  algorithm: z.literal("pg-jsonb-catalog-sha256-v1"),
  database: z.string(),
});
export const authSchemaReadinessSchema = z.discriminatedUnion("status", [
  base.extend({ status: z.enum(["unverified", "migration_in_progress"]) }),
  base.extend({
    status: z.enum(["catalog_drift", "verified"]),
    targetDigest: hash,
    assetSha256: hash,
    publishedFingerprint: hash,
    observedFingerprint: hash,
  }),
]);
/** Fixed metadata read. This does not prove login, table DML, users, or sessions. */
export async function readAuthSchemaReadiness(database: Pick<Pool | PoolClient, "query">) {
  const result = await database.query("select _auth_schema_readiness.read_current() as readiness");
  if (result.rows.length !== 1) throw new Error("Auth schema readiness is unavailable");
  return authSchemaReadinessSchema.parse(result.rows[0]?.readiness);
}
export async function verifyAuthSchemaReadiness(
  database: Pick<Pool | PoolClient, "query">,
  expected: { database: string; targetDigest: string; assetSha256: string },
) {
  const observed = await readAuthSchemaReadiness(database);
  if (
    observed.status !== "verified" ||
    observed.database !== expected.database ||
    observed.targetDigest !== expected.targetDigest ||
    observed.assetSha256 !== expected.assetSha256 ||
    observed.publishedFingerprint !== observed.observedFingerprint
  )
    throw new Error("Auth schema readiness is unconfirmed");
  return observed;
}
