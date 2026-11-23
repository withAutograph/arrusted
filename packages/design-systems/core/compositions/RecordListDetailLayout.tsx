import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "../components/Button";
import { cx } from "../components/utils";
import { ChevronLeft } from "../icons";

export type RecordListDetailLayoutListContext = {
  /** Whether the detail panel is currently rendered by the responsive layout. */
  isDetailVisible: boolean;
};

export type RecordListDetailLayoutList =
  | ReactNode
  | ((context: RecordListDetailLayoutListContext) => ReactNode);

export type RecordListDetailLayoutProps = {
  /** A list node, or a render function that can align list selection with visible detail. */
  list: RecordListDetailLayoutList;
  detail: ReactNode;
  hasSelection: boolean;
  /** Keeps an existing wide selection visible while deferring constrained detail until opted in. */
  showDetailOnConstrained?: boolean;
  /** The current controlled record id, used to restore focus after Back. */
  selectedId?: string;
  onBack: () => void;
  backLabel?: ReactNode;
  className?: string;
};

/**
 * Preserves a two-column record-review surface when space permits. In a
 * constrained container, selected detail replaces the list and exposes a
 * semantic Back control that returns ownership of selection to the caller.
 */
export function RecordListDetailLayout(props: RecordListDetailLayoutProps) {
  const {
    list,
    detail,
    hasSelection,
    showDetailOnConstrained = true,
    selectedId,
    onBack,
    backLabel = "Back",
    className,
  } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const backContainerRef = useRef<HTMLDivElement>(null);
  const previousHasSelection = useRef(hasSelection);
  const hasConstrainedDetail = hasSelection && showDetailOnConstrained;
  const listUsesDetailVisibility = typeof list === "function";
  const previousHasConstrainedDetail = useRef(hasConstrainedDetail);
  const previousSelectedItemId = useRef<string | undefined>(undefined);
  const [isDetailVisible, setIsDetailVisible] = useState(false);

  useLayoutEffect(() => {
    if (!listUsesDetailVisibility) {
      setIsDetailVisible(false);
      return;
    }

    function updateDetailVisibility() {
      const nextVisible =
        detail != null &&
        detailRef.current != null &&
        window.getComputedStyle(detailRef.current).display !== "none";
      setIsDetailVisible((current) => (current === nextVisible ? current : nextVisible));
    }

    updateDetailVisibility();
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateDetailVisibility);
    if (containerRef.current) resizeObserver?.observe(containerRef.current);
    return () => resizeObserver?.disconnect();
  }, [detail, hasConstrainedDetail, listUsesDetailVisibility]);

  useLayoutEffect(() => {
    const selected = listRef.current?.querySelector<HTMLButtonElement>(
      'button[data-record-list-item][aria-pressed="true"]',
    );
    if (hasSelection) {
      previousSelectedItemId.current = selectedId ?? selected?.dataset.recordListId;
    }
    if (!previousHasConstrainedDetail.current && hasConstrainedDetail) {
      const backButton = backContainerRef.current?.querySelector<HTMLButtonElement>("button");
      if (
        backButton &&
        backContainerRef.current &&
        window.getComputedStyle(backContainerRef.current).display !== "none"
      ) {
        backButton.focus();
      }
    }
    if (
      (previousHasSelection.current && !hasSelection) ||
      (previousHasConstrainedDetail.current && !hasConstrainedDetail)
    ) {
      const previousId = previousSelectedItemId.current;
      const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>(
        "button[data-record-list-item]",
      );
      Array.from(buttons ?? [])
        .find((button) => button.dataset.recordListId === previousId)
        ?.focus();
    }
    previousHasSelection.current = hasSelection;
    previousHasConstrainedDetail.current = hasConstrainedDetail;
  }, [hasConstrainedDetail, hasSelection, selectedId]);

  return (
    <div
      ref={containerRef}
      className={cx("@container/record-list-detail min-w-[var(--space-0)]", className)}
    >
      <div className="grid min-w-[var(--space-0)] gap-[var(--space-4)] @3xl/record-list-detail:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)]">
        <div
          ref={listRef}
          className={cx(
            "min-w-[var(--space-0)]",
            hasConstrainedDetail && "@max-3xl/record-list-detail:hidden",
          )}
        >
          {typeof list === "function" ? list({ isDetailVisible }) : list}
        </div>
        <div
          ref={detailRef}
          tabIndex={-1}
          className={cx(
            "min-w-[var(--space-0)] focus:outline-none",
            !hasConstrainedDetail && "hidden @3xl/record-list-detail:block",
          )}
        >
          {hasConstrainedDetail ? (
            <div
              ref={backContainerRef}
              className="mb-[var(--space-2)] @3xl/record-list-detail:hidden"
            >
              <Button
                size="sm"
                intent="secondary"
                leading={
                  <ChevronLeft
                    aria-hidden="true"
                    className="h-[var(--size-icon-sm)] w-[var(--size-icon-sm)]"
                  />
                }
                onClick={onBack}
              >
                {backLabel}
              </Button>
            </div>
          ) : null}
          {detail}
        </div>
      </div>
    </div>
  );
}
