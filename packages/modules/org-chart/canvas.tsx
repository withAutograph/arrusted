// Read-only org-chart canvas: pan/zoom, expand/collapse, focused fit, and
// connector rendering. Apps provide the card renderer through `renderNode`.

import {
  Fragment,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";

import { ArrowsPointingIn, Minus, Plus } from "@autograph/icons";

import "./canvas.css";
import {
  buildExpandFocusNodeIds,
  computeBoundsForNodes,
  computeViewportForBounds,
  computeViewportForBoundsAtScale,
  type CanvasSize,
  type ViewportState,
} from "./canvas-camera";
import { useOrgChartLayout } from "./layout";

import type {
  OrgChartLayoutBounds,
  OrgChartLayoutDirection,
  OrgChartLayoutNode,
  OrgChartPositionedLayout,
  OrgChartLink,
  OrgChartNode,
} from "./layout";
import type { NodeActivateOptions, OrgChartAtom, OrgChartNodeActivatePayload } from "./types";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Imperative handle exposed by the canvas. Keep this read-only: app write
 * surfaces live outside this module.
 */
export type ChartInstanceHandle = {
  expandAll: () => void;
  collapseAll: () => void;
};

/** Layout-stage view of a node, plus motion state — what `renderNode`
 *  receives so apps can derive their card props from it. */
export type ChartRenderNode = OrgChartLayoutNode & {
  motionState?: "stable";
};

/** Derived state the canvas passes to renderNode. Apps map this onto
 *  their leaf primitive's state (e.g. NodeCard's `state` prop). */
export type ChartRenderDerivedState = {
  motionState: "stable";
  isFocused: boolean;
  isDimmed: boolean;
};

export type ChartRenderNodeFn = (
  node: ChartRenderNode,
  derived: ChartRenderDerivedState,
) => React.ReactNode;

/** Raw, host-supplied chart data consumed by the layout. */
export type OrgChartData = {
  key: string;
  label: string | null;
  nodes: OrgChartNode[];
  links: OrgChartLink[];
};

type ExpandedNodesState = {
  key: string;
  nodes: Set<string>;
  pendingFocus: PendingExpandFocus | null;
};

type PendingExpandFocus =
  | { type: "expand"; nodeId: string }
  | { type: "collapse"; nodeId: string }
  | { type: "all" };

export type OrgChartCanvasProps = {
  ref?: Ref<ChartInstanceHandle>;
  data: OrgChartData;
  onNodeActivate: (payload: OrgChartNodeActivatePayload) => void;
  /** Host-owned renderer for each node. See module README for adapter shape. */
  renderNode: ChartRenderNodeFn;
  /** Field list the layout threads into per-node data for the renderer. */
  visibleFields: string[];
  /** Date string the layout threads into per-node data for the renderer. */
  asOfDate: string;
  /** When true, nodes whose `matchesFilter` is false render dimmed. */
  filterActive: boolean;
  /** Switches the layout to the taller "slot card" row heights. */
  showSlots: boolean;
  /** Per-slot atom lookup the layout reads to attach `slotData`. */
  slotMap?: Map<string, OrgChartAtom>;
  /** When set, ancestors of these nodes are auto-expanded and the camera frames them. */
  focusNodeIds?: string[];
  /** Set of node ids the host considers "focused" — drives renderNode's `isFocused`. */
  focusedNodeIds?: Set<string>;
  /** Callback to clear focusNodeIds after they have been consumed. */
  onFocusConsumed?: () => void;
  /** Axis the tree grows along. Defaults to `top-to-bottom`. */
  direction?: OrgChartLayoutDirection;
  /** Fixed box for every node; omit for the built-in card sizes. */
  nodeSize?: { width: number; height: number };
  /** Gap between siblings along the sibling axis; omit for the direction's default. */
  siblingGap?: number;
  /**
   * Pre-positioned layout. When set, the canvas renders it as-is and does
   * not lay out `data.nodes` / `data.links`; `data.key` still identifies the
   * chart, so a new key re-fits the camera.
   */
  layout?: OrgChartPositionedLayout;
  /** Largest scale an automatic fit may choose. Defaults to 2. */
  fitMaxScale?: number;
  /** Padding around the chart for the initial and reset fits. Defaults to 120. */
  fitPaddingPx?: number;
  /**
   * Opt in to re-fitting when the container resizes: debounced, instant (no
   * zoom animation), and only when the chart no longer fits or the size
   * changed meaningfully. Off by default.
   */
  refitOnResize?: boolean;
  /**
   * Host-drawn extras in chart coordinates (for example a frame around a
   * group of cards). They paint above connectors and below the cards they
   * precede, and each sits immediately before its `beforeNodeId` node in
   * DOM and tab order. Mark interactive parts with
   * `data-org-chart-control="true"` so pressing them does not pan.
   */
  decorations?: readonly OrgChartCanvasDecoration[];
  /**
   * How the chart first opens (and re-opens after a meaningful resize when
   * `refitOnResize` is set). Defaults to fitting the whole chart. The
   * "Fit chart" control always fits the whole chart.
   */
  initialView?: OrgChartInitialView;
  /**
   * "canvas" (the default) is a surface of its own: a page-coloured fill,
   * the dotted grid and boxed zoom controls. "flat" draws no fill and no
   * grid, with small unboxed zoom controls, so the chart reads as content on
   * whatever surface hosts it (a card or a page panel).
   */
  surface?: "canvas" | "flat";
};

export type OrgChartInitialView =
  | { kind: "fit" }
  /** Centre one node at a fixed scale, cropping whatever does not fit. */
  | { kind: "centre-on-node"; nodeId: string; scale: number };

export type OrgChartCanvasDecoration = {
  /** Unique among decorations. */
  id: string;
  /** The node this decoration precedes. Decorations for unknown nodes are not rendered. */
  beforeNodeId: string;
  /** Absolutely positioned content, in chart coordinates. */
  element: React.ReactNode;
};

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

// Auto-fit deliberately allows scale < 1 — clamping higher (e.g. 1)
// clips root cards in the closed-pullout state where 4 × 240px cards
// plus INITIAL_FIT_PADDING_PX don't fit at scale 1. The proper fix
// (suppress re-fit on container resize so user's viewport persists) is
// documented as deferred work in docs/known-footguns.md "App Shell
// Pullouts" → "Watch: org-chart canvas does not re-fit when its
// container resizes."
const MIN_SCALE = 0.25;
const MAX_SCALE = 2;
const INITIAL_FIT_PADDING_PX = 120;
const EXPAND_FIT_PADDING_PX = 80;
// The initial fit is rendered with content hidden, so animating to it would
// just show an animation-from-nowhere on first paint. Snap to it instead;
// subsequent fits (expand/collapse, reset) keep the smoother transition.
const INITIAL_FIT_DURATION = 0;
const EXPAND_FIT_DURATION = 260;
const CAMERA_EPSILON = 0.001;
const RESIZE_REFIT_DEBOUNCE_MS = 150;
/** A container change larger than this fraction of either side re-fits. */
const RESIZE_REFIT_MIN_CHANGE = 0.1;
/** The zoom controls' left offset plus width (see canvas.css), and a gap. */
const ZOOM_CONTROLS_GAP_PX = 16;
const ZOOM_CONTROLS_INSET_PX = 16 + 34 + ZOOM_CONTROLS_GAP_PX;

// -----------------------------------------------------------------------------
// useElementSize
// -----------------------------------------------------------------------------

function useElementSize(ref: React.RefObject<HTMLElement | null>): CanvasSize {
  const [size, setSize] = useState<CanvasSize>({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const width = Math.max(entry.contentRect.width, 0);
      const height = Math.max(entry.contentRect.height, 0);
      setSize((current) =>
        current.width === width && current.height === height ? current : { width, height },
      );
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return size;
}

// -----------------------------------------------------------------------------
// OrgChartCanvas
// -----------------------------------------------------------------------------

const EMPTY_SLOT_MAP: Map<string, OrgChartAtom> = new Map();
const EMPTY_FOCUS_NODE_IDS: string[] = [];
const EMPTY_EXPANDED_NODES = new Set<string>();
const EMPTY_DATA_NODES: OrgChartNode[] = [];
const EMPTY_DATA_LINKS: OrgChartLink[] = [];

export function OrgChartCanvas({
  ref,
  data,
  onNodeActivate,
  renderNode,
  visibleFields,
  asOfDate,
  filterActive,
  showSlots,
  slotMap = EMPTY_SLOT_MAP,
  focusNodeIds = EMPTY_FOCUS_NODE_IDS,
  focusedNodeIds,
  onFocusConsumed,
  direction,
  nodeSize,
  siblingGap,
  layout,
  fitMaxScale,
  fitPaddingPx,
  refitOnResize = false,
  decorations,
  initialView,
  surface = "canvas",
}: OrgChartCanvasProps) {
  return useOrgChartCanvasElement({
    ref,
    data,
    onNodeActivate,
    renderNode,
    visibleFields,
    asOfDate,
    filterActive,
    showSlots,
    slotMap,
    focusNodeIds,
    focusedNodeIds,
    onFocusConsumed,
    direction,
    nodeSize,
    siblingGap,
    layout,
    fitMaxScale,
    fitPaddingPx,
    refitOnResize,
    decorations,
    initialView,
    surface,
  });
}

function useOrgChartCanvasElement({
  ref,
  data,
  onNodeActivate,
  renderNode,
  visibleFields,
  asOfDate,
  filterActive,
  showSlots,
  slotMap = EMPTY_SLOT_MAP,
  focusNodeIds = EMPTY_FOCUS_NODE_IDS,
  focusedNodeIds,
  onFocusConsumed,
  direction,
  nodeSize,
  siblingGap,
  layout,
  fitMaxScale,
  fitPaddingPx,
  refitOnResize = false,
  decorations,
  initialView,
  surface = "canvas",
}: OrgChartCanvasProps) {
  const decorationsByNode = useMemo(() => {
    const byNode = new Map<string, OrgChartCanvasDecoration[]>();
    for (const decoration of decorations ?? []) {
      byNode.set(decoration.beforeNodeId, [
        ...(byNode.get(decoration.beforeNodeId) ?? []),
        decoration,
      ]);
    }
    return byNode;
  }, [decorations]);

  const expansionKey = useMemo(() => {
    if (!filterActive) return `data:${data.key}`;
    const matchingNodeIds: string[] = [];
    for (const node of data.nodes) {
      if (node.matchesFilter ?? true) {
        matchingNodeIds.push(node.id);
      }
    }
    matchingNodeIds.sort();
    return `filter:${data.key}:${matchingNodeIds.join("|")}`;
  }, [data.key, data.nodes, filterActive]);

  // Filter-driven expansion is derived. User expand/collapse operations store
  // an override for the active expansion key, so stale overrides self-evict.
  const filterExpandedNodes = useMemo(() => {
    if (!filterActive) return EMPTY_EXPANDED_NODES;
    const matchingIds = data.nodes.filter((node) => node.matchesFilter ?? true);
    if (matchingIds.length === 0) return EMPTY_EXPANDED_NODES;

    const map = new Map<string, string>();
    for (const link of data.links) {
      map.set(link.to, link.from);
    }

    const next = new Set<string>();
    for (const match of matchingIds) {
      let current: string | undefined = match.id;
      const seen = new Set<string>();
      while (current) {
        if (seen.has(current)) break;
        seen.add(current);
        next.add(current);
        current = map.get(current);
      }
    }
    return next;
  }, [data.links, data.nodes, filterActive]);

  const [expandedNodesState, setExpandedNodesState] = useState<ExpandedNodesState>(() => ({
    key: "",
    nodes: EMPTY_EXPANDED_NODES,
    pendingFocus: null,
  }));
  if (!filterActive && expandedNodesState.key.startsWith("filter:")) {
    setExpandedNodesState({
      key: "",
      nodes: EMPTY_EXPANDED_NODES,
      pendingFocus: null,
    });
  }
  const expandedNodes =
    expandedNodesState.key === expansionKey ? expandedNodesState.nodes : filterExpandedNodes;
  const focusNodeIdsKey = focusNodeIds.join("|");
  const layoutExpandedNodes = useMemo(() => {
    if (!focusNodeIdsKey) return expandedNodes;

    const parentByChildId = new Map<string, string>();
    for (const link of data.links) {
      parentByChildId.set(link.to, link.from);
    }

    const next = new Set(expandedNodes);
    for (const focusNodeId of focusNodeIds) {
      next.add(focusNodeId);
      let current = parentByChildId.get(focusNodeId);
      const seen = new Set<string>([focusNodeId]);
      while (current) {
        if (seen.has(current)) break;
        seen.add(current);
        next.add(current);
        current = parentByChildId.get(current);
      }
    }
    return next;
  }, [data.links, expandedNodes, focusNodeIds, focusNodeIdsKey]);
  const pendingExpandFocus =
    expandedNodesState.key === expansionKey ? expandedNodesState.pendingFocus : null;
  const expandedNodesRef = useRef<Set<string>>(EMPTY_EXPANDED_NODES);
  const [viewport, setViewport] = useState<ViewportState>({
    x: 0,
    y: 0,
    scale: 1,
  });
  const [isPanning, setIsPanning] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasSize = useElementSize(containerRef);
  const animationFrameRef = useRef<number | null>(null);
  const viewportRef = useRef<ViewportState>(viewport);
  const panStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const initialFitDoneKeyRef = useRef<string | null>(null);
  // Container size at the most recent automatic fit (resize re-fit only).
  const lastFitSizeRef = useRef<CanvasSize | null>(null);
  // The last container size a resize decision was made for, whether or not it
  // re-fitted, so unrelated rerenders never replay a resize already handled.
  const handledResizeSizeRef = useRef<CanvasSize | null>(null);
  // Drives the content layer's opacity: stays hidden until the initial fit
  // has been committed so the user never sees the un-fit (scale=1, top-left)
  // frame between mount and the first fit effect firing.
  const [initialFitAppliedKey, setInitialFitAppliedKey] = useState<string | null>(null);
  const initialFitApplied = initialFitAppliedKey === data.key;

  const allNodeIds = useMemo(() => data.nodes.map((node) => node.id), [data.nodes]);

  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);

  useEffect(() => {
    expandedNodesRef.current = expandedNodes;
  }, [expandedNodes]);

  useLayoutEffect(() => {
    if (!filterActive || filterExpandedNodes.size > 0) return;
    if (expandedNodesRef.current.size === 0) return;

    setExpandedNodesState((current) => {
      if (
        current.key === expansionKey &&
        current.nodes.size === 0 &&
        current.pendingFocus?.type === "all"
      ) {
        return current;
      }
      return {
        key: expansionKey,
        nodes: EMPTY_EXPANDED_NODES,
        pendingFocus: { type: "all" },
      };
    });
  }, [expansionKey, filterActive, filterExpandedNodes]);

  const handleExpandToggle = useCallback(
    (nodeId: string) => {
      const prev = expandedNodesRef.current;
      const isExpanded = prev.has(nodeId);
      const next = new Set(prev);
      if (isExpanded) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      expandedNodesRef.current = next;
      setExpandedNodesState({
        key: expansionKey,
        nodes: next,
        pendingFocus: isExpanded ? { type: "collapse", nodeId } : { type: "expand", nodeId },
      });
    },
    [expansionKey],
  );

  const handleExpandAll = useCallback(() => {
    const next = new Set(allNodeIds);
    expandedNodesRef.current = next;
    setExpandedNodesState({
      key: expansionKey,
      nodes: next,
      pendingFocus: { type: "all" },
    });
  }, [allNodeIds, expansionKey]);

  const handleCollapseAll = useCallback(() => {
    const next = new Set<string>();
    expandedNodesRef.current = next;
    setExpandedNodesState({
      key: expansionKey,
      nodes: next,
      pendingFocus: { type: "all" },
    });
  }, [expansionKey]);

  const computedLayout = useOrgChartLayout(
    layout ? EMPTY_DATA_NODES : data.nodes,
    layout ? EMPTY_DATA_LINKS : data.links,
    layoutExpandedNodes,
    visibleFields,
    asOfDate,
    filterActive,
    showSlots,
    // Insights are out of scope for this read-only canvas.
    false,
    slotMap,
    { direction, nodeSize, siblingGap },
  );
  const { parentMap, childrenMap } = computedLayout;
  const layoutNodes = layout?.nodes ?? computedLayout.nodes;
  const edges = layout?.edges ?? computedLayout.edges;
  const bounds = layout?.bounds ?? computedLayout.bounds;
  const resolvedFitMaxScale = fitMaxScale ?? MAX_SCALE;
  const resolvedFitPaddingPx = fitPaddingPx ?? INITIAL_FIT_PADDING_PX;

  // Frame externally focused nodes once per focus request. Expansion is
  // derived in `layoutExpandedNodes`, so the prop request does not need a
  // local state adjustment effect.
  const prevFocusNodeIdsKeyRef = useRef<string | null>(null);

  // The host renderer cannot attach these layout-level handlers itself.
  const nodesWithState = useMemo(() => {
    return layoutNodes.map((node) => {
      return {
        ...node,
        data: {
          ...node.data,
          onClick:
            node.data.isVirtualRoot || node.data.interactive === false
              ? undefined
              : ({ append }: NodeActivateOptions) =>
                  onNodeActivate({
                    nodeId: node.id,
                    subjectId: node.data.subjectId ?? null,
                    slotId: node.data.slotId ?? null,
                    nodeKind: node.data.nodeKind,
                    isVirtualRoot: node.data.isVirtualRoot,
                    append,
                  }),
          onExpandToggle: node.data.canCollapse ? () => handleExpandToggle(node.id) : undefined,
        },
      } satisfies OrgChartLayoutNode;
    });
  }, [layoutNodes, onNodeActivate, handleExpandToggle]);

  const stopCameraAnimation = useCallback(() => {
    if (animationFrameRef.current != null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
  }, []);

  const animateViewportTo = useCallback(
    (next: ViewportState, durationMs: number) => {
      const current = viewportRef.current;
      if (
        Math.abs(current.x - next.x) < CAMERA_EPSILON &&
        Math.abs(current.y - next.y) < CAMERA_EPSILON &&
        Math.abs(current.scale - next.scale) < CAMERA_EPSILON
      ) {
        return;
      }

      stopCameraAnimation();

      if (durationMs <= 0) {
        setViewport(next);
        return;
      }

      const start = performance.now();
      const from = viewportRef.current;

      const tick = (now: number) => {
        const t = clamp((now - start) / durationMs, 0, 1);
        const eased = 1 - Math.pow(1 - t, 3);

        setViewport({
          x: from.x + (next.x - from.x) * eased,
          y: from.y + (next.y - from.y) * eased,
          scale: from.scale + (next.scale - from.scale) * eased,
        });

        animationFrameRef.current = t < 1 ? requestAnimationFrame(tick) : null;
      };

      animationFrameRef.current = requestAnimationFrame(tick);
    },
    [stopCameraAnimation],
  );

  const fitToBounds = useCallback(
    (targetBounds: OrgChartLayoutBounds, durationMs: number, paddingPx: number) => {
      if (canvasSize.width <= 0 || canvasSize.height <= 0) return;
      const next = computeViewportForBounds({
        bounds: targetBounds,
        canvas: canvasSize,
        minScale: MIN_SCALE,
        maxScale: resolvedFitMaxScale,
        paddingPx,
      });
      animateViewportTo(next, durationMs);
    },
    [animateViewportTo, canvasSize, resolvedFitMaxScale],
  );

  const fitToNodes = useCallback(
    (targetNodes: OrgChartLayoutNode[], durationMs: number, paddingPx: number) => {
      fitToBounds(computeBoundsForNodes(targetNodes), durationMs, paddingPx);
    },
    [fitToBounds],
  );

  const centerOnNodesAtCurrentScale = useCallback(
    (targetNodes: OrgChartLayoutNode[], durationMs: number) => {
      if (targetNodes.length === 0 || canvasSize.width <= 0 || canvasSize.height <= 0) {
        return;
      }
      const next = computeViewportForBoundsAtScale({
        bounds: computeBoundsForNodes(targetNodes),
        canvas: canvasSize,
        scale: viewportRef.current.scale,
        minScale: MIN_SCALE,
        maxScale: MAX_SCALE,
      });
      animateViewportTo(next, durationMs);
    },
    [animateViewportTo, canvasSize],
  );

  // The opening view: fit the whole chart, or centre one node at a fixed
  // scale when the host asks for it and the node is present.
  const openInitialView = useCallback(() => {
    if (initialView?.kind === "centre-on-node") {
      const node = nodesWithState.find((candidate) => candidate.id === initialView.nodeId);
      if (node && canvasSize.width > 0 && canvasSize.height > 0) {
        // Centre the node in the area right of the zoom controls, then nudge
        // the chart right so it does not start under them, as far as the
        // node itself stays in view.
        const inset = Math.min(ZOOM_CONTROLS_INSET_PX, canvasSize.width / 4);
        const free = { width: canvasSize.width - inset, height: canvasSize.height };
        const view = computeViewportForBoundsAtScale({
          bounds: computeBoundsForNodes([node]),
          canvas: free,
          scale: initialView.scale,
          minScale: MIN_SCALE,
          maxScale: MAX_SCALE,
        });
        const x = view.x + inset;
        const chartLeft = bounds.minX * view.scale + x;
        const nodeRight = (node.x + node.width) * view.scale + x;
        const nudge = Math.max(
          0,
          Math.min(inset - chartLeft, canvasSize.width - ZOOM_CONTROLS_GAP_PX - nodeRight),
        );
        animateViewportTo({ ...view, x: x + nudge }, INITIAL_FIT_DURATION);
        return;
      }
    }
    fitToBounds(bounds, INITIAL_FIT_DURATION, resolvedFitPaddingPx);
  }, [
    animateViewportTo,
    bounds,
    canvasSize,
    fitToBounds,
    initialView,
    nodesWithState,
    resolvedFitPaddingPx,
  ]);

  useImperativeHandle(
    ref,
    () => ({
      expandAll: handleExpandAll,
      collapseAll: handleCollapseAll,
    }),
    [handleExpandAll, handleCollapseAll],
  );

  // oxlint-disable-next-line react-doctor/no-derived-state-effect -- the reveal flag must follow the imperative fit committed in this layout effect; deriving it during render would paint one un-fit frame.
  useLayoutEffect(() => {
    if (
      initialFitDoneKeyRef.current === data.key ||
      nodesWithState.length === 0 ||
      canvasSize.width <= 0 ||
      canvasSize.height <= 0
    ) {
      return;
    }

    initialFitDoneKeyRef.current = data.key;
    lastFitSizeRef.current = canvasSize;
    handledResizeSizeRef.current = canvasSize;
    openInitialView();
    // Reveal the content layer once the fit viewport has been committed.
    // INITIAL_FIT_DURATION is 0 so this paints on the same flush as the
    // viewport update, avoiding any visible un-fit frame.
    setInitialFitAppliedKey(data.key);
  }, [canvasSize, data.key, nodesWithState.length, openInitialView]);

  useEffect(() => {
    if (!refitOnResize || initialFitDoneKeyRef.current !== data.key) return;
    const last = lastFitSizeRef.current;
    const handled = handledResizeSizeRef.current;
    if (!last || canvasSize.width <= 0 || canvasSize.height <= 0) return;
    if (handled && handled.width === canvasSize.width && handled.height === canvasSize.height) {
      return;
    }

    const timer = window.setTimeout(() => {
      handledResizeSizeRef.current = canvasSize;
      const view = viewportRef.current;
      const fits =
        bounds.minX * view.scale + view.x >= 0 &&
        bounds.minY * view.scale + view.y >= 0 &&
        bounds.maxX * view.scale + view.x <= canvasSize.width &&
        bounds.maxY * view.scale + view.y <= canvasSize.height;
      const changedMeaningfully =
        Math.abs(canvasSize.width - last.width) > last.width * RESIZE_REFIT_MIN_CHANGE ||
        Math.abs(canvasSize.height - last.height) > last.height * RESIZE_REFIT_MIN_CHANGE;
      // A centred view crops on purpose, so only a meaningful size change
      // re-opens it.
      if ((fits || initialView?.kind === "centre-on-node") && !changedMeaningfully) return;
      lastFitSizeRef.current = canvasSize;
      openInitialView();
    }, RESIZE_REFIT_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [bounds, canvasSize, data.key, initialView?.kind, openInitialView, refitOnResize]);

  useLayoutEffect(() => {
    if (!pendingExpandFocus || nodesWithState.length === 0) {
      return;
    }

    if (pendingExpandFocus.type === "all") {
      fitToBounds(bounds, EXPAND_FIT_DURATION, EXPAND_FIT_PADDING_PX);
      setExpandedNodesState((current) =>
        current.pendingFocus === pendingExpandFocus ? { ...current, pendingFocus: null } : current,
      );
      return;
    }

    if (pendingExpandFocus.type === "collapse") {
      const collapsedNode = nodesWithState.find((node) => node.id === pendingExpandFocus.nodeId);
      if (collapsedNode) {
        centerOnNodesAtCurrentScale([collapsedNode], EXPAND_FIT_DURATION);
      }
      setExpandedNodesState((current) =>
        current.pendingFocus === pendingExpandFocus ? { ...current, pendingFocus: null } : current,
      );
      return;
    }

    const focusNodeIdsLocal = buildExpandFocusNodeIds({
      nodeId: pendingExpandFocus.nodeId,
      parentMap,
      childrenMap,
    });

    const focusNodes = nodesWithState.filter((node) => focusNodeIdsLocal.has(node.id));
    if (focusNodes.length > 0) {
      fitToNodes(focusNodes, EXPAND_FIT_DURATION, EXPAND_FIT_PADDING_PX);
    }
    setExpandedNodesState((current) =>
      current.pendingFocus === pendingExpandFocus ? { ...current, pendingFocus: null } : current,
    );
  }, [
    pendingExpandFocus,
    parentMap,
    childrenMap,
    nodesWithState,
    fitToBounds,
    fitToNodes,
    centerOnNodesAtCurrentScale,
    bounds,
  ]);

  useLayoutEffect(() => {
    if (!focusNodeIdsKey) {
      prevFocusNodeIdsKeyRef.current = null;
      return;
    }
    if (focusNodeIdsKey === prevFocusNodeIdsKeyRef.current) return;

    const focusNodeIdSet = new Set(focusNodeIds);
    const focusNodes = nodesWithState.filter((node) => focusNodeIdSet.has(node.id));
    if (focusNodes.length === 0) return;

    prevFocusNodeIdsKeyRef.current = focusNodeIdsKey;
    const next = new Set(layoutExpandedNodes);
    expandedNodesRef.current = next;
    setExpandedNodesState({
      key: expansionKey,
      nodes: next,
      pendingFocus: null,
    });
    fitToNodes(focusNodes, EXPAND_FIT_DURATION, EXPAND_FIT_PADDING_PX);
    onFocusConsumed?.();
  }, [
    expansionKey,
    focusNodeIds,
    focusNodeIdsKey,
    fitToNodes,
    layoutExpandedNodes,
    nodesWithState,
    onFocusConsumed,
  ]);

  useEffect(() => {
    return () => {
      if (animationFrameRef.current != null) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement;
      if (target.closest("[data-org-chart-control='true']")) {
        return;
      }
      if (target.closest("[data-org-chart-node='true']")) {
        return;
      }

      stopCameraAnimation();
      event.currentTarget.setPointerCapture(event.pointerId);
      panStateRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: viewportRef.current.x,
        originY: viewportRef.current.y,
      };
      setIsPanning(true);
    },
    [stopCameraAnimation],
  );

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const panState = panStateRef.current;
    if (!panState || panState.pointerId !== event.pointerId) {
      return;
    }

    const dx = event.clientX - panState.startX;
    const dy = event.clientY - panState.startY;
    setViewport((current) => ({
      ...current,
      x: panState.originX + dx,
      y: panState.originY + dy,
    }));
  }, []);

  const endPan = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const panState = panStateRef.current;
    if (!panState || panState.pointerId !== event.pointerId) {
      return;
    }
    panStateRef.current = null;
    setIsPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const handleWheel = useCallback(
    (event: WheelEvent) => {
      if (canvasSize.width <= 0 || canvasSize.height <= 0) {
        return;
      }
      event.preventDefault();
      stopCameraAnimation();

      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;

      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;

      setViewport((current) => {
        const factor = Math.exp(-event.deltaY * 0.0015);
        const nextScale = clamp(current.scale * factor, MIN_SCALE, MAX_SCALE);
        const worldX = (pointerX - current.x) / current.scale;
        const worldY = (pointerY - current.y) / current.scale;

        return {
          scale: nextScale,
          x: pointerX - worldX * nextScale,
          y: pointerY - worldY * nextScale,
        };
      });
    },
    [canvasSize.height, canvasSize.width, stopCameraAnimation],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      container.removeEventListener("wheel", handleWheel);
    };
  }, [handleWheel]);

  const resetZoom = useCallback(() => {
    fitToBounds(bounds, EXPAND_FIT_DURATION, resolvedFitPaddingPx);
  }, [fitToBounds, bounds, resolvedFitPaddingPx]);

  const zoomAroundCanvasPoint = useCallback(
    (factor: number) => {
      stopCameraAnimation();

      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;

      const pointerX = rect.width / 2;
      const pointerY = rect.height / 2;

      setViewport((current) => {
        const nextScale = clamp(current.scale * factor, MIN_SCALE, MAX_SCALE);
        const worldX = (pointerX - current.x) / current.scale;
        const worldY = (pointerY - current.y) / current.scale;

        return {
          scale: nextScale,
          x: pointerX - worldX * nextScale,
          y: pointerY - worldY * nextScale,
        };
      });
    },
    [stopCameraAnimation],
  );

  const zoomIn = useCallback(() => {
    zoomAroundCanvasPoint(1.15);
  }, [zoomAroundCanvasPoint]);

  const zoomOut = useCallback(() => {
    zoomAroundCanvasPoint(1 / 1.15);
  }, [zoomAroundCanvasPoint]);

  const contentWidth = Math.max(bounds.maxX + 300, 1);
  const contentHeight = Math.max(bounds.maxY + 300, 1);

  return (
    <div
      ref={containerRef}
      className="org-chart-canvas"
      data-testid="org-chart-canvas"
      data-panning={isPanning ? "true" : undefined}
      data-surface={surface}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
    >
      {surface === "canvas" ? <div aria-hidden className="org-chart-canvas-grid" /> : null}

      <div
        data-testid="org-chart-canvas-content"
        className="org-chart-canvas-content"
        style={{
          width: contentWidth,
          height: contentHeight,
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
          // Hidden until the initial fit lands — see `initialFitApplied`.
          opacity: initialFitApplied ? 1 : 0,
        }}
      >
        <svg
          className="org-chart-canvas-edges"
          style={{ position: "absolute", left: 0, top: 0 }}
          width={contentWidth}
          height={contentHeight}
          viewBox={`0 0 ${contentWidth} ${contentHeight}`}
          aria-hidden
        >
          {edges.map((edge) => (
            <path key={edge.id} className="org-chart-canvas-edge" d={edge.path} />
          ))}
        </svg>

        {nodesWithState.map((node) => {
          const motionState = "stable";
          const isDimmed = filterActive && node.data.matchesFilter === false;
          const isFocused = focusedNodeIds?.has(node.id) ?? false;
          // The renderer is host-provided, so the canvas fires activation at
          // the layout-node boundary.
          const handleClick = node.data.onClick
            ? (event: React.MouseEvent<HTMLDivElement>) => {
                node.data.onClick?.({
                  append: event.metaKey || event.ctrlKey,
                });
              }
            : undefined;
          const handleKeyDown = node.data.onClick
            ? (event: React.KeyboardEvent<HTMLDivElement>) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                node.data.onClick?.({
                  append: event.metaKey || event.ctrlKey,
                });
              }
            : undefined;
          const nodeElement = (
            <div
              key={node.id}
              data-org-chart-node="true"
              role={handleClick ? "button" : undefined}
              tabIndex={handleClick ? 0 : undefined}
              aria-label={handleClick ? `Activate ${node.data.name || node.id}` : undefined}
              className="org-chart-node"
              style={{
                left: node.x,
                top: node.y,
                width: node.width,
                height: node.height,
                cursor: handleClick ? "pointer" : undefined,
              }}
              onClick={handleClick}
              onKeyDown={handleKeyDown}
            >
              {renderNode({ ...node, motionState }, { motionState, isFocused, isDimmed })}
            </div>
          );
          const before = decorationsByNode.get(node.id);
          if (!before) return nodeElement;
          return (
            <Fragment key={node.id}>
              {before.map((decoration) => (
                <Fragment key={decoration.id}>{decoration.element}</Fragment>
              ))}
              {nodeElement}
            </Fragment>
          );
        })}
      </div>

      {data.label ? <div className="org-chart-label">{data.label}</div> : null}

      <div className="org-chart-zoom-cluster" data-org-chart-control="true">
        <button
          type="button"
          className="org-chart-zoom-button"
          aria-label="Zoom in"
          onClick={zoomIn}
          data-testid="org-chart-zoom-in"
          data-org-chart-control="true"
        >
          <Plus />
        </button>
        <button
          type="button"
          className="org-chart-zoom-button"
          aria-label="Zoom out"
          onClick={zoomOut}
          data-testid="org-chart-zoom-out"
          data-org-chart-control="true"
        >
          <Minus />
        </button>
        <button
          type="button"
          className="org-chart-zoom-button"
          aria-label="Fit chart"
          onClick={resetZoom}
          data-testid="org-chart-fit"
          data-org-chart-control="true"
        >
          <ArrowsPointingIn />
        </button>
      </div>
    </div>
  );
}
