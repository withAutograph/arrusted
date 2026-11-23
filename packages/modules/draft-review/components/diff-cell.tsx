// DiffCell · renders `<s>before</s> → after` for one cell in a card table.
//
// Apps may override the per-cell rendering via the surface's
// `renderDiffCell` slot; the default below is the stock formatter that uses
// `formatFieldValue` + the app's `relationLabel` callback for relation cells.

import type { ReactNode } from "react";

import type { FieldDiff } from "@contracts";

import { formatFieldValue, type ColumnSpec, type RelationLabelLookup } from "../helpers/cards";

const DIFF_WRAP_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  fontVariantNumeric: "tabular-nums",
  // The `<s>before</s> → after` reads as one token; let the column
  // expand rather than breaking the diff across lines mid-arrow.
  whiteSpace: "nowrap",
};

const EMPTY_DIFF_STYLE: React.CSSProperties = {
  color: "var(--color-text-disabled)",
  fontStyle: "italic",
};

const BEFORE_STYLE: React.CSSProperties = {
  color: "var(--color-text-muted)",
};

const BEFORE_STRIKE_STYLE: React.CSSProperties = {
  textDecorationColor: "var(--color-text-disabled)",
};

const EMPTY_VALUE_STYLE: React.CSSProperties = {
  color: "var(--color-text-disabled)",
};

const ARROW_STYLE: React.CSSProperties = {
  color: "var(--color-text-disabled)",
};

const AFTER_STYLE: React.CSSProperties = {
  color: "var(--color-text-primary)",
  fontWeight: "var(--font-weight-medium)" as React.CSSProperties["fontWeight"],
};

export function DiffCell(props: {
  diff: FieldDiff | null;
  column: ColumnSpec;
  relationLabel: RelationLabelLookup;
}): ReactNode {
  if (!props.diff) {
    return <span style={EMPTY_DIFF_STYLE}>·</span>;
  }
  // Enum values use the label the kernel recorded for the change's own schema
  // revision, so a later rename does not rewrite what was approved.
  const before =
    props.diff.before_enum?.event_label ??
    formatFieldValue(
      props.diff.before ?? null,
      props.column.type,
      props.column.field_id,
      props.relationLabel,
      props.column.option_set,
    );
  const after =
    props.diff.after_enum?.event_label ??
    formatFieldValue(
      props.diff.after ?? null,
      props.column.type,
      props.column.field_id,
      props.relationLabel,
      props.column.option_set,
    );
  // P11 P5: distinguish "cleared" (after is null — the user removed the
  // value) from "intentionally empty" (after is a set FieldValue whose
  // formatted form is `""`, e.g. `{type:"text",value:""}` or
  // `{type:"text_list",value:[]}`). The legacy `after || "(cleared)"`
  // conflated the two — empty-text edits showed "(cleared)" which the
  // user reads as "the value was removed," not "the user typed empty
  // string." Render "(cleared)" only for the null branch; for empty-
  // set values, render the middle-dot glyph that matches the grid's
  // empty-cell convention (same · used in the `before` branch above).
  const afterIsCleared = props.diff.after == null;
  return (
    <span style={DIFF_WRAP_STYLE}>
      {before ? (
        <span style={BEFORE_STYLE}>
          <s style={BEFORE_STRIKE_STYLE}>{before}</s>
        </span>
      ) : (
        <span style={EMPTY_VALUE_STYLE}>·</span>
      )}
      <span style={ARROW_STYLE}>→</span>
      <span style={AFTER_STYLE}>
        {after !== ""
          ? after
          : afterIsCleared
            ? "(cleared)"
            : // Intentional empty — match the grid's empty-cell glyph
              // so the user reads "field still set, just empty" the same
              // way they would in the grid.
              "·"}
      </span>
    </span>
  );
}
