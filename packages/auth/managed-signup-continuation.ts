import { z } from "zod";
import type { ManagedAppSignupClaim, ManagedAppSignupPolicy } from "./managed-app-signup";
import { managedSignupAppUrl, type ManagedSignupContinuation } from "./managed-signup-request";

const sessionSchema = z.object({
  user: z.object({ id: z.string().min(1), email: z.email(), emailVerified: z.boolean() }),
  session: z.object({ id: z.string().min(1), userId: z.string().min(1) }),
});
type Identity = { policyId: string; policyDigest: string; actorId: string; sessionId: string };
type Ready = { status: "ready"; appUrl: string };
export type ManagedSignupContinuationPorts = {
  loadSession(): Promise<unknown>;
  resolveIntent(input: { appUrl: string; email?: string }): Promise<ManagedAppSignupPolicy | null>;
  existingAccess(policy: ManagedAppSignupPolicy): Promise<{
    actorId: string;
    appId: string;
    organizationId: string;
    generations: readonly number[];
    appAccessGeneration?: number;
  } | null>;
  readAccess(identity: Identity): Promise<Ready | null>;
  claim(identity: Identity): Promise<ManagedAppSignupClaim | null>;
  complete(input: { policyId: string; claimId: string }): Promise<"ready" | "pending">;
  continuationUrl(input: Identity & { appUrl: string }): Promise<string>;
};

/** Authenticated readers and the protected callback supply authority; request fields supply no identity. */
export async function continueManagedSignup(
  input: {
    origin: string;
    appUrl?: string;
    complete: boolean;
    continuation?: ManagedSignupContinuation;
  },
  ports: ManagedSignupContinuationPorts,
) {
  const target = input.appUrl && managedSignupAppUrl(input.appUrl, input.origin);
  if (!target) return { status: "blocked" as const };
  const policy = await ports.resolveIntent({ appUrl: target });
  if (!policy) return { status: "blocked" as const };
  const session = sessionSchema.safeParse(await ports.loadSession());
  if (!session.success) return { status: "sign_in_required" as const, appUrl: policy.returnUrl };
  const { user, session: signedSession } = session.data;
  if (signedSession.userId !== user.id) return { status: "blocked" as const };
  const continuation = input.continuation;
  if (
    continuation &&
    (continuation.actorId !== user.id ||
      continuation.policyId !== policy.policyId ||
      continuation.policyDigest !== policy.policyDigest ||
      continuation.appUrl !== policy.returnUrl ||
      continuation.origin !== input.origin)
  )
    return { status: "blocked" as const };
  const existing = await ports.existingAccess(policy);
  const positive = (generation: number) => Number.isSafeInteger(generation) && generation > 0;
  if (
    existing &&
    existing.actorId === user.id &&
    existing.appId === policy.appId &&
    existing.organizationId === policy.organizationId &&
    ((existing.appAccessGeneration !== undefined && positive(existing.appAccessGeneration)) ||
      (existing.generations.length > 0 && existing.generations.every(positive)))
  )
    return { status: "ready" as const, appUrl: policy.returnUrl };
  const eligible = await ports.resolveIntent({ appUrl: target, email: user.email });
  if (
    !eligible ||
    eligible.policyId !== policy.policyId ||
    eligible.policyDigest !== policy.policyDigest
  )
    return { status: "blocked" as const };
  if (!user.emailVerified)
    return { status: "verification_required" as const, appUrl: policy.returnUrl };
  const identity = {
    policyId: policy.policyId,
    policyDigest: policy.policyDigest,
    actorId: user.id,
    sessionId: signedSession.id,
  };
  const access = await ports.readAccess(identity);
  if (access?.appUrl === policy.returnUrl) return access;
  if (!input.complete) return { status: "pending" as const, appUrl: policy.returnUrl };
  const claim = await ports.claim(identity);
  if (
    !claim ||
    claim.status === "rejected" ||
    claim.policyId !== policy.policyId ||
    claim.policyDigest !== policy.policyDigest ||
    claim.actorId !== user.id ||
    claim.sessionId !== signedSession.id ||
    claim.returnUrl !== policy.returnUrl
  )
    return { status: "blocked" as const };
  try {
    const status = await ports.complete({ policyId: claim.policyId, claimId: claim.id });
    if (status === "ready") {
      const current = await ports.readAccess(identity);
      if (current?.appUrl === policy.returnUrl) return current;
    }
  } catch {
    // Retry the same durable claim; an uncertain callback never proves admission.
  }
  return {
    status: "pending" as const,
    appUrl: policy.returnUrl,
    continuationUrl: await ports.continuationUrl({ ...identity, appUrl: policy.returnUrl }),
  };
}
