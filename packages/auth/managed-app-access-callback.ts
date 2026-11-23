import { getContext, verifyVercelOidcToken } from "@vercel/oidc";
import { z } from "zod";
import {
  assertRealmNativeSenderEnvironment,
  realmOperatorLinkConfigSchema,
} from "./operator-identity-link";

type CompletionIo = {
  context?: typeof getContext;
  // This boundary validates the verified payload's fields itself; callers cannot assert a payload type.
  verifyToken?: typeof verifyVercelOidcToken<unknown>;
  fetch?: typeof fetch;
};

/** Invited users need no Builder account. Only the enrolled Auth workload resumes their saved invitation. */
export async function completeManagedAppInvitation(
  input: {
    config: z.infer<typeof realmOperatorLinkConfigSchema>;
    invitationId: string;
    environment?: Readonly<Record<string, string | undefined>>;
  },
  io: CompletionIo = {},
): Promise<"ready" | "pending"> {
  return completeManagedAppAccess(
    input,
    { version: 1, invitationId: z.uuid().parse(input.invitationId) },
    io,
  );
}

export async function completeManagedAppSignup(
  input: {
    config: z.infer<typeof realmOperatorLinkConfigSchema>;
    policyId: string;
    claimId: string;
    environment?: Readonly<Record<string, string | undefined>>;
  },
  io: CompletionIo = {},
): Promise<"ready" | "pending"> {
  return completeManagedAppAccess(
    input,
    {
      version: 1,
      kind: "signup",
      policyId: z.uuid().parse(input.policyId),
      claimId: z.uuid().parse(input.claimId),
    },
    io,
  );
}

async function completeManagedAppAccess(
  input: {
    config: z.infer<typeof realmOperatorLinkConfigSchema>;
    environment?: Readonly<Record<string, string | undefined>>;
  },
  body:
    | { version: 1; invitationId: string }
    | { version: 1; kind: "signup"; policyId: string; claimId: string },
  io: CompletionIo,
): Promise<"ready" | "pending"> {
  const config = realmOperatorLinkConfigSchema.parse(input.config);
  const environment = input.environment ?? process.env;
  const sender = config.identityHandoff?.sender;
  assertRealmNativeSenderEnvironment(config, environment);
  if (
    !config.managedProduction ||
    !sender ||
    environment.VERCEL !== "1" ||
    environment.VERCEL_PROJECT_ID !== sender.projectId
  )
    throw new Error("app_access_completion_unavailable");
  const token = (io.context ?? getContext)().headers?.["x-vercel-oidc-token"];
  if (!token || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token))
    throw new Error("app_access_completion_unavailable");
  const { payload } = await (io.verifyToken ?? verifyVercelOidcToken)(token, sender);
  if (
    payload.iss !== sender.issuer ||
    payload.aud !== sender.audience ||
    payload.sub !== sender.subject ||
    payload.project_id !== sender.projectId ||
    payload.owner_id !== sender.ownerId ||
    payload.environment !== "production"
  )
    throw new Error("app_access_completion_unavailable");
  const response = await (io.fetch ?? fetch)(
    new URL("/v1/repository-production/access/complete", config.operatorOrigin),
    {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(20_000),
      headers: {
        authorization: `Bearer ${token}`,
        "x-vercel-trusted-oidc-idp-token": token,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) throw new Error("app_access_completion_unavailable");
  const reply = z
    .strictObject({ version: z.literal(1), status: z.enum(["ready", "pending"]) })
    .parse(await response.json());
  return reply.status;
}
