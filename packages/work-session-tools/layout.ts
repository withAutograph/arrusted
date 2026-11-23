import type { WorkJson } from "@autograph/generated-app-runtime/data";
import { z } from "zod";

/**
 * A `rule` unit shows one session rule on the plane (`config.rule_id`); a
 * `note` is plain text; a `kpi` is a strip of aggregates over one model.
 */
export const unitKinds = ["grid", "chart", "graph", "rule", "note", "kpi"] as const;
export type UnitKind = (typeof unitKinds)[number];

/** The chart kinds, each drawn by one `@autograph/compositions` chart family. */
export const chartKinds = ["breakdown", "donut", "heatmap", "stacked_timeline", "range"] as const;
export type ChartKind = (typeof chartKinds)[number];
const metricSchema = z.discriminatedUnion("fn", [
  z.strictObject({ fn: z.literal("count") }),
  z.strictObject({ fn: z.enum(["sum", "avg"]), field_id: z.string().min(1) }),
]);
/** The most filters a chart unit's header offers. */
export const chartFilterLimit = 6;
/**
 * A chart unit's header filters: each offers a picker for one column (an
 * enum or a relation, by field id); a `value` (an option id or a record id)
 * narrows the chart's reads to it, and none means all.
 */
export const chartFiltersSchema = z
  .array(
    z.strictObject({
      field_id: z.string().min(1),
      value: z.union([z.string().min(1), z.boolean()]).optional(),
    }),
  )
  .max(chartFilterLimit)
  .optional();
export type ChartFilter = NonNullable<z.infer<typeof chartFiltersSchema>>[number];
const aggregateChart = {
  model_id: z.string().min(1),
  /** Breakdown and donut: the groups; heatmap: the rows; stacked timeline: the time column. */
  group_by: z.string().min(1),
  metric: metricSchema,
  filters: chartFiltersSchema,
};
/**
 * A chart unit's config. Columns are field ids. An aggregate chart groups by
 * one column (and `series_by`, a heatmap's columns or a timeline's stacks)
 * and measures one metric; a `range` chart reads records: each record's
 * `value` as a point against its own range from `low` to `high`, grouped by `group_by` (and `target`).
 * An earlier `bar` chart reads as a breakdown. `filters` are the header's
 * column filters.
 */
export const chartConfigSchema = z.preprocess(
  (value) =>
    value !== null &&
    typeof value === "object" &&
    ((value as { kind?: unknown }).kind === "bar" || !("kind" in value))
      ? { ...value, kind: "breakdown" }
      : value,
  z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("breakdown"), ...aggregateChart }),
    z.strictObject({ kind: z.literal("donut"), ...aggregateChart }),
    z.strictObject({
      kind: z.literal("heatmap"),
      ...aggregateChart,
      series_by: z.string().min(1),
    }),
    z.strictObject({
      kind: z.literal("stacked_timeline"),
      ...aggregateChart,
      series_by: z.string().min(1),
    }),
    z.strictObject({
      kind: z.literal("range"),
      model_id: z.string().min(1),
      group_by: z.string().min(1),
      value: z.string().min(1),
      low: z.string().min(1),
      high: z.string().min(1),
      target: z.string().min(1).optional(),
      filters: chartFiltersSchema,
    }),
  ]),
);
export type ChartConfig = z.infer<typeof chartConfigSchema>;

/** A note unit: plain text, edited in place. */
export const noteMaxLength = 4000;
export const noteConfigSchema = z.strictObject({ text: z.string().max(noteMaxLength) });

/** A KPI strip: one to six aggregates over one model (`fn` and, except for count, a column). */
export const kpiConfigSchema = z.strictObject({
  model_id: z.string().min(1),
  metrics: z
    .array(
      z.discriminatedUnion("fn", [
        z.strictObject({ fn: z.literal("count") }),
        z.strictObject({
          fn: z.enum(["sum", "avg", "min", "max", "median"]),
          field_id: z.string().min(1),
        }),
      ]),
    )
    .min(1)
    .max(6),
});
export type KpiConfig = z.infer<typeof kpiConfigSchema>;

const unitSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(unitKinds),
    /** Per-kind settings (model, chart spec, relation, rule); the unit reads its own. */
    config: z.record(z.string(), z.custom<WorkJson>()),
    x: z.number(),
    y: z.number(),
    w: z.number().positive(),
    h: z.number().positive(),
    /** Grid mode: the columns the unit spans (default: full width for grids and KPI strips, half otherwise). */
    span: z.number().int().positive().optional(),
    /** The unit's title in product words ("Base pay vs range"); without it the canvas names it from its config. */
    title: z.string().trim().min(1).max(80).optional(),
  })
  .refine((unit) => unit.kind !== "rule" || typeof unit.config.rule_id === "string", {
    message: "A rule unit names its rule.",
    path: ["config", "rule_id"],
  });
const gridSchema = z.object({
  columns: z.number().int().min(1).max(24),
  gap: z.number().min(0).max(400),
});
/**
 * `session.layout`. A new session's layout is `{}`, which holds no units.
 * Grid mode (the default; `mode` absent) places units in reading order by
 * span; free mode keeps each unit's x and y, Figma-like.
 */
export const layoutSchema = z.object({
  mode: z.enum(["grid", "free"]).optional(),
  grid: gridSchema.optional(),
  units: z.array(unitSchema).default([]),
});
export type CanvasUnit = z.infer<typeof unitSchema>;
export type CanvasLayout = z.infer<typeof layoutSchema>;
export type CanvasGrid = z.infer<typeof gridSchema>;

/** The session's layout, or the validation message when it is not one. */
export function parseLayout(
  value: unknown,
): { ok: true; layout: CanvasLayout } | { ok: false; error: string } {
  const parsed = layoutSchema.safeParse(value);
  return parsed.success
    ? { ok: true, layout: parsed.data }
    : { ok: false, error: z.prettifyError(parsed.error) };
}

/** Default unit sizes in plane pixels (from the spike). */
export const unitSizes: Record<UnitKind, { w: number; h: number }> = {
  grid: { w: 1160, h: 460 },
  chart: { w: 640, h: 380 },
  graph: { w: 720, h: 420 },
  rule: { w: 440, h: 168 },
  note: { w: 400, h: 220 },
  kpi: { w: 960, h: 160 },
};
const origin = { x: 80, y: 24 };
const gap = 32;
/** The width new units are placed within before wrapping to a new row. */
const planeWidth = 1560;

/**
 * The first free slot for a unit of `size`, in reading order: the candidates
 * are the plane origin and the points just right of and just below every
 * unit; a slot must not overlap any unit (with the gap) and stays within the
 * plane width unless it starts at the left edge.
 */
export function freeSlot(layout: CanvasLayout, size: { w: number; h: number }) {
  const xs = [origin.x, ...layout.units.map((unit) => unit.x + unit.w + gap)];
  const ys = [origin.y, ...layout.units.map((unit) => unit.y + unit.h + gap)];
  const fits = (x: number, y: number) =>
    (x === origin.x || x + size.w <= origin.x + planeWidth) &&
    layout.units.every(
      (unit) =>
        x >= unit.x + unit.w + gap ||
        x + size.w + gap <= unit.x ||
        y >= unit.y + unit.h + gap ||
        y + size.h + gap <= unit.y,
    );
  const candidates = ys
    .flatMap((y) => xs.map((x) => ({ x, y })))
    .toSorted((a, b) => a.y - b.y || a.x - b.x);
  // Below every unit at the left edge always fits.
  return candidates.find(({ x, y }) => fits(x, y)) ?? { x: origin.x, y: Math.max(...ys) };
}

/** Grid mode unless the layout says free. */
export const isGridLayout = (layout: CanvasLayout) => layout.mode !== "free";

/**
 * Appends a new unit of `kind` at its default size: a grid layout re-places
 * every unit in reading order (the new one last); a free layout puts it in
 * the first free slot.
 */
export function addUnit(
  layout: CanvasLayout,
  kind: UnitKind,
  config: { readonly [key: string]: WorkJson } = {},
  id = `unit-${crypto.randomUUID().slice(0, 8)}`,
): CanvasLayout {
  const size = unitSizes[kind];
  if (isGridLayout(layout))
    return placeGrid({
      ...layout,
      units: [...layout.units, { id, kind, config, x: 0, y: 0, ...size }],
    });
  const unit: CanvasUnit = { id, kind, config, ...freeSlot(layout, size), ...size };
  return { ...layout, units: [...layout.units, unit] };
}

// Grid arithmetic, from the spike's layout-arrange: shared by the canvas (grid
// rendering) and the agent's layout tool. Grid mode places units in reading
// order: each takes `span` columns of a fixed-width grid and wraps to a new
// row when it does not fit; a row is as tall as its tallest unit. x, y and w
// are derived from that and stored too, so switching to free mode keeps the
// arrangement.

/** Where the grid starts and how wide it is, in plane pixels. */
export const gridOrigin = origin;
export const gridWidth = planeWidth;
export const defaultGrid: CanvasGrid = { columns: 12, gap: 24 };

/** The narrowest column a stored grid may have (at the stored grid width). */
export const minColumnWidth = 24;

/** One column's width when the grid is `width` plane pixels wide. */
export const columnWidth = (grid: CanvasGrid, width: number = gridWidth) =>
  (width - grid.gap * (grid.columns - 1)) / grid.columns;

/**
 * Where a grid is laid out: its left edge and width in plane pixels. Stored
 * layouts use the fixed origin and width; the canvas lays the same order and
 * spans out across the width it has, so nothing runs off its right edge.
 */
export type GridFrame = { x: number; width: number };

/** Kinds that take the full width by default: a grid of records and a KPI strip. */
const fullWidth = (kind: UnitKind) => kind === "grid" || kind === "kpi";

/** A unit without a span takes the full width for grids and KPI strips, half otherwise. */
export const defaultSpan = (kind: UnitKind, columns: number) =>
  fullWidth(kind) ? columns : Math.max(1, Math.ceil(columns / 2));

const clampSpan = (span: number, columns: number) =>
  Math.min(columns, Math.max(1, Math.round(span)));

/** The gap and column width a grid renders with in a frame `width` wide. */
function gridMetrics(grid: CanvasGrid, width: number) {
  // A narrow frame still gives every column some width; gaps shrink first.
  const gap = Math.min(
    grid.gap,
    Math.max(0, (width - grid.columns * 8) / Math.max(1, grid.columns - 1)),
  );
  return { gap, column: Math.max(8, columnWidth({ ...grid, gap }, width)) };
}

/** Derive every unit's position and width from its order and span (in `frame`). */
export function placeGrid(
  layout: CanvasLayout,
  frame: GridFrame = { x: gridOrigin.x, width: gridWidth },
): CanvasLayout {
  const grid = layout.grid ?? defaultGrid;
  const { gap, column } = gridMetrics(grid, frame.width);
  let col = 0;
  let rowTop: number = gridOrigin.y;
  let rowHeight = 0;
  const units = layout.units.map((unit): CanvasUnit => {
    const span = clampSpan(unit.span ?? defaultSpan(unit.kind, grid.columns), grid.columns);
    if (col > 0 && col + span > grid.columns) {
      rowTop += rowHeight + gap;
      col = 0;
      rowHeight = 0;
    }
    const placed = {
      ...unit,
      span,
      x: Math.round(frame.x + col * (column + gap)),
      y: Math.round(rowTop),
      w: Math.max(1, Math.round(span * column + (span - 1) * gap)),
    };
    col += span;
    rowHeight = Math.max(rowHeight, unit.h);
    return placed;
  });
  return { mode: "grid", grid, units };
}

/** The layout as the plane shows it: grid layouts placed, free ones as stored. */
export const placedLayout = (layout: CanvasLayout): CanvasLayout =>
  isGridLayout(layout) ? placeGrid(layout) : layout;

/** The span a grid unit gets when resized to `width` plane pixels (in a grid `frameWidth` wide). */
export function spanForWidth(width: number, grid: CanvasGrid, frameWidth: number = gridWidth) {
  const { gap, column } = gridMetrics(grid, frameWidth);
  return clampSpan((width + gap) / (column + gap), grid.columns);
}

/** Heights the auto arrangement uses: grids tall, KPI strips short, the rest one even row. */
const autoHeights: Record<UnitKind, number> = {
  grid: 480,
  kpi: 160,
  graph: 440,
  chart: 440,
  rule: 200,
  note: 200,
};

/**
 * A tidy arrangement: grids and KPI strips full width on top (in their
 * current order), then every other unit in rows below, two or three per row
 * depending on how many there are, each row as tall as its tallest unit.
 */
export function arrangeAuto(layout: CanvasLayout): CanvasLayout {
  const columns = defaultGrid.columns;
  const wide = layout.units.filter((unit) => fullWidth(unit.kind));
  const rest = layout.units.filter((unit) => !fullWidth(unit.kind));
  const span = rest.length <= 2 ? 6 : rest.length === 4 ? 6 : 4;
  const units = [
    ...wide.map((unit) => ({ ...unit, span: columns, h: autoHeights[unit.kind] })),
    ...rest.map((unit) => ({ ...unit, span, h: autoHeights[unit.kind] })),
  ];
  return placeGrid({ mode: "grid", grid: { ...defaultGrid }, units });
}

/** The agent's arrangement request (`arrange_layout`). */
export type ArrangeInput = {
  mode: "grid" | "free" | "auto";
  columns?: number;
  gap?: number;
  units?: {
    unit_id: string;
    span?: number;
    order?: number;
    h?: number;
    x?: number;
    y?: number;
    w?: number;
  }[];
};

/** An arrangement the layout cannot take; the message says why. */
export class ArrangeError extends Error {
  readonly code = "contract_validation_failed";
}

const sizeRange = { min: 80, max: 4000 };
const checkSize = (unitId: string, value: number, what: string) => {
  if (!Number.isFinite(value) || value < sizeRange.min || value > sizeRange.max)
    throw new ArrangeError(
      `${what} for ${unitId} must be ${sizeRange.min} to ${sizeRange.max} pixels.`,
    );
};

/**
 * The layout tool. "grid" places units by order and column span (heights
 * optional) in `columns` columns; "free" sets x, y, w, h per unit, Figma-like;
 * "auto" picks a tidy grid: grids and KPI strips full width on top, the rest
 * in rows below. Units not mentioned keep their settings and come after the
 * listed ones.
 */
export function arrangeLayout(layout: CanvasLayout, input: ArrangeInput): CanvasLayout {
  const listed = input.units ?? [];
  const seen = new Set<string>();
  for (const item of listed) {
    if (!layout.units.some((unit) => unit.id === item.unit_id))
      throw new ArrangeError(`no unit ${item.unit_id} on the canvas`);
    if (seen.has(item.unit_id)) throw new ArrangeError(`Unit ${item.unit_id} is listed twice.`);
    seen.add(item.unit_id);
    if (item.h !== undefined) checkSize(item.unit_id, item.h, "h");
  }
  if (input.mode === "auto") {
    if (listed.length > 0 || input.columns !== undefined)
      throw new ArrangeError("auto arranges every unit itself; give no units or columns.");
    return arrangeAuto(layout);
  }
  const byId = new Map(listed.map((item) => [item.unit_id, item]));
  if (input.mode === "free") {
    for (const item of listed) {
      if ([item.x, item.y, item.w, item.h].some((value) => value === undefined))
        throw new ArrangeError(`free mode needs x, y, w and h for ${item.unit_id}.`);
      checkSize(item.unit_id, item.w!, "w");
    }
    const placed = placedLayout(layout);
    return {
      ...placed,
      mode: "free",
      units: placed.units.map((unit): CanvasUnit => {
        const item = byId.get(unit.id);
        return item
          ? { ...unit, x: Math.max(0, item.x!), y: Math.max(0, item.y!), w: item.w!, h: item.h! }
          : unit;
      }),
    };
  }
  const grid = {
    columns: input.columns ?? layout.grid?.columns ?? defaultGrid.columns,
    gap: input.gap ?? layout.grid?.gap ?? defaultGrid.gap,
  };
  if (!Number.isInteger(grid.columns) || grid.columns < 1 || grid.columns > 24)
    throw new ArrangeError("columns must be a whole number from 1 to 24.");
  if (grid.gap < 0 || grid.gap > 400) throw new ArrangeError("gap must be 0 to 400 pixels.");
  // Every column keeps some width: a stored grid's units always validate.
  if (columnWidth(grid) < minColumnWidth)
    throw new ArrangeError(
      `${grid.columns} columns with a ${grid.gap}px gap leave no room for the units; use fewer columns or a smaller gap.`,
    );
  for (const item of listed)
    if (
      item.span !== undefined &&
      (!Number.isInteger(item.span) || item.span < 1 || item.span > grid.columns)
    )
      throw new ArrangeError(`span for ${item.unit_id} must be 1 to ${grid.columns}.`);
  // Listed units in their given order (by `order`, then list position), the rest after.
  const ordered = [
    ...listed
      .map((item, index) => ({ item, index }))
      .toSorted(
        (left, right) =>
          (left.item.order ?? left.index) - (right.item.order ?? right.index) ||
          left.index - right.index,
      )
      .map(({ item }) => layout.units.find((unit) => unit.id === item.unit_id)!),
    ...layout.units.filter((unit) => !seen.has(unit.id)),
  ];
  const previous = layout.grid?.columns ?? defaultGrid.columns;
  const units = ordered.map((unit): CanvasUnit => {
    const item = byId.get(unit.id);
    // A span from another column count keeps its share of the width.
    const span =
      item?.span ??
      (unit.span === undefined
        ? undefined
        : Math.min(grid.columns, Math.max(1, Math.round((unit.span * grid.columns) / previous))));
    return {
      ...unit,
      ...(span === undefined ? {} : { span }),
      ...(item?.h === undefined ? {} : { h: item.h }),
    };
  });
  return placeGrid({ mode: "grid", grid, units });
}

/**
 * A new session's scope and arranged layout: one grid per model, for the
 * named models or else every model of the app. No app composes a starting
 * canvas; the agent offers starting canvases. `modelIds` comes main model first (`mainModelOrder` in
 * `./labels`), and named models keep that order (any it does not know go
 * last). Unit ids follow from their order, so a retried create sends the
 * same layout.
 */
export function newSessionLayout(
  modelIds: readonly string[],
  named?: readonly string[],
): { models: string[]; layout: CanvasLayout } {
  const rank = (id: string) => {
    const index = modelIds.indexOf(id);
    return index === -1 ? modelIds.length : index;
  };
  const models = [...new Set(named ?? modelIds)].toSorted((a, b) => rank(a) - rank(b));
  let layout: CanvasLayout = { units: [] };
  for (const [index, model] of models.entries())
    layout = addUnit(layout, "grid", { model_id: model }, `unit-${index + 1}`);
  return { models, layout: arrangeAuto(layout) };
}
