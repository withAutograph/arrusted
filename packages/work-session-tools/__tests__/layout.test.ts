import { describe, expect, test } from "vitest";
import { mainModelOrder } from "../labels";
import {
  addUnit,
  arrangeLayout,
  chartConfigSchema,
  freeSlot,
  newSessionLayout,
  parseLayout,
  placeGrid,
  spanForWidth,
  type CanvasLayout,
} from "../layout";

describe("layout", () => {
  test("validates units; a new session's empty layout holds none", () => {
    expect(parseLayout({})).toEqual({ ok: true, layout: { units: [] } });
    const unit = { id: "u", kind: "chart", config: {}, x: 0, y: 0, w: 10, h: 10 };
    expect(parseLayout({ units: [unit] })).toMatchObject({ ok: true });
    expect(parseLayout({ units: [{ ...unit, kind: "table" }] })).toMatchObject({ ok: false });
    expect(parseLayout({ units: [{ ...unit, w: 0 }] })).toMatchObject({ ok: false });
    expect(parseLayout({ units: [{ ...unit, id: undefined }] })).toMatchObject({ ok: false });
    // A rule unit shows one rule, by its id.
    const rule = { ...unit, kind: "rule", config: { rule_id: "r1" } };
    expect(parseLayout({ units: [rule] })).toMatchObject({ ok: true });
    expect(parseLayout({ units: [{ ...rule, config: {} }] })).toMatchObject({ ok: false });
  });

  test("on a free canvas a new unit takes the first free slot without overlapping", () => {
    const empty: CanvasLayout = { mode: "free", units: [] };
    expect(freeSlot(empty, { w: 640, h: 380 })).toEqual({ x: 80, y: 24 });
    const one = addUnit(empty, "chart");
    const two = addUnit(one, "chart");
    expect(two.units[1]).toMatchObject({ kind: "chart", x: 80 + 640 + 32, y: 24, w: 640, h: 380 });
    // A full-width grid does not fit beside them, so it goes below.
    const three = addUnit(two, "grid");
    expect(three.units[2]).toMatchObject({ x: 80, y: 24 + 380 + 32 });
    expect(new Set(three.units.map((unit) => unit.id)).size).toBe(3);
  });

  test("a grid canvas (the default) places units in reading order by span", () => {
    const one = addUnit({ units: [] }, "kpi", {}, "k");
    const two = addUnit(one, "grid", {}, "g");
    const three = addUnit(two, "chart", {}, "c");
    const four = addUnit(three, "graph", {}, "r");
    expect(four.mode).toBe("grid");
    const [kpi, grid, chart, graph] = four.units;
    // KPI strip and grid take the full width; charts and graphs half, side by side.
    expect(kpi).toMatchObject({ x: 80, y: 24, w: 1560, span: 12 });
    expect(grid).toMatchObject({ x: 80, y: 24 + 160 + 24, w: 1560 });
    expect(chart).toMatchObject({ x: 80, y: grid!.y + 460 + 24, span: 6 });
    expect(graph).toMatchObject({ y: chart!.y, x: 80 + chart!.w + 24 });
    // Placing again changes nothing.
    expect(placeGrid(four)).toEqual(four);
  });

  test("arrange: auto, grid by order and span, free; listed units checked", () => {
    let layout: CanvasLayout = { units: [] };
    for (const [id, kind] of [
      ["c1", "chart"],
      ["g", "grid"],
      ["c2", "chart"],
      ["n", "note"],
    ] as const)
      layout = addUnit(layout, kind, {}, id);
    const auto = arrangeLayout(layout, { mode: "auto" });
    expect(auto.units.map((unit) => unit.id)).toEqual(["g", "c1", "c2", "n"]);
    expect(auto.units.map((unit) => unit.span)).toEqual([12, 4, 4, 4]);
    expect(auto.units[1]!.y).toBe(auto.units[2]!.y);
    const ordered = arrangeLayout(auto, {
      mode: "grid",
      columns: 6,
      units: [{ unit_id: "n", order: 0, span: 6, h: 120 }],
    });
    expect(ordered.units[0]).toMatchObject({ id: "n", span: 6, h: 120, w: 1560 });
    // A span from 12 columns keeps its share: 4 of 12 is 2 of 6.
    expect(ordered.units.find((unit) => unit.id === "c1")!.span).toBe(2);
    const free = arrangeLayout(auto, {
      mode: "free",
      units: [{ unit_id: "c1", x: 900, y: 900, w: 300, h: 300 }],
    });
    expect(free.mode).toBe("free");
    expect(free.units.find((unit) => unit.id === "c1")).toMatchObject({ x: 900, y: 900 });
    expect(free.units.find((unit) => unit.id === "g")).toMatchObject(auto.units[0]!);
    expect(() => arrangeLayout(auto, { mode: "auto", columns: 4 })).toThrow(/auto arranges/);
    expect(() => arrangeLayout(auto, { mode: "grid", units: [{ unit_id: "nope" }] })).toThrow(
      /no unit/,
    );
    expect(() =>
      arrangeLayout(auto, { mode: "grid", units: [{ unit_id: "g" }, { unit_id: "g" }] }),
    ).toThrow(/twice/);
    expect(() => arrangeLayout(auto, { mode: "free", units: [{ unit_id: "g", x: 0 }] })).toThrow(
      /needs x, y, w and h/,
    );
  });

  test("arrange refuses columns and a gap that leave no room; the canvas lays any grid out in its width", () => {
    const layout = addUnit({ units: [] }, "chart", {}, "c");
    expect(() => arrangeLayout(layout, { mode: "grid", columns: 24, gap: 400 })).toThrow(
      /leave no room/,
    );
    const narrow = placeGrid(arrangeLayout(layout, { mode: "grid", columns: 12, gap: 24 }), {
      x: 24,
      width: 300,
    });
    expect(narrow.units[0]!.w).toBeGreaterThan(0);
    expect(narrow.units[0]!.x + narrow.units[0]!.w).toBeLessThanOrEqual(24 + 300);
    // Across a 1300px frame a full-width grid ends at its right edge.
    const wide = placeGrid(addUnit(layout, "grid", {}, "g"), { x: 24, width: 1300 });
    expect(wide.units[1]).toMatchObject({ x: 24, w: 1300 });
  });

  test("a new session starts with one grid per model, arranged; ids follow their order", () => {
    const start = newSessionLayout(["item", "other"]);
    expect(start.models).toEqual(["item", "other"]);
    expect(start.layout.mode).toBe("grid");
    expect(start.layout.units.map((unit) => [unit.id, unit.kind, unit.config])).toEqual([
      ["unit-1", "grid", { model_id: "item" }],
      ["unit-2", "grid", { model_id: "other" }],
    ]);
    expect(newSessionLayout(["item", "other"], ["other", "other"])).toMatchObject({
      models: ["other"],
      layout: { units: [{ id: "unit-1", config: { model_id: "other" } }] },
    });
  });

  test("a new session's grids follow the given order; named models keep it", () => {
    expect(newSessionLayout(["main", "lookup"]).models).toEqual(["main", "lookup"]);
    expect(newSessionLayout(["main", "lookup"], ["lookup", "main"]).models).toEqual([
      "main",
      "lookup",
    ]);
    // A model the app does not have goes last (the caller rejects it).
    expect(newSessionLayout(["main", "lookup"], ["nope", "lookup"]).models).toEqual([
      "lookup",
      "nope",
    ]);
  });

  test("the main model leads: most inbound links, then most columns, then definition order", () => {
    const field = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      name: id,
      type: "text",
      required: false,
      readOnly: false,
      ...extra,
    });
    const link = (id: string, target: string, type = "relation") =>
      field(id, { type, target_model: target });
    const model = (id: string, fields: ReturnType<typeof field>[]) => ({
      id,
      name: id,
      relations: [],
      fields,
    });
    // A lookup first in definition order, with more columns than the main model;
    // the main model has two links pointing at it (one its own).
    const definition = {
      formatVersion: 1,
      schemaVersion: "main-model",
      models: [
        model("zone", [field("a"), field("b"), field("c"), field("d"), field("e")]),
        model("person", [field("name"), link("zone", "zone"), link("manager", "person")]),
        model("assignment", [link("person", "person")]),
        model("tag", [field("x"), field("y")]),
        model("note", [field("x"), field("y"), field("z")]),
      ],
    } as unknown as Parameters<typeof mainModelOrder>[0];
    expect(mainModelOrder(definition).map((item) => item.id)).toEqual([
      "person",
      "zone",
      "note",
      "tag",
      "assignment",
    ]);
    // A relation list counts as a link: the main model still leads.
    const listed = {
      ...definition,
      models: definition.models.map((item) =>
        item.id === "assignment"
          ? { ...item, fields: [link("people", "person", "relation_list")] }
          : item,
      ),
    } as typeof definition;
    expect(mainModelOrder(listed).map((item) => item.id)[0]).toBe("person");
    // A retired link does not count: zone and person tie on one link each (person's
    // is its own), so the model with more columns leads.
    const retired = {
      ...definition,
      models: definition.models.map((item) =>
        item.id === "assignment"
          ? { ...item, fields: [{ ...item.fields[0]!, lifecycle: "retired" }] }
          : item,
      ),
    } as typeof definition;
    expect(mainModelOrder(retired).map((item) => item.id)).toEqual([
      "zone",
      "person",
      "note",
      "tag",
      "assignment",
    ]);
  });

  test("a resize maps back to the span the narrowed grid rendered", () => {
    const grid = { columns: 24, gap: 40 };
    const frame = { x: 0, width: 640 };
    const unit = {
      id: "u",
      kind: "chart" as const,
      config: {},
      x: 0,
      y: 0,
      w: 0,
      h: 200,
      span: 12,
    };
    const placed = placeGrid({ mode: "grid", grid, units: [unit] }, frame).units[0]!;
    // Its rendered width maps back to its own span, not a narrower one.
    expect(spanForWidth(placed.w, grid, frame.width)).toBe(12);
  });
});

describe("chart config", () => {
  test("carries header filters on any chart kind, each a column with an optional value", () => {
    const range = {
      kind: "range",
      model_id: "m",
      group_by: "level",
      value: "pay",
      low: "low",
      high: "high",
      filters: [{ field_id: "department", value: "d1" }, { field_id: "level" }],
    };
    expect(chartConfigSchema.parse(range)).toEqual(range);
    const breakdown = {
      model_id: "m",
      group_by: "team",
      metric: { fn: "count" },
      filters: [{ field_id: "active", value: true }],
    };
    expect(chartConfigSchema.parse(breakdown)).toEqual({ ...breakdown, kind: "breakdown" });
    expect(chartConfigSchema.safeParse({ ...range, filters: [{ field: "x" }] }).success).toBe(
      false,
    );
    expect(
      chartConfigSchema.safeParse({
        ...range,
        filters: Array.from({ length: 7 }, (_, n) => ({ field_id: `f${n}` })),
      }).success,
    ).toBe(false);
  });
});
