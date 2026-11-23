"use client";

import { useEffect, useMemo, useState } from "react";
import { createAuthenticatedCsvWorkspaceClient, type CsvWorkspaceClient } from "./client";
import { InstalledCsvWorkspace } from "./InstalledCsvWorkspace";
import type { CsvWorkspaceContext } from "./types";

export type CsvWorkspaceProps = {
  baseUrl: string;
  expectedScope: { appId: string; customerId: string };
  initialAsOf?: string;
  description?: string;
  initialInstruction?: string;
};

/** Browser composition only: the host authenticates and supplies the expected app/customer. */
export function CsvWorkspace(props: CsvWorkspaceProps) {
  return (
    <CsvWorkspaceRun
      key={JSON.stringify([
        props.baseUrl,
        props.expectedScope.appId,
        props.expectedScope.customerId,
      ])}
      {...props}
    />
  );
}

function CsvWorkspaceRun({
  baseUrl,
  expectedScope,
  initialAsOf,
  description,
  initialInstruction,
}: CsvWorkspaceProps) {
  const [asOf, setAsOf] = useState(initialAsOf ?? "");
  const [started, setStarted] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (initialAsOf !== undefined) return;
    const now = new Date();
    setAsOf(
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
    );
  }, [initialAsOf]);
  const [loaded, setLoaded] = useState<{
    client: CsvWorkspaceClient;
    context?: CsvWorkspaceContext;
    error?: string;
  } | null>(null);
  const client = useMemo(
    () => createAuthenticatedCsvWorkspaceClient({ asOf, baseUrl }),
    [asOf, baseUrl],
  );

  useEffect(() => {
    if (!asOf) return;
    const controller = new AbortController();
    void client
      .loadWorkspace(controller.signal)
      .then((context) => {
        if (controller.signal.aborted) return;
        if (
          !expectedScope.customerId ||
          context.scope.appId !== expectedScope.appId ||
          context.scope.customerId !== expectedScope.customerId
        )
          throw new Error("CSV workspace returned a different authenticated organization");
        if (context.asOf !== asOf)
          throw new Error("CSV workspace returned a different effective date");
        setLoaded({ client, context });
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          setLoaded({
            client,
            error: failure instanceof Error ? failure.message : "CSV workspace unavailable",
          });
      });
    return () => controller.abort();
  }, [asOf, client, expectedScope.appId, expectedScope.customerId, reload]);

  const current = loaded?.client === client ? loaded : null;
  return (
    <main className="flex h-full flex-col gap-[var(--space-4)] p-[var(--space-6)]">
      <header>
        <h1 className="m-0 text-[length:var(--text-page-title)] font-[var(--font-weight-semibold)] text-[var(--color-text-primary)]">
          Import data
        </h1>
        <p className="mt-[var(--space-1)] text-[length:var(--text-body)] text-[var(--color-text-secondary)]">
          {description ??
            "Let the agent prepare the changes, refine them in the grid, then save once."}
        </p>
        <label className="mt-[var(--space-3)] flex w-fit items-center gap-[var(--space-2)] text-[length:var(--text-control-sm)]">
          Effective date
          <input
            aria-label="Effective date"
            type="date"
            value={asOf}
            disabled={started}
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (
                /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
                Number.isFinite(Date.parse(value)) &&
                new Date(value).toISOString().slice(0, 10) === value
              )
                setAsOf(value);
            }}
          />
        </label>
      </header>
      {current?.error ? <p role="alert">{current.error}</p> : null}
      {!current ? <p>Loading CSV workspace…</p> : null}
      {current?.context ? (
        <InstalledCsvWorkspace
          client={client}
          context={current.context}
          initialInstruction={initialInstruction}
          onRunStart={() => setStarted(true)}
          onRunReset={() => {
            setStarted(false);
            setLoaded(null);
            setReload((value) => value + 1);
          }}
        />
      ) : null}
    </main>
  );
}
