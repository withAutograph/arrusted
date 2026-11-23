import { useMemo } from "react";

import type { Meta, StoryObj } from "@storybook/react-vite";

import { NodeCard } from "./node-card";
import type {
  NodeCardDetailPair,
  NodeCardOccupant,
  NodeCardSlot,
  NodeCardState,
} from "./node-card";
import { OrgChart } from "./org-chart";
import type { ChartRenderDerivedState, ChartRenderNode, OrgChartData } from "./canvas";
import type { OrgChartNode } from "./layout";

type FixtureRow = {
  id: string;
  parentId: string | null;
  name: string;
  title: string;
  level: string;
  contact: string;
  group: "Platform" | "Planning" | "Experience" | "Market" | "Business";
  region: string;
  occupied: boolean;
};

const FIXTURE_ROWS: FixtureRow[] = [
  {
    id: "root",
    parentId: null,
    name: "Sam Park",
    title: "Root Lead",
    level: "E1",
    contact: "sam.park@example.test",
    group: "Business",
    region: "San Francisco, CA",
    occupied: true,
  },
  {
    id: "platform-lead",
    parentId: "root",
    name: "Alice Park",
    title: "Platform Lead",
    level: "L7",
    contact: "alice.park@example.test",
    group: "Platform",
    region: "San Francisco, CA",
    occupied: true,
  },
  {
    id: "planning-lead",
    parentId: "root",
    name: "Bob Tan",
    title: "Planning Lead",
    level: "L6",
    contact: "bob.tan@example.test",
    group: "Planning",
    region: "New York, NY",
    occupied: true,
  },
  {
    id: "experience-lead",
    parentId: "root",
    name: "Carol Singh",
    title: "Experience Lead",
    level: "L6",
    contact: "carol.singh@example.test",
    group: "Experience",
    region: "San Francisco, CA",
    occupied: true,
  },
  {
    id: "platform-builder",
    parentId: "platform-lead",
    name: "Jordan Lee",
    title: "Senior Builder, Backend",
    level: "L5",
    contact: "jordan.lee@example.test",
    group: "Platform",
    region: "Remote (US)",
    occupied: true,
  },
  {
    id: "vacant-builder",
    parentId: "platform-lead",
    name: "",
    title: "Builder, Frontend",
    level: "L4",
    contact: "",
    group: "Platform",
    region: "Remote (US)",
    occupied: false,
  },
  {
    id: "market-lead",
    parentId: "planning-lead",
    name: "Nina Park",
    title: "Market Lead",
    level: "L5",
    contact: "nina.park@example.test",
    group: "Market",
    region: "New York, NY",
    occupied: true,
  },
  {
    id: "experience-specialist",
    parentId: "experience-lead",
    name: "Ravi Khan",
    title: "Senior Experience Specialist",
    level: "L5",
    contact: "ravi.khan@example.test",
    group: "Experience",
    region: "San Francisco, CA",
    occupied: true,
  },
];

const GROUP_ACCENT: Record<FixtureRow["group"], { color: string; label: string }> = {
  Platform: { color: "var(--story-accent-platform)", label: "Platform" },
  Planning: { color: "var(--story-accent-planning)", label: "Planning" },
  Experience: { color: "var(--story-accent-experience)", label: "Experience" },
  Market: { color: "var(--story-accent-market)", label: "Market" },
  Business: { color: "var(--story-accent-business)", label: "Business" },
};

const STORY_PALETTE: React.CSSProperties = {
  ["--story-accent-platform" as string]: "#8192ff",
  ["--story-accent-planning" as string]: "#b78ad6",
  ["--story-accent-experience" as string]: "#e98aa5",
  ["--story-accent-market" as string]: "#eb8526",
  ["--story-accent-business" as string]: "#17b196",
};

const rowsById = new Map(FIXTURE_ROWS.map((row) => [row.id, row]));

function buildData(): OrgChartData {
  const nodes: OrgChartNode[] = FIXTURE_ROWS.map((row) => ({
    id: row.id,
    name: row.name || row.title,
    title: row.title,
    sortKey: row.title,
    subjectId: row.occupied ? `subject-${row.id}` : undefined,
    slotId: `slot-${row.id}`,
    slotLabel: row.title,
    nodeKind: row.occupied ? "subject" : "vacant",
    fieldValues: {
      group: { fieldName: "group", label: "Group", value: row.group },
      region: { fieldName: "region", label: "Region", value: row.region },
    },
  }));
  const links = FIXTURE_ROWS.filter((row) => row.parentId != null).map((row) => ({
    from: row.parentId!,
    to: row.id,
  }));

  return {
    key: "story-org-chart-composition",
    label: null,
    nodes,
    links,
  };
}

function buildSearchText(): Map<string, string> {
  return new Map(
    FIXTURE_ROWS.map((row) => [
      row.id,
      [row.name, row.title, row.group, row.region, row.contact]
        .filter(Boolean)
        .join(" ")
        .toLowerCase(),
    ]),
  );
}

function makeRenderNode() {
  return (node: ChartRenderNode, derived: ChartRenderDerivedState) => {
    const row = rowsById.get(node.id);
    if (!row) return null;

    const state: NodeCardState = derived.isDimmed
      ? "dimmed"
      : derived.isFocused
        ? "focused"
        : "default";

    const slot: NodeCardSlot = {
      title: row.title,
      badge: row.level,
      details: [
        { label: row.group, accent: GROUP_ACCENT[row.group] },
        { label: row.region },
      ] as const satisfies NodeCardDetailPair,
    };

    const occupant: NodeCardOccupant | undefined = row.occupied
      ? {
          primary: row.name,
          details: row.contact
            ? ([{ label: row.contact }] as const satisfies NodeCardDetailPair)
            : undefined,
        }
      : undefined;

    return <NodeCard slot={slot} occupant={occupant} state={state} />;
  };
}

function Harness() {
  const data = useMemo(() => buildData(), []);
  const searchText = useMemo(() => buildSearchText(), []);
  const renderNode = useMemo(() => makeRenderNode(), []);

  return (
    <div
      style={{
        ...STORY_PALETTE,
        height: "100vh",
        width: "100vw",
        background: "var(--color-bg-page)",
        color: "var(--color-text-primary)",
        fontFamily: "var(--font-sans)",
        display: "flex",
      }}
    >
      <OrgChart
        data={data}
        renderNode={renderNode}
        searchText={searchText}
        visibleFields={["group", "region"]}
        asOfDate="2026-05-16"
      />
    </div>
  );
}

const meta = {
  title: "Org Chart / Composition",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <Harness />,
};

export const SearchActive: Story = {
  render: () => <Harness />,
  play: async ({ canvasElement }) => {
    const input = canvasElement.querySelector<HTMLInputElement>(
      "input[data-org-chart-search-input]",
    );
    if (!input) return;
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    nativeSetter?.call(input, "Platform");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  },
};

export const NoMatchSearch: Story = {
  render: () => <Harness />,
  play: async ({ canvasElement }) => {
    const input = canvasElement.querySelector<HTMLInputElement>(
      "input[data-org-chart-search-input]",
    );
    if (!input) return;
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    nativeSetter?.call(input, "Nope");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  },
};
