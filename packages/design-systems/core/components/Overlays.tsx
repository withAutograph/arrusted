import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import { Close } from "../icons";
import { cx, focusRing } from "./utils";

export type ModalProps = {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  onClose: () => void;
  actions?: ReactNode;
  size?: "sm" | "md" | "lg";
  dismissOnBackdropClick?: boolean;
  dismissOnEscape?: boolean;
};

const modalSizeClass = {
  sm: "max-w-[var(--size-modal-sm)]",
  md: "max-w-[var(--size-modal-md)]",
  lg: "max-w-[var(--size-modal-lg)]",
};

export function Modal(props: ModalProps) {
  const {
    open,
    title,
    description,
    children,
    onClose,
    actions,
    size = "md",
    dismissOnBackdropClick = true,
    dismissOnEscape = true,
  } = props;
  const containerRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useFocusTrap(containerRef, open, {
    onEscape: dismissOnEscape ? onClose : undefined,
  });

  if (!open) return null;
  if (typeof document === "undefined") return null;
  // Portal to <body> so the modal escapes any parent stacking context. Without
  // this, a portaled-sibling overlay (e.g., the Sheet primitive, which portals
  // to body) at the same z-index paints on top because DOM order breaks ties
  // for siblings sharing a stacking context.
  return createPortal(
    <div className="fixed inset-0 z-[var(--z-overlay)] flex items-center justify-center bg-[var(--color-bg-overlay)] p-[var(--space-6)]">
      {dismissOnBackdropClick ? (
        <button
          type="button"
          aria-label="Close modal"
          className="absolute inset-0 cursor-default border-0 bg-transparent p-0"
          onClick={onClose}
        />
      ) : null}
      <section
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={cx(
          "relative flex max-h-[var(--size-modal-max-height)] w-full flex-col overflow-hidden rounded-[var(--radius-shell)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] shadow-[var(--shadow-raised)]",
          modalSizeClass[size],
        )}
      >
        <header className="flex items-start justify-between gap-[var(--space-4)] border-b border-[var(--color-border-subtle)] px-[var(--space-5)] py-[var(--space-4)]">
          <div>
            <h2
              id={titleId}
              className="text-[length:var(--text-section-title)] font-[var(--font-weight-semibold)] text-[var(--color-text-primary)]"
            >
              {title}
            </h2>
            {description ? (
              <p
                id={descriptionId}
                className="mt-[var(--space-1)] text-[length:var(--text-control-sm)] text-[var(--color-text-muted)]"
              >
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className={cx(
              "inline-flex h-[var(--size-control-sm)] w-[var(--size-control-sm)] items-center justify-center rounded-[var(--radius-control)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]",
              focusRing,
            )}
          >
            <Close className="h-[var(--size-icon-md)] w-[var(--size-icon-md)]" />
          </button>
        </header>
        <div className="min-h-[var(--space-0)] flex-1 overflow-auto px-[var(--space-5)] py-[var(--space-4)]">
          {children}
        </div>
        {actions ? (
          <footer className="border-t border-[var(--color-border-subtle)] px-[var(--space-5)] py-[var(--space-4)]">
            {actions}
          </footer>
        ) : null}
      </section>
    </div>,
    document.body,
  );
}

const TABBABLE_SELECTOR = [
  "a[href]:not([tabindex='-1'])",
  "button:not([disabled]):not([tabindex='-1'])",
  "input:not([disabled]):not([type='hidden']):not([tabindex='-1'])",
  "select:not([disabled]):not([tabindex='-1'])",
  "textarea:not([disabled]):not([tabindex='-1'])",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

let activeTrapCount = 0;
let savedBodyOverflow: string | null = null;
let savedBodyPosition: string | null = null;
let savedBodyTop: string | null = null;
let savedBodyWidth: string | null = null;
let savedScrollY = 0;
const activeTrapStack: symbol[] = [];

function lockBodyScroll() {
  if (activeTrapCount === 0) {
    savedBodyOverflow = document.body.style.overflow;
    savedBodyPosition = document.body.style.position;
    savedBodyTop = document.body.style.top;
    savedBodyWidth = document.body.style.width;
    savedScrollY = window.scrollY;
    document.body.style.overflow = "hidden";
    document.body.style.position = "fixed";
    document.body.style.top = `-${savedScrollY}px`;
    document.body.style.width = "100%";
  }
  activeTrapCount += 1;
}

function unlockBodyScroll() {
  activeTrapCount -= 1;
  if (activeTrapCount > 0) {
    return;
  }
  activeTrapCount = 0;
  document.body.style.overflow = savedBodyOverflow ?? "";
  document.body.style.position = savedBodyPosition ?? "";
  document.body.style.top = savedBodyTop ?? "";
  document.body.style.width = savedBodyWidth ?? "";
  if (window.scrollY !== savedScrollY) {
    window.scrollTo(0, savedScrollY);
  }
  savedBodyOverflow = null;
  savedBodyPosition = null;
  savedBodyTop = null;
  savedBodyWidth = null;
  savedScrollY = 0;
}

function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
  options: { onEscape?: () => void } = {},
) {
  const onEscapeRef = useRef(options.onEscape);
  const [trapId] = useState(() => Symbol("focus-trap"));

  useEffect(() => {
    onEscapeRef.current = options.onEscape;
  }, [options.onEscape]);

  useEffect(() => {
    if (!active) {
      return;
    }
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const previousActiveElement = document.activeElement;
    activeTrapStack.push(trapId);
    const initialTabbable = container.querySelector<HTMLElement>(TABBABLE_SELECTOR);
    const initialFocusTarget = initialTabbable ?? container;
    if (!container.contains(document.activeElement)) {
      initialFocusTarget.focus();
    }
    lockBodyScroll();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (activeTrapStack[activeTrapStack.length - 1] !== trapId) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        // Stop other document-level Escape listeners (notably Sheet's, when
        // Modal is stacked over a Sheet) from also firing and re-entering
        // their own close path. Without this, Sheet — registered first — would
        // run its Escape handler before Modal here.
        event.stopImmediatePropagation();
        onEscapeRef.current?.();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }

      const tabbables = Array.from(container.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR));
      if (tabbables.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }
      const first = tabbables[0]!;
      const last = tabbables[tabbables.length - 1]!;
      const focused = document.activeElement;
      if (!container.contains(focused)) {
        event.preventDefault();
        if (event.shiftKey) {
          last.focus();
        } else {
          first.focus();
        }
        return;
      }
      if (event.shiftKey) {
        if (focused === first || focused === container) {
          event.preventDefault();
          last.focus();
        }
      } else if (focused === last || focused === container) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      const trapIndex = activeTrapStack.lastIndexOf(trapId);
      if (trapIndex !== -1) {
        activeTrapStack.splice(trapIndex, 1);
      }
      unlockBodyScroll();
      if (previousActiveElement instanceof HTMLElement) {
        previousActiveElement.focus();
      }
    };
  }, [active, containerRef, trapId]);
}

export type PopoverProps = {
  trigger: ReactNode;
  children: ReactNode;
  open?: boolean;
  className?: string;
};

export function Popover(props: PopoverProps) {
  const { trigger, children, open, className } = props;
  return (
    <span className="relative inline-flex">
      {trigger}
      {open ? (
        <span
          className={cx(
            "absolute left-0 top-full z-[var(--z-popover)] mt-[var(--space-2)] min-w-[var(--size-popover-min-width)] rounded-[var(--radius-panel)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-[var(--space-2)] shadow-[var(--shadow-raised)]",
            className,
          )}
        >
          {children}
        </span>
      ) : null}
    </span>
  );
}

export type TooltipProps = {
  content: ReactNode;
  children: ReactNode;
};

export function Tooltip(props: TooltipProps) {
  const { content, children } = props;
  return (
    <span className="group relative inline-flex">
      {children}
      <span className="pointer-events-none absolute bottom-full left-1/2 z-[var(--z-overlay)] mb-[var(--space-2)] hidden -translate-x-1/2 whitespace-nowrap rounded-[var(--radius-control)] bg-[var(--color-text-primary)] px-[var(--space-2)] py-[var(--space-1)] text-[length:var(--text-caption)] text-[var(--color-text-inverse)] group-hover:block">
        {content}
      </span>
    </span>
  );
}

export type MenuItem = {
  id: string;
  label: ReactNode;
  disabled?: boolean;
  onSelect?: () => void;
};

// Body-portal popover anchored to an external trigger ref. Use when a
// popover must escape its parent overflow context (e.g., a scrollable
// table viewport, a Sheet's stacking context) — the panel paints as a
// fixed-position child of `<body>` and re-anchors against the trigger's
// bounding rect on scroll/resize. Click-outside (capture-phase
// pointerdown) and Escape dismiss; the trigger keeps focus management.
//
// Right-edge alignment is intentional: both production call sites
// (toolbar-style triggers in the right cluster of an indicator bar)
// would run off-screen with left-edge alignment. The panel slides left
// from the trigger's right edge once its width is known; a brief first
// frame may flash at top:0/left:0 with `visibility: hidden` until the
// next layout effect anchors it.
//
// Use the lighter inline `Popover` above when the popover's parent
// doesn't clip and a simple `position: absolute` is enough.
export type BodyPortalPopoverProps = {
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  ariaLabel: string;
  align?: "start" | "end";
  children: ReactNode;
};

export function BodyPortalPopover(props: BodyPortalPopoverProps) {
  const { anchorRef, open, onClose, ariaLabel, align = "end", children } = props;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    function updatePosition() {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      // Right-edge alignment: anchor the panel's right edge to the
      // trigger's right edge so triggers near the page margin don't
      // push the panel off-screen. Falls back to left edge for the
      // first paint, before the panel has measured its own width.
      const panelWidth = panelRef.current?.offsetWidth ?? 0;
      const panelHeight = panelRef.current?.offsetHeight ?? 0;
      const viewportPadding = 8;
      const preferredLeft = align === "end" && panelWidth > 0 ? rect.right - panelWidth : rect.left;
      const maxLeft =
        panelWidth > 0
          ? window.innerWidth - panelWidth - viewportPadding
          : window.innerWidth - viewportPadding;
      const maxTop =
        panelHeight > 0
          ? window.innerHeight - panelHeight - viewportPadding
          : window.innerHeight - viewportPadding;
      const top = Math.max(viewportPadding, Math.min(rect.bottom + 4, maxTop));
      const left = Math.max(viewportPadding, Math.min(preferredLeft, maxLeft));
      setPosition({ top, left });
    }
    updatePosition();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [open, anchorRef, align]);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    }
    function handleKey(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;
      onClose();
    }
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open, anchorRef, onClose]);

  if (!open) return null;
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={ariaLabel}
      style={{
        position: "fixed",
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        zIndex: "var(--z-popover)",
        visibility: position ? "visible" : "hidden",
      }}
      className={cx(
        "rounded-[var(--radius-panel)] border border-[var(--color-border-subtle)]",
        "bg-[var(--color-bg-surface)] shadow-[var(--shadow-raised)]",
      )}
    >
      {children}
    </div>,
    document.body,
  );
}

export function DropdownMenu(props: { trigger: ReactNode; items: MenuItem[]; open?: boolean }) {
  const { trigger, items, open } = props;
  return (
    <Popover trigger={trigger} open={open}>
      <div className="flex flex-col gap-[var(--space-1)]">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            disabled={item.disabled}
            onClick={item.onSelect}
            className={cx(
              "rounded-[var(--radius-control)] px-[var(--space-2)] py-[var(--space-1-5)] text-left text-[length:var(--text-body)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-selected)]",
              focusRing,
              item.disabled && "cursor-not-allowed opacity-50",
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
    </Popover>
  );
}
