import { memoryAdapter } from "@better-auth/memory-adapter";
import type { CreateEmailOptions, CreateEmailResponse } from "resend";
import { betterAuth } from "better-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mail = vi.hoisted(() => ({
  send: vi.fn<(options: CreateEmailOptions) => Promise<CreateEmailResponse>>(),
  create: vi.fn(),
}));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: mail.send };
    constructor(apiKey: string) {
      mail.create({ apiKey });
    }
  },
}));

import { passwordRecoveryEnabledForEnvironment } from "../env";
import { createPasswordRecoveryOptions } from "../password-recovery";
import { createAuthOptions } from "../server";
import { createAuthViewPaths } from "../ui-view-paths";

const origin = "http://localhost:3000";
const environment = {
  PLATFORM_AUTH_DATABASE_URL: "postgres://auth@127.0.0.1/auth",
  BETTER_AUTH_URL: origin,
  BETTER_AUTH_SECRET: "recovery-fixture-secret-01234567890123456789",
  AUTH_RECOVERY_RESEND_API_KEY: "fixture-email-key",
  AUTH_RECOVERY_EMAIL_FROM: "recovery@example.test",
};
const pools: ReturnType<typeof createAuthOptions>["database"][] = [];

function fixture(backgroundTasks?: { handler: (task: Promise<unknown>) => void }) {
  const configured = createAuthOptions({
    appName: "Recovery Fixture",
    env: environment,
    backgroundTasks,
  });
  pools.push(configured.database);
  const data: Record<
    | "account"
    | "user"
    | "session"
    | "verification"
    | "organization"
    | "member"
    | "app_actor_assignment",
    Record<string, unknown>[]
  > = {
    account: [],
    user: [],
    session: [],
    verification: [],
    organization: [],
    member: [],
    app_actor_assignment: [],
  };
  const auth = betterAuth({
    baseURL: origin,
    secret: environment.BETTER_AUTH_SECRET,
    database: memoryAdapter(data),
    // Fixture setup creates controlled users; deployed signup policy is tested separately.
    emailAndPassword: { ...configured.emailAndPassword, disableSignUp: false },
    advanced: configured.advanced,
    trustedOrigins: [origin],
    logger: { disabled: true },
  });
  const post = (path: string, body: Record<string, unknown>) =>
    auth.handler(
      new Request(`${origin}/api/auth/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify(body),
      }),
    );
  return { auth, data, post };
}

beforeEach(() => {
  mail.send.mockReset().mockResolvedValue({
    data: { id: "fixture-delivery" },
    error: null,
    headers: null,
  });
  mail.create.mockReset();
});
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
});

describe("existing-account password recovery", () => {
  it("requires a dedicated email credential without inheriting the dashboard key", () => {
    const source = { BETTER_AUTH_API_KEY: "production-dashboard-credential" };
    expect(passwordRecoveryEnabledForEnvironment(source)).toBe(false);
    expect(createPasswordRecoveryOptions(source, "Fixture")).toBeUndefined();
    expect(mail.create).not.toHaveBeenCalled();
    expect(passwordRecoveryEnabledForEnvironment(environment)).toBe(true);
    createPasswordRecoveryOptions(environment, "Fixture");
    expect(mail.create).toHaveBeenCalledWith({ apiKey: "fixture-email-key" });
  });

  it("keeps recovery routes unavailable until delivery is configured", () => {
    const disabled = createAuthViewPaths().auth!;
    const enabled = createAuthViewPaths({ allowPasswordRecovery: true }).auth!;
    expect(disabled.forgotPassword).toBe(disabled.signIn);
    expect(disabled.resetPassword).toBe(disabled.signIn);
    expect(disabled.resetLinkSent).toBe(disabled.signIn);
    expect(enabled.forgotPassword).toBe("forgot-password");
    expect(enabled.resetPassword).toBe("reset-password");
    expect(enabled.resetLinkSent).toBe("reset-link-sent");
    expect(enabled.signUp).toBe(enabled.signIn);
  });

  it("requires both a delivery credential and a valid sender before offering recovery", () => {
    for (const source of [
      { AUTH_RECOVERY_RESEND_API_KEY: "fixture-email-key" },
      { AUTH_RECOVERY_EMAIL_FROM: "recovery@example.test" },
      { ...environment, AUTH_RECOVERY_EMAIL_FROM: "not-a-sender" },
    ]) {
      expect(passwordRecoveryEnabledForEnvironment(source)).toBe(false);
      expect(createPasswordRecoveryOptions(source, "Fixture")).toBeUndefined();
    }
    expect(mail.create).not.toHaveBeenCalled();
  });

  it("preserves placeholder tooling without enabling a real sender against placeholder Auth", () => {
    const configured = createAuthOptions({
      appName: "Recovery Fixture",
      allowPlaceholderConfig: true,
      env: {
        AUTH_RECOVERY_RESEND_API_KEY: environment.AUTH_RECOVERY_RESEND_API_KEY,
        AUTH_RECOVERY_EMAIL_FROM: environment.AUTH_RECOVERY_EMAIL_FROM,
      },
    });
    pools.push(configured.database);
    expect(configured.emailAndPassword.sendResetPassword).toBeUndefined();
    expect(mail.create).not.toHaveBeenCalled();
  });

  it("enables Preview recovery without registering the Production dashboard", () => {
    const configured = createAuthOptions({
      appName: "Recovery Fixture",
      env: {
        ...environment,
        VERCEL_ENV: "preview",
        VERCEL_DEPLOYMENT_ID: "dpl_preview",
        VERCEL_URL: "apps-feature-autographing.vercel.app",
        PLATFORM_AUTH_DATABASE_URL:
          "postgres://auth:fixture@ep-preview.us-east-2.aws.neon.tech/auth?sslmode=verify-full",
        DATABASE_URL_UNPOOLED:
          "postgres://auth:fixture@ep-preview.us-east-2.aws.neon.tech/auth?sslmode=verify-full",
        AUTH_PRODUCTION_DATABASE_IDENTITY: "ep-production.us-east-2.aws.neon.tech/auth",
        BETTER_AUTH_API_KEY: "production-dashboard-credential",
      },
    });
    pools.push(configured.database);
    expect(configured.emailAndPassword.sendResetPassword).toBeTypeOf("function");
    expect(configured.plugins.map((plugin) => plugin.id)).not.toContain("dash");
  });

  it("recovers the same user, consumes the token once and preserves other users and grants", async () => {
    const { auth, data, post } = fixture();
    const first = await auth.api.signUpEmail({
      body: {
        email: "owner@example.test",
        password: "old-password-123",
        name: "Fixture Owner",
      },
    });
    const second = await auth.api.signUpEmail({
      body: {
        email: "other@example.test",
        password: "other-password-123",
        name: "Other Fixture",
      },
    });
    data.organization.push({ id: "fixture-organization" });
    data.member.push({
      userId: first.user.id,
      organizationId: "fixture-organization",
      role: "owner",
    });
    data.app_actor_assignment.push({ actorId: first.user.id, role: "fixture-role" });
    const grants = structuredClone({
      organization: data.organization,
      member: data.member,
      app: data.app_actor_assignment,
    });
    const request = await post("request-password-reset", {
      email: first.user.email,
      redirectTo: `${origin}/auth/reset-password`,
    });
    expect(request.status).toBe(200);
    expect(mail.send).toHaveBeenCalledTimes(1);
    const delivered = mail.send.mock.calls[0]?.[0];
    if (!delivered) throw new Error("The fixture must deliver the recovery request.");
    expect(delivered.from).toBe(environment.AUTH_RECOVERY_EMAIL_FROM);
    expect(delivered.subject).toBe("Reset your Recovery Fixture password");
    expect(delivered.to).toBe(first.user.email);
    const resetLink = delivered.text?.match(/https?:\/\/\S+/u)?.[0];
    if (!resetLink) throw new Error("The recovery email must include the callback URL.");
    const callback = await auth.handler(new Request(resetLink));
    expect(callback.status).toBe(302);
    const location = callback.headers.get("location");
    if (!location) throw new Error("The recovery callback must return its destination.");
    const destination = new URL(location);
    expect(destination.origin).toBe(origin);
    expect(destination.pathname).toBe("/auth/reset-password");
    const token = destination.searchParams.get("token");
    expect(token).toBeTruthy();
    const reset = await post("reset-password", { token, newPassword: "new-password-123" });
    expect(reset.status).toBe(200);
    expect(data.user.map((user) => user.id)).toEqual([first.user.id, second.user.id]);
    expect(data.session.filter((session) => session.userId === first.user.id)).toHaveLength(0);
    expect(data.session.filter((session) => session.userId === second.user.id)).toHaveLength(1);
    expect({
      organization: data.organization,
      member: data.member,
      app: data.app_actor_assignment,
    }).toEqual(grants);
    expect(
      (await post("reset-password", { token, newPassword: "replayed-password-123" })).status,
    ).toBe(400);
    expect(
      (await post("sign-in/email", { email: first.user.email, password: "old-password-123" }))
        .status,
    ).toBe(401);
    const login = await post("sign-in/email", {
      email: first.user.email,
      password: "new-password-123",
    });
    expect(login.status).toBe(200);
    expect((await login.json()).user.id).toBe(first.user.id);
  });

  it("returns the same response for unknown accounts without creating users or sending mail", async () => {
    const { auth, data, post } = fixture();
    await auth.api.signUpEmail({
      body: { email: "owner@example.test", password: "old-password-123", name: "Fixture" },
    });
    const known = await post("request-password-reset", {
      email: "owner@example.test",
      redirectTo: `${origin}/auth/reset-password`,
    });
    const unknown = await post("request-password-reset", {
      email: "absent@example.test",
      redirectTo: `${origin}/auth/reset-password`,
    });
    expect(unknown.status).toBe(known.status);
    expect(await unknown.json()).toEqual(await known.json());
    expect(data.user).toHaveLength(1);
    expect(mail.send).toHaveBeenCalledTimes(1);
  });

  it("rejects expired tokens and foreign recovery redirects", async () => {
    const { auth, data, post } = fixture();
    await auth.api.signUpEmail({
      body: { email: "owner@example.test", password: "old-password-123", name: "Fixture" },
    });
    const foreign = await post("request-password-reset", {
      email: "owner@example.test",
      redirectTo: "https://foreign.example/reset",
    });
    expect(foreign.status).toBe(403);
    expect(mail.send).not.toHaveBeenCalled();
    await post("request-password-reset", {
      email: "owner@example.test",
      redirectTo: `${origin}/auth/reset-password`,
    });
    const verification = data.verification[0];
    if (!verification) throw new Error("The fixture must retain the reset token.");
    const token = String(verification.identifier).slice("reset-password:".length);
    verification.expiresAt = new Date(0);
    expect((await post("reset-password", { token, newPassword: "new-password-123" })).status).toBe(
      400,
    );
  });

  it("defers delivery beyond the generic response and keeps private delivery failures out of errors", async () => {
    let rejectDelivery: (error: Error) => void = () => {};
    mail.send.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectDelivery = reject;
        }),
    );
    const tasks: Promise<unknown>[] = [];
    const { auth, post } = fixture({
      handler(task) {
        tasks.push(task);
        void task.catch(() => {});
      },
    });
    await auth.api.signUpEmail({
      body: { email: "owner@example.test", password: "old-password-123", name: "Fixture" },
    });
    expect(
      (
        await post("request-password-reset", {
          email: "owner@example.test",
          redirectTo: `${origin}/auth/reset-password`,
        })
      ).status,
    ).toBe(200);
    expect(tasks).toHaveLength(1);
    rejectDelivery(new Error("private-email-key and private-reset-link"));
    // Better Auth catches background failures after returning the generic response.
    await expect(tasks[0]).resolves.toBeUndefined();
  });

  it("discards private provider errors for both rejected delivery and transport failure", async () => {
    mail.send
      .mockResolvedValueOnce({
        data: null,
        error: {
          name: "validation_error",
          message: "private-email-key private-reset-link",
          statusCode: 422,
        },
        headers: null,
      })
      .mockRejectedValueOnce(new Error("private-email-key private-reset-link"));
    const options = createPasswordRecoveryOptions(environment, "Fixture");
    if (!options?.sendResetPassword) throw new Error("The fixture must enable recovery.");
    const user = {
      id: "existing-user",
      email: "owner@example.test",
      name: "Fixture",
      emailVerified: true,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        options.sendResetPassword({
          user,
          url: `${origin}/private-reset-link`,
          token: "fixture-token",
        }),
      ).rejects.toThrow(/^auth_password_recovery_delivery_unavailable$/);
    }
  });

  it("does not wait for local delivery for either existing or unknown accounts", async () => {
    let completeDelivery: () => void = () => {};
    mail.send.mockImplementation(
      () =>
        new Promise((resolve) => {
          completeDelivery = () =>
            resolve({ data: { id: "fixture-delivery" }, error: null, headers: null });
        }),
    );
    const { auth, post } = fixture();
    await auth.api.signUpEmail({
      body: { email: "owner@example.test", password: "old-password-123", name: "Fixture" },
    });
    try {
      const existing = await post("request-password-reset", {
        email: "owner@example.test",
        redirectTo: `${origin}/auth/reset-password`,
      });
      const unknown = await post("request-password-reset", {
        email: "unknown@example.test",
        redirectTo: `${origin}/auth/reset-password`,
      });
      expect(existing.status).toBe(200);
      expect(unknown.status).toBe(200);
      expect(await existing.json()).toEqual(await unknown.json());
      expect(mail.send).toHaveBeenCalledTimes(1);
    } finally {
      completeDelivery();
    }
  });
});
