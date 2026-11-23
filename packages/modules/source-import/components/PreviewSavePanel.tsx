// PreviewSavePanel — active body for the "Preview & save" stage.
//
// Mounts N parallel preview-only editable-grid controllers — one per
// `PreviewModelTab` — and surfaces aggregated counts + a Save action
// across all of them via PreviewSaveBar. The active tab body is visible;
// inactive tab bodies render with `display: none` so per-model dirty
// state survives tab switches.
//
// Rules-of-Hooks compliance: the hook MUST be called the same number of
// times on every render, and that number is determined by the dynamic
// `tabs.length`. The pattern: render N <PreviewModelTabMount /> children,
// each calls the hook exactly once and reports its controller back via
// `onController(modelId, controller)`. The parent collects controllers
// in a stable Map keyed by modelId.
//
// Hidden tabs are rendered with `display: none`. AG Grid still mounts in
// hidden tabs and runs render passes — there's a measurable perf cost on wide
// grids that hosts should be aware of. This is acceptable for the first
// expected import scale; revisit when a real consumer pushes past those bounds.
//
// Layer: module layer 5. Imports source-import types + the sibling
// editable-grid module + contracts (type-only).

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import {
  EditableRowVersionGrid,
  useEditableRowVersionGridPreview,
  type EditableGridPreviewController,
  type FieldOverrides,
} from "@modules/editable-grid";
import { projectCustomFields } from "@engines/custom-field-projection/index";
import type {
  AppId,
  ChangeTypeId,
  CustomerId,
  FieldId,
  FieldValue,
  ModelId,
  Schema,
  VisibleRecord,
} from "@contracts";

import { PreviewSaveBar } from "./PreviewSaveBar";
import { PreviewSaveTabs, PREVIEW_ERRORS_TAB_ID } from "./PreviewSaveTabs";
import type {
  PreviewModelTab,
  PreviewParseIssue,
  PreviewRowIssue,
  SaveBlockingReason,
  WriteBoundImportPreview,
} from "../types";

import "./preview-save-panel.css";

export type PreviewSavePanelProps = {
  preview: WriteBoundImportPreview;
  schema: Schema;
  scope: { appId: AppId; customerId: CustomerId };
  asOf: string;
  fieldOverridesByModel: Readonly<Record<ModelId, FieldOverrides>>;
  // Returned from the surface's combined-save handler so the bar can
  // disable while ANY underlying controller is in flight.
  // Override the blocking-reason precedence; defaults to module-derived.
  blockingReason?: SaveBlockingReason;
  // Surfaced when one or more controllers' partitions failed in the
  // previous save attempt. Rendered as an alert beneath the Save button
  // in the bar. Cleared on the next successful save.
  // Surfaced when the synthetic Issues tab is selected (PREVIEW_ERRORS_TAB_ID).
  renderErrorsBody?: () => ReactNode;
  errorCopy?: PreviewSavePanelErrorCopy;
  // Optional surface-level subscribers. The panel owns controller
  // registration for its tab mounts, but the top-level surface owns the
  // combined Save action and wipe-warning state, so it needs snapshots.
  onDirtyEditCountChange?: (count: number) => void;
  onDiscardAll?: () => void;
  sourceKind?: string;
  sourceRef?: string | null;
  className?: string;
  saving: boolean;
  onSave: () => void | Promise<void>;
  saveErrorMessage?: string;
  onControllersChange?: (controllers: ReadonlyMap<ModelId, EditableGridPreviewController>) => void;
};

export type PreviewSavePanelErrorCopy = {
  ariaLabel: string;
  issueNoun: string;
};

type ControllerSnapshot = ReadonlyMap<
  ModelId,
  {
    dirtyCount: number;
    readyRowCount: number;
    invalidRowCount: number;
    invalidCellCount: number;
    pendingEditsHidden: number;
  }
>;

function joinClassNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

function sumDirtyEdits(controllers: ReadonlyMap<ModelId, EditableGridPreviewController>): number {
  let count = 0;
  for (const controller of controllers.values()) {
    count += controller.dirtyCount;
  }
  return count;
}

export function PreviewSavePanel(props: PreviewSavePanelProps) {
  const onControllersChange = props.onControllersChange;
  const {
    preview,
    schema,
    scope,
    asOf,
    fieldOverridesByModel,
    blockingReason,
    renderErrorsBody,
    errorCopy,
    onDirtyEditCountChange,
    sourceKind = "human",
    sourceRef,
    className,
  } = props;

  // First tab is active by default. The composite stays controlled by an
  // internal active-tab state; the host's surface composite typically
  // doesn't need to swap tabs externally, but the PreviewSaveTabs leaf
  // is itself controlled so we wire local state for it.
  const [activeTabId, setActiveTabId] = useState<string>(() => {
    return preview.modelTabs[0]?.modelId ?? "";
  });
  const [stageFailuresByModel, setStageFailuresByModel] = useState<ReadonlyMap<ModelId, string>>(
    () => new Map(),
  );
  const setStageFailure = useCallback((modelId: ModelId, message: string | null) => {
    setStageFailuresByModel((current) => {
      const existing = current.get(modelId) ?? null;
      if (existing === message) return current;
      const next = new Map(current);
      if (message === null) {
        next.delete(modelId);
      } else {
        next.set(modelId, message);
      }
      return next;
    });
  }, []);

  // Per-modelId controller refs. The real editable-grid hook returns a
  // fresh controller object each render, so controller identity cannot be
  // used as React state without creating a render loop. Keep the latest
  // controllers in a ref for Save, and mirror only count/status fields into
  // state so the bar re-renders when observable state changes.
  const editableControllersRef = useRef<Map<ModelId, EditableGridPreviewController> | null>(null);
  if (editableControllersRef.current === null) {
    editableControllersRef.current = new Map();
  }
  const [controllerSnapshot, setControllerSnapshot] = useState<ControllerSnapshot>(() => new Map());
  const registerController = useCallback(
    (modelId: ModelId, controller: EditableGridPreviewController | null) => {
      if (controller == null) {
        editableControllersRef.current!.delete(modelId);
      } else {
        editableControllersRef.current!.set(modelId, controller);
      }
      // Controller objects intentionally stay out of React state to avoid a
      // render loop, but the host needs the latest pending edits even when
      // dirty/invalid counts did not change.
      onControllersChange?.(new Map(editableControllersRef.current!));
      onDirtyEditCountChange?.(sumDirtyEdits(editableControllersRef.current!));
      setControllerSnapshot((current) => {
        if (controller == null) {
          if (!current.has(modelId)) return current;
          const next = new Map(current);
          next.delete(modelId);
          return next;
        }
        const nextSnapshot = {
          dirtyCount: controller.dirtyCount,
          readyRowCount: controller.pendingChangesByRow.size,
          invalidRowCount: controller.invalidRowCount,
          invalidCellCount: controller.invalidCellCount,
          pendingEditsHidden: controller.pendingEditsHidden,
        };
        const existing = current.get(modelId);
        if (
          existing &&
          existing.dirtyCount === nextSnapshot.dirtyCount &&
          existing.readyRowCount === nextSnapshot.readyRowCount &&
          existing.invalidRowCount === nextSnapshot.invalidRowCount &&
          existing.invalidCellCount === nextSnapshot.invalidCellCount &&
          existing.pendingEditsHidden === nextSnapshot.pendingEditsHidden
        ) {
          return current;
        }
        const next = new Map(current);
        next.set(modelId, nextSnapshot);
        return next;
      });
    },
    [onControllersChange, onDirtyEditCountChange, preview.rowsByModel],
  );

  useEffect(() => {
    return () => {
      onControllersChange?.(new Map());
    };
  }, [onControllersChange]);

  // Symmetric to the controllers cleanup above: when the panel unmounts
  // (stage navigates away from preview_save, agent reruns cleaning, etc.)
  // the grids unmount and their pending edits are gone — so the host's
  // mirrored dirty count must zero too. Without this, a count > 0
  // captured at the moment of unmount leaks into other stages' wipe-
  // warning modals (revise_step from clean_up_data would falsely claim
  // "N edits exist").
  useEffect(() => {
    return () => {
      onDirtyEditCountChange?.(0);
    };
  }, [onDirtyEditCountChange]);

  const effectiveModelTabs = useMemo(() => {
    return preview.modelTabs.map((tab) => {
      const snapshot = controllerSnapshot.get(tab.modelId);
      if (!snapshot) return tab;
      const needsReviewRowCount = snapshot.invalidRowCount;
      return {
        ...tab,
        readyRowCount: Math.max(0, snapshot.readyRowCount - needsReviewRowCount),
        needsReviewRowCount,
      };
    });
  }, [controllerSnapshot, preview.modelTabs]);

  const availableTabIds = useMemo(() => {
    const presentIds = new Set<string>(effectiveModelTabs.map((tab) => tab.modelId));
    if (
      effectiveModelTabs.some((tab) => tab.parseErrorRowCount + tab.needsReviewRowCount > 0) ||
      (preview.notices?.length ?? 0) > 0
    ) {
      presentIds.add(PREVIEW_ERRORS_TAB_ID);
    }
    return presentIds;
  }, [effectiveModelTabs, preview.notices]);

  const [suppressedUnavailableTabId, setSuppressedUnavailableTabId] = useState<string | null>(null);
  const effectiveActiveTabId = availableTabIds.has(activeTabId)
    ? suppressedUnavailableTabId === activeTabId
      ? (effectiveModelTabs[0]?.modelId ?? "")
      : activeTabId
    : (effectiveModelTabs[0]?.modelId ?? "");

  useEffect(() => {
    if (!availableTabIds.has(activeTabId)) setSuppressedUnavailableTabId(activeTabId);
  }, [activeTabId, availableTabIds]);

  const changeActiveTab = useCallback((nextActiveTabId: string) => {
    setSuppressedUnavailableTabId(null);
    setActiveTabId(nextActiveTabId);
  }, []);

  const stageFailureMessage = useMemo(() => {
    const messages: string[] = [];
    for (const [modelId, message] of stageFailuresByModel) {
      if (availableTabIds.has(modelId)) messages.push(message);
    }
    return messages.length === 0 ? null : messages.join("; ");
  }, [availableTabIds, stageFailuresByModel]);

  // Aggregated counts across all controllers. When a controller hasn't
  // reported yet we fall back to the preview's per-tab counts so the bar
  // is never blank on first mount.
  const aggregateCounts = useMemo(() => {
    let ready = 0;
    let needsReview = 0;
    let unchanged = 0;
    let parseErrors = 0;
    for (const tab of preview.modelTabs) {
      const snapshot = controllerSnapshot.get(tab.modelId);
      if (snapshot) {
        // Editable-grid dirtyCount is cell-based. The bar's ready tally is
        // row-based, so use the controller's row-keyed pending map instead.
        // Seeded review issues live in editable-grid invalid-cell state so
        // the blocker clears when the user fixes those cells.
        ready += Math.max(0, snapshot.readyRowCount - snapshot.invalidRowCount);
        needsReview += snapshot.invalidRowCount;
      } else {
        ready += tab.readyRowCount;
        needsReview += tab.needsReviewRowCount;
      }
      parseErrors += tab.parseErrorRowCount;
      unchanged += tab.unchangedRowCount ?? 0;
    }
    return { ready, needsReview, parseErrors, unchanged };
  }, [controllerSnapshot, preview.modelTabs]);

  return (
    <section
      data-source-import-preview-save
      data-active-tab-kind={effectiveActiveTabId === PREVIEW_ERRORS_TAB_ID ? "errors" : "model"}
      className={joinClassNames("preview-save-panel", className)}
      aria-label="Preview and save"
    >
      <PreviewSaveTabs
        className="preview-save-panel__tabs"
        tabs={effectiveModelTabs}
        noticeCount={preview.notices?.length ?? 0}
        activeTabId={effectiveActiveTabId}
        onActiveTabChange={changeActiveTab}
        renderActiveBody={(tabId) => {
          if (tabId === PREVIEW_ERRORS_TAB_ID) {
            return renderErrorsBody ? (
              renderErrorsBody()
            ) : (
              <DefaultParseErrorsBody
                preview={preview}
                copy={errorCopy}
                parseErrorCount={aggregateCounts.parseErrors}
                needsReviewCount={aggregateCounts.needsReview}
              />
            );
          }
          // We DON'T render the active body directly here — we render ALL
          // tab mounts side-by-side outside the active body, and use CSS
          // `display: none` to hide inactive ones. That preserves dirty
          // state across switches. Returning a placeholder is enough; the
          // mounts below cover the visual.
          return <div className="preview-save-panel__active-anchor" data-active-tab={tabId} />;
        }}
      />

      {/* The N controllers. Each renders inside its own div whose visibility
       * is toggled via display: none. Mounted in a stable order (modelTabs
       * iteration order) so React's reconciliation keeps controller
       * identity stable across re-renders. */}
      <div className="preview-save-panel__mounts">
        {preview.modelTabs.map((tab) => (
          <PreviewModelTabMount
            key={tab.modelId}
            tab={tab}
            visible={effectiveActiveTabId === tab.modelId}
            rows={preview.rowsByModel?.[tab.modelId]}
            schema={schema}
            scope={scope}
            asOf={asOf}
            fieldOverrides={fieldOverridesByModel[tab.modelId]}
            sourceKind={sourceKind}
            sourceRef={sourceRef}
            onStageFailure={setStageFailure}
            onController={registerController}
          />
        ))}
      </div>

      <PreviewSaveBar
        readyRowCount={aggregateCounts.ready}
        needsReviewRowCount={aggregateCounts.needsReview}
        parseErrorRowCount={aggregateCounts.parseErrors}
        unchangedRowCount={aggregateCounts.unchanged}
        blockingReason={
          stageFailureMessage
            ? "stage_errors"
            : (blockingReason ??
              (aggregateCounts.needsReview > 0
                ? "needs_review_rows"
                : ((preview.saveBlockingReason === "needs_review_rows"
                    ? undefined
                    : preview.saveBlockingReason) ??
                  (aggregateCounts.ready === 0 ? "no_changes" : undefined))))
        }
        saving={props.saving}
        onSave={props.onSave}
        onDiscardAll={props.onDiscardAll}
        asOf={asOf}
        {...(stageFailureMessage
          ? { saveErrorMessage: stageFailureMessage }
          : props.saveErrorMessage === undefined
            ? {}
            : { saveErrorMessage: props.saveErrorMessage })}
      />
    </section>
  );
}

function NoticesSection(props: { preview: WriteBoundImportPreview }) {
  const notices = props.preview.notices ?? [];
  if (notices.length === 0) return null;
  return (
    <section className="preview-save-panel__notices" aria-label="Import notices">
      <p className="preview-save-panel__notices-title">
        {notices.length} {notices.length === 1 ? "notice" : "notices"} (does not block Save)
      </p>
      <ul className="preview-save-panel__notices-list" role="list">
        {notices.map((notice) => (
          <li key={`${notice.modelId}:${notice.code}:${notice.message}`}>
            <span className="preview-save-panel__notices-code">{notice.code}</span>
            <span className="preview-save-panel__notices-message">{notice.message}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function DefaultParseErrorsBody(props: {
  preview: WriteBoundImportPreview;
  copy?: PreviewSavePanelErrorCopy;
  parseErrorCount: number;
  needsReviewCount: number;
}) {
  const issues = props.preview.parseIssues ?? [];
  const copy = props.copy ?? {
    ariaLabel: "Import row issues",
    issueNoun: "row issue",
  };
  const totalIssueCount = props.parseErrorCount + props.needsReviewCount;
  if (issues.length === 0) {
    // The synthetic Issues tab badge counts parse errors AND live
    // needs-review rows, so this fallback summary must match it — and the
    // guidance must split by issue kind: review rows are fixable in the
    // model-tab grids, parse errors only upstream.
    const guidance = [
      props.needsReviewCount > 0 ? "Fix the highlighted cells in the model tabs." : null,
      props.parseErrorCount > 0
        ? "Return to Clean up data to revise the import plan or fix the source file."
        : null,
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <div className="preview-save-panel__errors" aria-label="Import row issues">
        {totalIssueCount > 0 ? (
          <p className="preview-save-panel__errors-summary">
            {totalIssueCount} {totalIssueCount === 1 ? "row issue" : "row issues"} blocked Save.
            {guidance ? ` ${guidance}` : ""}
          </p>
        ) : null}
        <NoticesSection preview={props.preview} />
      </div>
    );
  }
  if (totalIssueCount === 0) {
    return (
      <div className="preview-save-panel__errors" aria-label={copy.ariaLabel}>
        <p className="preview-save-panel__errors-summary">
          No {pluralize(copy.issueNoun, 2)} currently block Save.
        </p>
        <NoticesSection preview={props.preview} />
      </div>
    );
  }
  return (
    <div className="preview-save-panel__errors" aria-label={copy.ariaLabel}>
      <p className="preview-save-panel__errors-summary">
        {issues.length} {pluralize(copy.issueNoun, issues.length)} blocked Save.
        {props.needsReviewCount > 0
          ? ` ${props.needsReviewCount} more ${props.needsReviewCount === 1 ? "row needs" : "rows need"} review — fix the highlighted cells in the model tabs.`
          : ""}
      </p>
      <table className="preview-save-panel__errors-table">
        <thead>
          <tr>
            <th scope="col">Row</th>
            <th scope="col">Model</th>
            <th scope="col">Issue</th>
          </tr>
        </thead>
        <tbody>
          {issues.map((issue) => (
            <tr key={`${parseIssueKey(issue)}:${issue.message}`}>
              <td>{issue.sourceRowNumber}</td>
              <td>{modelLabel(props.preview, issue.modelId)}</td>
              <td>
                <span className="preview-save-panel__errors-code">{issue.code}</span>
                <span className="preview-save-panel__errors-message">{issue.message}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* Below the blocking table: notices must never visually bury an
          issue that gates Save. */}
      <NoticesSection preview={props.preview} />
    </div>
  );
}

function pluralize(noun: string, count: number): string {
  return `${noun}${count === 1 ? "" : "s"}`;
}

function modelLabel(preview: WriteBoundImportPreview, modelId: ModelId): string {
  return preview.modelTabs.find((tab) => tab.modelId === modelId)?.label ?? modelId;
}

function parseIssueKey(issue: PreviewParseIssue): string {
  return `${issue.modelId}:${issue.rowIndex}:${issue.path}:${issue.code}`;
}

function invalidCellsForPreviewRow(
  issues: readonly PreviewRowIssue[] | undefined,
): Readonly<Record<FieldId, string>> | undefined {
  if (!issues || issues.length === 0) return undefined;
  const invalidCells: Record<FieldId, string> = {} as Record<FieldId, string>;
  for (const issue of issues) {
    if (!issue.fieldId) continue;
    invalidCells[issue.fieldId] = issue.message;
  }
  return Object.keys(invalidCells).length === 0 ? undefined : invalidCells;
}

type PreviewModelTabMountProps = {
  tab: PreviewModelTab;
  visible: boolean;
  rows: NonNullable<WriteBoundImportPreview["rowsByModel"]>[ModelId] | undefined;
  schema: Schema;
  scope: { appId: AppId; customerId: CustomerId };
  asOf: string;
  fieldOverrides: FieldOverrides | undefined;
  sourceKind: string;
  sourceRef: string | null | undefined;
  onStageFailure: (modelId: ModelId, message: string | null) => void;
  onController: (modelId: ModelId, controller: EditableGridPreviewController | null) => void;
};

// One editable-grid mount per model tab. Hook is called exactly once per
// child (per render), satisfying Rules of Hooks. Reports the controller
// up via the parent's `onController` callback on every render so the
// parent's aggregation reflects the latest controller state (dirty
// counts, submitting state, etc.).
function PreviewModelTabMount(props: PreviewModelTabMountProps) {
  const baseRows = useMemo(() => previewBaseRows(props.rows), [props.rows]);
  // The grid projects active custom fields into columns and row values itself.
  const { controller, surfaceProps } = useEditableRowVersionGridPreview(
    editableGridConfig(props, baseRows),
  );
  usePreviewModelTabController(props, controller);
  return (
    <PreviewModelTabMountBody {...props} controller={controller} surfaceProps={surfaceProps} />
  );
}

function editableGridConfig(props: PreviewModelTabMountProps, baseRows: VisibleRecord[]) {
  return {
    modelId: props.tab.modelId,
    asOf: props.asOf,
    scope: props.scope,
    rows: baseRows,
    schema: props.schema,
    model: props.tab.modelId,
    fieldOverrides: props.fieldOverrides,
    sourceKind: props.sourceKind,
    sourceRef: props.sourceRef,
    mode: "edit" as const,
    changeTypeId: previewChangeTypeId(props.rows),
  };
}

function previewChangeTypeId(rows: PreviewModelTabMountProps["rows"]): ChangeTypeId | undefined {
  const rowChangeTypes = [...(rows?.existing ?? []), ...(rows?.creates ?? [])].map(
    (row) => row.changeTypeId,
  );
  const first = rowChangeTypes[0];
  return first !== undefined && rowChangeTypes.every((changeTypeId) => changeTypeId === first)
    ? first
    : undefined;
}

function previewBaseRows(rows: PreviewModelTabMountProps["rows"]): VisibleRecord[] {
  return (rows?.existing ?? []).map((row) => ({
    record_id: row.recordId,
    effective_start: row.effectiveStart,
    effective_end: null,
    values: Object.fromEntries(
      Object.entries(row.priorValues).filter(([, value]) => value !== null),
    ) as VisibleRecord["values"],
    custom_fields: row.priorCustomFields ?? [],
  }));
}

type PreviewModelTabMountBodyProps = PreviewModelTabMountProps & {
  controller: EditableGridPreviewController;
  surfaceProps: ReturnType<typeof useEditableRowVersionGridPreview>["surfaceProps"];
};

function PreviewModelTabMountBody(props: PreviewModelTabMountBodyProps) {
  const { tab, visible, surfaceProps } = props;
  return (
    <div
      className="preview-save-panel__mount"
      data-model-id={tab.modelId}
      data-visible={visible ? "true" : "false"}
      style={{ display: visible ? undefined : "none" }}
      aria-hidden={!visible}
    >
      <EditableRowVersionGrid
        {...surfaceProps}
        fullWidthCellRendererParams={{
          ...surfaceProps.fullWidthCellRendererParams,
          effectiveDateReadOnly: true,
        }}
      />
    </div>
  );
}

function usePreviewModelTabController(
  props: PreviewModelTabMountProps,
  controller: EditableGridPreviewController,
): void {
  const { tab, rows, onStageFailure, onController } = props;
  const previewStageKey = useMemo(() => {
    return JSON.stringify(rows ?? {});
  }, [rows]);

  const stagedPreviewKeyRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!rows) return;
    if (stagedPreviewKeyRef.current === previewStageKey) return;
    stagedPreviewKeyRef.current = previewStageKey;
    const stagingController = controller;
    onStageFailure(tab.modelId, null);
    const stageFailures: string[] = [];
    for (const row of rows.existing ?? []) {
      const values: Record<FieldId, FieldValue | null> = {
        ...projectCustomFields(row.values, row.customFields ?? []),
      };
      // A clear of a cell that is already empty is not a change.
      const priorValues = projectCustomFields(row.priorValues, row.priorCustomFields ?? []);
      for (const fieldId of row.clearFields ?? []) {
        if (priorValues[fieldId] != null) values[fieldId] = null;
      }
      const result = stagingController.stageBulkUpdate({
        rows: [{ rowKey: row.recordId }],
        values,
        bulkGroupId: `source-import:${tab.modelId}`,
        effectiveStart: row.effectiveStart,
        changeTypeId: row.changeTypeId,
        initialInvalidCells: invalidCellsForPreviewRow(row.issues),
      });
      if (!result.ok) {
        stageFailures.push(
          ...result.failures.map(
            (failure) => `${failure.rowKey}.${failure.fieldId}: ${failure.message}`,
          ),
        );
      }
    }
    for (const row of rows.creates ?? []) {
      stagingController.stageNewRecord(
        projectCustomFields(row.values, row.customFields ?? []) as Record<FieldId, FieldValue>,
        {
          effectiveStart: row.effectiveStart,
          changeTypeId: row.changeTypeId,
          recordKey: row.recordKey,
          newRecordId: row.newRecordId,
          tempRowKey: row.tempRowId,
          initialInvalidCells: invalidCellsForPreviewRow(row.issues),
        },
      );
    }
    if (stageFailures.length > 0) {
      onStageFailure(tab.modelId, stageFailures.join("; "));
    }
    return () => {
      if (stagedPreviewKeyRef.current === previewStageKey) {
        stagedPreviewKeyRef.current = null;
      }
    };
  }, [onStageFailure, previewStageKey, rows, tab.modelId]);

  // Report controller up. The parent treats unreported tabs as "preview
  // counts only" and reported tabs as "live controller counts," so the
  // identity here matters — `useEffect`-on-every-render keeps the parent
  // state in sync with each render-time controller snapshot.
  const previousModelIdRef = useRef<ModelId | null>(null);
  useLayoutEffect(() => {
    onController(tab.modelId, controller);
    previousModelIdRef.current = tab.modelId;
  }, [controller, onController, tab.modelId]);

  // Cleanup: when this mount unmounts (tab disappears or panel
  // re-keys), drop the controller from the parent registry so stale
  // counts don't linger.
  useLayoutEffect(() => {
    return () => {
      const modelId = previousModelIdRef.current;
      if (modelId) {
        onStageFailure(modelId, null);
        onController(modelId, null);
      }
    };
  }, [onController, onStageFailure]);
}
