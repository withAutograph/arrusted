"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { authClient } from "@autograph/auth/client";

const INVALID_LINK_MESSAGE =
  "This password link is invalid or has expired. Ask the app administrator for a new link.";

export function SetPassword() {
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const readFragment = useRef(false);

  useEffect(() => {
    if (readFragment.current) return;
    readFragment.current = true;
    const value = new URLSearchParams(window.location.hash.slice(1)).get("token")?.trim() || null;
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    setToken(value);
    setReady(true);
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) {
      setError(INVALID_LINK_MESSAGE);
      return;
    }
    const data = new FormData(event.currentTarget);
    const password = String(data.get("password") ?? "");
    const confirmPassword = String(data.get("confirmPassword") ?? "");
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await authClient.resetPassword({ newPassword: password, token });
      if (result.error) {
        setError(
          result.error.code === "INVALID_TOKEN" || /invalid|expired/i.test(result.error.message ?? "")
            ? INVALID_LINK_MESSAGE
            : (result.error.message ?? INVALID_LINK_MESSAGE),
        );
        return;
      }
      setDone(true);
    } catch {
      setError("Could not set your password. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <main className="auth-card">
        <h1>Password set</h1>
        <p>Your password has been saved. You can now sign in.</p>
        <p>
          <Link href="/auth/sign-in">Sign in</Link>
        </p>
      </main>
    );
  }

  if (ready && !token) {
    return (
      <main className="auth-card">
        <h1>Set your password</h1>
        <p role="alert" className="error">
          {INVALID_LINK_MESSAGE}
        </p>
        <p>
          <Link href="/auth/sign-in">Back to sign in</Link>
        </p>
      </main>
    );
  }

  return (
    <main className="auth-card">
      <h1>Set your password</h1>
      <form onSubmit={(event) => void submit(event)}>
        <label>
          New password
          <input
            name="password"
            type="password"
            minLength={8}
            autoComplete="new-password"
            required
          />
        </label>
        <label>
          Confirm password
          <input
            name="confirmPassword"
            type="password"
            minLength={8}
            autoComplete="new-password"
            required
          />
        </label>
        <button className="primary" disabled={busy || !ready}>
          {busy ? "Please wait…" : "Set password"}
        </button>
      </form>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </main>
  );
}
