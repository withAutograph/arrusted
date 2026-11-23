import { dashClient } from "@better-auth/infra/client";
import { createAuthClient } from "better-auth/react";
import { organizationClient } from "better-auth/client/plugins";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";

export function authClientBaseURL() {
  const origin =
    typeof globalThis.origin === "string" && globalThis.origin.length > 0
      ? globalThis.origin
      : "http://localhost:3000";
  return new URL("/api/auth", origin).toString();
}

export const authClient = createAuthClient({
  baseURL: authClientBaseURL(),
  // The OAuth provider client carries a signed authorization request through
  // sign-in, so an agent's OAuth flow continues after the user signs in.
  plugins: [organizationClient(), dashClient(), oauthProviderClient()],
});

export const { signIn, signOut, signUp, useSession } = authClient;
