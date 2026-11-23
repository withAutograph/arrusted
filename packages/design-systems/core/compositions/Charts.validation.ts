import { requireArray, requireObject, requireString } from "./spec";
import type {
  BreakdownChartConfig,
  ChartCommonConfig,
  ChartConfig,
  ChartPaletteColor,
  ChartValueFormat,
  CombinedBarLineChartConfig,
  DonutChartConfig,
  HeatmapChartConfig,
  KpiStripSpec,
  RangeMarkerChartConfig,
  ScatterChartConfig,
  StackedTimelineChartConfig,
  WaterfallChartConfig,
} from "./Charts";

const PALETTE = new Set<ChartPaletteColor>(["chart-1", "chart-2", "chart-3", "chart-4"]);
const COMMON_KEYS = new Set([
  "family",
  "frame",
  "height",
  "valueFormat",
  "showLegend",
  "emptyLabel",
  "controls",
  "segmentAction",
]);

export function validateChartSpec(value: unknown): ChartConfig {
  const object = requireObject(value, "chart.config");
  const family = requireString(object.family, "chart.family");
  if (family === "breakdown") return validateBreakdown(object);
  if (family === "stacked_timeline") return validateTimeline(object);
  if (family === "waterfall") return validateWaterfall(object);
  if (family === "scatter") return validateScatter(object);
  if (family === "range_marker") return validateRangeMarker(object);
  if (family === "donut") return validateDonut(object);
  if (family === "combined_bar_line") return validateCombinedBarLine(object);
  if (family === "heatmap") return validateHeatmap(object);
  throw new Error(`chart.family is unsupported: ${family}`);
}

function validateDonut(object: Record<string, unknown>): DonutChartConfig {
  rejectUnknownKeys(
    object,
    new Set([...COMMON_KEYS, "data", "valueLabel", "innerRadiusRatio"]),
    "chart.donut",
  );
  const common = validateCommon(object);
  const ratio = object.innerRadiusRatio;
  if (ratio !== undefined && (typeof ratio !== "number" || ratio < 0 || ratio > 0.9)) {
    throw new Error("chart.donut.innerRadiusRatio must be a number from 0 through 0.9");
  }
  const ids = new Set<string>();
  const data = requireArray(object.data, "chart.donut.data", (item, index) => {
    const datum = requireObject(item, `chart.donut.data[${index}]`);
    rejectUnknownKeys(
      datum,
      new Set(["id", "label", "value", "color"]),
      `chart.donut.data[${index}]`,
    );
    const value = finiteNumber(datum.value, `chart.donut.data[${index}].value`);
    if (value < 0) throw new Error(`chart.donut.data[${index}].value must not be negative`);
    return {
      id: uniqueId(datum.id, ids, `chart.donut.data[${index}].id`),
      label: requireString(datum.label, `chart.donut.data[${index}].label`),
      value,
      color: optionalPalette(datum.color, `chart.donut.data[${index}].color`),
    };
  });
  return {
    family: "donut",
    ...common,
    data,
    valueLabel: optionalString(object.valueLabel, "chart.donut.valueLabel"),
    innerRadiusRatio: ratio as number | undefined,
  };
}

function validateCombinedBarLine(object: Record<string, unknown>): CombinedBarLineChartConfig {
  rejectUnknownKeys(
    object,
    new Set([...COMMON_KEYS, "data", "barLabel", "lineLabel", "barValueFormat", "lineValueFormat"]),
    "chart.combined_bar_line",
  );
  const common = validateCommon(object);
  const ids = new Set<string>();
  const data = requireArray(object.data, "chart.combined_bar_line.data", (item, index) => {
    const datum = requireObject(item, `chart.combined_bar_line.data[${index}]`);
    rejectUnknownKeys(
      datum,
      new Set(["id", "label", "barValue", "lineValue"]),
      `chart.combined_bar_line.data[${index}]`,
    );
    return {
      id: uniqueId(datum.id, ids, `chart.combined_bar_line.data[${index}].id`),
      label: requireString(datum.label, `chart.combined_bar_line.data[${index}].label`),
      barValue: finiteNumber(datum.barValue, `chart.combined_bar_line.data[${index}].barValue`),
      lineValue: finiteNumber(datum.lineValue, `chart.combined_bar_line.data[${index}].lineValue`),
    };
  });
  return {
    family: "combined_bar_line",
    ...common,
    data,
    barLabel: requireString(object.barLabel, "chart.combined_bar_line.barLabel"),
    lineLabel: requireString(object.lineLabel, "chart.combined_bar_line.lineLabel"),
    barValueFormat: validateValueFormat(object.barValueFormat),
    lineValueFormat: validateValueFormat(object.lineValueFormat),
  };
}

function validateHeatmap(object: Record<string, unknown>): HeatmapChartConfig {
  rejectUnknownKeys(
    object,
    new Set([...COMMON_KEYS, "data", "xLabel", "yLabel", "valueLabel"]),
    "chart.heatmap",
  );
  const common = validateCommon(object);
  const ids = new Set<string>();
  const coordinates = new Set<string>();
  const data = requireArray(object.data, "chart.heatmap.data", (item, index) => {
    const datum = requireObject(item, `chart.heatmap.data[${index}]`);
    rejectUnknownKeys(
      datum,
      new Set(["id", "xKey", "xLabel", "yKey", "yLabel", "value"]),
      `chart.heatmap.data[${index}]`,
    );
    const xKey = requireString(datum.xKey, `chart.heatmap.data[${index}].xKey`);
    const yKey = requireString(datum.yKey, `chart.heatmap.data[${index}].yKey`);
    const coordinate = `${xKey}\u0000${yKey}`;
    if (coordinates.has(coordinate)) {
      throw new Error(`chart.heatmap.data[${index}] must have unique xKey/yKey coordinates`);
    }
    coordinates.add(coordinate);
    return {
      id: uniqueId(datum.id, ids, `chart.heatmap.data[${index}].id`),
      xKey,
      xLabel: requireString(datum.xLabel, `chart.heatmap.data[${index}].xLabel`),
      yKey,
      yLabel: requireString(datum.yLabel, `chart.heatmap.data[${index}].yLabel`),
      value: finiteNumber(datum.value, `chart.heatmap.data[${index}].value`),
    };
  });
  return {
    family: "heatmap",
    ...common,
    data,
    xLabel: optionalString(object.xLabel, "chart.heatmap.xLabel"),
    yLabel: optionalString(object.yLabel, "chart.heatmap.yLabel"),
    valueLabel: optionalString(object.valueLabel, "chart.heatmap.valueLabel"),
  };
}

function validateScatter(object: Record<string, unknown>): ScatterChartConfig {
  rejectUnknownKeys(
    object,
    new Set([...COMMON_KEYS, "data", "xLabel", "yLabel", "bubble"]),
    "chart.scatter",
  );
  const common = validateCommon(object);
  if (object.bubble !== undefined && typeof object.bubble !== "boolean") {
    throw new Error("chart.scatter.bubble must be boolean");
  }
  const ids = new Set<string>();
  const data = requireArray(object.data, "chart.scatter.data", (item, index) => {
    const datum = requireObject(item, `chart.scatter.data[${index}]`);
    rejectUnknownKeys(
      datum,
      new Set(["id", "label", "x", "y", "size", "group", "color"]),
      `chart.scatter.data[${index}]`,
    );
    const size = datum.size;
    if (size !== undefined && finiteNumber(size, `chart.scatter.data[${index}].size`) < 0) {
      throw new Error(`chart.scatter.data[${index}].size must not be negative`);
    }
    return {
      id: uniqueId(datum.id, ids, `chart.scatter.data[${index}].id`),
      label: optionalString(datum.label, `chart.scatter.data[${index}].label`),
      x: finiteNumber(datum.x, `chart.scatter.data[${index}].x`),
      y: finiteNumber(datum.y, `chart.scatter.data[${index}].y`),
      size: size === undefined ? undefined : Number(size),
      group: optionalString(datum.group, `chart.scatter.data[${index}].group`),
      color: optionalPalette(datum.color, `chart.scatter.data[${index}].color`),
    };
  });
  return {
    family: "scatter",
    ...common,
    data,
    xLabel: optionalString(object.xLabel, "chart.scatter.xLabel"),
    yLabel: optionalString(object.yLabel, "chart.scatter.yLabel"),
    bubble: object.bubble as boolean | undefined,
  };
}

function validateRangeMarker(object: Record<string, unknown>): RangeMarkerChartConfig {
  rejectUnknownKeys(
    object,
    new Set([
      ...COMMON_KEYS,
      "data",
      "rangeLabel",
      "markerLabel",
      "rangeColor",
      "points",
      "previousLabel",
    ]),
    "chart.range_marker",
  );
  const common = validateCommon(object);
  const ids = new Set<string>();
  const data = requireArray(object.data, "chart.range_marker.data", (item, index) => {
    const datum = requireObject(item, `chart.range_marker.data[${index}]`);
    rejectUnknownKeys(
      datum,
      new Set(["id", "label", "low", "high", "marker"]),
      `chart.range_marker.data[${index}]`,
    );
    const low = finiteNumber(datum.low, `chart.range_marker.data[${index}].low`);
    const high = finiteNumber(datum.high, `chart.range_marker.data[${index}].high`);
    if (low > high) throw new Error(`chart.range_marker.data[${index}] low must not exceed high`);
    return {
      id: uniqueId(datum.id, ids, `chart.range_marker.data[${index}].id`),
      label: requireString(datum.label, `chart.range_marker.data[${index}].label`),
      low,
      high,
      marker: finiteNumber(datum.marker, `chart.range_marker.data[${index}].marker`),
    };
  });
  const pointIds = new Set<string>();
  const points =
    object.points === undefined
      ? undefined
      : requireArray(object.points, "chart.range_marker.points", (item, index) => {
          const path = `chart.range_marker.points[${index}]`;
          const point = requireObject(item, path);
          rejectUnknownKeys(
            point,
            new Set(["id", "rowId", "value", "label", "group", "color", "previous"]),
            path,
          );
          const rowId = requireString(point.rowId, `${path}.rowId`);
          if (!ids.has(rowId)) throw new Error(`${path}.rowId must name a range row`);
          return {
            id: uniqueId(point.id, pointIds, `${path}.id`),
            rowId,
            value: finiteNumber(point.value, `${path}.value`),
            label: optionalString(point.label, `${path}.label`),
            group: requireString(point.group, `${path}.group`),
            color: optionalPalette(point.color, `${path}.color`),
            previous:
              point.previous === undefined
                ? undefined
                : finiteNumber(point.previous, `${path}.previous`),
          };
        });
  return {
    family: "range_marker",
    ...common,
    data,
    rangeLabel: optionalString(object.rangeLabel, "chart.range_marker.rangeLabel"),
    markerLabel: optionalString(object.markerLabel, "chart.range_marker.markerLabel"),
    rangeColor: optionalPalette(object.rangeColor, "chart.range_marker.rangeColor"),
    points,
    previousLabel: optionalString(object.previousLabel, "chart.range_marker.previousLabel"),
  };
}

function validateBreakdown(object: Record<string, unknown>): BreakdownChartConfig {
  rejectUnknownKeys(
    object,
    new Set([...COMMON_KEYS, "data", "orientation", "valueLabel"]),
    "chart.breakdown",
  );
  const common = validateCommon(object);
  const ids = new Set<string>();
  const data = requireArray(object.data, "chart.breakdown.data", (item, index) => {
    const datum = requireObject(item, `chart.breakdown.data[${index}]`);
    rejectUnknownKeys(
      datum,
      new Set(["id", "label", "value", "color"]),
      `chart.breakdown.data[${index}]`,
    );
    const id = uniqueId(datum.id, ids, `chart.breakdown.data[${index}].id`);
    return {
      id,
      label: requireString(datum.label, `chart.breakdown.data[${index}].label`),
      value: finiteNumber(datum.value, `chart.breakdown.data[${index}].value`),
      color: optionalPalette(datum.color, `chart.breakdown.data[${index}].color`),
    };
  });
  const orientation = object.orientation;
  if (orientation !== undefined && orientation !== "horizontal" && orientation !== "vertical") {
    throw new Error("chart.breakdown.orientation must be horizontal or vertical");
  }
  return {
    family: "breakdown",
    ...common,
    data,
    orientation,
    valueLabel: optionalString(object.valueLabel, "chart.breakdown.valueLabel"),
  };
}

function validateTimeline(object: Record<string, unknown>): StackedTimelineChartConfig {
  rejectUnknownKeys(
    object,
    new Set([...COMMON_KEYS, "variant", "series", "data", "valueLabel"]),
    "chart.stacked_timeline",
  );
  const common = validateCommon(object);
  const seriesIds = new Set<string>();
  const series = requireArray(object.series, "chart.stacked_timeline.series", (item, index) => {
    const entry = requireObject(item, `chart.stacked_timeline.series[${index}]`);
    rejectUnknownKeys(
      entry,
      new Set(["id", "label", "color"]),
      `chart.stacked_timeline.series[${index}]`,
    );
    const id = uniqueId(entry.id, seriesIds, `chart.stacked_timeline.series[${index}].id`);
    return {
      id,
      label: requireString(entry.label, `chart.stacked_timeline.series[${index}].label`),
      color: optionalPalette(entry.color, `chart.stacked_timeline.series[${index}].color`),
    };
  });
  const periodIds = new Set<string>();
  const data = requireArray(object.data, "chart.stacked_timeline.data", (item, index) => {
    const datum = requireObject(item, `chart.stacked_timeline.data[${index}]`);
    rejectUnknownKeys(
      datum,
      new Set(["periodKey", "periodLabel", "values"]),
      `chart.stacked_timeline.data[${index}]`,
    );
    const periodKey = uniqueId(
      datum.periodKey,
      periodIds,
      `chart.stacked_timeline.data[${index}].periodKey`,
    );
    const rawValues = requireObject(datum.values, `chart.stacked_timeline.data[${index}].values`);
    const values: Record<string, number | null> = {};
    for (const [seriesId, rawValue] of Object.entries(rawValues)) {
      if (!seriesIds.has(seriesId)) {
        throw new Error(
          `chart.stacked_timeline.data[${index}].values references unknown series: ${seriesId}`,
        );
      }
      values[seriesId] =
        rawValue === null
          ? null
          : finiteNumber(rawValue, `chart.stacked_timeline.data[${index}].values.${seriesId}`);
    }
    return {
      periodKey,
      periodLabel: requireString(
        datum.periodLabel,
        `chart.stacked_timeline.data[${index}].periodLabel`,
      ),
      values,
    };
  });
  const variant = object.variant;
  if (variant !== undefined && variant !== "bar" && variant !== "area" && variant !== "line") {
    throw new Error("chart.stacked_timeline.variant must be bar, area, or line");
  }
  return {
    family: "stacked_timeline",
    ...common,
    variant,
    series,
    data,
    valueLabel: optionalString(object.valueLabel, "chart.stacked_timeline.valueLabel"),
  };
}

function validateWaterfall(object: Record<string, unknown>): WaterfallChartConfig {
  rejectUnknownKeys(object, new Set([...COMMON_KEYS, "data", "valueLabel"]), "chart.waterfall");
  const common = validateCommon(object);
  const ids = new Set<string>();
  const data = requireArray(object.data, "chart.waterfall.data", (item, index) => {
    const datum = requireObject(item, `chart.waterfall.data[${index}]`);
    rejectUnknownKeys(
      datum,
      new Set(["id", "label", "value", "kind"]),
      `chart.waterfall.data[${index}]`,
    );
    const kind = datum.kind;
    if (kind !== "start" && kind !== "change" && kind !== "end") {
      throw new Error(`chart.waterfall.data[${index}].kind must be start, change, or end`);
    }
    return {
      id: uniqueId(datum.id, ids, `chart.waterfall.data[${index}].id`),
      label: requireString(datum.label, `chart.waterfall.data[${index}].label`),
      value: finiteNumber(datum.value, `chart.waterfall.data[${index}].value`),
      kind: kind as "start" | "change" | "end",
    };
  });
  if (data.length > 0) {
    if (data[0]?.kind !== "start")
      throw new Error("chart.waterfall.data must begin with a start point");
    if (data.at(-1)?.kind !== "end")
      throw new Error("chart.waterfall.data must end with an end point");
    if (data.slice(1, -1).some((datum) => datum.kind !== "change")) {
      throw new Error("chart.waterfall.data may contain only change points between start and end");
    }
    const expectedEnd = data.slice(0, -1).reduce((total, datum) => total + datum.value, 0);
    const suppliedEnd = data.at(-1)!.value;
    if (!approximatelyEqual(suppliedEnd, expectedEnd)) {
      throw new Error(
        `chart.waterfall.data end value must equal the start plus changes: expected ${expectedEnd}, received ${suppliedEnd}`,
      );
    }
  }
  return {
    family: "waterfall",
    ...common,
    data,
    valueLabel: optionalString(object.valueLabel, "chart.waterfall.valueLabel"),
  };
}

function validateCommon(object: Record<string, unknown>): ChartCommonConfig {
  const frame = object.frame;
  if (frame !== undefined && frame !== "card" && frame !== "flat") {
    throw new Error("chart.frame must be card or flat");
  }
  const height = object.height;
  if (
    height !== undefined &&
    (!Number.isFinite(height) || Number(height) < 160 || Number(height) > 800)
  ) {
    throw new Error("chart.height must be a finite number from 160 through 800");
  }
  if (object.showLegend !== undefined && typeof object.showLegend !== "boolean") {
    throw new Error("chart.showLegend must be boolean");
  }
  return {
    frame,
    height: height === undefined ? undefined : Number(height),
    valueFormat: validateValueFormat(object.valueFormat),
    showLegend: object.showLegend as boolean | undefined,
    emptyLabel: optionalString(object.emptyLabel, "chart.emptyLabel"),
    controls: validateControls(object.controls),
    segmentAction: validateSegmentAction(object.segmentAction),
  };
}

function validateControls(value: unknown): ChartCommonConfig["controls"] {
  if (value === undefined) return undefined;
  const ids = new Set<string>();
  const controls = requireArray(value, "chart.controls", (item, index) => {
    const control = requireObject(item, `chart.controls[${index}]`);
    const kind = control.kind ?? "choice";
    const allowedKeys =
      kind === "date"
        ? new Set(["id", "label", "value", "kind", "role", "minDate", "maxDate"])
        : new Set(["id", "label", "value", "kind", "role", "display", "options"]);
    rejectUnknownKeys(control, allowedKeys, `chart.controls[${index}]`);
    const id = uniqueId(control.id, ids, `chart.controls[${index}].id`);
    const selected = requireString(control.value, `chart.controls[${index}].value`);
    const label = requireString(control.label, `chart.controls[${index}].label`);
    const role = control.role;
    const roles = new Set([
      "group_by",
      "filter",
      "as_of",
      "granularity",
      "measure",
      "comparison",
      "custom",
    ]);
    if (role !== undefined && (typeof role !== "string" || !roles.has(role))) {
      throw new Error(`chart.controls[${index}].role is unsupported`);
    }
    if (kind === "date") {
      if (role !== "as_of") throw new Error(`chart.controls[${index}].date role must be as_of`);
      for (const field of ["value", "minDate", "maxDate"] as const) {
        const date = control[field];
        if (date !== undefined) validateIsoDate(date, `chart.controls[${index}].${field}`);
      }
      const minDate = control.minDate as string | undefined;
      const maxDate = control.maxDate as string | undefined;
      if (minDate && maxDate && minDate > maxDate) {
        throw new Error(`chart.controls[${index}].minDate must not be after maxDate`);
      }
      if (minDate && selected < minDate) {
        throw new Error(`chart.controls[${index}].value must not be before minDate`);
      }
      if (maxDate && selected > maxDate) {
        throw new Error(`chart.controls[${index}].value must not be after maxDate`);
      }
      return {
        id,
        label,
        value: selected,
        kind: "date" as const,
        role: "as_of" as const,
        minDate: optionalString(control.minDate, `chart.controls[${index}].minDate`),
        maxDate: optionalString(control.maxDate, `chart.controls[${index}].maxDate`),
      };
    }
    if (kind !== "choice") throw new Error(`chart.controls[${index}].kind is unsupported`);
    const optionValues = new Set<string>();
    const options = requireArray(
      control.options,
      `chart.controls[${index}].options`,
      (option, optionIndex) => {
        const entry = requireObject(option, `chart.controls[${index}].options[${optionIndex}]`);
        rejectUnknownKeys(
          entry,
          new Set(["value", "label"]),
          `chart.controls[${index}].options[${optionIndex}]`,
        );
        return {
          value: uniqueId(
            entry.value,
            optionValues,
            `chart.controls[${index}].options[${optionIndex}].value`,
          ),
          label: requireString(
            entry.label,
            `chart.controls[${index}].options[${optionIndex}].label`,
          ),
        };
      },
    );
    if (options.length < 2 || options.length > 12) {
      throw new Error(`chart.controls[${index}].options must contain 2 through 12 options`);
    }
    if (!optionValues.has(selected)) {
      throw new Error(`chart.controls[${index}].value must reference one of its options`);
    }
    const display = control.display;
    if (display !== undefined && display !== "segmented" && display !== "select") {
      throw new Error(`chart.controls[${index}].display must be segmented or select`);
    }
    return {
      id,
      label,
      value: selected,
      kind: control.kind === "choice" ? ("choice" as const) : undefined,
      role: role as
        | "group_by"
        | "filter"
        | "as_of"
        | "granularity"
        | "measure"
        | "comparison"
        | "custom"
        | undefined,
      display: display as "segmented" | "select" | undefined,
      options,
    };
  });
  if (controls.length > 5) throw new Error("chart.controls supports at most 5 controls");
  return controls;
}

function validateIsoDate(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new Error(`${path} must be a valid YYYY-MM-DD date`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month! - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`${path} must be a valid YYYY-MM-DD date`);
  }
}

function approximatelyEqual(left: number, right: number) {
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= Number.EPSILON * scale * 16;
}

function validateSegmentAction(value: unknown): ChartCommonConfig["segmentAction"] {
  if (value === undefined) return undefined;
  const action = requireObject(value, "chart.segmentAction");
  rejectUnknownKeys(action, new Set(["actionId", "label"]), "chart.segmentAction");
  return {
    actionId: requireString(action.actionId, "chart.segmentAction.actionId"),
    label: requireString(action.label, "chart.segmentAction.label"),
  };
}

function validateValueFormat(value: unknown): ChartValueFormat | undefined {
  if (value === undefined) return undefined;
  const format = requireObject(value, "chart.valueFormat");
  const kind = requireString(format.kind, "chart.valueFormat.kind");
  const allowed =
    kind === "currency"
      ? new Set(["kind", "currency", "maximumFractionDigits"])
      : new Set(["kind", "maximumFractionDigits"]);
  rejectUnknownKeys(format, allowed, "chart.valueFormat");
  const digits = format.maximumFractionDigits;
  if (
    digits !== undefined &&
    (!Number.isInteger(digits) || Number(digits) < 0 || Number(digits) > 6)
  ) {
    throw new Error("chart.valueFormat.maximumFractionDigits must be an integer from 0 through 6");
  }
  if (kind === "currency") {
    const currency = requireString(format.currency, "chart.valueFormat.currency");
    if (!/^[A-Z]{3}$/u.test(currency))
      throw new Error("chart.valueFormat.currency must be an uppercase ISO currency code");
    return { kind, currency, maximumFractionDigits: digits as number | undefined };
  }
  if (kind !== "number" && kind !== "percent") {
    throw new Error(`chart.valueFormat.kind is unsupported: ${kind}`);
  }
  return { kind, maximumFractionDigits: digits as number | undefined };
}

function uniqueId(value: unknown, seen: Set<string>, path: string) {
  const id = requireString(value, path);
  if (seen.has(id)) throw new Error(`${path} must be unique`);
  seen.add(id);
  return id;
}

function finiteNumber(value: unknown, path: string) {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${path} must be a finite number`);
  return value;
}

function optionalString(value: unknown, path: string) {
  return value === undefined ? undefined : requireString(value, path);
}

function optionalPalette(value: unknown, path: string): ChartPaletteColor | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !PALETTE.has(value as ChartPaletteColor)) {
    throw new Error(`${path} must be a semantic chart palette color`);
  }
  return value as ChartPaletteColor;
}

function rejectUnknownKeys(object: Record<string, unknown>, allowed: Set<string>, path: string) {
  const unknown = Object.keys(object).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${path}.${unknown} is not supported`);
}

export function validateKpiStripSpec(value: unknown): KpiStripSpec {
  const object = requireObject(value, "kpi_strip.config");
  const layout = object.layout;
  if (layout !== undefined && layout !== "responsive" && layout !== "container") {
    throw new Error("kpi_strip.layout must be responsive or container");
  }
  const labelEmphasis = object.labelEmphasis;
  if (labelEmphasis !== undefined && labelEmphasis !== "primary") {
    throw new Error("kpi_strip.labelEmphasis must be primary");
  }
  const maxColumns = object.maxColumns;
  if (maxColumns !== undefined && maxColumns !== 2 && maxColumns !== 3) {
    throw new Error("kpi_strip.maxColumns must be 2 or 3");
  }
  return {
    ...(layout === undefined ? {} : { layout }),
    ...(labelEmphasis === undefined ? {} : { labelEmphasis }),
    ...(maxColumns === undefined ? {} : { maxColumns }),
    items: requireArray(object.items, "kpi_strip.items", (item, index) => {
      const kpi = requireObject(item, `kpi_strip.items[${index}]`);
      const span = kpi.span;
      if (span !== undefined && span !== "full") {
        throw new Error(`kpi_strip.items[${index}].span must be full`);
      }
      return {
        id: requireString(kpi.id, "kpi.id"),
        label: requireString(kpi.label, "kpi.label"),
        value: requireString(kpi.value, "kpi.value"),
        description: typeof kpi.description === "string" ? kpi.description : undefined,
        ...(span === undefined ? {} : { span }),
        delta: typeof kpi.delta === "string" ? kpi.delta : undefined,
        tone:
          kpi.tone === "success" || kpi.tone === "warning" || kpi.tone === "danger"
            ? kpi.tone
            : "neutral",
      };
    }),
  };
}
