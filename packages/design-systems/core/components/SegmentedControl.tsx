// SegmentedControl — generic pill-segmented selector.
//
// Replaces divergent ad-hoc segmented-control styling that shipped in
// headcount:
//
//   1. The Drafts|Published group in ApprovalsPage (action-primary fill on
//      active, sharp 1px divider rail).
//   2. The deferred Read|Tweak|Edit mode picker direction (subtle
//      surface-on-subtle treatments read as "tab strip" more than
//      "active control" and were flagged for low contrast).
//
// The defaults here lean into the higher-contrast variant: `intent="primary"`
// uses `--color-action-primary` background + `--color-text-inverse` on the
// active segment so the active control is glanceable, not inferred. The
// neutral variant remains available for surfaces where the segmented
// control sits alongside a primary CTA and shouldn't compete for attention.
//
// Generic over a string-literal `T` so call sites get exhaustive option
// values + a typed `onChange`. Use the function-declaration form below
// (not `const = ...`) so JSX `<SegmentedControl<"a"|"b"> ...>` generics work.

import { cx, focusRing } from "./utils";

export type SegmentedControlSize = "sm" | "md" | "lg";
export type SegmentedControlIntent = "primary" | "neutral";

export type SegmentedControlOption<T extends string> = {
  value: T;
  label: string;
  ariaLabel?: string;
  /**
   * A count shown as a badge after the label (e.g. items waiting in that
   * view). Nothing shows for zero or undefined; name the count in
   * `ariaLabel` so it is announced with the label.
   */
  count?: number;
};

export type SegmentedControlProps<T extends string> = {
  value: T;
  onChange: (next: T) => void;
  options: ReadonlyArray<SegmentedControlOption<T>>;
  /** Visual size. Defaults to "md". */
  size?: SegmentedControlSize;
  /**
   * Active-segment treatment. Defaults to "primary" (action-primary fill +
   * inverse text) for clearly-glanceable active state. Use "neutral" when
   * sitting next to a primary CTA where the control shouldn't compete.
   */
  intent?: SegmentedControlIntent;
  /** Optional aria-label for the radiogroup. */
  ariaLabel?: string;
  className?: string;
};

// Padding + text-size per visual size. The control is a single row of
// segments, so we only key on height-ish tokens; no need for the full
// xs..lg ladder that the Button uses.
const SIZE_SEGMENT_CLASS: Record<SegmentedControlSize, string> = {
  sm: "px-[var(--space-2-5)] py-[var(--space-1)] text-[length:var(--text-control-xs)]",
  md: "px-[var(--space-3)] py-[var(--space-1-5)] text-[length:var(--text-control-sm)]",
  lg: "px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-body)]",
};

// Wrapper inner padding for the PRIMARY intent only: a hairline so the
// active fill has a 1px ring of bg-subtle around it. The neutral intent
// uses NO inner padding — segments butt up against the border so the
// active surface-on-subtle treatment reads as a tab strip, not a chip.
// See `intent === "neutral"` branch below.
const SIZE_GROUP_PADDING: Record<SegmentedControlSize, string> = {
  sm: "p-[var(--space-0-5)]",
  md: "p-[var(--space-0-5)]",
  lg: "p-[var(--space-0-5)]",
};

// Active / inactive segment classes per intent. Both use --radius-control
// on the inner segment so the rounded fill matches the outer pill.
const SEGMENT_CLASS: Record<
  SegmentedControlIntent,
  { active: string; inactive: string; group: string }
> = {
  primary: {
    group:
      "inline-flex items-center rounded-[var(--radius-control)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-subtle)]",
    active:
      "bg-[var(--color-action-primary)] text-[var(--color-text-inverse)] font-[var(--font-weight-medium)] shadow-[var(--shadow-control)]",
    inactive:
      "bg-transparent text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]",
  },
  neutral: {
    group:
      "inline-flex items-center rounded-[var(--radius-control)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-subtle)]",
    active:
      "bg-[var(--color-bg-surface)] text-[var(--color-text-primary)] font-[var(--font-weight-medium)] shadow-[var(--shadow-control)]",
    inactive:
      "bg-transparent text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]",
  },
};

export function SegmentedControl<T extends string>(props: SegmentedControlProps<T>) {
  const { value, onChange, options, size = "md", intent = "primary", ariaLabel, className } = props;
  const tokens = SEGMENT_CLASS[intent];
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      data-segmented-control
      data-intent={intent}
      data-size={size}
      className={cx(
        tokens.group,
        // Neutral intent: no inner padding (per the comment on
        // SIZE_GROUP_PADDING above). Primary intent: hairline padding so
        // the active fill has a ring of bg-subtle around it.
        intent === "neutral" ? null : SIZE_GROUP_PADDING[size],
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={option.ariaLabel}
            data-segmented-option={option.value}
            data-active={active ? "true" : "false"}
            onClick={() => onChange(option.value)}
            className={cx(
              // Inner segment uses --radius-control so the active fill
              // matches the outer pill's curvature.
              "inline-flex items-center justify-center gap-[var(--space-1-5)] rounded-[var(--radius-control)] transition-colors",
              SIZE_SEGMENT_CLASS[size],
              active ? tokens.active : tokens.inactive,
              focusRing,
            )}
          >
            {option.label}
            {option.count === undefined || option.count === 0 ? null : (
              <span
                className={cx(
                  "inline-flex h-[var(--space-4)] min-w-[var(--space-4)] items-center justify-center rounded-[var(--radius-pill)] px-[var(--space-1)] text-[length:var(--text-micro)] font-[var(--font-weight-semibold)] tabular-nums",
                  // Inverted on the filled active segment so it stays legible.
                  active && intent === "primary"
                    ? "bg-[var(--color-bg-surface)] text-[var(--color-action-primary)]"
                    : "bg-[var(--color-action-primary)] text-[var(--color-text-inverse)]",
                )}
                data-segmented-count={option.count}
              >
                {option.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
