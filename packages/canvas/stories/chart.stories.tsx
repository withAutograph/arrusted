// The chart unit over the in-memory canvas client, in a unit frame.
import { useMemo } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { ChartUnit, chartUnitTitle } from "../chart-unit";
import { CanvasKernelError, type CanvasClient } from "../client";
import { unitSizes } from "@autograph/work-session-tools/layout";
import { createSelectionStore, type CanvasSelection } from "../selection";
import { UnitFrame } from "../unit-frame";
import { useCanvasSession } from "../use-canvas-session";
import { chartGraphMemory, chartGraphSession, specs } from "./fixtures/chart-graph";

function ChartStory({
  client,
  config,
  selection = null,
  height = unitSizes.chart.h,
}: {
  client: CanvasClient;
  config: unknown;
  selection?: CanvasSelection | null;
  /** The unit's height; the default is a new chart unit's. */
  height?: number;
}) {
  const session = useCanvasSession(client, chartGraphSession);
  const store = useMemo(() => {
    const created = createSelectionStore(client.definition);
    if (selection !== null) created.select(selection);
    return created;
  }, [client, selection]);
  return (
    <div className="min-h-screen bg-[var(--color-bg-page)] p-[var(--space-6)] font-[var(--font-sans)]">
      <div style={{ width: unitSizes.chart.w, height }}>
        <UnitFrame unitId="chart-1" title={chartUnitTitle(client, config)}>
          {session.session !== null ? (
            <ChartUnit
              client={client}
              unitId="chart-1"
              config={config}
              session={session}
              selection={store}
            />
          ) : null}
        </UnitFrame>
      </div>
    </div>
  );
}

const meta = {
  title: "Canvas/Chart",
  parameters: { layout: "fullscreen" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** Count of people by an enum column. */
export const CountByTeam: Story = {
  render: () => <ChartStory client={chartGraphMemory().client} config={specs.countByTeam} />,
};

/** The same count as a donut. */
export const CountByTeamDonut: Story = {
  render: () => <ChartStory client={chartGraphMemory().client} config={specs.countByTeamDonut} />,
};

/**
 * Sum of a money column by team, paid in US dollars and euros: one chart per
 * currency and period, each with its unit on the axis and caption.
 */
export const PayByTeamTwoCurrencies: Story = {
  render: () => (
    <ChartStory client={chartGraphMemory().client} config={specs.payByTeam} height={660} />
  ),
};

/** No records to aggregate. */
export const Empty: Story = {
  render: () => (
    <ChartStory client={chartGraphMemory({ empty: true }).client} config={specs.countByTeam} />
  ),
};

/** One bar selected: it takes the accent colour, and the selection can be cleared. */
export const SelectedBar: Story = {
  render: () => (
    <ChartStory
      client={chartGraphMemory().client}
      config={specs.countByTeam}
      selection={{
        kind: "segment",
        unit_id: "chart-1",
        model_id: "m_person",
        field_id: "f_team",
        value: "design",
      }}
    />
  ),
};

const failing = (): CanvasClient => {
  const { client } = chartGraphMemory();
  return {
    ...client,
    data: {
      ...client.data,
      aggregate: () =>
        Promise.reject(new CanvasKernelError("permission_denied", "You cannot read Base pay.")),
    },
  };
};

/** The kernel refuses the aggregate: its message, and a retry. */
export const ReadError: Story = {
  render: () => <ChartStory client={failing()} config={specs.payByTeam} />,
};

/** A spec whose column is no longer in the table. */
export const MissingColumn: Story = {
  render: () => (
    <ChartStory
      client={chartGraphMemory().client}
      config={{ ...specs.countByTeam, group_by: "f_retired" }}
    />
  ),
};
