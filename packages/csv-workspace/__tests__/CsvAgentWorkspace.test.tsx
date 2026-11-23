import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ReactNode } from "react";

import type { FieldValue, ModelId, Schema } from "@contracts";
import type { EditableGridPreviewController } from "@modules/editable-grid";

import type { WorkspaceDraft } from "../draft";

const grid = vi.hoisted(() => ({
  controller: null as EditableGridPreviewController | null,
}));

vi.mock("@modules/source-import", () => ({
  SourceArtifactDropZone: () => <div>Upload</div>,
  PreviewSavePanel: (props: {
    onControllersChange: (value: ReadonlyMap<ModelId, EditableGridPreviewController>) => void;
    onSave: () => void;
    saving: boolean;
  }) => {
    if (grid.controller) {
      props.onControllersChange(new Map([["people" as ModelId, grid.controller]]));
    }
    return (
      <button type="button" disabled={props.saving} onClick={props.onSave}>
        Save 2 changes
      </button>
    );
  },
}));

vi.mock("@modules/agent-chat", () => ({
  MessageThread: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  PromptInput: (props: {
    onSend: (value: string) => void;
    onStop: () => void;
    isRunning: boolean;
  }) =>
    props.isRunning ? (
      <button type="button" onClick={props.onStop}>
        Stop
      </button>
    ) : (
      <button type="button" onClick={() => props.onSend("keep my correction")}>
        Amend
      </button>
    ),
}));

import {
  captureWorkspaceDraft,
  CsvAgentWorkspace,
  workspaceDraftPreview,
  type CsvAgentWorkspacePresentation,
} from "../CsvAgentWorkspace";

const text = (value: string): FieldValue => ({ type: "text", value });

const DRAFT: WorkspaceDraft = {
  revision: 3,
  rows: [
    {
      rowId: "existing-person",
      modelId: "people",
      recordId: "person-1",
      operation: "update",
      effectiveStart: "2026-09-01",
      values: { name: text("Agent proposal") },
      clearFields: ["nickname"],
    },
    {
      rowId: "new-department",
      modelId: "departments",
      recordId: "department-1",
      operation: "create",
      effectiveStart: "2026-09-01",
      values: { name: text("Operations") },
      clearFields: [],
    },
  ],
};

const PRESENTATION: CsvAgentWorkspacePresentation = {
  schema: {} as Schema,
  scope: { appId: "app", customerId: "customer" },
  asOf: "2026-09-01",
  fieldOverridesByModel: {},
  models: [
    { modelId: "people", label: "People", changeTypeId: "import_people" },
    { modelId: "departments", label: "Departments", changeTypeId: "import_departments" },
  ],
  priorValuesByRowId: { "existing-person": { name: text("Original") } },
};

function controllerWithHumanEdit(): EditableGridPreviewController {
  return {
    pendingChangesByRow: new Map([
      [
        "person-1",
        {
          effectiveDate: "2026-09-02",
          changeType: "import_people",
          fieldChanges: [
            { fieldId: "name", prior: text("Original"), next: text("Human correction") },
            { fieldId: "nickname", prior: text("Old nick"), next: text("New nick") },
          ],
        },
      ],
    ]),
  } as unknown as EditableGridPreviewController;
}

describe("CSV agent workspace", () => {
  afterEach(() => {
    grid.controller = null;
  });
  it("projects a multi-model WorkspaceDraft into the existing editable-grid preview contract", () => {
    const preview = workspaceDraftPreview(DRAFT, PRESENTATION);

    expect(preview.modelTabs.map((tab) => [tab.label, tab.rowCount])).toEqual([
      ["People", 1],
      ["Departments", 1],
    ]);
    expect(preview.rowsByModel?.people?.existing?.[0]).toMatchObject({
      recordId: "person-1",
      priorValues: { name: text("Original") },
      values: { name: text("Agent proposal") },
    });
    expect(preview.rowsByModel?.departments?.creates?.[0]).toMatchObject({
      tempRowId: "tmp:new-department",
      newRecordId: "department-1",
    });
  });

  it("captures human grid edits before feedback and preserves the input after failure or cancel", async () => {
    grid.controller = controllerWithHumanEdit();
    const onFeedback = vi.fn();
    const onCancel = vi.fn();
    const view = render(
      <CsvAgentWorkspace
        draft={DRAFT}
        presentation={PRESENTATION}
        messages={[]}
        running={false}
        onArtifact={vi.fn()}
        onFeedback={onFeedback}
        onCancel={onCancel}
        onSave={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Amend" }));
    const sent = onFeedback.mock.calls[0]?.[1] as WorkspaceDraft;
    expect(sent.rows[0]).toMatchObject({
      effectiveStart: "2026-09-02",
      values: { name: text("Human correction"), nickname: text("New nick") },
      clearFields: [],
    });
    expect(DRAFT.rows[0]?.values.name).toEqual(text("Agent proposal"));

    view.rerender(
      <CsvAgentWorkspace
        draft={DRAFT}
        presentation={PRESENTATION}
        messages={[]}
        running
        error="Turn failed"
        onArtifact={vi.fn()}
        onFeedback={onFeedback}
        onCancel={onCancel}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByText("Turn failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save 2 changes" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(captureWorkspaceDraft(DRAFT, new Map([["people" as ModelId, grid.controller]]))).toEqual(
      sent,
    );
  });

  it("submits one exact captured draft even when Save is double-clicked", async () => {
    grid.controller = controllerWithHumanEdit();
    let release!: () => void;
    const onFeedback = vi.fn();
    const onSave = vi.fn<(draft: WorkspaceDraft) => Promise<void>>(
      (_draft) =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    render(
      <CsvAgentWorkspace
        draft={DRAFT}
        presentation={PRESENTATION}
        messages={[]}
        running={false}
        onArtifact={vi.fn()}
        onFeedback={onFeedback}
        onCancel={vi.fn()}
        onSave={onSave}
      />,
    );

    const save = screen.getByRole("button", { name: "Save 2 changes" });
    fireEvent.click(save);
    fireEvent.click(save);
    fireEvent.click(screen.getByRole("button", { name: "Amend" }));
    expect(onFeedback).not.toHaveBeenCalled();
    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave.mock.calls[0]?.[0]).toEqual(
      captureWorkspaceDraft(DRAFT, new Map([["people" as ModelId, grid.controller]])),
    );
    release();
    await waitFor(() => expect(save).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Amend" }));
    expect(onFeedback).toHaveBeenCalledOnce();
  });

  it("captures only clears that remain in the live grid state", () => {
    grid.controller = {
      ...controllerWithHumanEdit(),
      pendingChangesByRow: new Map([
        [
          "person-1",
          {
            effectiveDate: "2026-09-02",
            changeType: "import_people",
            fieldChanges: [
              { fieldId: "name", prior: text("Original"), next: text("Human correction") },
            ],
          },
        ],
      ]),
    } as EditableGridPreviewController;
    const onSave = vi.fn();
    render(
      <CsvAgentWorkspace
        draft={DRAFT}
        presentation={PRESENTATION}
        messages={[]}
        running={false}
        onArtifact={vi.fn()}
        onFeedback={vi.fn()}
        onCancel={vi.fn()}
        onSave={onSave}
      />,
    );

    expect(screen.queryByRole("region", { name: "Fields to clear" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save 2 changes" }));
    expect((onSave.mock.calls[0]?.[0] as WorkspaceDraft).rows[0]?.clearFields).toEqual([]);
  });
});
