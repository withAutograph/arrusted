import { describe, expect, it, vi } from "vitest";

import { appOrganizationChoices, requireAppContext, type AppContextGuardOptions } from "../server";

const legacyMemberships = async (input: { actorId: string; organizationIds: readonly string[] }) =>
  input.organizationIds.map((organizationId) => ({
    id: `legacy:${organizationId}:${input.actorId}`,
    organizationId,
    actorId: input.actorId,
  }));

const options = (roles: readonly string[]): AppContextGuardOptions => ({
  appId: "proof",
  getSession: async () => ({
    user: { id: "actor-a", name: "Actor A" },
    session: { activeOrganizationId: "tenant-a" },
  }),
  verifyTenantMembership: async () => true,
  loadOrganizationMemberships: legacyMemberships,
  listOrganizations: async () => [
    { id: "tenant-a", name: "Tenant A", slug: "tenant-a", appIds: ["proof"] },
  ],
  loadAppActorRoles: async (input) => {
    expect(input).toEqual({ actorId: "actor-a", appId: "proof", organizationId: "tenant-a" });
    return roles;
  },
  loadAppActorAccess: async () => false,
});

describe("authenticated app assignments", () => {
  it("returns immutable current roles bound to the verified tenant and actor", async () => {
    const supplied = ["reviewer", "member", "member"];
    const context = await requireAppContext(new Headers(), options(supplied));
    expect(context.scope).toEqual({ appId: "proof", customerId: "tenant-a", actorId: "actor-a" });
    expect(context.roles).toEqual(["member", "reviewer"]);
    expect(Object.isFrozen(context.roles)).toBe(true);
    supplied.length = 0;
    expect(context.roles).toEqual(["member", "reviewer"]);
  });

  it("requires an active assignment and the requested role", async () => {
    for (const value of [options([]), { ...options(["member"]), requiredRole: "reviewer" }]) {
      await expect(requireAppContext(new Headers(), value)).rejects.toMatchObject({
        code: "app_access_required",
        status: 403,
      });
    }
    await expect(
      requireAppContext(new Headers(), { ...options(["reviewer"]), requiredRole: "reviewer" }),
    ).resolves.toMatchObject({ roles: ["reviewer"] });
  });

  it("verifies session and organization before reading app roles", async () => {
    let rolesRead = false;
    const input = {
      ...options(["member"]),
      loadAppActorRoles: async () => {
        rolesRead = true;
        return ["member"];
      },
    };
    await expect(
      requireAppContext(new Headers(), { ...input, getSession: async () => null }),
    ).rejects.toMatchObject({ code: "auth_required" });
    await expect(
      requireAppContext(new Headers(), { ...input, verifyTenantMembership: async () => false }),
    ).rejects.toMatchObject({ code: "tenant_required" });
    expect(rolesRead).toBe(false);
  });

  it("reads assignments afresh so revocation fails on the next invocation", async () => {
    let roles = ["member"];
    const input = { ...options([]), loadAppActorRoles: async () => roles };
    await expect(requireAppContext(new Headers(), input)).resolves.toMatchObject({
      roles: ["member"],
    });
    roles = [];
    await expect(requireAppContext(new Headers(), input)).rejects.toMatchObject({
      code: "app_access_required",
    });
  });

  it("rejects malformed assignment data", async () => {
    await expect(requireAppContext(new Headers(), options(["Member\n"]))).rejects.toThrow(
      "App role assignment response is invalid",
    );
  });
  it("supports revocable role-less app access without granting a required business role", async () => {
    let active = true;
    const input = { ...options([]), loadAppActorAccess: async () => active };
    await expect(requireAppContext(new Headers(), input)).resolves.toMatchObject({ roles: [] });
    await expect(
      requireAppContext(new Headers(), { ...input, requiredRole: "owner" }),
    ).rejects.toMatchObject({ code: "app_access_required" });
    active = false;
    await expect(requireAppContext(new Headers(), input)).rejects.toMatchObject({
      code: "app_access_required",
    });
  });
});

describe("app organization choices", () => {
  it("skips an organization whose assignment lookup fails and keeps the others", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const choices = await appOrganizationChoices(new Headers(), {
        ...options(["member"]),
        getSession: async () => ({ user: { id: "actor-a", name: "Actor A" }, session: {} }),
        loadOrganizationMemberships: legacyMemberships,
        listOrganizations: async () =>
          ["tenant-a", "tenant-b", "tenant-c"].map((id) => ({
            id,
            name: id,
            slug: id,
            appIds: ["proof"],
          })),
        loadAppActorRoles: async ({ organizationId }) => {
          if (organizationId === "tenant-b") throw new Error("lookup timed out");
          return ["member"];
        },
      });
      expect(choices.map((organization) => organization.id)).toEqual(["tenant-a", "tenant-c"]);
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0]![0])).toContain("tenant-b");
      expect(String(warn.mock.calls[0]![0])).toContain("lookup timed out");
    } finally {
      warn.mockRestore();
    }
  });
});
