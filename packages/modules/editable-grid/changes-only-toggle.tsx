// ChangesOnlyToggle — checkbox + label that drives `controller.showChangesOnly`.
//
// Pairs naturally with the editable-grid controller's
// `showChangesOnly` + `setShowChangesOnly` surface. The toggle stays dumb
// (just `on`/`onChange` props) so apps can wire it to whatever state
// source they want — the typical wiring is two props pulled straight
// off the controller. Disabled in `mode === "read"` (no edits to filter).
//
// Round-checkbox (`.checkbox`) is load-bearing: it matches AG
// Grid Quartz's built-in row-selection + filter-list checkboxes so the
// page reads as ONE checkbox primitive across the surface. A square
// checkbox here would read as a different primitive — earlier review
// rejected that drift.

export type ChangesOnlyToggleProps = {
  on: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
};

export function ChangesOnlyToggle(props: ChangesOnlyToggleProps) {
  const { on, onChange, disabled = false } = props;
  return (
    <label
      data-changes-only-toggle
      data-state={on ? "on" : "off"}
      className="inline-flex select-none items-center gap-[var(--space-1-5)]"
      style={{
        fontSize: "var(--text-caption)",
        color: disabled ? "var(--color-text-disabled)" : "var(--color-text-secondary)",
        cursor: disabled ? "not-allowed" : "pointer",
        whiteSpace: "nowrap",
      }}
    >
      {/* `.checkbox` (defined in `tokens/theme.css`) renders as
       * a round circle matching AG Grid Quartz's built-in row-selection
       * / filter-list checkboxes. Same shape across every checkbox in
       * the app — a square checkbox here would read as a different
       * primitive and the user called it out. */}
      <input
        type="checkbox"
        checked={on}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="checkbox"
      />
      Show changes only
    </label>
  );
}
