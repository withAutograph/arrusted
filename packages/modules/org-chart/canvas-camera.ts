import type { OrgChartLayoutBounds, OrgChartLayoutNode } from "./layout";

export type ViewportState = {
  x: number;
  y: number;
  scale: number;
};

export type CanvasSize = {
  width: number;
  height: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Compute the bounding box for a set of layout nodes. */
export function computeBoundsForNodes(nodes: OrgChartLayoutNode[]): OrgChartLayoutBounds {
  if (nodes.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  }

  let minX = nodes[0]!.x;
  let minY = nodes[0]!.y;
  let maxX = nodes[0]!.x + nodes[0]!.width;
  let maxY = nodes[0]!.y + nodes[0]!.height;
  for (let i = 1; i < nodes.length; i += 1) {
    const node = nodes[i]!;
    const nodeMaxX = node.x + node.width;
    const nodeMaxY = node.y + node.height;
    if (node.x < minX) minX = node.x;
    if (node.y < minY) minY = node.y;
    if (nodeMaxX > maxX) maxX = nodeMaxX;
    if (nodeMaxY > maxY) maxY = nodeMaxY;
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: Math.max(maxX - minX, 0),
    height: Math.max(maxY - minY, 0),
  };
}

export function computeViewportForBounds(args: {
  bounds: OrgChartLayoutBounds;
  canvas: CanvasSize;
  minScale?: number;
  maxScale?: number;
  paddingPx?: number;
}): ViewportState {
  const { bounds, canvas, minScale = 0.25, maxScale = 2, paddingPx = 80 } = args;
  if (canvas.width <= 0 || canvas.height <= 0) return { x: 0, y: 0, scale: 1 };
  // Padding is in screen pixels, so it holds at any scale (it keeps cards
  // clear of the zoom controls). On a small canvas the padding gives way so
  // the chart keeps at least half of each side.
  const roomWidth = Math.max(canvas.width - paddingPx * 2, canvas.width / 2);
  const roomHeight = Math.max(canvas.height - paddingPx * 2, canvas.height / 2);
  const scale = clamp(
    Math.min(roomWidth / Math.max(bounds.width, 1), roomHeight / Math.max(bounds.height, 1)),
    minScale,
    maxScale,
  );
  const x = (canvas.width - bounds.width * scale) / 2 - bounds.minX * scale;
  const y = (canvas.height - bounds.height * scale) / 2 - bounds.minY * scale;
  return { x, y, scale };
}

export function computeViewportForBoundsAtScale(args: {
  bounds: OrgChartLayoutBounds;
  canvas: CanvasSize;
  scale: number;
  minScale?: number;
  maxScale?: number;
}): ViewportState {
  const { bounds, canvas, scale, minScale = 0.25, maxScale = 2 } = args;
  if (canvas.width <= 0 || canvas.height <= 0) return { x: 0, y: 0, scale: 1 };
  const resolvedScale = clamp(scale, minScale, maxScale);
  const centerX = bounds.minX + bounds.width / 2;
  const centerY = bounds.minY + bounds.height / 2;
  return {
    scale: resolvedScale,
    x: canvas.width / 2 - centerX * resolvedScale,
    y: canvas.height / 2 - centerY * resolvedScale,
  };
}

export function buildExpandFocusNodeIds(args: {
  nodeId: string;
  parentMap: Map<string, string>;
  childrenMap: Map<string, string[]>;
}): Set<string> {
  const { nodeId, parentMap, childrenMap } = args;
  const focusNodeIds = new Set<string>([nodeId]);
  const parentId = parentMap.get(nodeId);
  if (parentId) focusNodeIds.add(parentId);
  for (const childId of childrenMap.get(nodeId) ?? []) focusNodeIds.add(childId);
  return focusNodeIds;
}
