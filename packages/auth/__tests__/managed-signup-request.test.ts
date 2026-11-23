// @vitest-environment node
import { memoryAdapter } from "@better-auth/memory-adapter";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { signJWT } from "better-auth/crypto";
import type { Resend } from "resend";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const delivery = vi.hoisted(() => ({ send: vi.fn<Resend["emails"]["send"]>() }));
// Only the external email transport is replaced; Better Auth creates users, tokens and sessions.
vi.mock("resend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("resend")>();
  return {
    ...actual,
    Resend: class extends actual.Resend {
      constructor(key: string) {
        super(key);
        this.emails.send = delivery.send;
      }
    },
  };
});

import {
  createManagedSignupRequestHandler,
  createManagedSignupVerification,
  managedSignupContinuationUrl,
  readManagedSignupContinuation,
  managedSignupAppUrl,
  type ManagedSignupIntentResolver,
} from "../managed-signup-request";

const origin = "http://localhost:3000";
const appUrl = `${origin}/apps/signup-fixture`;
const email = "new-user@example.test";
const password = "fixture-password-123";
const secret = "managed-signup-fixture-secret-0123456789";
const policy = { policyId: "policy-fixture", policyDigest: "a".repeat(64), returnUrl: appUrl };

function fixture() {
  const data: Record<
    "user" | "account" | "session" | "verification" | "member" | "app_actor_assignment",
    Record<string, unknown>[]
  > = {
    user: [],
    account: [],
    session: [],
    verification: [],
    member: [],
    app_actor_assignment: [],
  };
  const resolveIntent = vi.fn<ManagedSignupIntentResolver>(async (input) =>
    input.appUrl === appUrl && (!input.email || input.email.toLowerCase() === email)
      ? policy
      : null,
  );
  const options: BetterAuthOptions = {
    baseURL: origin,
    secret,
    database: memoryAdapter(data),
    trustedOrigins: [origin],
    emailAndPassword: { enabled: true, disableSignUp: true },
    emailVerification: createManagedSignupVerification({
      source: {
        AUTH_RECOVERY_RESEND_API_KEY: "fixture-key",
        AUTH_RECOVERY_EMAIL_FROM: "auth@example.test",
      },
      appName: "Autograph",
      origin,
      secret,
      resolveIntent,
    }),
    logger: { disabled: true },
  };
  const normal = betterAuth(options);
  const signup = createManagedSignupRequestHandler({ options, origin, resolveIntent });
  const request = (body: Record<string, unknown> = {}, requestOrigin = origin) =>
    new Request(`${origin}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { origin: requestOrigin, "content-type": "application/json" },
      body: JSON.stringify({ email, password, name: "New User", callbackURL: appUrl, ...body }),
    });
  return { data, options, normal, signup, request, resolveIntent };
}

beforeEach(() => {
  delivery.send
    .mockReset()
    .mockResolvedValue({ data: { id: "controlled-send" }, error: null, headers: null });
});

describe("policy-bound Production password signup", () => {
  it("rejects an oversized chunked body promptly, cancels its reader and stops consuming", async () => {
    const f = fixture();
    let pulls = 0;
    let cancelled = false;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>(
      {
        start(value) {
          controller = value;
        },
        pull(value) {
          pulls++;
          if (pulls <= 2) value.enqueue(new Uint8Array(pulls === 1 ? 4096 : 4097));
        },
        // Even a peer that never finishes cancellation cannot hold the response open.
        cancel() {
          cancelled = true;
          return new Promise<void>(() => {});
        },
      },
      { highWaterMark: 0 },
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const request = new Request(`${origin}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" });
      const response = await Promise.race([
        f.signup(request),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("body limit did not respond")), 500);
        }),
      ]);
      expect(response.status).toBe(403);
      expect(cancelled).toBe(true);
      expect(pulls).toBe(2);
      expect(f.data.user).toEqual([]);
      expect(f.resolveIntent).not.toHaveBeenCalled();
    } finally {
      clearTimeout(timer);
      if (!cancelled) controller!.close();
    }
  });

  it("accepts a valid signup body exactly at the existing byte limit", async () => {
    const f = fixture();
    const input = { email, password, name: "New 🌱 User", callbackURL: appUrl, padding: "" };
    const base = JSON.stringify(input);
    const text = JSON.stringify({
      ...input,
      padding: "a".repeat(8192 - new TextEncoder().encode(base).length),
    });
    const encoded = new TextEncoder().encode(text);
    expect(encoded.length).toBe(8192);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const split = encoded.indexOf(0xf0) + 1;
        controller.enqueue(encoded.slice(0, split));
        controller.enqueue(encoded.slice(split));
        controller.close();
      },
    });
    const response = await f.signup(
      new Request(`${origin}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    );
    expect(response.status).toBe(200);
    expect(f.data.user).toHaveLength(1);
    expect(f.data.user[0]?.name).toBe(input.name);
  });

  it("keeps ordinary signup disabled and rejects missing, foreign, unrelated and ineligible targets before user creation", async () => {
    const f = fixture();
    expect((await f.normal.handler(f.request())).status).toBe(400);
    for (const body of [
      { callbackURL: undefined },
      { callbackURL: "https://other.example/apps/signup-fixture" },
      { callbackURL: `${origin}/apps/private-unrelated` },
      { email: "not-eligible@example.test" },
    ])
      expect((await f.signup(f.request(body))).status).toBe(403);
    expect((await f.signup(f.request({}, "https://other.example"))).status).toBe(403);
    expect(f.data.user).toEqual([]);
    expect(f.data.session).toEqual([]);
    expect(delivery.send).not.toHaveBeenCalled();
  });

  it("rechecks policy at the user-create boundary and preserves a revoked policy", async () => {
    const f = fixture();
    f.resolveIntent.mockResolvedValueOnce(policy).mockResolvedValue(null);
    expect((await f.signup(f.request())).ok).toBe(false);
    expect(f.data.user).toEqual([]);
    expect(delivery.send).not.toHaveBeenCalled();
  });

  it("requires a configured verification sender before creating an account", async () => {
    const f = fixture();
    const signup = createManagedSignupRequestHandler({
      options: { ...f.options, emailVerification: undefined },
      origin,
      resolveIntent: f.resolveIntent,
    });
    expect((await signup(f.request())).status).toBe(403);
    expect(f.data.user).toEqual([]);
  });

  it("sends a clickable verification link with the exact continuation and keeps the account unverified until it is opened", async () => {
    const f = fixture();
    const [allowed, denied] = await Promise.all([
      f.signup(f.request()),
      f.normal.handler(f.request({ email: "other@example.test" })),
    ]);
    expect(allowed.status).toBe(200);
    expect(denied.status).toBe(400);
    expect(await allowed.json()).toMatchObject({ token: null, user: { emailVerified: false } });
    expect(f.data.user).toHaveLength(1);
    expect(f.data.session).toEqual([]);
    expect(f.data.member).toEqual([]);
    expect(f.data.app_actor_assignment).toEqual([]);
    expect(f.options.emailAndPassword).toEqual({ enabled: true, disableSignUp: true });
    const sent = delivery.send.mock.calls[0]?.[0];
    expect(sent).toMatchObject({ from: "auth@example.test", to: email });
    const link = String(sent?.text).split("\n")[1]!;
    expect(link.length).toBeGreaterThan(76);
    const href = /<a\b[^>]*\bhref="([^"]+)"/u.exec(String(sent?.html))?.[1] ?? "";
    expect(href).toContain("&amp;");
    const clickedLink = href.replaceAll("&amp;", "&");
    expect(clickedLink).toBe(link);
    expect(new URL(link).origin).toBe(origin);
    const callback = new URL(link).searchParams.get("callbackURL")!;
    expect(await readManagedSignupContinuation(new Request(callback), secret)).toMatchObject({
      actorId: f.data.user[0]?.id,
      policyId: policy.policyId,
      policyDigest: policy.policyDigest,
      appUrl,
    });
    const verified = await f.normal.handler(new Request(clickedLink));
    expect(verified.status).toBe(302);
    expect(verified.headers.get("location")).toBe(callback);
    expect(f.data.user[0]?.emailVerified).toBe(true);
    expect(f.data.session).toHaveLength(1);
    const replay = await f.normal.handler(new Request(link));
    expect(replay.headers.get("set-cookie")).toBeNull();
    expect(f.data.session).toHaveLength(1);
  });

  it("preserves existing unverified private-account sign-in without a global verification requirement", async () => {
    const f = fixture();
    const setup = betterAuth({
      ...f.options,
      emailAndPassword: { enabled: true },
      emailVerification: undefined,
    });
    await setup.api.signUpEmail({
      body: { email: "legacy@example.test", password, name: "Legacy" },
    });
    const signedIn = await f.normal.api.signInEmail({
      body: { email: "legacy@example.test", password },
    });
    expect(signedIn.user.emailVerified).toBe(false);
    expect(signedIn.token).toBeTruthy();
    expect(delivery.send).not.toHaveBeenCalled();
    await expect(
      f.normal.api.signUpEmail({ body: { email, password, name: "New" } }),
    ).rejects.toThrow();
  });

  it("rejects a verification resend for a private or foreign target without sending a message", async () => {
    const f = fixture();
    await f.signup(f.request());
    delivery.send.mockClear();
    await expect(
      f.normal.api.sendVerificationEmail({
        body: {
          email,
          callbackURL: `${origin}/apps/private-unrelated`,
        },
      }),
    ).rejects.toThrow("app_signup_verification_unavailable");
    expect(delivery.send).not.toHaveBeenCalled();
    await f.normal.api.sendVerificationEmail({ body: { email, callbackURL: appUrl } });
    expect(delivery.send).toHaveBeenCalledTimes(1);
  });

  it("accepts only same-origin continuation candidates without trusting them as policy", () => {
    expect(managedSignupAppUrl(appUrl, origin)).toBe(appUrl);
    for (const target of [
      "https://other.example/app",
      `${origin}/app#fragment`,
      "http://user@localhost:3000/app",
    ])
      expect(managedSignupAppUrl(target, origin)).toBeNull();
  });

  it("rejects unsigned, forged, expired, foreign-origin and target-tampered GET continuations", async () => {
    const url = await managedSignupContinuationUrl(
      {
        origin,
        actorId: "actor",
        policyId: policy.policyId,
        policyDigest: policy.policyDigest,
        appUrl,
      },
      secret,
    );
    const valid = await readManagedSignupContinuation(new Request(url), secret);
    expect(valid).toMatchObject({ actorId: "actor", policyId: policy.policyId, appUrl });
    const altered = new URL(url);
    altered.searchParams.set("appUrl", `${origin}/apps/other`);
    const forged = new URL(url);
    const pieces = forged.searchParams.get("state")!.split(".");
    pieces[1] = Buffer.from(JSON.stringify({ ...valid, appUrl: `${origin}/apps/other` })).toString(
      "base64url",
    );
    forged.searchParams.set("state", pieces.join("."));
    const expired = new URL(url);
    expired.searchParams.set("state", await signJWT(valid, secret, -1));
    const foreign = new URL(url);
    foreign.host = "other.example";
    for (const candidate of [
      `${origin}/api/auth/platform/signup-continue?appUrl=${encodeURIComponent(appUrl)}`,
      altered.toString(),
      forged.toString(),
      expired.toString(),
      foreign.toString(),
    ])
      expect(await readManagedSignupContinuation(new Request(candidate), secret)).toBeNull();
    expect(
      await readManagedSignupContinuation(
        new Request(url),
        "other-secret-01234567890123456789012345",
      ),
    ).toBeNull();
  });
});
