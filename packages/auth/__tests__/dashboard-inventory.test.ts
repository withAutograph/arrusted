import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { memoryAdapter } from "@better-auth/memory-adapter";
import { dash } from "@better-auth/infra";
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { describe, expect, it } from "vitest";

import { createAuthRouteHandlers } from "../next";

const API_KEY = "better-auth-infrastructure-api-key";
const AUTH_SECRET = "01234567890123456789012345678901";

function base64Url(value: string | ArrayBuffer): string {
  return Buffer.from(typeof value === "string" ? value : new Uint8Array(value)).toString(
    "base64url",
  );
}

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(digest).toString("hex");
}

async function signDashboardToken(
  privateKey: CryptoKey,
  payload: Record<string, unknown> = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const encodedHeader = base64Url(JSON.stringify({ alg: "ES256", kid: "dashboard-test" }));
  const encodedPayload = base64Url(
    JSON.stringify({
      apiKeyHash: await hash(API_KEY),
      exp: now + 300,
      iat: now,
      jti: crypto.randomUUID(),
      ...payload,
    }),
  );
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = await crypto.subtle.sign(
    { hash: "SHA-256", name: "ECDSA" },
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64Url(signature)}`;
}

describe("Better Auth Infrastructure inventory", () => {
  it("serves signed user, organization, and session inventory through the adapter", async () => {
    const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const publicKey = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
    const jwks = {
      keys: [
        {
          ...publicKey,
          alg: "ES256",
          kid: "dashboard-test",
          use: "sig",
        },
      ],
    };
    const server = createServer((request, response) => {
      if (request.url === "/api/auth/jwks") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(jwks));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address() as AddressInfo;
      const now = new Date();
      const database: Record<string, Record<string, unknown>[]> = {
        account: [],
        invitation: [],
        member: [
          {
            createdAt: now,
            id: "member-1",
            organizationId: "organization-1",
            role: "owner",
            userId: "user-1",
          },
        ],
        organization: [
          {
            appIds: ["dev"],
            createdAt: now,
            id: "organization-1",
            logo: null,
            metadata: null,
            name: "Dev",
            slug: "dev",
          },
        ],
        session: [
          {
            activeOrganizationId: "organization-1",
            createdAt: now,
            expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
            id: "session-1",
            ipAddress: "127.0.0.1",
            token: "must-not-leave-the-auth-boundary",
            updatedAt: now,
            userAgent: "dashboard-inventory-test",
            userId: "user-1",
          },
        ],
        user: [
          {
            createdAt: now,
            email: "dashboard@example.test",
            emailVerified: true,
            id: "user-1",
            image: null,
            name: "Dashboard Test",
            updatedAt: now,
          },
        ],
        verification: [],
      };
      const auth = betterAuth({
        baseURL: "https://apps.autograph.so",
        database: memoryAdapter(database),
        secret: AUTH_SECRET,
        plugins: [
          organization({
            allowUserToCreateOrganization: false,
            disableOrganizationDeletion: true,
            schema: {
              organization: {
                additionalFields: {
                  appIds: { input: false, required: false, type: "json" },
                },
              },
            },
          }),
          dash({
            activityTracking: { enabled: false },
            apiKey: API_KEY,
            apiUrl: `http://127.0.0.1:${address.port}`,
          }),
        ],
      });
      const handlers = createAuthRouteHandlers(auth);
      const rejectedMutation = await handlers.POST(
        new Request("https://apps.autograph.so/api/auth/dash/create-user", {
          body: JSON.stringify({
            email: "unauthorized@example.test",
            emailVerified: true,
            name: "Unauthorized",
          }),
          headers: {
            authorization: "Bearer header.payload.signature",
            "content-type": "application/json",
          },
          method: "POST",
        }),
      );
      expect(rejectedMutation.status).toBe(401);
      expect(database.user).toHaveLength(1);

      const listToken = await signDashboardToken(keyPair.privateKey);
      const detailToken = await signDashboardToken(keyPair.privateKey, { userId: "user-1" });
      const request = (path: string, token: string) =>
        handlers.GET(
          new Request(`https://apps.autograph.so/api/auth${path}`, {
            headers: {
              authorization: `Bearer ${token}`,
              "x-forwarded-host": "dash.better-auth.com",
            },
          }),
        );

      const [usersResponse, organizationsResponse, userResponse] = await Promise.all([
        request("/dash/list-users", listToken),
        request("/dash/list-organizations", listToken),
        request("/dash/user", detailToken),
      ]);
      const users = await usersResponse.json();
      const organizations = await organizationsResponse.json();
      const user = await userResponse.json();

      expect(usersResponse.status).toBe(200);
      expect(users).toMatchObject({
        activityTrackingEnabled: false,
        total: 1,
        users: [{ email: "dashboard@example.test", id: "user-1" }],
      });
      expect(organizationsResponse.status).toBe(200);
      expect(organizations).toMatchObject({
        organizations: [
          {
            id: "organization-1",
            memberCount: 1,
            members: [{ email: "dashboard@example.test", id: "user-1" }],
          },
        ],
        total: 1,
      });
      expect(userResponse.status).toBe(200);
      expect(user).toMatchObject({
        id: "user-1",
        session: [{ id: "session-1", userId: "user-1" }],
      });
      expect(user.session[0]).not.toHaveProperty("token");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
