import { describe, expect, it, vi } from "vite-plus/test";

import type { FieldValue, Schema, VisibleRecord } from "@contracts";
import { required, type FieldValidator } from "@engines/field-validation/index";

import {
  buildSchemaColumnDefs,
  isEditableGridField,
  relationLabelFormatter,
  type GridColumnContext,
} from "../index";
import {
  DatePickerCellEditorAdapter,
  DatetimeCellEditorAdapter,
  MoneyRateCellEditorAdapter,
  NumberCellEditorAdapter,
  PersonPickerCellEditorAdapter,
  RelationPickerCellEditorAdapter,
  TextCellEditorAdapter,
  TextListCellEditorAdapter,
  ValueSelectCellEditorAdapter,
} from "../cell-editors";

function makeCtx(): GridColumnContext {
  const dirtyCellClassRules = { "ag-cell-dirty": () => true };
  const invalidCellClassRules = { "ag-cell-invalid": () => false };
  return {
    asOf: "2026-05-16",
    mode: "edit",
    fieldGetter: vi.fn((fieldId) => `getter:${fieldId}` as never),
    fieldSetter: vi.fn((fieldId) => `setter:${fieldId}` as never),
    fieldSetterFromValue: vi.fn((fieldId) => `setterFromValue:${fieldId}` as never),
    fieldValueGetter: vi.fn((fieldId) => `fieldValueGetter:${fieldId}` as never),
    dirtyCellClassRules,
    invalidCellClassRules,
    diffCellRenderer: vi.fn(
      (opts: {
        formatValue: (value: unknown, fieldValue: FieldValue | null | undefined) => string;
      }) => ({ kind: "diff", opts }) as never,
    ),
  };
}

type FieldSetterCall = [
  fieldId: string,
  fieldType: FieldValue["type"],
  options?: { validate?: FieldValidator },
];

function fieldSetterCalls(ctx: GridColumnContext): FieldSetterCall[] {
  return (ctx.fieldSetter as unknown as { mock: { calls: FieldSetterCall[] } }).mock.calls;
}

const schema: Schema = {
  app_id: "hc",
  customer_id: "demo",
  version: "v1",
  change_types: [],
  models: [
    {
      id: "position",
      kind: "entity",
      label: "Position",
      fields: [
        { id: "title", label: "Title", type: "text", required: false },
        { id: "base_salary", label: "Base Salary", type: "money_rate", required: false },
        { id: "start_date", label: "Start Date", type: "date", required: false },
      ],
    },
  ],
};

function schemaWithFields(fields: Schema["models"][number]["fields"]): Schema {
  return {
    app_id: "hc",
    customer_id: "demo",
    version: "v1",
    change_types: [],
    models: [{ id: "position", kind: "entity", label: "Position", fields }],
  };
}

describe("schema-driven editable-grid columns", () => {
  it("wires editors, validators, diff rendering, and edit-state classes from schema plus overrides", () => {
    const ctx = makeCtx();
    const validateTitle = required("Title is required");

    const columns = buildSchemaColumnDefs(ctx, schema, "position", {
      fieldOverrides: {
        title: {
          validate: validateTitle,
          flex: 2,
          minWidth: 220,
        },
        base_salary: {
          validate: required("Salary is required"),
          formatValue: (_value, fv) =>
            fv && fv.type === "money_rate" ? `${fv.value.amount}/${fv.value.period}` : "",
        },
      },
    });

    const title = columns.find((c) => c.colId === "title");
    expect(title).toBeTruthy();
    expect(title?.cellEditor).toBeDefined();
    expect(title?.valueGetter).toBe("getter:title");
    expect(title?.valueSetter).toBe("setter:title");
    expect(title?.cellClassRules).toHaveProperty("ag-cell-dirty");
    expect(title?.cellClassRules).toHaveProperty("ag-cell-invalid");
    expect(title?.cellRenderer).toMatchObject({ kind: "diff" });
    expect(title?.flex).toBe(2);
    expect(title?.minWidth).toBe(220);
    expect(ctx.fieldSetter).toHaveBeenCalledWith("title", "text", {
      validate: validateTitle,
    });

    const salary = columns.find((c) => c.colId === "base_salary");
    expect(salary?.valueGetter).toBe("fieldValueGetter:base_salary");
    expect(salary?.valueSetter).toBe("setterFromValue:base_salary");
    expect(ctx.fieldSetterFromValue).toHaveBeenCalledWith("base_salary", {
      validate: expect.any(Function),
    });
    const salaryFormatter = salary?.valueFormatter;
    expect(typeof salaryFormatter).toBe("function");
    expect(
      (salaryFormatter as (params: { data?: VisibleRecord }) => string)({
        data: {
          record_id: "pos-1",
          effective_start: "2026-05-16",
          custom_fields: [],
          values: {
            base_salary: {
              type: "money_rate",
              value: { amount: "155000", currency: "USD", period: "annual" },
            },
          },
        } as unknown as VisibleRecord,
      }),
    ).toBe("155000/annual");

    const startDate = columns.find((c) => c.colId === "start_date");
    expect(startDate?.valueGetter).toBe("getter:start_date");
    expect(startDate?.valueSetter).toBe("setter:start_date");
    expect(ctx.fieldSetter).toHaveBeenCalledWith("start_date", "date", {
      validate: undefined,
    });
  });

  it("renders newly added schema fields without app override changes", () => {
    const ctx = makeCtx();
    const columns = buildSchemaColumnDefs(
      ctx,
      {
        app_id: "hc",
        customer_id: "demo",
        version: "v1",
        change_types: [],
        models: [
          {
            id: "position",
            kind: "entity",
            label: "Position",
            fields: [
              ...schema.models[0]!.fields,
              { id: "custom_x", label: "Custom X", type: "text", required: false },
            ],
          },
        ],
      },
      "position",
      {
        fieldOverrides: {
          title: { validate: required("Title is required") },
        },
      },
    );

    const custom = columns.find((c) => c.colId === "custom_x");
    expect(custom).toBeTruthy();
    expect(custom?.headerName).toBe("Custom X");
    expect(custom?.valueGetter).toBe("getter:custom_x");
    expect(custom?.valueSetter).toBe("setter:custom_x");
    expect(custom?.cellRenderer).toMatchObject({ kind: "diff" });
    expect(ctx.fieldSetter).toHaveBeenCalledWith("custom_x", "text", {
      validate: undefined,
    });
  });

  it("routes fixed-vocabulary text fields through the value-select editor", () => {
    const ctx = makeCtx();
    const validateStatus = required("Status is required");
    const valueOptions = ["Open", "Closed"] as const;
    const columns = buildSchemaColumnDefs(
      ctx,
      schemaWithFields([{ id: "status", label: "Status", type: "text", required: false }]),
      "position",
      {
        fieldOverrides: {
          status: {
            validate: validateStatus,
            valueOptions,
            width: 160,
          },
        },
      },
    );

    const status = columns[0]!;
    expect(status.cellEditor).toBe(ValueSelectCellEditorAdapter);
    expect(status.cellEditorPopup).toBe(true);
    expect(status.cellEditorPopupPosition).toBe("under");
    expect(status.valueGetter).toBe("getter:status");
    expect(status.valueSetter).toBe("setter:status");
    expect(status.cellClassRules).toHaveProperty("ag-cell-dirty");
    expect(status.cellClassRules).toHaveProperty("ag-cell-invalid");
    expect(status.cellEditorParams).toEqual({
      fieldType: { type: "text", label: "Status", valueOptions: ["Open", "Closed"] },
    });
    expect(status.width).toBe(160);
    expect(ctx.fieldSetter).toHaveBeenCalledWith("status", "text", {
      validate: validateStatus,
    });

    expect(status.cellEditorParams.fieldType.valueOptions).not.toBe(valueOptions);
  });

  it("routes explicitly empty text vocabularies through the value-select editor", () => {
    const ctx = makeCtx();
    const columns = buildSchemaColumnDefs(
      ctx,
      schemaWithFields([{ id: "status", label: "Status", type: "text", required: false }]),
      "position",
      { fieldOverrides: { status: { valueOptions: [] } } },
    );

    const status = columns[0]!;
    expect(status.cellEditor).toBe(ValueSelectCellEditorAdapter);
    expect(status.cellEditorParams).toEqual({
      fieldType: { type: "text", label: "Status", valueOptions: [] },
    });
    expect(status.valueSetter).toBe("setter:status");
  });

  it("maps every generated FieldType to an editor or read-only gating", () => {
    const ctx = makeCtx();
    const columns = buildSchemaColumnDefs(
      ctx,
      schemaWithFields([
        { id: "text_f", label: "Text", type: "text", required: false },
        { id: "iso_country_f", label: "ISO Country", type: "iso_country", required: false },
        { id: "iso_currency_f", label: "ISO Currency", type: "iso_currency", required: false },
        { id: "number_f", label: "Number", type: "number", required: false },
        { id: "bool_f", label: "Bool", type: "bool", required: false },
        { id: "date_f", label: "Date", type: "date", required: false },
        { id: "datetime_f", label: "Datetime", type: "datetime", required: false },
        {
          id: "relation_f",
          label: "Relation",
          type: "relation",
          required: false,
          target_model: "department",
        },
        { id: "text_list_f", label: "Text List", type: "text_list", required: false },
        {
          id: "enum_f",
          label: "Enum",
          type: "enum",
          required: false,
          option_set: [
            { id: "active", label: "Active", aliases: ["current"] },
            { id: "paused", label: "Paused", aliases: [] },
          ],
        },
        {
          id: "known_aliases_f",
          label: "Known Aliases",
          type: "known_aliases",
          required: false,
        },
        { id: "json_f", label: "Json", type: "json", required: false },
        { id: "money_f", label: "Money", type: "money_rate", required: false },
      ]),
      "position",
    );
    const byId = new Map(columns.map((col) => [col.colId, col]));

    expect(byId.get("text_f")?.cellEditor).toBe(TextCellEditorAdapter);
    expect(byId.get("iso_country_f")?.cellEditor).toBe(TextCellEditorAdapter);
    expect(byId.get("iso_currency_f")?.cellEditor).toBe(TextCellEditorAdapter);
    expect(byId.get("number_f")?.cellEditor).toBe(NumberCellEditorAdapter);
    expect(byId.get("bool_f")?.cellEditor).toBe("agCheckboxCellEditor");
    expect(byId.get("date_f")?.cellEditor).toBe(DatePickerCellEditorAdapter);
    expect(byId.get("relation_f")?.cellEditor).toBe(RelationPickerCellEditorAdapter);
    // No options to pick: an optional link opens only to clear a saved value.
    expect(typeof byId.get("relation_f")?.editable).toBe("function");
    expect(byId.get("money_f")?.cellEditor).toBe(MoneyRateCellEditorAdapter);
    expect(ctx.fieldSetter).toHaveBeenCalledWith("iso_country_f", "text", {});
    expect(ctx.fieldSetter).toHaveBeenCalledWith("iso_currency_f", "text", {});

    const enumCol = byId.get("enum_f");
    expect(enumCol?.editable).toBe(true);
    expect(enumCol?.cellEditor).toBe(ValueSelectCellEditorAdapter);
    expect(enumCol?.valueSetter).toBe("setter:enum_f");
    expect(enumCol?.cellEditorParams).toEqual({
      fieldType: {
        type: "enum",
        label: "Enum",
        valueOptions: [
          { value: "active", label: "Active" },
          { value: "paused", label: "Paused" },
        ],
      },
      clearable: true,
    });
    expect(ctx.fieldSetter).toHaveBeenCalledWith("enum_f", "enum", {
      validate: expect.any(Function),
    });

    expect(byId.get("datetime_f")?.cellEditor).toBe(DatetimeCellEditorAdapter);
    expect(byId.get("text_list_f")?.cellEditor).toBe(TextListCellEditorAdapter);
    for (const id of ["datetime_f", "text_list_f"]) {
      expect(byId.get(id)?.editable).toBe(true);
      expect(byId.get(id)?.valueGetter).toBe(`getter:${id}`);
      expect(ctx.fieldSetterFromValue).toHaveBeenCalledWith(id, expect.anything());
    }

    for (const id of ["known_aliases_f", "json_f"]) {
      const col = byId.get(id);
      expect(col?.editable).toBe(false);
      expect(col?.cellEditor).toBeUndefined();
      expect(col?.valueSetter).toBeUndefined();
      expect(col?.valueGetter).toBe(`getter:${id}`);
    }
    const enumFormatter = byId.get("enum_f")?.valueFormatter;
    expect(typeof enumFormatter).toBe("function");
    expect(
      (enumFormatter as (params: { value?: unknown; data?: VisibleRecord }) => string)({
        value: "paused",
      }),
    ).toBe("Paused");
    expect(
      (enumFormatter as (params: { value?: unknown; data?: VisibleRecord }) => string)({
        data: {
          record_id: "pos-1",
          effective_start: "2026-05-16",
          values: { enum_f: { type: "enum", value: "active" } },
        } as unknown as VisibleRecord,
      }),
    ).toBe("Active");
    expect(
      (enumFormatter as (params: { value?: unknown; data?: VisibleRecord }) => string)({
        value: "unknown",
      }),
    ).toBe("unknown");

    const enumSetterCall = fieldSetterCalls(ctx).find(([fieldId]) => fieldId === "enum_f");
    const validateEnum = enumSetterCall?.[2]?.validate;
    expect(validateEnum).toBeDefined();
    expect(validateEnum?.({ type: "enum", value: "active" }, { fieldId: "enum_f" }).ok).toBe(true);
    expect(validateEnum?.({ type: "enum", value: "retired" }, { fieldId: "enum_f" })).toEqual({
      ok: false,
      message: "Select a valid Enum",
    });
    expect(validateEnum?.(null, { fieldId: "enum_f" }).ok).toBe(true);
  });

  it("uses the same repairability boundary advertised to import previews", () => {
    expect(isEditableGridField({ type: "enum" })).toBe(false);
    expect(
      isEditableGridField({
        type: "enum",
        option_set: [{ id: "active", label: "Active" }],
      }),
    ).toBe(true);
    expect(isEditableGridField({ type: "datetime" })).toBe(true);
    expect(isEditableGridField({ type: "text_list" })).toBe(true);
    expect(isEditableGridField({ type: "json" })).toBe(false);
    expect(isEditableGridField({ type: "relation" })).toBe(false);
    expect(
      isEditableGridField(
        { type: "relation" },
        { relationOptions: [{ key: { type: "record_id", value: "dept-1" }, label: "Finance" }] },
      ),
    ).toBe(true);
  });

  it("renders complete money-rate values without an app formatter", () => {
    const ctx = makeCtx();
    const columns = buildSchemaColumnDefs(ctx, schema, "position");
    const salaryFormatter = columns.find(
      (column) => column.colId === "base_salary",
    )?.valueFormatter;
    expect(
      (salaryFormatter as (params: { data?: VisibleRecord }) => string)({
        data: {
          record_id: "pos-1",
          effective_start: "2026-05-16",
          custom_fields: [],
          values: {
            base_salary: {
              type: "money_rate",
              value: { amount: "155000", currency: "USD", period: "annual" },
            },
          },
        } as VisibleRecord,
      }),
    ).toBe("155,000 USD/yr");
  });

  it("rejects retired enum options in the setter while still labelling them", () => {
    const ctx = makeCtx();
    const columns = buildSchemaColumnDefs(
      ctx,
      schemaWithFields([
        {
          id: "enum_f",
          label: "Enum",
          type: "enum",
          required: false,
          option_set: [
            { id: "active", label: "Active", aliases: [] },
            { id: "old", label: "Old", aliases: [], lifecycle: "retired" },
          ],
        },
      ]),
      "position",
    );
    const validateEnum = fieldSetterCalls(ctx)[0]?.[2]?.validate;
    expect(validateEnum?.({ type: "enum", value: "active" }, { fieldId: "enum_f" }).ok).toBe(true);
    expect(validateEnum?.({ type: "enum", value: "old" }, { fieldId: "enum_f" })).toEqual({
      ok: false,
      message: "Select a valid Enum",
    });
    const formatter = columns[0]?.valueFormatter as (params: { value?: unknown }) => string;
    expect(formatter({ value: "old" })).toBe("Old");
  });

  it("composes enum option-set validation with app overrides", () => {
    const ctx = makeCtx();
    const validateOverride = vi.fn(() => ({ ok: false as const, message: "Override failed" }));
    buildSchemaColumnDefs(
      ctx,
      schemaWithFields([
        {
          id: "enum_f",
          label: "Enum",
          type: "enum",
          required: false,
          option_set: [
            { id: "active", label: "Active", aliases: [] },
            { id: "paused", label: "Paused", aliases: [] },
          ],
        },
      ]),
      "position",
      { fieldOverrides: { enum_f: { validate: validateOverride } } },
    );

    const enumSetterCall = fieldSetterCalls(ctx)[0];
    const validateEnum = enumSetterCall?.[2]?.validate;
    expect(validateEnum).toBeDefined();

    expect(validateEnum?.({ type: "enum", value: "retired" }, { fieldId: "enum_f" })).toEqual({
      ok: false,
      message: "Select a valid Enum",
    });
    expect(validateOverride).not.toHaveBeenCalled();

    expect(validateEnum?.({ type: "enum", value: "active" }, { fieldId: "enum_f" })).toEqual({
      ok: false,
      message: "Override failed",
    });
    expect(validateOverride).toHaveBeenCalledWith(
      { type: "enum", value: "active" },
      { fieldId: "enum_f" },
    );
  });

  it("dispatches all relation targets to the generic picker by default", () => {
    const ctx = makeCtx();
    const columns = buildSchemaColumnDefs(
      ctx,
      schemaWithFields([
        {
          id: "manager",
          label: "Manager",
          type: "relation",
          required: false,
          target_model: "employee",
        },
        {
          id: "department",
          label: "Department",
          type: "relation",
          required: false,
          target_model: "department",
        },
      ]),
      "position",
    );

    expect(columns.find((c) => c.colId === "manager")?.cellEditor).toBe(
      RelationPickerCellEditorAdapter,
    );
    expect(columns.find((c) => c.colId === "department")?.cellEditor).toBe(
      RelationPickerCellEditorAdapter,
    );
  });

  it("keeps retired relation targets out of the picker while still labelling them", () => {
    const ctx = makeCtx();
    const columns = buildSchemaColumnDefs(
      ctx,
      schemaWithFields([
        {
          id: "department",
          label: "Department",
          type: "relation",
          required: false,
          target_model: "department",
        },
      ]),
      "position",
      {
        relationOptionsByModel: {
          department: [
            { key: { type: "record_id", value: "dep-1" }, label: "Engineering" },
            { key: { type: "record_id", value: "dep-old" }, label: "Legacy", retired: true },
          ],
        },
      },
    );
    const column = columns.find((c) => c.colId === "department");
    const params = column?.cellEditorParams as {
      fieldType: { relationOptions: Array<{ label: string }> };
    };
    expect(params.fieldType.relationOptions.map((option) => option.label)).toEqual(["Engineering"]);
    const format = column?.valueFormatter as (params: {
      value?: unknown;
      data?: VisibleRecord;
    }) => string;
    expect(format({ value: "dep-old" })).toBe("Legacy");
  });

  it("gives relation pickers their target's search and reports picks by target", () => {
    const ctx = makeCtx();
    const search = vi.fn(async () => ({ options: [], truncated: false }));
    const onRelationOptionPicked = vi.fn();
    const columns = buildSchemaColumnDefs(
      ctx,
      schemaWithFields([
        {
          id: "department",
          label: "Department",
          type: "relation",
          required: true,
          target_model: "department",
        },
      ]),
      "position",
      {
        relationOptionsByModel: {
          department: [{ key: { type: "record_id", value: "dep-1" }, label: "Engineering" }],
        },
        relationSearchByModel: { department: search },
        onRelationOptionPicked,
      },
    );
    const column = columns.find((c) => c.colId === "department");
    const params = column?.cellEditorParams as {
      fieldType: {
        searchRelationOptions: unknown;
        onRelationOptionPicked: (option: unknown) => void;
      };
    };
    const format = column?.valueFormatter as (params: { value?: unknown }) => string;
    // Values are labelled from the options only; a pick the app has not added
    // to them reads as unknown.
    expect(format({ value: "dep-1" })).toBe("Engineering");
    expect(format({ value: "dep-new" })).toBe("Unknown record");
    expect(params.fieldType.searchRelationOptions).toBe(search);
    const picked = { key: { type: "record_id", value: "dep-new" }, label: "Design" };
    params.fieldType.onRelationOptionPicked(picked);
    expect(onRelationOptionPicked).toHaveBeenCalledWith("department", picked);
    // Required links with nothing loaded are still editable: the picker searches.
    expect(column?.editable).toBe(true);
  });

  it("lets apps opt person-like relations into the person picker without hardcoded model names", () => {
    const ctx = makeCtx();
    const columns = buildSchemaColumnDefs(
      ctx,
      schemaWithFields([
        {
          id: "assignee",
          label: "Assignee",
          type: "relation",
          required: false,
          target_model: "team_member",
        },
      ]),
      "position",
      { fieldOverrides: { assignee: { editor: "person-picker" } } },
    );

    expect(columns.find((c) => c.colId === "assignee")?.cellEditor).toBe(
      PersonPickerCellEditorAdapter,
    );
  });

  it("rejects non-relation editor overrides on relation fields", () => {
    const ctx = makeCtx();

    expect(() =>
      buildSchemaColumnDefs(
        ctx,
        schemaWithFields([
          {
            id: "department",
            label: "Department",
            type: "relation",
            required: false,
            target_model: "department",
          },
        ]),
        "position",
        { fieldOverrides: { department: { editor: "text-cell-editor" } } },
      ),
    ).toThrow(/relation field "department" cannot use non-relation editor "text-cell-editor"/);
  });

  it("wires relation filter dropdown formatting through the display formatter", () => {
    const ctx = makeCtx();
    const columns = buildSchemaColumnDefs(
      ctx,
      schemaWithFields([
        {
          id: "department",
          label: "Department",
          type: "relation",
          required: false,
          target_model: "department",
        },
      ]),
      "position",
      {
        fieldOverrides: {
          department: {
            formatValue: (value) => (value === "dep-1" ? "Engineering" : String(value ?? "")),
          },
        },
      },
    );

    const formatter = columns[0]!.filterParams?.valueFormatter as (params: {
      value?: unknown;
    }) => string;
    expect(formatter({ value: "dep-1" })).toBe("Engineering");
  });

  it("honors hidden fields and explicit field ordering with schema-order tail", () => {
    const ctx = makeCtx();
    const columns = buildSchemaColumnDefs(
      ctx,
      schemaWithFields([
        { id: "a", label: "A", type: "text", required: false },
        { id: "b", label: "B", type: "text", required: false },
        { id: "c", label: "C", type: "text", required: false },
        { id: "d", label: "D", type: "text", required: false },
      ]),
      "position",
      { fieldOrder: ["c", "a"], hidden: ["b"] },
    );

    expect(columns.map((col) => col.colId)).toEqual(["c", "a", "d"]);
  });

  it("defaults unknown tweak-mode fields to non-editable until explicitly opted in", () => {
    const ctx = { ...makeCtx(), mode: "tweak" as const };
    const columns = buildSchemaColumnDefs(
      ctx,
      schemaWithFields([
        { id: "title", label: "Title", type: "text", required: false },
        { id: "is_open", label: "Open", type: "bool", required: false },
      ]),
      "position",
      { fieldOverrides: { is_open: { editable: true } } },
    );

    expect(columns.find((c) => c.colId === "title")?.editable).toBe(false);
    expect(columns.find((c) => c.colId === "is_open")?.editable).toBe(true);
  });

  it("wires bool fields through AG Grid checkbox plus the bool value bridge", () => {
    const ctx = makeCtx();
    const columns = buildSchemaColumnDefs(
      ctx,
      schemaWithFields([{ id: "is_open", label: "Open", type: "bool", required: false }]),
      "position",
    );

    const col = columns[0]!;
    expect(col.cellEditor).toBe("agCheckboxCellEditor");
    expect(col.valueGetter).toBe("getter:is_open");
    expect(col.valueSetter).toBe("setter:is_open");
    expect(ctx.fieldSetter).toHaveBeenCalledWith("is_open", "bool", {
      validate: undefined,
    });
  });

  it("shows date-times in UTC without an app formatter", () => {
    const ctx = makeCtx();
    const columns = buildSchemaColumnDefs(
      ctx,
      schemaWithFields([{ id: "seen", label: "Seen", type: "datetime", required: false }]),
      "position",
    );
    const { opts } = columns[0]?.cellRenderer as unknown as {
      opts: { formatValue: (value: unknown, fieldValue: FieldValue | null) => string };
    };
    expect(opts.formatValue(undefined, { type: "datetime", value: "2026-11-02T14:30:05Z" })).toBe(
      "Nov 2, 2026, 14:30 UTC",
    );
    expect(opts.formatValue("2026-11-02T23:30:00-02:00", null)).toBe("Nov 3, 2026, 01:30 UTC");
    expect(opts.formatValue(null, null)).toBe("");
  });

  it("opens text_list fields in the list editor with the row's live value", () => {
    const ctx = makeCtx();
    const columns = buildSchemaColumnDefs(
      ctx,
      schemaWithFields([{ id: "tags", label: "Tags", type: "text_list", required: true }]),
      "position",
    );

    expect(columns[0]?.editable).toBe(true);
    expect(columns[0]?.cellEditor).toBe(TextListCellEditorAdapter);
    expect(columns[0]?.cellEditorPopup).toBe(true);
    expect(columns[0]?.cellEditorParams).toMatchObject({
      fieldType: { type: "text_list", label: "Tags", required: true },
      clearable: false,
      currentValue: expect.any(Function),
    });
  });

  it("returns no columns while schema is loading", () => {
    const ctx = makeCtx();
    expect(buildSchemaColumnDefs(ctx, null, "position")).toEqual([]);
  });

  it("returns no columns when the model is absent from the schema", () => {
    const ctx = makeCtx();
    expect(buildSchemaColumnDefs(ctx, schema, "missing")).toEqual([]);
  });
});

describe("relationLabelFormatter", () => {
  const format = relationLabelFormatter(
    [
      {
        key: { type: "record_id", value: "r-1" },
        label: "Operations",
        aliasKeys: [{ type: "external_key", value: "OPS" }],
      },
    ],
    "Unknown team",
  );

  it("labels a stored key by its type and never shows an unknown key", () => {
    expect(format("", { type: "relation", value: { type: "external_key", value: "OPS" } })).toBe(
      "Operations",
    );
    expect(format("", { type: "relation", value: { type: "record_id", value: "r-9" } })).toBe(
      "Unknown team",
    );
  });

  it("labels the filter list's bare key value as a record id or an external key", () => {
    expect(format("r-1", undefined)).toBe("Operations");
    expect(format("OPS", undefined)).toBe("Operations");
    expect(format("r-9", undefined)).toBe("Unknown team");
  });

  it("reads a bare value naming one record's id and another's external key as unknown", () => {
    const ambiguous = relationLabelFormatter(
      [
        { key: { type: "record_id", value: "r-1" }, label: "Operations" },
        {
          key: { type: "record_id", value: "r-2" },
          label: "Sales",
          aliasKeys: [{ type: "external_key", value: "r-1" }],
        },
      ],
      "Unknown team",
    );
    expect(ambiguous("r-1", undefined)).toBe("Unknown team");
    expect(ambiguous("", { type: "relation", value: { type: "external_key", value: "r-1" } })).toBe(
      "Sales",
    );
  });
});
