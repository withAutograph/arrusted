// @vitest-environment node
import { expect, it } from "vitest";
import { authSchemaReadinessSchema } from "../schema-readiness";

const base = { version: 1, algorithm: "pg-jsonb-catalog-sha256-v1", database: "auth_fixture" };
it("requires live and published fingerprints for verified metadata", () => {
  expect(() =>
    authSchemaReadinessSchema.parse({
      ...base,
      status: "verified",
      targetDigest: "a".repeat(64),
      assetSha256: "b".repeat(64),
    }),
  ).toThrow();
  expect(authSchemaReadinessSchema.parse({ ...base, status: "unverified" }).status).toBe(
    "unverified",
  );
});
it("rejects private history fields and unknown fingerprint algorithms", () => {
  expect(() =>
    authSchemaReadinessSchema.parse({
      ...base,
      status: "unverified",
      plan: { sql: "private-history" },
    }),
  ).toThrow();
  expect(() =>
    authSchemaReadinessSchema.parse({
      ...base,
      status: "unverified",
      algorithm: "historical-ts-hash",
    }),
  ).toThrow();
});
