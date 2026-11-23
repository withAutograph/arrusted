// Validation hook integration test.
//
// Mounts `useEditableRowVersionGrid` in a harness, captures the schema-built
// title column's valueSetter, then invokes it with mock AG Grid
// `ValueSetterParams` to assert the validation gate:
//   - Valid commit → buffer dirties + dirtyCount increments.
//   - Invalid commit → buffer stays clean + valueSetter returns false +
//     invalid-cell class rule reports the cell as invalid.
//   - Subsequent valid commit → invalid-cell error clears.
//
// Does NOT mount AG Grid. The valueSetter contract is "AG Grid hands you
// ValueSetterParams; you return bool." Calling it directly tests the
// gate without the host.

import { useEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, render } from "@testing-library/react";

import type { ColDef, ValueSetterParams } from "ag-grid-community";

import type { KernelClient, VisibleRecord } from "@contracts";

import {
  EditableRowVersionGrid,
  useEditableRowVersionGrid,
  type EditableGridController,
  type EditableRowVersionGridSurfaceProps,
} from "../index";
import { combine, required, textLength } from "../../../engines/field-validation/index";
import { testSchemaConfig } from "./test-schema";

function makeFakeClient(): KernelClient {
  return {
    getJson: (async () => []) as KernelClient["getJson"],
    postJson: (async () => ({ id: 1, schema_revision_id: "1" })) as KernelClient["postJson"],
  };
}

function fakeRow(): VisibleRecord {
  return {
    record_id: "rec-1",
    effective_start: "2026-05-13",
    values: {
      title: { type: "text", value: "Original" },
    },
    custom_fields: [],
  };
}

function fakeSetterParams(
  data: VisibleRecord,
  newValue: unknown,
): ValueSetterParams<VisibleRecord> {
  return {
    data,
    newValue,
    oldValue: undefined,
    colDef: { colId: "title" } as ColDef<VisibleRecord>,
    column: {} as never,
    api: {} as never,
    columnApi: {} as never,
    context: {} as never,
    node: null,
  } as unknown as ValueSetterParams<VisibleRecord>;
}

type Captured = {
  controller: EditableGridController;
  surfaceProps: EditableRowVersionGridSurfaceProps;
};

function Harness(props: { onCaptured: (c: Captured) => void; rows: VisibleRecord[] }) {
  const { controller, surfaceProps } = useEditableRowVersionGrid({
    modelId: "position",
    asOf: "2026-05-13",
    scope: { appId: "hc", customerId: "demo" },
    rows: props.rows,
    client: makeFakeClient(),
    ...testSchemaConfig(),
    fieldOverrides: {
      title: {
        validate: combine(required(), textLength({ minLength: 3 })),
      },
    },
  });

  useEffect(() => {
    props.onCaptured({ controller, surfaceProps });
  });

  return null;
}

describe("validation gate inside fieldSetter", () => {
  it("invalid commit: returns false; buffer stays clean; invalid-cell class fires", () => {
    const captured: Captured[] = [];
    const row = fakeRow();
    render(<Harness rows={[row]} onCaptured={(c) => captured.push(c)} />);

    const latest = () => captured[captured.length - 1]!;
    expect(latest().controller.dirtyCount).toBe(0);

    const setter = latest().surfaceProps.columnDefs.find((c) => c.colId === "title")!
      .valueSetter as unknown as (params: ValueSetterParams<VisibleRecord>) => boolean;

    // Empty text fails `required`.
    let result = false;
    act(() => {
      result = setter(fakeSetterParams(row, ""));
    });
    expect(result).toBe(false);
    expect(latest().controller.dirtyCount).toBe(0);

    // The invalid-cell class rule should now report this cell as invalid.
    const invalidRule = (
      latest().surfaceProps.columnDefs.find((c) => c.colId === "title")!.cellClassRules as Record<
        string,
        (p: { data?: VisibleRecord; colDef: ColDef }) => boolean
      >
    )["ag-cell-invalid"];
    expect(invalidRule!({ data: row, colDef: { colId: "title" } as ColDef })).toBe(true);
  });

  it("valid commit after invalid: dirties + clears the invalid-cell error", () => {
    const captured: Captured[] = [];
    const row = fakeRow();
    render(<Harness rows={[row]} onCaptured={(c) => captured.push(c)} />);

    const latest = () => captured[captured.length - 1]!;

    const setter = latest().surfaceProps.columnDefs.find((c) => c.colId === "title")!
      .valueSetter as unknown as (params: ValueSetterParams<VisibleRecord>) => boolean;

    // First: invalid (too short).
    act(() => {
      setter(fakeSetterParams(row, "ab"));
    });
    let invalidRule = (
      latest().surfaceProps.columnDefs.find((c) => c.colId === "title")!.cellClassRules as Record<
        string,
        (p: { data?: VisibleRecord; colDef: ColDef }) => boolean
      >
    )["ag-cell-invalid"];
    expect(invalidRule!({ data: row, colDef: { colId: "title" } as ColDef })).toBe(true);
    expect(latest().controller.dirtyCount).toBe(0);

    // Now valid.
    let result = false;
    act(() => {
      result = setter(fakeSetterParams(row, "abc"));
    });
    expect(result).toBe(true);
    expect(latest().controller.dirtyCount).toBe(1);

    // Invalid rule no longer fires (error cleared).
    invalidRule = (
      latest().surfaceProps.columnDefs.find((c) => c.colId === "title")!.cellClassRules as Record<
        string,
        (p: { data?: VisibleRecord; colDef: ColDef }) => boolean
      >
    )["ag-cell-invalid"];
    expect(invalidRule!({ data: row, colDef: { colId: "title" } as ColDef })).toBe(false);
  });

  it("no-op commit (same value): does not register an error or dirty", () => {
    const captured: Captured[] = [];
    const row = fakeRow();
    render(<Harness rows={[row]} onCaptured={(c) => captured.push(c)} />);

    const latest = () => captured[captured.length - 1]!;

    const setter = latest().surfaceProps.columnDefs.find((c) => c.colId === "title")!
      .valueSetter as unknown as (params: ValueSetterParams<VisibleRecord>) => boolean;

    let result = false;
    act(() => {
      result = setter(fakeSetterParams(row, "Original"));
    });
    expect(result).toBe(false);
    expect(latest().controller.dirtyCount).toBe(0);
  });
});
