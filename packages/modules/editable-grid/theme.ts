// AG Grid Quartz theme remapped to core design tokens.
//
// Pulls our `--color-*`, `--font-*`, `--text-*`, `--radius-*`, and
// `--space-*` semantic tokens (defined in
// `packages/design-systems/core/tokens/theme.css`) into AG Grid's theme
// params via CSS variable references. The result: AG Grid renders with
// our color palette, our font, our radii, and our spacing instead of
// Quartz's defaults — without forking the AG Grid theme code or writing
// CSS overrides.
//
// CSS-variable references (vs. concrete values) mean the AG Grid surface
// inherits theme changes at runtime — flip a `--color-*` token and the
// grid follows. This keeps a single source of truth for the design
// language across native components and AG Grid.
//
// What this does NOT cover (intentionally V0):
//   - Custom checkbox SVG / icon shape: AG Grid's checkbox is color-
//     matched but uses Quartz's SVG shape. Per Hari, color-match only
//     for V0; replace cellRenderer with a custom Checkbox if/when the
//     shape mismatch is product-flagged.
//   - Filter popup / column menu density and layout: AG Grid's internal
//     popup chrome inherits the colors above but its layout / padding is
//     Quartz's. Restyling the popups requires CSS class overrides; deferred
//     until a specific control feels wrong in product use.

import { themeQuartz } from "ag-grid-community";

// AG Grid v33 theme.withParams accepts both concrete color strings and
// CSS variable references. We use CSS variables so the design-system
// tokens stay the single source of truth.
export const AgGridTheme = themeQuartz.withParams({
  // Color identity
  accentColor: "var(--color-action-primary)",
  backgroundColor: "var(--color-bg-surface)",
  foregroundColor: "var(--color-text-primary)",
  borderColor: "var(--color-border-subtle)",
  chromeBackgroundColor: "var(--color-bg-subtle)",
  headerBackgroundColor: "var(--color-bg-subtle)",
  headerTextColor: "var(--color-text-secondary)",
  oddRowBackgroundColor: "var(--color-bg-surface)",
  rowHoverColor: "var(--color-bg-hover)",
  selectedRowBackgroundColor: "var(--color-bg-selected)",
  rangeSelectionBorderColor: "var(--color-action-primary)",
  rangeSelectionBackgroundColor: "var(--color-bg-selected)",
  inputFocusBorder: { color: "var(--color-action-primary)", style: "solid", width: 1 },

  // Typography
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-control-md)",
  headerFontWeight: "var(--font-weight-semibold)",

  // Geometry
  borderRadius: "var(--radius-control)",
  wrapperBorderRadius: "var(--radius-panel)",
  rowVerticalPaddingScale: 1,
  cellHorizontalPaddingScale: 1.2,
});

// Read-presentation variant of the edit theme. Used by the editable-grid
// module's `mode: "read" | "tweak"` modes so a "mostly read" or "view-only"
// surface looks visually distinct from the dense edit mode without forking
// the design language. Inherits every color / font / radius token from the
// edit theme via chained `.withParams` (AG Grid's theme API merges the
// param overrides on top of the prior theme), so changes to the edit
// theme's color identity flow through automatically.
//
// What changes vs. the edit theme:
//   - More vertical row padding + horizontal cell padding for a more
//     spacious, read-comfortable rhythm.
//   - Inner row + column gridlines suppressed (`rowBorder: false`,
//     `columnBorder: false`) so the cell grid reads as a quiet text
//     surface rather than a dense data form. Header underline and the
//     wrapper border stay (default) — they keep the surface bounded.
//
// Cell-selection ring suppression is NOT in the theme: it's a grid-level
// `cellSelection={false}` prop on `<AgGridReact>` set by the surface
// component when `mode !== "edit"`. (Theme params don't include a "no
// range selection" toggle — selection is a behavior, not a style.)
export const AgGridReadTheme = AgGridTheme.withParams({
  rowVerticalPaddingScale: 1.4,
  cellHorizontalPaddingScale: 1.5,
  rowBorder: false,
  columnBorder: false,
});
