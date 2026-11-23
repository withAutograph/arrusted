import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import type { ComponentProps, ComponentType, ReactNode } from "react";

import type { Field, FieldValue, ModelId, Schema } from "@contracts";
import type { EditableGridPreviewController } from "@modules/editable-grid";

import type { WorkspaceDraft } from "../draft";

const realGrid = vi.hoisted(() => ({ controller: null as EditableGridPreviewController | null }));

// Replace only AG Grid's canvas; render its actual row-meta renderer and params.
vi.mock("ag-grid-react", () => ({
  AgGridReact: (props: {
    rowData: Array<{ record_id: string; __metaRow?: boolean }>;
    fullWidthCellRenderer: ComponentType<Record<string, unknown>>;
    fullWidthCellRendererParams: Record<string, unknown>;
  }) => {
    const Renderer = props.fullWidthCellRenderer;
    return (
      <div aria-label="Editable data review">
        {props.rowData
          .filter((row) => row.__metaRow)
          .map((row) => (
            <Renderer key={row.record_id} {...props.fullWidthCellRendererParams} data={row} />
          ))}
      </div>
    );
  },
}));

vi.mock("@modules/source-import", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@modules/source-import")>();
  return {
    ...actual,
    PreviewSavePanel: (props: ComponentProps<typeof actual.PreviewSavePanel>) => {
      return (
        <actual.PreviewSavePanel
          {...props}
          onControllersChange={(
            controllers: ReadonlyMap<ModelId, EditableGridPreviewController>,
          ) => {
            realGrid.controller = controllers.values().next().value ?? null;
            props.onControllersChange?.(controllers);
          }}
        />
      );
    },
  };
});

vi.mock("@modules/agent-chat", () => ({
  MessageThread: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  PromptInput: (props: { onSend: (value: string) => void }) => (
    <button type="button" onClick={() => props.onSend("use my edited name")}>
      Amend
    </button>
  ),
}));

import { CsvAgentWorkspace, type CsvAgentWorkspacePresentation } from "../CsvAgentWorkspace";

const text = (value: string): FieldValue => ({ type: "text", value });
const schema = {
  app_id: "app",
  customer_id: "customer",
  schema_revision_id: 1,
  version: "v1",
  models: [
    {
      id: "people",
      kind: "entity",
      name: "People",
      label: "People",
      record_label: "person",
      fields: [
        { id: "name", name: "Name", type: "text" } as unknown as Field,
        { id: "nickname", name: "Nickname", type: "text" } as unknown as Field,
      ],
    },
  ],
  change_types: [
    {
      id: "import_people",
      label: "Import people",
      target_model: "people",
      touches: ["name", "nickname"],
      required: [],
    },
  ],
} as unknown as Schema;
const draft: WorkspaceDraft = {
  revision: 1,
  rows: [
    {
      rowId: "person-row",
      modelId: "people",
      recordId: "person-1",
      operation: "update",
      effectiveStart: "2026-09-01",
      values: { name: text("Agent proposal") },
      clearFields: [],
    },
  ],
};
const createDraft: WorkspaceDraft = {
  revision: 2,
  rows: [
    {
      rowId: "new-person-row",
      modelId: "people",
      recordId: "person-2",
      operation: "create",
      effectiveStart: "2026-09-01",
      values: { name: text("Agent-created person") },
      clearFields: [],
    },
  ],
};
const presentation: CsvAgentWorkspacePresentation = {
  schema,
  scope: { appId: "app", customerId: "customer" },
  asOf: "2026-09-01",
  fieldOverridesByModel: {},
  models: [{ modelId: "people", label: "People", changeTypeId: "import_people" }],
  priorValuesByRowId: { "person-row": { name: text("Original") } },
};

describe("CSV agent workspace real editable-grid boundary", () => {
  it("round-trips a created row through the real controller temp key", async () => {
    const onFeedback = vi.fn();
    render(
      <CsvAgentWorkspace
        draft={createDraft}
        presentation={presentation}
        messages={[]}
        running={false}
        onArtifact={vi.fn()}
        onFeedback={onFeedback}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(realGrid.controller?.pendingChangesByRow.has("tmp:new-person-row")).toBe(true),
    );

    act(() => {
      const outcome = realGrid.controller!.stageBulkUpdate({
        rows: [{ rowKey: "tmp:new-person-row" }],
        fieldId: "name",
        value: text("Human-created correction"),
        bulkGroupId: "human-edit",
        effectiveStart: "2026-09-01",
        changeTypeId: "import_people",
      });
      expect(outcome).toEqual({ ok: true });
    });
    await waitFor(() =>
      expect(
        realGrid.controller?.pendingChangesByRow.get("tmp:new-person-row")?.fieldChanges[0]?.next,
      ).toEqual(text("Human-created correction")),
    );

    fireEvent.click(screen.getByRole("button", { name: "Amend" }));
    const captured = onFeedback.mock.calls[0]?.[1] as WorkspaceDraft;
    expect(captured.rows).toEqual([
      expect.objectContaining({
        rowId: "new-person-row",
        recordId: "person-2",
        operation: "create",
        effectiveStart: "2026-09-01",
        values: { name: text("Human-created correction") },
      }),
    ]);
  });

  it("passes a human edit from the live controller into feedback", async () => {
    const onFeedback = vi.fn();
    render(
      <CsvAgentWorkspace
        draft={draft}
        presentation={presentation}
        messages={[]}
        running={false}
        onArtifact={vi.fn()}
        onFeedback={onFeedback}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    await waitFor(() => expect(realGrid.controller?.pendingChangesByRow.size).toBe(1));
    expect(screen.getByText("Effective:")).toBeInTheDocument();
    expect(document.querySelector("[data-row-meta-date-trigger]")).toBeNull();

    act(() => {
      const outcome = realGrid.controller!.stageBulkUpdate({
        rows: [{ rowKey: "person-1" }],
        fieldId: "name",
        value: text("Human correction"),
        bulkGroupId: "human-edit",
        effectiveStart: "2026-09-01",
        changeTypeId: "import_people",
      });
      expect(outcome).toEqual({ ok: true });
    });
    await waitFor(() => {
      expect(
        realGrid.controller?.pendingChangesByRow.get("person-1")?.fieldChanges[0]?.next,
      ).toEqual(text("Human correction"));
    });
    fireEvent.click(screen.getByRole("button", { name: "Amend" }));

    const captured = onFeedback.mock.calls[0]?.[1] as WorkspaceDraft;
    expect(captured.rows[0]).toMatchObject({
      effectiveStart: "2026-09-01",
      values: { name: text("Human correction") },
    });
    expect(draft.rows[0]?.values.name).toEqual(text("Agent proposal"));
  });

  it("omits a proposal row after the live grid discards all of its edits", async () => {
    const onFeedback = vi.fn();
    render(
      <CsvAgentWorkspace
        draft={draft}
        presentation={presentation}
        messages={[]}
        running={false}
        onArtifact={vi.fn()}
        onFeedback={onFeedback}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    await waitFor(() => expect(realGrid.controller?.pendingChangesByRow.size).toBe(1));

    act(() => {
      realGrid.controller!.revertRowEdits("person-1");
    });
    await waitFor(() => expect(realGrid.controller?.pendingChangesByRow.size).toBe(0));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Amend" }));

    expect((onFeedback.mock.calls[0]?.[1] as WorkspaceDraft).rows).toEqual([]);
    expect(draft.rows).toHaveLength(1);
  });

  it("stages and saves an incoming clear through the real controller", async () => {
    const onSave = vi.fn();
    const clearOnly: WorkspaceDraft = {
      revision: 3,
      rows: [{ ...draft.rows[0]!, values: {}, clearFields: ["name"] }],
    };
    render(
      <CsvAgentWorkspace
        draft={clearOnly}
        presentation={presentation}
        messages={[]}
        running={false}
        onArtifact={vi.fn()}
        onFeedback={vi.fn()}
        onCancel={vi.fn()}
        onSave={onSave}
      />,
    );
    await waitFor(() => expect(realGrid.controller?.pendingChangesByRow.size).toBe(1));
    expect(screen.queryByRole("region", { name: "Fields to clear" })).not.toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Save 1 change" });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    expect(onSave).toHaveBeenCalledExactlyOnceWith(clearOnly);
  });

  it("disables Save after reverting a row with typed edits and an incoming clear", async () => {
    const mixedDraft: WorkspaceDraft = {
      revision: 4,
      rows: [{ ...draft.rows[0]!, clearFields: ["nickname"] }],
    };
    render(
      <CsvAgentWorkspace
        draft={mixedDraft}
        presentation={presentation}
        messages={[]}
        running={false}
        onArtifact={vi.fn()}
        onFeedback={vi.fn()}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    await waitFor(() => expect(realGrid.controller?.pendingChangesByRow.size).toBe(1));
    expect(screen.getByRole("button", { name: "Save 1 change" })).toBeEnabled();
    act(() => realGrid.controller!.revertRowEdits("person-1"));
    await waitFor(() => expect(realGrid.controller?.pendingChangesByRow.size).toBe(0));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});
