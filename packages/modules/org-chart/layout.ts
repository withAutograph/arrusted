// Org-chart layout: deterministic tree positioning plus cubic connector paths.
// It stays generic over app data; the canvas/app renderer owns presentation.

import { useMemo } from "react";

import type { DynamicFieldValue, OrgChartAtom, OrgChartNodeKind } from "./types";

const DEFAULT_VISIBLE_FIELDS: string[] = ["title", "group", "avatarUrl", "metric"];
const EMPTY_SLOT_MAP: Map<string, OrgChartAtom> = new Map();

export type OrgChartNode = {
  id: string;
  sortKey?: string;
  subjectId?: string;
  displayId?: string;
  slotId?: string | null;
  slotLabel?: string | null;
  name: string;
  title?: string;
  avatarUrl?: string;
  fieldValues: Record<string, DynamicFieldValue>;
  isVirtualRoot?: boolean;
  /**
   * Set `false` to render the node without activation: the canvas gives it
   * no button role, no tab stop, and no click handler. Defaults to
   * activatable (virtual roots are never activatable).
   */
  interactive?: boolean;
  startDate?: string;
  matchesFilter?: boolean;
  nodeKind: OrgChartNodeKind;
  slotData?: OrgChartAtom;
  externalData?: OrgChartAtom;
};

export type OrgChartLink = {
  from: string;
  to: string;
};

/**
 * Per-node payload carried on the layout output. The host's `renderNode`
 * adapter owns domain-specific rendering.
 */
export type OrgChartLayoutNodeData = {
  subjectId: string | null;
  displayId?: string;
  slotId: string | null;
  slotLabel: string | null;
  name: string;
  title?: string;
  avatarUrl?: string;
  fieldValues: Record<string, DynamicFieldValue>;
  layer: number;
  childCount: number;
  descendantCount: number;
  isVirtualRoot: boolean;
  /** Mirrors `OrgChartNode.interactive`; absent means activatable. */
  interactive?: boolean;
  hasParent: boolean;
  matchesFilter: boolean;
  filterActive: boolean;
  filterCacheKey: string;
  /** Click handler — set in the canvas, not the layout. */
  onClick?: (options: { append: boolean }) => void;
  /** Expand/collapse toggle — set in the canvas, not the layout. */
  onExpandToggle?: () => void;
  isExpanded?: boolean;
  hasChildren?: boolean;
  canCollapse?: boolean;
  visibleFields: string[];
  startDate?: string;
  effectiveDate: string;
  showSlots: boolean;
  slotData: OrgChartAtom | null;
  nodeKind: OrgChartNodeKind;
  externalData: OrgChartAtom | null;
  nodeHeight: number;
};

export type OrgChartLayoutNode = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  className?: string;
  data: OrgChartLayoutNodeData;
};

export type OrgChartLayoutEdge = {
  id: string;
  source: string;
  target: string;
  path: string;
};

export type OrgChartLayoutBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
};

/**
 * Axis the tree grows along. `top-to-bottom` is the classic org chart and
 * the default. `left-to-right` grows children to the right of their parent;
 * `right-to-left` is its exact mirror, so a host can draw a tree on either
 * side of a shared root.
 */
export type OrgChartLayoutDirection = "top-to-bottom" | "left-to-right" | "right-to-left";

export type OrgChartLayoutOptions = {
  /** Defaults to `top-to-bottom`. */
  direction?: OrgChartLayoutDirection;
  /**
   * Fixed box for every node. Omit to keep the built-in card sizes
   * (240px wide, height by node kind and slot mode).
   */
  nodeSize?: { width: number; height: number };
  /**
   * Space between siblings. Omit to keep the built-in spacing for the
   * direction (56px top-to-bottom, 16px horizontal).
   */
  siblingGap?: number;
};

const DEFAULT_LAYOUT_OPTIONS: OrgChartLayoutOptions = {};

const NODE_WIDTH = 240;
const NODE_HEIGHT_COMPACT = 124;
const NODE_HEIGHT_POSITION_MODE = 184;
const NODE_HEIGHT_POSITION_MODE_WITH_INSIGHTS = 218;
const NODE_HEIGHT_ROOT = 92;
const HORIZONTAL_GAP = 56;
const ROOT_GAP = 96;
const VERTICAL_GAP = 72;

/**
 * Spacing along the depth axis (`main`) and between siblings (`cross`).
 * Top-to-bottom keeps the original org-chart constants. Horizontal trees
 * stack siblings in one column, so siblings sit closer together.
 */
type AxisSpacing = { mainGap: number; crossGap: number; rootGap: number };

const VERTICAL_SPACING: AxisSpacing = {
  mainGap: VERTICAL_GAP,
  crossGap: HORIZONTAL_GAP,
  rootGap: ROOT_GAP,
};

const HORIZONTAL_SPACING: AxisSpacing = {
  mainGap: 72,
  crossGap: 16,
  rootGap: 48,
};

const COLLAPSIBLE_DEPTH = 1;
const ALWAYS_VISIBLE_DEPTH = 2;

function getStableNodeLabel(node: OrgChartNode | undefined): string {
  if (!node) return "";
  return node.sortKey || node.name || node.title || node.id;
}

function sortChildrenByStableLabel(
  childrenMap: Map<string, string[]>,
  nodeMap: Map<string, OrgChartNode>,
) {
  for (const children of childrenMap.values()) {
    children.sort((a, b) =>
      getStableNodeLabel(nodeMap.get(a)).localeCompare(
        getStableNodeLabel(nodeMap.get(b)),
        undefined,
        { numeric: true, sensitivity: "base" },
      ),
    );
  }
}

function getNodeHeight(node: OrgChartNode, showSlots: boolean, showNodeInsights: boolean): number {
  if (node.isVirtualRoot) return NODE_HEIGHT_ROOT;
  if (!showSlots) {
    return NODE_HEIGHT_COMPACT;
  }
  if (showNodeInsights && (node.nodeKind === "subject" || node.nodeKind === "vacant")) {
    return NODE_HEIGHT_POSITION_MODE_WITH_INSIGHTS;
  }
  return NODE_HEIGHT_POSITION_MODE;
}

function countCountableChildren(ids: string[] | undefined, nodeMap: Map<string, OrgChartNode>) {
  if (!ids || ids.length === 0) return 0;
  let count = 0;
  for (const id of ids) {
    const kind = nodeMap.get(id)?.nodeKind;
    if (kind === "subject" || kind === "vacant") {
      count += 1;
    }
  }
  return count;
}

/**
 * Soft cubic connector from a parent to a child, leaving the parent on the
 * side that faces the child. Vertical trees run bottom-centre to top-centre;
 * horizontal trees run between the facing vertical edges at mid-height.
 */
export function buildEdgePath(
  source: OrgChartLayoutNode,
  target: OrgChartLayoutNode,
  direction: OrgChartLayoutDirection = "top-to-bottom",
): string {
  if (direction !== "top-to-bottom") {
    const sign = direction === "left-to-right" ? 1 : -1;
    const sx = direction === "left-to-right" ? source.x + source.width : source.x;
    const sy = source.y + source.height / 2;
    const tx = direction === "left-to-right" ? target.x : target.x + target.width;
    const ty = target.y + target.height / 2;

    const spanX = Math.max((tx - sx) * sign, 0);
    const controlOffset = Math.max(Math.min(spanX / 2, 72), 24);

    return `M ${sx} ${sy} C ${sx + sign * controlOffset} ${sy} ${tx - sign * controlOffset} ${ty} ${tx} ${ty}`;
  }

  const sx = source.x + source.width / 2;
  const sy = source.y + source.height;
  const tx = target.x + target.width / 2;
  const ty = target.y;

  const spanY = Math.max(ty - sy, 0);
  const controlOffset = Math.max(Math.min(spanY / 2, 72), 24);

  return `M ${sx} ${sy} C ${sx} ${sy + controlOffset} ${tx} ${ty - controlOffset} ${tx} ${ty}`;
}

function getEmptyBounds(): OrgChartLayoutBounds {
  return {
    minX: 0,
    minY: 0,
    maxX: 0,
    maxY: 0,
    width: 0,
    height: 0,
  };
}

/**
 * Already-positioned nodes and connectors. Hosts that compose several
 * layouts into one coordinate space (for example trees growing in
 * different directions from one shared node) pass this instead of letting
 * the canvas lay out `data`. Coordinates must be non-negative.
 */
export type OrgChartPositionedLayout = {
  nodes: OrgChartLayoutNode[];
  edges: OrgChartLayoutEdge[];
  bounds: OrgChartLayoutBounds;
};

export type OrgChartLayoutResult = {
  nodes: OrgChartLayoutNode[];
  edges: OrgChartLayoutEdge[];
  parentMap: Map<string, string>;
  childrenMap: Map<string, string[]>;
  bounds: OrgChartLayoutBounds;
};

/**
 * Memoised layout for React hosts. See `computeOrgChartLayout` for the
 * pure function it wraps.
 */
export function useOrgChartLayout(
  nodes: OrgChartNode[],
  links: OrgChartLink[],
  expandedNodes: Set<string>,
  visibleFields: string[] = DEFAULT_VISIBLE_FIELDS,
  effectiveDate: string = "",
  filterActive: boolean = false,
  showSlots: boolean = false,
  showNodeInsights: boolean = false,
  slotMap: Map<string, OrgChartAtom> = EMPTY_SLOT_MAP,
  options: OrgChartLayoutOptions = DEFAULT_LAYOUT_OPTIONS,
): OrgChartLayoutResult {
  const direction = options.direction ?? "top-to-bottom";
  const fixedWidth = options.nodeSize?.width;
  const fixedHeight = options.nodeSize?.height;
  const siblingGap = options.siblingGap;
  return useMemo(
    () =>
      computeOrgChartLayout(
        nodes,
        links,
        expandedNodes,
        visibleFields,
        effectiveDate,
        filterActive,
        showSlots,
        showNodeInsights,
        slotMap,
        {
          direction,
          nodeSize:
            fixedWidth != null && fixedHeight != null
              ? { width: fixedWidth, height: fixedHeight }
              : undefined,
          siblingGap,
        },
      ),
    [
      nodes,
      links,
      expandedNodes,
      visibleFields,
      effectiveDate,
      filterActive,
      showSlots,
      showNodeInsights,
      slotMap,
      direction,
      fixedWidth,
      fixedHeight,
      siblingGap,
    ],
  );
}

/** Deterministic tree layout: positions, connector paths, and bounds. */
export function computeOrgChartLayout(
  nodes: OrgChartNode[],
  links: OrgChartLink[],
  expandedNodes: Set<string>,
  visibleFields: string[] = DEFAULT_VISIBLE_FIELDS,
  effectiveDate: string = "",
  filterActive: boolean = false,
  showSlots: boolean = false,
  showNodeInsights: boolean = false,
  slotMap: Map<string, OrgChartAtom> = EMPTY_SLOT_MAP,
  options: OrgChartLayoutOptions = DEFAULT_LAYOUT_OPTIONS,
): OrgChartLayoutResult {
  const direction = options.direction ?? "top-to-bottom";
  const fixedWidth = options.nodeSize?.width;
  const fixedHeight = options.nodeSize?.height;
  const isVertical = direction === "top-to-bottom";
  const baseSpacing = isVertical ? VERTICAL_SPACING : HORIZONTAL_SPACING;
  const spacing =
    options.siblingGap == null ? baseSpacing : { ...baseSpacing, crossGap: options.siblingGap };
  const nodeWidth = fixedWidth ?? NODE_WIDTH;
  const heightOf = (node: OrgChartNode) =>
    fixedHeight ?? getNodeHeight(node, showSlots, showNodeInsights);
  // `main` is the depth axis, `cross` is the sibling axis.
  const mainSizeOf = (node: OrgChartNode) => (isVertical ? heightOf(node) : nodeWidth);
  const crossSizeOf = (node: OrgChartNode) => (isVertical ? nodeWidth : heightOf(node));

  if (nodes.length === 0) {
    return {
      nodes: [],
      edges: [],
      parentMap: new Map<string, string>(),
      childrenMap: new Map<string, string[]>(),
      bounds: getEmptyBounds(),
    };
  }

  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const childrenMap = new Map<string, string[]>();
  const parentMap = new Map<string, string>();

  for (const link of links) {
    const existing = childrenMap.get(link.from);
    if (existing) {
      existing.push(link.to);
    } else {
      childrenMap.set(link.from, [link.to]);
    }
    parentMap.set(link.to, link.from);
  }

  sortChildrenByStableLabel(childrenMap, nodeMap);

  const depths = new Map<string, number>();
  const descendantCounts = new Map<string, number>();
  const rootNodes = nodes.filter((node) => !parentMap.has(node.id));
  const metricsRoots =
    rootNodes.length > 0
      ? rootNodes
      : nodes.toSorted((a, b) => getStableNodeLabel(a).localeCompare(getStableNodeLabel(b)));

  const metricsVisiting = new Set<string>();
  const computeMetrics = (nodeId: string, depth: number): number => {
    if (metricsVisiting.has(nodeId)) {
      return 0;
    }
    metricsVisiting.add(nodeId);
    depths.set(nodeId, depth);
    const children = childrenMap.get(nodeId) ?? [];

    if (children.length === 0) {
      descendantCounts.set(nodeId, 0);
      metricsVisiting.delete(nodeId);
      return 0;
    }

    let descendants = 0;
    for (const childId of children) {
      descendants += computeMetrics(childId, depth + 1);
      const childKind = nodeMap.get(childId)?.nodeKind;
      if (childKind === "subject" || childKind === "vacant") {
        descendants += 1;
      }
    }

    descendantCounts.set(nodeId, descendants);
    metricsVisiting.delete(nodeId);
    return descendants;
  };

  for (const root of metricsRoots) {
    computeMetrics(root.id, 0);
  }

  const visibleNodeIds = new Set<string>();
  const isVisible = (nodeId: string): boolean => {
    const depth = depths.get(nodeId) ?? 0;
    if (depth < ALWAYS_VISIBLE_DEPTH) {
      return true;
    }

    let currentId = nodeId;
    const seen = new Set<string>();
    while (parentMap.has(currentId)) {
      if (seen.has(currentId)) {
        return true;
      }
      seen.add(currentId);
      const parentId = parentMap.get(currentId)!;
      const parentDepth = depths.get(parentId) ?? 0;
      if (parentDepth >= COLLAPSIBLE_DEPTH && !expandedNodes.has(parentId)) {
        return false;
      }
      currentId = parentId;
    }
    return true;
  };

  for (const node of nodes) {
    if (isVisible(node.id)) {
      visibleNodeIds.add(node.id);
    }
  }

  const visibleNodes = nodes.filter((node) => visibleNodeIds.has(node.id));
  const visibleNodeMap = new Map(visibleNodes.map((node) => [node.id, node]));
  const visibleLinks = links.filter(
    (link) => visibleNodeIds.has(link.from) && visibleNodeIds.has(link.to),
  );

  const visibleChildrenMap = new Map<string, string[]>();
  for (const [parentId, childIds] of childrenMap.entries()) {
    const filtered = childIds.filter((id) => visibleNodeIds.has(id));
    if (filtered.length > 0) {
      visibleChildrenMap.set(parentId, filtered);
    }
  }

  const visibleRoots = visibleNodes
    .filter((node) => {
      const parentId = parentMap.get(node.id);
      return !parentId || !visibleNodeIds.has(parentId);
    })
    .sort((a, b) =>
      getStableNodeLabel(a).localeCompare(getStableNodeLabel(b), undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
  const layoutRoots =
    visibleRoots.length > 0
      ? visibleRoots
      : visibleNodes.toSorted((a, b) => getStableNodeLabel(a).localeCompare(getStableNodeLabel(b)));

  // Depth offsets along the main axis: each depth band is as deep as its
  // largest node, so siblings line up in one row (vertical) or one
  // column (horizontal).
  const maxDepthMain = new Map<number, number>();
  for (const node of visibleNodes) {
    const depth = depths.get(node.id) ?? 0;
    const mainSize = mainSizeOf(node);
    const prev = maxDepthMain.get(depth) ?? 0;
    if (mainSize > prev) {
      maxDepthMain.set(depth, mainSize);
    }
  }

  const depthMain = new Map<number, number>();
  const sortedDepths = Array.from(maxDepthMain.keys()).sort((a, b) => a - b);
  let cursorMain = 0;
  for (const depth of sortedDepths) {
    depthMain.set(depth, cursorMain);
    cursorMain += (maxDepthMain.get(depth) ?? NODE_HEIGHT_COMPACT) + spacing.mainGap;
  }

  const subtreeCrossMemo = new Map<string, number>();
  const crossVisiting = new Set<string>();
  const getSubtreeCross = (nodeId: string): number => {
    const cached = subtreeCrossMemo.get(nodeId);
    if (cached != null) return cached;
    const node = visibleNodeMap.get(nodeId);
    const nodeCross = node ? crossSizeOf(node) : nodeWidth;
    if (crossVisiting.has(nodeId)) return nodeCross;
    crossVisiting.add(nodeId);

    const children = visibleChildrenMap.get(nodeId) ?? [];
    if (children.length === 0) {
      subtreeCrossMemo.set(nodeId, nodeCross);
      crossVisiting.delete(nodeId);
      return nodeCross;
    }

    let totalChildrenCross = 0;
    for (let i = 0; i < children.length; i += 1) {
      totalChildrenCross += getSubtreeCross(children[i]!);
      if (i < children.length - 1) {
        totalChildrenCross += spacing.crossGap;
      }
    }

    const cross = Math.max(nodeCross, totalChildrenCross);
    subtreeCrossMemo.set(nodeId, cross);
    crossVisiting.delete(nodeId);
    return cross;
  };

  const layoutBoxes = new Map<string, { x: number; y: number; width: number; height: number }>();
  const layoutVisiting = new Set<string>();
  const assignLayout = (nodeId: string, crossStart: number) => {
    if (layoutVisiting.has(nodeId)) return;
    layoutVisiting.add(nodeId);
    const node = visibleNodeMap.get(nodeId);
    if (!node) {
      layoutVisiting.delete(nodeId);
      return;
    }

    const subtreeCross = getSubtreeCross(nodeId);
    const nodeCross = crossSizeOf(node);
    const depth = depths.get(nodeId) ?? 0;
    const main = depthMain.get(depth) ?? 0;
    const cross = crossStart + (subtreeCross - nodeCross) / 2;

    layoutBoxes.set(
      nodeId,
      isVertical
        ? { x: cross, y: main, width: nodeWidth, height: heightOf(node) }
        : { x: main, y: cross, width: nodeWidth, height: heightOf(node) },
    );

    const children = visibleChildrenMap.get(nodeId) ?? [];
    if (children.length === 0) {
      layoutVisiting.delete(nodeId);
      return;
    }

    let childTotalCross = 0;
    for (let i = 0; i < children.length; i += 1) {
      childTotalCross += getSubtreeCross(children[i]!);
      if (i < children.length - 1) {
        childTotalCross += spacing.crossGap;
      }
    }

    let childStart = crossStart + (subtreeCross - childTotalCross) / 2;
    for (const childId of children) {
      assignLayout(childId, childStart);
      childStart += getSubtreeCross(childId) + spacing.crossGap;
    }
    layoutVisiting.delete(nodeId);
  };

  let rootStart = 0;
  for (const root of layoutRoots) {
    assignLayout(root.id, rootStart);
    rootStart += getSubtreeCross(root.id) + spacing.rootGap;
  }

  // Right-to-left mirrors the left-to-right placement across the main
  // axis, keeping every coordinate non-negative with the roots on the
  // right edge.
  if (direction === "right-to-left") {
    const mainExtent = Math.max(cursorMain - spacing.mainGap, 0);
    for (const box of layoutBoxes.values()) {
      box.x = mainExtent - box.x - box.width;
    }
  }

  const layoutNodes: OrgChartLayoutNode[] = visibleNodes.map((node) => {
    const box = layoutBoxes.get(node.id) ?? {
      x: 0,
      y: 0,
      width: nodeWidth,
      height: heightOf(node),
    };
    const nodeDepth = depths.get(node.id) ?? 0;
    const allChildren = childrenMap.get(node.id) ?? [];
    const hasChildren = allChildren.length > 0;
    const canCollapse = hasChildren && nodeDepth >= COLLAPSIBLE_DEPTH;
    const slot =
      node.nodeKind === "vacant"
        ? (node.slotData ?? null)
        : showSlots && node.slotId
          ? (slotMap.get(node.slotId) ?? null)
          : null;
    const nodeMatchesFilter = node.matchesFilter ?? true;

    return {
      id: node.id,
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      className: filterActive && !nodeMatchesFilter ? "filtered-out" : undefined,
      data: {
        subjectId: node.subjectId ?? null,
        displayId: node.displayId,
        slotId: node.slotId ?? null,
        slotLabel: node.slotLabel ?? null,
        name: node.name,
        title: node.title,
        avatarUrl: node.avatarUrl,
        fieldValues: node.fieldValues,
        layer: nodeDepth + 1,
        childCount: countCountableChildren(allChildren, nodeMap),
        descendantCount: descendantCounts.get(node.id) ?? 0,
        isVirtualRoot: node.isVirtualRoot ?? false,
        ...(node.interactive === undefined ? {} : { interactive: node.interactive }),
        hasParent: parentMap.has(node.id),
        matchesFilter: nodeMatchesFilter,
        filterActive,
        filterCacheKey: filterActive ? `filtered-${nodeMatchesFilter}` : "unfiltered",
        onClick: undefined,
        onExpandToggle: undefined,
        isExpanded: expandedNodes.has(node.id),
        hasChildren,
        canCollapse,
        visibleFields,
        startDate: node.startDate,
        effectiveDate,
        showSlots,
        slotData: slot,
        nodeKind: node.nodeKind,
        externalData: node.externalData ?? null,
        nodeHeight: box.height,
      },
    };
  });

  const layoutNodeMap = new Map(layoutNodes.map((node) => [node.id, node]));
  const layoutEdges: OrgChartLayoutEdge[] = visibleLinks
    .map((link) => {
      const sourceNode = layoutNodeMap.get(link.from);
      const targetNode = layoutNodeMap.get(link.to);
      if (!sourceNode || !targetNode) return null;

      return {
        id: `${link.from}-${link.to}`,
        source: link.from,
        target: link.to,
        path: buildEdgePath(sourceNode, targetNode, direction),
      } satisfies OrgChartLayoutEdge;
    })
    .filter((edge): edge is OrgChartLayoutEdge => edge != null);

  if (layoutNodes.length === 0) {
    return {
      nodes: [],
      edges: layoutEdges,
      parentMap,
      childrenMap,
      bounds: getEmptyBounds(),
    };
  }

  let minX = layoutNodes[0]!.x;
  let minY = layoutNodes[0]!.y;
  let maxX = layoutNodes[0]!.x + layoutNodes[0]!.width;
  let maxY = layoutNodes[0]!.y + layoutNodes[0]!.height;
  for (let i = 1; i < layoutNodes.length; i += 1) {
    const node = layoutNodes[i]!;
    const nodeMaxX = node.x + node.width;
    const nodeMaxY = node.y + node.height;
    if (node.x < minX) minX = node.x;
    if (node.y < minY) minY = node.y;
    if (nodeMaxX > maxX) maxX = nodeMaxX;
    if (nodeMaxY > maxY) maxY = nodeMaxY;
  }

  return {
    nodes: layoutNodes,
    edges: layoutEdges,
    parentMap,
    childrenMap,
    bounds: {
      minX,
      minY,
      maxX,
      maxY,
      width: Math.max(maxX - minX, 0),
      height: Math.max(maxY - minY, 0),
    },
  };
}
