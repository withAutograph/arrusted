import { describe, expect, it, vi } from "vitest";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "@better-auth/memory-adapter";
import {
  appInvitationAcceptanceUrl,
  createManagedAppInvitation,
  managedAppInvitationPlugin,
  verifyManagedAppInvitation,
} from "../managed-app-invitations";
import { authDatabaseResourceDigest } from "../signup-policy";
import type { ManagedProductionRealm } from "../public-realm-enrollment";

const realm: ManagedProductionRealm = {
  version: 1,
  kind: "managed-production-realm-v1",
  workspaceId: "workspace",
  repositoryId: "123",
  repositoryFullName: "owner/repository",
  authResourceId: "auth",
  authorizedOrganizationIds: ["dev"],
  publicOrigin: "https://apps.example",
  project: { projectId: "prj_apps", ownerId: "team", environment: "production" },
  resource: {
    version: 1,
    environment: "production",
    hostname: "ep-auth.neon.tech",
    port: 5432,
    database: "auth",
    schema: "public",
    runtimeRole: "auth_runtime",
    migratorRole: "auth_migrator",
    neon: { projectId: "neon", branchId: "branch" },
  },
};
const row = {
  id: "11111111-1111-4111-a111-111111111111",
  workspaceId: "workspace",
  appId: "requests",
  organizationId: "dev",
  email: "person@example.test",
  roles: ["requester"],
  returnUrl: "https://apps.example/requests",
  operationRef: "22222222-2222-4222-a222-222222222222",
  planDigest: "a".repeat(64),
  scopeDigest: "b".repeat(64),
  resourceDigest: authDatabaseResourceDigest(realm.resource),
  fenceGeneration: 2,
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
  status: "pending",
  verifiedActorId: null,
  verifiedSessionId: null,
  deliveryStatus: "sending",
  deliveryAttemptId: "attempt",
  deliveryProviderId: null,
};

describe("managed invitation authentication", () => {
  it("uses a one-use verified sign-in without opening password signup or granting app access", async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("record_app_invitation_delivery") ? [{ recorded: true }] : [row],
    }));
    const messages: string[] = [];
    const send = vi.fn(async (message: { text: string }) => {
      messages.push(message.text);
      return "email_1";
    });
    const memory = { user: [], session: [], account: [], verification: [] };
    const auth = betterAuth({
      baseURL: realm.publicOrigin,
      secret: "managed-auth-test-secret-at-least-32-characters",
      database: memoryAdapter(memory),
      emailAndPassword: { enabled: true, disableSignUp: true },
      plugins: [
        managedAppInvitationPlugin({
          database: { query },
          realm,
          apiKey: "unused",
          from: "app@example.test",
          send,
        }),
      ],
    });
    const response = await auth.handler(
      new Request(`${realm.publicOrigin}/api/auth/sign-in/magic-link`, {
        method: "POST",
        headers: { origin: realm.publicOrigin, "content-type": "application/json" },
        body: JSON.stringify({
          email: row.email,
          callbackURL: appInvitationAcceptanceUrl(realm.publicOrigin, row.id),
          metadata: { appInvitationId: row.id, deliveryAttemptId: "attempt" },
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledOnce();
    expect(memory.user).toHaveLength(0);
    const link = messages[0]!.split("\n")[1]!;
    const verified = await auth.handler(new Request(link));
    expect(verified.status).toBe(302);
    expect(verified.headers.get("location")).toBe(
      appInvitationAcceptanceUrl(realm.publicOrigin, row.id),
    );
    expect(memory.user).toHaveLength(1);
    expect(memory.user[0]).toMatchObject({ email: row.email, emailVerified: true });
    const replayed = await auth.handler(new Request(link));
    expect(replayed.headers.get("location")).toContain("error=");
    expect(memory.session).toHaveLength(1);
    expect(
      query.mock.calls.every(
        ([sql]) =>
          !sql.includes("app_actor_assignment") && !sql.includes("insert into public.member"),
      ),
    ).toBe(true);
    const signup = await auth.handler(
      new Request(`${realm.publicOrigin}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { origin: realm.publicOrigin, "content-type": "application/json" },
        body: JSON.stringify({
          email: "uninvited@example.test",
          name: "Uninvited",
          password: "long-enough-password",
        }),
      }),
    );
    expect(signup.status).toBe(400);
    expect(memory.user).toHaveLength(1);
  });

  it.each([
    { status: "cancelled" },
    { deliveryStatus: "sent" },
    { expiresAt: "2000-01-01T00:00:00Z" },
    { email: "someone-else@example.test" },
  ])("refuses invitation delivery for %j", async (change) => {
    const send = vi.fn(async () => "email_1");
    const plugin = managedAppInvitationPlugin({
      database: { query: async () => ({ rows: [{ ...row, ...change }] }) },
      realm,
      apiKey: "unused",
      from: "app@example.test",
      send,
    });
    const auth = betterAuth({
      baseURL: realm.publicOrigin,
      secret: "managed-auth-test-secret-at-least-32-characters",
      database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
      plugins: [plugin],
    });
    const response = await auth.handler(
      new Request(`${realm.publicOrigin}/api/auth/sign-in/magic-link`, {
        method: "POST",
        headers: { origin: realm.publicOrigin, "content-type": "application/json" },
        body: JSON.stringify({
          email: row.email,
          callbackURL: appInvitationAcceptanceUrl(realm.publicOrigin, row.id),
          metadata: { appInvitationId: row.id, deliveryAttemptId: "attempt" },
        }),
      }),
    );
    expect(response.ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("binds acceptance to the actual Auth actor/session and leaves grants to the protected operator", async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("verify_app_access_invitation") ? [{ verified: true }] : [row],
    }));
    expect(
      await verifyManagedAppInvitation({ query }, realm, {
        invitationId: row.id,
        actorId: "authenticated-actor",
        sessionId: "authenticated-session",
      }),
    ).toBe(row.returnUrl);
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining("verify_app_access_invitation"),
      [row.id, "authenticated-actor", "authenticated-session", row.resourceDigest],
    );
  });

  it("does not let an approved workspace invite into another organization or redirect elsewhere", async () => {
    const query = vi.fn();
    for (const change of [
      { organizationId: "another-tenant" },
      { returnUrl: "https://attacker.example" },
      { returnUrl: "blob:https://apps.example/invitation" },
      { returnUrl: "http://apps.example/invitation" },
    ]) {
      await expect(
        createManagedAppInvitation(
          { query },
          {
            id: row.id,
            workspaceId: row.workspaceId,
            appId: row.appId,
            organizationId: row.organizationId,
            email: row.email,
            roles: row.roles,
            returnUrl: row.returnUrl,
            operationRef: row.operationRef,
            planDigest: row.planDigest,
            fenceGeneration: 1,
            expiresAt: row.expiresAt,
            ...change,
          },
          realm,
          "https://builder.example",
        ),
      ).rejects.toThrow("app_invitation_scope_mismatch");
    }
    expect(query).not.toHaveBeenCalled();
  });
});
