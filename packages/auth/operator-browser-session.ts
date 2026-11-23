import {
  createOperatorCallbackDeadline,
  reportOperatorCallback,
  type OperatorCallbackOutcome,
  type OperatorCallbackPhase,
} from "./operator-callback-transport";
import { createHash } from "node:crypto";
import { getContext, verifyVercelOidcToken, type VercelOidcPayload } from "@vercel/oidc";
import { z } from "zod";
import {
  assertRealmNativeSenderEnvironment,
  realmOperatorLinkChallengeSchema,
  realmOperatorLinkConfigSchema,
} from "./operator-identity-link";

const normalCookieSchema = z.strictObject({
  name: z.string().regex(/^[A-Za-z0-9_.-]{1,256}$/u),
  value: z
    .string()
    .min(1)
    .max(8192)
    .regex(/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/u),
  domain: z.string().min(1).max(256),
  path: z.string().startsWith("/"),
  expires: z.literal(-1),
  httpOnly: z.literal(true),
  secure: z.literal(true),
  sameSite: z.enum(["Strict", "Lax", "None"]),
  hostOnly: z.boolean(),
});
type NormalCookie = z.infer<typeof normalCookieSchema>;

/** Private credential projection from the real Auth cookie configuration. Never return it to a browser. */
export function readOperatorNormalCookie(input: {
  headers: Headers;
  origin: string;
  cookie: {
    name: string;
    attributes: {
      domain?: string;
      path?: string;
      httpOnly?: boolean;
      secure?: boolean;
      sameSite?: boolean | "lax" | "strict" | "none" | "Lax" | "Strict" | "None";
    };
  };
}): NormalCookie {
  try {
    const url = new URL(input.origin);
    const { name, attributes } = input.cookie;
    const values = (input.headers.get("cookie") ?? "")
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.startsWith(`${name}=`));
    if (url.protocol !== "https:" || values.length !== 1) throw new Error();
    const domain = attributes.domain ?? url.hostname;
    const scope = domain.replace(/^\./u, "");
    if (url.hostname !== scope && (!attributes.domain || !url.hostname.endsWith(`.${scope}`)))
      throw new Error();
    const site = typeof attributes.sameSite === "string" ? attributes.sameSite.toLowerCase() : null;
    const sameSite =
      site === "strict" ? "Strict" : site === "lax" ? "Lax" : site === "none" ? "None" : null;
    return normalCookieSchema.parse({
      name,
      value: values[0]!.slice(name.length + 1),
      domain,
      path: attributes.path,
      // Request Cookie headers carry no expiration. Session-only replay never extends it.
      expires: -1,
      httpOnly: attributes.httpOnly,
      secure: attributes.secure,
      sameSite,
      hostOnly: attributes.domain === undefined,
    });
  } catch {
    throw new Error("realm_browser_session_cookie_required");
  }
}

export const operatorNormalCookieDigest = (cookie: Pick<NormalCookie, "name" | "value">) =>
  createHash("sha256").update(`${cookie.name}=${cookie.value}`).digest("hex");

/** Fixed private transport. Builder authorizes before any credential leaves Auth, then rechecks on capture. */
export async function captureOperatorNormalBrowserSession(
  input: {
    config: z.infer<typeof realmOperatorLinkConfigSchema>;
    challenge: z.infer<typeof realmOperatorLinkChallengeSchema>;
    proof: string;
    normalCookie: NormalCookie;
    environment?: Readonly<Record<string, string | undefined>>;
  },
  io: {
    context?: typeof getContext;
    verifyToken?: (
      token: string,
      options: Parameters<typeof verifyVercelOidcToken>[1],
    ) => Promise<{
      payload: Pick<
        VercelOidcPayload,
        "iss" | "aud" | "sub" | "project_id" | "owner_id" | "environment"
      >;
    }>;
    fetch?: typeof fetch;
  } = {},
): Promise<void> {
  let deadline: ReturnType<typeof createOperatorCallbackDeadline> | undefined;
  let phase: OperatorCallbackPhase = "sender-validation";
  let failure: OperatorCallbackOutcome = "sender-rejected";
  try {
    const config = realmOperatorLinkConfigSchema.parse(input.config);
    const challenge = realmOperatorLinkChallengeSchema.parse(input.challenge);
    const cookie = normalCookieSchema.parse(input.normalCookie);
    const capture = config.browserSessionCapture;
    const environment = input.environment ?? process.env;
    assertRealmNativeSenderEnvironment(config, environment);
    if (
      !capture ||
      !challenge.browserSession ||
      environment.VERCEL !== "1" ||
      environment.VERCEL_PROJECT_ID !== capture.sender.projectId
    )
      throw new Error();
    // Only Vercel's provider-owned request context; no browser header or env token fallback.
    const token = (io.context ?? getContext)().headers?.["x-vercel-oidc-token"];
    if (
      !token ||
      token.length > 16384 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)
    )
      throw new Error();
    const sender = capture.sender;
    const { payload } = await (io.verifyToken ?? verifyVercelOidcToken)(token, {
      issuer: sender.issuer,
      audience: sender.audience,
      ownerId: sender.ownerId,
      projectId: sender.projectId,
      environment: sender.environment,
      subject: sender.subject,
    });
    if (
      payload.iss !== sender.issuer ||
      payload.aud !== sender.audience ||
      payload.owner_id !== sender.ownerId ||
      payload.project_id !== sender.projectId ||
      payload.environment !== sender.environment ||
      payload.sub !== sender.subject
    )
      throw new Error();
    const envelope = {
      version: 1,
      purpose: "realm-normal-browser-session-v1",
      ownerSessionId: challenge.ownerSessionId,
      ...challenge.browserSession,
      reviewedNonce: challenge.nonce,
      proof: input.proof,
      origin: config.browserOrigin,
    };
    const endpoint = `${config.builderCallbackOrigin}${capture.path}`;
    deadline = createOperatorCallbackDeadline();
    const signal = deadline.signal;
    const send = async (nextPhase: "authorize" | "capture") => {
      phase = nextPhase;
      failure = "transport-failure";
      signal.throwIfAborted();
      reportOperatorCallback("browser-session", phase, "started");
      const response = await (io.fetch ?? fetch)(endpoint, {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        credentials: "omit",
        signal,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          ...envelope,
          phase: nextPhase,
          ...(nextPhase === "capture" ? { normalCookie: cookie } : {}),
        }),
      });
      signal.throwIfAborted();
      failure = "http-rejected";
      if (!response.ok) throw new Error();
      failure = "invalid-acknowledgement";
      if (!response.headers.get("content-type")?.startsWith("application/json")) throw new Error();
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const next = await reader.read();
        signal.throwIfAborted();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 1024) {
          await reader.cancel();
          throw new Error();
        }
        chunks.push(next.value);
      }
      const ack: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      (nextPhase === "authorize"
        ? z.strictObject({ authorized: z.literal(true) })
        : z.strictObject({ captured: z.literal(true) })
      ).parse(ack);
      signal.throwIfAborted();
      reportOperatorCallback("browser-session", phase, "acknowledged");
    };
    await send("authorize");
    await send("capture");
  } catch {
    reportOperatorCallback(
      "browser-session",
      phase,
      deadline?.signal.aborted ? "timeout" : failure,
    );
    throw new Error("realm_browser_session_capture_unavailable");
  } finally {
    deadline?.close();
  }
}
