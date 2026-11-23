import { useRef, useState, type ReactNode } from "react";
import type { WorkChange } from "@autograph/generated-app-runtime/data";
import { BodyPortalPopover } from "@autograph/components";
import { formatTime } from "./review-labels";
import type { CanvasSession } from "./use-canvas-session";

/** The parts of a session provenance reads: rules, threads and turns. */
export type ProvenanceSource = Pick<CanvasSession, "rules" | "threads" | "groups">;

const quote = (text: string, max = 80) =>
  `“${text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text}”`;

/** The rule note an entry was staged with, as people read it: "By rule: …". */
export const ruleNote = (entry: WorkChange) =>
  entry.note !== undefined && entry.note.trim() !== "" ? `By rule: ${entry.note}` : null;

/** Whether the agent's entry replaced a value the user had staged (Restore yours). */
export const replacedYours = (entry: WorkChange) =>
  entry.author_kind === "agent" && entry.replaced?.author_kind === "human";

/**
 * Who staged an entry, when, and through which rule, agent turn or thread,
 * as label/value lines. Session-level only: everything comes from the entry
 * and the session's rules, threads and turns.
 */
export function provenanceLines(
  entry: WorkChange,
  source: ProvenanceSource,
): { label: string; value: string }[] {
  const lines = [
    {
      label: "Changed by",
      value:
        entry.author_kind !== "agent"
          ? "You"
          : entry.turn_id === undefined && entry.thread_id !== undefined
            ? "The agent, pulled by you"
            : "The agent",
    },
    { label: "When", value: formatTime(entry.updated_at) },
  ];
  if (entry.note !== undefined && entry.note.trim() !== "")
    lines.push({ label: "By rule", value: entry.note });
  if (entry.rule_id !== undefined) {
    const rule = source.rules.find((item) => item.id === entry.rule_id);
    lines.push({
      label: "Rule",
      value: rule?.description?.trim() ? rule.description : "A rule (removed)",
    });
  }
  if (entry.turn_id !== undefined) {
    const turns = source.groups.filter((group) => group.turn_id !== null);
    const index = turns.findIndex((group) => group.turn_id === entry.turn_id);
    lines.push({
      label: "Turn",
      value: index === -1 ? "An agent turn" : `Agent turn ${index + 1}`,
    });
  }
  if (entry.thread_id !== undefined) {
    const thread = source.threads.find((item) => item.id === entry.thread_id);
    const first = thread?.messages[0]?.message.trim();
    lines.push({ label: "Thread", value: first ? quote(first) : "A thread" });
  }
  return lines;
}

/**
 * A staged value with its provenance on hover or focus: who staged it, when,
 * and its rule, turn or thread. Wrap the value as rendered (a log line or a
 * grid cell); the card opens beside it and escapes any scrolling parent.
 */
export function Provenance(props: {
  entry: WorkChange;
  source: ProvenanceSource;
  children: ReactNode;
}) {
  const { entry, source, children } = props;
  const anchor = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <span
      ref={anchor}
      className="inline-flex min-w-[var(--space-0)] rounded-[var(--radius-xs)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-action-primary)]/30"
      data-provenance
      tabIndex={0}
      onBlur={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      {children}
      <BodyPortalPopover
        align="start"
        anchorRef={anchor}
        ariaLabel="Where this value came from"
        open={open}
        onClose={() => setOpen(false)}
      >
        <dl className="m-[var(--space-0)] grid max-w-[var(--size-editor-popover-sm)] grid-cols-[auto_1fr] gap-x-[var(--space-3)] gap-y-[var(--space-1)] px-[var(--space-3)] py-[var(--space-2-5)] text-[length:var(--text-caption)] leading-[var(--leading-caption)]">
          {provenanceLines(entry, source).map((line) => (
            <div className="contents" key={line.label}>
              <dt className="text-[var(--color-text-muted)]">{line.label}</dt>
              <dd className="m-[var(--space-0)] text-[var(--color-text-primary)]">{line.value}</dd>
            </div>
          ))}
        </dl>
      </BodyPortalPopover>
    </span>
  );
}
