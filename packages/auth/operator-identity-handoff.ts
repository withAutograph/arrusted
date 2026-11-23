import {
  createOperatorCallbackDeadline,
  reportOperatorCallback,
  type OperatorCallbackOutcome,
  type OperatorCallbackPhase,
} from "./operator-callback-transport";
import { getContext, verifyVercelOidcToken, type VercelOidcPayload } from "@vercel/oidc";
import { z } from "zod";
import {
  assertRealmNativeSenderEnvironment,
  realmOperatorLinkConfigSchema,
} from "./operator-identity-link";

const linkedSchema = z.strictObject({
  callbackUrl: z.url(),
  nonce: z.string().regex(/^[a-f0-9]{64}$/u),
  proof: z.string().min(1).max(16384),
});
const replySchema = z.strictObject({ version: z.literal(1), continuationUrl: z.url().max(4096) });

/** Only the native Auth workload stages proof; the browser receives an opaque continuation. */
export async function handoffRealmOperatorIdentityLink(
  input: {
    config: z.infer<typeof realmOperatorLinkConfigSchema>;
    linked: z.infer<typeof linkedSchema>;
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
): Promise<string> {
  let deadline: ReturnType<typeof createOperatorCallbackDeadline> | undefined;
  let phase: OperatorCallbackPhase = "sender-validation";
  let failure: OperatorCallbackOutcome = "sender-rejected";
  try {
    const config = realmOperatorLinkConfigSchema.parse(input.config);
    const linked = linkedSchema.parse(input.linked);
    const sender = config.identityHandoff?.sender;
    const environment = input.environment ?? process.env;
    assertRealmNativeSenderEnvironment(config, environment);
    const endpoint = `${config.builderCallbackOrigin}${config.builderCallbackPath}`;
    if (
      !sender ||
      linked.callbackUrl !== endpoint ||
      environment.VERCEL !== "1" ||
      environment.VERCEL_PROJECT_ID !== sender.projectId
    )
      throw new Error();
    // Provider-owned request context only. Never use browser headers or an environment token.
    const token = (io.context ?? getContext)().headers?.["x-vercel-oidc-token"];
    if (
      !token ||
      token.length > 16384 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)
    )
      throw new Error();
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
    deadline = createOperatorCallbackDeadline();
    const signal = deadline.signal;
    phase = "identity-handoff";
    failure = "transport-failure";
    signal.throwIfAborted();
    reportOperatorCallback("identity-handoff", phase, "started");
    const response = await (io.fetch ?? fetch)(endpoint, {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
      signal,
      headers: {
        authorization: `Bearer ${token}`,
        "x-vercel-trusted-oidc-idp-token": token,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        version: 1,
        purpose: "realm-owner-identity-stage-v1",
        origin: config.browserOrigin,
        nonce: linked.nonce,
        proof: linked.proof,
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
      if (bytes > 4096) {
        await reader.cancel();
        throw new Error();
      }
      chunks.push(next.value);
    }
    const reply = replySchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const target = new URL(reply.continuationUrl);
    if (
      target.origin !== config.builderCallbackOrigin ||
      target.pathname !== config.builderCallbackPath ||
      target.username !== "" ||
      target.password !== "" ||
      target.hash !== "" ||
      target.searchParams.getAll("handoff").length !== 1 ||
      !target.searchParams.get("handoff") ||
      [...target.searchParams.keys()].some((key) => key !== "handoff")
    )
      throw new Error();
    signal.throwIfAborted();
    reportOperatorCallback("identity-handoff", phase, "acknowledged");
    return target.href;
  } catch {
    reportOperatorCallback(
      "identity-handoff",
      phase,
      deadline?.signal.aborted ? "timeout" : failure,
    );
    throw new Error("realm_identity_handoff_unavailable");
  } finally {
    deadline?.close();
  }
}
