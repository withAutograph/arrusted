// Frozen relation-neighbourhood cases. `relation-neighbourhood-golden.json`
// holds the output these cases produced BEFORE framed groups existed; the
// no-op test re-runs them and requires identical nodes, edges, and bounds.
// Never regenerate the golden to make an unframed layout change pass.

import type { OrgChartNode } from "../../layout";
import type { RelationLayoutInput } from "../../relation-graph-layout";

function n(id: string): OrgChartNode {
  return { id, name: id, nodeKind: "subject", fieldValues: {} };
}

function group(prefix: string, count: number): OrgChartNode[] {
  return Array.from({ length: count }, (_, i) => n(`${prefix}${i}`));
}

function singles(prefix: string, count: number): OrgChartNode[][] {
  return Array.from({ length: count }, (_, i) => [n(`${prefix}${i}`)]);
}

const SIZE = { width: 208, height: 56 };

export const RELATION_NEIGHBOURHOOD_CASES: Array<{ name: string; input: RelationLayoutInput }> = [
  { name: "lone centre", input: { centre: n("c"), sides: {}, nodeSize: SIZE } },
  {
    name: "single columns",
    input: {
      centre: n("c"),
      sides: { left: [group("l", 2)], right: singles("r", 3) },
      nodeSize: SIZE,
    },
  },
  {
    name: "record employee",
    input: {
      centre: n("c"),
      sides: { left: singles("l", 2), right: singles("r", 6), below: [group("d", 3)] },
      nodeSize: SIZE,
    },
  },
  {
    name: "many columns with overflow",
    input: {
      centre: n("c"),
      sides: {
        left: [group("x", 3), [...group("y", 3), n("y-more")]],
        right: [group("a", 2), [...group("g", 3), n("g-more")], group("b", 1)],
        below: [group("d", 2), [...group("e", 3), n("e-more")]],
      },
      nodeSize: SIZE,
    },
  },
  {
    name: "twelve a side",
    input: {
      centre: n("c"),
      sides: { left: singles("l", 12), right: singles("r", 12), below: [group("d", 4)] },
      nodeSize: SIZE,
    },
  },
  {
    name: "uneven and uncapped",
    input: {
      centre: n("c"),
      sides: { right: [group("a", 1), group("g", 6), group("b", 1)], below: [group("d", 1)] },
      nodeSize: { width: 180, height: 48 },
    },
  },
];
