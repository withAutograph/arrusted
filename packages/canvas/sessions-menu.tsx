import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  BodyPortalPopover,
  Button,
  Tag,
  TextField,
  cx,
  focusRing,
  useToast,
} from "@autograph/components";
import { ChevronDown, Plus, Search } from "@autograph/icons";
import type { WorkSessionRequest } from "@autograph/generated-app-runtime/data";

import {
  failureMessage,
  type CanvasClient,
  type CanvasSessionHeader,
  type CanvasSessions,
} from "./client";

const dateFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
const formatDate = (iso: string) => dateFormat.format(new Date(`${iso.slice(0, 10)}T00:00:00Z`));

/** Pinned first, then the most recently updated. */
const ordered = (list: readonly CanvasSessionHeader[]) =>
  list.toSorted(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
  );

/** What a row is doing: renaming in place, or asking before it archives. */
type RowMode = { id: string; kind: "actions" | "rename" | "archive" };

/**
 * The session title as a menu: search the viewer's sessions, open one, start
 * a New session, and rename, pin, duplicate or archive any of them. Each
 * change goes through `session.request` at the revision the list showed,
 * with a fresh request id per gesture; the list re-reads after it.
 */
export function SessionsMenu({
  client,
  sessions,
  current,
}: {
  client: CanvasClient;
  sessions: CanvasSessions;
  current: { id: string; title: string };
}) {
  const toast = useToast();
  const anchor = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<CanvasSessionHeader[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [row, setRow] = useState<RowMode | null>(null);
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      setList(ordered(await sessions.list()));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [sessions]);
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setRow(null);
    setCreating(null);
    void reload();
  }, [open, reload]);

  /**
   * One gesture on a listed session: a rename is a last-write-wins edit; pin
   * and archive go at the revision the list showed.
   */
  const act = async (
    header: CanvasSessionHeader,
    input: Record<string, unknown>,
    success: string,
  ) => {
    setBusy(true);
    try {
      const request = { ...input, session_id: header.id } as WorkSessionRequest;
      await client.session.request(
        request.operation === "update"
          ? request
          : ({
              ...request,
              expected_revision: header.revision,
              request_id: crypto.randomUUID(),
            } as WorkSessionRequest),
      );
      toast.success(success);
      setRow(null);
      return true;
    } catch (error) {
      toast.warning(failureMessage(error, "That did not work. Try again."));
      return false;
    } finally {
      setBusy(false);
      await reload();
    }
  };
  const duplicate = async (header: CanvasSessionHeader) => {
    setBusy(true);
    try {
      const sessionId = crypto.randomUUID();
      await client.session.request({
        operation: "duplicate",
        expected_revision: 0,
        request_id: crypto.randomUUID(),
        session_id: sessionId,
        source_session_id: header.id,
        title: `${header.title} (copy)`,
      });
      setOpen(false);
      sessions.open(sessionId);
    } catch (error) {
      toast.warning(failureMessage(error, "The session was not duplicated. Try again."));
    } finally {
      setBusy(false);
    }
  };
  const create = async (event: FormEvent) => {
    event.preventDefault();
    const title = (creating ?? "").trim();
    if (title === "") return;
    setBusy(true);
    try {
      const { sessionId } = await sessions.create(title);
      setOpen(false);
      sessions.open(sessionId);
    } catch (error) {
      toast.warning(failureMessage(error, "The session was not created. Try again."));
    } finally {
      setBusy(false);
    }
  };

  const needle = query.trim().toLowerCase();
  const shown = (list ?? []).filter((item) => item.title.toLowerCase().includes(needle));
  return (
    <>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        className={cx(
          "-mx-[var(--space-1-5)] inline-flex min-w-[var(--space-0)] items-center gap-[var(--space-1)] rounded-[var(--radius-control)] px-[var(--space-1-5)] py-[var(--space-0-5)] text-left hover:bg-[var(--color-bg-hover)]",
          focusRing,
        )}
        data-sessions-menu
        ref={anchor}
        title="Sessions"
        type="button"
        onClick={() => setOpen((value) => !value)}
      >
        <h1 className="m-[var(--space-0)] truncate text-[length:var(--text-section-title)] font-[var(--font-weight-semibold)] text-[var(--color-text-primary)]">
          {current.title}
        </h1>
        <ChevronDown
          aria-hidden
          className="size-[var(--size-icon-sm)] shrink-0 text-[var(--color-text-muted)]"
        />
      </button>
      <BodyPortalPopover
        align="start"
        anchorRef={anchor}
        ariaLabel="Sessions"
        open={open}
        onClose={() => setOpen(false)}
      >
        <div
          className="flex max-h-[min(36rem,calc(100vh-var(--space-8)*3))] w-[min(calc(var(--size-agent-panel-width)+var(--space-8)),calc(100vw-var(--space-4)))] flex-col"
          data-pane="sessions"
        >
          <div className="border-b border-[var(--color-border-subtle)] p-[var(--space-3)]">
            <TextField
              aria-label="Search sessions"
              autoFocus
              placeholder="Search sessions"
              size="sm"
              trailing={
                <Search
                  aria-hidden
                  className="size-[var(--size-icon-sm)] text-[var(--color-text-muted)]"
                />
              }
              value={query}
              onValueChange={setQuery}
            />
          </div>
          <div className="min-h-[var(--space-0)] flex-1 overflow-y-auto p-[var(--space-1)]">
            {list === null ? (
              <p className="m-[var(--space-0)] p-[var(--space-3)] text-[length:var(--text-control-sm)] text-[var(--color-text-muted)]">
                {failed ? "Your sessions could not be loaded." : "Loading sessions…"}
              </p>
            ) : shown.length === 0 ? (
              <p className="m-[var(--space-0)] p-[var(--space-3)] text-[length:var(--text-control-sm)] text-[var(--color-text-muted)]">
                {needle === "" ? "No other sessions yet." : "No session matches."}
              </p>
            ) : (
              <ul
                aria-label="Your sessions"
                className="m-[var(--space-0)] flex list-none flex-col p-[var(--space-0)]"
              >
                {shown.map((item) => {
                  const mode = row?.id === item.id ? row.kind : null;
                  const isCurrent = item.id === current.id;
                  return (
                    <li
                      className={cx(
                        "rounded-[var(--radius-control)]",
                        mode !== null && "bg-[var(--color-bg-hover)]",
                      )}
                      data-session-row={item.id}
                      key={item.id}
                    >
                      {mode === "rename" ? (
                        <form
                          className="flex items-center gap-[var(--space-2)] px-[var(--space-2)] py-[var(--space-1-5)]"
                          onSubmit={(event) => {
                            event.preventDefault();
                            const title = draft.trim();
                            if (title === "" || title === item.title) return setRow(null);
                            void act(
                              item,
                              { operation: "update", patch: { title } },
                              "Renamed the session",
                            );
                          }}
                        >
                          <TextField
                            aria-label="Session title"
                            autoFocus
                            className="flex-1"
                            size="sm"
                            value={draft}
                            onValueChange={setDraft}
                          />
                          <Button disabled={busy} intent="primary" size="xs" type="submit">
                            Rename
                          </Button>
                          <Button
                            intent="ghost"
                            size="xs"
                            type="button"
                            onClick={() => setRow(null)}
                          >
                            Cancel
                          </Button>
                        </form>
                      ) : (
                        <div className="flex items-center gap-[var(--space-1)]">
                          <button
                            className={cx(
                              "flex min-w-[var(--space-0)] flex-1 flex-col gap-[var(--space-0-5)] rounded-[var(--radius-control)] px-[var(--space-3)] py-[var(--space-2)] text-left hover:bg-[var(--color-bg-hover)]",
                              focusRing,
                            )}
                            type="button"
                            onClick={() => {
                              setOpen(false);
                              if (!isCurrent) sessions.open(item.id);
                            }}
                          >
                            <span className="flex min-w-[var(--space-0)] items-center gap-[var(--space-2)]">
                              <span className="truncate text-[length:var(--text-control-sm)] font-[var(--font-weight-medium)] text-[var(--color-text-primary)]">
                                {item.title}
                              </span>
                              {item.pinned ? <Tag label="Pinned" tone="gray" /> : null}
                              {isCurrent ? <Tag label="Open" tone="blue" /> : null}
                            </span>
                            <span className="text-[length:var(--text-caption)] text-[var(--color-text-secondary)]">
                              As of {formatDate(item.asOf)}
                            </span>
                          </button>
                          <Button
                            aria-expanded={mode !== null}
                            aria-label={`Actions for ${item.title}`}
                            className="mr-[var(--space-1)] shrink-0"
                            intent="ghost"
                            size="xs"
                            onClick={() =>
                              setRow(mode === null ? { id: item.id, kind: "actions" } : null)
                            }
                          >
                            <ChevronDown aria-hidden className="size-[var(--size-icon-sm)]" />
                          </Button>
                        </div>
                      )}
                      {mode === "actions" ? (
                        <div className="flex flex-wrap gap-[var(--space-1)] px-[var(--space-2)] pb-[var(--space-2)]">
                          <Button
                            intent="secondary"
                            size="xs"
                            onClick={() => {
                              setDraft(item.title);
                              setRow({ id: item.id, kind: "rename" });
                            }}
                          >
                            Rename
                          </Button>
                          <Button
                            disabled={busy}
                            intent="secondary"
                            size="xs"
                            onClick={() =>
                              void act(
                                item,
                                { operation: "pin", pinned: !item.pinned },
                                item.pinned ? "Unpinned the session" : "Pinned the session",
                              )
                            }
                          >
                            {item.pinned ? "Unpin" : "Pin"}
                          </Button>
                          <Button
                            disabled={busy}
                            intent="secondary"
                            size="xs"
                            onClick={() => void duplicate(item)}
                          >
                            Duplicate
                          </Button>
                          <Button
                            intent="secondary"
                            size="xs"
                            onClick={() => setRow({ id: item.id, kind: "archive" })}
                          >
                            Archive
                          </Button>
                        </div>
                      ) : null}
                      {mode === "archive" ? (
                        <div className="flex flex-wrap items-center gap-[var(--space-2)] px-[var(--space-3)] pb-[var(--space-2)] text-[length:var(--text-caption)] text-[var(--color-text-secondary)]">
                          <span className="flex-1">
                            Archive “{item.title}”? It leaves this list; its unsaved changes are not
                            saved.
                          </span>
                          <Button
                            disabled={busy}
                            intent="danger"
                            size="xs"
                            onClick={() =>
                              void act(item, { operation: "archive" }, "Archived the session").then(
                                (done) => {
                                  // The open session went: home opens the latest
                                  // other session, or offers a new one.
                                  if (!done || !isCurrent) return;
                                  setOpen(false);
                                  sessions.home();
                                },
                              )
                            }
                          >
                            Archive
                          </Button>
                          <Button intent="ghost" size="xs" onClick={() => setRow(null)}>
                            Cancel
                          </Button>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <div className="border-t border-[var(--color-border-subtle)] p-[var(--space-2)]">
            {creating === null ? (
              <Button
                className="w-full justify-start"
                intent="ghost"
                leading={<Plus aria-hidden className="size-[var(--size-icon-sm)]" />}
                size="sm"
                onClick={() => setCreating("")}
              >
                New session
              </Button>
            ) : (
              <form
                className="flex items-center gap-[var(--space-2)] p-[var(--space-1)]"
                onSubmit={(event) => void create(event)}
              >
                <TextField
                  aria-label="New session title"
                  autoFocus
                  className="flex-1"
                  placeholder="Title"
                  size="sm"
                  value={creating}
                  onValueChange={setCreating}
                />
                <Button
                  disabled={busy || creating.trim() === ""}
                  intent="primary"
                  size="xs"
                  type="submit"
                >
                  Create
                </Button>
                <Button
                  intent="ghost"
                  size="xs"
                  type="button"
                  onClick={() => {
                    sessions.cancelCreate();
                    setCreating(null);
                  }}
                >
                  Cancel
                </Button>
              </form>
            )}
          </div>
        </div>
      </BodyPortalPopover>
    </>
  );
}
