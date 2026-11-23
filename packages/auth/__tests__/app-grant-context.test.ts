// @vitest-environment node
import { expect, it } from "vitest";
import { requireAppGrantContext } from "../server";

const legacyMemberships = async (input: { actorId: string; organizationIds: readonly string[] }) =>
  input.organizationIds.map((organizationId) => ({
    id: `legacy:${organizationId}:${input.actorId}`,
    organizationId,
    actorId: input.actorId,
  }));

const options = {
  appId: "spend-review",
  getSession: async () => ({
    user: { id: "actor" },
    session: { id: "session", activeOrganizationId: "tenant" },
  }),
  verifyTenantMembership: async () => true,
  loadAppAccess: async () => null,
  loadOrganizationMemberships: legacyMemberships,
  listOrganizations: async () => [
    { id: "tenant", name: "Tenant", slug: "tenant", appIds: ["spend-review"] },
  ],
};
it("reads exact current app grants only after session and membership verification", async () => {
  let loads = 0;
  const result = await requireAppGrantContext(new Headers(), {
    ...options,
    loadAppActorGrants: async (input) => {
      expect(input).toEqual({ actorId: "actor", appId: "spend-review", organizationId: "tenant" });
      loads += 1;
      return [{ role: "reviewer", fenceGeneration: loads }];
    },
  });
  expect(result.grants).toEqual([{ role: "reviewer", fenceGeneration: 1 }]);
  expect(Object.isFrozen(result.grants)).toBe(true);
  expect(result.roles).toEqual(["reviewer"]);
});
it.each([
  { grants: [] },
  { grants: [{ role: "reviewer", fenceGeneration: -1 }] },
  { grants: [{ role: "reviewer", fenceGeneration: 0.5 }] },
  { grants: [{ role: "", fenceGeneration: 1 }] },
  { grants: [{ role: "reviewer\nadmin", fenceGeneration: 1 }] },
  {
    grants: [
      { role: "reviewer", fenceGeneration: 0 },
      { role: "reviewer", fenceGeneration: 1 },
    ],
  },
])("rejects missing or invalid assignments", async ({ grants }) => {
  await expect(
    requireAppGrantContext(new Headers(), { ...options, loadAppActorGrants: async () => grants }),
  ).rejects.toThrow();
});
it("returns a distinct app access claim for a role-less app and denies it after revocation", async () => {
  let active = true;
  const input = {
    ...options,
    loadAppActorGrants: async () => [],
    loadAppAccess: async () => (active ? { fenceGeneration: 8 } : null),
  };
  await expect(requireAppGrantContext(new Headers(), input)).resolves.toMatchObject({
    roles: [],
    grants: [],
    appAccess: { fenceGeneration: 8 },
  });
  active = false;
  await expect(requireAppGrantContext(new Headers(), input)).rejects.toMatchObject({
    code: "app_access_required",
  });
});
it("does not load assignment authority for an unverified human", async () => {
  let loaded = false;
  await expect(
    requireAppGrantContext(new Headers(), {
      ...options,
      getSession: async () => null,
      loadAppActorGrants: async () => {
        loaded = true;
        return [{ role: "reviewer", fenceGeneration: 1 }];
      },
    }),
  ).rejects.toThrow();
  expect(loaded).toBe(false);
});

it("does not load grants after failed tenant membership verification", async () => {
  let loaded = false;
  await expect(
    requireAppGrantContext(new Headers(), {
      ...options,
      verifyTenantMembership: async () => false,
      loadAppActorGrants: async () => {
        loaded = true;
        return [{ role: "reviewer", fenceGeneration: 1 }];
      },
    }),
  ).rejects.toThrow();
  expect(loaded).toBe(false);
});

it("rejects a non-string role readback", async () => {
  const grants = [{ role: "reviewer", fenceGeneration: 1 }];
  Object.defineProperty(grants[0], "role", { value: 123 });
  await expect(
    requireAppGrantContext(new Headers(), { ...options, loadAppActorGrants: async () => grants }),
  ).rejects.toThrow();
});
