"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { authClient } from "@autograph/auth/client";
export function SignIn({
  redirectTo,
  oauth,
  openSignUp,
}: {
  redirectTo: string;
  oauth: boolean;
  openSignUp: boolean;
}) {
  const [proof, setProof] = useState<{ setup?: string; invite?: string }>({});
  const readFragment = useRef(false);
  useEffect(() => {
    if (readFragment.current) return;
    readFragment.current = true;
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const setup = fragment.get("setup") ?? undefined;
    const invite = fragment.get("invite") ?? undefined;
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    setProof({ setup, invite });
    if (setup || invite) setCreating(true);
  }, []);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const data = new FormData(event.currentTarget);
    const requested = redirectTo;
    const callbackURL =
      requested.startsWith("/") && !requested.startsWith("//") && !requested.includes("\\")
        ? requested
        : "/";
    try {
      const credentials = {
        email: String(data.get("email")),
        password: String(data.get("password")),
        callbackURL,
      };
      const result = creating
        ? await authClient.signUp.email(
            { ...credentials, name: String(data.get("name")) },
            {
              headers: {
                ...(proof.setup ? { "x-owner-setup": proof.setup } : {}),
                ...(proof.invite ? { "x-invitation": proof.invite } : {}),
              },
            },
          )
        : await authClient.signIn.email(credentials);
      if (result.error) {
        const message = result.error.message ?? "Sign-in failed.";
        if (creating && proof.invite && /already exists|already registered/i.test(message)) {
          setError(
            `${message} If you already have an account, switch to Sign in and enter your existing password to accept this invitation.`,
          );
        } else {
          setError(message);
        }
        return;
      }
      if (!creating && proof.invite) {
        const accept = await fetch("/api/auth/accept-member-invitation", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "x-invitation": proof.invite,
            accept: "application/json",
          },
        });
        if (!accept.ok) {
          const body = (await accept.json().catch(() => ({}))) as { message?: string };
          setError(body.message ?? "Invitation could not be accepted.");
          return;
        }
      }
      // The OAuth client plugin continues a signed authorization request after login.
      if (
        result.data &&
        "url" in result.data &&
        typeof result.data.url === "string" &&
        result.data.url
      )
        window.location.assign(result.data.url);
      else if (!oauth) window.location.assign(callbackURL);
    } catch {
      setError("Sign-in could not be completed. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-card">
      <h1>{creating ? "Create your account" : "Welcome back"}</h1>
      {proof.invite && (
        <p>
          {creating
            ? "Create a new account with your invited email, or switch to Sign in with your existing password if you already have an account."
            : "Sign in with your existing password to accept this invitation."}
        </p>
      )}
      <form onSubmit={(event) => void submit(event)}>
        {creating && (
          <label>
            Name
            <input name="name" autoComplete="name" required />
          </label>
        )}
        <label>
          Email
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            minLength={8}
            autoComplete={creating ? "new-password" : "current-password"}
            required
          />
        </label>
        <button className="primary" disabled={busy}>
          {busy ? "Please wait…" : creating ? "Create account" : "Sign in"}
        </button>
      </form>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {(openSignUp || proof.setup || proof.invite) && (
        <button style={{ marginTop: 20 }} onClick={() => setCreating(!creating)}>
          {creating ? "Already have an account? Sign in" : "Create an account"}
        </button>
      )}
    </main>
  );
}
