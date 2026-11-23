import { memoryAdapter } from "@better-auth/memory-adapter";
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { describe, expect, it, vi } from "vitest";

import { bootstrapPreviewQaIdentity, bootstrapValidationIdentity } from "../preview-qa";

const env = {
  VERCEL: "1",
  VERCEL_DEPLOYMENT_ID: "dpl_exactPreview",
  VERCEL_ENV: "preview",
  VERCEL_GIT_COMMIT_SHA: "a".repeat(40),
};
const identity = {
  actorId: "platform_preview_qa_native",
  applicationIds: ["alpha"],
  email: "preview-qa@example.invalid",
  organizationId: "preview-qa",
  organizationName: "Preview QA",
  password: "preview-qa-fixture-password",
} as const;

function adapter(existing: Record<string, Record<string, unknown>> = {}) {
  const findOne = vi.fn<
    (input: {
      model: string;
      where: Array<{ field: string; value: string }>;
    }) => Promise<Record<string, unknown> | null>
  >(
    async ({ model, where }: { model: string; where: Array<{ field: string; value: string }> }) =>
      (existing[model]?.[where[0]!.value] as Record<string, unknown> | undefined) ?? null,
  );
  const create = vi.fn(
    async ({
      data,
    }: {
      model: string;
      data: Record<string, unknown>;
    }): Promise<Record<string, unknown>> => data,
  );
  const update = vi.fn(
    async ({ update }: { update: Record<string, unknown> }): Promise<Record<string, unknown>> =>
      update,
  );
  return { findOne, create, update };
}

describe("Better Auth-owned Preview QA identity", () => {
  it("prepares a synthetic organization member without granting an owner role", async () => {
    const authAdapter = adapter();
    await bootstrapValidationIdentity({ adapter: authAdapter, identity, membershipRole: "member" });
    expect(authAdapter.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "member",
        data: expect.objectContaining({ role: "member" }),
      }),
    );
    expect(authAdapter.create).not.toHaveBeenCalledWith(
      expect.objectContaining({
        model: "member",
        data: expect.objectContaining({ role: "owner" }),
      }),
    );
  });
  it("provisions an isolated identity through the Better Auth adapter", async () => {
    const authAdapter = adapter();
    await expect(
      bootstrapPreviewQaIdentity({ adapter: authAdapter, env, identity }),
    ).resolves.toMatchObject({
      actorId: identity.actorId,
      organizationId: identity.organizationId,
    });
    expect(authAdapter.create).toHaveBeenCalledTimes(4);
    expect(authAdapter.findOne).toHaveBeenCalledTimes(5);
    expect(authAdapter.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ appIds: '["alpha"]' }),
        forceAllowId: true,
        model: "organization",
      }),
    );
  });

  it("awaits the Better Auth context before using its adapter", async () => {
    const authAdapter = adapter();
    await expect(
      bootstrapPreviewQaIdentity({
        auth: { $context: Promise.resolve({ adapter: authAdapter }) },
        env,
        identity,
      }),
    ).resolves.toMatchObject({ actorId: identity.actorId });
    expect(authAdapter.create).toHaveBeenCalledTimes(4);
  });

  it("preserves trusted fixture IDs through the real Better Auth adapter", async () => {
    const database = {
      account: [] as Record<string, unknown>[],
      invitation: [] as Record<string, unknown>[],
      member: [] as Record<string, unknown>[],
      organization: [] as Record<string, unknown>[],
      session: [] as Record<string, unknown>[],
      user: [] as Record<string, unknown>[],
      verification: [] as Record<string, unknown>[],
    };
    const auth = betterAuth({
      database: memoryAdapter(database),
      plugins: [
        organization({
          schema: {
            organization: {
              additionalFields: {
                appIds: { input: false, required: false, type: "json" },
              },
            },
          },
        }),
      ],
    });

    await expect(
      bootstrapPreviewQaIdentity({
        auth: auth as unknown as NonNullable<
          Parameters<typeof bootstrapPreviewQaIdentity>[0]["auth"]
        >,
        env,
        identity,
      }),
    ).resolves.toMatchObject({
      actorId: identity.actorId,
      organizationId: identity.organizationId,
    });
    expect(database.user).toContainEqual(expect.objectContaining({ id: identity.actorId }));
    expect(database.organization).toContainEqual(
      expect.objectContaining({ id: identity.organizationId }),
    );
  });

  it("reconciles existing records idempotently", async () => {
    const authAdapter = adapter({
      organization: { "preview-qa": { id: "preview-qa" } },
      user: { [identity.email]: { id: identity.actorId } },
      member: {
        "preview-qa:platform_preview_qa_native:owner": {
          id: "preview-qa:platform_preview_qa_native:owner",
        },
      },
      account: { [`credential:${identity.actorId}`]: { id: `credential:${identity.actorId}` } },
    });
    await bootstrapPreviewQaIdentity({ adapter: authAdapter, env, identity });
    expect(authAdapter.update).toHaveBeenCalledTimes(4);
    expect(authAdapter.create).not.toHaveBeenCalled();
  });

  it("fails closed outside an exact Vercel Git Preview", async () => {
    const authAdapter = adapter();
    await expect(
      bootstrapPreviewQaIdentity({
        adapter: authAdapter,
        env: { ...env, VERCEL_ENV: "production" },
        identity,
      }),
    ).rejects.toThrow("only on an exact Vercel Git Preview");
    expect(authAdapter.findOne).not.toHaveBeenCalled();
  });

  it("rejects malformed identities before touching the adapter", async () => {
    const authAdapter = adapter();
    await expect(
      bootstrapPreviewQaIdentity({
        adapter: authAdapter,
        env,
        identity: { ...identity, actorId: "invalid actor" },
      }),
    ).rejects.toThrow("identity seed is invalid");
    expect(authAdapter.findOne).not.toHaveBeenCalled();
  });

  it("rejects an email that is already owned by another actor", async () => {
    const authAdapter = adapter({ user: { [identity.email]: { id: "unexpected" } } });

    await expect(
      bootstrapPreviewQaIdentity({ adapter: authAdapter, env, identity }),
    ).rejects.toThrow("unexpected actor");
  });

  it("rejects a create conflict recovered to another actor", async () => {
    const records: Record<string, Record<string, unknown>> = {};
    const authAdapter = adapter(records);
    authAdapter.create.mockImplementation(
      async ({ model, data }: { model: string; data: Record<string, unknown> }) => {
        if (model === "user") {
          records.user = { [identity.email]: { id: "unexpected" } };
          throw new Error("duplicate email");
        }
        return data;
      },
    );

    await expect(
      bootstrapPreviewQaIdentity({ adapter: authAdapter, env, identity }),
    ).rejects.toThrow("Preview QA email belongs to an unexpected actor");
    expect(authAdapter.update).not.toHaveBeenCalledWith(expect.objectContaining({ model: "user" }));
  });
});
