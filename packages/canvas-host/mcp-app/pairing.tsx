import { useEffect, useState } from "react";
import { Button } from "@autograph/components";

import type { CanvasPairing, FrameSession } from "./client";

/**
 * The only thing the canvas shows without a token: "Sign in to <app> to work
 * here as you", a short code and Open sign-in. Open sign-in opens the device
 * page once (`openLink`); the frame polls until the person approves.
 */
export function PairingPanel(props: {
  title: string;
  session: FrameSession;
  openLink: (url: string) => Promise<unknown>;
}) {
  const { session, openLink } = props;
  const [pairing, setPairing] = useState<CanvasPairing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);

  useEffect(() => {
    let current: CanvasPairing | null = null;
    let cancelled = false;
    const start = () => {
      setError(null);
      setOpened(false);
      session
        .pair()
        .then((started) => {
          if (cancelled) return started.cancel();
          current = started;
          setPairing(started);
          void started.done.then((approved) => {
            if (cancelled || approved) return;
            // Denied or expired: a fresh code, so the person can try again.
            start();
          });
        })
        .catch((reason: unknown) => {
          if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
        });
    };
    start();
    return () => {
      cancelled = true;
      current?.cancel();
    };
  }, [session]);

  return (
    <main
      className="flex min-h-full items-center justify-center p-[var(--space-6)]"
      aria-label="Sign in"
    >
      <div className="flex w-full max-w-[var(--size-modal-sm)] flex-col gap-[var(--space-4)] rounded-[var(--radius-panel)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-[var(--space-6)]">
        <h1 className="m-[var(--space-0)] text-[length:var(--text-title)] font-[var(--font-weight-semibold)] leading-[var(--leading-title)] text-[var(--color-text-primary)]">
          Sign in to {props.title} to work here as you
        </h1>
        {error ? (
          <p
            role="alert"
            className="m-[var(--space-0)] text-[length:var(--text-body)] text-[var(--color-status-danger)]"
          >
            {error}
          </p>
        ) : null}
        {pairing ? (
          <>
            <p className="m-[var(--space-0)] text-[length:var(--text-body)] leading-[var(--leading-body)] text-[var(--color-text-secondary)]">
              Your code:{" "}
              <strong className="font-[family-name:var(--font-mono)] tracking-[var(--tracking-label)]">
                {pairing.userCode}
              </strong>
            </p>
            <Button
              onClick={() => {
                setOpened(true);
                void openLink(pairing.verificationUrl).catch(() => setOpened(false));
              }}
            >
              Open sign-in
            </Button>
            {opened ? (
              <p className="m-[var(--space-0)] text-[length:var(--text-body)] leading-[var(--leading-body)] text-[var(--color-text-secondary)]">
                Approve in the page that opened; this canvas then opens.
              </p>
            ) : null}
          </>
        ) : error ? null : (
          <p className="m-[var(--space-0)] text-[length:var(--text-body)] leading-[var(--leading-body)] text-[var(--color-text-secondary)]">
            Preparing sign-in…
          </p>
        )}
      </div>
    </main>
  );
}
