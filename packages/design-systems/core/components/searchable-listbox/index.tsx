import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { TextField } from "../FormControls";
import { cx } from "../utils";

const DEFAULT_MAX_RESULTS = 50;
const MAX_RESULTS_LIMIT = 500;
const POPUP_GAP = 4;
const VIEWPORT_PADDING = 8;

type PopupPosition = {
  left: number;
  top: number;
  width: number;
};

export type SearchableListboxOption<T> = {
  value: T;
  label: ReactNode;
  searchText: string;
  disabled?: boolean;
};

export type SearchableListboxProps<T> = {
  options: readonly SearchableListboxOption<T>[];
  value: T | null;
  query: string;
  onQueryChange: (query: string) => void;
  onValueChange: (value: T) => void;
  onActiveValueChange?: (value: T | null) => void;
  onEmptyActivation?: () => void;
  getOptionKey: (value: T) => string;
  ariaLabel: string;
  placeholder: string;
  id?: string;
  ariaDescribedBy?: string;
  required?: boolean;
  invalid?: boolean;
  disabled?: boolean;
  loading?: boolean;
  error?: ReactNode;
  emptyMessage?: ReactNode;
  renderOption?: (
    option: SearchableListboxOption<T>,
    state: { active: boolean; selected: boolean },
  ) => ReactNode;
  maxResults?: number;
  /** False when `options` already match `query` (e.g. a server search), so they are shown as given. */
  filterOptions?: boolean;
  /** A quiet note below the options, e.g. that more match than are shown. */
  footer?: ReactNode;
  autoFocus?: boolean;
  className?: string;
};

function boundedMaxResults(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_RESULTS;
  return Math.min(MAX_RESULTS_LIMIT, Math.max(1, Math.floor(value)));
}

// eslint-disable-next-line react-doctor/no-giant-component -- the generic combobox owns one coupled keyboard, portal, positioning, and ARIA state machine
export function SearchableListbox<T>(props: SearchableListboxProps<T>) {
  const {
    options,
    value,
    query,
    onQueryChange,
    onValueChange,
    onActiveValueChange,
    onEmptyActivation,
    getOptionKey,
    ariaLabel,
    placeholder,
    id,
    ariaDescribedBy,
    required,
    invalid,
    disabled = false,
    loading = false,
    error,
    emptyMessage = "No options found",
    renderOption,
    maxResults,
    filterOptions = true,
    footer,
    autoFocus,
    className,
  } = props;
  const inputId = useId();
  const listboxId = useId();
  const messageId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(Boolean(autoFocus) && !disabled);
  const [popupPosition, setPopupPosition] = useState<PopupPosition | null>(null);
  const selectedKey = value === null ? null : getOptionKey(value);
  const visibleOptions = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const selectedOption = options.find(
      (option) => selectedKey !== null && getOptionKey(option.value) === selectedKey,
    );
    const selectedDisplayText =
      typeof selectedOption?.label === "string" || typeof selectedOption?.label === "number"
        ? String(selectedOption.label).trim().toLocaleLowerCase()
        : null;
    const queryDisplaysSelection = needle.length > 0 && needle === selectedDisplayText;
    const filtered =
      filterOptions && needle && !queryDisplaysSelection
        ? options.filter((option) => option.searchText.toLocaleLowerCase().includes(needle))
        : options;
    return filtered.slice(0, boundedMaxResults(maxResults));
  }, [filterOptions, getOptionKey, maxResults, options, query, selectedKey]);
  const enabledOptions =
    disabled || loading ? [] : visibleOptions.filter((option) => !option.disabled);
  const selectedIndex = enabledOptions.findIndex(
    (option) => getOptionKey(option.value) === selectedKey,
  );
  const [activeState, setActiveState] = useState(() => ({
    selectedKey,
    activeKey: enabledOptions[selectedIndex >= 0 ? selectedIndex : 0]
      ? getOptionKey(enabledOptions[selectedIndex >= 0 ? selectedIndex : 0]!.value)
      : null,
  }));
  const activeCallbackRef = useRef(onActiveValueChange);
  const activeSelectionIsUserInitiatedRef = useRef(query.trim().length > 0);
  const lastReportedActiveKeyRef = useRef<string | null>(null);
  const selectedKeyChanged = activeState.selectedKey !== selectedKey;
  const preservedActiveIndex = enabledOptions.findIndex(
    (option) => getOptionKey(option.value) === activeState.activeKey,
  );
  const renderedActiveIndex = selectedKeyChanged
    ? Math.max(0, selectedIndex)
    : preservedActiveIndex >= 0
      ? preservedActiveIndex
      : 0;
  const normalizedActiveIndex = Math.min(
    renderedActiveIndex,
    Math.max(0, enabledOptions.length - 1),
  );
  const activeOption = enabledOptions[normalizedActiveIndex] ?? null;
  const activeVisibleIndex = activeOption
    ? visibleOptions.findIndex(
        (option) => getOptionKey(option.value) === getOptionKey(activeOption.value),
      )
    : -1;
  const activeOptionId = activeVisibleIndex >= 0 ? `${listboxId}-${activeVisibleIndex}` : undefined;

  useEffect(() => {
    activeCallbackRef.current = onActiveValueChange;
  }, [onActiveValueChange]);

  useLayoutEffect(() => {
    if (!open || disabled) {
      setPopupPosition(null);
      return;
    }

    let animationFrame = 0;
    let previousRect: DOMRect | null = null;
    function updatePosition() {
      const input = rootRef.current?.querySelector("input");
      const popup = popupRef.current;
      if (!input || !popup) return;
      const rect = input.getBoundingClientRect();
      const popupHeight = popup.offsetHeight;
      const belowTop = rect.bottom + POPUP_GAP;
      const collidesBelow = belowTop + popupHeight > window.innerHeight - VIEWPORT_PADDING;
      const top = collidesBelow
        ? Math.max(VIEWPORT_PADDING, rect.top - POPUP_GAP - popupHeight)
        : belowTop;
      const left = Math.max(
        VIEWPORT_PADDING,
        Math.min(rect.left, window.innerWidth - rect.width - VIEWPORT_PADDING),
      );
      setPopupPosition({ left, top, width: rect.width });
      previousRect = rect;
    }
    function trackMovement() {
      const input = rootRef.current?.querySelector("input");
      if (input) {
        const rect = input.getBoundingClientRect();
        if (
          !previousRect ||
          rect.left !== previousRect.left ||
          rect.top !== previousRect.top ||
          rect.width !== previousRect.width ||
          rect.height !== previousRect.height
        ) {
          updatePosition();
        }
      }
      animationFrame = window.requestAnimationFrame(trackMovement);
    }

    updatePosition();
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updatePosition);
    const input = rootRef.current?.querySelector("input");
    if (input) resizeObserver?.observe(input);
    if (popupRef.current) resizeObserver?.observe(popupRef.current);
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    animationFrame = window.requestAnimationFrame(trackMovement);
    return () => {
      resizeObserver?.disconnect();
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [disabled, open, loading, visibleOptions.length]);

  function moveActive(nextIndex: number) {
    if (enabledOptions.length === 0) return;
    const boundedIndex = Math.min(enabledOptions.length - 1, Math.max(0, nextIndex));
    const next = enabledOptions[boundedIndex];
    activeSelectionIsUserInitiatedRef.current = true;
    setActiveState({ selectedKey, activeKey: next ? getOptionKey(next.value) : null });
    const nextKey = next ? getOptionKey(next.value) : null;
    if (lastReportedActiveKeyRef.current !== nextKey) {
      lastReportedActiveKeyRef.current = nextKey;
      activeCallbackRef.current?.(next?.value ?? null);
    }
    if (next) {
      window.setTimeout(
        () =>
          document
            .getElementById(`${listboxId}-${visibleOptions.indexOf(next)}`)
            ?.scrollIntoView?.({ block: "nearest" }),
        0,
      );
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (disabled) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      if (!open) {
        setOpen(true);
        return;
      }
      moveActive(normalizedActiveIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      if (!open) {
        setOpen(true);
        return;
      }
      moveActive(normalizedActiveIndex - 1);
    } else if (event.key === "Home") {
      if (!open) return;
      event.preventDefault();
      event.stopPropagation();
      moveActive(0);
    } else if (event.key === "End") {
      if (!open) return;
      event.preventDefault();
      event.stopPropagation();
      moveActive(enabledOptions.length - 1);
    } else if (event.key === "Enter") {
      if (!open) return;
      event.preventDefault();
      event.stopPropagation();
      if (activeOption && activeSelectionIsUserInitiatedRef.current) {
        setOpen(false);
        onValueChange(activeOption.value);
      } else if (query.trim()) {
        setOpen(false);
        onEmptyActivation?.();
      }
    } else if (event.key === "Escape" && open) {
      setOpen(false);
    }
  }

  const popup =
    open && !disabled && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={popupRef}
            id={listboxId}
            role="listbox"
            aria-label={`${ariaLabel} options`}
            aria-busy={loading || undefined}
            style={{
              position: "fixed",
              left: popupPosition?.left ?? 0,
              top: popupPosition?.top ?? 0,
              width: popupPosition?.width ?? 0,
              visibility: popupPosition ? "visible" : "hidden",
              zIndex: rootRef.current?.closest("dialog, [role='dialog']")
                ? "calc(var(--z-overlay) + 1)"
                : "var(--z-popover)",
            }}
            // The list is portalled out of its host. `ag-custom-component-popup`
            // is AG Grid's marker for an editor's floating element: without it a
            // grid popup editor (e.g. a link picker) closes on the option's
            // mousedown, before the click picks it. Elsewhere it is inert.
            className="ag-custom-component-popup max-h-[var(--size-editor-options-max-height)] overflow-auto rounded-[var(--radius-control)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] shadow-[var(--shadow-raised)]"
          >
            {loading || visibleOptions.length === 0 ? (
              <div
                role="option"
                aria-disabled="true"
                aria-selected="false"
                className="px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-control-sm)] text-[var(--color-text-muted)]"
              >
                <span role="status">{loading ? "Loading options…" : emptyMessage}</span>
              </div>
            ) : (
              visibleOptions.map((option, visibleIndex) => {
                const optionKey = getOptionKey(option.value);
                const enabledIndex = enabledOptions.findIndex(
                  (candidate) => getOptionKey(candidate.value) === optionKey,
                );
                const active = activeOption
                  ? getOptionKey(activeOption.value) === optionKey
                  : false;
                const selected = selectedKey === optionKey;
                return (
                  <div
                    key={`${optionKey}:${visibleIndex}`}
                    id={`${listboxId}-${visibleIndex}`}
                    role="option"
                    aria-disabled={option.disabled || undefined}
                    aria-selected={selected}
                    className={cx(
                      "block w-full cursor-pointer px-[var(--space-3)] py-[var(--space-2)] text-left text-[length:var(--text-control-sm)] hover:bg-[var(--color-bg-hover)]",
                      active && "bg-[var(--color-bg-hover)]",
                      selected && "bg-[var(--color-bg-selected)]",
                      option.disabled && "cursor-not-allowed opacity-50",
                    )}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => {
                      if (enabledIndex >= 0) {
                        activeSelectionIsUserInitiatedRef.current = true;
                        setActiveState({ selectedKey, activeKey: optionKey });
                        if (lastReportedActiveKeyRef.current !== optionKey) {
                          lastReportedActiveKeyRef.current = optionKey;
                          activeCallbackRef.current?.(option.value);
                        }
                      }
                    }}
                    onClick={() => {
                      if (!option.disabled) {
                        setOpen(false);
                        onValueChange(option.value);
                      }
                    }}
                  >
                    {renderOption ? renderOption(option, { active, selected }) : option.label}
                  </div>
                );
              })
            )}
            {footer && !loading && visibleOptions.length > 0 ? (
              <div
                role="option"
                aria-disabled="true"
                aria-selected="false"
                className="px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-caption)] text-[var(--color-text-muted)]"
              >
                {footer}
              </div>
            ) : null}
          </div>,
          document.body,
        )
      : null;

  return (
    <div
      ref={rootRef}
      className={cx("flex w-full flex-col gap-[var(--space-2)]", className)}
      onFocusCapture={() => {
        if (!disabled) setOpen(true);
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <TextField
        aria-activedescendant={open ? activeOptionId : undefined}
        aria-controls={listboxId}
        aria-describedby={
          [ariaDescribedBy, error ? messageId : undefined].filter(Boolean).join(" ") || undefined
        }
        aria-expanded={open && !disabled}
        aria-invalid={invalid || Boolean(error) || undefined}
        aria-label={ariaLabel}
        aria-autocomplete="list"
        autoComplete="off"
        autoFocus={autoFocus}
        disabled={disabled}
        id={id ?? inputId}
        placeholder={placeholder}
        required={required}
        role="combobox"
        size="sm"
        value={query}
        trailing={
          <button
            type="button"
            aria-hidden={!query}
            aria-label="Clear search"
            disabled={disabled || !query}
            tabIndex={query ? 0 : -1}
            className={cx(
              "text-[length:var(--text-title)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]",
              !query && "invisible",
            )}
            onClick={() => {
              activeSelectionIsUserInitiatedRef.current = false;
              lastReportedActiveKeyRef.current = null;
              activeCallbackRef.current?.(null);
              setActiveState({ selectedKey, activeKey: null });
              onQueryChange("");
            }}
          >
            ×
          </button>
        }
        onClick={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        onValueChange={(next) => {
          activeSelectionIsUserInitiatedRef.current = next.length > 0;
          const needle = next.trim().toLocaleLowerCase();
          const nextActive =
            filterOptions && !loading && needle
              ? options.find(
                  (option) =>
                    !option.disabled && option.searchText.toLocaleLowerCase().includes(needle),
                )
              : undefined;
          setActiveState({
            selectedKey,
            activeKey: nextActive ? getOptionKey(nextActive.value) : null,
          });
          const nextActiveKey = nextActive ? getOptionKey(nextActive.value) : null;
          lastReportedActiveKeyRef.current = nextActiveKey;
          activeCallbackRef.current?.(nextActive?.value ?? null);
          setOpen(true);
          onQueryChange(next);
        }}
      />
      {error ? (
        <div
          id={messageId}
          role="alert"
          className="text-[length:var(--text-caption)] text-[var(--color-status-danger)]"
        >
          {error}
        </div>
      ) : null}
      {popup}
    </div>
  );
}
