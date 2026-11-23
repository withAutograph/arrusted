import { useCallback, useRef, useState, type ReactNode } from "react";

import type {
  AppId,
  ChangeTypeId,
  CustomerId,
  FieldId,
  FieldValue,
  ModelId,
  Schema,
} from "@contracts";
import { MessageThread, PromptInput, type ChatMessageView } from "@modules/agent-chat";
import {
  EDITABLE_GRID_TEMP_ROW_KEY_PREFIX,
  type EditableGridPreviewController,
  type FieldOverrides,
} from "@modules/editable-grid";

import {
  PreviewSavePanel,
  SourceArtifactDropZone,
  type SourceArtifactSelection,
  type PreviewModelRows,
  type WriteBoundImportPreview,
} from "@modules/source-import";
import type { WorkspaceDraft } from "./draft";

import "./csv-agent-workspace.css";

export type CsvAgentWorkspacePresentation = {
  schema: Schema;
  scope: { appId: AppId; customerId: CustomerId };
  asOf: string;
  fieldOverridesByModel: Readonly<Record<ModelId, FieldOverrides>>;
  models: readonly {
    modelId: string;
    label: string;
    changeTypeId?: string;
  }[];
  priorValuesByRowId: Readonly<Record<string, Record<string, FieldValue | null>>>;
};

export type CsvAgentWorkspaceProps = {
  artifactName?: string;
  draft: WorkspaceDraft | null;
  presentation: CsvAgentWorkspacePresentation;
  messages: readonly ChatMessageView[];
  running: boolean;
  saving?: boolean;
  error?: string | null;
  receipt?: ReactNode;
  onArtifact: (selection: SourceArtifactSelection) => void;
  onFeedback: (message: string, draft: WorkspaceDraft) => void | Promise<void>;
  onCancel: () => void;
  onSave: (draft: WorkspaceDraft) => void | Promise<void>;
};

function snapshotControllers(
  controllers: ReadonlyMap<ModelId, EditableGridPreviewController>,
): ReadonlyMap<ModelId, EditableGridPreviewController> {
  return new Map(controllers);
}

function workspaceGridRowKey(row: WorkspaceDraft["rows"][number]) {
  return row.operation === "create"
    ? `${EDITABLE_GRID_TEMP_ROW_KEY_PREFIX}${row.rowId}`
    : row.recordId;
}

export function captureWorkspaceDraft(
  draft: WorkspaceDraft,
  controllers: ReadonlyMap<ModelId, EditableGridPreviewController>,
): WorkspaceDraft {
  const next = structuredClone(draft);
  next.rows = next.rows.flatMap((row) => {
    const controller = controllers.get(row.modelId as ModelId);
    if (!controller) return [row];
    const rowKey = workspaceGridRowKey(row);
    const summary = controller.pendingChangesByRow.get(rowKey);
    if (!summary) {
      return [];
    }
    row.effectiveStart = summary.effectiveDate;
    const values: WorkspaceDraft["rows"][number]["values"] = {};
    const clearFields: string[] = [];
    for (const change of summary.fieldChanges) {
      // A cleared cell joins the draft's clears rather than its values.
      if (change.next === null) clearFields.push(change.fieldId);
      else values[change.fieldId] = structuredClone(change.next);
    }
    row.values = values;
    row.clearFields = clearFields;
    return [row];
  });
  return next;
}

export function workspaceDraftPreview(
  draft: WorkspaceDraft,
  presentation: CsvAgentWorkspacePresentation,
): WriteBoundImportPreview {
  const rowsByModel = {} as Record<ModelId, PreviewModelRows>;
  const tabs = presentation.models.map((model) => {
    const rows = draft.rows.filter((row) => row.modelId === model.modelId);
    rowsByModel[model.modelId as ModelId] = {
      existing: rows.flatMap((row) =>
        row.operation === "update"
          ? [
              {
                recordId: row.recordId,
                effectiveStart: row.effectiveStart,
                priorValues: (presentation.priorValuesByRowId[row.rowId] ?? {}) as Record<
                  FieldId,
                  FieldValue | null
                >,
                values: row.values as Record<FieldId, FieldValue>,
                clearFields: row.clearFields as FieldId[],
                ...(model.changeTypeId ? { changeTypeId: model.changeTypeId as ChangeTypeId } : {}),
              },
            ]
          : [],
      ),
      creates: rows.flatMap((row) =>
        row.operation === "create"
          ? [
              {
                tempRowId: workspaceGridRowKey(row),
                newRecordId: row.recordId,
                effectiveStart: row.effectiveStart,
                values: row.values as Record<FieldId, FieldValue>,
                clearFields: row.clearFields as FieldId[],
                ...(model.changeTypeId ? { changeTypeId: model.changeTypeId as ChangeTypeId } : {}),
              },
            ]
          : [],
      ),
    };
    return {
      modelId: model.modelId as ModelId,
      label: model.label,
      rowCount: rows.length,
      readyRowCount: rows.length,
      needsReviewRowCount: 0,
      parseErrorRowCount: 0,
    };
  });
  return {
    changeCount: draft.rows.length,
    modelTabs: tabs,
    saveBlockingReason: draft.rows.length === 0 ? "no_changes" : null,
    rowsByModel,
  };
}

const EMPTY_CONTROLLERS: ReadonlyMap<ModelId, EditableGridPreviewController> = new Map();

export function CsvAgentWorkspace(props: CsvAgentWorkspaceProps) {
  const controllersRef =
    useRef<ReadonlyMap<ModelId, EditableGridPreviewController>>(EMPTY_CONTROLLERS);
  const saveClaimRef = useRef(false);
  const [localSaving, setLocalSaving] = useState(false);
  const locked = props.running || Boolean(props.saving) || localSaving;

  const handleControllersChange = useCallback(
    (controllers: ReadonlyMap<ModelId, EditableGridPreviewController>) => {
      controllersRef.current = snapshotControllers(controllers);
    },
    [],
  );

  const { draft: currentDraft, onFeedback, onSave } = props;
  const handleFeedback = useCallback(
    (message: string) => {
      if (locked || saveClaimRef.current || !currentDraft || message.trim().length === 0) return;
      void onFeedback(
        message,
        captureWorkspaceDraft(currentDraft!, snapshotControllers(controllersRef.current!)),
      );
    },
    [locked, currentDraft, onFeedback],
  );

  const handleSave = useCallback(async () => {
    if (locked || saveClaimRef.current) return;
    saveClaimRef.current = true;
    setLocalSaving(true);
    try {
      await onSave(
        captureWorkspaceDraft(currentDraft!, snapshotControllers(controllersRef.current!)),
      );
    } finally {
      saveClaimRef.current = false;
      setLocalSaving(false);
    }
  }, [locked, currentDraft, onSave]);

  if (props.receipt) {
    return (
      <section
        className="csv-agent-workspace csv-agent-workspace--receipt"
        aria-label="Saved import"
      >
        {props.receipt}
      </section>
    );
  }

  if (!props.draft) {
    return (
      <section className="csv-agent-workspace csv-agent-workspace--upload" aria-label="CSV import">
        <SourceArtifactDropZone
          onArtifact={props.onArtifact}
          acceptedContentTypes={["text/csv", "application/csv", "text/plain"]}
          acceptedFileExtensions={[".csv"]}
          headline="Drop a CSV here"
          subline="The agent will interpret it and prepare records for review."
          footerNote="Nothing is published until you Save."
        />
      </section>
    );
  }

  const draft = props.draft;
  const preview = workspaceDraftPreview(draft, props.presentation);
  return (
    <section className="csv-agent-workspace" aria-label="CSV workspace">
      <div className="csv-agent-workspace__review">
        <header className="csv-agent-workspace__header">
          <div>
            <p className="csv-agent-workspace__eyebrow">Current draft</p>
            <h2>{props.artifactName ?? "CSV import"}</h2>
          </div>
          {props.running ? <span role="status">Agent working…</span> : null}
        </header>
        <div
          className="csv-agent-workspace__grid"
          aria-disabled={locked || undefined}
          inert={locked || undefined}
        >
          <PreviewSavePanel
            key={draft.revision}
            preview={preview}
            schema={props.presentation.schema}
            scope={props.presentation.scope}
            asOf={props.presentation.asOf}
            fieldOverridesByModel={props.presentation.fieldOverridesByModel}
            saving={locked}
            onSave={handleSave}
            onControllersChange={handleControllersChange}
          />
        </div>
      </div>

      <aside className="csv-agent-workspace__conversation" aria-label="Import agent">
        <header className="csv-agent-workspace__conversation-header">Import agent</header>
        <MessageThread
          messages={props.messages}
          isRunning={props.running}
          className="csv-agent-workspace__thread"
          viewportClassName="csv-agent-workspace__thread-viewport"
          emptyState={<p>Ask how the file was interpreted or request a change.</p>}
        >
          {props.error ? (
            <p role="alert" className="csv-agent-workspace__error">
              {props.error}
            </p>
          ) : null}
        </MessageThread>
        <div
          className="csv-agent-workspace__composer"
          inert={Boolean(props.saving || localSaving) || undefined}
          aria-disabled={Boolean(props.saving || localSaving) || undefined}
        >
          <PromptInput
            onSend={handleFeedback}
            onStop={props.onCancel}
            isRunning={props.running}
            placeholder="Ask a question or amend this draft…"
          />
        </div>
      </aside>
    </section>
  );
}
