// Tenant custom fields in the CSV import workspace, through the real
// presentation, PreviewSavePanel, editable-grid controller and cell
// renderers. Only AG Grid's canvas is replaced: the stand-in renders every
// data cell with the column's own valueGetter, valueFormatter and
// cellRenderer, and exposes column defs so a test can commit a value the way
// an editor does (through the column's valueSetter).

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vite-plus/test";
import type { ComponentType, ReactNode } from "react";
import type { EditableRowVersionGridSurfaceProps, GridColumnContext } from "@modules/editable-grid";

import type { FieldValue, Schema, VisibleRecord } from "@contracts";

import { splitCustomFieldsFromWrites } from "../../engines/custom-field-projection/index";
import { buildWorkspaceWrites, type WorkspaceDraft } from "../draft";

// AG Grid types through the editable-grid module (apps never import AG Grid).
type ColDef<_TData> = EditableRowVersionGridSurfaceProps["columnDefs"][number];
type ValueSetterParams<_TData> = Parameters<ReturnType<GridColumnContext["fieldSetter"]>>[0];

const grid = vi.hoisted(() => ({
  columns: [] as Array<ColDef<VisibleRecord>>,
  rows: [] as VisibleRecord[],
}));

vi.mock("ag-grid-react", () => ({
  AgGridReact: (props: {
    rowData: Array<VisibleRecord & { __metaRow?: boolean }>;
    columnDefs: Array<ColDef<VisibleRecord>>;
  }) => {
    grid.columns = props.columnDefs;
    grid.rows = props.rowData.filter((row) => !row.__metaRow);
    return (
      <table aria-label="Editable data review">
        <tbody>
          {grid.rows.map((row) => (
            <tr key={row.record_id}>
              {props.columnDefs.map((column) => {
                const value = (column.valueGetter as (p: { data: VisibleRecord }) => unknown)({
                  data: row,
                });
                const formatter = column.valueFormatter as
                  | ((p: { value: unknown; data: VisibleRecord }) => string)
                  | undefined;
                const valueFormatted = formatter ? formatter({ value, data: row }) : null;
                const Renderer = column.cellRenderer as ComponentType<Record<string, unknown>>;
                return (
                  <td key={column.colId} data-cell={`${row.record_id}:${column.colId}`}>
                    <Renderer
                      data={row}
                      value={value}
                      valueFormatted={valueFormatted}
                      colDef={{ colId: column.colId }}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    );
  },
}));

vi.mock("@modules/agent-chat", () => ({
  MessageThread: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  PromptInput: () => null,
}));

import { CsvAgentWorkspace } from "../CsvAgentWorkspace";
import { buildCsvWorkspacePresentation } from "../presentation";
import type { CsvWorkspaceContext } from "../types";

const text = (value: string): FieldValue => ({ type: "text", value });

const schema = {
  app_id: "app",
  customer_id: "customer",
  version: "v1",
  models: [
    {
      id: "people",
      kind: "entity",
      label: "People",
      display_field_id: "name",
      extensions: { typed_custom_fields: true },
      fields: [
        { id: "name", label: "Name", type: "text", required: true },
        { id: "squad", label: "Squad", type: "relation", required: false, target_model: "team" },
      ],
    },
    {
      id: "team",
      kind: "lookup",
      label: "Team",
      display_field_id: "name",
      fields: [{ id: "name", label: "Name", type: "text", required: true }],
    },
  ],
  custom_fields: [
    { id: "cfd_note", model_id: "people", field_id: "cf_note", label: "Note", type: "text" },
    {
      id: "cfd_team",
      model_id: "people",
      field_id: "cf_team",
      label: "Home team",
      type: "relation",
      target_model_id: "team",
    },
  ],
  change_types: [
    {
      id: "import_people",
      label: "Import people",
      target_model: "people",
      touches: ["name"],
      required: [],
    },
  ],
} as unknown as Schema;

const person: VisibleRecord = {
  record_id: "person-1",
  effective_start: "2026-01-01",
  effective_end: null,
  values: { name: text("Ada") },
  custom_fields: [
    { field_id: "cf_note", type: "text", value: "Keep me" },
    { field_id: "cf_team", type: "relation", value: { type: "record_id", value: "team-1" } },
  ],
};

const context = {
  schema,
  schemaRevisionId: "1",
  scope: { appId: "app", customerId: "customer" },
  actorId: "reviewer",
  asOf: "2026-09-01",
  recoveryContext: {
    appId: "app",
    customerId: "customer",
    actorId: "reviewer",
    asOf: "2026-09-01",
  },
  policies: [],
  recordsByModel: {
    people: [person],
    team: [
      {
        record_id: "team-1",
        effective_start: "2026-01-01",
        external_key: "team-platform",
        values: { name: text("Platform") },
        custom_fields: [],
      },
      {
        record_id: "team-2",
        effective_start: "2026-01-01",
        values: { name: text("Field ops") },
        custom_fields: [],
      },
    ],
  },
  activity: [],
} as unknown as CsvWorkspaceContext;

function workspace(draft: WorkspaceDraft, onSave = vi.fn()) {
  const presentation = {
    ...buildCsvWorkspacePresentation(context, draft),
    models: [{ modelId: "people", label: "People", changeTypeId: "import_people" }],
  };
  render(
    <CsvAgentWorkspace
      draft={draft}
      presentation={presentation}
      messages={[]}
      running={false}
      onArtifact={vi.fn()}
      onFeedback={vi.fn()}
      onCancel={vi.fn()}
      onSave={onSave}
    />,
  );
  return onSave;
}

function cell(recordId: string, fieldId: string) {
  return document.querySelector(`[data-cell="${recordId}:${fieldId}"]`) as HTMLElement;
}

function commit(recordId: string, fieldId: string, newValue: unknown) {
  const column = grid.columns.find((candidate) => candidate.colId === fieldId)!;
  const data = grid.rows.find((row) => row.record_id === recordId)!;
  act(() => {
    (column.valueSetter as (p: ValueSetterParams<VisibleRecord>) => boolean)({
      data,
      newValue,
    } as ValueSetterParams<VisibleRecord>);
  });
}

// Opens the column's real cell editor (the relation picker adapter) the way
// AG Grid does and clicks an option; its commit runs the column's setter.
async function pick(recordId: string, fieldId: string, optionLabel: string) {
  const column = grid.columns.find((candidate) => candidate.colId === fieldId)!;
  const data = grid.rows.find((row) => row.record_id === recordId)!;
  const Editor = column.cellEditor as ComponentType<Record<string, unknown>>;
  const value = (column.valueGetter as (p: { data: VisibleRecord }) => unknown)({ data });
  const view = render(
    <div data-editor>
      <Editor
        {...(column.cellEditorParams as Record<string, unknown>)}
        value={value}
        data={data}
        colDef={column}
        column={{ getColId: () => fieldId }}
        node={{
          setDataValue: (_column: unknown, newValue: unknown) =>
            act(() => {
              (column.valueSetter as (p: ValueSetterParams<VisibleRecord>) => boolean)({
                data,
                newValue,
              } as ValueSetterParams<VisibleRecord>);
            }),
        }}
        api={{ stopEditing: () => undefined }}
      />
    </div>,
  );
  await userEvent.click(within(view.container).getByRole("combobox"));
  await userEvent.click(await screen.findByRole("option", { name: optionLabel }));
  view.unmount();
}

const update = (values: WorkspaceDraft["rows"][number]["values"]): WorkspaceDraft => ({
  revision: 1,
  rows: [
    {
      rowId: "person-row",
      modelId: "people",
      recordId: "person-1",
      operation: "update",
      effectiveStart: "2026-09-01",
      values,
      clearFields: [],
    },
  ],
});

const incomingCustomClear = (): WorkspaceDraft => ({
  revision: 2,
  rows: [{ ...update({}).rows[0]!, clearFields: ["cf_note"] }],
});

describe("CSV workspace grid with tenant custom fields", () => {
  it("shows an incoming custom clear and removes it when the saved value is retyped", async () => {
    const onSave = workspace(incomingCustomClear());
    await waitFor(() => expect(cell("person-1", "cf_note")).toHaveTextContent("Cleared"));
    expect(cell("person-1", "cf_note")).toHaveTextContent("was Keep me");

    const save = screen.getByRole("button", { name: "Save 1 change" });
    fireEvent.click(save);
    const saved = onSave.mock.calls[0]![0] as WorkspaceDraft;
    expect(saved.rows[0]).toMatchObject({ values: {}, clearFields: ["cf_note"] });
    const [write] = splitCustomFieldsFromWrites(buildWorkspaceWrites(saved), schema);
    expect(write).toMatchObject({ clear_custom_fields: ["cf_note"] });

    await waitFor(() => expect(save).toBeEnabled());
    commit("person-1", "cf_note", "Keep me");
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeDisabled());
    expect(onSave).toHaveBeenCalledOnce();
  });

  it("removes an incoming custom clear when the row is reverted", async () => {
    workspace(incomingCustomClear());
    await waitFor(() => expect(cell("person-1", "cf_note")).toHaveTextContent("Cleared"));

    fireEvent.click(within(cell("person-1", "cf_note")).getByRole("button", { name: "Revert" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeDisabled());
    expect(cell("person-1", "cf_note")).toHaveTextContent("Keep me");
    expect(cell("person-1", "cf_note")).not.toHaveTextContent("Cleared");
  });

  it("shows saved custom values and saves a clear of one", async () => {
    const onSave = workspace(update({ name: text("Ada L.") }));
    await waitFor(() => expect(cell("person-1", "cf_note")).toHaveTextContent("Keep me"));
    expect(cell("person-1", "cf_team")).toHaveTextContent("Platform");

    commit("person-1", "cf_note", null);
    await waitFor(() => expect(cell("person-1", "cf_note")).toHaveTextContent("Cleared"));
    expect(cell("person-1", "cf_note")).toHaveTextContent("Keep me");

    fireEvent.click(screen.getByRole("button", { name: /^Save/ }));
    const saved = onSave.mock.calls[0]![0] as WorkspaceDraft;
    expect(saved.rows[0]).toMatchObject({ clearFields: ["cf_note"] });
    expect(buildWorkspaceWrites(saved)[0]).toMatchObject({ clear_fields: ["cf_note"] });
  });

  it("offers custom-link targets by name and labels a lookup-or-create value", async () => {
    const onSave = workspace(
      update({
        cf_team: {
          type: "relation",
          value: { type: "lookup_or_create", value: { label: "Research" } },
        },
      }),
    );
    await waitFor(() => expect(cell("person-1", "cf_team")).toHaveTextContent("Research"));
    expect(cell("person-1", "cf_team")).toHaveTextContent("Platform");

    const column = grid.columns.find((candidate) => candidate.colId === "cf_team")!;
    const options = (
      column.cellEditorParams as { fieldType: { relationOptions: Array<{ label: string }> } }
    ).fieldType.relationOptions;
    expect(options.map((option) => option.label)).toEqual(["Platform", "Field ops"]);

    await pick("person-1", "cf_team", "Field ops");
    await waitFor(() => expect(cell("person-1", "cf_team")).toHaveTextContent("Field ops"));
    fireEvent.click(screen.getByRole("button", { name: /^Save/ }));
    expect((onSave.mock.calls[0]![0] as WorkspaceDraft).rows[0]!.values.cf_team).toEqual({
      type: "relation",
      value: { type: "record_id", value: "team-2" },
    });
  });

  it("saves a picked record's own key over an external-key proposal", async () => {
    const byExternalKey = {
      type: "relation" as const,
      value: { type: "external_key" as const, value: "team-platform" },
    };
    const onSave = workspace(update({ cf_team: byExternalKey, squad: byExternalKey }));
    await waitFor(() => expect(cell("person-1", "cf_team")).toHaveTextContent("Platform"));
    expect(cell("person-1", "squad")).toHaveTextContent("Platform");

    await pick("person-1", "cf_team", "Field ops");
    await pick("person-1", "squad", "Field ops");
    await waitFor(() => expect(cell("person-1", "squad")).toHaveTextContent("Field ops"));
    fireEvent.click(screen.getByRole("button", { name: /^Save/ }));

    const saved = onSave.mock.calls[0]![0] as WorkspaceDraft;
    const [write] = splitCustomFieldsFromWrites(buildWorkspaceWrites(saved), schema);
    const teamTwo = { type: "record_id", value: "team-2" };
    expect(write!.custom_fields).toEqual([
      { field_id: "cf_team", type: "relation", value: teamTwo },
    ]);
    expect(write!.values).toMatchObject({ squad: { type: "relation", value: teamTwo } });
  });
});
