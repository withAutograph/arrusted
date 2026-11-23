// The graph unit over the in-memory canvas client, on a plain unit card.
import { useMemo } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import type { CanvasClient } from "../client";
import { GraphUnit, graphUnitTitle } from "../graph-unit";
import { unitSizes } from "@autograph/work-session-tools/layout";
import { createSelectionStore, type CanvasSelection } from "../selection";
import { UnitFrame } from "../unit-frame";
import { useCanvasSession } from "../use-canvas-session";
import { chartGraphMemory, chartGraphSession, personId, specs } from "./fixtures/chart-graph";

function GraphStory({
  client,
  config,
  selection = null,
}: {
  client: CanvasClient;
  config: unknown;
  selection?: CanvasSelection | null;
}) {
  const session = useCanvasSession(client, chartGraphSession);
  const store = useMemo(() => {
    const created = createSelectionStore(client.definition);
    if (selection !== null) created.select(selection);
    return created;
  }, [client, selection]);
  return (
    <div className="h-screen bg-[var(--color-bg-page)] p-[var(--space-6)] font-[var(--font-sans)]">
      <div style={{ width: unitSizes.graph.w, height: unitSizes.graph.h }}>
        <UnitFrame unitId="graph-1" title={graphUnitTitle(client, config)}>
          {session.session !== null ? (
            <GraphUnit
              client={client}
              unitId="graph-1"
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
  title: "Canvas/Graph",
  parameters: { layout: "fullscreen" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/**
 * People by Manager, centred on the person most often named as a manager:
 * their direct reports underneath, on the card's own surface. Click a card to
 * centre on it and select it.
 */
export const OnPlainCard: Story = {
  render: () => <GraphStory client={chartGraphMemory().client} config={specs.managers} />,
};

/** A selected person: centred, with their manager on the left and reports below. */
export const SelectedNode: Story = {
  render: () => (
    <GraphStory
      client={chartGraphMemory().client}
      config={{ ...specs.managers, record_id: personId(4) }}
      selection={{
        kind: "nodes",
        unit_id: "graph-1",
        model_id: "m_person",
        record_ids: [personId(4)],
        field_id: "f_manager",
      }}
    />
  ),
};

/** No people yet. */
export const Empty: Story = {
  render: () => (
    <GraphStory client={chartGraphMemory({ empty: true }).client} config={specs.managers} />
  ),
};
