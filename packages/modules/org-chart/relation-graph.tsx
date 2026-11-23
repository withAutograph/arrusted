// RelationGraph: a read-only, one-hop neighbourhood around a centre card.
//
// Presentational only. The host decides what belongs on each side, what
// every card says, and what happens on activation; this component shows
// exactly the items it is given:
//
//   left   — what the centre sits under, mirrored to the left
//   right  — the centre's own descriptive values
//   below  — things under the centre, as a row underneath
//
// Sides wrap into brick-offset columns of four cards, as many as needed; see
// `relation-graph-layout.ts`. It reuses the org-chart canvas (camera,
// pan/zoom, keyboard activation, opt-in resize re-fit) and NodeCard's label
// form. Connectors carry no labels.
//
// The graph is flat content, not a canvas: it paints no fill or grid and
// keeps its zoom controls small, so it sits on whatever surface hosts it.
// The host owns the framing (a card, a bordered panel).
//
// A group may be framed: its cards sit in one captioned box (for example a
// mapping table's look-through relations under the table's label).

import { useCallback, useLayoutEffect, useMemo, useRef } from "react";

import {
  OrgChartCanvas,
  type ChartRenderNodeFn,
  type OrgChartCanvasDecoration,
  type OrgChartInitialView,
  type OrgChartData,
} from "./canvas";
import type { OrgChartNode } from "./layout";
import { NodeCard, type NodeCardLabel } from "./node-card";
import "./relation-graph.css";
import {
  layoutRelationNeighbourhood,
  type RelationLayoutFrame,
  type RelationLayoutGroup,
  type RelationLayoutSide,
} from "./relation-graph-layout";
import type { OrgChartNodeActivatePayload } from "./types";

export type RelationGraphItem = NodeCardLabel & {
  /** Unique within its group. */
  id: string;
  /** Render as a loading placeholder; placeholders are not activatable. */
  pending?: boolean;
};

export type RelationGraphOverflow = {
  /** Host-supplied text, e.g. "+54 more". */
  label: string;
  onSelect: () => void;
};

export type RelationGraphFrame = {
  /** Host-supplied caption shown in the frame's top edge, e.g. a model label. */
  caption: string;
  /** Makes the caption a button named "Open <caption>". */
  onSelect?: () => void;
};

export type RelationGraphGroup = {
  /** Unique within its side. */
  id: string;
  items: readonly RelationGraphItem[];
  /** Optional trailing card standing in for items not shown. */
  overflow?: RelationGraphOverflow;
  /**
   * Draw the group's cards inside one captioned box. Each card keeps its
   * own connector and activation. On the left and right a side's framed
   * groups sit in its outermost column; see `relation-graph-layout.ts`.
   */
  frame?: RelationGraphFrame;
};

export type RelationGraphProps = {
  centre: NodeCardLabel;
  /** Identity of the centre. A new key re-fits the camera. Defaults to the
   *  centre's caption and text. */
  centreKey?: string;
  left: readonly RelationGraphGroup[];
  right: readonly RelationGraphGroup[];
  below?: readonly RelationGraphGroup[];
  onSelect: (item: RelationGraphItem, group: RelationGraphGroup) => void;
  /**
   * Neighbours are still loading. Each side that has no groups yet shows
   * one placeholder card (`below` only when it is provided).
   */
  pending?: boolean;
  /** Text on placeholder cards. Defaults to "Loading". */
  pendingLabel?: string;
  /** Card box. Defaults to 208 x 56. */
  nodeSize?: { width: number; height: number };
  /**
   * Screen pixels kept around the chart when it is fitted. Defaults to 80,
   * which keeps cards clear of the zoom controls; a short panel may use less.
   */
  fitPaddingPx?: number;
  /**
   * How the graph opens. "fit" (the default) fits every card; "centre"
   * shows the centre card at 100% and crops the rest. "Fit chart" always
   * fits every card.
   */
  initialView?: "fit" | "centre";
};

const DEFAULT_NODE_SIZE = { width: 208, height: 56 };
const CENTRE_ID = "centre";
const CENTRE_VIEW: OrgChartInitialView = { kind: "centre-on-node", nodeId: CENTRE_ID, scale: 1 };
const EMPTY_FIELDS: string[] = [];
// Fit generously but never enlarge cards beyond their natural size. The
// padding keeps cards clear of the canvas zoom controls in the corner.
const FIT_MAX_SCALE = 1;
const FIT_PADDING_PX = 80;

type CardEntry = {
  label: NodeCardLabel;
  kind: "centre" | "item" | "overflow" | "pending";
  activate?: () => void;
};

/**
 * Cap a group to its first `limit` items. When `total` exceeds what is
 * shown, adds an overflow card whose text comes from `overflowLabel`.
 */
export function capRelationGroup(options: {
  id: string;
  items: readonly RelationGraphItem[];
  /** Full item count, which may exceed `items.length`. */
  total: number;
  limit?: number;
  overflowLabel: (hiddenCount: number) => string;
  onOverflow: () => void;
}): RelationGraphGroup {
  const limit = options.limit ?? 3;
  const shown = options.items.slice(0, limit);
  const hidden = Math.max(options.total - shown.length, 0);
  return {
    id: options.id,
    items: shown,
    overflow:
      hidden > 0
        ? { label: options.overflowLabel(hidden), onSelect: options.onOverflow }
        : undefined,
  };
}

// Encode the card's identity as a tuple so host ids containing separators
// (e.g. "a/b") or reserved-looking values (e.g. "+more") never collide.
function cardId(
  side: RelationLayoutSide,
  kind: "pending" | "item" | "overflow" | "frame",
  groupId?: string,
  itemId?: string,
): string {
  return JSON.stringify([side, kind, groupId ?? null, itemId ?? null]);
}

function accessibleName(label: NodeCardLabel): string {
  return label.caption ? `${label.caption}: ${label.primary}` : label.primary;
}

export function RelationGraph(props: RelationGraphProps) {
  const {
    centre,
    left,
    right,
    below,
    onSelect,
    pending = false,
    pendingLabel = "Loading",
    nodeSize = DEFAULT_NODE_SIZE,
    fitPaddingPx = FIT_PADDING_PX,
    initialView = "fit",
  } = props;
  const centreKey = props.centreKey ?? accessibleName(centre);
  // Read the latest handler at activation time so a new `onSelect` identity
  // does not rebuild the layout.
  const onSelectRef = useRef(onSelect);
  useLayoutEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  const { layout, cards, frames, key } = useMemo(() => {
    const cardsById = new Map<string, CardEntry>();
    const framesById = new Map<string, RelationGraphFrame>();
    const centreNode: OrgChartNode = {
      id: CENTRE_ID,
      name: accessibleName(centre),
      nodeKind: "subject",
      fieldValues: {},
      interactive: false,
    };
    cardsById.set(CENTRE_ID, { label: centre, kind: "centre" });

    const sideNodes = (
      side: RelationLayoutSide,
      groups: readonly RelationGraphGroup[] | undefined,
    ): RelationLayoutGroup[] => {
      if (!groups) return [];
      if (groups.length === 0) {
        if (!pending) return [];
        const id = cardId(side, "pending");
        cardsById.set(id, { label: { primary: pendingLabel }, kind: "pending" });
        return [
          [{ id, name: pendingLabel, nodeKind: "subject", fieldValues: {}, interactive: false }],
        ];
      }
      return groups.map((group) => {
        const nodes: OrgChartNode[] = group.items.map((item) => {
          const id = cardId(side, "item", group.id, item.id);
          cardsById.set(id, {
            label: item,
            kind: item.pending ? "pending" : "item",
            activate: item.pending ? undefined : () => onSelectRef.current(item, group),
          });
          return {
            id,
            name: accessibleName(item),
            nodeKind: "subject",
            fieldValues: {},
            interactive: !item.pending,
          };
        });
        if (group.overflow) {
          const overflow = group.overflow;
          const id = cardId(side, "overflow", group.id);
          cardsById.set(id, {
            label: { primary: overflow.label, muted: true },
            kind: "overflow",
            activate: overflow.onSelect,
          });
          nodes.push({ id, name: overflow.label, nodeKind: "subject", fieldValues: {} });
        }
        if (!group.frame) return nodes;
        const frameId = cardId(side, "frame", group.id);
        framesById.set(frameId, group.frame);
        return { frameId, nodes };
      });
    };

    const positioned = layoutRelationNeighbourhood({
      centre: centreNode,
      sides: {
        left: sideNodes("left", left),
        right: sideNodes("right", right),
        below: sideNodes("below", below),
      },
      nodeSize,
    });
    // Re-fit when the centre changes or the set of cards changes shape
    // (for example placeholders resolving), not on every render.
    const shapeKey = JSON.stringify([
      centreKey,
      nodeSize.width,
      nodeSize.height,
      positioned.nodes.map((node) => node.id),
      ...(positioned.frames.length > 0 ? [positioned.frames.map((frame) => frame.id)] : []),
    ]);
    return { layout: positioned, cards: cardsById, frames: framesById, key: shapeKey };
  }, [centre, centreKey, left, right, below, pending, pendingLabel, nodeSize]);

  const data = useMemo<OrgChartData>(() => ({ key, label: null, nodes: [], links: [] }), [key]);

  const decorations = useMemo<OrgChartCanvasDecoration[] | undefined>(() => {
    if (layout.frames.length === 0) return undefined;
    return layout.frames.map((placed) => ({
      id: placed.id,
      beforeNodeId: placed.nodeIds[0]!,
      element: <RelationGraphFrameBox placed={placed} frame={frames.get(placed.id)!} />,
    }));
  }, [layout, frames]);

  const renderNode = useCallback<ChartRenderNodeFn>(
    (node) => {
      const card = cards.get(node.id);
      if (!card) return null;
      return (
        <NodeCard
          label={card.label}
          state={
            card.kind === "centre" ? "current" : card.kind === "pending" ? "pending" : "default"
          }
        />
      );
    },
    [cards],
  );

  const handleActivate = useCallback(
    (payload: OrgChartNodeActivatePayload) => {
      cards.get(payload.nodeId)?.activate?.();
    },
    [cards],
  );

  return (
    <OrgChartCanvas
      data={data}
      layout={layout}
      renderNode={renderNode}
      onNodeActivate={handleActivate}
      visibleFields={EMPTY_FIELDS}
      asOfDate=""
      filterActive={false}
      showSlots={false}
      fitMaxScale={FIT_MAX_SCALE}
      fitPaddingPx={fitPaddingPx}
      refitOnResize
      decorations={decorations}
      initialView={initialView === "centre" ? CENTRE_VIEW : undefined}
      surface="flat"
    />
  );
}

/** The frame's border box and its caption, in chart coordinates. */
function RelationGraphFrameBox({
  placed,
  frame,
}: {
  placed: RelationLayoutFrame;
  frame: RelationGraphFrame;
}) {
  const { caption } = placed;
  const captionStyle = {
    left: caption.x,
    top: caption.y,
    height: caption.height,
    maxWidth: caption.width,
  };
  const text = <span className="relation-graph-frame-caption-text">{frame.caption}</span>;
  return (
    <>
      <div
        aria-hidden
        className="relation-graph-frame"
        data-relation-graph-frame="true"
        style={{ left: placed.x, top: placed.y, width: placed.width, height: placed.height }}
      />
      {frame.onSelect ? (
        <button
          type="button"
          className="relation-graph-frame-caption"
          data-org-chart-control="true"
          aria-label={`Open ${frame.caption}`}
          title={frame.caption}
          style={captionStyle}
          onClick={frame.onSelect}
        >
          {text}
        </button>
      ) : (
        <p className="relation-graph-frame-caption" title={frame.caption} style={captionStyle}>
          {text}
        </p>
      )}
    </>
  );
}
