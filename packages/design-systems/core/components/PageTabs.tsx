// PageTabs — underline-tab strip ported from AG2's `AppModeTabs`. See
// `docs/frontend-architecture.md` "App Shell IA". The leaf ships chrome-
// less; bottom border + horizontal padding live in the consumer.
//
// Non-obvious behaviors:
//   - `pendingSelection` for optimistic active swap while the router catches
//     up; it becomes inactive once the router value changes.
//   - Returns null when `options.length <= 1`.
//   - WAI-ARIA tablist keyboard nav with roving tabindex; arrow keys
//     activate AND focus the new tab.
//   - `aria-controls` is intentionally omitted — routing strip, no
//     co-located tabpanel. Strict spec wants `role="navigation"` + links;
//     we accept partial conformance to keep the arrow-key contract.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { cx, focusRing } from "./utils";

export type PageTabOption = {
  id: string;
  label: string;
  icon?: ReactNode;
};

export type PageTabsProps = {
  value: string;
  options: ReadonlyArray<PageTabOption>;
  onChange: (id: string) => void;
  /*
   * Called when a tab is pointed at or focused, before any decision to activate
   * it. A routing consumer uses this to warm the next route: the strip swaps its
   * own underline instantly either way, but the page underneath cannot arrive
   * before the server does, and hover is the earliest honest signal we get.
   */
  onOptionIntent?: (id: string) => void;
  ariaLabel?: string;
  className?: string;
};

export function PageTabs(props: PageTabsProps) {
  const { value, options, onChange, onOptionIntent, ariaLabel = "Page tabs", className } = props;
  const navRef = useRef<HTMLElement | null>(null);
  const [valueEpochState, setValueEpochState] = useState({
    value,
    epoch: 0,
  });
  const [pendingSelection, setPendingSelection] = useState<{
    fromValue: string;
    toValue: string;
    valueEpoch: number;
  } | null>(null);
  const [indicatorStyle, setIndicatorStyle] = useState<{
    width: number;
    transform: string;
  }>({ width: 0, transform: "translateX(0)" });
  // The indicator is measured from the DOM, so its first value is always zero
  // width at the far left. Sliding out of that is not a transition between two
  // tabs -- it is the component being born -- and animating it reads as the
  // strip replaying itself. Transitions switch on only once it has a position.
  const [measured, setMeasured] = useState(false);

  const valueEpoch =
    valueEpochState.value === value ? valueEpochState.epoch : valueEpochState.epoch + 1;

  const displayValue =
    pendingSelection !== null &&
    pendingSelection.valueEpoch === valueEpoch &&
    pendingSelection.fromValue === value
      ? pendingSelection.toValue
      : value;

  useEffect(() => {
    setValueEpochState((current) =>
      current.value === value ? current : { value, epoch: current.epoch + 1 },
    );
  }, [value]);

  useEffect(() => {
    const updateIndicator = () => {
      const nav = navRef.current;
      if (!nav) return;
      const activeBtn = nav.querySelector("[data-active='true']") as HTMLElement | null;
      if (!activeBtn) return;
      const navRect = nav.getBoundingClientRect();
      const btnRect = activeBtn.getBoundingClientRect();
      setIndicatorStyle({
        width: btnRect.width,
        transform: `translateX(${btnRect.left - navRect.left}px)`,
      });
      setMeasured(true);
    };
    const rafId = requestAnimationFrame(updateIndicator);
    window.addEventListener("resize", updateIndicator);
    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", updateIndicator);
    };
  }, [displayValue, options]);

  const navigableIds = useMemo(() => options.map((opt) => opt.id), [options]);

  const focusAndActivateAt = useCallback(
    (nextIndex: number) => {
      const nav = navRef.current;
      if (!nav) return;
      const nextId = navigableIds[nextIndex];
      if (nextId == null) return;
      const nextBtn = nav.querySelector(`[data-page-tab='${nextId}']`) as HTMLButtonElement | null;
      if (!nextBtn) return;
      if (nextId !== displayValue) {
        setPendingSelection({
          fromValue: value,
          toValue: nextId,
          valueEpoch,
        });
        onChange(nextId);
      }
      nextBtn.focus();
    },
    [navigableIds, displayValue, onChange, value, valueEpoch],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
      const count = navigableIds.length;
      if (count === 0) return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        focusAndActivateAt((currentIndex + 1) % count);
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        focusAndActivateAt((currentIndex - 1 + count) % count);
        return;
      }
      if (e.key === "Home") {
        e.preventDefault();
        focusAndActivateAt(0);
        return;
      }
      if (e.key === "End") {
        e.preventDefault();
        focusAndActivateAt(count - 1);
        return;
      }
    },
    [navigableIds, focusAndActivateAt],
  );

  if (options.length <= 1) return null;

  return (
    <nav
      ref={navRef}
      role="tablist"
      aria-label={ariaLabel}
      data-page-tabs
      className={cx("relative inline-flex gap-[var(--space-1)]", className)}
    >
      {options.map((opt, index) => {
        const isActive = opt.id === displayValue;
        return (
          <button
            key={opt.id}
            role="tab"
            type="button"
            aria-selected={isActive}
            // Roving tabindex: only the active tab is in the natural
            // tab order; arrow keys move within the strip.
            tabIndex={isActive ? 0 : -1}
            data-page-tab={opt.id}
            data-active={isActive}
            onClick={() => {
              if (!isActive) {
                setPendingSelection({
                  fromValue: value,
                  toValue: opt.id,
                  valueEpoch,
                });
                onChange(opt.id);
              }
            }}
            onPointerEnter={() => onOptionIntent?.(opt.id)}
            onFocus={() => onOptionIntent?.(opt.id)}
            onKeyDown={(e) => handleKeyDown(e, index)}
            className={cx(
              "appearance-none border-0 bg-transparent cursor-pointer",
              "inline-flex items-center gap-[var(--space-1-5)]",
              // px-4 (not px-3) so the indicator reads padding-box wide
              // with short labels. Vertical px-3 keeps the 52px topnav fit.
              "px-[var(--space-4)] py-[var(--space-3)] m-0",
              "text-[length:var(--text-control-sm)] font-[var(--font-weight-medium)] tracking-[var(--tracking-normal)] whitespace-nowrap",
              "transition-colors duration-150 ease-in-out",
              focusRing,
              isActive
                ? "text-[var(--color-text-primary)]"
                : "text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]",
            )}
          >
            {opt.icon}
            {opt.label}
          </button>
        );
      })}
      <div
        className={cx(
          "absolute bottom-0 left-0 bg-[var(--color-action-primary)]",
          measured && "transition-[transform,width] duration-200 ease-[cubic-bezier(0.4,0,0.2,1)]",
        )}
        aria-hidden="true"
        style={{
          // 2px = AG2's `h-0.5`. No matching token; single-consumer inline.
          height: "2px",
          width: `${indicatorStyle.width}px`,
          transform: indicatorStyle.transform,
        }}
      />
    </nav>
  );
}
