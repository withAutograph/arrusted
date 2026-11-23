import { describe, expect, it, vi } from "vitest";
import { handoffRealmOperatorIdentityLink } from "../operator-identity-handoff";

const sender = {
  issuer: "https://oidc.vercel.com/owned-team",
  audience: "https://vercel.com/owned-team",
  ownerId: "team_owned",
  projectId: "prj_gateway",
  environment: "preview" as const,
  subject: "owner:owned-team:project:gateway:environment:preview",
};
const endpoint = "https://builder.example.test/api/hosted-operator/realm-identity";
const continuationUrl = `${endpoint}?handoff=opaque-browser-secret`;
const input = {
  config: {
    browserOrigin: "https://auth.example.test",
    builderCallbackOrigin: "https://builder.example.test",
    builderCallbackPath: "/api/hosted-operator/realm-identity" as const,
    operatorOrigin: "https://operator.example.test",
    identityHandoff: { sender },
  },
  linked: { callbackUrl: endpoint, nonce: "a".repeat(64), proof: "signed.private.proof" },
  environment: { VERCEL: "1", VERCEL_ENV: "preview", VERCEL_PROJECT_ID: sender.projectId },
};
const payload = {
  iss: sender.issuer,
  aud: sender.audience,
  sub: sender.subject,
  owner_id: sender.ownerId,
  project_id: sender.projectId,
  environment: sender.environment,
};
const ports = () => ({
  context: vi.fn(() => ({ headers: { "x-vercel-oidc-token": "provider.native.token" } })),
  verifyToken: vi.fn(async () => ({ payload })),
  fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json({ version: 1, continuationUrl })),
});

describe("private owner identity handoff", () => {
  it("stages only proof through the configured native workload and returns only an opaque continuation", async () => {
    const io = ports();
    await expect(handoffRealmOperatorIdentityLink(input, io)).resolves.toBe(continuationUrl);
    expect(io.verifyToken).toHaveBeenCalledWith("provider.native.token", {
      issuer: sender.issuer,
      audience: sender.audience,
      ownerId: sender.ownerId,
      projectId: sender.projectId,
      environment: sender.environment,
      subject: sender.subject,
    });
    expect(io.fetch).toHaveBeenCalledWith(
      endpoint,
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        headers: {
          authorization: "Bearer provider.native.token",
          "x-vercel-trusted-oidc-idp-token": "provider.native.token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          version: 1,
          purpose: "realm-owner-identity-stage-v1",
          origin: input.config.browserOrigin,
          nonce: input.linked.nonce,
          proof: input.linked.proof,
        }),
      }),
    );
  });

  it.each(["iss", "aud", "sub", "owner_id", "project_id", "environment"] as const)(
    "rejects mismatched verified %s before transferring proof",
    async (claim) => {
      const io = ports();
      io.verifyToken.mockResolvedValue({ payload: { ...payload, [claim]: "foreign" } });
      await expect(handoffRealmOperatorIdentityLink(input, io)).rejects.toThrow(
        "realm_identity_handoff_unavailable",
      );
      expect(io.fetch).not.toHaveBeenCalled();
    },
  );

  it("never falls back to an environment token when native context is absent", async () => {
    const io = ports();
    io.context.mockReturnValue({ headers: { "x-vercel-oidc-token": "" } });
    await expect(
      handoffRealmOperatorIdentityLink(
        {
          ...input,
          environment: {
            ...input.environment,
            VERCEL_OIDC_TOKEN: "environment.fallback.token",
          },
        },
        io,
      ),
    ).rejects.toThrow("realm_identity_handoff_unavailable");
    expect(io.verifyToken).not.toHaveBeenCalled();
    expect(io.fetch).not.toHaveBeenCalled();
  });

  it("rejects a substituted callback target before any proof transfer", async () => {
    const io = ports();
    await expect(
      handoffRealmOperatorIdentityLink(
        {
          ...input,
          linked: {
            ...input.linked,
            callbackUrl: "https://foreign.test/api/hosted-operator/realm-identity",
          },
        },
        io,
      ),
    ).rejects.toThrow("realm_identity_handoff_unavailable");
    expect(io.fetch).not.toHaveBeenCalled();
  });

  it.each([
    "https://foreign.test/api/hosted-operator/realm-identity?handoff=secret",
    "https://builder.example.test/other?handoff=secret",
    `${endpoint}?handoff=secret&proof=raw`,
    `${endpoint}?handoff=one&handoff=two`,
    `${endpoint}?handoff=`,
    `${endpoint}?handoff=secret#fragment`,
    "https://user:password@builder.example.test/api/hosted-operator/realm-identity?handoff=secret",
  ])("rejects an unsafe continuation %s", async (url) => {
    const io = ports();
    io.fetch.mockResolvedValue(Response.json({ version: 1, continuationUrl: url }));
    await expect(handoffRealmOperatorIdentityLink(input, io)).rejects.toThrow(
      "realm_identity_handoff_unavailable",
    );
  });

  it("rejects native verification failure without transferring proof", async () => {
    const io = ports();
    io.verifyToken.mockRejectedValue(new Error("native signature invalid"));
    await expect(handoffRealmOperatorIdentityLink(input, io)).rejects.toThrow(
      "realm_identity_handoff_unavailable",
    );
    expect(io.fetch).not.toHaveBeenCalled();
  });

  it.each([
    new Response("denied", { status: 403 }),
    new Response("not json"),
    Response.json({ version: 2, continuationUrl }),
    new Response("x".repeat(4097), { headers: { "content-type": "application/json" } }),
  ])("rejects failed, malformed or oversized private replies", async (response) => {
    const io = ports();
    io.fetch.mockResolvedValue(response);
    await expect(handoffRealmOperatorIdentityLink(input, io)).rejects.toThrow(
      "realm_identity_handoff_unavailable",
    );
  });
});

const delayedHandoffReply = (
  signal: AbortSignal | null | undefined,
  duration: number,
  response: Response,
) =>
  new Promise<Response>((resolve, reject) => {
    if (!signal) {
      reject(new Error("Callback must be abortable"));
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve(response);
    }, duration);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
const fakeHandoffClock = () => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation((duration) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), duration);
    return controller.signal;
  });
};

describe("bounded owner identity callback latency", () => {
  it("acknowledges a slow valid handoff without widening the returned browser destination", async () => {
    fakeHandoffClock();
    const io = ports();
    io.fetch.mockImplementation((_url, init) =>
      delayedHandoffReply(init?.signal, 25_000, Response.json({ version: 1, continuationUrl })),
    );
    const outcome = handoffRealmOperatorIdentityLink(input, io).then(
      (url) => url,
      () => "failed",
    );
    try {
      await vi.advanceTimersByTimeAsync(25_000);
      expect(await outcome).toBe(continuationUrl);
      expect(io.fetch).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("aborts an unknown handoff within its fixed budget without retrying or returning proof", async () => {
    fakeHandoffClock();
    const io = ports();
    const logs = vi.spyOn(console, "info").mockImplementation(() => {});
    io.fetch.mockImplementation((_url, init) =>
      delayedHandoffReply(init?.signal, 90_000, Response.json({ version: 1, continuationUrl })),
    );
    const outcome = handoffRealmOperatorIdentityLink(input, io).then(
      () => null,
      (error: Error) => error,
    );
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect((await outcome)?.message).toBe("realm_identity_handoff_unavailable");
      expect(io.fetch).toHaveBeenCalledTimes(1);
      expect(logs).toHaveBeenCalledWith("[auth:operator-callback]", {
        transport: "identity-handoff",
        phase: "identity-handoff",
        outcome: "timeout",
        transportTimeout: true,
      });
      const output = JSON.stringify(logs.mock.calls);
      for (const secret of [
        input.linked.nonce,
        input.linked.proof,
        continuationUrl,
        endpoint,
        "provider.native.token",
      ]) {
        expect(output).not.toContain(secret);
      }
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
});
