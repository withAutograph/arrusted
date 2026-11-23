// Neighbourhood layout: one shared centre with up to three one-hop sides.
//
//   • right — columns of cards to the right of the centre
//   • left  — the mirror image, columns to the left
//   • below — a top-to-bottom row underneath everything else
//
// Sides wrap at four cards per column into as many columns as needed, filled
// top to bottom; a group (including its overflow card) never splits across a
// column break, so an uncapped group larger than four is one taller column. Each outer column is offset by half a row pitch from the
// one inside it (a brick pattern), so every inner gap lines up with an
// outer card. A connector to an outer card leaves the centre, settles into
// a gap of each inner column it crosses, and runs straight through it, so
// no connector passes behind a card.
//
// The below row is laid out by the ordinary org-chart layout in its
// top-to-bottom direction and starts under the lower of the two sides; its
// connectors drop on a straight trunk between the sides before fanning out.
//
// Framed groups. A group may ask for a frame: one bordered box around its
// cards with a caption in the box's top edge. Connectors still run from the
// centre to each card inside. The packing keeps every connector clear of
// every caption and of every frame it does not end in:
//
//   • left / right — a side's framed groups go after its plain groups, in one
//     outermost column of their own, stacked top to bottom in the host's
//     order with one empty row between frames. Nothing lies beyond that
//     column, so no other connector crosses a frame, and connectors into it
//     reuse the brick lanes through the plain columns.
//   • below — a framed group keeps its place in the row with frame padding on
//     both sides. When any below group is framed, the row drops by the
//     caption's height and every below connector fans out above the
//     captions, then enters its card with a straight vertical drop.
//
// Layouts without framed groups are unchanged.

import {
  buildEdgePath,
  computeOrgChartLayout,
  type OrgChartLayoutBounds,
  type OrgChartLayoutEdge,
  type OrgChartLayoutNode,
  type OrgChartNode,
  type OrgChartPositionedLayout,
} from "./layout";

export type RelationLayoutSide = "left" | "right" | "below";

/** A group whose cards sit inside one captioned frame. */
export type RelationLayoutFramedGroup = {
  /** Unique across the layout. */
  frameId: string;
  nodes: readonly OrgChartNode[];
};

/** A plain list of nodes, or a framed group. */
export type RelationLayoutGroup = readonly OrgChartNode[] | RelationLayoutFramedGroup;

export type RelationLayoutInput = {
  centre: OrgChartNode;
  /** Each side is a list of groups. */
  sides: Partial<Record<RelationLayoutSide, readonly RelationLayoutGroup[]>>;
  nodeSize: { width: number; height: number };
};

export type RelationLayoutBox = { x: number; y: number; width: number; height: number };

export type RelationLayoutFrame = RelationLayoutBox & {
  id: string;
  side: RelationLayoutSide;
  /**
   * Space reserved for the caption, centred on the frame's top edge. The
   * caption must render inside it (truncating if needed): connectors are
   * kept clear of this box, not of the rendered text.
   */
  caption: RelationLayoutBox;
  /** The frame's cards, in order. */
  nodeIds: string[];
};

export type RelationLayout = OrgChartPositionedLayout & {
  /** Framed groups in node (tab) order. Empty when no group is framed. */
  frames: RelationLayoutFrame[];
};

/** Space between the centre and a side's first column. */
const SIDE_CHANNEL = 72;
/** Space between neighbouring columns on one side. */
const COLUMN_GAP = 56;
/** Vertical gap between cards when a side has a single column. */
const SINGLE_COLUMN_ROW_GAP = 16;
/** Vertical gap when a side wraps; connectors run through these gaps. */
const MULTI_COLUMN_ROW_GAP = 28;
export const RELATION_MAX_CARDS_PER_COLUMN = 4;
/** Horizontal gap between cards in the below row. */
const BELOW_GAP = 24;
/** Extra horizontal space between groups in the below row. */
const BELOW_GROUP_GAP = 12;

/** Space between a frame's border and its cards (sides and bottom). */
const FRAME_PAD = 12;
/** Space between a frame's top border and its first card. */
const FRAME_PAD_TOP = 20;
/** Height of the caption box, centred on the frame's top border. */
const FRAME_CAPTION_HEIGHT = 16;
/** Caption box inset from the frame's left border. */
const FRAME_CAPTION_INSET = 8;
/** Below: room kept between a caption and its first card's connector. */
const FRAME_CAPTION_CLEARANCE = 8;
/** Below: room kept between the fanned-out connectors and the captions. */
const FAN_CLEARANCE = 4;
/** Below: how far a framed row drops so connectors fan out above captions. */
const BELOW_FRAME_DROP = FRAME_PAD_TOP + FRAME_CAPTION_HEIGHT / 2 + FAN_CLEARANCE;

const EMPTY_EXPANDED = new Set<string>();

type Box = RelationLayoutBox;

function isFramed(group: RelationLayoutGroup): group is RelationLayoutFramedGroup {
  return !Array.isArray(group);
}

function groupNodes(group: RelationLayoutGroup): readonly OrgChartNode[] {
  return isFramed(group) ? group.nodes : (group as readonly OrgChartNode[]);
}

/**
 * Pack groups into columns of at most four cards, adding columns as needed.
 * A group that does not fit the current column starts the next one, and a
 * group is never split, so a group larger than four cards (hosts normally
 * cap groups with `capRelationGroup`) occupies one taller column.
 */
export function packRelationColumns<T>(groups: readonly (readonly T[])[]): T[][] {
  const columns: T[][] = [];
  for (const group of groups) {
    if (group.length === 0) continue;
    const current = columns.at(-1);
    if (current && current.length + group.length <= RELATION_MAX_CARDS_PER_COLUMN) {
      current.push(...group);
    } else {
      columns.push([...group]);
    }
  }
  return columns;
}

function layoutNodeFor(node: OrgChartNode, box: Box, template: OrgChartLayoutNode) {
  return {
    ...template,
    id: node.id,
    ...box,
    data: {
      ...template.data,
      name: node.name,
      interactive: node.interactive,
      nodeHeight: box.height,
    },
  } satisfies OrgChartLayoutNode;
}

/** A frame around `cards`, with a caption box at most `captionWidth` wide. */
function frameAround(
  id: string,
  side: RelationLayoutSide,
  cards: readonly OrgChartLayoutNode[],
  captionWidth: number,
): RelationLayoutFrame {
  const inner = boundsOf(cards);
  const x = inner.minX - FRAME_PAD;
  const y = inner.minY - FRAME_PAD_TOP;
  const width = inner.width + 2 * FRAME_PAD;
  return {
    id,
    side,
    x,
    y,
    width,
    height: inner.maxY + FRAME_PAD - y,
    caption: {
      x: x + FRAME_CAPTION_INSET,
      y: y - FRAME_CAPTION_HEIGHT / 2,
      width: Math.min(width - 2 * FRAME_CAPTION_INSET, captionWidth),
      height: FRAME_CAPTION_HEIGHT,
    },
    nodeIds: cards.map((card) => card.id),
  };
}

/** The frame plus the half of its caption above the top border. */
function frameExtent(frame: RelationLayoutFrame): Box {
  return {
    x: frame.x,
    y: frame.caption.y,
    width: frame.width,
    height: frame.y + frame.height - frame.caption.y,
  };
}

function shiftFrame(frame: RelationLayoutFrame, dx: number, dy: number): RelationLayoutFrame {
  return {
    ...frame,
    x: frame.x + dx,
    y: frame.y + dy,
    caption: { ...frame.caption, x: frame.caption.x + dx, y: frame.caption.y + dy },
  };
}

type SidePlacement = {
  /** Cards relative to the centre's top-left corner. */
  nodes: OrgChartLayoutNode[];
  /** Frames relative to the centre's top-left corner. */
  frames: RelationLayoutFrame[];
  /** Connectors, given the centre and cards at their final positions. */
  edges: (
    centre: OrgChartLayoutNode,
    finalById: ReadonlyMap<string, OrgChartLayoutNode>,
  ) => OrgChartLayoutEdge[];
};

/**
 * Place one horizontal side. Coordinates are relative to the centre's
 * top-left corner; `outward` is the distance from the centre's facing edge.
 */
function placeSide(
  side: "left" | "right",
  groups: readonly RelationLayoutGroup[],
  nodeSize: { width: number; height: number },
  template: OrgChartLayoutNode,
): SidePlacement | null {
  // Plain groups pack as usual. Framed groups share one outermost column,
  // separated by an empty row (`null`).
  const plain: (readonly OrgChartNode[])[] = [];
  const framed: RelationLayoutFramedGroup[] = [];
  for (const group of groups) {
    if (!isFramed(group)) plain.push(groupNodes(group));
    else if (group.nodes.length > 0) framed.push(group);
  }
  const columns: (OrgChartNode | null)[][] = packRelationColumns(plain);
  const frameSpans: Array<{ id: string; ids: string[] }> = [];
  if (framed.length > 0) {
    const column: (OrgChartNode | null)[] = [];
    for (const group of framed) {
      if (column.length > 0) column.push(null);
      column.push(...group.nodes);
      frameSpans.push({ id: group.frameId, ids: group.nodes.map((node) => node.id) });
    }
    columns.push(column);
  }
  if (columns.length === 0) return null;

  const { width: w, height: h } = nodeSize;
  const rowGap = columns.length > 1 ? MULTI_COLUMN_ROW_GAP : SINGLE_COLUMN_ROW_GAP;
  const pitch = h + rowGap;
  const firstCount = columns[0]!.length;
  const top = h / 2 - (firstCount * h + (firstCount - 1) * rowGap) / 2;
  const columnStart = (index: number) => SIDE_CHANNEL + index * (w + COLUMN_GAP);
  const toX = (outward: number) => (side === "right" ? w + outward : -outward);
  const cardX = (index: number) =>
    side === "right" ? toX(columnStart(index)) : toX(columnStart(index)) - w;

  const placed: Array<{ node: OrgChartLayoutNode; column: number }> = [];
  columns.forEach((column, columnIndex) => {
    const brick = columnIndex % 2 === 1 ? pitch / 2 : 0;
    column.forEach((node, row) => {
      if (!node) return;
      const box = { x: cardX(columnIndex), y: top + row * pitch + brick, width: w, height: h };
      placed.push({ node: layoutNodeFor(node, box, template), column: columnIndex });
    });
  });
  const placedById = new Map(placed.map(({ node }) => [node.id, node]));
  // Connectors enter a side frame through its inner side, well below the
  // caption, so the caption may span the frame's whole top edge.
  const frames = frameSpans.map(({ id, ids }) =>
    frameAround(
      id,
      side,
      ids.map((nodeId) => placedById.get(nodeId)!),
      Infinity,
    ),
  );

  const edges: SidePlacement["edges"] = (centre, finalById) => {
    const sy = centre.y + h / 2;
    const point = (outward: number, y: number) => `${toX(outward) + centre.x} ${y}`;
    const finals = placed.map(({ node, column }) => ({ node: finalById.get(node.id)!, column }));
    // Lanes must stay inside the drawn area (the SVG clips anything above the
    // top-most card or below the bottom-most one) and must not cross a card.
    const floor = Math.min(centre.y, ...finals.map(({ node }) => node.y));
    const ceiling = Math.max(centre.y + h, ...finals.map(({ node }) => node.y + h));
    const laneIsClear = (y: number, column: number) =>
      y >= floor &&
      y <= ceiling &&
      finals.every(({ node, column: c }) => c !== column || y <= node.y || y >= node.y + h);
    return placed.map(({ node: relative, column }) => {
      const node = finalById.get(relative.id)!;
      const ty = node.y + h / 2;
      if (column === 0) {
        return {
          id: `${centre.id}-${node.id}`,
          source: centre.id,
          target: node.id,
          path: buildEdgePath(centre, node, side === "right" ? "left-to-right" : "right-to-left"),
        };
      }
      // Lane through each inner column: the last is the target's own row
      // (an inner gap by construction); each earlier lane is half a pitch
      // up or down, whichever stays closer to the centre.
      const lanes = Array.from<number>({ length: column });
      lanes[column - 1] = ty;
      for (let k = column - 2; k >= 0; k -= 1) {
        const next = lanes[k + 1]!;
        const up = next - pitch / 2;
        const down = next + pitch / 2;
        const [near, far] = Math.abs(up - sy) <= Math.abs(down - sy) ? [up, down] : [down, up];
        lanes[k] = laneIsClear(near, k) || !laneIsClear(far, k) ? near : far;
      }
      const entry = Math.max(Math.min(SIDE_CHANNEL / 2, 72), 24);
      const bend = COLUMN_GAP / 2;
      let path = `M ${point(0, sy)} C ${point(entry, sy)} ${point(SIDE_CHANNEL - entry, lanes[0]!)} ${point(SIDE_CHANNEL, lanes[0]!)}`;
      for (let k = 0; k < column - 1; k += 1) {
        const exit = columnStart(k) + w;
        const nextStart = columnStart(k + 1);
        path += ` L ${point(exit, lanes[k]!)} C ${point(exit + bend, lanes[k]!)} ${point(nextStart - bend, lanes[k + 1]!)} ${point(nextStart, lanes[k + 1]!)}`;
      }
      path += ` L ${point(columnStart(column), ty)}`;
      return { id: `${centre.id}-${node.id}`, source: centre.id, target: node.id, path };
    });
  };

  return { nodes: placed.map(({ node }) => node), frames, edges };
}

/** Lay out the below row and return it relative to the centre's top-left. */
function placeBelow(
  centre: OrgChartNode,
  groups: readonly RelationLayoutGroup[],
  nodeSize: { width: number; height: number },
): { nodes: OrgChartLayoutNode[]; frames: RelationLayoutFrame[] } {
  const nonEmpty = groups.filter((group) => groupNodes(group).length > 0);
  if (nonEmpty.length === 0) return { nodes: [], frames: [] };

  const groupOf = new Map<string, number>();
  const items: OrgChartNode[] = [];
  // Each group's horizontal offset: the group gap, plus the frame padding of
  // every framed group up to and including this one.
  const offsets: number[] = [];
  let framePadding = 0;
  nonEmpty.forEach((group, groupIndex) => {
    if (isFramed(group)) framePadding += FRAME_PAD;
    offsets.push(groupIndex * BELOW_GROUP_GAP + framePadding);
    if (isFramed(group)) framePadding += FRAME_PAD;
    for (const node of groupNodes(group)) {
      groupOf.set(node.id, groupIndex);
      // The org-chart layout orders siblings by `sortKey`; pin the host's order.
      items.push({ ...node, sortKey: String(items.length).padStart(6, "0") });
    }
  });

  const result = computeOrgChartLayout(
    [centre, ...items],
    items.map((item) => ({ from: centre.id, to: item.id })),
    EMPTY_EXPANDED,
    [],
    "",
    false,
    false,
    false,
    undefined,
    { direction: "top-to-bottom", nodeSize, siblingGap: BELOW_GAP },
  );
  const centreNode = result.nodes.find((node) => node.id === centre.id)!;
  const spread = (nonEmpty.length - 1) * BELOW_GROUP_GAP + framePadding;
  const drop = nonEmpty.some(isFramed) ? BELOW_FRAME_DROP : 0;
  const placed: typeof result.nodes = [];
  for (const node of result.nodes) {
    if (node.id === centre.id) continue;
    placed.push({
      ...node,
      x: node.x - centreNode.x + offsets[groupOf.get(node.id) ?? 0]! - spread / 2,
      y: node.y - centreNode.y + drop,
    });
  }
  const placedById = new Map(placed.map((node) => [node.id, node]));
  const frames: RelationLayoutFrame[] = [];
  for (const group of nonEmpty) {
    if (!isFramed(group)) continue;
    frames.push(
      frameAround(
        group.frameId,
        "below",
        group.nodes.map((node) => placedById.get(node.id)!),
        // Stop short of the first card's connector, which drops into the
        // middle of the card's top edge.
        nodeSize.width / 2 + FRAME_PAD - FRAME_CAPTION_INSET - FRAME_CAPTION_CLEARANCE,
      ),
    );
  }
  return { nodes: placed, frames };
}

function boundsOf(boxes: readonly Box[]): OrgChartLayoutBounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const box of boxes) {
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/** Top-to-bottom connector with a straight trunk down to `trunkY`. */
function buildTrunkEdgePath(
  source: OrgChartLayoutNode,
  target: OrgChartLayoutNode,
  trunkY: number,
) {
  const sx = source.x + source.width / 2;
  const sy = source.y + source.height;
  if (trunkY <= sy) return buildEdgePath(source, target, "top-to-bottom");
  // Treat the trunk's foot as the connector's source.
  const fan = buildEdgePath({ ...source, y: trunkY - source.height }, target, "top-to-bottom");
  return `M ${sx} ${sy} L ${sx} ${trunkY} ${fan.replace(/^M \S+ \S+ /, "")}`;
}

export function layoutRelationNeighbourhood(input: RelationLayoutInput): RelationLayout {
  const { centre, sides, nodeSize } = input;

  // One plain layout of the lone centre supplies the node payload template.
  const template = computeOrgChartLayout(
    [centre],
    [],
    EMPTY_EXPANDED,
    [],
    "",
    false,
    false,
    false,
    undefined,
    { nodeSize },
  ).nodes[0]!;
  const centreNode: OrgChartLayoutNode = { ...template, x: 0, y: 0 };

  const left = placeSide("left", sides.left ?? [], nodeSize, template);
  const right = placeSide("right", sides.right ?? [], nodeSize, template);
  const leftItems = left?.nodes ?? [];
  const rightItems = right?.nodes ?? [];
  const sideFrames = [...(left?.frames ?? []), ...(right?.frames ?? [])];

  // Start the below row under whichever is lower: the centre or a side.
  const sideBottom = Math.max(
    centreNode.height,
    ...leftItems.map((node) => node.y + node.height),
    ...rightItems.map((node) => node.y + node.height),
    ...sideFrames.map((frame) => frame.y + frame.height),
  );
  const belowShift = sideBottom - centreNode.height;
  const below = placeBelow(centre, sides.below ?? [], nodeSize);
  const belowItems = below.nodes.map((node) => ({
    ...node,
    y: node.y + belowShift,
  }));
  const belowFrames = below.frames.map((frame) => shiftFrame(frame, 0, belowShift));

  // Order is also the keyboard tab order: left, centre, right, below.
  const all = [...leftItems, centreNode, ...rightItems, ...belowItems];
  const rawFrames = [...sideFrames, ...belowFrames];
  const raw = boundsOf([...all, ...rawFrames.map(frameExtent)]);
  const nodes = all.map((node) => ({ ...node, x: node.x - raw.minX, y: node.y - raw.minY }));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const order = new Map(nodes.map((node, index) => [node.id, index]));
  const frames = rawFrames
    .map((frame) => shiftFrame(frame, -raw.minX, -raw.minY))
    .sort((a, b) => order.get(a.nodeIds[0]!)! - order.get(b.nodeIds[0]!)!);
  const placedCentre = byId.get(centre.id)!;
  const trunkY = placedCentre.y + placedCentre.height + belowShift;
  // With a framed below group, connectors finish fanning out above the
  // captions, then drop straight into their cards.
  let fanEndY: number | null = null;
  for (const frame of frames) {
    if (frame.side !== "below") continue;
    fanEndY = Math.min(fanEndY ?? Infinity, frame.caption.y - FAN_CLEARANCE);
  }

  const edges = [
    ...(left?.edges(placedCentre, byId) ?? []),
    ...(right?.edges(placedCentre, byId) ?? []),
    ...belowItems.map((item) => {
      const target = byId.get(item.id)!;
      const path =
        fanEndY === null
          ? buildTrunkEdgePath(placedCentre, target, trunkY)
          : `${buildTrunkEdgePath(placedCentre, { ...target, y: fanEndY }, trunkY)} L ${target.x + target.width / 2} ${target.y}`;
      return { id: `${centre.id}-${target.id}`, source: centre.id, target: target.id, path };
    }),
  ];

  return { nodes, edges, bounds: boundsOf([...nodes, ...frames.map(frameExtent)]), frames };
}
