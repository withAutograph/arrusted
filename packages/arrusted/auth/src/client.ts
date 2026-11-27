"use client";

import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export function authClientBaseURL(originOverride?: string): string {
  const origin =
    originOverride ??
    (typeof globalThis.origin === "string" && globalThis.origin.length > 0
      ? globalThis.origin
      : "http://localhost:3000");
  return new URL("/api/auth", origin).toString();
}

export function createAppAuthClient(options?: { baseURL?: string }) {
  return createAuthClient({
    baseURL: options?.baseURL ?? authClientBaseURL(),
    plugins: [organizationClient()],
  });
}

export const authClient = createAppAuthClient();

export const { signIn, signOut, signUp, useSession } = authClient;
