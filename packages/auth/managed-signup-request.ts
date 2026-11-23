import { betterAuth, type BetterAuthOptions } from "better-auth";
import { signJWT, verifyJWT } from "better-auth/crypto";
import { z } from "zod";
import type { AuthEnvironmentSource } from "./env";
import { createAuthEmailSender } from "./email-delivery";

export const AUTH_APP_SIGNUP_CONTINUE_PATH = "/api/auth/platform/signup-continue";

export type ManagedSignupIntent = {
  policyId: string;
  policyDigest: string;
  returnUrl: string;
};
export type ManagedSignupIntentResolver = (input: {
  appUrl: string;
  email?: string;
}) => Promise<ManagedSignupIntent | null>;

const continuationSchema = z.object({
  purpose: z.literal("managed-app-signup-continuation-v1"),
  origin: z.url(),
  actorId: z.string().min(1),
  policyId: z.string().min(1),
  policyDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  appUrl: z.url(),
});
export type ManagedSignupContinuation = z.infer<typeof continuationSchema>;

export async function managedSignupContinuationUrl(
  input: {
    origin: string;
    actorId: string;
    policyId: string;
    policyDigest: string;
    appUrl: string;
  },
  secret: string,
): Promise<string> {
  const state = continuationSchema.parse({
    ...input,
    purpose: "managed-app-signup-continuation-v1",
  });
  if (secret.length < 32 || managedSignupAppUrl(state.appUrl, state.origin) !== state.appUrl)
    throw new Error("app_signup_continuation_unavailable");
  const url = new URL(AUTH_APP_SIGNUP_CONTINUE_PATH, input.origin);
  url.searchParams.set("state", await signJWT(state, secret, 3600));
  return url.toString();
}

export async function readManagedSignupContinuation(request: Request, secret: string) {
  const url = new URL(request.url);
  const token = url.searchParams.get("state");
  if (
    request.method !== "GET" ||
    url.pathname !== AUTH_APP_SIGNUP_CONTINUE_PATH ||
    !token ||
    token.length > 8192 ||
    url.searchParams.getAll("state").length !== 1 ||
    [...url.searchParams.keys()].some((key) => key !== "state")
  )
    return null;
  const parsed = continuationSchema.safeParse(await verifyJWT<unknown>(token, secret));
  if (
    !parsed.success ||
    parsed.data.origin !== url.origin ||
    managedSignupAppUrl(parsed.data.appUrl, url.origin) !== parsed.data.appUrl
  )
    return null;
  return parsed.data;
}

/** A continuation URL identifies a candidate policy; the resolver still owns authorization. */
export function managedSignupAppUrl(value: string, origin: string): string | null {
  try {
    if (!value) return null;
    const url = new URL(value, origin);
    if (url.origin !== origin || url.username || url.password || url.hash) return null;
    return url.pathname === AUTH_APP_SIGNUP_CONTINUE_PATH ? null : url.toString();
  } catch {
    return null;
  }
}

export function createManagedSignupVerification(input: {
  source: AuthEnvironmentSource;
  appName: string;
  origin: string;
  secret: string;
  resolveIntent: ManagedSignupIntentResolver;
}): BetterAuthOptions["emailVerification"] | undefined {
  const send = createAuthEmailSender(input.source);
  if (!send) return undefined;
  return {
    // Verification does not change whether existing private accounts may sign in.
    autoSignInAfterVerification: true,
    async sendVerificationEmail({ user, url }) {
      try {
        const verification = new URL(url);
        const target = managedSignupAppUrl(
          verification.searchParams.get("callbackURL") ?? "",
          input.origin,
        );
        const intent = target && (await input.resolveIntent({ appUrl: target, email: user.email }));
        if (verification.origin !== input.origin || !intent)
          throw new Error("app_signup_verification_unavailable");
        verification.searchParams.set(
          "callbackURL",
          await managedSignupContinuationUrl(
            {
              origin: input.origin,
              actorId: user.id,
              policyId: intent.policyId,
              policyDigest: intent.policyDigest,
              appUrl: intent.returnUrl,
            },
            input.secret,
          ),
        );
        const verificationUrl = verification.toString();
        const href = verificationUrl
          .replaceAll("&", "&amp;")
          .replaceAll('"', "&quot;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;");
        await send({
          to: user.email,
          subject: `Verify your ${input.appName} email`,
          text: `Verify your email to finish creating your account:\n${verificationUrl}\n\nIf you did not request this account, ignore this email.`,
          html: `<p><a href="${href}">Verify your email</a> to finish creating your account.</p><p>If you did not request this account, ignore this email.</p>`,
        });
      } catch {
        throw new Error("app_signup_verification_unavailable");
      }
    },
  };
}

async function readSignupBody(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("app_signup_body_unavailable");
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > 8192) {
        // Do not tee the request or await an untrusted peer's cancellation.
        void reader.cancel().catch(() => {});
        throw new Error("app_signup_body_unavailable");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

/** Only this pre-authorized HTTP request gets a separate signup-enabled Auth instance. */
export function createManagedSignupRequestHandler(input: {
  options: BetterAuthOptions;
  origin: string;
  resolveIntent: ManagedSignupIntentResolver;
}) {
  return async (request: Request): Promise<Response> => {
    const blocked = () =>
      Response.json(
        { code: "APP_SIGNUP_UNAVAILABLE", message: "Signup is unavailable for this app." },
        { status: 403, headers: { "cache-control": "no-store" } },
      );
    const url = new URL(request.url);
    if (
      request.method !== "POST" ||
      url.pathname !== "/api/auth/sign-up/email" ||
      url.origin !== input.origin ||
      request.headers.get("origin") !== input.origin ||
      !input.options.emailVerification?.sendVerificationEmail
    )
      return blocked();
    let body: Record<string, unknown>;
    try {
      const text = await readSignupBody(request);
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== "object" || Array.isArray(value)) return blocked();
      body = { ...value };
    } catch {
      return blocked();
    }
    if (typeof body.email !== "string" || typeof body.callbackURL !== "string") return blocked();
    const appUrl = managedSignupAppUrl(body.callbackURL, input.origin);
    if (!appUrl) return blocked();
    const intent = await input.resolveIntent({ appUrl, email: body.email });
    if (!intent) return blocked();
    const originalBefore = input.options.databaseHooks?.user?.create?.before;
    const configured: BetterAuthOptions = {
      ...input.options,
      emailAndPassword: {
        ...input.options.emailAndPassword,
        enabled: true,
        disableSignUp: false,
        autoSignIn: false,
        requireEmailVerification: true,
      },
      emailVerification: { ...input.options.emailVerification, sendOnSignUp: true },
      databaseHooks: {
        ...input.options.databaseHooks,
        user: {
          ...input.options.databaseHooks?.user,
          create: {
            ...input.options.databaseHooks?.user?.create,
            before: async (user, context) => {
              const current = await input.resolveIntent({
                appUrl: intent.returnUrl,
                email: user.email,
              });
              if (
                !current ||
                current.policyId !== intent.policyId ||
                current.policyDigest !== intent.policyDigest
              )
                return false;
              return originalBefore ? originalBefore(user, context) : { data: user };
            },
          },
        },
      },
    };
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    return betterAuth(configured).handler(
      new Request(request.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...body, callbackURL: intent.returnUrl }),
      }),
    );
  };
}
