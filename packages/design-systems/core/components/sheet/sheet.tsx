import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from "react";

import { Close } from "../../icons";
import { cx, focusRing } from "../utils";

export type SheetProps = {
  open: boolean;
  title: ReactNode;
  children: ReactNode;
  onClose: (reason?: string) => void;
  footer?: ReactNode;
  width?: string;
  /** Where the sheet's top edge sits, e.g. below a host's top bar. */
  top?: string;
  backdrop?: boolean;
  /**
   * "inset" (the default) floats a rounded card inset from the viewport.
   * "edge" sits flush against the right edge, from `top` to the bottom,
   * separated from the page by a single left hairline.
   */
  placement?: "inset" | "edge";
  /** A small muted line above the title, e.g. what kind of thing the title names. */
  eyebrow?: ReactNode;
};

const TABBABLE_SELECTOR = [
  "a[href]:not([tabindex='-1'])",
  "button:not([disabled]):not([tabindex='-1'])",
  "input:not([disabled]):not([type='hidden']):not([tabindex='-1'])",
  "select:not([disabled]):not([tabindex='-1'])",
  "textarea:not([disabled]):not([tabindex='-1'])",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

export function Sheet(props: SheetProps) {
  const {
    open,
    title,
    children,
    onClose,
    footer,
    width,
    top,
    backdrop = false,
    placement = "inset",
    eyebrow,
  } = props;
  const containerRef = useRef<HTMLDialogElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();

  // Mirror onClose into a ref so the open/close effect can stay keyed on `open`
  // only. If we depended on `onClose` identity, every parent re-render with a
  // fresh inline arrow would tear down the effect and re-run the focus-capture
  // + focus-restore cleanup, snapping focus back to the previously-active
  // element on every render. SheetRenderer stabilizes onClose, but direct Sheet
  // consumers (stories, ad hoc usage) routinely pass inline arrows.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const container = containerRef.current;
    if (!container) {
      return;
    }
    // Capture whoever had focus before the sheet stole it so we can hand
    // focus back on close. Mirrors the Modal/useFocusTrap pattern.
    const previousActiveElement = document.activeElement;
    const body = container.querySelector<HTMLElement>("[data-sheet-body]");
    const initialTabbable = body?.querySelector<HTMLElement>(TABBABLE_SELECTOR);
    // An edge sheet with nothing to fill in opens focused on itself, so its
    // first stop is not a ringed close button (Tab reaches it next).
    const initialFocusTarget =
      initialTabbable ?? (placement === "edge" ? container : closeButtonRef.current);
    initialFocusTarget?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current("escape");
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (
        previousActiveElement instanceof HTMLElement &&
        previousActiveElement.isConnected &&
        typeof previousActiveElement.focus === "function"
      ) {
        previousActiveElement.focus();
      }
    };
    // The placement is fixed for a sheet's life; focus is taken once, as it opens.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const sheetStyle: CSSProperties | undefined =
    width || top
      ? ({
          ...(width ? { ["--size-sheet-width" as string]: width } : {}),
          ...(top ? { top } : {}),
        } as CSSProperties)
      : undefined;

  const heading = (
    <h2
      id={titleId}
      className="text-[length:var(--text-section-title)] font-[var(--font-weight-semibold)] text-[var(--color-text-primary)]"
    >
      {title}
    </h2>
  );

  return (
    <>
      {backdrop ? (
        <button
          type="button"
          aria-hidden="true"
          tabIndex={-1}
          className="fixed inset-0 z-[var(--z-overlay)] cursor-default border-0 bg-[var(--color-bg-overlay)] p-0"
          onClick={() => onClose("backdrop")}
        />
      ) : null}
      <dialog
        ref={containerRef}
        open
        // Sheet has no focus trap (Tab freely escapes to the page underneath),
        // so claiming aria-modal would lie to assistive tech. Even with the
        // backdrop variant, the dim is visual-only, not a focus barrier.
        aria-labelledby={titleId}
        tabIndex={-1}
        style={sheetStyle}
        className={cx(
          placement === "edge"
            ? "fixed bottom-[var(--space-0)] left-auto right-[var(--space-0)] top-[var(--space-0)] z-[var(--z-overlay)] m-0 h-auto p-0 outline-none!"
            : "fixed bottom-[var(--space-4)] left-auto right-[var(--space-4)] top-[var(--space-4)] z-[var(--z-overlay)] m-0 p-0",
          "flex w-[var(--size-sheet-width)] max-w-[var(--size-sheet-max-width)] flex-col",
          placement === "edge"
            ? "overflow-hidden rounded-none border-y-0 border-l border-r-0 border-[var(--color-border-subtle)]"
            : "overflow-hidden rounded-[var(--radius-shell)] border border-[var(--color-border-subtle)]",
          placement === "edge"
            ? "bg-[var(--color-bg-surface)] text-[var(--color-text-primary)]"
            : "bg-[var(--color-bg-surface)] text-[var(--color-text-primary)] shadow-[var(--shadow-raised)]",
        )}
      >
        <header className="flex items-start justify-between gap-[var(--space-4)] border-b border-[var(--color-border-subtle)] px-[var(--space-5)] py-[var(--space-4)]">
          {eyebrow ? (
            <div className="min-w-[var(--space-0)] flex-1">
              <div className="mb-[var(--space-0-5)] truncate text-[length:var(--text-caption)] leading-[var(--leading-caption)] text-[var(--color-text-muted)]">
                {eyebrow}
              </div>
              {heading}
            </div>
          ) : (
            heading
          )}
          <button
            ref={closeButtonRef}
            type="button"
            aria-label="Close sheet"
            onClick={() => onClose("close-button")}
            className={cx(
              "inline-flex h-[var(--size-control-sm)] w-[var(--size-control-sm)] items-center justify-center rounded-[var(--radius-control)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]",
              focusRing,
            )}
          >
            <Close className="h-[var(--size-icon-md)] w-[var(--size-icon-md)]" />
          </button>
        </header>
        <div
          data-sheet-body
          className="min-h-[var(--space-0)] flex-1 overflow-auto px-[var(--space-5)] py-[var(--space-4)]"
        >
          {children}
        </div>
        {footer ? (
          <footer className="border-t border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-[var(--space-5)] py-[var(--space-4)]">
            {footer}
          </footer>
        ) : null}
      </dialog>
    </>
  );
}
