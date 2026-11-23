// Frozen top-to-bottom layout cases. `top-to-bottom-golden.json` holds the
// output these cases produced BEFORE the `direction` option existed; the
// no-op test re-runs them and requires identical nodes, edges, and bounds.
// Never regenerate the golden to make a top-to-bottom change pass.

import type { OrgChartLink, OrgChartNode } from "../../layout";
import type { OrgChartAtom } from "../../types";

export type TopToBottomCase = {
  name: string;
  nodes: OrgChartNode[];
  links: OrgChartLink[];
  expanded: string[];
  filterActive?: boolean;
  showSlots?: boolean;
  showNodeInsights?: boolean;
  slotMap?: Array<[string, OrgChartAtom]>;
};

function subject(id: string, name: string, extra: Partial<OrgChartNode> = {}): OrgChartNode {
  return { id, name, nodeKind: "subject", fieldValues: {}, ...extra };
}

const TREE_NODES: OrgChartNode[] = [
  subject("root", "Root"),
  subject("a", "Node A", { slotId: "slot-a" }),
  subject("b", "Node B"),
  subject("a1", "Node A1"),
  subject("a2", "Node A2", { matchesFilter: false }),
  subject("a1x", "Node A1x"),
  { id: "v1", name: "Open seat", nodeKind: "vacant", fieldValues: {}, slotData: { seat: 1 } },
  { id: "e1", name: "Contractor", nodeKind: "external", fieldValues: {} },
];

const TREE_LINKS: OrgChartLink[] = [
  { from: "root", to: "a" },
  { from: "root", to: "b" },
  { from: "a", to: "a1" },
  { from: "a", to: "a2" },
  { from: "a1", to: "a1x" },
  { from: "b", to: "v1" },
  { from: "b", to: "e1" },
];

export const TOP_TO_BOTTOM_CASES: TopToBottomCase[] = [
  { name: "collapsed", nodes: TREE_NODES, links: TREE_LINKS, expanded: [] },
  {
    name: "expanded",
    nodes: TREE_NODES,
    links: TREE_LINKS,
    expanded: ["root", "a", "b", "a1"],
  },
  {
    name: "slots-insights-filter",
    nodes: TREE_NODES,
    links: TREE_LINKS,
    expanded: ["root", "a", "b", "a1"],
    filterActive: true,
    showSlots: true,
    showNodeInsights: true,
    slotMap: [["slot-a", { label: "Slot A" }]],
  },
  {
    name: "virtual-root-and-forest",
    nodes: [
      { ...subject("vr", "Company"), isVirtualRoot: true },
      subject("x", "X"),
      subject("y", "Y", { sortKey: "0001" }),
      subject("z", "Z"),
      subject("lone", "Lone root"),
    ],
    links: [
      { from: "vr", to: "x" },
      { from: "vr", to: "y" },
      { from: "x", to: "z" },
    ],
    expanded: ["vr", "x"],
    showSlots: true,
  },
  {
    name: "cycle",
    nodes: [subject("c1", "C1"), subject("c2", "C2")],
    links: [
      { from: "c1", to: "c2" },
      { from: "c2", to: "c1" },
    ],
    expanded: ["c1", "c2"],
  },
];
