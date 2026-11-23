// Layout regression test for the org-chart module.
//
// Mounts `useOrgChartLayout` inside a tiny harness and asserts the
// structural properties that matter to the canvas:
//   • Every node gets a positioned (x, y) box
//   • The root is centered above its children
//   • Collapsed subtrees drop out of the visible node set
//   • Edge paths are produced for every visible link
//
// This is the minimum-viable surface that catches "I edited the layout
// math and the chart broke" regressions. The full visual contract lives
// in the Storybook stories + screenshots, not here.

import { useOrgChartLayout, type OrgChartLink, type OrgChartNode } from "../layout";

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

function makeNode(id: string, name: string): OrgChartNode {
  return {
    id,
    name,
    nodeKind: "subject",
    fieldValues: {},
  };
}

const NODES: OrgChartNode[] = [
  makeNode("root", "Root"),
  makeNode("a", "Node A"),
  makeNode("b", "Node B"),
  makeNode("a1", "Node A1"),
  makeNode("a2", "Node A2"),
];

const LINKS: OrgChartLink[] = [
  { from: "root", to: "a" },
  { from: "root", to: "b" },
  { from: "a", to: "a1" },
  { from: "a", to: "a2" },
];

describe("useOrgChartLayout", () => {
  it("produces a positioned layout for every visible node", () => {
    const { result } = renderHook(() =>
      useOrgChartLayout(NODES, LINKS, new Set(["root", "a", "b"])),
    );

    expect(result.current.nodes.length).toBe(5);
    expect(result.current.edges.length).toBe(4);

    // Bounds are non-degenerate
    expect(result.current.bounds.width).toBeGreaterThan(0);
    expect(result.current.bounds.height).toBeGreaterThan(0);
  });

  it("centers a parent above its children's combined width", () => {
    const { result } = renderHook(() =>
      useOrgChartLayout(NODES, LINKS, new Set(["root", "a", "b"])),
    );

    const byId = new Map(result.current.nodes.map((n) => [n.id, n]));
    const root = byId.get("root")!;
    const a = byId.get("a")!;
    const b = byId.get("b")!;
    const a1 = byId.get("a1")!;
    const a2 = byId.get("a2")!;

    // root above a and b
    expect(root.y).toBeLessThan(a.y);
    expect(root.y).toBeLessThan(b.y);

    // a above its own children
    expect(a.y).toBeLessThan(a1.y);
    expect(a.y).toBeLessThan(a2.y);

    // a1 and a2 share their parent row
    expect(a1.y).toBe(a2.y);

    // Root center is the midpoint of {a, b} centers (within a tolerance
    // that accounts for the layout's own subtree-width logic — the root
    // should be in the horizontal span of its descendants).
    const rootCenter = root.x + root.width / 2;
    const aCenter = a.x + a.width / 2;
    const bCenter = b.x + b.width / 2;
    expect(rootCenter).toBeGreaterThanOrEqual(Math.min(aCenter, bCenter));
    expect(rootCenter).toBeLessThanOrEqual(Math.max(aCenter, bCenter));
  });

  it("drops descendants when an ancestor is collapsed", () => {
    // With "a" collapsed (not in the expanded set), a1/a2 should be hidden.
    // Depth thresholds: depth < ALWAYS_VISIBLE_DEPTH (2) is always visible,
    // so root (0) and a/b (1) stay. a1/a2 at depth 2 require ancestor "a"
    // to be in the expanded set.
    const { result } = renderHook(() => useOrgChartLayout(NODES, LINKS, new Set<string>()));

    const ids = new Set(result.current.nodes.map((n) => n.id));
    expect(ids.has("root")).toBe(true);
    expect(ids.has("a")).toBe(true);
    expect(ids.has("b")).toBe(true);
    expect(ids.has("a1")).toBe(false);
    expect(ids.has("a2")).toBe(false);

    // Edges to hidden nodes are dropped
    const edgeTargets = result.current.edges.map((e) => e.target);
    expect(edgeTargets).not.toContain("a1");
    expect(edgeTargets).not.toContain("a2");
  });

  it("returns empty maps and bounds for an empty graph", () => {
    const { result } = renderHook(() => useOrgChartLayout([], [], new Set()));
    expect(result.current.nodes).toEqual([]);
    expect(result.current.edges).toEqual([]);
    expect(result.current.bounds.width).toBe(0);
    expect(result.current.bounds.height).toBe(0);
  });

  it("emits cubic-bezier edge paths from buildEdgePath", () => {
    const { result } = renderHook(() =>
      useOrgChartLayout(NODES, LINKS, new Set(["root", "a", "b"])),
    );

    for (const edge of result.current.edges) {
      expect(edge.path).toMatch(/^M \S+ \S+ C \S+ \S+ \S+ \S+ \S+ \S+$/);
    }
  });

  it("populates layer + parent membership in node data", () => {
    const { result } = renderHook(() =>
      useOrgChartLayout(NODES, LINKS, new Set(["root", "a", "b"])),
    );
    const byId = new Map(result.current.nodes.map((n) => [n.id, n]));
    expect(byId.get("root")!.data.layer).toBe(1);
    expect(byId.get("a")!.data.layer).toBe(2);
    expect(byId.get("a1")!.data.layer).toBe(3);
    expect(byId.get("root")!.data.hasParent).toBe(false);
    expect(byId.get("a")!.data.hasParent).toBe(true);
  });

  it("exposes parentMap and childrenMap to the caller", () => {
    const { result } = renderHook(() =>
      useOrgChartLayout(NODES, LINKS, new Set(["root", "a", "b"])),
    );
    expect(result.current.parentMap.get("a")).toBe("root");
    expect(result.current.parentMap.get("a1")).toBe("a");
    expect(result.current.childrenMap.get("root")?.length).toBe(2);
    expect(result.current.childrenMap.get("a")?.length).toBe(2);
  });

  it("does not hang on a cyclic link set", () => {
    const cyclicNodes = [makeNode("a", "Node A"), makeNode("b", "Node B")];
    const cyclicLinks: OrgChartLink[] = [
      { from: "a", to: "b" },
      { from: "b", to: "a" },
    ];

    const { result } = renderHook(() =>
      useOrgChartLayout(cyclicNodes, cyclicLinks, new Set(["a", "b"])),
    );

    expect(result.current.nodes.map((node) => node.id).sort()).toEqual(["a", "b"]);
  });

  it("keeps nodes renderable when links reference a missing parent", () => {
    const { result } = renderHook(() =>
      useOrgChartLayout(
        [makeNode("child", "Child")],
        [{ from: "missing", to: "child" }],
        new Set(["missing"]),
      ),
    );

    expect(result.current.nodes.map((node) => node.id)).toEqual(["child"]);
    expect(result.current.edges).toEqual([]);
  });
});
