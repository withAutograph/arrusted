"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@autograph/components";
import { IntegrationActionProvider } from "@modules/integrations";
import type { IntegrationActionRequest, IntegrationsSurfaceProps } from "@modules/integrations";
import type { AppConnectionSetup, ConnectionSetup } from "./connection-setup";

type ActionResult = void | { status: "cancelled" };

/** Inline OAuth handoff. Broad provider credentials never enter this client entrypoint. */
export function AppIntegrationClient({
  children,
  prepareConnection,
  completeConnection,
  prepareReconnect,
  completeReconnect,
  prepareActivation,
  onAction,
  onRefresh,
}: AppConnectionSetup &
  Pick<IntegrationsSurfaceProps, "onAction" | "onRefresh"> & {
    children: ReactNode;
    prepareReconnect?(providerId: string, accountId: string): Promise<ConnectionSetup>;
    completeReconnect?(
      providerId: string,
      accountId: string,
      setupId: string,
    ): Promise<{ status: "pending" | "connected" }>;
    prepareActivation?(
      providerId: string,
      accountId: string,
    ): Promise<{ status: "already-active" } | { status: "ready"; grant: string; path: string }>;
  }) {
  const [setup, setSetup] = useState<{
    providerId: string;
    value: ConnectionSetup;
    accountId?: string;
  }>();
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState("");
  const current = useRef<{ resolve(value: ActionResult): void }>(undefined);
  const busy = useRef(false);
  const panel = useRef<HTMLElement>(null);
  const router = useRouter();
  useEffect(() => () => current.current?.resolve({ status: "cancelled" }), []);
  useEffect(() => {
    if (setup) panel.current?.focus();
  }, [setup]);

  async function action(request: IntegrationActionRequest): Promise<ActionResult> {
    if (request.kind === "activate") {
      if (!prepareActivation || !request.accountId)
        throw new Error("Integration activation unavailable");
      const activation = await prepareActivation(request.providerId, request.accountId);
      if (activation.status === "already-active") {
        router.refresh();
        return;
      }
      const target = new URL(activation.path, window.location.origin);
      if (
        target.origin !== window.location.origin ||
        !target.pathname.endsWith("/activate") ||
        target.search ||
        target.hash
      )
        throw new Error("Integration activation unavailable");
      const response = await fetch(target, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant: activation.grant }),
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error("Integration activation unavailable");
      router.refresh();
      return;
    }
    const reconnect =
      request.kind === "reconnect" && prepareReconnect && completeReconnect && request.accountId;
    if (request.kind !== "connect" && !reconnect) {
      if (!onAction) throw new Error("Integration action unavailable");
      const result = await onAction(request);
      if (result?.status !== "cancelled") router.refresh();
      return result;
    }
    if (busy.current) throw new Error("Complete or cancel the current connection setup");
    busy.current = true;
    try {
      const value = reconnect
        ? await prepareReconnect(request.providerId, reconnect)
        : await prepareConnection(request.providerId);
      // The server also validates this against the provider's approved OAuth origins.
      if (new URL(value.authorizationUrl).protocol !== "https:")
        throw new Error("Invalid authorization URL");
      setSetup({
        providerId: request.providerId,
        value,
        ...(reconnect ? { accountId: reconnect } : {}),
      });
      setNotice("");
      return await new Promise<ActionResult>((resolve) => {
        current.current = { resolve };
      });
    } finally {
      busy.current = false;
    }
  }

  function cancel() {
    setSetup(undefined);
    setNotice("");
    current.current?.resolve({ status: "cancelled" });
    current.current = undefined;
  }

  async function check() {
    if (!setup || checking) return;
    setChecking(true);
    try {
      const result =
        setup.accountId && completeReconnect
          ? await completeReconnect(setup.providerId, setup.accountId, setup.value.setupId)
          : await completeConnection(setup.providerId, setup.value.setupId);
      if (result.status === "pending") {
        setNotice(
          "The provider has not confirmed this connection yet. Finish sign-in, then check again.",
        );
        return;
      }
      setSetup(undefined);
      setNotice("");
      current.current?.resolve();
      current.current = undefined;
      try {
        await onRefresh?.();
        router.refresh();
      } catch {
        setNotice(
          "The connection is confirmed, but the view could not refresh. Refresh the page to see it.",
        );
      }
    } catch {
      // Provider responses and authorization URLs may contain private data.
      setNotice("The connection could not be verified. Check again or cancel and retry.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <IntegrationActionProvider
      onAction={action}
      {...(onRefresh === undefined ? {} : { onRefresh })}
    >
      {children}
      {!setup && notice ? <p role="status">{notice}</p> : null}
      {setup ? (
        <section
          ref={panel}
          tabIndex={-1}
          aria-label="Connect provider account"
          aria-busy={checking}
        >
          <h2>Connect provider account</h2>
          <p>
            Open the provider sign-in window. When sign-in is complete, check the connection here.
          </p>
          <a href={setup.value.authorizationUrl} target="_blank" rel="noopener noreferrer">
            Open provider sign-in
          </a>
          <Button onClick={() => void check()} disabled={checking}>
            Check connection
          </Button>
          <Button intent="secondary" onClick={cancel} disabled={checking}>
            Cancel
          </Button>
          {notice ? <p role="status">{notice}</p> : null}
        </section>
      ) : null}
    </IntegrationActionProvider>
  );
}
