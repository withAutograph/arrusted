import { useRef, useState, useTransition } from "react";

import { Button, FieldFrame, TextField } from "@autograph/components";

/** What starting a session came to: the new session, or why not. */
export type StartSessionResult =
  | { ok: true; value: { sessionId: string } }
  | { ok: false; error: { code: string; message: string } };

/** One New session gesture: its title, ids and the as-of date it starts at. */
export type StartSessionInput = {
  title: string;
  session_id: string;
  request_id: string;
  as_of: string;
};

/** The browser's own calendar date, `YYYY-MM-DD`. */
function localToday(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** A definite answer: the create committed, or the request itself is invalid. */
const definite = (result: StartSessionResult) =>
  result.ok || result.error.code === "contract_validation_failed";

/**
 * The first session of a canvas: a title, as of today at the submit. A
 * submit whose outcome is not definite keeps its ids and date, so retrying
 * the same title replays it instead of creating a second session, even
 * after midnight.
 */
export function NewSessionForm({
  create,
  onCreated,
  placeholder,
}: {
  /** Starts the session (the host's `createSession`). */
  create: (input: StartSessionInput) => Promise<StartSessionResult>;
  /** Opens the session once started. */
  onCreated: (sessionId: string) => void;
  /** An example title. */
  placeholder?: string;
}) {
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const retained = useRef<(Omit<StartSessionInput, "title"> & { key: string }) | null>(null);
  const submit = () =>
    startTransition(async () => {
      setError(null);
      // The host trims the title: " Plan " and "Plan" are one gesture.
      const key = JSON.stringify({ title: title.trim() });
      const ids =
        retained.current?.key === key
          ? retained.current
          : {
              key,
              session_id: crypto.randomUUID(),
              request_id: crypto.randomUUID(),
              as_of: localToday(),
            };
      retained.current = ids;
      try {
        const result = await create({
          title,
          session_id: ids.session_id,
          request_id: ids.request_id,
          as_of: ids.as_of,
        });
        // Only a success or an invalid request ends the gesture; any other
        // refusal (sign-in, a conflict, unavailable) may follow a committed
        // create, so a retry keeps the same inputs.
        if (definite(result)) retained.current = null;
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        onCreated(result.value.sessionId);
      } catch {
        setError("We couldn't confirm the new session. Submit again to retry it safely.");
      }
    });
  return (
    <form
      aria-labelledby="new-session-heading"
      className="flex flex-col gap-[var(--space-4)] rounded-[var(--radius-panel)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-[var(--space-5)]"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <h2
        id="new-session-heading"
        className="m-[var(--space-0)] text-[length:var(--text-section-title)] font-[var(--font-weight-semibold)] leading-[var(--leading-section-title)] text-[var(--color-text-primary)]"
      >
        New session
      </h2>
      <FieldFrame label="Title" htmlFor="session-title" required>
        <TextField
          id="session-title"
          value={title}
          onValueChange={setTitle}
          {...(placeholder === undefined ? {} : { placeholder })}
          maxLength={200}
          required
        />
      </FieldFrame>
      {error === null ? null : (
        <p
          role="alert"
          className="m-[var(--space-0)] text-[length:var(--text-body)] text-[var(--color-status-danger)]"
        >
          {error}
        </p>
      )}
      <div>
        <Button type="submit" loading={pending} disabled={title.trim() === ""}>
          Start session
        </Button>
      </div>
    </form>
  );
}

/** An organization the person may open the app in. */
export type OrganizationOption = { id: string; name: string };

/**
 * The person works in several organizations that open this app and none is
 * active: they choose one. `choose` makes it active and answers whether it
 * did; the page then reads again in it.
 */
export function OrganizationChooser({
  organizations,
  appName,
  choose,
}: {
  organizations: readonly OrganizationOption[];
  /** The app as people name it: "Open <appName> in:". */
  appName: string;
  choose: (organizationId: string) => Promise<boolean>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const pick = (organizationId: string) =>
    startTransition(async () => {
      setError(null);
      setChosen(organizationId);
      const opened = await choose(organizationId).catch(() => false);
      if (!opened) setError("The organization could not be opened. Try again.");
    });
  return (
    <section
      aria-labelledby="organization-chooser-heading"
      className="mx-auto flex max-w-[var(--size-modal-sm)] flex-col gap-[var(--space-4)] p-[var(--space-8)]"
    >
      <div className="flex flex-col gap-[var(--space-1)]">
        <h1
          id="organization-chooser-heading"
          className="m-[var(--space-0)] text-[length:var(--text-page-title)] font-[var(--font-weight-semibold)] leading-[var(--leading-page-title)] text-[var(--color-text-primary)]"
        >
          Choose an organization
        </h1>
        <p className="m-[var(--space-0)] text-[length:var(--text-body)] text-[var(--color-text-secondary)]">
          You work in more than one organization. Open {appName} in:
        </p>
      </div>
      <ul className="m-[var(--space-0)] flex list-none flex-col gap-[var(--space-2)] p-[var(--space-0)]">
        {organizations.map((organization) => (
          <li key={organization.id}>
            <Button
              className="w-full justify-start"
              disabled={pending}
              intent="secondary"
              loading={pending && chosen === organization.id}
              onClick={() => pick(organization.id)}
            >
              {organization.name}
            </Button>
          </li>
        ))}
      </ul>
      {error === null ? null : (
        <p
          role="alert"
          className="m-[var(--space-0)] text-[length:var(--text-body)] text-[var(--color-status-danger)]"
        >
          {error}
        </p>
      )}
    </section>
  );
}
