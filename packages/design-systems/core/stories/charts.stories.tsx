import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import {
  BreakdownChart,
  ChartComposition,
  CombinedBarLineChart,
  DonutChart,
  HeatmapChart,
  RangeMarkerChart,
  ScatterChart,
  StackedTimelineChart,
  WaterfallChart,
} from "../compositions/Charts";

const meta = {
  title: "Design System/Compositions/Charts",
  decorators: [
    (Story) => (
      <div className="min-h-screen bg-[var(--color-bg-page)] p-[var(--space-6)] text-[var(--color-text-primary)]">
        <div className="mx-auto max-w-[1080px]">
          <Story />
        </div>
      </div>
    ),
  ],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const spendByVendor = [
  { id: "northstar", label: "Northstar Cloud", value: 184_200 },
  { id: "redwood", label: "Redwood Systems", value: 126_400 },
  { id: "meridian", label: "Meridian Labs", value: 93_800 },
  { id: "atlas", label: "Atlas Works", value: 61_500 },
];

const timelineSeries = [
  { id: "software", label: "Software", color: "chart-1" as const },
  { id: "services", label: "Services", color: "chart-2" as const },
  { id: "other", label: "Other", color: "chart-3" as const },
];

const timelineData = [
  {
    periodKey: "2026-01",
    periodLabel: "Jan",
    values: { software: 82_000, services: 31_000, other: 9_000 },
  },
  {
    periodKey: "2026-02",
    periodLabel: "Feb",
    values: { software: 87_000, services: 29_000, other: null },
  },
  {
    periodKey: "2026-03",
    periodLabel: "Mar",
    values: { software: 91_000, services: 36_000, other: 11_000 },
  },
  {
    periodKey: "2026-04",
    periodLabel: "Apr",
    values: { software: 96_000, services: 34_000, other: 12_000 },
  },
];

const heatmapRows = [
  { yKey: "software", yLabel: "Software", values: [82_000, 87_000, 91_000, 96_000] },
  { yKey: "services", yLabel: "Services", values: [31_000, 29_000, 36_000, 34_000] },
  { yKey: "other", yLabel: "Other", values: [9_000, 8_000, 11_000, 12_000] },
];

export const Breakdown: Story = {
  render: () => <VendorBreakdownFixture />,
};

function VendorBreakdownFixture() {
  const [period, setPeriod] = useState("current-quarter");
  const [currency, setCurrency] = useState("USD");
  const [lastAction, setLastAction] = useState("Select a bar to inspect its transactions.");
  return (
    <div className="grid gap-[var(--space-3)]">
      <BreakdownChart
        family="breakdown"
        title="Spend by source"
        subtitle="Current reporting period"
        data={spendByVendor}
        valueFormat={{ kind: "currency", currency }}
        controls={[
          {
            id: "period",
            label: "Period",
            value: period,
            display: "segmented",
            options: [
              { value: "current-quarter", label: "This quarter" },
              { value: "prior-quarter", label: "Prior quarter" },
            ],
          },
          {
            id: "currency",
            label: "Currency",
            value: currency,
            options: [
              { value: "USD", label: "USD" },
              { value: "EUR", label: "EUR" },
            ],
          },
        ]}
        segmentAction={{ actionId: "open-transactions", label: "Inspect transactions for" }}
        onControlChange={(id, value) => {
          if (id === "period") setPeriod(value);
          if (id === "currency") setCurrency(value);
        }}
        onSegmentAction={(actionId, segment) =>
          setLastAction(`${actionId}: ${segment.datumId} (${segment.value.toLocaleString()})`)
        }
      />
      <p className="text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
        {lastAction}
      </p>
    </div>
  );
}

export const StackedTimeline: Story = {
  render: () => (
    <StackedTimelineChart
      family="stacked_timeline"
      title="Spend trend"
      subtitle="Missing values remain visible gaps"
      variant="bar"
      series={timelineSeries}
      data={timelineData}
      valueFormat={{ kind: "currency", currency: "USD" }}
    />
  ),
};

export const TimelineVariants: Story = {
  render: () => (
    <div className="grid gap-[var(--space-4)] lg:grid-cols-2">
      <StackedTimelineChart
        family="stacked_timeline"
        title="Stacked area"
        variant="area"
        series={timelineSeries}
        data={timelineData}
        valueFormat={{ kind: "currency", currency: "USD" }}
      />
      <StackedTimelineChart
        family="stacked_timeline"
        title="Independent lines"
        variant="line"
        series={timelineSeries}
        data={timelineData}
        valueFormat={{ kind: "currency", currency: "USD" }}
      />
    </div>
  ),
};

export const Waterfall: Story = {
  render: () => (
    <WaterfallChart
      family="waterfall"
      title="Period-over-period movement"
      data={[
        { id: "opening", label: "Opening", value: 420_000, kind: "start" },
        { id: "new", label: "New spend", value: 58_000, kind: "change" },
        { id: "credits", label: "Credits", value: -21_000, kind: "change" },
        { id: "ending", label: "Ending", value: 457_000, kind: "end" },
      ]}
      valueFormat={{ kind: "currency", currency: "USD" }}
    />
  ),
};

export const Scatter: Story = {
  render: () => (
    <ScatterChart
      family="scatter"
      title="Source spend concentration"
      subtitle="Transaction count versus net spend; bubble size represents open review questions."
      xLabel="Transactions"
      yLabel="Net spend"
      bubble
      data={[
        { id: "northstar", label: "Northstar Cloud", x: 48, y: 184_200, size: 6 },
        { id: "redwood", label: "Redwood Systems", x: 76, y: 126_400, size: 3 },
        { id: "meridian", label: "Meridian Labs", x: 31, y: 93_800, size: 8 },
        { id: "atlas", label: "Atlas Works", x: 19, y: 61_500, size: 2 },
      ]}
      valueFormat={{ kind: "number", maximumFractionDigits: 0 }}
      controls={[
        {
          id: "currency",
          label: "Currency",
          value: "USD",
          options: [
            { value: "USD", label: "USD" },
            { value: "EUR", label: "EUR" },
          ],
        },
      ]}
      segmentAction={{ actionId: "filter-transactions", label: "Filter transactions for" }}
    />
  ),
};

/** Many points per range row, coloured by group, with moved points' previous values hollow. */
export const RangeMarkerWithPoints: Story = {
  render: () => (
    <RangeMarkerChart
      family="range_marker"
      title="Items against their group range"
      subtitle="Each dot is an item; hollow dots show where a moved item was."
      rangeLabel="Group range"
      markerLabel="Group target"
      previousLabel="Before change"
      rangeColor="chart-1"
      valueFormat={{ kind: "currency", currency: "USD" }}
      data={[
        { id: "group-a", label: "Group A", low: 100_000, high: 140_000, marker: 120_000 },
        { id: "group-b", label: "Group B", low: 130_000, high: 180_000, marker: 155_000 },
        { id: "group-c", label: "Group C", low: 170_000, high: 230_000, marker: 200_000 },
      ]}
      points={[
        {
          id: "a1",
          rowId: "group-a",
          value: 96_000,
          group: "Below range",
          color: "chart-3",
          label: "Item Alpha",
        },
        {
          id: "a2",
          rowId: "group-a",
          value: 118_000,
          group: "Within range",
          color: "chart-2",
          label: "Item Beta",
          previous: 104_000,
        },
        {
          id: "a3",
          rowId: "group-a",
          value: 131_000,
          group: "Within range",
          color: "chart-2",
          label: "Item Gamma",
        },
        {
          id: "b1",
          rowId: "group-b",
          value: 126_000,
          group: "Below range",
          color: "chart-3",
          label: "Item Delta",
        },
        {
          id: "b2",
          rowId: "group-b",
          value: 162_000,
          group: "Within range",
          color: "chart-2",
          label: "Item Epsilon",
        },
        {
          id: "b3",
          rowId: "group-b",
          value: 188_000,
          group: "Above range",
          color: "chart-4",
          label: "Item Zeta",
        },
        {
          id: "c1",
          rowId: "group-c",
          value: 205_000,
          group: "Within range",
          color: "chart-2",
          label: "Item Eta",
        },
        {
          id: "c2",
          rowId: "group-c",
          value: 236_000,
          group: "Above range",
          color: "chart-4",
          label: "Item Theta",
          previous: 214_000,
        },
      ]}
    />
  ),
};

export const RangeMarker: Story = {
  render: () => (
    <RangeMarkerChart
      family="range_marker"
      title="Source spend against expected range"
      subtitle="Expected quarterly range with current net spend marker."
      rangeLabel="Expected spend"
      markerLabel="Current spend"
      valueFormat={{ kind: "currency", currency: "USD" }}
      data={[
        { id: "northstar", label: "Northstar Cloud", low: 150_000, high: 210_000, marker: 184_200 },
        { id: "redwood", label: "Redwood Systems", low: 90_000, high: 135_000, marker: 126_400 },
        { id: "meridian", label: "Meridian Labs", low: 65_000, high: 90_000, marker: 93_800 },
        { id: "atlas", label: "Atlas Works", low: 50_000, high: 75_000, marker: 61_500 },
      ]}
      controls={[
        {
          id: "comparison",
          label: "Range basis",
          value: "expected",
          display: "segmented",
          options: [
            { value: "expected", label: "Expected" },
            { value: "prior", label: "Prior period" },
          ],
        },
      ]}
      segmentAction={{ actionId: "open-source", label: "Open source" }}
    />
  ),
};

export const Donut: Story = {
  render: () => (
    <DonutChart
      family="donut"
      title="Spend by category"
      subtitle="Share of approved spend in the current quarter."
      valueLabel="Approved spend"
      valueFormat={{ kind: "currency", currency: "USD" }}
      data={[
        { id: "software", label: "Software", value: 182_000 },
        { id: "services", label: "Services", value: 96_000 },
        { id: "facilities", label: "Facilities", value: 61_000 },
        { id: "other", label: "Other", value: 28_000 },
      ]}
      controls={[
        {
          id: "period",
          label: "Period",
          value: "quarter",
          display: "segmented",
          options: [
            { value: "month", label: "Month" },
            { value: "quarter", label: "Quarter" },
          ],
        },
      ]}
      segmentAction={{ actionId: "filter-category", label: "Filter to" }}
    />
  ),
};

export const CombinedBarLine: Story = {
  render: () => (
    <CombinedBarLineChart
      family="combined_bar_line"
      title="Spend and transaction volume"
      subtitle="Independent measures retain independent formats and axes."
      barLabel="Net spend"
      lineLabel="Transactions"
      barValueFormat={{ kind: "currency", currency: "USD" }}
      lineValueFormat={{ kind: "number", maximumFractionDigits: 0 }}
      data={[
        { id: "jan", label: "Jan", barValue: 122_000, lineValue: 184 },
        { id: "feb", label: "Feb", barValue: 127_000, lineValue: 203 },
        { id: "mar", label: "Mar", barValue: 138_000, lineValue: 196 },
        { id: "apr", label: "Apr", barValue: 142_000, lineValue: 221 },
      ]}
      segmentAction={{ actionId: "open-period", label: "Open period" }}
    />
  ),
};

export const Heatmap: Story = {
  render: () => (
    <HeatmapChart
      family="heatmap"
      title="Category spend by month"
      subtitle="Stable category and period keys remain separate from display labels."
      xLabel="Month"
      yLabel="Category"
      valueLabel="Net spend"
      valueFormat={{ kind: "currency", currency: "USD" }}
      data={heatmapRows.flatMap(({ yKey, yLabel, values }) =>
        values.map((value, index) => {
          const xKey = ["jan", "feb", "mar", "apr"][index]!;
          return {
            id: `${yKey}:${xKey}`,
            xKey,
            xLabel: ["Jan", "Feb", "Mar", "Apr"][index]!,
            yKey,
            yLabel,
            value,
          };
        }),
      )}
      segmentAction={{ actionId: "filter-cell", label: "Filter to" }}
    />
  ),
};

export const AgentSafeComposition: Story = {
  render: () => (
    <ChartComposition
      spec={{
        type: "chart",
        title: "Generated breakdown",
        description:
          "Rendered from the same serializable composition contract available to agents.",
        config: {
          family: "breakdown",
          data: spendByVendor,
          valueFormat: { kind: "currency", currency: "USD" },
        },
      }}
    />
  ),
};

export const EmptyAndLarge: Story = {
  render: () => (
    <div className="grid gap-[var(--space-4)] lg:grid-cols-2">
      <BreakdownChart family="breakdown" title="No matching data" data={[]} />
      <BreakdownChart
        family="breakdown"
        title="Large category set"
        height={420}
        data={Array.from({ length: 18 }, (_, index) => ({
          id: `category-${index}`,
          label: `Category ${index + 1}`,
          value: (18 - index) * 1_250,
        }))}
      />
    </div>
  ),
};
