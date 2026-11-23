/*
 * Shared className constants for the date-picker calendar surface.
 * Covers BOTH disabled states: `aria-disabled` (used by react-day-picker's
 * Day buttons) and `disabled` (used by our own buttons in
 * month-year-selector for year-range edge clamping). Both selectors target
 * different states and don't conflict.
 */
import { cx } from "../utils";

export const NAV_BUTTON_CLASSES = cx(
  "inline-flex h-[var(--size-date-nav-button)] w-[var(--size-date-nav-button)]",
  "items-center justify-center rounded-[var(--radius-control)]",
  "border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)]",
  "text-[var(--color-text-primary)] transition-colors",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-action-primary)]/40",
  "hover:border-[var(--color-action-primary)] hover:bg-[var(--color-bg-selected)] hover:text-[var(--color-action-primary)]",
  "aria-disabled:cursor-not-allowed aria-disabled:opacity-40",
  "aria-disabled:hover:border-[var(--color-border-subtle)] aria-disabled:hover:bg-[var(--color-bg-surface)]",
  "aria-disabled:hover:text-[var(--color-text-muted)]",
  "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[var(--color-border-subtle)]",
  "disabled:hover:bg-[var(--color-bg-surface)] disabled:hover:text-[var(--color-text-muted)]",
);
