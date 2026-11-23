import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  appSignupPolicyDigest,
  appSignupPolicySchema,
  enrollAppSignupUser,
  persistAppSignupPolicy,
  readAppSignupStatus,
} from "../signup-policy";

const policy = {
  version: 1 as const,
  policyId: "policy-spend-review",
  authResourceId: "auth-resource",
  appId: "spend-review",
  origin: "https://spend-review.example",
  appPath: "/",
  organizationId: "spend-review-org",
  eligibility: "public" as const,
  membershipRole: "member" as const,
  appRoles: ["member"],
};
const resource = {
  version: 1 as const,
  environment: "preview" as const,
  hostname: "auth.neon.tech",
  port: 5432,
  database: "auth_db",
  schema: "public" as const,
  runtimeRole: "auth_runtime",
  migratorRole: "auth_migrator",
  neon: { projectId: "project", branchId: "branch" },
};

describe("protected app signup policy", () => {
  it("rejects implicit owner membership and malformed or unbound origins", () => {
    expect(() => appSignupPolicySchema.parse({ ...policy, membershipRole: "owner" })).toThrow();
    expect(() =>
      appSignupPolicySchema.parse({ ...policy, origin: "https://example.test/path" }),
    ).toThrow();
    expect(() =>
      appSignupPolicySchema.parse({ ...policy, appPath: "//attacker.example" }),
    ).toThrow();
    expect(() =>
      appSignupPolicySchema.parse({ ...policy, eligibility: "approved-email", allowedEmails: [] }),
    ).toThrow();
  });

  it("persists a policy bound to the protected operation and approved plan", async () => {
    const query = vi.fn(
      async (
        _sql: string,
        _values?: readonly unknown[],
      ): Promise<{ rows: Record<string, unknown>[] }> => ({ rows: [{ ok: 1 }] }),
    );
    const expected = appSignupPolicyDigest({
      ...policy,
      operationRef: "operation-1",
      planDigest: "a".repeat(64),
      fenceGeneration: 4,
    });
    query
      .mockResolvedValueOnce({ rows: [{ ok: 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: policy.policyId, policyDigest: expected }] });
    await expect(
      persistAppSignupPolicy({ query }, policy, {
        operationRef: "operation-1",
        planDigest: "a".repeat(64),
        fenceGeneration: 4,
        resource,
      }),
    ).resolves.toEqual({ policyDigest: expected });
    expect(query.mock.calls[1]?.[1]).toContain(expected);
    await expect(
      persistAppSignupPolicy({ query }, policy, {
        operationRef: "operation-1",
        planDigest: "bad",
        fenceGeneration: 4,
        resource,
      }),
    ).rejects.toThrow();
  });

  it("distinguishes no approved policy from a persisted app-scoped enrollment", async () => {
    const database = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              id: policy.policyId,
              organizationId: policy.organizationId,
              appId: policy.appId,
              eligibility: "public",
              allowedEmails: [],
              membershipRole: "member",
              appRoles: ["member"],
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              result: {
                status: "membership_ready",
                appId: policy.appId,
                organizationId: policy.organizationId,
                roles: ["member"],
                sessionBound: true,
              },
            },
          ],
        }),
    };
    await expect(
      enrollAppSignupUser(database, {
        userId: "user-1",
        sessionId: "session-1",
        origin: policy.origin,
        resource,
      }),
    ).resolves.toEqual({ status: "waiting_for_signup" });
    expect(database.query).not.toHaveBeenCalled();
    await expect(
      enrollAppSignupUser(database, {
        userId: "user-1",
        sessionId: "session-1",
        origin: policy.origin,
        resource,
        appUrl: `${policy.origin}${policy.appPath}`,
      }),
    ).resolves.toEqual({
      status: "membership_ready",
      appId: policy.appId,
      organizationId: policy.organizationId,
      roles: ["member"],
      sessionBound: true,
    });
    expect(database.query.mock.calls[1]?.[1]).toEqual([
      "user-1",
      "session-1",
      expect.any(String),
      policy.origin,
      "/",
    ]);
  });

  it("does not enroll an email outside an approved eligibility list", async () => {
    const database = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              id: policy.policyId,
              organizationId: policy.organizationId,
              appId: policy.appId,
              appPath: policy.appPath,
              eligibility: "approved-email",
              allowedEmails: ["allowed@example.test"],
              membershipRole: "member",
              appRoles: ["member"],
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ result: { status: "blocked" } }] }),
    };
    await expect(
      enrollAppSignupUser(database, {
        userId: "user-1",
        sessionId: "session-1",
        origin: policy.origin,
        resource,
        appUrl: `${policy.origin}${policy.appPath}`,
      }),
    ).resolves.toEqual({ status: "blocked" });
    expect(database.query).toHaveBeenCalledTimes(2);
    expect(database.query.mock.calls[1]?.[0]).toContain("enroll_app_signup_user");
  });

  it("checks persisted email verification and binds only the requested session inside SQL", () => {
    const sqlPath = process.cwd().endsWith("/packages/auth")
      ? "runtime-privileges.sql"
      : "packages/auth/runtime-privileges.sql";
    const sql = readFileSync(sqlPath, "utf8");
    expect(sql).toMatch(
      /select email,"emailVerified" into actor_email,actor_email_verified from public\."user" where id=requested_user/u,
    );
    expect(sql).toMatch(/not actor_email_verified or not exists/u);
    expect(sql).toMatch(
      /where "id"=requested_session and "userId"=requested_user and "expiresAt">clock_timestamp\(\)/u,
    );
    expect(sql).not.toMatch(
      /update public\.session[\s\S]{0,200}where "userId"=requested_user\s*;/u,
    );
  });

  it("reports ready after the signed-in session, valid membership, and planned roles read back while preserving extra grants", async () => {
    const database = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              id: policy.policyId,
              appId: policy.appId,
              appPath: policy.appPath,
              organizationId: policy.organizationId,
              appRoles: ["member"],
              membershipRole: "member",
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ ok: 1 }] })
        .mockResolvedValueOnce({ rows: [{ ok: 1 }] })
        .mockResolvedValueOnce({ rows: [{ role: "member" }, { role: "reviewer" }] }),
    };
    await expect(
      readAppSignupStatus(database, {
        userId: "user-1",
        sessionId: "session-1",
        origin: policy.origin,
        resource,
        appUrl: `${policy.origin}${policy.appPath}`,
      }),
    ).resolves.toEqual({
      status: "ready",
      appId: policy.appId,
      organizationId: policy.organizationId,
      roles: ["member", "reviewer"],
      appUrl: "https://spend-review.example/",
    });
    expect(database.query.mock.calls.map((call) => call[0])).toHaveLength(4);
  });
});
