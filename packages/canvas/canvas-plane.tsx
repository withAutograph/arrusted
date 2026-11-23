import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react";

import { Button } from "@autograph/components";
import { ArrowsPointingIn, Minus, Plus } from "@autograph/icons";

import {
  defaultGrid,
  isGridLayout,
  placeGrid,
  placedLayout,
  spanForWidth,
  type CanvasLayout,
  type CanvasUnit,
} from "@autograph/work-session-tools/layout";
import { UnitFrame } from "./unit-frame";
import type { CanvasOutcome, CanvasSession } from "./use-canvas-session";

/** Below this the units stop shrinking to fit and the plane scrolls instead. */
export const minReadableScale = 0.75;
const zoomRange = { min: 0.4, max: 1.6 };
const zoomStep = 1.2;
/** Space kept right of and below the furthest unit. */
const margin = 48;
/** A grid's left inset on the plane, and the narrowest it lays out (below it the plane scrolls). */
const gridInset = 24;
const minGridWidth = 640;
const minUnit = { w: 320, h: 200 };
/** Pointer travel before a press on a header becomes a move. */
const dragThreshold = 3;

/** The plane's size in plane units: its furthest unit plus the margin. */
export function planeBounds(layout: CanvasLayout) {
  return {
    w: Math.max(0, ...layout.units.map((unit) => unit.x + unit.w)) + margin,
    h: Math.max(0, ...layout.units.map((unit) => unit.y + unit.h)) + margin,
  };
}

/**
 * Fit-then-scroll: the scale at which the units fit the viewport, never above
 * 1 and never below the readable minimum (past which the plane scrolls).
 */
export function fitScale(bounds: { w: number; h: number }, viewport: { w: number; h: number }) {
  if (viewport.w <= 0 || viewport.h <= 0) return 1;
  const fit = Math.min(viewport.w / bounds.w, viewport.h / bounds.h, 1);
  return Math.max(minReadableScale, fit);
}

/** What the plane shows for one unit inside its frame. */
export type UnitView = {
  title: string;
  controls?: ReactNode;
  pins?: ReactNode;
  content: ReactNode;
  /** False when the frame offers no remove (the unit goes with what it shows). */
  removable?: boolean;
};

/**
 * A request to bring one unit into view: the plane centres the unit (zooming
 * to at least full size first when `zoom` is set) and flashes it, or centres
 * and flashes the element inside it that `flash` selects when that is
 * rendered. The flash starts once the scroll has settled. Cells `also`
 * selects anywhere on the plane flash with it. `scroll: false` flashes in
 * place, without scrolling (what it flashes is already on screen). A new
 * `nonce` asks again.
 */
export type PlaneFocus = {
  unitId: string;
  flash?: string;
  also?: readonly string[];
  zoom?: boolean;
  scroll?: boolean;
  nonce: number;
};

/** The longest a smooth focus scroll is waited on before its flash starts (when `scrollend` never comes). */
const scrollSettleMs = 600;

/** Whether the person asked for less motion: scrolls jump and flashes hold without fading. */
export function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

/** Whether `element` has a box on screen inside every one of `within` (when given). */
export function onScreen(element: Element, ...within: (Element | null | undefined)[]) {
  const box = element.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return false;
  return within.every((outer) => {
    if (outer === null || outer === undefined) return true;
    const area = outer.getBoundingClientRect();
    return (
      box.bottom > area.top &&
      box.top < area.bottom &&
      box.right > area.left &&
      box.left < area.right
    );
  });
}

/**
 * Flashes an element briefly: a ring around a unit, a tint inside a cell.
 * `data-canvas-flash` marks it meanwhile.
 */
export function flash(element: HTMLElement, kind: "unit" | "cell") {
  element.setAttribute("data-canvas-flash", "");
  const on =
    kind === "unit"
      ? {
          outline: "var(--ring-focus-width) solid var(--color-action-primary)",
          outlineOffset: "var(--space-1)",
          borderRadius: "var(--radius-panel)",
        }
      : {
          boxShadow: "inset 0 0 0 var(--ring-focus-width) var(--color-action-primary)",
          backgroundColor: "color-mix(in srgb, var(--color-action-primary) 16%, transparent)",
        };
  const off =
    kind === "unit"
      ? { ...on, outline: "var(--ring-focus-width) solid transparent" }
      : {
          boxShadow: "inset 0 0 0 var(--ring-focus-width) transparent",
          backgroundColor: "transparent",
        };
  // Held, then faded; with reduced motion only held, then gone.
  element.animate?.(
    prefersReducedMotion() ? [on, on] : [on, { ...on, offset: 0.6 }, off],
    prefersReducedMotion() ? { duration: 1800 } : { duration: 1800, easing: "ease-out" },
  );
  setTimeout(() => element.removeAttribute("data-canvas-flash"), 1800);
}

export type CanvasPlaneProps = {
  session: Pick<CanvasSession, "layout" | "beginLayoutGesture" | "moveLayout" | "commitLayout">;
  view: (unit: CanvasUnit) => UnitView;
  /** Hears the outcome of every layout save (move, resize, remove). */
  onLayoutSaved?: (
    outcome: CanvasOutcome,
    change: "move" | "resize" | "remove",
    unit: CanvasUnit,
  ) => void;
  /** Shown in the middle of the plane when it has no units. */
  empty?: ReactNode;
  /** The unit to bring into view, when asked. */
  focus?: PlaneFocus | null;
  /**
   * Content height (a chat's inline frame): the plane is as tall as its
   * units at a width-fitted scale, instead of filling and scrolling.
   */
  compact?: boolean;
};

type Gesture = {
  kind: "move" | "resize";
  unit: CanvasUnit;
  base: CanvasLayout;
  start: { x: number; y: number };
  scale: number;
  moved: boolean;
  last: CanvasLayout | null;
};

const roundUnit = (unit: CanvasUnit): CanvasUnit => ({
  ...unit,
  x: Math.round(unit.x),
  y: Math.round(unit.y),
  w: Math.round(unit.w),
  h: Math.round(unit.h),
});

/**
 * The canvas plane, the only dotted surface: the session's units at their
 * layout positions inside unit frames, at full size (the plane scrolls). A
 * grid layout (the default) places units in reading order: a unit resizes by
 * its corner, which sets its column span and height. A free layout moves a
 * unit by its header too. Zoom is view state, never saved; its buttons show
 * when the pointer is over the corner they sit in.
 */
export function CanvasPlane({
  session,
  view,
  onLayoutSaved,
  empty,
  focus,
  compact = false,
}: CanvasPlaneProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  /** null follows the fit; a number is the user's zoom. A compact plane has no zoom: it fits its width. */
  const [userZoom, setZoom] = useState<number | null>(1);
  const zoom = compact ? null : userZoom;
  /** The scale a drag or resize started at, held until it drops so the unit tracks the pointer. */
  const [gestureScale, setGestureScale] = useState<number | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const savedRef = useRef(onLayoutSaved);
  savedRef.current = onLayoutSaved;

  useEffect(() => {
    const element = viewportRef.current;
    if (element === null) return;
    const measure = () => setViewport({ w: element.clientWidth, h: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const stored = session.layout;
  const grid = isGridLayout(stored);
  // A grid is laid out across the width the canvas has (at the user's zoom),
  // so no unit runs off its right edge; it re-flows as the window resizes.
  const frameWidth =
    grid && viewport.w > 0
      ? Math.max(minGridWidth, viewport.w / (zoom ?? 1) - gridInset - margin - 1)
      : null;
  const layout = useMemo(
    () => (frameWidth === null ? stored : placeGrid(stored, { x: gridInset, width: frameWidth })),
    [stored, frameWidth],
  );
  const frameWidthRef = useRef(frameWidth);
  frameWidthRef.current = frameWidth;
  const bounds = planeBounds(layout);
  const fit = compact
    ? viewport.w <= 0
      ? 1
      : Math.min(1, viewport.w / bounds.w)
    : fitScale(bounds, viewport);
  const scale = gestureScale ?? zoom ?? fit;

  // A focus request zooms to at least full size, then centres and flashes once laid out.
  const pendingFocus = useRef<PlaneFocus | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  useEffect(() => {
    if (focus === null || focus === undefined) return;
    pendingFocus.current = focus;
    if (focus.zoom === true && scale < 1) setZoom(1);
    setFocusTick((tick) => tick + 1);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- a new nonce is a new request.
  }, [focus?.nonce]);
  useLayoutEffect(() => {
    const request = pendingFocus.current;
    const element = viewportRef.current;
    if (request === null || element === null) return;
    pendingFocus.current = null;
    const unit = layout.units.find((item) => item.id === request.unitId);
    const box = element.querySelector<HTMLElement>(
      `[data-unit-box="${CSS.escape(request.unitId)}"]`,
    );
    if (unit === undefined || box === null) return;
    const scrolls = request.scroll !== false;
    const smooth = !prefersReducedMotion();
    /** Scrolls the plane to `left`/`top`; whether it moves at all. */
    const scrollPlane = (left: number, top: number) => {
      const to = { left: Math.max(0, left), top: Math.max(0, top) };
      const moves =
        Math.abs(to.left - element.scrollLeft) > 1 || Math.abs(to.top - element.scrollTop) > 1;
      if (moves) element.scrollTo?.({ ...to, behavior: smooth ? "smooth" : "auto" });
      return moves;
    };
    // The unit centred (its top first when it is taller than the viewport).
    const toUnit = () =>
      scrollPlane(
        (unit.x + unit.w / 2) * scale - element.clientWidth / 2,
        unit.y * scale - Math.max(0, element.clientHeight - unit.h * scale) / 2,
      );
    // A cell centred in the viewport (the table has already centred it in itself).
    const toCell = (cell: HTMLElement) => {
      const at = cell.getBoundingClientRect();
      const view = element.getBoundingClientRect();
      return scrollPlane(
        element.scrollLeft + at.left + at.width / 2 - view.left - element.clientWidth / 2,
        element.scrollTop + at.top + at.height / 2 - view.top - element.clientHeight / 2,
      );
    };
    // The flash starts once the scroll has settled, so it is seen whole.
    const settled = (moved: boolean, then: () => void) => {
      if (!moved || !smooth) {
        then();
        return;
      }
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        element.removeEventListener("scrollend", finish);
        then();
      };
      element.addEventListener("scrollend", finish);
      // Where scrollend never fires (no scroll happened, an older engine), a settle time.
      const timer = setTimeout(finish, scrollSettleMs);
    };
    const selector = request.flash;
    const also = request.also ?? [];
    if (selector === undefined && also.length === 0) {
      settled(scrolls && toUnit(), () => flash(box, "unit"));
      return;
    }
    // The table may re-render its rows as the plane settles; the cells are found after that.
    setTimeout(() => {
      const inner = selector === undefined ? null : box.querySelector<HTMLElement>(selector);
      const moved = scrolls && (inner === null ? toUnit() : toCell(inner));
      settled(moved, () => {
        const shown = selector === undefined ? null : box.querySelector<HTMLElement>(selector);
        const cells = new Set<HTMLElement>(shown === null ? [] : [shown]);
        for (const other of also)
          for (const cell of element.querySelectorAll<HTMLElement>(other)) cells.add(cell);
        if (cells.size === 0) flash(box, "unit");
        for (const cell of cells) flash(cell, "cell");
      });
    }, 120);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- runs once per request, after its zoom applies.
  }, [focusTick, scale]);
  const zoomTo = (next: number) =>
    setZoom(Math.min(zoomRange.max, Math.max(zoomRange.min, Math.round(next * 100) / 100)));

  const start = (kind: Gesture["kind"], unit: CanvasUnit, event: PointerEvent<HTMLElement>) => {
    event.preventDefault();
    gesture.current = {
      kind,
      unit,
      base: sessionRef.current.layout,
      start: { x: event.clientX, y: event.clientY },
      scale,
      moved: false,
      last: null,
    };
    setGestureScale(scale);
    const onMove = (move: globalThis.PointerEvent) => {
      const live = gesture.current;
      if (live === null) return;
      const dx = (move.clientX - live.start.x) / live.scale;
      const dy = (move.clientY - live.start.y) / live.scale;
      if (!live.moved) {
        if (Math.hypot(dx * live.scale, dy * live.scale) < dragThreshold) return;
        live.moved = true;
        // The layout may have changed since the press (an agent's rule card
        // placed): the drag moves the unit within the layout as it is now.
        live.base = sessionRef.current.layout;
        sessionRef.current.beginLayoutGesture();
      }
      const sized = {
        w: Math.max(minUnit.w, live.unit.w + dx),
        // A unit already shorter than the minimum (a KPI strip) keeps its height.
        h: Math.max(Math.min(minUnit.h, live.unit.h), live.unit.h + dy),
      };
      // On a grid a resize sets the unit's span (its width in columns) and
      // height; the span keeps at least one column, not the free minimum width.
      const next: CanvasUnit =
        live.kind === "move"
          ? { ...live.unit, x: Math.max(0, live.unit.x + dx), y: Math.max(0, live.unit.y + dy) }
          : isGridLayout(live.base)
            ? {
                ...live.unit,
                span: spanForWidth(
                  Math.max(1, live.unit.w + dx),
                  live.base.grid ?? defaultGrid,
                  frameWidthRef.current ?? undefined,
                ),
                h: sized.h,
              }
            : { ...live.unit, ...sized };
      live.last = placedLayout({
        ...live.base,
        units: live.base.units.map((item) => (item.id === live.unit.id ? roundUnit(next) : item)),
      });
      sessionRef.current.moveLayout(live.last);
    };
    const onEnd = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onEnd);
      document.removeEventListener("pointercancel", onEnd);
      const live = gesture.current;
      gesture.current = null;
      setGestureScale(null);
      if (live?.moved !== true || live.last === null) return;
      const moved = live.last.units.find((item) => item.id === live.unit.id);
      if (moved === undefined) return;
      void sessionRef.current
        .commitLayout((current) => ({
          ...current,
          units: current.units.map((item) => (item.id === moved.id ? moved : item)),
        }))
        .then((outcome) => savedRef.current?.(outcome, live.kind, live.unit));
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onEnd);
    document.addEventListener("pointercancel", onEnd);
  };

  const remove = (unit: CanvasUnit) => {
    void sessionRef.current
      .commitLayout((current) => ({
        ...current,
        units: current.units.filter((item) => item.id !== unit.id),
      }))
      .then((outcome) => savedRef.current?.(outcome, "remove", unit));
  };

  const dots = 24 * scale;
  return (
    <div
      className={
        compact
          ? "flex min-w-[var(--space-0)] flex-col"
          : "flex min-h-[var(--space-0)] min-w-[var(--space-0)] flex-1 flex-col"
      }
      data-canvas-gesture={gestureScale === null ? undefined : ""}
      data-canvas-plane
      data-layout-mode={grid ? "grid" : "free"}
    >
      <div className={compact ? "relative flex" : "relative flex min-h-[var(--space-0)] flex-1"}>
        <div
          aria-label="Canvas"
          className={
            compact
              ? "min-w-[var(--space-0)] flex-1 overflow-x-hidden"
              : "min-h-[var(--space-0)] min-w-[var(--space-0)] flex-1 overflow-auto"
          }
          data-scale={scale.toFixed(2)}
          ref={viewportRef}
          role="region"
        >
          <div
            className="relative bg-[var(--color-bg-canvas-grid)]"
            style={{
              width: Math.max(bounds.w * scale, viewport.w),
              height: compact ? bounds.h * scale : Math.max(bounds.h * scale, viewport.h),
              backgroundImage:
                "radial-gradient(circle, var(--color-canvas-grid-dot) 1px, transparent 1px)",
              backgroundSize: `${dots}px ${dots}px`,
            }}
          >
            {layout.units.length === 0 && empty !== undefined ? (
              <div className="absolute inset-[var(--space-0)] flex items-center justify-center p-[var(--space-6)]">
                {empty}
              </div>
            ) : null}
            <div
              className="absolute left-[var(--space-0)] top-[var(--space-0)] origin-top-left"
              style={{ width: bounds.w, height: bounds.h, transform: `scale(${scale})` }}
            >
              {layout.units.map((unit) => {
                const shown = view(unit);
                return (
                  <div
                    className="absolute"
                    data-unit-box={unit.id}
                    key={unit.id}
                    style={{ left: unit.x, top: unit.y, width: unit.w, height: unit.h }}
                  >
                    <UnitFrame
                      className="shadow-[var(--shadow-raised)]"
                      controls={shown.controls}
                      pins={shown.pins}
                      title={shown.title}
                      unitId={unit.id}
                      onMoveStart={grid ? undefined : (event) => start("move", unit, event)}
                      onRemove={shown.removable === false ? undefined : () => remove(unit)}
                    >
                      {shown.content}
                    </UnitFrame>
                    <div
                      aria-label={`Resize ${shown.title}`}
                      className="absolute bottom-[var(--space-0)] right-[var(--space-0)] z-[2] flex size-[var(--space-4)] cursor-nwse-resize touch-none items-end justify-end p-[var(--space-0-5)] text-[var(--color-text-disabled)] hover:text-[var(--color-text-muted)]"
                      data-resize-handle={unit.id}
                      role="separator"
                      onPointerDown={(event) => {
                        if (event.button !== 0) return;
                        event.stopPropagation();
                        start("resize", unit, event);
                      }}
                    >
                      <svg aria-hidden fill="none" height="8" viewBox="0 0 8 8" width="8">
                        <path
                          d="M7 1L1 7M7 4.5L4.5 7"
                          stroke="currentColor"
                          strokeLinecap="round"
                          strokeWidth="1.2"
                        />
                      </svg>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        {layout.units.length === 0 || compact ? null : (
          <div
            aria-label="Canvas zoom"
            className="absolute bottom-[var(--space-3)] right-[var(--space-3)] z-[3] flex shrink-0 items-center opacity-0 shadow-[var(--shadow-control)] transition-opacity focus-within:opacity-100 hover:opacity-100 gap-[var(--space-0-5)] rounded-[var(--radius-control)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-[var(--space-0-5)]"
            role="group"
          >
            <Button
              aria-label="Zoom out"
              disabled={scale <= zoomRange.min}
              intent="ghost"
              size="xs"
              title="Zoom out"
              onClick={() => zoomTo(scale / zoomStep)}
            >
              <Minus aria-hidden className="size-[var(--size-icon-sm)]" />
            </Button>
            <span
              className="min-w-[var(--size-control-lg)] text-center text-[length:var(--text-caption)] tabular-nums text-[var(--color-text-secondary)]"
              data-zoom-level
            >
              {Math.round(scale * 100)}%
            </span>
            <Button
              aria-label="Zoom in"
              disabled={scale >= zoomRange.max}
              intent="ghost"
              size="xs"
              title="Zoom in"
              onClick={() => zoomTo(scale * zoomStep)}
            >
              <Plus aria-hidden className="size-[var(--size-icon-sm)]" />
            </Button>
            <Button
              aria-label="Fit to view"
              disabled={zoom === null}
              intent="ghost"
              size="xs"
              title="Fit to view"
              onClick={() => setZoom(null)}
            >
              <ArrowsPointingIn aria-hidden className="size-[var(--size-icon-sm)]" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
