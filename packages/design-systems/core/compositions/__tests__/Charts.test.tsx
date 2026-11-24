// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const shown = vi.hoisted(() => ({ listeners: undefined as Record<string, Function> | undefined }));
vi.mock("../charting/runtime", () => ({
  agChartsEnterpriseEnabled: () => true,
  AgChartsHost: (props: {
    label: string;
    options: {
      data?: unknown;
      series?: Array<Record<string, unknown>>;
      legend?: unknown;
      listeners?: Record<string, Function>;
    };
  }) => (
    (shown.listeners = props.options.listeners),
    (
      <div
        data-testid="chart-host"
        data-chart-options={JSON.stringify({
          data: props.options.data,
          series: props.options.series,
          legend: props.options.legend,
        })}
      >
        {props.label}
      </div>
    )
  ),
}));
vi.mock("../charting/theme", () => ({
  useResolvedChartTheme: () => ({
    palette: {
      "chart-1": "blue",
      "chart-2": "green",
      "chart-3": "yellow",
      "chart-4": "red",
    },
    axisText: "black",
    gridLine: "gray",
    fontFamily: "sans-serif",
    fontSize: 12,
    cornerRadius: 4,
  }),
  chartColor: (theme: { palette: Record<string, string> }, color = "chart-1") =>
    theme.palette[color],
  chartAxis: () => ({ label: { fontSize: 12 }, gridLine: {} }),
}));

import { BreakdownChart } from "../charting/BreakdownChart";
import { CombinedBarLineChart } from "../charting/CombinedBarLineChart";
import { DonutChart } from "../charting/DonutChart";
import { HeatmapChart } from "../charting/HeatmapChart";
import { RangeMarkerChart } from "../charting/RangeMarkerChart";
import { StackedTimelineChart } from "../charting/StackedTimelineChart";
import { WaterfallChart } from "../charting/WaterfallChart";
import { KpiStripComposition } from "../Charts";

afterEach(cleanup);

describe("chart compositions", () => {
  it("keeps the KPI strip viewport-responsive by default and supports container columns", () => {
    const spec = {
      type: "kpi_strip" as const,
      config: {
        items: [
          { id: "current", label: "Current", value: "18" },
          { id: "addition", label: "Addition", value: "96" },
          { id: "projected", label: "Projected", value: "114" },
        ],
      },
    };
    const { container, rerender } = render(<KpiStripComposition spec={spec} />);
    expect(container.firstElementChild).toHaveClass("sm:grid-cols-2", "lg:grid-cols-4");
    expect(container.firstElementChild).not.toHaveClass("@container/kpi-strip");

    rerender(
      <KpiStripComposition spec={{ ...spec, config: { ...spec.config, layout: "container" } }} />,
    );
    expect(container.firstElementChild).toHaveClass("@container/kpi-strip");
    expect(container.firstElementChild?.firstElementChild).toHaveClass(
      "grid-cols-1",
      "@sm/kpi-strip:grid-cols-2",
      "@lg/kpi-strip:grid-cols-3",
    );

    rerender(
      <KpiStripComposition
        spec={{
          ...spec,
          config: { ...spec.config, layout: "container", maxColumns: 2 },
        }}
      />,
    );
    expect(container.firstElementChild?.firstElementChild).toHaveClass(
      "grid-cols-1",
      "@sm/kpi-strip:grid-cols-2",
    );
    expect(container.firstElementChild?.firstElementChild).not.toHaveClass(
      "@lg/kpi-strip:grid-cols-3",
    );

    rerender(
      <KpiStripComposition
        spec={{
          ...spec,
          config: {
            ...spec.config,
            layout: "container",
            maxColumns: 2,
            items: [
              ...spec.config.items.slice(0, 2),
              { id: "projected", label: "Projected", value: "114", span: "full" },
            ],
          },
        }}
      />,
    );
    expect(screen.getByText("Projected").parentElement).toHaveClass("col-span-full");
  });

  it("keeps muted caption labels by default and supports primary decision labels", () => {
    const spec = {
      type: "kpi_strip" as const,
      config: { items: [{ id: "projected", label: "Projected on-hand", value: "114" }] },
    };
    const { rerender } = render(<KpiStripComposition spec={spec} />);
    expect(screen.getByText("Projected on-hand")).toHaveClass(
      "text-[length:var(--text-caption)]",
      "text-[var(--color-text-muted)]",
    );

    rerender(
      <KpiStripComposition
        spec={{ ...spec, config: { ...spec.config, labelEmphasis: "primary" } }}
      />,
    );
    expect(screen.getByText("Projected on-hand")).toHaveClass(
      "text-[length:var(--text-body)]",
      "font-[var(--font-weight-semibold)]",
      "text-[var(--color-text-primary)]",
    );
  });

  it("renders optional KPI descriptions below values without adding a default", () => {
    const spec = {
      type: "kpi_strip" as const,
      config: {
        items: [
          {
            id: "addition",
            label: "Addition",
            value: "96 units",
            description: "24 cases × 4 units · supplier minimum",
          },
          { id: "projected", label: "Projected", value: "114 units" },
        ],
      },
    };
    render(<KpiStripComposition spec={spec} />);

    expect(screen.getByText("24 cases × 4 units · supplier minimum")).toHaveClass(
      "text-[length:var(--text-body)]",
      "text-[var(--color-text-primary)]",
    );
    expect(screen.getByText("96 units").nextElementSibling).toHaveTextContent(
      "24 cases × 4 units · supplier minimum",
    );
    expect(screen.getByText("114 units").nextElementSibling).toBeNull();
  });

  it("renders a breakdown with an accessible summary and stable click payload", () => {
    const onSegmentClick = vi.fn();
    const onControlChange = vi.fn();
    const onSegmentAction = vi.fn();
    render(
      <BreakdownChart
        family="breakdown"
        title="Spend by vendor"
        data={[{ id: "vendor-1", label: "Northstar", value: 1250 }]}
        valueFormat={{ kind: "currency", currency: "USD" }}
        onSegmentClick={onSegmentClick}
        onSegmentAction={onSegmentAction}
        segmentAction={{ actionId: "open-transactions", label: "Open transactions for" }}
        controls={[
          {
            id: "period",
            label: "Period",
            value: "month",
            display: "segmented",
            options: [
              { value: "month", label: "Month" },
              { value: "quarter", label: "Quarter" },
            ],
          },
        ]}
        onControlChange={onControlChange}
      />,
    );

    expect(screen.getByTestId("chart-host")).toHaveTextContent("Spend by vendor");
    const options = JSON.parse(screen.getByTestId("chart-host").dataset.chartOptions!);
    expect(options.series[0]).toMatchObject({ type: "bar", cornerRadius: 4 });
    expect(screen.getByRole("table", { name: "Spend by vendor" })).toHaveTextContent("Northstar");
    fireEvent.click(screen.getByRole("radio", { name: "Quarter" }));
    expect(onControlChange).toHaveBeenCalledWith("period", "quarter");
    fireEvent.click(screen.getByRole("button", { name: "Open transactions for Northstar" }));
    expect(onSegmentClick).toHaveBeenCalledWith({
      family: "breakdown",
      datumId: "vendor-1",
      value: 1250,
    });
    expect(onSegmentAction).toHaveBeenCalledWith("open-transactions", {
      family: "breakdown",
      datumId: "vendor-1",
      value: 1250,
    });
  });

  it("renders a design-system as-of control", () => {
    render(
      <BreakdownChart
        family="breakdown"
        data={[{ id: "vendor", label: "Vendor", value: 1 }]}
        controls={[
          {
            id: "as-of",
            label: "As of",
            kind: "date",
            role: "as_of",
            value: "2026-08-11",
          },
        ]}
        onControlChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /As of: Aug 11, 2026/u })).toBeInTheDocument();
  });

  it("keeps missing timeline values distinct from zero in the summary", () => {
    const onSegmentClick = vi.fn();
    render(
      <StackedTimelineChart
        family="stacked_timeline"
        series={[{ id: "open", label: "Open" }]}
        data={[
          { periodKey: "jan", periodLabel: "January", values: { open: null } },
          { periodKey: "feb", periodLabel: "February", values: { open: 0 } },
        ]}
        onSegmentClick={onSegmentClick}
      />,
    );

    const table = screen.getByRole("table", { name: "Timeline chart data" });
    expect(table).toHaveTextContent("JanuaryNo value");
    expect(table).toHaveTextContent("February0");
    expect(screen.queryByRole("button", { name: "Inspect Open for January" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Inspect Open for February" }));
    expect(onSegmentClick).toHaveBeenCalledWith({
      family: "stacked_timeline",
      datumId: "feb",
      periodKey: "feb",
      seriesId: "open",
      value: 0,
    });
  });

  it("tapers missing stacked-area values to zero without changing summary semantics", () => {
    render(
      <StackedTimelineChart
        family="stacked_timeline"
        variant="area"
        series={[{ id: "other", label: "Other" }]}
        data={[
          { periodKey: "jan", periodLabel: "January", values: { other: 9 } },
          { periodKey: "feb", periodLabel: "February", values: { other: null } },
          { periodKey: "mar", periodLabel: "March", values: { other: 11 } },
        ]}
      />,
    );

    const options = JSON.parse(screen.getByTestId("chart-host").dataset.chartOptions!);
    expect(options.data[1].other).toBe(0);
    expect(screen.getByRole("table", { name: "Timeline chart data" })).toHaveTextContent(
      "FebruaryNo value",
    );
  });

  it("uses the design-system radius for waterfall bars and draws connectors behind them", () => {
    render(
      <WaterfallChart
        family="waterfall"
        data={[
          { id: "opening", label: "Opening", value: 100, kind: "start" },
          { id: "growth", label: "Growth", value: 20, kind: "change" },
          { id: "ending", label: "Ending", value: 120, kind: "end" },
        ]}
      />,
    );

    const options = JSON.parse(screen.getByTestId("chart-host").dataset.chartOptions!);
    expect(options.series[0]).toMatchObject({
      type: "line",
      yKey: "connector",
      interpolation: { type: "step", position: "end" },
    });
    expect(options.series[1]).toMatchObject({ type: "range-bar", cornerRadius: 4 });
    expect(options.data.map((datum: { connector: number }) => datum.connector)).toEqual([
      100, 120, 120,
    ]);
  });

  it("renders a stable empty state without mounting the vendor chart", () => {
    render(<WaterfallChart family="waterfall" data={[]} emptyLabel="Nothing changed" />);
    expect(screen.getByText("Nothing changed")).toBeInTheDocument();
    expect(screen.queryByTestId("chart-host")).not.toBeInTheDocument();
  });

  it("renders donut data and emits its opaque action payload", () => {
    const onSegmentAction = vi.fn();
    render(
      <DonutChart
        family="donut"
        title="Spend mix"
        data={[{ id: "software", label: "Software", value: 1250 }]}
        segmentAction={{ actionId: "filter-category", label: "Filter to" }}
        onSegmentAction={onSegmentAction}
      />,
    );
    const options = JSON.parse(screen.getByTestId("chart-host").dataset.chartOptions!);
    expect(options.series[0]).toMatchObject({ type: "donut", cornerRadius: 4 });
    fireEvent.click(screen.getByRole("button", { name: "Filter to Software" }));
    expect(onSegmentAction).toHaveBeenCalledWith("filter-category", {
      family: "donut",
      datumId: "software",
      value: 1250,
    });
  });

  it("uses the design-system radius across remaining rectangular series", () => {
    const { unmount } = render(
      <StackedTimelineChart
        family="stacked_timeline"
        series={[{ id: "open", label: "Open" }]}
        data={[{ periodKey: "jan", periodLabel: "January", values: { open: 3 } }]}
      />,
    );
    expect(
      JSON.parse(screen.getByTestId("chart-host").dataset.chartOptions!).series[0],
    ).toMatchObject({ type: "bar", cornerRadius: 4 });
    unmount();

    const range = render(
      <RangeMarkerChart
        family="range_marker"
        data={[{ id: "team", label: "Team", low: 1, high: 5, marker: 3 }]}
      />,
    );
    expect(
      JSON.parse(screen.getByTestId("chart-host").dataset.chartOptions!).series[0],
    ).toMatchObject({ type: "range-bar", cornerRadius: 4 });
    range.unmount();

    render(
      <CombinedBarLineChart
        family="combined_bar_line"
        barLabel="Spend"
        lineLabel="Count"
        data={[{ id: "jan", label: "January", barValue: 10, lineValue: 2 }]}
      />,
    );
    expect(
      JSON.parse(screen.getByTestId("chart-host").dataset.chartOptions!).series[0],
    ).toMatchObject({ type: "bar", cornerRadius: 4 });
  });

  it("plots many points per range row by group, with hollow previous values", () => {
    const onSegmentClick = vi.fn();
    render(
      <RangeMarkerChart
        family="range_marker"
        title="Spread"
        rangeColor="chart-1"
        markerLabel="Target"
        previousLabel="Before"
        data={[
          { id: "g-a", label: "Group A", low: 10, high: 20, marker: 15 },
          { id: "g-b", label: "Group B", low: 20, high: 40, marker: 30 },
        ]}
        points={[
          { id: "p1", rowId: "g-a", value: 8, group: "Low", color: "chart-3", label: "Item Alpha" },
          { id: "p2", rowId: "g-a", value: 16, group: "Mid", color: "chart-2", previous: 12 },
          { id: "p3", rowId: "g-b", value: 25, group: "Mid", color: "chart-2" },
          { id: "p4", rowId: "missing", value: 1, group: "Low" },
        ]}
        onSegmentClick={onSegmentClick}
      />,
    );
    const options = JSON.parse(screen.getByTestId("chart-host").dataset.chartOptions!);
    const [range, marker, low, mid, previous, extra] = options.series;
    // Room for a second legend row, so a unit-width chart wraps its entries instead of paging them.
    expect(options.legend).toMatchObject({ enabled: true, position: "bottom" });
    expect(options.legend.maxHeight).toBeGreaterThanOrEqual(48);
    expect(range).toMatchObject({ type: "range-bar", fill: "blue", fillOpacity: 0.28 });
    expect(marker).toMatchObject({ type: "scatter", xKey: "marker", title: "Target" });
    // One series per group on the point's row label; a point on no row is left out.
    expect(low).toMatchObject({ type: "scatter", xName: "Low", fill: "yellow", yKey: "row" });
    expect(low.data).toEqual([expect.objectContaining({ id: "p1", row: "Group A" })]);
    expect(mid).toMatchObject({ xName: "Mid", fill: "green" });
    expect(mid.data.map((point: { id: string }) => point.id)).toEqual(["p2", "p3"]);
    // Only moved points get a hollow previous marker.
    expect(previous).toMatchObject({ xKey: "previous", xName: "Before", fillOpacity: 0 });
    expect(previous.data.map((point: { id: string }) => point.id)).toEqual(["p2"]);
    expect(extra).toBeUndefined();
    // Clicking a hollow marker emits the previous value it marks.
    shown.listeners!.seriesNodeClick!({ datum: previous.data[0], seriesId: previous.id });
    expect(onSegmentClick).toHaveBeenLastCalledWith({
      family: "range_marker",
      datumId: "p2",
      seriesId: "points",
      value: 12,
    });

    const table = screen.getByRole("table", { name: "Spread points" });
    expect(table).toHaveTextContent("Item AlphaGroup A8Low");
    fireEvent.click(screen.getByRole("button", { name: "Inspect Item Alpha" }));
    expect(onSegmentClick).toHaveBeenCalledWith({
      family: "range_marker",
      datumId: "p1",
      seriesId: "points",
      value: 8,
    });
  });

  it("gives a point group named like the previous-value series its own series id", () => {
    render(
      <RangeMarkerChart
        family="range_marker"
        data={[{ id: "g-a", label: "Group A", low: 10, high: 20, marker: 15 }]}
        points={[{ id: "p1", rowId: "g-a", value: 16, group: "previous", previous: 12 }]}
      />,
    );
    const ids = JSON.parse(screen.getByTestId("chart-host").dataset.chartOptions!)
      .series.slice(2)
      .map((item: { id: string }) => item.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("keeps a range marker chart without points unchanged", () => {
    render(
      <RangeMarkerChart
        family="range_marker"
        data={[{ id: "team", label: "Team", low: 1, high: 5, marker: 3 }]}
      />,
    );
    const options = JSON.parse(screen.getByTestId("chart-host").dataset.chartOptions!);
    expect(options.series).toHaveLength(2);
    expect(options.legend).toEqual({ enabled: false });
    expect(options.series[0]).toMatchObject({ fill: "yellow" });
    expect(options.series[0]).not.toHaveProperty("fillOpacity");
    expect(options.series[1]).not.toHaveProperty("title");
    expect(screen.queryByRole("table", { name: /points$/u })).toBeNull();
  });

  it("formats combined measures independently and exposes both series actions", () => {
    const onSegmentClick = vi.fn();
    render(
      <CombinedBarLineChart
        family="combined_bar_line"
        barLabel="Spend"
        lineLabel="Transactions"
        barValueFormat={{ kind: "currency", currency: "USD" }}
        lineValueFormat={{ kind: "number" }}
        data={[{ id: "jan", label: "January", barValue: 1250, lineValue: 4 }]}
        onSegmentClick={onSegmentClick}
      />,
    );
    const table = screen.getByRole("table", { name: "Combined bar and line chart data" });
    expect(table).toHaveTextContent("January$1.3K4");
    fireEvent.click(screen.getByRole("button", { name: "Inspect Transactions for January" }));
    expect(onSegmentClick).toHaveBeenCalledWith({
      family: "combined_bar_line",
      datumId: "jan",
      seriesId: "line",
      value: 4,
    });
  });

  it("keeps heatmap coordinate identities in its accessible summary", () => {
    render(
      <HeatmapChart
        family="heatmap"
        xLabel="Month"
        yLabel="Category"
        valueLabel="Spend"
        data={[
          {
            id: "software:jan",
            xKey: "jan",
            xLabel: "January",
            yKey: "software",
            yLabel: "Software",
            value: 1250,
          },
        ]}
      />,
    );
    expect(screen.getByRole("table", { name: "Heatmap chart data" })).toHaveTextContent(
      "SoftwareJanuary1.3K",
    );
  });
});
