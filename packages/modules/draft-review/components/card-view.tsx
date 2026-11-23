// CardView — header + table for one ApprovalCard. The kind switch governs
// the header (batch actions for named-bulk, no actions for type-group) and
// the row strip (no actions for named-bulk, per-row Discard / Publish for
// type-group).
//
// The "primary" cell (leftmost column showing the record identity, e.g.
// HR's avatar + position title) is rendered via an injected
// `renderPrimaryCell(rowKey)` slot — module doesn't know what the primary
// model's display shape is.

import { useState, type ReactNode } from "react";

import { Button, ConfirmButton, Modal, TextArea } from "@autograph/components";
import type { FieldDiff } from "@contracts";

import {
  formatEffectiveDate,
  type ApprovalCard,
  type CardStatus,
  type CardRow,
  type ColumnSpec,
  type RelationLabelLookup,
} from "../helpers/cards";
import { DiffCell } from "./diff-cell";

const CARD_STYLE: React.CSSProperties = {
  background: "var(--color-bg-surface)",
  border: "1px solid var(--color-border-subtle)",
  borderRadius: "var(--radius-panel)",
  overflow: "hidden",
};

const HEADER_STYLE: React.CSSProperties = {
  padding: "var(--space-3) var(--space-4)",
  background: "var(--color-bg-subtle)",
  borderBottom: "1px solid var(--color-border-subtle)",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-3)",
  flexWrap: "wrap",
};

const TITLE_BLOCK_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: "var(--space-3)",
  flexWrap: "wrap",
};

const TITLE_STYLE: React.CSSProperties = {
  fontSize: "var(--text-title)",
  fontWeight: "var(--font-weight-semibold)" as React.CSSProperties["fontWeight"],
  color: "var(--color-text-primary)",
};

const META_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  fontSize: "var(--text-caption)",
  color: "var(--color-text-muted)",
};

const META_PILL_STYLE: React.CSSProperties = {
  padding: "var(--space-0-5) var(--space-2)",
  background: "var(--color-bg-subtle)",
  border: "1px solid var(--color-border-subtle)",
  borderRadius: "var(--radius-pill)",
  color: "var(--color-text-secondary)",
  fontWeight: "var(--font-weight-medium)" as React.CSSProperties["fontWeight"],
};

const TABLE_STYLE: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "var(--text-body)",
  // Primary column has a min width but no fixed share — wider tables
  // need every column to flex rather than the actions getting clipped.
  tableLayout: "auto",
};

const TH_STYLE: React.CSSProperties = {
  background: "var(--color-bg-surface)",
  padding: "var(--space-2) var(--space-4)",
  textAlign: "left",
  fontSize: "var(--text-micro)",
  color: "var(--color-text-muted)",
  fontWeight: "var(--font-weight-semibold)" as React.CSSProperties["fontWeight"],
  textTransform: "uppercase",
  letterSpacing: "var(--tracking-label)",
  borderBottom: "1px solid var(--color-border-subtle)",
  whiteSpace: "nowrap",
};

const TH_RIGHT_STYLE: React.CSSProperties = { ...TH_STYLE, textAlign: "right" };

const TD_STYLE: React.CSSProperties = {
  padding: "var(--space-3) var(--space-4)",
  borderBottom: "1px solid var(--color-border-subtle)",
  verticalAlign: "middle",
};

const EFFECTIVE_DATE_STYLE: React.CSSProperties = {
  color: "var(--color-text-secondary)",
  fontVariantNumeric: "tabular-nums",
  whiteSpace: "nowrap",
};

export type RenderPrimaryCell = (row: CardRow) => ReactNode;

export type RenderDiffCell = (field: ColumnSpec, diff: FieldDiff | null) => ReactNode;

// App content under a card's table (e.g. the draft's comment threads).
export type RenderCardFooter = (card: ApprovalCard) => ReactNode;

// A draft author's display name from their actor id, or null when unknown.
export type AuthorLabel = (actorId: string) => string | null | undefined;

const NOTE_STYLE: React.CSSProperties = {
  padding: "var(--space-2) var(--space-4)",
  borderBottom: "1px solid var(--color-border-subtle)",
  fontSize: "var(--text-body)",
  color: "var(--color-text-secondary)",
  lineHeight: "var(--leading-prose)",
};

const savedAtFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function CardView(props: {
  card: ApprovalCard;
  renderPrimaryCell: RenderPrimaryCell;
  renderDiffCell?: RenderDiffCell;
  // Header copy for the leftmost column. Module default is "Record"; apps
  // pass their primary-model's display word (e.g. "Position", "Discount").
  primaryColumnHeader?: string;
  relationLabel: RelationLabelLookup;
  // Return type intentionally `unknown`: the action handlers from
  // `useDraftReview` now resolve to `Promise<boolean>` (true on
  // action-succeeded), but the ConfirmButton callsites discard the
  // return. Widening to `unknown` lets either signature flow through
  // without forcing the cards to know the controller contract.
  onDiscard: (change_set_id: number, note?: string) => unknown;
  onPublish: (change_set_id: number) => unknown;
  onRevert: (change_set_id: number) => unknown;
  renderFooter?: RenderCardFooter;
  authorLabel?: AuthorLabel;
  // Discard opens a dialog with an optional note instead of a second click.
  discardNote?: boolean;
  // No Publish, Discard or Revert: the viewer reads but does not act.
  readOnly?: boolean;
}): ReactNode {
  const { card } = props;
  const isPublished = card.status === "published";
  const ctLabelOnHeader =
    card.kind === "named" && card.change_type_label ? card.change_type_label : null;
  const [discarding, setDiscarding] = useState(false);
  const author =
    card.kind === "named" && card.author_id ? (props.authorLabel?.(card.author_id) ?? null) : null;
  const savedAt =
    card.kind === "named" && card.created_at !== undefined
      ? savedAtFormat.format(new Date(card.created_at))
      : null;
  const note = card.kind === "named" ? (card.note ?? null) : null;
  // A per-draft card names its author in the title and its models in the meta
  // line; a published one is a change, no longer a draft.
  const title = author ? `${isPublished ? "Change" : "Draft"} by ${author}` : card.title;
  const subject = author ? card.title : null;
  const footer = props.renderFooter?.(card) ?? null;

  return (
    <div data-card={card.kind} data-card-status={card.status} style={CARD_STYLE}>
      <div style={HEADER_STYLE}>
        <div style={TITLE_BLOCK_STYLE}>
          <span style={TITLE_STYLE}>{title}</span>
          <div style={META_STYLE}>
            {subject ? (
              <>
                <span>{subject}</span>
                <span>·</span>
              </>
            ) : null}
            {ctLabelOnHeader ? (
              <>
                <span style={META_PILL_STYLE}>{ctLabelOnHeader}</span>
                <span>·</span>
              </>
            ) : null}
            <span>{recordsCountLabel(card)}</span>
            {savedAt ? (
              <>
                <span>·</span>
                <span>{savedAt}</span>
              </>
            ) : null}
            {card.kind === "named" ? (
              <>
                <span>·</span>
                <StatusPillToken status={card.status} />
              </>
            ) : null}
          </div>
        </div>
        {card.kind === "named" ? (
          // Destructive header actions go through ConfirmButton so a
          // stray click can't fire Discard / Publish / Revert without
          // a deliberate second confirm — `cross.popover-dismissal`
          // applies to destructive affordances per the parity rubric.
          // Auto-reverts after 5s of no follow-up click.
          card.status === "rejected" || props.readOnly ? null : (
            <div className="flex gap-[var(--space-2)]">
              {isPublished ? (
                <ConfirmButton
                  intent="secondary"
                  size="sm"
                  idleLabel="Revert"
                  confirmLabel="Confirm revert?"
                  onConfirm={() => props.onRevert(card.change_set_id)}
                />
              ) : (
                <>
                  {props.discardNote ? (
                    <Button intent="danger" size="sm" onClick={() => setDiscarding(true)}>
                      Discard
                    </Button>
                  ) : (
                    <ConfirmButton
                      intent="danger"
                      size="sm"
                      idleLabel="Discard"
                      confirmLabel="Confirm discard?"
                      onConfirm={() => props.onDiscard(card.change_set_id)}
                    />
                  )}
                  <ConfirmButton
                    intent="primary"
                    size="sm"
                    idleLabel="Publish"
                    confirmLabel="Confirm publish?"
                    onConfirm={() => props.onPublish(card.change_set_id)}
                  />
                </>
              )}
            </div>
          )
        ) : null}
      </div>
      {note ? (
        <p data-card-note style={{ ...NOTE_STYLE, margin: 0 }}>
          <span style={{ color: "var(--color-text-muted)" }}>
            {card.status === "rejected" ? "Rejection note: " : "Note: "}
          </span>
          {note}
        </p>
      ) : null}
      <CardTable
        card={card}
        renderPrimaryCell={props.renderPrimaryCell}
        renderDiffCell={props.renderDiffCell}
        primaryColumnHeader={props.primaryColumnHeader}
        relationLabel={props.relationLabel}
        onDiscard={props.onDiscard}
        onPublish={props.onPublish}
        onRevert={props.onRevert}
        readOnly={props.readOnly}
      />
      {footer === null ? null : (
        // Hidden when the app's footer renders nothing.
        <div
          data-card-footer
          className="border-t border-[var(--color-border-subtle)] px-[var(--space-4)] py-[var(--space-3)] empty:hidden"
        >
          {footer}
        </div>
      )}
      {card.kind === "named" && props.discardNote && !props.readOnly ? (
        <DiscardDialog
          open={discarding}
          onClose={() => setDiscarding(false)}
          onDiscard={async (text) => {
            // The controller resolves false when the note or the discard
            // failed (it has said why): the dialog stays open with the note.
            const done = await props.onDiscard(card.change_set_id, text);
            if (done === false) return false;
            setDiscarding(false);
            return true;
          }}
        />
      ) : null}
    </div>
  );
}

// Confirms a Discard and takes an optional note for the draft's author. The
// note clears only once the discard succeeds; a failure keeps the dialog,
// the note and an error in view so the approver can retry.
function DiscardDialog(props: {
  open: boolean;
  onClose: () => void;
  /** Resolves true once discarded; false (or a throw) keeps the draft. */
  onDiscard: (note: string) => Promise<boolean>;
}): ReactNode {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const close = () => {
    setFailed(false);
    props.onClose();
  };
  return (
    <Modal
      open={props.open}
      size="sm"
      title="Discard this draft?"
      onClose={close}
      actions={
        <div className="flex justify-end gap-[var(--space-2)]">
          <Button intent="secondary" size="sm" onClick={close}>
            Cancel
          </Button>
          <Button
            intent="danger"
            size="sm"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setFailed(false);
              let done = false;
              try {
                done = await props.onDiscard(note);
              } catch {
                done = false;
              } finally {
                setBusy(false);
              }
              if (done) setNote("");
              else setFailed(true);
            }}
          >
            Discard draft
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-[var(--space-2)]">
        <p className="m-[var(--space-0)] text-[length:var(--text-body)] leading-[var(--leading-prose)] text-[var(--color-text-secondary)]">
          Its changes are not published. It stays on the Rejected tab.
        </p>
        <label className="flex flex-col gap-[var(--space-1)] text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
          Note for the author (optional)
          <TextArea rows={3} value={note} onValueChange={setNote} />
        </label>
        {failed ? (
          <p
            role="alert"
            className="m-[var(--space-0)] text-[length:var(--text-caption)] text-[var(--color-status-danger)]"
          >
            The draft was not discarded. Your note is kept; try again.
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

function recordsCountLabel(card: ApprovalCard): string {
  if (card.kind === "named") {
    return `${card.rows.length} record${card.rows.length === 1 ? "" : "s"}`;
  }
  // Type-group: also disclose the count of distinct change_sets so the
  // user knows the card is an aggregation. "1 record" doesn't need that
  // disclosure.
  if (card.changeSetCount === 1) {
    return `${card.rows.length} record${card.rows.length === 1 ? "" : "s"}`;
  }
  return `${card.rows.length} records · ${card.changeSetCount} separate drafts`;
}

// Status pill — token-only.
const STATUS_TOKENS: Record<CardStatus, { label: string; bg: string; ink: string }> = {
  draft: {
    label: "Draft",
    bg: "var(--color-status-warning-bg)",
    ink: "var(--color-status-warning)",
  },
  published: {
    label: "Published",
    bg: "var(--color-status-success-bg)",
    ink: "var(--color-status-success)",
  },
  rejected: {
    label: "Rejected",
    bg: "var(--color-status-danger-bg)",
    ink: "var(--color-status-danger)",
  },
};

function StatusPillToken(props: { status: CardStatus }): ReactNode {
  const tokens = STATUS_TOKENS[props.status];
  const style: React.CSSProperties = {
    padding: "var(--space-0-5) var(--space-2)",
    borderRadius: "var(--radius-pill)",
    background: tokens.bg,
    color: tokens.ink,
    fontWeight: "var(--font-weight-medium)" as React.CSSProperties["fontWeight"],
    fontSize: "var(--text-micro)",
    textTransform: "uppercase",
    letterSpacing: "var(--tracking-label)",
  };
  return <span style={style}>{tokens.label}</span>;
}

// ---------------------------------------------------------------------------
// Card table — Primary | Effective | <one column per change_type touch> | Actions?
// ---------------------------------------------------------------------------
function CardTable(props: {
  card: ApprovalCard;
  renderPrimaryCell: RenderPrimaryCell;
  renderDiffCell?: RenderDiffCell;
  primaryColumnHeader?: string;
  relationLabel: RelationLabelLookup;
  // See `CardView` props comment: action handlers may return anything;
  // ConfirmButton callsites discard the return.
  onDiscard: (change_set_id: number, note?: string) => unknown;
  onPublish: (change_set_id: number) => unknown;
  onRevert: (change_set_id: number) => unknown;
  readOnly?: boolean;
}): ReactNode {
  const { card } = props;
  // Per-row actions ride on type-group cards; named-bulk cards have no row
  // actions (the per-row "drop" mock action has no kernel API).
  const showRowActions =
    card.kind === "unnamed-by-type" && card.status !== "rejected" && !props.readOnly;

  return (
    // Wrap so wide tables scroll horizontally inside the card chrome
    // rather than overflowing the shell viewport and clipping Actions.
    <div style={{ overflowX: "auto" }}>
      <table style={TABLE_STYLE}>
        <thead>
          <tr>
            <th style={{ ...TH_STYLE, minWidth: 220 }}>{props.primaryColumnHeader ?? "Record"}</th>
            <th style={TH_STYLE}>Effective</th>
            {card.columns.map((col) => (
              <th key={col.field_id} style={TH_STYLE}>
                {col.label}
              </th>
            ))}
            {showRowActions ? <th style={{ ...TH_RIGHT_STYLE, width: 160 }}>Actions</th> : null}
          </tr>
        </thead>
        <tbody>
          {card.rows.map((row, idx) => {
            const isLast = idx === card.rows.length - 1;
            const cellStyle: React.CSSProperties = isLast
              ? { ...TD_STYLE, borderBottom: "none" }
              : TD_STYLE;
            return (
              <tr key={`${row.change_set_id}-${row.record_id}`}>
                <td style={cellStyle}>{props.renderPrimaryCell(row)}</td>
                <td style={cellStyle}>
                  <span style={EFFECTIVE_DATE_STYLE}>
                    {formatEffectiveDate(row.effective_start)}
                  </span>
                </td>
                {card.columns.map((col) => (
                  <td key={col.field_id} style={cellStyle}>
                    {renderCell(col, row.diffByField.get(col.field_id) ?? null, props)}
                    {row.ruleNotes?.has(col.field_id) ? (
                      <div
                        data-rule-note
                        className="mt-[var(--space-1)] text-[length:var(--text-caption)] text-[var(--color-text-muted)]"
                      >
                        By rule: {row.ruleNotes.get(col.field_id)}
                      </div>
                    ) : null}
                  </td>
                ))}
                {showRowActions ? (
                  <td style={cellStyle}>
                    <div className="flex justify-end gap-[var(--space-1)]">
                      {card.status === "published" ? (
                        <ConfirmButton
                          intent="secondary"
                          size="xs"
                          idleLabel="Revert"
                          confirmLabel="Confirm revert?"
                          onConfirm={() => props.onRevert(row.change_set_id)}
                        />
                      ) : (
                        <>
                          <ConfirmButton
                            intent="ghost"
                            size="xs"
                            idleLabel="Discard"
                            confirmLabel="Confirm discard?"
                            onConfirm={() => props.onDiscard(row.change_set_id)}
                          />
                          <ConfirmButton
                            intent="primary"
                            size="xs"
                            idleLabel="Publish"
                            confirmLabel="Confirm publish?"
                            onConfirm={() => props.onPublish(row.change_set_id)}
                          />
                        </>
                      )}
                    </div>
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function renderCell(
  column: ColumnSpec,
  diff: FieldDiff | null,
  props: {
    renderDiffCell?: RenderDiffCell;
    relationLabel: RelationLabelLookup;
  },
): ReactNode {
  if (props.renderDiffCell) {
    return props.renderDiffCell(column, diff);
  }
  return <DiffCell diff={diff} column={column} relationLabel={props.relationLabel} />;
}
