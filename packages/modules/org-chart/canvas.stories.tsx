// OrgChartCanvas stories — visual verification of the ported canvas.
//
// Four states the PR's spec requires:
//   1. Default — chart visible, no focus, no search
//   2. Expanded — bulk expand triggers extra layers / connectors
//   3. Focused — clicking a card highlights its subtree
//   4. SearchDim — matched cards stay default; others dim
//
// The story-local `renderNode` maps the layout's view-model shape onto
// `NodeCard`'s {slot, occupant, state} props. Apps will write a similar
// adapter for their domain shape.

import { useEffect, useMemo, useRef, useState } from "react";

import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  OrgChartCanvas,
  type ChartInstanceHandle,
  type ChartRenderDerivedState,
  type ChartRenderNode,
  type OrgChartData,
} from "./canvas";
import { NodeCard } from "./node-card";
import type {
  NodeCardDetailPair,
  NodeCardOccupant,
  NodeCardSlot,
  NodeCardState,
} from "./node-card";
import type { OrgChartNode } from "./layout";

// ---------------------------------------------------------------------------
// Mock data: a 3-layer org with two top-level branches, two mid nodes under
// each, and one leaf under one of the managers (so the layout has variety
// in subtree widths).
// ---------------------------------------------------------------------------

type FixtureRow = {
  id: string;
  parentId: string | null;
  name: string;
  title: string;
  level: string;
  contact: string;
  group: "Platform" | "Planning" | "Experience" | "Market" | "Business";
  region: string;
  occupant: boolean;
};

const FIXTURE_ROWS: FixtureRow[] = [
  {
    id: "ceo",
    parentId: null,
    name: "Sam Park",
    title: "Root Lead",
    level: "E1",
    contact: "sam.park@example.test",
    group: "Business",
    region: "San Francisco, CA",
    occupant: true,
  },
  {
    id: "vp-eng",
    parentId: "ceo",
    name: "Alice Park",
    title: "Platform Lead",
    level: "L7",
    contact: "alice.park@example.test",
    group: "Platform",
    region: "San Francisco, CA",
    occupant: true,
  },
  {
    id: "vp-prod",
    parentId: "ceo",
    name: "Bob Tan",
    title: "Director of Planning",
    level: "L6",
    contact: "bob.tan@example.test",
    group: "Planning",
    region: "New York, NY",
    occupant: true,
  },
  {
    id: "vp-design",
    parentId: "ceo",
    name: "Carol Singh",
    title: "Head of Experience",
    level: "L6",
    contact: "carol.singh@example.test",
    group: "Experience",
    region: "San Francisco, CA",
    occupant: true,
  },
  {
    id: "em-mobile",
    parentId: "vp-eng",
    name: "Marcus Hill",
    title: "Platform Manager, Mobile",
    level: "L6",
    contact: "marcus.hill@example.test",
    group: "Platform",
    region: "San Francisco, CA",
    occupant: true,
  },
  {
    id: "em-backend",
    parentId: "vp-eng",
    name: "Jordan Lee",
    title: "Senior Builder, Backend",
    level: "L5",
    contact: "jordan.lee@example.test",
    group: "Platform",
    region: "San Francisco, CA",
    occupant: true,
  },
  {
    id: "em-frontend",
    parentId: "vp-eng",
    name: "",
    title: "SW Builder, Frontend",
    level: "L4",
    contact: "",
    group: "Platform",
    region: "Remote (US)",
    occupant: false,
  },
  {
    id: "pm-growth",
    parentId: "vp-prod",
    name: "Pat Morgan",
    title: "PM, Growth",
    level: "L5",
    contact: "pat.morgan@example.test",
    group: "Planning",
    region: "New York, NY",
    occupant: true,
  },
  {
    id: "pm-platform",
    parentId: "vp-prod",
    name: "Jamie Wu",
    title: "PM, Platform",
    level: "L5",
    contact: "jamie.wu@example.test",
    group: "Planning",
    region: "Remote (US)",
    occupant: true,
  },
  {
    id: "designer-1",
    parentId: "vp-design",
    name: "Riley Cohen",
    title: "Senior Experience Specialist",
    level: "L5",
    contact: "riley.cohen@example.test",
    group: "Experience",
    region: "San Francisco, CA",
    occupant: true,
  },
  {
    id: "ic-mobile-1",
    parentId: "em-mobile",
    name: "Eve Nakamura",
    title: "Senior Builder, Mobile",
    level: "L5",
    contact: "eve.nakamura@example.test",
    group: "Platform",
    region: "San Francisco, CA",
    occupant: true,
  },
  {
    id: "ic-mobile-2",
    parentId: "em-mobile",
    name: "Dan Alvarez",
    title: "Builder, Mobile",
    level: "L4",
    contact: "dan.alvarez@example.test",
    group: "Platform",
    region: "Chicago, IL",
    occupant: true,
  },
];

const GROUP_ACCENT: Record<FixtureRow["group"], { color: string; label: string }> = {
  Platform: {
    color: "var(--story-accent-eng)",
    label: "Platform",
  },
  Planning: { color: "var(--story-accent-prod)", label: "Planning" },
  Experience: { color: "var(--story-accent-design)", label: "Experience" },
  Market: { color: "var(--story-accent-sales)", label: "Market" },
  Business: { color: "var(--story-accent-ops)", label: "Business" },
};

function buildChartData(filter: string = ""): OrgChartData {
  const normalized = filter.trim().toLowerCase();
  const nodes: OrgChartNode[] = FIXTURE_ROWS.map((p) => ({
    id: p.id,
    name: p.name || p.title,
    title: p.title,
    nodeKind: p.occupant ? "subject" : "vacant",
    fieldValues: {},
    matchesFilter:
      normalized.length === 0
        ? true
        : [p.name, p.title, p.group, p.region, p.contact]
            .filter(Boolean)
            .some((v) => v.toLowerCase().includes(normalized)),
  }));
  const links = FIXTURE_ROWS.filter((p) => p.parentId != null).map((p) => ({
    from: p.parentId!,
    to: p.id,
  }));
  return {
    key: "story-chart",
    label: null,
    nodes,
    links,
  };
}

// Story-local accent palette (mirrors NodeCard stories).
const STORY_PALETTE: React.CSSProperties = {
  ["--story-accent-eng" as string]: "#8192ff",
  ["--story-accent-prod" as string]: "#b78ad6",
  ["--story-accent-design" as string]: "#e98aa5",
  ["--story-accent-sales" as string]: "#eb8526",
  ["--story-accent-ops" as string]: "#17b196",
};

// ---------------------------------------------------------------------------
// renderNode adapter — maps FixtureRow data onto NodeCard props.
//
// Apps will write a similar adapter that closes over their own atom shape;
// this story-local one is what proves the renderNode contract works.
// ---------------------------------------------------------------------------

function makeRenderNode(rowsById: Map<string, FixtureRow>) {
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
        {
          label: row.group,
          accent: GROUP_ACCENT[row.group],
        },
        { label: row.region },
      ] as const satisfies NodeCardDetailPair,
    };

    const occupant: NodeCardOccupant | undefined = row.occupant
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

const rowsById = new Map(FIXTURE_ROWS.map((p) => [p.id, p]));

// ---------------------------------------------------------------------------
// Story harness — gives every story a sized canvas viewport, the renderNode
// adapter, and a no-op activate handler unless overridden.
// ---------------------------------------------------------------------------

type HarnessProps = {
  data: OrgChartData;
  filterActive?: boolean;
  focusedNodeIds?: Set<string>;
  focusNodeIds?: string[];
  onActivate?: (nodeId: string) => void;
  bulkAction?: "expand-all" | null;
};

function CanvasHarness(props: HarnessProps) {
  const handleRef = useRef<ChartInstanceHandle | null>(null);
  const renderNode = useMemo(() => makeRenderNode(rowsById), []);

  useEffect(() => {
    if (props.bulkAction === "expand-all") {
      // Defer until the canvas has done its initial fit so the
      // expand-fit animation reads clearly in screenshots.
      const id = window.setTimeout(() => {
        handleRef.current?.expandAll();
      }, 320);
      return () => window.clearTimeout(id);
    }
    return;
  }, [props.bulkAction]);

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
      <OrgChartCanvas
        ref={handleRef}
        data={props.data}
        renderNode={renderNode}
        visibleFields={["title", "group"]}
        asOfDate="2025-01-01"
        filterActive={Boolean(props.filterActive)}
        showSlots={false}
        focusedNodeIds={props.focusedNodeIds}
        focusNodeIds={props.focusNodeIds}
        onNodeActivate={(payload) => props.onActivate?.(payload.nodeId)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Story-only wrapper for the Focused story — needs local state to track
// which subtree the click highlights.
// ---------------------------------------------------------------------------

function FocusedHarness() {
  const data = useMemo(() => buildChartData(), []);
  const childrenByParent = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const link of data.links) {
      const list = out.get(link.from) ?? [];
      list.push(link.to);
      out.set(link.from, list);
    }
    return out;
  }, [data.links]);

  // Compute the Platform subtree (used for the highlight set + the
  // focusNodeIds expand hint so the screenshot shows the affordance on a
  // multi-level subtree without requiring an interaction).
  const SEED = "vp-eng";
  const initialSubtree = useMemo(() => {
    const set = new Set<string>();
    const stack = [SEED];
    while (stack.length > 0) {
      const id = stack.pop()!;
      set.add(id);
      for (const child of childrenByParent.get(id) ?? []) {
        stack.push(child);
      }
    }
    return set;
  }, [childrenByParent]);

  const [activeFocus, setActiveFocus] = useState<Set<string>>(initialSubtree);
  const [focusNodeIds, setFocusNodeIds] = useState<string[] | undefined>(() => [SEED]);

  return (
    <CanvasHarness
      data={data}
      focusedNodeIds={activeFocus}
      // `focusNodeIds` auto-expands ancestors AND triggers the
      // expand-fit-to-subtree camera move. Seed it once so the
      // initial render frames the highlighted subtree.
      focusNodeIds={focusNodeIds}
      onActivate={(nodeId) => {
        const set = new Set<string>();
        const stack = [nodeId];
        while (stack.length > 0) {
          const id = stack.pop()!;
          set.add(id);
          for (const child of childrenByParent.get(id) ?? []) {
            stack.push(child);
          }
        }
        setActiveFocus(set);
        setFocusNodeIds([nodeId]);
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Meta + stories
// ---------------------------------------------------------------------------

const meta = {
  title: "Org Chart / Canvas",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <CanvasHarness data={buildChartData()} />,
};

export const ExpandAll: Story = {
  render: () => <CanvasHarness data={buildChartData()} bulkAction="expand-all" />,
};

export const Focused: Story = {
  render: () => <FocusedHarness />,
};

export const SearchDim: Story = {
  render: () => <CanvasHarness data={buildChartData("Platform")} filterActive />,
};
