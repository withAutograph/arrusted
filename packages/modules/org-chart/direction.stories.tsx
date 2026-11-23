// Layout direction stories — one centre and three children, drawn by the
// real canvas so connectors come from the layout's edge builder.
//
//   • LeftToRight: children in one column to the right of the centre.
//   • RightToLeft: the mirror, children to the left.
//   • TopToBottom: the classic org-chart axis with the same nodes.
//
// Cards use the NodeCard label form at a fixed `nodeSize`.

import { useMemo } from "react";

import type { Meta, StoryObj } from "@storybook/react-vite";

import { OrgChartCanvas, type ChartRenderNodeFn, type OrgChartData } from "./canvas";
import type { OrgChartLayoutDirection, OrgChartNode } from "./layout";
import { NodeCard, type NodeCardLabel } from "./node-card";

const NODE_SIZE = { width: 208, height: 56 };

const LABELS: Record<string, NodeCardLabel> = {
  centre: { primary: "Jane Doe" },
  c1: { primary: "Engineering", caption: "Department" },
  c2: { primary: "San Francisco", caption: "Work Location" },
  c3: { primary: "Software Engineering", caption: "Job Family" },
};

function node(id: string, sortKey: string): OrgChartNode {
  return {
    id,
    sortKey,
    name: LABELS[id]!.primary,
    nodeKind: "subject",
    fieldValues: {},
    // The tinted centre is the current card, not a link.
    ...(id === "centre" ? { interactive: false } : {}),
  };
}

const DATA: OrgChartData = {
  key: "direction-star",
  label: null,
  nodes: [node("centre", "0"), node("c1", "1"), node("c2", "2"), node("c3", "3")],
  links: [
    { from: "centre", to: "c1" },
    { from: "centre", to: "c2" },
    { from: "centre", to: "c3" },
  ],
};

const renderNode: ChartRenderNodeFn = (layoutNode) => (
  <NodeCard
    label={LABELS[layoutNode.id]!}
    state={layoutNode.id === "centre" ? "current" : "default"}
  />
);

function DirectionHarness({ direction }: { direction: OrgChartLayoutDirection }) {
  const emptyFields = useMemo(() => [], []);
  return (
    <div
      style={{
        width: 800,
        height: 440,
        display: "flex",
        border: "1px solid var(--color-border-subtle)",
        fontFamily: "var(--font-sans)",
      }}
    >
      <OrgChartCanvas
        data={DATA}
        direction={direction}
        nodeSize={NODE_SIZE}
        renderNode={renderNode}
        visibleFields={emptyFields}
        asOfDate=""
        filterActive={false}
        showSlots={false}
        onNodeActivate={() => {}}
      />
    </div>
  );
}

const meta = {
  title: "Org Chart / Direction",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const LeftToRight: Story = {
  render: () => <DirectionHarness direction="left-to-right" />,
};

export const RightToLeft: Story = {
  render: () => <DirectionHarness direction="right-to-left" />,
};

export const TopToBottom: Story = {
  render: () => <DirectionHarness direction="top-to-bottom" />,
};
