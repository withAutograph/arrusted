import { hashPassword } from "better-auth/crypto";

import { createAuth, getAuth } from "./server";
import type { AuthEnvironmentSource } from "./env";

export type PreviewQaIdentitySeed = {
  actorId: string;
  applicationIds: readonly string[];
  email: string;
  organizationId: string;
  organizationName: string;
  /** Synthetic fixture credential retained only for the existing password QA lane. */
  password: string;
};

type PreviewQaAdapter = {
  findOne(input: {
    model: string;
    where: Array<{ field: string; value: string }>;
  }): Promise<Record<string, unknown> | null>;
  create(input: {
    model: string;
    data: Record<string, unknown>;
    forceAllowId?: boolean;
  }): Promise<Record<string, unknown>>;
  update(input: {
    model: string;
    where: Array<{ field: string; value: string }>;
    update: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
};

type PreviewQaAuth = {
  $context: PromiseLike<{ adapter: PreviewQaAdapter }>;
};

export async function bootstrapPreviewQaIdentity(options: {
  adapter?: PreviewQaAdapter;
  auth?: PreviewQaAuth;
  env?: AuthEnvironmentSource;
  identity: PreviewQaIdentitySeed;
}) {
  // This is deliberately an auth-service operation. Do not replace it with
  // direct SQL: this synthetic browser-proof fixture remains a trusted,
  // server-owned identity and membership in the ephemeral Preview database.
  const env = options.env ?? process.env;
  assertPreviewDeployment(env);
  return bootstrapValidationIdentity(options);
}

/** Installer-owned fixtures. Never called by an application request or a public signup route. */
export async function bootstrapValidationIdentity(options: {
  adapter?: PreviewQaAdapter;
  auth?: PreviewQaAuth;
  env?: AuthEnvironmentSource;
  identity: PreviewQaIdentitySeed;
  preserveExistingCredential?: boolean;
  /** Local fixture members may be authenticated without any application assignment. */
  membershipRole?: "owner" | "member";
}) {
  const identity = validatedIdentity(options.identity);
  let adapter = options.adapter;
  if (!adapter) {
    const auth =
      options.auth ??
      ((options.env === undefined
        ? getAuth()
        : createAuth({ appName: "apps", env: options.env })) as unknown as PreviewQaAuth);
    adapter = (await auth.$context).adapter;
  }
  const now = new Date();
  const [passwordHash, existingUser] = await Promise.all([
    hashPassword(identity.password),
    adapter.findOne({
      model: "user",
      where: [{ field: "email", value: identity.email.toLowerCase() }],
    }),
  ]);
  if (existingUser && existingUser.id !== identity.actorId) {
    throw new Error("Preview QA email belongs to an unexpected actor");
  }
  const [organization, user] = await Promise.all([
    upsert(adapter, "organization", identity.organizationId, {
      id: identity.organizationId,
      name: identity.organizationName,
      slug: identity.organizationId,
      // The Postgres Pool adapter binds JavaScript arrays as pg arrays; JSONB needs JSON text.
      appIds: JSON.stringify(identity.applicationIds),
      createdAt: now,
      metadata: null,
      logo: null,
    }),
    upsert(
      adapter,
      "user",
      identity.actorId,
      {
        id: identity.actorId,
        name: identity.organizationName,
        email: identity.email.toLowerCase(),
        emailVerified: true,
        image: null,
        createdAt: now,
        updatedAt: now,
      },
      "email",
    ),
  ]);
  if (user.id !== identity.actorId)
    throw new Error("Preview QA email belongs to an unexpected actor");
  const existingCredential = options.preserveExistingCredential
    ? await adapter.findOne({
        model: "account",
        where: [{ field: "id", value: `credential:${user.id}` }],
      })
    : null;
  if (
    existingCredential &&
    (existingCredential.userId !== user.id || existingCredential.providerId !== "credential")
  )
    throw new Error("Preview QA credential belongs to an unexpected actor");
  await Promise.all([
    existingCredential ??
      upsert(adapter, "account", `credential:${user.id}`, {
        id: `credential:${user.id}`,
        accountId: user.id,
        providerId: "credential",
        userId: user.id,
        password: passwordHash,
        createdAt: now,
        updatedAt: now,
      }),
    upsert(
      adapter,
      "member",
      `${identity.organizationId}:${identity.actorId}:${options.membershipRole ?? "owner"}`,
      {
        id: `${identity.organizationId}:${identity.actorId}:${options.membershipRole ?? "owner"}`,
        organizationId: organization.id,
        userId: user.id,
        role: options.membershipRole ?? "owner",
        createdAt: now,
      },
    ),
  ]);
  return {
    actorId: user.id,
    applicationIds: identity.applicationIds,
    email: identity.email,
    organizationId: organization.id,
  };
}

async function upsert(
  adapter: PreviewQaAdapter,
  model: string,
  id: string,
  data: Record<string, unknown>,
  lookup = "id",
) {
  // Better Auth adapter find/update/create recovery provides the same on conflict
  // idempotency the repository audit requires, without provisioning credentials via SQL.
  const existing = await adapter.findOne({
    model,
    where: [
      {
        field: lookup,
        value: typeof data[lookup] === "string" ? data[lookup] : id,
      },
    ],
  });
  if (existing)
    return adapter.update({
      model,
      where: [{ field: "id", value: String(existing.id) }],
      update: data,
    });
  try {
    return await adapter.create({ model, data, forceAllowId: true });
  } catch (error) {
    const recovered = await adapter.findOne({
      model,
      where: [
        {
          field: lookup,
          value: typeof data[lookup] === "string" ? data[lookup] : id,
        },
      ],
    });
    if (!recovered) throw error;
    if (model === "user" && lookup === "email" && String(recovered.id) !== id) {
      throw new Error("Preview QA email belongs to an unexpected actor");
    }
    return adapter.update({
      model,
      where: [{ field: "id", value: String(recovered.id) }],
      update: data,
    });
  }
}

function validatedIdentity(identity: PreviewQaIdentitySeed): PreviewQaIdentitySeed {
  const idPattern = /^[a-z][a-z0-9_-]+$/u;
  if (
    !idPattern.test(identity.actorId) ||
    !idPattern.test(identity.organizationId) ||
    identity.applicationIds.some((applicationId) => !idPattern.test(applicationId)) ||
    !identity.email.includes("@") ||
    identity.organizationName.trim().length === 0 ||
    identity.password.length < 16
  ) {
    throw new Error("Preview QA identity seed is invalid");
  }
  return identity;
}

function assertPreviewDeployment(env: AuthEnvironmentSource) {
  if (
    env.VERCEL !== "1" ||
    env.VERCEL_ENV !== "preview" ||
    !/^dpl_[A-Za-z0-9]+$/u.test(env.VERCEL_DEPLOYMENT_ID?.trim() ?? "") ||
    !/^[0-9a-f]{40}$/u.test(env.VERCEL_GIT_COMMIT_SHA?.trim() ?? "")
  ) {
    throw new Error("Preview QA bootstrap is available only on an exact Vercel Git Preview");
  }
}
