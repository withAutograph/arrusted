// NodeCard is the per-node card primitive for the org-chart module.
// It renders two generic halves: an optional occupant and a durable slot.
// App code decides how domain records map onto those halves.
//
// The `label` form is the same card reduced to one block: a main line with
// an optional small caption above it. Relationship graphs use it for a
// neighbour (caption = column header, main line = value), a header-only
// card, the current centre, and overflow ("+N more") cards.

import "./node-card.css";

export type NodeCardAccent = {
  /** CSS variable reference for the dot color (e.g. `"var(--accent-eng)"`).
   *  The caller owns the mapping from their domain category to a token;
   *  the module ships no domain palette. */
  color: string;
  /** Aria label for the dot (e.g. "Platform"). */
  label: string;
};

export type NodeCardDetail = {
  /** Text content for this detail field. */
  label: string;
  /** Optional dot prefix rendered before the label. */
  accent?: NodeCardAccent;
};

/** Up to two details per half, rendered as a single row with the
 *  first detail left-aligned and the optional second detail
 *  right-aligned. The tuple type caps the array at two at compile
 *  time — apps that pass three get a type error. */
export type NodeCardDetailPair =
  | readonly [NodeCardDetail]
  | readonly [NodeCardDetail, NodeCardDetail];

export type NodeCardSlot = {
  /** Durable slot label. */
  title: string;
  /** Optional small badge pinned to the right of the title row. */
  badge?: string;
  /** Up to 2 detail fields rendered as a left | right row after the title. */
  details?: NodeCardDetailPair;
};

export type NodeCardOccupant = {
  /** Primary line for the optional occupant half. */
  primary: string;
  /** Up to 2 detail fields rendered as a left | right row after the primary line. */
  details?: NodeCardDetailPair;
};

export type NodeCardLabel = {
  /** Main line, in ink. Truncates with an ellipsis; the full text is the
   *  card's tooltip. */
  primary: string;
  /** Optional small muted caption rendered above the main line. */
  caption?: string;
  /** Quiet the main line, e.g. for an overflow card such as "+54 more". */
  muted?: boolean;
};

/**
 * - `focused`: host selection ring.
 * - `dimmed`: filtered out.
 * - `current`: the card the view is about. Tinted and marked
 *   `aria-current`; hosts should not make it activatable.
 * - `pending`: placeholder while its content loads (dashed, pulsing,
 *   `aria-busy`).
 */
export type NodeCardState = "default" | "focused" | "dimmed" | "current" | "pending";

type NodeCardCommonProps = {
  state?: NodeCardState;
  /** Forwarded to the wrapper for layout positioning by the canvas. */
  style?: React.CSSProperties;
  className?: string;
};

export type NodeCardProps = NodeCardCommonProps &
  (
    | {
        slot: NodeCardSlot;
        /** Omit to render the "Open" empty state. */
        occupant?: NodeCardOccupant;
        label?: never;
      }
    | {
        /** Single-block card. Fills its container's box, so the canvas
         *  `nodeSize` decides its width and height. */
        label: NodeCardLabel;
        slot?: never;
        occupant?: never;
      }
  );

function NodeCardDetailsRow({ details }: { details: NodeCardDetailPair }) {
  const [left, right] = details;
  return (
    <p className="node-card-details">
      <NodeCardDetailItem detail={left} side="left" />
      {right ? <NodeCardDetailItem detail={right} side="right" /> : null}
    </p>
  );
}

function NodeCardDetailItem({ detail, side }: { detail: NodeCardDetail; side: "left" | "right" }) {
  // The dot color rides on an inline custom property so the paired
  // CSS resolves it without merging runtime styles into the dot
  // element directly — keeps the dot a pure CSS-driven shape.
  const dotStyle = detail.accent
    ? ({
        ["--node-card-detail-accent" as string]: detail.accent.color,
      } as React.CSSProperties)
    : undefined;
  return (
    <span className={`node-card-detail node-card-detail-${side}`} style={dotStyle}>
      {detail.accent ? (
        <span role="img" aria-label={detail.accent.label} className="node-card-detail-dot" />
      ) : null}
      <span className="node-card-detail-label">{detail.label}</span>
    </span>
  );
}

function NodeCardLabelBlock({
  label,
  state,
  style,
  className,
}: {
  label: NodeCardLabel;
  state: NodeCardState;
  style?: React.CSSProperties;
  className?: string;
}) {
  const wrapperClass = ["node-card", className].filter(Boolean).join(" ");
  const title = label.caption ? `${label.caption}: ${label.primary}` : label.primary;
  return (
    <div
      data-node-state={state}
      data-node-variant="label"
      data-node-muted={label.muted ? "true" : undefined}
      aria-current={state === "current" ? "true" : undefined}
      aria-busy={state === "pending" ? "true" : undefined}
      title={title}
      className={wrapperClass}
      style={style}
    >
      {label.caption ? <p className="node-card-label-caption">{label.caption}</p> : null}
      <p className="node-card-label-primary">{label.primary}</p>
    </div>
  );
}

export function NodeCard(props: NodeCardProps) {
  if (props.label) {
    return (
      <NodeCardLabelBlock
        label={props.label}
        state={props.state ?? "default"}
        style={props.style}
        className={props.className}
      />
    );
  }

  const { slot, occupant, state = "default", style, className } = props;

  const wrapperClass = ["node-card", className].filter(Boolean).join(" ");

  return (
    <div
      data-node-state={state}
      data-node-empty={occupant ? undefined : "true"}
      aria-current={state === "current" ? "true" : undefined}
      aria-busy={state === "pending" ? "true" : undefined}
      className={wrapperClass}
      style={style}
    >
      <div className="node-card-occupant">
        {occupant ? (
          <>
            <p className="node-card-occupant-primary">{occupant.primary}</p>
            {occupant.details ? <NodeCardDetailsRow details={occupant.details} /> : null}
          </>
        ) : (
          <p className="node-card-occupant-empty">Open</p>
        )}
      </div>
      <footer className="node-card-slot">
        <div className="node-card-slot-row">
          <p className="node-card-title">{slot.title}</p>
          {slot.badge ? <span className="node-card-badge">{slot.badge}</span> : null}
        </div>
        {slot.details ? <NodeCardDetailsRow details={slot.details} /> : null}
      </footer>
    </div>
  );
}
