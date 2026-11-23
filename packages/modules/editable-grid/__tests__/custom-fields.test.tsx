// Tenant custom fields in the shared grid: the module projects active
// definitions into columns and row values, stages edits and clears like any
// other cell, and saves them in the canonical wire shape.

import { describe, expect, it, vi } from "vite-plus/test";
import type { ComponentType } from "react";
import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ColDef, ValueSetterParams } from "ag-grid-community";

import type { AppliedChangeSet, KernelClient, Schema, VisibleRecord } from "@contracts";

import { useEditableRowVersionGrid } from "../index";

const SCHEMA: Schema = {
  app_id: "demo",
  customer_id: "demo",
  version: "1",
  models: [
    {
      id: "widget",
      kind: "entity",
      label: "Widget",
      extensions: { typed_custom_fields: true },
      fields: [
        { id: "name", label: "Name", type: "text", required: true },
        { id: "note", label: "Note", type: "text", required: false },
      ],
    },
    {
      id: "group",
      kind: "lookup",
      label: "Group",
      display_field_id: "name",
      fields: [{ id: "name", label: "Name", type: "text", required: true }],
    },
  ],
  custom_fields: [
    { id: "cfd_code", model_id: "widget", field_id: "cf_code", label: "Code", type: "text" },
    { id: "cfd_score", model_id: "widget", field_id: "cf_score", label: "Score", type: "number" },
    {
      id: "cfd_budget",
      model_id: "widget",
      field_id: "cf_budget",
      label: "Budget",
      type: "money_rate",
    },
    {
      id: "cfd_owner",
      model_id: "widget",
      field_id: "cf_owner",
      label: "Owner",
      type: "relation",
      target_model_id: "group",
    },
    {
      id: "cfd_old",
      model_id: "widget",
      field_id: "cf_old",
      label: "Old",
      type: "text",
      lifecycle: "retired",
      archived_at: "2026-09-01T00:00:00Z",
    },
  ],
  change_types: [
    { id: "widget_update", label: "Update", target_model: "widget", touches: [], required: [] },
  ],
};

const ROW: VisibleRecord = {
  record_id: "w-1",
  effective_start: "2026-01-01",
  effective_end: null,
  values: {
    name: { type: "text", value: "North" },
    note: { type: "text", value: "Gate" },
  },
  custom_fields: [
    { field_id: "cf_code", type: "text", value: "RD-200" },
    { field_id: "cf_score", type: "number", value: "82" },
    {
      field_id: "cf_budget",
      type: "money_rate",
      value: { amount: "1200", currency: "USD", period: "annual" },
    },
    { field_id: "cf_owner", type: "relation", value: { type: "record_id", value: "g-1" } },
    { field_id: "cf_old", type: "text", value: "retired value" },
  ],
};

function client() {
  const postJson = vi.fn(async (_path: string, _body: unknown): Promise<AppliedChangeSet> => ({
    id: 7,
    schema_revision_id: "1",
  }));
  return { postJson, getJson: vi.fn(async () => []) } as unknown as KernelClient & {
    postJson: typeof postJson;
  };
}

function mountGrid(
  kernel = client(),
  rows: VisibleRecord[] = [ROW],
  groupOptions = [{ key: { type: "record_id" as const, value: "g-1" }, label: "Platform" }],
  schema: Schema = SCHEMA,
) {
  const hook = renderHook(() =>
    useEditableRowVersionGrid({
      modelId: "widget",
      asOf: "2026-10-17",
      scope: { appId: "demo", customerId: "demo" },
      rows,
      client: kernel,
      schema,
      model: "widget",
      changeTypeId: "widget_update",
      relationOptionsByModel: {
        group: groupOptions,
      },
    }),
  );
  return { hook, kernel };
}

function setCell(
  hook: ReturnType<typeof mountGrid>["hook"],
  fieldId: string,
  newValue: unknown,
  rowKey = "w-1",
) {
  const column = hook.result.current.surfaceProps.columnDefs.find((col) => col.colId === fieldId);
  const data = hook.result.current.surfaceProps.rows.find((row) => row.record_id === rowKey);
  const setter = column?.valueSetter as (params: ValueSetterParams<VisibleRecord>) => boolean;
  let accepted = false;
  act(() => {
    accepted = setter({ data, newValue } as ValueSetterParams<VisibleRecord>);
  });
  return accepted;
}

describe("custom fields in the editable grid", () => {
  it("adds active custom fields as columns after the declared ones", () => {
    const { hook } = mountGrid();
    expect(hook.result.current.surfaceProps.columnDefs.map((col) => col.headerName)).toEqual([
      "Name",
      "Note",
      "Code",
      "Score",
      "Budget",
      "Owner",
    ]);
  });

  it("projects active custom values into row values and labels relations", () => {
    const { hook } = mountGrid();
    const row = hook.result.current.surfaceProps.rows[0] as VisibleRecord;
    expect(row.values).toEqual({
      name: { type: "text", value: "North" },
      note: { type: "text", value: "Gate" },
      cf_code: { type: "text", value: "RD-200" },
      cf_score: { type: "number", value: "82" },
      cf_budget: {
        type: "money_rate",
        value: { amount: "1200", currency: "USD", period: "annual" },
      },
      cf_owner: { type: "relation", value: { type: "record_id", value: "g-1" } },
    });
    const owner = hook.result.current.surfaceProps.columnDefs.find(
      (col) => col.colId === "cf_owner",
    );
    const format = owner?.valueFormatter as (params: { value: unknown }) => string;
    expect(format({ value: "g-1" })).toBe("Platform");
    expect(format({ value: "g-unknown" })).toBe("Unknown record");
  });

  it("saves edits as custom_fields and emptied cells as clear_custom_fields", async () => {
    const { hook, kernel } = mountGrid();
    setCell(hook, "cf_code", "RD-210");
    setCell(hook, "cf_score", null);
    expect(hook.result.current.controller.pendingChangesByRow.get("w-1")?.fieldChanges).toEqual([
      {
        fieldId: "cf_code",
        prior: { type: "text", value: "RD-200" },
        next: { type: "text", value: "RD-210" },
      },
      { fieldId: "cf_score", prior: { type: "number", value: "82" }, next: null },
    ]);

    await act(async () => {
      await hook.result.current.controller.save();
    });
    const payload = kernel.postJson.mock.calls[0]![1] as { writes: unknown[] };
    expect(payload.writes).toEqual([
      {
        model_id: "widget",
        record_key: { type: "record_id", value: "w-1" },
        effective_start: "2026-10-17",
        values: {},
        custom_fields: [{ field_id: "cf_code", type: "text", value: "RD-210" }],
        clear_custom_fields: ["cf_score"],
      },
    ]);
  });

  it("treats clearing an already-empty custom cell as no change", () => {
    const empty: VisibleRecord = { ...ROW, custom_fields: [] };
    const { hook } = mountGrid(client(), [empty]);
    setCell(hook, "cf_code", "");
    expect(hook.result.current.controller.dirtyCount).toBe(0);
    setCell(hook, "cf_code", "New");
    setCell(hook, "cf_code", "");
    expect(hook.result.current.controller.dirtyCount).toBe(0);
  });

  it("clears optional declared fields through clear_fields", async () => {
    const { hook, kernel } = mountGrid();
    setCell(hook, "note", "");
    await act(async () => {
      await hook.result.current.controller.save();
    });
    const payload = kernel.postJson.mock.calls[0]![1] as { writes: Array<Record<string, unknown>> };
    expect(payload.writes[0]).toMatchObject({ values: {}, clear_fields: ["note"] });
    expect(payload.writes[0]).not.toHaveProperty("clear_custom_fields");
  });

  it("treats clearing an already-empty required cell as no change", () => {
    // `name` uses the primitive setter; `budget` the FieldValue setter.
    const schema: Schema = {
      ...SCHEMA,
      models: SCHEMA.models.map((model) =>
        model.id === "widget"
          ? {
              ...model,
              fields: [
                ...model.fields,
                { id: "budget", label: "Budget", type: "money_rate", required: true },
              ],
            }
          : model,
      ),
    };
    const unnamed: VisibleRecord = { ...ROW, values: { note: ROW.values.note! } };
    const { hook } = mountGrid(client(), [unnamed], undefined, schema);
    setCell(hook, "name", null);
    setCell(hook, "budget", null);
    expect(hook.result.current.controller.dirtyCount).toBe(0);
    expect(hook.result.current.controller.invalidCellCount).toBe(0);
  });

  it("does not stage a bulk clear of an already-empty cell", () => {
    const empty: VisibleRecord = { ...ROW, values: { name: ROW.values.name! }, custom_fields: [] };
    const { hook } = mountGrid(client(), [empty]);
    setCell(hook, "note", "Draft");
    expect(hook.result.current.controller.dirtyCount).toBe(1);
    act(() => {
      expect(
        hook.result.current.controller.stageBulkUpdate({
          rows: [{ rowKey: "w-1" }],
          values: { note: null, cf_code: null },
          bulkGroupId: "bulk",
        }),
      ).toEqual({ ok: true });
    });
    expect(hook.result.current.controller.dirtyCount).toBe(0);
  });

  it("flags an emptied required cell instead of staging it", () => {
    const { hook } = mountGrid();
    setCell(hook, "name", null);
    expect(hook.result.current.controller.dirtyCount).toBe(0);
    expect(hook.result.current.controller.invalidCellCount).toBe(1);
  });

  it("refuses a required clear on a staged new row and clears an optional one", () => {
    const { hook } = mountGrid();
    let tempRowKey = "";
    act(() => {
      tempRowKey = hook.result.current.controller.stageNewRecord({
        name: { type: "text", value: "South" },
        note: { type: "text", value: "Dock" },
        cf_code: { type: "text", value: "RD-300" },
      }).tempRowKey;
    });
    expect(hook.result.current.controller.dirtyCount).toBe(3);

    expect(setCell(hook, "name", null, tempRowKey)).toBe(false);
    expect(hook.result.current.controller.invalidCellCount).toBe(1);
    const draft = () =>
      hook.result.current.surfaceProps.rows.find((row) => row.record_id === tempRowKey);
    expect(draft()?.values.name).toEqual({ type: "text", value: "South" });

    setCell(hook, "note", null, tempRowKey);
    expect(hook.result.current.controller.dirtyCount).toBe(2);
    expect(draft()?.values.note).toBeUndefined();
    expect(draft()?.values.name).toEqual({ type: "text", value: "South" });
  });

  it("bulk clears on a staged new row refuse required fields and drop optional ones", () => {
    const { hook } = mountGrid();
    let tempRowKey = "";
    act(() => {
      tempRowKey = hook.result.current.controller.stageNewRecord({
        name: { type: "text", value: "South" },
        note: { type: "text", value: "Dock" },
      }).tempRowKey;
    });
    let refused: ReturnType<typeof hook.result.current.controller.stageBulkUpdate> | undefined;
    act(() => {
      refused = hook.result.current.controller.stageBulkUpdate({
        rows: [{ rowKey: tempRowKey }],
        values: { name: null },
        bulkGroupId: "bulk",
      });
    });
    expect(refused?.ok).toBe(false);

    act(() => {
      hook.result.current.controller.stageBulkUpdate({
        rows: [{ rowKey: tempRowKey }],
        values: { note: null },
        bulkGroupId: "bulk",
      });
    });
    const draft = hook.result.current.surfaceProps.rows.find((row) => row.record_id === tempRowKey);
    expect(draft?.values.note).toBeUndefined();
    expect(draft?.values.name).toEqual({ type: "text", value: "South" });
  });

  // Mounts a column's real cell editor the way AG Grid does: `setDataValue`
  // runs the column's valueSetter, which stages into the grid's buffer.
  function mountEditor(hook: ReturnType<typeof mountGrid>["hook"], fieldId: string) {
    const column = hook.result.current.surfaceProps.columnDefs.find(
      (col) => col.colId === fieldId,
    ) as ColDef<VisibleRecord>;
    const data = hook.result.current.surfaceProps.rows[0] as VisibleRecord;
    const getter = column.valueGetter as (params: { data: VisibleRecord }) => unknown;
    const setter = column.valueSetter as (params: ValueSetterParams<VisibleRecord>) => boolean;
    const Editor = column.cellEditor as ComponentType<Record<string, unknown>>;
    render(
      <Editor
        {...(column.cellEditorParams as Record<string, unknown>)}
        value={getter({ data })}
        data={data}
        colDef={column}
        column={{ getColId: () => fieldId }}
        node={{
          setDataValue: (_column: unknown, newValue: unknown) =>
            act(() => {
              setter({ data, newValue } as ValueSetterParams<VisibleRecord>);
            }),
        }}
        api={{ stopEditing: () => undefined }}
      />,
    );
  }

  async function savedWrite(
    hook: ReturnType<typeof mountGrid>["hook"],
    kernel: ReturnType<typeof client>,
  ) {
    await act(async () => {
      await hook.result.current.controller.save();
    });
    const payload = kernel.postJson.mock.calls[0]![1] as {
      writes: Array<Record<string, unknown>>;
    };
    return payload.writes[0];
  }

  it("clears a custom number when its editor is emptied", async () => {
    const { hook, kernel } = mountGrid();
    mountEditor(hook, "cf_score");
    const input = screen.getByRole("textbox", { name: "Score" });
    await userEvent.clear(input);
    await userEvent.keyboard("{Enter}");
    expect(await savedWrite(hook, kernel)).toMatchObject({ clear_custom_fields: ["cf_score"] });
  });

  it("labels and selects links by their full key, record id or external key", async () => {
    const byExternalKey: VisibleRecord = {
      ...ROW,
      custom_fields: [
        {
          field_id: "cf_owner",
          type: "relation",
          value: { type: "external_key", value: "g-1" },
        },
      ],
    };
    const options = [
      {
        key: { type: "record_id" as const, value: "g-2" },
        label: "Field operations",
        // Its external key is the other record's id: no collision.
        aliasKeys: [{ type: "external_key" as const, value: "g-1" }],
      },
      { key: { type: "record_id" as const, value: "g-1" }, label: "Platform" },
    ];
    const { hook, kernel } = mountGrid(client(), [byExternalKey], options);
    const column = hook.result.current.surfaceProps.columnDefs.find(
      (col) => col.colId === "cf_owner",
    ) as ColDef<VisibleRecord>;
    const row = hook.result.current.surfaceProps.rows[0] as VisibleRecord;
    const format = column.valueFormatter as (p: { value: unknown; data: VisibleRecord }) => string;
    expect(format({ value: "g-1", data: row })).toBe("Field operations");
    const byRecordId: VisibleRecord = {
      ...ROW,
      values: {
        ...ROW.values,
        cf_owner: { type: "relation", value: { type: "record_id", value: "g-1" } },
      },
    };
    expect(format({ value: "g-1", data: byRecordId })).toBe("Platform");
    // A bare value (the filter list) naming both records is ambiguous.
    expect(format({ value: "g-1", data: ROW })).toBe("Unknown record");

    // The picker opens on the option the external key names.
    mountEditor(hook, "cf_owner");
    await userEvent.click(screen.getByRole("combobox"));
    expect(
      await screen.findByRole("option", { name: "Field operations", selected: true }),
    ).toBeInTheDocument();

    // A pasted value naming one record by id and another by external key is
    // ambiguous and rejected; an unambiguous one resolves to its option's key.
    expect(setCell(hook, "cf_owner", "g-1")).toBe(false);
    setCell(hook, "cf_owner", "g-2");
    expect(await savedWrite(hook, kernel)).toMatchObject({
      custom_fields: [
        { field_id: "cf_owner", type: "relation", value: { type: "record_id", value: "g-2" } },
      ],
    });
  });

  it("clears a saved custom link even when its target list is empty", async () => {
    const empty: VisibleRecord = { ...ROW, record_id: "w-2", custom_fields: [] };
    const { hook, kernel } = mountGrid(client(), [ROW, empty], []);
    const column = hook.result.current.surfaceProps.columnDefs.find(
      (col) => col.colId === "cf_owner",
    ) as ColDef<VisibleRecord>;
    const editable = column.editable as (params: { data?: VisibleRecord }) => boolean;
    const rows = hook.result.current.surfaceProps.rows as VisibleRecord[];
    expect(editable({ data: rows[0] })).toBe(true);
    // Nothing to pick and nothing to clear: the empty cell stays closed.
    expect(editable({ data: rows[1] })).toBe(false);

    mountEditor(hook, "cf_owner");
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(await savedWrite(hook, kernel)).toMatchObject({ clear_custom_fields: ["cf_owner"] });
  });

  it("clears a custom money value when its amount is emptied", async () => {
    const { hook, kernel } = mountGrid();
    mountEditor(hook, "cf_budget");
    const input = screen.getByRole("textbox", { name: "Budget amount" });
    await userEvent.clear(input);
    await userEvent.keyboard("{Enter}");
    expect(await savedWrite(hook, kernel)).toMatchObject({ clear_custom_fields: ["cf_budget"] });
  });

  it("refuses to clear required fields in bulk", () => {
    const { hook } = mountGrid();
    let result: ReturnType<typeof hook.result.current.controller.stageBulkUpdate> | undefined;
    act(() => {
      result = hook.result.current.controller.stageBulkUpdate({
        rows: [{ rowKey: "w-1" }],
        values: { name: null, cf_code: null },
        bulkGroupId: "bulk",
      });
    });
    expect(result).toEqual({
      ok: false,
      failures: [{ rowKey: "w-1", fieldId: "name", message: "This field can't be cleared." }],
    });
    expect(hook.result.current.controller.dirtyCount).toBe(0);
  });
});
