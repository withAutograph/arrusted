// PreviewSaveBar - bottom action bar for the Preview & save column.
//
// Renders aggregate counts across all model tabs plus the primary Save
// action. Save is gated until every preview row passes validation; there is no
// partial save. When blocked, the button stays disabled and the blocking reason
// is rendered next to it through `aria-describedby` so the explanatory text is
// announced together with the disabled state.
//
// Boundary: this composite knows the substrate `SaveBlockingReason`
// enum and the copy that maps each variant to a sentence. Apps pick the
// reason; this composite owns the rendering but not draft/mainline policy.

import { useId, type ReactNode } from "react";

import { Button, StatusPill, type StatusPillTone } from "@autograph/components";

import type { SaveBlockingReason } from "../types";

import "./preview-save.css";

export type PreviewSaveBarProps = {
  readyRowCount: number;
  needsReviewRowCount: number;
  parseErrorRowCount: number;
  // Re-import rows that matched an existing record with identical values
  // and compiled to no-ops. Rendered as a neutral chip when > 0 so dropped
  // rows are visible-not-silent; omitted/0 hides the chip.
  unchangedRowCount?: number;
  // Why Save is currently disabled. When undefined and `saving` is
  // false, Save is enabled. Multiple upstream reasons may apply at
  // once; the host picks the highest-priority one to render here.
  blockingReason?: SaveBlockingReason;
  saveLabel?: string;
  savingLabel?: string;
  onSave: () => void | Promise<void>;
  saving: boolean;
  // Optional. Hidden when undefined - apps that don't expose a discard
  // affordance shouldn't have a placeholder slot.
  onDiscardAll?: () => void;
  // Surfaces the combined error envelope from the last save attempt
  // when one or more partitions landed with status `failed` or
  // `blocked`. Rendered as an alert beneath the Save action. Cleared
  // on the next successful save by the host.
  saveErrorMessage?: string;
  // Informational write date. Shown only on this stage; not a control.
  // Omit to hide it.
  asOf?: string;
  className?: string;
};

function classNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

// Same "MMM D, YYYY" rule as the editable-grid meta row: parse the ISO
// calendar day directly so render does not rebuild Intl or depend on
// locale/timezone.
function formatImportAsOf(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(iso);
  if (!match) return iso;
  const year = match[1];
  const monthNum = Number(match[2]);
  const day = Number(match[3]);
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const monthLabel = months[monthNum - 1];
  if (!monthLabel) return iso;
  return `${monthLabel} ${day}, ${year}`;
}

function reasonCopy(
  reason: SaveBlockingReason,
  needsReviewRowCount: number,
  parseErrorRowCount: number,
): string {
  // Interpolation only for the row-count variants.
  switch (reason) {
    case "questions_pending":
      return "Finish answering the agent's questions in Clean up data.";
    case "stage_errors":
      return "Fix preview staging errors before Save can proceed.";
    case "needs_review_rows":
      return `${needsReviewRowCount} ${needsReviewRowCount === 1 ? "row needs" : "rows need"} review before Save can proceed.`;
    case "parse_errors":
      return `${parseErrorRowCount} ${parseErrorRowCount === 1 ? "issue" : "issues"} must be fixed before Save can proceed.`;
    case "request_too_large":
      return "This reviewed upload is too large to publish as one atomic change. Reduce the file and run the import again.";
    case "no_changes":
      return "No changes to save.";
    case "write_date_pending":
      return "Wait for the write date to finish updating.";
  }
}

function CountChip(props: { value: number; tone: StatusPillTone; label: ReactNode }) {
  return (
    <span className="preview-save-bar__count">
      <span className="preview-save-bar__count-value">{props.value}</span>
      <StatusPill tone={props.tone} label={props.label} />
    </span>
  );
}

export function PreviewSaveBar(props: PreviewSaveBarProps) {
  const {
    readyRowCount,
    needsReviewRowCount,
    parseErrorRowCount,
    unchangedRowCount = 0,
    blockingReason,
    saveLabel,
    savingLabel = "Saving...",
    onSave,
    saving,
    onDiscardAll,
    saveErrorMessage,
    asOf,
    className,
  } = props;

  // `useId` so multiple bars rendered in the same document (tests,
  // storybook) get unique describedby targets. Hardcoding a string
  // would collide.
  const reasonId = useId();
  const reasonElementId = `preview-save-bar-reason-${reasonId}`;

  const disabled = saving || blockingReason !== undefined;
  // Label rule:
  // - `savingLabel` while in flight (also disabled).
  // - caller-provided `saveLabel` when supplied.
  // - "Save N changes" when enabled with at least one ready row.
  // - "Save" when readyRowCount === 0 (which `no_changes` blocks anyway,
  //   but the label still needs to read sensibly under any blocker that
  //   happens to coincide with zero ready rows).
  const buttonLabel = saving
    ? savingLabel
    : saveLabel
      ? saveLabel
      : readyRowCount > 0
        ? `Save ${readyRowCount} change${readyRowCount === 1 ? "" : "s"}`
        : "Save";

  const reasonText = blockingReason
    ? reasonCopy(blockingReason, needsReviewRowCount, parseErrorRowCount)
    : null;

  const errorElementId = `preview-save-bar-error-${reasonId}`;

  return (
    <div className={classNames("preview-save-bar", className)}>
      <div className="preview-save-bar__counts" aria-label="Preview row counts">
        <CountChip
          value={readyRowCount}
          tone="success"
          label={`ready row${readyRowCount === 1 ? "" : "s"}`}
        />
        <CountChip value={needsReviewRowCount} tone="warning" label="to review" />
        <CountChip
          value={parseErrorRowCount}
          tone="danger"
          label={`issue${parseErrorRowCount === 1 ? "" : "s"}`}
        />
        {unchangedRowCount > 0 ? (
          <CountChip value={unchangedRowCount} tone="neutral" label="unchanged" />
        ) : null}
      </div>
      <div className="preview-save-bar__spacer" />
      {reasonText ? (
        <p
          id={reasonElementId}
          className="preview-save-bar__reason"
          data-blocking-reason={blockingReason}
        >
          {reasonText}
        </p>
      ) : null}
      {asOf ? (
        <p className="preview-save-bar__as-of" data-import-as-of={asOf}>
          Writing as of {formatImportAsOf(asOf)}
        </p>
      ) : null}
      <div className="preview-save-bar__actions">
        {onDiscardAll ? (
          <Button intent="ghost" size="sm" onClick={onDiscardAll} disabled={saving}>
            Discard all
          </Button>
        ) : null}
        <Button
          intent="primary"
          size="md"
          onClick={onSave}
          disabled={disabled}
          aria-describedby={
            saveErrorMessage ? errorElementId : reasonText ? reasonElementId : undefined
          }
        >
          {buttonLabel}
        </Button>
      </div>
      {saveErrorMessage ? (
        <p
          id={errorElementId}
          className="preview-save-bar__error"
          role="alert"
          data-save-error="true"
        >
          {saveErrorMessage}
        </p>
      ) : null}
    </div>
  );
}
