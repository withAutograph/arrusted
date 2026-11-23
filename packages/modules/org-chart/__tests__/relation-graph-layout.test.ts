// Geometry contract for the relation neighbourhood layout:
//   • up to four cards: one column per side, vertically centred on the centre;
//   • more: brick-offset columns (max three), filled top to bottom, never
//     splitting a group;
//   • the below row sits under both sides;
//   • no two cards overlap and no connector passes behind a card.

import type { OrgChartLayoutNode, OrgChartNode, OrgChartPositionedLayout } from "../layout";
import {
  layoutRelationNeighbourhood,
  type RelationLayout,
  type RelationLayoutFrame,
  type RelationLayoutGroup,
} from "../relation-graph-layout";
import { RELATION_NEIGHBOURHOOD_CASES } from "./fixtures/relation-neighbourhood-cases";
import golden from "./fixtures/relation-neighbourhood-golden.json";

import { describe, expect, it } from "vite-plus/test";

const SIZE = { width: 208, height: 56 };

function n(id: string): OrgChartNode {
  return { id, name: id, nodeKind: "subject", fieldValues: {} };
}

function group(prefix: string, count: number): OrgChartNode[] {
  return Array.from({ length: count }, (_, i) => n(`${prefix}${i}`));
}

type Point = { x: number; y: number };

/** Sample an `M … [L …] C …` path into points. */
function samplePath(path: string): Point[] {
  const tokens = path.trim().split(/\s+/);
  const points: Point[] = [];
  let cursor: Point = { x: 0, y: 0 };
  let i = 0;
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    const command = tokens[i++];
    if (command === "M") {
      cursor = { x: num(), y: num() };
      points.push(cursor);
    } else if (command === "L") {
      const to = { x: num(), y: num() };
      for (let s = 1; s <= 40; s += 1) {
        const t = s / 40;
        points.push({ x: cursor.x + (to.x - cursor.x) * t, y: cursor.y + (to.y - cursor.y) * t });
      }
      cursor = to;
    } else if (command === "C") {
      const p1 = { x: num(), y: num() };
      const p2 = { x: num(), y: num() };
      const p3 = { x: num(), y: num() };
      const p0 = cursor;
      for (let s = 1; s <= 80; s += 1) {
        const t = s / 80;
        const u = 1 - t;
        points.push({
          x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
          y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
        });
      }
      cursor = p3;
    } else {
      throw new Error(`unexpected path command ${command}`);
    }
  }
  return points;
}

type Rect = { x: number; y: number; width: number; height: number };

function strictlyInside(point: Point, box: Rect): boolean {
  return (
    point.x > box.x + 0.5 &&
    point.x < box.x + box.width - 0.5 &&
    point.y > box.y + 0.5 &&
    point.y < box.y + box.height - 0.5
  );
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/** A frame with the half of its caption that sits above the border. */
function frameExtent(frame: RelationLayoutFrame): Rect {
  return {
    x: frame.x,
    y: frame.caption.y,
    width: frame.width,
    height: frame.y + frame.height - frame.caption.y,
  };
}

/**
 * Frames and captions are obstacles too: a frame holds exactly its own
 * cards, no two frames overlap, every caption sits on its frame's top edge,
 * and an edge may enter only the frame of its own target, never a caption.
 */
function assertFramesClean(layout: RelationLayout) {
  const { nodes, edges, frames, bounds } = layout;
  if (frames.length === 0) return;
  for (const frame of frames) {
    const members = new Set(frame.nodeIds);
    for (const node of nodes) {
      if (members.has(node.id)) {
        expect(contains(frame, node), `${frame.id} holds ${node.id}`).toBe(true);
      } else {
        expect(overlaps(frameExtent(frame), node), `${frame.id} overlaps ${node.id}`).toBe(false);
      }
    }
    expect(frame.caption.y + frame.caption.height / 2).toBeCloseTo(frame.y);
    expect(contains({ ...frame, y: frame.caption.y, height: frame.height }, frame.caption)).toBe(
      true,
    );
    expect(frame.caption.y).toBeGreaterThanOrEqual(0);
    expect(frame.x).toBeGreaterThanOrEqual(0);
    expect(
      contains({ x: 0, y: 0, width: bounds.maxX, height: bounds.maxY }, frameExtent(frame)),
    ).toBe(true);
    for (const other of frames) {
      if (other === frame) continue;
      expect(
        overlaps(frameExtent(frame), frameExtent(other)),
        `${frame.id} meets ${other.id}`,
      ).toBe(false);
    }
  }
  for (const edge of edges) {
    const points = samplePath(edge.path);
    for (const frame of frames) {
      const hitCaption = points.find((point) => strictlyInside(point, frame.caption));
      expect(hitCaption, `edge ${edge.id} crosses the ${frame.id} caption`).toBeUndefined();
      if (frame.nodeIds.includes(edge.target)) continue;
      const hitFrame = points.find((point) => strictlyInside(point, frameExtent(frame)));
      expect(hitFrame, `edge ${edge.id} crosses the ${frame.id} frame`).toBeUndefined();
    }
  }
}

function assertClean(layout: OrgChartPositionedLayout | RelationLayout) {
  if ("frames" in layout) assertFramesClean(layout);
  const { nodes, edges } = layout;
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      expect(overlaps(nodes[i]!, nodes[j]!), `${nodes[i]!.id} overlaps ${nodes[j]!.id}`).toBe(
        false,
      );
    }
    expect(nodes[i]!.x).toBeGreaterThanOrEqual(0);
    expect(nodes[i]!.y).toBeGreaterThanOrEqual(0);
  }
  for (const edge of edges) {
    const points = samplePath(edge.path);
    for (const node of nodes) {
      if (node.id === edge.source || node.id === edge.target) continue;
      const hit = points.find((point) => strictlyInside(point, node));
      expect(hit, `edge ${edge.id} passes behind ${node.id}`).toBeUndefined();
    }
    const top = Math.min(...nodes.map((node) => node.y));
    const bottom = Math.max(...nodes.map((node) => node.y + node.height));
    const outside = points.find((point) => point.y < top - 0.5 || point.y > bottom + 0.5);
    expect(outside, `edge ${edge.id} leaves the drawn area`).toBeUndefined();
  }
}

function byId(layout: OrgChartPositionedLayout) {
  return new Map(layout.nodes.map((node) => [node.id, node]));
}

describe("layoutRelationNeighbourhood", () => {
  it("places left and right in single columns centred on the centre", () => {
    const layout = layoutRelationNeighbourhood({
      centre: n("c"),
      sides: { left: [group("l", 2)], right: [[n("r0")], [n("r1")], [n("r2")]] },
      nodeSize: SIZE,
    });
    const nodes = byId(layout);
    const centre = nodes.get("c")!;
    const lefts = ["l0", "l1"].map((id) => nodes.get(id)!);
    const rights = ["r0", "r1", "r2"].map((id) => nodes.get(id)!);

    expect(new Set(lefts.map((node) => node.x)).size).toBe(1);
    expect(new Set(rights.map((node) => node.x)).size).toBe(1);
    expect(lefts[0]!.x + SIZE.width).toBeLessThan(centre.x);
    expect(rights[0]!.x).toBeGreaterThan(centre.x + SIZE.width);

    const mid = (items: OrgChartLayoutNode[]) => (items[0]!.y + items.at(-1)!.y + SIZE.height) / 2;
    expect(mid(lefts)).toBeCloseTo(centre.y + SIZE.height / 2);
    expect(mid(rights)).toBeCloseTo(centre.y + SIZE.height / 2);

    expect(layout.edges.map((edge) => edge.target)).toEqual(["l0", "l1", "r0", "r1", "r2"]);
    assertClean(layout);
  });

  it("keeps groups contiguous and in order within a column", () => {
    const layout = layoutRelationNeighbourhood({
      centre: n("c"),
      sides: { right: [group("a", 2), group("b", 2)] },
      nodeSize: SIZE,
    });
    const nodes = byId(layout);
    const cards = ["a0", "a1", "b0", "b1"].map((id) => nodes.get(id)!);
    expect(new Set(cards.map((node) => node.x)).size).toBe(1);
    const ys = cards.map((node) => node.y);
    expect(ys).toEqual([...ys].sort((p, q) => p - q));
    assertClean(layout);
  });

  function columnsOf(layout: OrgChartPositionedLayout, prefix: RegExp) {
    const xs = new Map<number, string[]>();
    for (const node of layout.nodes) {
      if (!prefix.test(node.id)) continue;
      xs.set(node.x, [...(xs.get(node.x) ?? []), node.id]);
    }
    return [...xs.entries()].sort(([a], [b]) => a - b).map(([, ids]) => ids);
  }

  for (const count of [6, 9, 12]) {
    it(`wraps ${count} single-card groups into brick columns on both sides`, () => {
      const singles = (prefix: string) =>
        Array.from({ length: count }, (_, i) => [n(`${prefix}${i}`)]);
      const layout = layoutRelationNeighbourhood({
        centre: n("c"),
        sides: { left: singles("l"), right: singles("r"), below: [group("d", 3)] },
        nodeSize: SIZE,
      });
      const right = columnsOf(layout, /^r\d/);
      const left = columnsOf(layout, /^l\d/).reverse(); // innermost first
      const expected = count === 6 ? [4, 2] : count === 9 ? [4, 4, 1] : [4, 4, 4];
      expect(right.map((column) => column.length)).toEqual(expected);
      expect(left.map((column) => column.length)).toEqual(expected);
      // Filled top to bottom, in the host's order.
      expect(right.flat()).toEqual(Array.from({ length: count }, (_, i) => `r${i}`));

      // Brick: each outer column sits half a row pitch below its inner one.
      const nodes = byId(layout);
      const firstY = (ids: string[]) => nodes.get(ids[0]!)!.y;
      const pitch = nodes.get(right[0]![1]!)!.y - firstY(right[0]!);
      expect(firstY(right[1]!) - firstY(right[0]!)).toBeCloseTo(pitch / 2);
      assertClean(layout);
    });
  }

  it("keeps outer-column connectors inside the drawn area for uneven groups", () => {
    const layout = layoutRelationNeighbourhood({
      centre: n("c"),
      sides: { right: [group("a", 1), group("b", 4), group("z", 1)] },
      nodeSize: SIZE,
    });
    expect(columnsOf(layout, /^[abz]/).map((column) => column.length)).toEqual([1, 4, 1]);
    assertClean(layout);
  });

  it("keeps every edge clear and in bounds for all small group-size combinations", () => {
    const shapes: number[][] = [[]];
    for (let groups = 1; groups <= 3; groups += 1) {
      const next: number[][] = [];
      for (const shape of shapes.filter((candidate) => candidate.length === groups - 1)) {
        for (let size = 1; size <= 5; size += 1) next.push([...shape, size]);
      }
      shapes.push(...next);
    }
    for (const shape of shapes) {
      const groupsFor = (prefix: string) => shape.map((size, i) => group(`${prefix}${i}-`, size));
      const layout = layoutRelationNeighbourhood({
        centre: n("c"),
        sides: { left: groupsFor("l"), right: groupsFor("r"), below: [group("d", 3)] },
        nodeSize: SIZE,
      });
      assertClean(layout);
    }
    // 155 full geometry sweeps; slow on a loaded machine.
  }, 30_000);

  it("never splits a group (with its overflow card) across a column break", () => {
    const layout = layoutRelationNeighbourhood({
      centre: n("c"),
      sides: {
        right: [group("a", 2), [...group("g", 3), n("g-more")], group("b", 1)],
        left: [group("x", 3), [...group("y", 3), n("y-more")]],
      },
      nodeSize: SIZE,
    });
    const columns = columnsOf(layout, /^[agb]/);
    expect(columns).toEqual([["a0", "a1"], ["g0", "g1", "g2", "g-more"], ["b0"]]);
    expect(columnsOf(layout, /^[xy]/).reverse()).toEqual([
      ["x0", "x1", "x2"],
      ["y0", "y1", "y2", "y-more"],
    ]);
    assertClean(layout);
  });

  it("keeps four cards per column by adding columns instead of overfilling one", () => {
    for (const [count, expected] of [
      [14, [4, 4, 4, 2]],
      [20, [4, 4, 4, 4, 4]],
    ] as const) {
      const singles = (prefix: string) =>
        Array.from({ length: count }, (_, i) => [n(`${prefix}${i}`)]);
      const layout = layoutRelationNeighbourhood({
        centre: n("c"),
        sides: { left: singles("l"), right: singles("r"), below: [group("d", 3)] },
        nodeSize: SIZE,
      });
      expect(columnsOf(layout, /^r\d/).map((column) => column.length)).toEqual(expected);
      expect(columnsOf(layout, /^l\d/).map((column) => column.length)).toEqual(
        [...expected].reverse(),
      );
      assertClean(layout);
    }
  });

  it("keeps an uncapped group larger than four whole in one column", () => {
    const layout = layoutRelationNeighbourhood({
      centre: n("c"),
      sides: { right: [group("a", 1), group("g", 6), group("b", 1)] },
      nodeSize: SIZE,
    });
    expect(columnsOf(layout, /^[agb]/)).toEqual([
      ["a0"],
      ["g0", "g1", "g2", "g3", "g4", "g5"],
      ["b0"],
    ]);
    assertClean(layout);
  });
  it("puts the below row under tall side columns with a clear trunk", () => {
    const layout = layoutRelationNeighbourhood({
      centre: n("c"),
      sides: {
        left: [group("l", 2)],
        right: [group("r", 6)],
        below: [group("d", 4)],
      },
      nodeSize: SIZE,
    });
    const nodes = byId(layout);
    const sideBottom = Math.max(
      ...layout.nodes.filter((node) => /^[lr]\d/.test(node.id)).map((node) => node.y + node.height),
    );
    for (const id of ["d0", "d1", "d2", "d3"]) {
      expect(nodes.get(id)!.y).toBeGreaterThan(sideBottom);
    }
    assertClean(layout);
  });

  it("orders nodes left, centre, right, below for keyboard focus", () => {
    const layout = layoutRelationNeighbourhood({
      centre: n("c"),
      sides: { left: [[n("l0")]], right: [[n("r0")]], below: [[n("d0")]] },
      nodeSize: SIZE,
    });
    expect(layout.nodes.map((node) => node.id)).toEqual(["l0", "c", "r0", "d0"]);
    assertClean(layout);
  });

  it("lays out a lone centre", () => {
    const layout = layoutRelationNeighbourhood({ centre: n("c"), sides: {}, nodeSize: SIZE });
    expect(layout.nodes).toHaveLength(1);
    expect(layout.nodes[0]).toMatchObject({ x: 0, y: 0, width: 208, height: 56 });
    expect(layout.edges).toEqual([]);
  });

  it("detects an edge drawn behind a card (negative proof of the checker)", () => {
    const layout = layoutRelationNeighbourhood({
      centre: n("c"),
      sides: { right: [group("r", 3)] },
      nodeSize: SIZE,
    });
    const r0 = byId(layout).get("r0")!;
    const r2 = byId(layout).get("r2")!;
    // A straight connector down the column from r0 to r2 crosses r1.
    const bad = {
      ...layout,
      edges: [
        {
          id: "bad",
          source: "r0",
          target: "r2",
          path: `M ${r0.x + 10} ${r0.y + r0.height} L ${r2.x + 10} ${r2.y}`,
        },
      ],
    };
    expect(() => assertClean(bad)).toThrow(/passes behind r1/);
  });
});

describe("layoutRelationNeighbourhood without frames is unchanged", () => {
  const GOLDEN = golden as Record<string, unknown>;
  for (const { name, input } of RELATION_NEIGHBOURHOOD_CASES) {
    it(`matches the pre-frame golden for "${name}"`, () => {
      const { nodes, edges, bounds, frames } = layoutRelationNeighbourhood(input);
      // `toEqual` skips undefined fields, which the stored JSON omits.
      expect({ nodes, edges, bounds }).toEqual(GOLDEN[name]);
      expect(frames).toEqual([]);
    });
  }

  it("keeps the other sides identical when one side gains a frame", () => {
    const plain = layoutRelationNeighbourhood({
      centre: n("c"),
      sides: { right: [group("r", 6)] },
      nodeSize: SIZE,
    });
    const framed = layoutRelationNeighbourhood({
      centre: n("c"),
      sides: { right: [group("r", 6)], left: [{ frameId: "f", nodes: group("l", 2) }] },
      nodeSize: SIZE,
    });
    const centre = (layout: RelationLayout) => byId(layout).get("c")!;
    const relative = (layout: RelationLayout) =>
      layout.nodes
        .filter((node) => node.id.startsWith("r"))
        .map((node) => [node.id, node.x - centre(layout).x, node.y - centre(layout).y]);
    expect(relative(framed)).toEqual(relative(plain));
  });
});

describe("layoutRelationNeighbourhood framed groups", () => {
  const framed = (frameId: string, nodes: OrgChartNode[]): RelationLayoutGroup => ({
    frameId,
    nodes,
  });

  function frameOf(layout: RelationLayout, id: string) {
    return layout.frames.find((frame) => frame.id === id)!;
  }

  it("frames a left-side mapping group, centred like a plain column", () => {
    const layout = layoutRelationNeighbourhood({
      centre: n("c"),
      sides: {
        left: [framed("assignment", [n("position"), n("manager")])],
        right: Array.from({ length: 6 }, (_, i) => [n(`r${i}`)]),
        below: [group("d", 3)],
      },
      nodeSize: SIZE,
    });
    const nodes = byId(layout);
    const frame = frameOf(layout, "assignment");
    expect(frame).toMatchObject({ side: "left", nodeIds: ["position", "manager"] });
    const centre = nodes.get("c")!;
    const position = nodes.get("position")!;
    const manager = nodes.get("manager")!;
    expect(position.x).toBe(manager.x);
    expect((position.y + manager.y + SIZE.height) / 2).toBeCloseTo(centre.y + SIZE.height / 2);
    expect(frame.x + frame.width).toBeLessThan(centre.x);
    // The below row starts under the frame, not just under its cards.
    expect(nodes.get("d0")!.y).toBeGreaterThan(frame.y + frame.height);
    expect(layout.edges.filter((edge) => frame.nodeIds.includes(edge.target))).toHaveLength(2);
    assertClean(layout);
  });

  it("puts framed groups in one outermost column after the plain groups", () => {
    const layout = layoutRelationNeighbourhood({
      centre: n("c"),
      sides: {
        right: [framed("f", group("f", 2)), ...Array.from({ length: 5 }, (_, i) => [n(`r${i}`)])],
      },
      nodeSize: SIZE,
    });
    const nodes = byId(layout);
    const plainMaxX = Math.max(...[0, 1, 2, 3, 4].map((i) => nodes.get(`r${i}`)!.x));
    expect(nodes.get("f0")!.x).toBeGreaterThan(plainMaxX);
    expect(nodes.get("f1")!.x).toBe(nodes.get("f0")!.x);
    assertClean(layout);
  });

  it("never splits a framed group, even past four cards", () => {
    const layout = layoutRelationNeighbourhood({
      centre: n("c"),
      sides: { left: [group("a", 2), framed("f", group("f", 6))] },
      nodeSize: SIZE,
    });
    const nodes = byId(layout);
    expect(new Set(group("f", 6).map((node) => nodes.get(node.id)!.x)).size).toBe(1);
    expect(frameOf(layout, "f").nodeIds).toHaveLength(6);
    assertClean(layout);
  });

  it("stacks two framed groups on one side in the same column", () => {
    const layout = layoutRelationNeighbourhood({
      centre: n("c"),
      sides: {
        left: [framed("a", group("a", 2)), framed("b", group("b", 3))],
        right: [group("r", 3), framed("x", group("x", 1)), framed("y", group("y", 2))],
      },
      nodeSize: SIZE,
    });
    const nodes = byId(layout);
    expect(nodes.get("a0")!.x).toBe(nodes.get("b0")!.x);
    expect(nodes.get("x0")!.x).toBe(nodes.get("y0")!.x);
    expect(frameOf(layout, "a").y + frameOf(layout, "a").height).toBeLessThan(
      frameOf(layout, "b").caption.y,
    );
    expect(layout.frames.map((frame) => frame.id)).toEqual(["a", "b", "x", "y"]);
    assertClean(layout);
  });

  it("frames below groups and drops every below connector clear of the captions", () => {
    const layout = layoutRelationNeighbourhood({
      centre: n("c"),
      sides: {
        left: [[n("l0")]],
        below: [group("p", 2), framed("f", group("f", 2)), group("q", 1), framed("g", [n("g0")])],
      },
      nodeSize: SIZE,
    });
    const f = frameOf(layout, "f");
    const g = frameOf(layout, "g");
    expect(f.side).toBe("below");
    // Captions stop short of the first card's connector.
    for (const frame of [f, g]) {
      const first = byId(layout).get(frame.nodeIds[0]!)!;
      expect(frame.caption.x + frame.caption.width).toBeLessThan(first.x + first.width / 2);
    }
    assertClean(layout);
  });

  it("keeps every edge clear of frames and captions for small framed shapes", () => {
    const sizes = [1, 2, 3, 4, 5];
    for (const frameSize of sizes) {
      for (const plainCount of [0, 1, 3, 6, 9]) {
        for (const at of ["first", "last"] as const) {
          const side = (prefix: string): RelationLayoutGroup[] => {
            const plain = Array.from({ length: plainCount }, (_, i) => [n(`${prefix}${i}`)]);
            const frame = framed(`${prefix}F`, group(`${prefix}F-`, frameSize));
            return at === "first" ? [frame, ...plain] : [...plain, frame];
          };
          const layout = layoutRelationNeighbourhood({
            centre: n("c"),
            sides: {
              left: side("l"),
              right: side("r"),
              below: [group("d", Math.min(plainCount, 3)), framed("dF", group("dF-", frameSize))],
            },
            nodeSize: SIZE,
          });
          assertClean(layout);
        }
      }
    }
    // Fifty full geometry sweeps; slow on a loaded machine.
  }, 30_000);

  it("detects an edge through a caption or a foreign frame (negative proof)", () => {
    const layout = layoutRelationNeighbourhood({
      centre: n("c"),
      sides: { right: [framed("f", group("f", 2))], left: [framed("g", [n("g0")])] },
      nodeSize: SIZE,
    });
    const f = frameOf(layout, "f");
    const g0 = byId(layout).get("g0")!;
    const c = byId(layout).get("c")!;
    const throughCaption = {
      ...layout,
      edges: [
        {
          id: "bad",
          source: "c",
          target: "f0",
          path: `M ${f.caption.x + 4} ${f.caption.y - 10} L ${f.caption.x + 4} ${f.y + 30}`,
        },
      ],
    };
    expect(() => assertClean(throughCaption)).toThrow(/crosses the f caption/);
    const throughFrame = {
      ...layout,
      edges: [
        {
          id: "bad",
          source: "c",
          target: "g0",
          // Ends at g0 but detours through the right-hand frame.
          path: `M ${c.x + c.width} ${c.y + 28} L ${f.x + 6} ${f.y + f.height - 6} L ${g0.x + g0.width} ${g0.y + 28}`,
        },
      ],
    };
    expect(() => assertClean(throughFrame)).toThrow(/crosses the f frame/);
  });
});
