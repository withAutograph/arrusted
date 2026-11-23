"use client";
import { useState, type FormEvent } from "react";
import { authClient } from "@autograph/auth/client";
export function SignIn({ redirectTo, oauth }: { redirectTo: string; oauth: boolean }) {
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
        ? await authClient.signUp.email({ ...credentials, name: String(data.get("name")) })
        : await authClient.signIn.email(credentials);
      if (result.error) {
        setError(result.error.message ?? "Sign-in failed.");
        return;
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
      <button style={{ marginTop: 20 }} onClick={() => setCreating(!creating)}>
        {creating ? "Already have an account? Sign in" : "Create an account"}
      </button>
    </main>
  );
}
