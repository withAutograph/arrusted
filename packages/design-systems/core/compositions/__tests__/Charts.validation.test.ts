import { describe, expect, it } from "vite-plus/test";
import { createChartValueFormatter } from "../charting/format";
import { validateChartSpec, validateKpiStripSpec } from "../Charts.validation";
import { compositionRegistry } from "../registry";

describe("range marker points", () => {
  const base = {
    family: "range_marker",
    data: [{ id: "g-a", label: "Group A", low: 1, high: 5, marker: 3 }],
  };
  it("accepts points on named rows with palette colours and previous values", () => {
    expect(
      validateChartSpec({
        ...base,
        rangeColor: "chart-1",
        previousLabel: "Before",
        points: [
          { id: "a", rowId: "g-a", value: 2, group: "Low", color: "chart-3", previous: 4 },
          { id: "b", rowId: "g-a", value: 4.5, group: "Mid", label: "Item Beta" },
        ],
      }),
    ).toMatchObject({
      rangeColor: "chart-1",
      previousLabel: "Before",
      points: [
        { id: "a", rowId: "g-a", value: 2, group: "Low", color: "chart-3", previous: 4 },
        { id: "b", label: "Item Beta" },
      ],
    });
  });

  it("rejects points on unknown rows, repeated ids, bad colours and unknown keys", () => {
    const point = { id: "a", rowId: "g-a", value: 2, group: "Low" };
    expect(() => validateChartSpec({ ...base, points: [{ ...point, rowId: "nope" }] })).toThrow(
      "chart.range_marker.points[0].rowId must name a range row",
    );
    expect(() => validateChartSpec({ ...base, points: [point, point] })).toThrow(/id/u);
    expect(() => validateChartSpec({ ...base, points: [{ ...point, color: "#ff0000" }] })).toThrow(
      /palette/u,
    );
    expect(() => validateChartSpec({ ...base, points: [{ ...point, size: 3 }] })).toThrow(
      "chart.range_marker.points[0].size is not supported",
    );
    expect(() => validateChartSpec({ ...base, rangeColor: "red" })).toThrow(/palette/u);
  });
});

describe("validateChartSpec", () => {
  it("validates opt-in KPI strip layout and decision-label emphasis", () => {
    expect(
      validateKpiStripSpec({
        layout: "container",
        items: [{ id: "current", label: "Current", value: "18" }],
      }),
    ).toMatchObject({ layout: "container" });
    expect(
      validateKpiStripSpec({
        layout: "container",
        labelEmphasis: "primary",
        maxColumns: 2,
        items: [
          {
            id: "current",
            label: "Current",
            value: "18",
            description: "Supplier minimum applies.",
            span: "full",
          },
        ],
      }),
    ).toMatchObject({
      layout: "container",
      labelEmphasis: "primary",
      maxColumns: 2,
      items: [{ description: "Supplier minimum applies.", span: "full" }],
    });
    expect(() => validateKpiStripSpec({ layout: "wide", items: [] })).toThrow(
      "kpi_strip.layout must be responsive or container",
    );
    expect(() => validateKpiStripSpec({ labelEmphasis: "muted", items: [] })).toThrow(
      "kpi_strip.labelEmphasis must be primary",
    );
    expect(() => validateKpiStripSpec({ maxColumns: 4, items: [] })).toThrow(
      "kpi_strip.maxColumns must be 2 or 3",
    );
    expect(() =>
      validateKpiStripSpec({
        items: [{ id: "current", label: "Current", value: "18", span: "half" }],
      }),
    ).toThrow("kpi_strip.items[0].span must be full");
  });

  it("accepts the gated chart families and preserves sparse timeline values", () => {
    expect(
      validateChartSpec({
        family: "breakdown",
        data: [{ id: "a", label: "A", value: 4, color: "chart-1" }],
      }).family,
    ).toBe("breakdown");

    const timeline = validateChartSpec({
      family: "stacked_timeline",
      variant: "area",
      series: [{ id: "open", label: "Open" }],
      data: [{ periodKey: "2026-01", periodLabel: "Jan", values: { open: null } }],
    });
    expect(timeline).toMatchObject({
      family: "stacked_timeline",
      data: [{ values: { open: null } }],
    });

    expect(
      validateChartSpec({
        family: "waterfall",
        data: [
          { id: "start", label: "Start", value: 100, kind: "start" },
          { id: "gain", label: "Gain", value: 20, kind: "change" },
          { id: "end", label: "End", value: 120, kind: "end" },
        ],
      }).family,
    ).toBe("waterfall");

    expect(
      validateChartSpec({
        family: "scatter",
        data: [{ id: "point", x: 10, y: 20, size: 3 }],
        bubble: true,
      }).family,
    ).toBe("scatter");

    expect(
      validateChartSpec({
        family: "range_marker",
        data: [{ id: "range", label: "Range", low: 10, high: 20, marker: 15 }],
      }).family,
    ).toBe("range_marker");

    expect(
      validateChartSpec({
        family: "donut",
        data: [{ id: "software", label: "Software", value: 40 }],
      }).family,
    ).toBe("donut");

    expect(
      validateChartSpec({
        family: "combined_bar_line",
        barLabel: "Spend",
        lineLabel: "Transactions",
        barValueFormat: { kind: "currency", currency: "USD" },
        lineValueFormat: { kind: "number" },
        data: [{ id: "jan", label: "January", barValue: 100, lineValue: 4 }],
      }).family,
    ).toBe("combined_bar_line");

    expect(
      validateChartSpec({
        family: "heatmap",
        data: [
          {
            id: "software:jan",
            xKey: "jan",
            xLabel: "January",
            yKey: "software",
            yLabel: "Software",
            value: 40,
          },
        ],
      }).family,
    ).toBe("heatmap");
  });

  it.each([
    [{ family: "pie", data: [] }, "unsupported"],
    [{ family: "breakdown", data: [{ id: "a", label: "A", value: Number.NaN }] }, "finite"],
    [{ family: "breakdown", data: [{ id: "a", label: "A", value: 1, color: "#fff" }] }, "semantic"],
    [
      { family: "breakdown", data: [{ id: "a", label: "A", value: 1 }], options: {} },
      "not supported",
    ],
    [
      {
        family: "breakdown",
        data: [
          { id: "a", label: "A", value: 1 },
          { id: "a", label: "B", value: 2 },
        ],
      },
      "unique",
    ],
    [
      {
        family: "stacked_timeline",
        series: [{ id: "a", label: "A" }],
        data: [{ periodKey: "1", periodLabel: "One", values: { b: 2 } }],
      },
      "unknown series",
    ],
    [
      { family: "waterfall", data: [{ id: "change", label: "Change", value: 2, kind: "change" }] },
      "begin",
    ],
    [
      {
        family: "waterfall",
        data: [
          { id: "start", label: "Start", value: 100, kind: "start" },
          { id: "gain", label: "Gain", value: 20, kind: "change" },
          { id: "end", label: "End", value: 5, kind: "end" },
        ],
      },
      "expected 120, received 5",
    ],
    [{ family: "breakdown", height: 1200, data: [] }, "160 through 800"],
    [
      { family: "breakdown", data: [], valueFormat: { kind: "currency", currency: "usd" } },
      "ISO currency",
    ],
    [{ family: "scatter", data: [{ id: "point", x: 1, y: 2, size: -1 }] }, "must not be negative"],
    [
      {
        family: "range_marker",
        data: [{ id: "range", label: "Range", low: 20, high: 10, marker: 15 }],
      },
      "must not exceed",
    ],
    [
      {
        family: "breakdown",
        data: [],
        controls: [
          {
            id: "period",
            label: "Period",
            value: "year",
            options: [
              { value: "month", label: "Month" },
              { value: "quarter", label: "Quarter" },
            ],
          },
        ],
      },
      "must reference one of its options",
    ],
    [{ family: "donut", data: [{ id: "a", label: "A", value: -1 }] }, "must not be negative"],
    [
      {
        family: "combined_bar_line",
        barLabel: "Spend",
        lineLabel: "Transactions",
        data: [{ id: "jan", label: "January", barValue: 100, lineValue: Number.NaN }],
      },
      "finite",
    ],
    [
      {
        family: "heatmap",
        data: [
          { id: "a", xKey: "jan", xLabel: "Jan", yKey: "software", yLabel: "Software", value: 1 },
          { id: "b", xKey: "jan", xLabel: "Jan", yKey: "software", yLabel: "Software", value: 2 },
        ],
      },
      "unique xKey/yKey coordinates",
    ],
  ])("rejects unsafe or incoherent specs", (spec, message) => {
    expect(() => validateChartSpec(spec)).toThrow(message);
  });

  it("uses serializable formatting descriptors without changing values", () => {
    const currency = createChartValueFormatter({ kind: "currency", currency: "USD" });
    const percent = createChartValueFormatter({ kind: "percent", maximumFractionDigits: 0 });
    expect(currency(1250)).toMatch(/\$1(?:\.3)?K/u);
    expect(percent(0.125)).toBe("13%");
  });

  it("validates semantic group, filter, and as-of controls", () => {
    const chart = validateChartSpec({
      family: "breakdown",
      data: [],
      controls: [
        {
          id: "group-by",
          label: "Group by",
          role: "group_by",
          value: "department",
          options: [
            { value: "department", label: "Department" },
            { value: "location", label: "Location" },
          ],
        },
        {
          id: "as-of",
          label: "As of",
          kind: "date",
          role: "as_of",
          value: "2026-08-11",
        },
      ],
    });

    expect(chart.controls).toMatchObject([
      { id: "group-by", role: "group_by" },
      { id: "as-of", kind: "date", role: "as_of", value: "2026-08-11" },
    ]);
    expect(() =>
      validateChartSpec({
        family: "breakdown",
        data: [],
        controls: [
          { id: "as-of", label: "As of", kind: "date", role: "as_of", value: "08/11/2026" },
        ],
      }),
    ).toThrow("YYYY-MM-DD");
    expect(() =>
      validateChartSpec({
        family: "breakdown",
        data: [],
        controls: [
          { id: "as-of", label: "As of", kind: "date", role: "as_of", value: "2026-02-30" },
        ],
      }),
    ).toThrow("valid YYYY-MM-DD");
    expect(() =>
      validateChartSpec({
        family: "breakdown",
        data: [],
        controls: [
          {
            id: "as-of",
            label: "As of",
            kind: "date",
            role: "as_of",
            value: "2026-08-11",
            minDate: "2026-09-01",
          },
        ],
      }),
    ).toThrow("must not be before minDate");
  });

  it("renders through the agent registry boundary and retains its size caps", () => {
    const rendered = compositionRegistry.render(
      {
        type: "chart",
        title: "Generated chart",
        config: {
          family: "breakdown",
          data: [{ id: "a", label: "A", value: 1 }],
          controls: [
            {
              id: "period",
              label: "Period",
              value: "month",
              options: [
                { value: "month", label: "Month" },
                { value: "quarter", label: "Quarter" },
              ],
            },
          ],
          segmentAction: { actionId: "open-rows", label: "Open rows for" },
        },
      },
      "agent",
    );
    expect(rendered).toBeTruthy();

    expect(() =>
      compositionRegistry.render(
        {
          type: "chart",
          config: {
            family: "breakdown",
            data: Array.from({ length: 101 }, (_, index) => ({
              id: `item-${index}`,
              label: `Item ${index}`,
              value: index,
            })),
          },
        },
        "agent",
      ),
    ).toThrow("maximum array length");
  });
});
