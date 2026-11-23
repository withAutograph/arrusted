import { act, renderHook } from "@testing-library/react";
import { describe, expect, test } from "vite-plus/test";
import { createSelectionStore, selectionFilter, useCanvasSelection } from "../selection";
import { definition, ids } from "./fixture";

import { bootstrapAgCharts } from "@autograph/compositions";

// As the app's session view: charts render with AG Charts registered, so a
// chart test can never pass on the "Call bootstrapAgCharts" error boundary.
bootstrapAgCharts({ allowMissingLicense: true });

const segment = (field_id: string, value: unknown) =>
  ({ kind: "segment", unit_id: "chart", model_id: "m_person", field_id, value }) as const;

describe("selection filter", () => {
  test("one chart bar on a filterable scalar field filters with eq", () => {
    expect(selectionFilter(definition, segment("f_team", "eng"))).toEqual({
      model_id: "m_person",
      field_id: "f_team",
      op: "eq",
      value: "eng",
    });
    expect(
      selectionFilter(definition, segment("f_manager", { type: "record_id", value: ids.ada })),
    ).toMatchObject({ field_id: "f_manager", value: ids.ada });
  });

  test("one graph node on its relation filters; several nodes only select", () => {
    const node = {
      kind: "nodes",
      unit_id: "graph",
      model_id: "m_person",
      field_id: "f_manager",
    } as const;
    expect(selectionFilter(definition, { ...node, record_ids: [ids.ada] })).toMatchObject({
      field_id: "f_manager",
      value: ids.ada,
    });
    expect(selectionFilter(definition, { ...node, record_ids: [ids.ada, ids.bo] })).toBeNull();
  });

  test("a graph node reached by external key filters by that key", () => {
    expect(
      selectionFilter(definition, {
        kind: "nodes",
        unit_id: "graph",
        model_id: "m_person",
        field_id: "f_manager",
        record_ids: [ids.ada],
        key: { type: "external_key", value: "P-ADA" },
      }),
    ).toMatchObject({ field_id: "f_manager", value: "P-ADA" });
  });

  test("money bins, null groups, non-scalar fields, cells and rows select without filtering", () => {
    expect(selectionFilter(definition, segment("f_pay", { from: "0", to: "100" }))).toBeNull();
    expect(selectionFilter(definition, segment("f_team", null))).toBeNull();
    expect(selectionFilter(definition, segment("f_notes", "x"))).toBeNull();
    expect(
      selectionFilter(definition, {
        kind: "cells",
        unit_id: "grid",
        model_id: "m_person",
        cells: [{ record_id: ids.ada, field_id: "f_team" }],
      }),
    ).toBeNull();
    expect(
      selectionFilter(definition, {
        kind: "rows",
        unit_id: "grid",
        model_id: "m_person",
        record_ids: [ids.ada],
      }),
    ).toBeNull();
  });

  test("the filter applies to the other units on the same model, by field name", () => {
    const store = createSelectionStore(definition);
    const { result } = renderHook(() => useCanvasSelection(store));
    act(() => result.current.select(segment("f_team", "ops")));
    expect(result.current.whereFor("grid", "m_person")).toEqual([
      { field: "team", op: "eq", value: "ops" },
    ]);
    expect(result.current.whereFor("chart", "m_person")).toEqual([]);
    expect(result.current.whereFor("grid", "m_other")).toEqual([]);
    act(() => result.current.clear());
    expect(result.current.filter).toBeNull();
  });
});
