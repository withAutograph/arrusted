// @vitest-environment node
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  appOrganizationChoices,
  requireAppContext,
  requireTenantContext,
  requireUser,
  requireUserOrganizationContext,
} from "../server";
import { readOrganizationMemberships } from "../organization-membership-access";
import { readManagedAppActorAccess } from "../managed-app-access";
import { APP, APP2, ORIGIN, realm, signIn, startCluster, stopCluster } from "./agent-grant-fixture";

const organization = {
  id: "workspace-org",
  name: "Workspace",
  slug: "workspace",
  appIds: ["requests", "expenses", "legacy-hc", "legacy-vendor"],
};
const managedMemberId = (organizationId: string, actorId: string) =>
  createHash("sha256")
    .update(JSON.stringify(["managed-membership-v1", organizationId, actorId]))
    .digest("hex");
const fixture = (actorId = "invitee") => {
  const memberships = [
    {
      id: managedMemberId(organization.id, actorId),
      organizationId: organization.id,
      actorId,
    },
  ];
  let roleActive = true;
  const options = {
    getSession: async () => ({
      user: { id: actorId },
      session: { activeOrganizationId: organization.id },
    }),
    listOrganizations: async () => [organization],
    verifyTenantMembership: async () => true,
    loadOrganizationMemberships: vi.fn(async (input: { organizationIds: readonly string[] }) =>
      memberships.filter((row) => input.organizationIds.includes(row.organizationId)),
    ),
    loadAppActorGrants: vi.fn(
      async (scope: { actorId: string; appId: string; organizationId: string }) =>
        roleActive &&
        scope.actorId === actorId &&
        scope.appId === "requests" &&
        scope.organizationId === organization.id
          ? [{ role: "requester", fenceGeneration: 3 }]
          : [],
    ),
    loadRolelessAppAccess: vi.fn(async () => null as { fenceGeneration: number } | null),
  };
  return {
    actorId,
    memberships,
    options,
    revoke: () => {
      roleActive = false;
    },
  };
};

it.each(["creator", "invitee"])(
  "does not turn %s app-created membership into unrelated app permission",
  async (actorId) => {
    const f = fixture(actorId);
    for (const appId of ["expenses", "legacy-hc", "legacy-vendor"]) {
      await expect(
        requireTenantContext(new Headers(), { ...f.options, appId }),
      ).rejects.toMatchObject({
        code: "app_access_required",
        status: 403,
      });
    }
    await expect(
      requireTenantContext(new Headers(), { ...f.options, appId: "requests" }),
    ).resolves.toMatchObject({
      scope: { actorId, appId: "requests", customerId: organization.id },
    });
  },
);

it("projects only explicitly allowed choices for an app-created member", async () => {
  const f = fixture();
  const context = await requireUserOrganizationContext(new Headers(), f.options);
  expect(context.organizations).toEqual([{ ...organization, appIds: ["requests"] }]);
  expect(context.actor.actorId).toBe(f.actorId);
});

it("keeps pre-existing memberships on their organization entitlement policy", async () => {
  const f = fixture();
  f.memberships[0]!.id = "existing-organization-member";
  await expect(
    requireTenantContext(new Headers(), { ...f.options, appId: "legacy-hc" }),
  ).resolves.toMatchObject({
    scope: { appId: "legacy-hc" },
  });
  expect((await requireUserOrganizationContext(new Headers(), f.options)).organizations).toEqual([
    organization,
  ]);
  expect(f.options.loadAppActorGrants).not.toHaveBeenCalled();
  expect(f.options.loadRolelessAppAccess).not.toHaveBeenCalled();
});

it("keeps membership origin scoped to each organization for the same actor", async () => {
  const f = fixture();
  const existing = { ...organization, id: "existing-org" };
  f.memberships.push({
    id: "pre-existing-member",
    organizationId: existing.id,
    actorId: f.actorId,
  });
  f.options.listOrganizations = async () => [organization, existing];
  await expect(
    requireTenantContext(new Headers(), {
      ...f.options,
      appId: "legacy-hc",
      customerId: existing.id,
    }),
  ).resolves.toMatchObject({ scope: { customerId: existing.id } });
  await expect(
    requireTenantContext(new Headers(), {
      ...f.options,
      appId: "legacy-hc",
      customerId: organization.id,
    }),
  ).rejects.toMatchObject({ code: "app_access_required" });
  const choices = await requireUserOrganizationContext(new Headers(), f.options);
  expect(choices.organizations.find((row) => row.id === existing.id)?.appIds).toEqual(
    organization.appIds,
  );
  expect(choices.organizations.find((row) => row.id === organization.id)?.appIds).toEqual([
    "requests",
  ]);
});

it("propagates unavailable app authority without projecting it as a missing grant", async () => {
  const f = fixture();
  const error = new Error("App authority unavailable");
  f.options.loadRolelessAppAccess.mockRejectedValue(error);
  await expect(
    requireTenantContext(new Headers(), { ...f.options, appId: "expenses" }),
  ).rejects.toBe(error);
  await expect(requireUserOrganizationContext(new Headers(), f.options)).rejects.toBe(error);
});

it("uses marked-member authority for app-specific choices while preserving legacy choices", async () => {
  const f = fixture();
  const legacy = { ...organization, id: "legacy-org" };
  f.memberships.push({ id: "pre-existing-member", organizationId: legacy.id, actorId: f.actorId });
  f.options.listOrganizations = async () => [organization, legacy];
  const classicAdmission = vi.fn(async () => true);
  const options = {
    ...f.options,
    appId: "expenses",
    loadAppActorRoles: async () => [],
    loadAppActorAccess: classicAdmission,
  };

  expect((await appOrganizationChoices(new Headers(), options)).map((row) => row.id)).toEqual([
    legacy.id,
  ]);
  expect(classicAdmission).not.toHaveBeenCalledWith(
    expect.objectContaining({ organizationId: organization.id }),
  );
  f.options.loadAppActorGrants.mockClear();
  await expect(requireAppContext(new Headers(), options)).resolves.toMatchObject({
    scope: { customerId: legacy.id },
  });
  expect(f.options.loadAppActorGrants).toHaveBeenCalledOnce();

  f.options.loadAppActorGrants.mockResolvedValue([{ role: "reader", fenceGeneration: 3 }]);
  expect((await appOrganizationChoices(new Headers(), options)).map((row) => row.id)).toEqual([
    organization.id,
    legacy.id,
  ]);
  f.options.loadAppActorGrants.mockResolvedValue([]);
  f.options.loadRolelessAppAccess.mockResolvedValue({ fenceGeneration: 4 });
  expect((await appOrganizationChoices(new Headers(), options)).map((row) => row.id)).toEqual([
    organization.id,
    legacy.id,
  ]);
  f.options.loadRolelessAppAccess.mockResolvedValue(null);

  const error = new Error("App authority unavailable");
  f.options.loadAppActorGrants.mockRejectedValue(error);
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect((await appOrganizationChoices(new Headers(), options)).map((row) => row.id)).toEqual([
      legacy.id,
    ]);
    expect(warning).toHaveBeenCalledOnce();
  } finally {
    warning.mockRestore();
  }
});

it("accepts explicit role-less admission for the exact app and tenant", async () => {
  const f = fixture();
  f.options.loadAppActorGrants.mockResolvedValue([]);
  f.options.loadRolelessAppAccess.mockResolvedValue({ fenceGeneration: 4 });
  await expect(
    requireTenantContext(new Headers(), { ...f.options, appId: "requests" }),
  ).resolves.toMatchObject({
    scope: { appId: "requests", customerId: organization.id },
  });
  expect(f.options.loadRolelessAppAccess).toHaveBeenCalledWith({
    actorId: f.actorId,
    appId: "requests",
    organizationId: organization.id,
  });
});

it("does not borrow another tenant's app role", async () => {
  const f = fixture();
  const other = { ...organization, id: "other-org" };
  f.memberships.push({
    id: managedMemberId(other.id, f.actorId),
    organizationId: other.id,
    actorId: f.actorId,
  });
  f.options.listOrganizations = async () => [organization, other];
  await expect(
    requireTenantContext(new Headers(), { ...f.options, appId: "requests", customerId: other.id }),
  ).rejects.toMatchObject({ code: "app_access_required" });
  const context = await requireUserOrganizationContext(new Headers(), f.options);
  expect(context.organizations.find((row) => row.id === other.id)?.appIds).toEqual([]);
});

it.each(["actorId", "organizationId"] as const)(
  "rejects a foreign membership %s readback",
  async (field) => {
    const f = fixture();
    f.options.loadOrganizationMemberships.mockResolvedValue([
      { ...f.memberships[0]!, [field]: "foreign" },
    ]);
    await expect(
      requireTenantContext(new Headers(), { ...f.options, appId: "requests" }),
    ).rejects.toThrow();
  },
);

it("rereads revoked app access on the next request", async () => {
  const f = fixture();
  await requireTenantContext(new Headers(), { ...f.options, appId: "requests" });
  f.revoke();
  await expect(
    requireTenantContext(new Headers(), { ...f.options, appId: "requests" }),
  ).rejects.toMatchObject({ code: "app_access_required" });
  expect(
    (await requireUserOrganizationContext(new Headers(), f.options)).organizations[0]!.appIds,
  ).toEqual([]);
});

it("does not classify an unavailable origin read as legacy permission", async () => {
  const f = fixture();
  const error = new Error("Membership authority unavailable");
  f.options.loadOrganizationMemberships.mockRejectedValue(error);
  await expect(
    requireTenantContext(new Headers(), { ...f.options, appId: "legacy-hc" }),
  ).rejects.toBe(error);
  await expect(requireUserOrganizationContext(new Headers(), f.options)).rejects.toBe(error);
});

it("keeps identity and account continuation usable before app grants exist", async () => {
  const f = fixture();
  f.revoke();
  await expect(requireUser(new Headers(), f.options)).resolves.toMatchObject({
    actorId: f.actorId,
  });
  expect(f.options.loadOrganizationMemberships).not.toHaveBeenCalled();
  const context = await requireUserOrganizationContext(new Headers(), f.options);
  expect(context.actor.actorId).toBe(f.actorId);
  expect(context.organizations).toEqual([{ ...organization, appIds: [] }]);
});

it("treats a missing current membership as revoked, never as a legacy member", async () => {
  const f = fixture();
  f.memberships.length = 0;
  await expect(
    requireTenantContext(new Headers(), { ...f.options, appId: "requests" }),
  ).rejects.toMatchObject({ code: "tenant_required", status: 403 });
  expect((await requireUserOrganizationContext(new Headers(), f.options)).organizations).toEqual(
    [],
  );
});

it("reuses stricter current grant readback within one managed request", async () => {
  const f = fixture();
  const { requireAppGrantContext } = await import("../server");
  await expect(
    requireAppGrantContext(new Headers(), { ...f.options, appId: "requests" }),
  ).resolves.toMatchObject({ roles: ["requester"] });
  expect(f.options.loadAppActorGrants).toHaveBeenCalledOnce();
});

describe.skipIf(process.env.AUTH_AGENT_GRANT_POSTGRES !== "1")(
  "app-created membership over real Auth storage",
  () => {
    beforeAll(startCluster, 120_000);
    afterAll(stopCluster, 60_000);
    it("retains sign-in before grants and separates roleful admission from explicit role-less access", async () => {
      const r = await realm();
      const actorId = r.users.member;
      await r.pool.query(
        'update public.member set id=$1 where "organizationId"=$2 and "userId"=$3',
        [managedMemberId("org-a", actorId), "org-a", actorId],
      );
      await r.pool.query(
        'delete from public.app_actor_assignment where "organizationId"=$1 and "actorId"=$2 and "appId"=$3',
        ["org-a", actorId, APP2],
      );
      await r.pool.query(
        `insert into public.app_actor_access("organizationId","actorId","appId","workspaceId",active,roles,"fenceGeneration") values ($1,$2,$3,$4,true,$5::jsonb,5)`,
        ["org-a", actorId, APP2, "workspace", JSON.stringify(["approver"])],
      );
      const { cookie, status } = await signIn(r, "user-member@example.test");
      expect(status).toBe(200);
      const headers = new Headers({ host: new URL(ORIGIN).host, origin: ORIGIN, cookie });
      const options = {
        getSession: (requestHeaders: Headers) => r.auth.api.getSession({ headers: requestHeaders }),
        listOrganizations: (requestHeaders: Headers) =>
          r.auth.api.listOrganizations({ headers: requestHeaders }),
        verifyTenantMembership: async (
          requestHeaders: Headers,
          scope: { organizationId: string },
        ) =>
          (await r.auth.api.listOrganizations({ headers: requestHeaders })).some(
            (row) => row.id === scope.organizationId,
          ),
        loadOrganizationMemberships: async (input: {
          actorId: string;
          organizationIds: readonly string[];
        }) => await readOrganizationMemberships(r.pool, input),
        loadAppActorGrants: async (input: {
          actorId: string;
          appId: string;
          organizationId: string;
        }) =>
          (
            await r.pool.query(
              'select role,fence_generation::int as "fenceGeneration" from public.app_actor_assignment where "actorId"=$1 and "appId"=$2 and "organizationId"=$3 and active',
              [input.actorId, input.appId, input.organizationId],
            )
          ).rows,
        loadAppActorRoles: async (input: {
          actorId: string;
          appId: string;
          organizationId: string;
        }) =>
          (
            await r.pool.query(
              'select role from public.app_actor_assignment where "actorId"=$1 and "appId"=$2 and "organizationId"=$3 and active',
              [input.actorId, input.appId, input.organizationId],
            )
          ).rows.map((row) => String(row.role)),
        loadAppActorAccess: async (input: {
          actorId: string;
          appId: string;
          organizationId: string;
        }) =>
          (await readManagedAppActorAccess(r.pool, { ...input, workspaceId: "workspace" })) !==
          null,
        loadRolelessAppAccess: async (input: {
          actorId: string;
          appId: string;
          organizationId: string;
        }) =>
          await readManagedAppActorAccess(r.pool, {
            ...input,
            workspaceId: "workspace",
            rolelessOnly: true,
          }),
      };
      await expect(requireUser(headers, options)).resolves.toMatchObject({ actorId });
      await expect(
        requireTenantContext(headers, { ...options, appId: APP2, customerId: "org-a" }),
      ).rejects.toMatchObject({ code: "app_access_required" });
      expect(await appOrganizationChoices(headers, { ...options, appId: APP2 })).toEqual([]);
      // The existing reader's public default retains its historical behavior.
      await expect(
        readManagedAppActorAccess(r.pool, {
          actorId,
          appId: APP2,
          organizationId: "org-a",
          workspaceId: "workspace",
        }),
      ).resolves.toEqual({ fenceGeneration: 5 });
      await r.pool.query(
        'update public.app_actor_access set roles=$1::jsonb where "actorId"=$2 and "appId"=$3',
        ["[]", actorId, APP2],
      );
      await expect(
        requireTenantContext(headers, { ...options, appId: APP2, customerId: "org-a" }),
      ).resolves.toMatchObject({ scope: { actorId, appId: APP2, customerId: "org-a" } });
      expect(
        (await appOrganizationChoices(headers, { ...options, appId: APP2 })).map((row) => row.id),
      ).toEqual(["org-a"]);
      await r.pool.query(
        'update public.app_actor_access set active=false where "actorId"=$1 and "appId"=$2',
        [actorId, APP2],
      );
      await expect(
        requireTenantContext(headers, { ...options, appId: APP2, customerId: "org-a" }),
      ).rejects.toMatchObject({ code: "app_access_required" });
      const choices = await requireUserOrganizationContext(headers, options);
      expect(choices.organizations.find((row) => row.id === "org-a")?.appIds).toEqual([APP]);
    }, 60_000);
  },
);
