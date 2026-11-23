// Direction contract for `useOrgChartLayout`.
//
//   • top-to-bottom (default and explicit) reproduces the pre-`direction`
//     golden output exactly: nodes, edges, and bounds.
//   • left-to-right puts children in one column to the right of the parent,
//     with connectors leaving the parent's right edge.
//   • right-to-left is the exact mirror of left-to-right.

import { useOrgChartLayout, type OrgChartLayoutOptions, type OrgChartNode } from "../layout";
import { TOP_TO_BOTTOM_CASES } from "./fixtures/top-to-bottom-cases";
import golden from "./fixtures/top-to-bottom-golden.json";

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

function layoutCase(
  name: string,
  options?: OrgChartLayoutOptions,
  mapNode: (node: OrgChartNode) => OrgChartNode = (node) => node,
  raw = false,
) {
  const c = TOP_TO_BOTTOM_CASES.find((entry) => entry.name === name)!;
  const caseNodes = c.nodes.map(mapNode);
  const { result } = renderHook(() =>
    useOrgChartLayout(
      caseNodes,
      c.links,
      new Set(c.expanded),
      undefined,
      "2026-01-01",
      c.filterActive ?? false,
      c.showSlots ?? false,
      c.showNodeInsights ?? false,
      new Map(c.slotMap ?? []),
      options,
    ),
  );
  const { nodes, edges, bounds } = result.current;
  if (raw) return { nodes, edges, bounds };
  // Drop undefined fields so the comparison matches the stored JSON golden.
  return withoutUndefined({ nodes, edges, bounds });
}

function withoutUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = withoutUndefined(entry);
  }
  return out;
}

const GOLDEN = golden as Record<string, unknown>;

describe("useOrgChartLayout top-to-bottom is unchanged", () => {
  it("leaves the interactive flag absent by default", () => {
    const layout = layoutCase("expanded", undefined, undefined, true) as {
      nodes: Array<{ data: object }>;
    };
    for (const node of layout.nodes) expect("interactive" in node.data).toBe(false);
  });

  for (const { name } of TOP_TO_BOTTOM_CASES) {
    it(`matches the pre-direction golden for "${name}" with no options`, () => {
      expect(layoutCase(name)).toEqual(GOLDEN[name]);
    });

    it(`matches the pre-direction golden for "${name}" with explicit top-to-bottom`, () => {
      expect(layoutCase(name, { direction: "top-to-bottom" })).toEqual(GOLDEN[name]);
    });

    it(`"${name}" with explicit interactive: true differs only by that flag`, () => {
      const explicit = layoutCase(name, undefined, (node) => ({ ...node, interactive: true })) as {
        nodes: Array<{ data: Record<string, unknown> }>;
      };
      for (const node of explicit.nodes) {
        expect(node.data.interactive).toBe(true);
        delete node.data.interactive;
      }
      expect(explicit).toEqual(GOLDEN[name]);
    });
  }
});

function leaf(id: string, name: string): OrgChartNode {
  return { id, name, nodeKind: "subject", fieldValues: {} };
}

const STAR_NODES: OrgChartNode[] = [
  leaf("centre", "Centre"),
  leaf("c1", "Child 1"),
  leaf("c2", "Child 2"),
  leaf("c3", "Child 3"),
];
const STAR_LINKS = [
  { from: "centre", to: "c1" },
  { from: "centre", to: "c2" },
  { from: "centre", to: "c3" },
];
const SIZE = { width: 200, height: 48 };
const EXPANDED = new Set(["centre"]);

function layoutStar(direction: OrgChartLayoutOptions["direction"]) {
  const { result } = renderHook(() =>
    useOrgChartLayout(
      STAR_NODES,
      STAR_LINKS,
      EXPANDED,
      undefined,
      "",
      false,
      false,
      false,
      undefined,
      { direction, nodeSize: SIZE },
    ),
  );
  const byId = new Map(result.current.nodes.map((node) => [node.id, node]));
  return { ...result.current, byId };
}

describe("useOrgChartLayout horizontal directions", () => {
  it("left-to-right stacks children in one column right of the centre", () => {
    const { byId, edges, bounds } = layoutStar("left-to-right");
    const centre = byId.get("centre")!;
    const children = ["c1", "c2", "c3"].map((id) => byId.get(id)!);

    for (const child of children) {
      expect(child.width).toBe(200);
      expect(child.height).toBe(48);
      expect(child.x).toBe(centre.x + centre.width + 72);
    }
    // One column, ordered top-down, 16px apart, never overlapping.
    expect(children.map((child) => child.y)).toEqual([0, 64, 128]);
    // Centre sits at the vertical midpoint of its children.
    expect(centre.x).toBe(0);
    expect(centre.y + centre.height / 2).toBe(64 + 24);

    expect(bounds).toMatchObject({ minX: 0, minY: 0, width: 472, height: 176 });

    const toC1 = edges.find((edge) => edge.target === "c1")!;
    expect(toC1.path).toBe("M 200 88 C 236 88 236 24 272 24");
  });

  it("right-to-left mirrors left-to-right with the centre on the right", () => {
    const ltr = layoutStar("left-to-right");
    const rtl = layoutStar("right-to-left");

    expect(rtl.bounds).toEqual(ltr.bounds);
    for (const [id, node] of rtl.byId) {
      const mirror = ltr.byId.get(id)!;
      expect(node.y).toBe(mirror.y);
      expect(node.x).toBe(ltr.bounds.width - mirror.x - mirror.width);
      expect(node.x).toBeGreaterThanOrEqual(0);
    }
    expect(rtl.byId.get("centre")!.x).toBe(272);
    expect(rtl.byId.get("c1")!.x).toBe(0);

    const toC1 = rtl.edges.find((edge) => edge.target === "c1")!;
    // Leaves the centre's left edge and lands on the child's right edge.
    expect(toC1.path).toBe("M 272 88 C 236 88 236 24 200 24");
  });

  it("top-to-bottom honours nodeSize without changing its spacing", () => {
    const { byId } = layoutStar("top-to-bottom");
    const centre = byId.get("centre")!;
    const c1 = byId.get("c1")!;
    const c2 = byId.get("c2")!;
    expect(c1.y).toBe(centre.y + 48 + 72);
    expect(c2.x - c1.x).toBe(200 + 56);
  });
});
