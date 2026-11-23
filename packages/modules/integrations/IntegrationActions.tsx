"use client";

import { useId, useRef, useState } from "react";
import { Button, FieldFrame, Select } from "@autograph/components";
import { useIntegrationActionHandlers } from "./IntegrationActionProvider";
import type {
  IntegrationAction,
  IntegrationActionRequest,
  IntegrationsSurfaceProps,
} from "./types";

const labels = {
  connect: "Connect account",
  reconnect: "Reconnect",
  activate: "Activate for this app",
  configure: "Configure",
  disable: "Disable for this app",
  disconnect: "Disconnect from organization",
} as const;

export function IntegrationActions({
  providerId,
  accountId,
  actions,
  onAction: actionHandler,
}: {
  providerId: string;
  accountId?: string;
  actions: readonly IntegrationAction[];
  onAction: IntegrationsSurfaceProps["onAction"];
}) {
  const handlers = useIntegrationActionHandlers();
  const onAction = actionHandler ?? handlers.onAction;
  const id = useId();
  const busy = useRef(false);
  const [selected, setSelected] = useState<IntegrationAction["kind"] | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  // Resolve against current host props so a revoked capability cannot survive a review.
  const action = actions.find((entry) => entry.kind === selected);
  const canSubmit = action?.availability === "available" && onAction !== undefined;

  function selectAction(next: IntegrationAction) {
    setSelected(next.kind);
    setFailed(false);
    setCompleted(false);
    setValues(
      next.kind === "configure"
        ? Object.fromEntries(next.fields.map((field) => [field.id, field.value]))
        : {},
    );
  }

  async function submit() {
    if (!action || !canSubmit || busy.current || !onAction) return;
    busy.current = true;
    setPending(true);
    setFailed(false);
    const request: IntegrationActionRequest = {
      kind: action.kind,
      providerId,
      ...(accountId === undefined ? {} : { accountId }),
      ...((action.kind === "disable" || action.kind === "disconnect") &&
      action.impact.reviewToken !== undefined
        ? { reviewToken: action.impact.reviewToken }
        : {}),
      ...(action.kind === "configure"
        ? {
            values: Object.fromEntries(
              action.fields.map((field) => [field.id, values[field.id] ?? field.value]),
            ),
          }
        : {}),
    };
    try {
      const result = await onAction(request);
      setSelected(null);
      setCompleted(result?.status !== "cancelled");
    } catch {
      // External exceptions may contain secrets. Keep failures safe and retryable.
      setFailed(true);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return (
    <div className="integrations-actions">
      <div className="integrations-actions__buttons">
        {actions.map((entry) => (
          <div key={entry.kind}>
            <Button
              size="sm"
              intent={entry.kind === "disconnect" ? "danger" : "secondary"}
              disabled={pending || entry.availability === "unavailable" || !onAction}
              aria-describedby={
                entry.availability === "unavailable" ? `${id}-${entry.kind}-reason` : undefined
              }
              aria-expanded={selected === entry.kind}
              onClick={() => selectAction(entry)}
            >
              {labels[entry.kind]}
            </Button>
            {entry.availability === "unavailable" ? (
              <p id={`${id}-${entry.kind}-reason`} className="integrations-muted">
                {entry.reason}
              </p>
            ) : null}
          </div>
        ))}
      </div>
      {action ? (
        <form
          className="integrations-action-review"
          aria-label={labels[action.kind]}
          aria-busy={pending}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <h4>{labels[action.kind]}</h4>
          {action.kind === "disable" || action.kind === "disconnect" ? (
            <>
              <p>
                {action.kind === "disable"
                  ? "This stops this app from using the account. The organization connection remains available."
                  : "This removes the organization connection and affects every app using it."}
              </p>
              <p>{action.impact.summary}</p>
              <p className="integrations-muted">Affected apps</p>
              {action.impact.affectedApps.length ? (
                <ul>
                  {action.impact.affectedApps.map((app) => (
                    <li key={app}>{app}</li>
                  ))}
                </ul>
              ) : (
                <p>No affected apps reported.</p>
              )}
            </>
          ) : action.kind === "configure" ? (
            <div className="integrations-configuration">
              {action.fields.map((field) => (
                <FieldFrame
                  key={field.id}
                  label={field.label}
                  htmlFor={`${id}-${field.id}`}
                  required={field.required}
                >
                  <Select
                    id={`${id}-${field.id}`}
                    value={values[field.id] ?? field.value}
                    required={field.required}
                    disabled={pending}
                    options={[...field.options]}
                    onValueChange={(value) =>
                      setValues((current) => ({ ...current, [field.id]: value }))
                    }
                  />
                </FieldFrame>
              ))}
            </div>
          ) : (
            <p>
              {action.kind === "activate"
                ? "Use this organization account in this app."
                : "Continue to the secure provider connection flow. This does not activate the account for an app."}
            </p>
          )}
          {!canSubmit ? (
            <p role="status">
              {action.availability === "unavailable"
                ? action.reason
                : "Management is currently unavailable."}
            </p>
          ) : null}
          {failed ? <p role="alert">This action could not be completed. Try again.</p> : null}
          <div className="integrations-actions__buttons">
            <Button
              type="submit"
              size="sm"
              intent={action.kind === "disconnect" ? "danger" : "primary"}
              disabled={pending || !canSubmit}
            >
              {pending
                ? "Working…"
                : failed
                  ? "Retry"
                  : action.kind === "disable" || action.kind === "disconnect"
                    ? `Confirm ${labels[action.kind].toLowerCase()}`
                    : "Continue"}
            </Button>
            <Button
              size="sm"
              intent="ghost"
              disabled={pending}
              onClick={() => {
                setSelected(null);
                setFailed(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      {completed ? <p role="status">Action completed.</p> : null}
    </div>
  );
}

export function IntegrationRefresh({
  onRefresh: refreshHandler,
}: {
  onRefresh?: IntegrationsSurfaceProps["onRefresh"];
}) {
  const handlers = useIntegrationActionHandlers();
  const onRefresh = refreshHandler ?? handlers.onRefresh;
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  async function refresh() {
    if (busy.current || !onRefresh) return;
    busy.current = true;
    setPending(true);
    setFailed(false);
    try {
      await onRefresh();
    } catch {
      setFailed(true);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  if (!onRefresh) return null;
  return (
    <div>
      <Button size="sm" disabled={pending} onClick={() => void refresh()}>
        {pending ? "Refreshing…" : failed ? "Retry refresh" : "Refresh integrations"}
      </Button>
      {failed ? <p role="alert">Refresh failed. Try again.</p> : null}
    </div>
  );
}
