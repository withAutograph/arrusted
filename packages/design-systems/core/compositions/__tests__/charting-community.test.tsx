// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { expect, it } from "vite-plus/test";

import { bootstrapAgCharts } from "../charting/runtime";
import { HeatmapChart } from "../charting/HeatmapChart";
import { WaterfallChart } from "../charting/WaterfallChart";
import { RangeMarkerChart } from "../charting/RangeMarkerChart";

it("shows Enterprise-only charts as visible tables without a licence", () => {
  bootstrapAgCharts();
  render(
    <>
      <HeatmapChart
        family="heatmap"
        title="Heat"
        data={[{ id: "a", xKey: "mon", xLabel: "Mon", yKey: "bread", yLabel: "Bread", value: 4 }]}
      />
      <WaterfallChart
        family="waterfall"
        title="Bridge"
        data={[{ id: "s", label: "Start", value: 10, kind: "start" }]}
      />
      <RangeMarkerChart
        family="range_marker"
        title="Bands"
        data={[{ id: "r", label: "L1", low: 1, high: 3, marker: 2 }]}
      />
    </>,
  );
  for (const name of ["Heat", "Bridge", "Bands"])
    expect(screen.getByRole("table", { name }).closest(".sr-only")).toBeNull();
});
