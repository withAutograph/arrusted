// "Clear" action for editors and picker popups. Hosts wire it to clear the
// stored value (the editable grid commits `null`, which the column setter
// stages as a clear or refuses for a required field).
//
// - `row`: a full-width row above an inline option list (value select).
// - `inline`: a compact button beside a search input. Search pickers float
//   their option list above or below the input, over anything stacked with
//   it, so the action sits next to the input where the list never covers it.

import type { ReactElement } from "react";

import { Close } from "../../icons";

export function ClearValueAction(props: {
  onClear: () => void;
  variant?: "row" | "inline";
}): ReactElement {
  const button = (
    <button
      type="button"
      data-editor-clear
      className={
        props.variant === "inline"
          ? "flex shrink-0 items-center gap-[var(--space-1)] rounded-[var(--radius-control)] px-[var(--space-2)] py-[var(--space-1-5)] text-[length:var(--text-control-sm)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]"
          : "flex w-full items-center gap-[var(--space-1-5)] rounded-[var(--radius-control)] px-[var(--space-2)] py-[var(--space-1-5)] text-left text-[length:var(--text-control-sm)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]"
      }
      onMouseDown={(event) => event.preventDefault()}
      onClick={props.onClear}
    >
      <Close aria-hidden="true" className="size-[var(--size-icon-sm)]" />
      Clear
    </button>
  );
  if (props.variant === "inline") return button;
  return (
    <div className="mb-[var(--space-2)] border-b border-[var(--color-border-subtle)] pb-[var(--space-2)]">
      {button}
    </div>
  );
}
