"use client";
import { authClient } from "@autograph/auth/client";
export function SignOut() {
  return (
    <button
      onClick={() => void authClient.signOut().then(() => window.location.assign("/auth/sign-in"))}
    >
      Sign out
    </button>
  );
}
