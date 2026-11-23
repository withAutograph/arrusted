// @vitest-environment node
import { describe, expect, it, vi } from "vite-plus/test";
import {
  continueManagedSignup,
  type ManagedSignupContinuationPorts,
} from "../managed-signup-continuation";
import type { ManagedAppSignupClaim, ManagedAppSignupPolicy } from "../managed-app-signup";
import {
  managedSignupContinuationUrl,
  readManagedSignupContinuation,
} from "../managed-signup-request";

const policy: ManagedAppSignupPolicy = {
  version: 1,
  policyId: "11111111-1111-4111-a111-111111111111",
  policyDigest: "a".repeat(64),
  workspaceId: "workspace",
  resourceDigest: "b".repeat(64),
  authResourceId: "auth",
  appId: "app",
  organizationId: "org",
  origin: "https://apps.example.test",
  appPath: "/apps/fixture",
  returnUrl: "https://apps.example.test/apps/fixture",
  eligibility: "public",
  storage: "none",
  allowedEmails: [],
  appRoles: [],
  enabled: true,
  operationRef: "22222222-2222-4222-a222-222222222222",
  planDigest: "c".repeat(64),
  fenceGeneration: 1,
};
const claim: ManagedAppSignupClaim = {
  id: "33333333-3333-4333-a333-333333333333",
  policyId: policy.policyId,
  policyDigest: policy.policyDigest,
  scopeDigest: "d".repeat(64),
  workspaceId: policy.workspaceId,
  resourceDigest: policy.resourceDigest,
  appId: policy.appId,
  organizationId: policy.organizationId,
  actorId: "actor",
  sessionId: "session",
  appRoles: [],
  returnUrl: policy.returnUrl,
  expiresAt: "2030-01-01T00:00:00Z",
  status: "verified",
  accessState: "absent",
  memberPrepared: false,
  grantReserved: false,
};
const request = { origin: policy.origin, appUrl: policy.returnUrl, complete: true };

// These ports are signed-session/SQL authority reads and the protected external callback.
// The continuation itself remains real; their owning suites verify those boundary contracts.
function fixture(emailVerified = true) {
  return {
    loadSession: vi.fn<ManagedSignupContinuationPorts["loadSession"]>().mockResolvedValue({
      user: { id: "actor", email: "owner@example.test", emailVerified },
      session: { id: "session", userId: "actor" },
    }),
    resolveIntent: vi
      .fn<ManagedSignupContinuationPorts["resolveIntent"]>()
      .mockResolvedValue(policy),
    existingAccess: vi
      .fn<ManagedSignupContinuationPorts["existingAccess"]>()
      .mockResolvedValue(null),
    readAccess: vi.fn<ManagedSignupContinuationPorts["readAccess"]>().mockResolvedValue(null),
    claim: vi.fn<ManagedSignupContinuationPorts["claim"]>().mockResolvedValue(claim),
    complete: vi.fn<ManagedSignupContinuationPorts["complete"]>().mockResolvedValue("ready"),
    continuationUrl: vi
      .fn<ManagedSignupContinuationPorts["continuationUrl"]>()
      .mockResolvedValue(
        "https://apps.example.test/api/auth/platform/signup-continue?state=signed",
      ),
  };
}

describe("managed app admission continuation", () => {
  it("requires the real session and verified email before claiming new access", async () => {
    const ports = fixture(false);
    expect(await continueManagedSignup(request, ports)).toEqual({
      status: "verification_required",
      appUrl: policy.returnUrl,
    });
    expect(ports.claim).not.toHaveBeenCalled();
    expect(ports.complete).not.toHaveBeenCalled();
    ports.loadSession.mockResolvedValue(null);
    expect(await continueManagedSignup(request, ports)).toMatchObject({
      status: "sign_in_required",
    });
    ports.loadSession.mockResolvedValue({
      user: { id: "other", email: "owner@example.test", emailVerified: true },
      session: { id: "session", userId: "actor" },
    });
    expect(await continueManagedSignup(request, ports)).toEqual({ status: "blocked" });
    expect(ports.claim).not.toHaveBeenCalled();
  });

  it.each([{ generations: [4] }, { generations: [], appAccessGeneration: 4 }])(
    "preserves existing private access %j without requiring a new verification or signup grant",
    async (access) => {
      const ports = fixture(false);
      ports.existingAccess.mockResolvedValue({
        actorId: "actor",
        appId: "app",
        organizationId: "org",
        ...access,
      });
      expect(await continueManagedSignup(request, ports)).toEqual({
        status: "ready",
        appUrl: policy.returnUrl,
      });
      expect(ports.claim).not.toHaveBeenCalled();
      expect(ports.complete).not.toHaveBeenCalled();
      expect(ports.resolveIntent).toHaveBeenCalledTimes(1);
    },
  );

  it("does not treat generation-zero or another actor's assignment as app admission", async () => {
    for (const existing of [
      { actorId: "actor", appId: "app", organizationId: "org", generations: [0] },
      { actorId: "other", appId: "app", organizationId: "org", generations: [4] },
      { actorId: "actor", appId: "other-app", organizationId: "org", generations: [4] },
    ]) {
      const ports = fixture(false);
      ports.existingAccess.mockResolvedValue(existing);
      expect(await continueManagedSignup(request, ports)).toMatchObject({
        status: "verification_required",
      });
      expect(ports.complete).not.toHaveBeenCalled();
    }
  });

  it("keeps GET status read-only and requires actual readback after a ready callback", async () => {
    const ports = fixture();
    expect(await continueManagedSignup({ ...request, complete: false }, ports)).toMatchObject({
      status: "pending",
    });
    expect(ports.claim).not.toHaveBeenCalled();
    expect(ports.complete).not.toHaveBeenCalled();
    expect(await continueManagedSignup(request, ports)).toMatchObject({ status: "pending" });
    expect(ports.complete).toHaveBeenCalledWith({ policyId: policy.policyId, claimId: claim.id });
    ports.readAccess
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ status: "ready", appUrl: policy.returnUrl });
    expect(await continueManagedSignup(request, ports)).toEqual({
      status: "ready",
      appUrl: policy.returnUrl,
    });
  });

  it("reuses the same claim after an unknown callback without claiming success", async () => {
    const ports = fixture();
    ports.complete.mockRejectedValue(new Error("transport unavailable"));
    for (let retry = 0; retry < 2; retry++)
      expect(await continueManagedSignup(request, ports)).toMatchObject({ status: "pending" });
    expect(ports.complete.mock.calls).toEqual([
      [{ policyId: policy.policyId, claimId: claim.id }],
      [{ policyId: policy.policyId, claimId: claim.id }],
    ]);
  });

  it("does not resume a revoked, foreign, or superseded claim", async () => {
    for (const rejected of [
      { ...claim, status: "rejected" as const, accessState: "revoked" as const },
      { ...claim, actorId: "other" },
      { ...claim, policyDigest: "e".repeat(64) },
    ]) {
      const ports = fixture();
      ports.claim.mockResolvedValue(rejected);
      expect(await continueManagedSignup(request, ports)).toEqual({ status: "blocked" });
      expect(ports.complete).not.toHaveBeenCalled();
    }
  });

  it("binds signed email continuation to the current cookie actor and exact current policy before any admission", async () => {
    const continuation = {
      purpose: "managed-app-signup-continuation-v1" as const,
      actorId: "actor",
      origin: policy.origin,
      policyId: policy.policyId,
      policyDigest: policy.policyDigest,
      appUrl: policy.returnUrl,
    };
    for (const altered of [
      { ...continuation, actorId: "other" },
      { ...continuation, policyId: "another-policy" },
      { ...continuation, policyDigest: "e".repeat(64) },
      { ...continuation, appUrl: `${policy.origin}/apps/other` },
    ]) {
      const ports = fixture();
      expect(await continueManagedSignup({ ...request, continuation: altered }, ports)).toEqual({
        status: "blocked",
      });
      expect(ports.existingAccess).not.toHaveBeenCalled();
      expect(ports.claim).not.toHaveBeenCalled();
      expect(ports.complete).not.toHaveBeenCalled();
    }
  });

  it("rejects an authentic old continuation after an approved entry-route revision", async () => {
    const secret = "managed-signup-route-revision-secret-0123456789";
    const oldUrl = await managedSignupContinuationUrl(
      {
        origin: policy.origin,
        actorId: "actor",
        policyId: policy.policyId,
        policyDigest: policy.policyDigest,
        appUrl: policy.returnUrl,
      },
      secret,
    );
    const oldContinuation = await readManagedSignupContinuation(new Request(oldUrl), secret);
    expect(oldContinuation).not.toBeNull();
    if (!oldContinuation) throw new Error("Expected signed continuation");
    const revised = {
      ...policy,
      appPath: "/apps/fixture/inbox",
      returnUrl: `${policy.origin}/apps/fixture/inbox`,
      policyDigest: "e".repeat(64),
      fenceGeneration: 2,
    };
    const ports = fixture();
    ports.resolveIntent.mockImplementation(async ({ appUrl }) =>
      appUrl === revised.returnUrl ? revised : null,
    );
    for (const appUrl of [policy.returnUrl, revised.returnUrl]) {
      expect(
        await continueManagedSignup({ ...request, appUrl, continuation: oldContinuation }, ports),
      ).toEqual({ status: "blocked" });
    }
    expect(ports.claim).not.toHaveBeenCalled();
    expect(ports.complete).not.toHaveBeenCalled();
    const currentUrl = await managedSignupContinuationUrl(
      {
        origin: revised.origin,
        actorId: "actor",
        policyId: revised.policyId,
        policyDigest: revised.policyDigest,
        appUrl: revised.returnUrl,
      },
      secret,
    );
    const currentContinuation = await readManagedSignupContinuation(
      new Request(currentUrl),
      secret,
    );
    if (!currentContinuation) throw new Error("Expected current signed continuation");
    ports.existingAccess.mockResolvedValue({
      actorId: "actor",
      appId: revised.appId,
      organizationId: revised.organizationId,
      generations: [4],
    });
    expect(
      await continueManagedSignup(
        { ...request, appUrl: revised.returnUrl, continuation: currentContinuation },
        ports,
      ),
    ).toEqual({ status: "ready", appUrl: revised.returnUrl });
  });
});
