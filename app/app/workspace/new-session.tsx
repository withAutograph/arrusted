"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createSession } from "../data/actions";
export function NewSession({ title, models }: { title: string; models?: string[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<Record<string, unknown> | null>(null);
  async function open() {
    setBusy(true);
    setError(null);
    const input = request.current ?? {
      title,
      ...(models ? { models } : {}),
      session_id: crypto.randomUUID(),
      request_id: crypto.randomUUID(),
      as_of: new Date().toISOString().slice(0, 10),
    };
    request.current = input;
    try {
      const result = await createSession(input);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      router.push(`/starter/${result.value.sessionId}`);
      router.refresh();
    } catch {
      setError("Could not confirm the session. Retry to check the same request.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button className="primary" disabled={busy} onClick={() => void open()}>
        {busy ? "Opening…" : "Open canvas"}
      </button>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </>
  );
}
