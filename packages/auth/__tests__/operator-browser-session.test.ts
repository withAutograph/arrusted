import { memoryAdapter } from "@better-auth/memory-adapter";
import { betterAuth } from "better-auth";
import { describe, expect, it, vi } from "vitest";
import {
  captureOperatorNormalBrowserSession,
  operatorNormalCookieDigest,
  readOperatorNormalCookie,
} from "../operator-browser-session";

const sender = {
  issuer: "https://oidc.vercel.com/owned-team",
  audience: "https://vercel.com/owned-team",
  ownerId: "team_owned",
  projectId: "prj_actual_auth",
  environment: "preview" as const,
  subject: "owner:owned-team:project:actual-auth:environment:preview",
};
const input = {
  config: {
    browserOrigin: "https://auth.example.test",
    builderCallbackOrigin: "https://builder.example.test",
    builderCallbackPath: "/api/hosted-operator/realm-identity" as const,
    operatorOrigin: "https://operator.example.test",
    browserSessionCapture: { path: "/api/hosted-operator/realm-browser-session" as const, sender },
  },
  challenge: {
    nonce: "a".repeat(64),
    ownerSessionId: "owner-session",
    bootstrapPlanDigest: "b".repeat(64),
    authResourceId: "auth-resource",
    organizationId: null,
    browserSession: {
      operationRef: "da2f2a9a-21ce-4a33-9107-d88ae5f353d6",
      participantProgramDigest: "c".repeat(64),
    },
  },
  proof: "signed.proof.bytes",
  normalCookie: {
    name: "__Secure-better-auth.session_token",
    value: "actual-signed-value%2Bsignature",
    domain: "auth.example.test",
    path: "/",
    expires: -1 as const,
    secure: true as const,
    httpOnly: true as const,
    sameSite: "Lax" as const,
    hostOnly: true,
  },
  environment: { VERCEL: "1", VERCEL_ENV: "preview", VERCEL_PROJECT_ID: sender.projectId },
};
const payload = {
  iss: sender.issuer,
  aud: sender.audience,
  sub: sender.subject,
  project_id: sender.projectId,
  owner_id: sender.ownerId,
  environment: sender.environment,
};
const ports = () => ({
  context: vi.fn(() => ({ headers: { "x-vercel-oidc-token": "provider.native.token" } })),
  verifyToken: vi.fn(async () => ({ payload, protectedHeader: { alg: "RS256" } })),
  fetch: vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ authorized: true }))
    .mockResolvedValueOnce(Response.json({ captured: true })),
});

describe("actual normal session private sender", () => {
  it("checks exact native sender, authorizes without cookie, then sends once to fixed Builder path", async () => {
    const io = ports();
    await captureOperatorNormalBrowserSession(input, io);
    expect(io.verifyToken).toHaveBeenCalledWith("provider.native.token", {
      issuer: sender.issuer,
      audience: sender.audience,
      projectId: sender.projectId,
      ownerId: sender.ownerId,
      environment: "preview",
      subject: sender.subject,
    });
    expect(io.fetch).toHaveBeenCalledTimes(2);
    const [authorization, capture] = io.fetch.mock.calls;
    const expectedEndpoint =
      "https://builder.example.test/api/hosted-operator/realm-browser-session";
    expect(authorization?.[0]).toBe(expectedEndpoint);
    expect(capture?.[0]).toBe(expectedEndpoint);
    const first = JSON.parse(authorization?.[1]?.body as string);
    const second = JSON.parse(capture?.[1]?.body as string);
    expect(first).toMatchObject({
      phase: "authorize",
      reviewedNonce: input.challenge.nonce,
      ...input.challenge.browserSession,
      proof: input.proof,
      origin: input.config.browserOrigin,
    });
    expect(first).not.toHaveProperty("normalCookie");
    expect(second).toEqual({ ...first, phase: "capture", normalCookie: input.normalCookie });
    expect(capture?.[1]).toMatchObject({
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
    });
    expect(capture?.[1]?.headers).toMatchObject({ authorization: "Bearer provider.native.token" });
  });

  it("transports a real ordinary signup cookie that remains usable by the same Auth realm", async () => {
    const auth = betterAuth({
      baseURL: input.config.browserOrigin,
      secret: "isolated-normal-cookie-fixture-secret-32chars",
      database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
      emailAndPassword: { enabled: true },
      advanced: { useSecureCookies: true },
    });
    const signup = await auth.handler(
      new Request(`${input.config.browserOrigin}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { origin: input.config.browserOrigin, "content-type": "application/json" },
        body: JSON.stringify({
          email: "normal-owner@example.test",
          name: "Normal Owner",
          password: "ordinary-signup-fixture-password",
        }),
      }),
    );
    expect(signup.ok).toBe(true);
    const context = await auth.$context;
    const cookieDefinition = context.authCookies.sessionToken;
    const setCookie = signup.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${cookieDefinition.name}=`));
    expect(setCookie).toBeDefined();
    const headers = new Headers({ cookie: setCookie!.split(";", 1)[0]! });
    const signedIn = await auth.api.getSession({ headers });
    expect(signedIn?.user.email).toBe("normal-owner@example.test");
    const normalCookie = readOperatorNormalCookie({
      headers,
      origin: input.config.browserOrigin,
      cookie: cookieDefinition,
    });
    const io = ports();
    await captureOperatorNormalBrowserSession({ ...input, normalCookie }, io);
    const transported = JSON.parse(io.fetch.mock.calls[1]![1]!.body as string).normalCookie;
    const resumed = await auth.api.getSession({
      headers: new Headers({ cookie: `${transported.name}=${transported.value}` }),
    });
    expect(resumed?.user.id).toBe(signedIn?.user.id);
    expect(resumed?.session.id).toBe(signedIn?.session.id);
    expect(transported.domain).toBe(new URL(input.config.browserOrigin).hostname);
  });

  it.each(["iss", "aud", "sub", "owner_id", "project_id", "environment"] as const)(
    "rejects a mismatched verified %s before any network transfer",
    async (claim) => {
      const io = ports();
      io.verifyToken.mockResolvedValue({
        payload: { ...payload, [claim]: "other" },
        protectedHeader: { alg: "RS256" },
      });
      await expect(captureOperatorNormalBrowserSession(input, io)).rejects.toThrow(
        "realm_browser_session_capture_unavailable",
      );
      expect(io.fetch).not.toHaveBeenCalled();
    },
  );

  it("refuses environment OIDC fallback and a Gateway project substituted for the Auth sender", async () => {
    const io = ports();
    io.context.mockReturnValue({ headers: { "x-vercel-oidc-token": "" } });
    await expect(
      captureOperatorNormalBrowserSession(
        {
          ...input,
          environment: { ...input.environment, VERCEL_OIDC_TOKEN: "provider.native.token" },
        },
        io,
      ),
    ).rejects.toThrow();
    expect(io.verifyToken).not.toHaveBeenCalled();
    expect(io.fetch).not.toHaveBeenCalled();
    await expect(
      captureOperatorNormalBrowserSession(
        { ...input, environment: { ...input.environment, VERCEL_PROJECT_ID: "prj_gateway" } },
        ports(),
      ),
    ).rejects.toThrow();
  });

  it.each([
    Response.json({ authorized: false }),
    Response.json({ authorized: true, cookie: "credential-echo" }),
    new Response("untrusted body", { status: 403 }),
    new Response("x".repeat(1025), { headers: { "content-type": "application/json" } }),
    new Response(null, { status: 302, headers: { location: "https://other.example.test" } }),
  ])("never sends a cookie after an invalid authorization ACK", async (response) => {
    const io = ports();
    io.fetch.mockReset().mockResolvedValue(response);
    await expect(captureOperatorNormalBrowserSession(input, io)).rejects.toThrow(
      "realm_browser_session_capture_unavailable",
    );
    expect(io.fetch).toHaveBeenCalledTimes(1);
    expect(io.fetch.mock.calls[0]?.[1]?.body).not.toContain(input.normalCookie.value);
  });

  it("redacts transport errors and never returns session bytes after successful capture", async () => {
    const io = ports();
    io.fetch.mockReset().mockRejectedValue(new Error(input.normalCookie.value));
    await expect(captureOperatorNormalBrowserSession(input, io)).rejects.toThrow(
      /^realm_browser_session_capture_unavailable$/u,
    );
    await expect(captureOperatorNormalBrowserSession(input, ports())).resolves.toBeUndefined();
  });
});

describe("real Better Auth cookie scope projection", () => {
  const cookieInput = {
    origin: input.config.browserOrigin,
    headers: new Headers({
      cookie: `unrelated=discard; ${input.normalCookie.name}=${input.normalCookie.value}`,
    }),
    cookie: {
      name: input.normalCookie.name,
      attributes: { path: "/", secure: true, httpOnly: true, sameSite: "lax" as const },
    },
  };
  it("preserves actual encoded value and host-only scope without replaying unrelated cookies", () => {
    const cookie = readOperatorNormalCookie(cookieInput);
    expect(cookie).toEqual(input.normalCookie);
    expect(operatorNormalCookieDigest(cookie)).toMatch(/^[a-f0-9]{64}$/u);
    expect(operatorNormalCookieDigest({ ...cookie, value: "different" })).not.toBe(
      operatorNormalCookieDigest(cookie),
    );
  });
  it("preserves a configured domain and path, never rewrites it to the destination host", () => {
    expect(
      readOperatorNormalCookie({
        ...cookieInput,
        cookie: {
          ...cookieInput.cookie,
          attributes: { ...cookieInput.cookie.attributes, domain: ".example.test", path: "/api" },
        },
      }),
    ).toMatchObject({
      domain: ".example.test",
      path: "/api",
      hostOnly: false,
    });
  });
  it.each([
    { headers: new Headers() },
    {
      headers: new Headers({
        cookie: `${input.normalCookie.name}=first; ${input.normalCookie.name}=second`,
      }),
    },
    {
      cookie: {
        ...cookieInput.cookie,
        attributes: { ...cookieInput.cookie.attributes, domain: "builder.example.test" },
      },
    },
    {
      cookie: {
        ...cookieInput.cookie,
        attributes: { ...cookieInput.cookie.attributes, httpOnly: false },
      },
    },
    { origin: "http://auth.example.test" },
  ])("fails closed on absent, ambiguous, insecure, or foreign-scope cookies", (change) => {
    expect(() => readOperatorNormalCookie({ ...cookieInput, ...change })).toThrow(
      /^realm_browser_session_cookie_required$/u,
    );
  });
});

const fakeCallbackClock = () => {
  vi.useFakeTimers();
  // Model the native timeout against the same fake clock, including the old implementation's deadline.
  vi.spyOn(AbortSignal, "timeout").mockImplementation((duration) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), duration);
    return controller.signal;
  });
};
const delayedCallbackReply = (
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

describe("bounded normal-session callback latency", () => {
  it("acknowledges slow valid authorization before releasing the credential", async () => {
    fakeCallbackClock();
    const io = ports();
    io.fetch.mockReset().mockImplementation((_url, init) => {
      const phase = JSON.parse(init!.body as string).phase;
      return delayedCallbackReply(
        init?.signal,
        phase === "authorize" ? 25_000 : 12_000,
        Response.json(phase === "authorize" ? { authorized: true } : { captured: true }),
      );
    });
    const outcome = captureOperatorNormalBrowserSession(input, io).then(
      () => "acknowledged",
      () => "failed",
    );
    try {
      await vi.advanceTimersByTimeAsync(24_999);
      expect(io.fetch).toHaveBeenCalledTimes(1);
      expect(io.fetch.mock.calls[0]?.[1]?.body).not.toContain(input.normalCookie.value);
      await vi.advanceTimersByTimeAsync(1);
      expect(io.fetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(12_000);
      expect(await outcome).toBe("acknowledged");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("bounds unknown authorization and never sends a capture credential or retries", async () => {
    fakeCallbackClock();
    const io = ports();
    const logs = vi.spyOn(console, "info").mockImplementation(() => {});
    io.fetch
      .mockReset()
      .mockImplementation((_url, init) =>
        delayedCallbackReply(init?.signal, 90_000, Response.json({ authorized: true })),
      );
    const outcome = captureOperatorNormalBrowserSession(input, io).then(
      () => null,
      (error: Error) => error,
    );
    try {
      await vi.advanceTimersByTimeAsync(59_999);
      expect(io.fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect((await outcome)?.message).toBe("realm_browser_session_capture_unavailable");
      expect(io.fetch).toHaveBeenCalledTimes(1);
      expect(io.fetch.mock.calls[0]?.[1]?.body).not.toContain(input.normalCookie.value);
      expect(logs).toHaveBeenCalledWith("[auth:operator-callback]", {
        transport: "browser-session",
        phase: "authorize",
        outcome: "timeout",
        transportTimeout: true,
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("shares the total deadline across authorize and capture rather than extending it per phase", async () => {
    fakeCallbackClock();
    const io = ports();
    const logs = vi.spyOn(console, "info").mockImplementation(() => {});
    io.fetch.mockReset().mockImplementation((_url, init) => {
      const phase = JSON.parse(init!.body as string).phase;
      return delayedCallbackReply(
        init?.signal,
        40_000,
        Response.json(phase === "authorize" ? { authorized: true } : { captured: true }),
      );
    });
    const outcome = captureOperatorNormalBrowserSession(input, io).then(
      () => null,
      (error: Error) => error,
    );
    try {
      await vi.advanceTimersByTimeAsync(40_000);
      expect(io.fetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(20_000);
      expect((await outcome)?.message).toBe("realm_browser_session_capture_unavailable");
      expect(logs).toHaveBeenCalledWith(
        "[auth:operator-callback]",
        expect.objectContaining({ phase: "capture", outcome: "timeout" }),
      );
      await vi.advanceTimersByTimeAsync(60_000);
      expect(io.fetch).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it.each(["transport-failure", "http-rejected", "invalid-acknowledgement"] as const)(
    "reports only closed %s facts without private material",
    async (failure) => {
      const io = ports();
      const logs = vi.spyOn(console, "info").mockImplementation(() => {});
      io.fetch.mockReset();
      if (failure === "transport-failure") {
        io.fetch.mockRejectedValue(new Error(`${input.proof} ${input.normalCookie.value}`));
      } else {
        io.fetch.mockResolvedValue(
          failure === "http-rejected"
            ? new Response("private server body", { status: 401 })
            : Response.json({ authorized: false, private: input.proof }),
        );
      }
      try {
        await expect(captureOperatorNormalBrowserSession(input, io)).rejects.toThrow(
          "realm_browser_session_capture_unavailable",
        );
        expect(io.fetch).toHaveBeenCalledTimes(1);
        expect(logs).toHaveBeenCalledWith("[auth:operator-callback]", {
          transport: "browser-session",
          phase: "authorize",
          outcome: failure,
          transportTimeout: false,
        });
        const output = JSON.stringify(logs.mock.calls);
        for (const secret of [
          input.proof,
          input.normalCookie.value,
          input.challenge.nonce,
          input.config.browserOrigin,
          "provider.native.token",
          input.challenge.ownerSessionId,
          input.challenge.browserSession.operationRef,
          "private server body",
        ]) {
          expect(output).not.toContain(secret);
        }
      } finally {
        logs.mockRestore();
      }
    },
  );
});

it("waits for a slow authorization response body before sending any capture credential", async () => {
  fakeCallbackClock();
  const io = ports();
  io.fetch
    .mockReset()
    .mockImplementationOnce((_url, init) => {
      const signal = init?.signal;
      if (!signal) {
        return Promise.reject(new Error("Callback must be abortable"));
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const abort = () => {
            clearTimeout(timer);
            controller.error(signal.reason);
          };
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ authorized: true })));
            controller.close();
          }, 25_000);
          signal.addEventListener("abort", abort, { once: true });
        },
      });
      return Promise.resolve(
        new Response(body, { headers: { "content-type": "application/json" } }),
      );
    })
    .mockResolvedValueOnce(Response.json({ captured: true }));
  const outcome = captureOperatorNormalBrowserSession(input, io).then(
    () => "acknowledged",
    () => "failed",
  );
  try {
    await vi.advanceTimersByTimeAsync(24_999);
    expect(io.fetch).toHaveBeenCalledTimes(1);
    expect(io.fetch.mock.calls[0]?.[1]?.body).not.toContain(input.normalCookie.value);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBe("acknowledged");
    expect(io.fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});
