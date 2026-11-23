import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  ColDef,
  EditableCallbackParams,
  GridApi,
  GridReadyEvent,
  IRowNode,
  IsFullWidthRowParams,
  RowHeightParams,
  ValueGetterParams,
  ValueSetterParams,
} from "ag-grid-community";

import {
  fieldValueEqual,
  fieldValuePrimitive,
  makeFieldValue,
} from "@engines/field-value-adapter/index";
import {
  activeCustomFieldIds,
  projectRecordCustomFields,
  schemaWithCustomFields,
  splitCustomFieldsFromWrites,
} from "@engines/custom-field-projection/index";
import {
  createEditBuffer,
  type CellAddress,
  type EditBuffer,
  type EditEntry,
  type EditMeta,
  type EditSource,
  type PendingFieldValue,
} from "@engines/edit-buffer/index";
import type { FieldValidator } from "@engines/field-validation/index";
import { safeUuid } from "@engines/uuid/index";
import type {
  ChangeTypeId,
  CustomFieldEntry,
  ErrorEnvelope,
  FieldId,
  FieldValue,
  ModelId,
  RecordKey,
  RecordId,
  RowVersionWrite,
  VisibleRecord,
} from "@contracts";

import {
  useApplyChangeSet,
  isSingleFlightBlocked,
  type ApplyChangeSetPayload,
} from "./hooks/useApplyChangeSet";
import { extractAppliedChangeSetId } from "./apply-result";
import { useEditBuffer, type EditBufferState } from "./hooks/useEditBuffer";
import { makeDiffCellRenderer } from "./diff-cell-renderer";
import { buildSchemaColumnDefs, type BuildSchemaColumnsOptions } from "./schema-columns";
import { isMetaRow } from "./row-meta-model";
import type { ChangeTypeOption, MetaRowMarker } from "./row-meta-row";
import { entriesToWrites, partitionEntriesForSave } from "./save-partitioning";
import { EDITABLE_GRID_TEMP_ROW_KEY_PREFIX, isEditableGridTempRowKey } from "./temp-row-key";
import type {
  HostStagedCell,
  HostStaging,
  EditableGridController,
  EditableGridPreviewController,
  EditableGridMode,
  EditableRowVersionGridSurfaceProps,
  GridColumnContext,
  RowChangeSummary,
  SaveChangeSetResult,
  SaveOutcome,
  StageBulkUpdateResult,
  UseEditableRowVersionGridConfig,
  UseEditableRowVersionGridPreviewConfig,
} from "./types";
import { EMPTY_SAVE_OUTCOME } from "./types";

export function useEditableRowVersionGrid(config: UseEditableRowVersionGridConfig): {
  controller: EditableGridController;
  surfaceProps: EditableRowVersionGridSurfaceProps;
} {
  const applyBinding = useApplyChangeSet(config.client);
  return useEditableRowVersionGridCore(config, applyBinding);
}

export function useEditableRowVersionGridPreview(config: UseEditableRowVersionGridPreviewConfig): {
  controller: EditableGridPreviewController;
  surfaceProps: EditableRowVersionGridSurfaceProps;
} {
  const { controller, surfaceProps } = useEditableRowVersionGridCore(config, null);
  const {
    lastSaveOutcome: _lastSaveOutcome,
    prepareAtomicSave: _prepareAtomicSave,
    save: _save,
    submitError: _submitError,
    submitting: _submitting,
    ...previewController
  } = controller;
  return { controller: previewController, surfaceProps };
}

type EditableRowVersionGridCoreConfig = UseEditableRowVersionGridPreviewConfig &
  Partial<
    Pick<
      UseEditableRowVersionGridConfig,
      | "idempotencyKeyForChangeType"
      | "onApplied"
      | "onApplyError"
      | "saveSource"
      | "saveMode"
      | "transformWrites"
    >
  >;

function useEditableRowVersionGridCore(
  config: EditableRowVersionGridCoreConfig,
  applyBinding: ReturnType<typeof useApplyChangeSet> | null,
): {
  controller: EditableGridController;
  surfaceProps: EditableRowVersionGridSurfaceProps;
} {
  const {
    modelId,
    asOf,
    scope,
    rows: suppliedRows,
    schema,
    model,
    fieldOverrides,
    fieldOrder,
    hidden,
    relationOptionsByModel,
    relationSearchByModel,
    onRelationOptionPicked,
    changeTypeId,
    sourceKind = "user",
    sourceRef,
    saveSource,
    idempotencyKeyForChangeType,
    saveMode = "mainline",
    transformWrites,
    onApplied,
    onApplyError,
    mode = "edit",
    inferChangeType,
    bulkGroupLabel: bulkGroupLabelProp,
    bulkGroupNotes,
    changeTypeLabel: changeTypeLabelProp,
    onClickBulkLink: onClickBulkLinkProp,
    changeTypeOptions: changeTypeOptionsProp,
    hostStaging,
    cellNote,
    cellPin,
    cellMark,
    rowReadOnly,
  } = config;
  // The host's latest read-only answer, read per cell by editability and by
  // the value setters (an editor opened before its row turned read-only).
  const rowReadOnlyRef = useRef(rowReadOnly);
  rowReadOnlyRef.current = rowReadOnly;

  // Tenant custom fields are ordinary columns here: the model's active
  // definitions are projected into the column schema, each row's active
  // custom values into `values`, and Save routes them back to
  // `custom_fields` / `clear_custom_fields`. Pages get this for free.
  const customFieldIds = useMemo(
    () => (schema ? activeCustomFieldIds(schema, modelId) : EMPTY_FIELD_IDS),
    [schema, modelId],
  );
  const columnSchema = useMemo(() => (schema ? schemaWithCustomFields(schema) : null), [schema]);
  // Emptying a cell clears the stored value for optional fields (declared or
  // custom); required fields refuse it.
  const requiredFieldIds = useMemo<ReadonlySet<FieldId>>(
    () =>
      new Set(
        (columnSchema?.models.find((candidate) => candidate.id === modelId)?.fields ?? []).flatMap(
          (field) => (field.required ? [field.id] : []),
        ),
      ),
    [columnSchema, modelId],
  );
  const rows = useMemo(
    () =>
      customFieldIds.size === 0
        ? suppliedRows
        : suppliedRows.map((row) => projectRecordCustomFields(row, customFieldIds)),
    [customFieldIds, suppliedRows],
  );
  const finalizeWrites = useCallback(
    (compiledWrites: RowVersionWrite[]): RowVersionWrite[] => {
      const canonical = schema
        ? splitCustomFieldsFromWrites(compiledWrites, schema)
        : compiledWrites;
      return transformWrites ? [...transformWrites(canonical)] : canonical;
    },
    [schema, transformWrites],
  );

  const localBuffer = useEditBuffer();
  const host = useHostStagingBuffer(hostStaging, modelId, asOf);
  // Host staging swaps the local buffer for the host's pending set: reads see
  // it, and edits and reverts go to the host instead of being buffered here.
  const {
    buffer,
    set,
    updateMeta,
    clear,
    revert,
    revertRow,
    revertMatching,
    isDirty,
    current: liveBuffer,
  } = host ?? localBuffer;
  const hosted = host !== null;
  // Under host staging the pending set and rows change while a cell editor
  // may be open (an agent stages another row). Rebuilding the columns would
  // close that editor, so the column callbacks read the host's latest pending
  // set and rows through `readBuffer` and `readRowsByKey`, and a host change
  // only repaints cells (see the effect after `columnDefs`). Without a host
  // they close over the buffer and rows, and the columns rebuild with them.
  const columnBuffer = hosted ? null : buffer;
  const readBuffer = useCallback(() => columnBuffer ?? liveBuffer(), [columnBuffer, liveBuffer]);
  const [atomicSubmitting, setAtomicSubmitting] = useState(false);
  const saveOperationTokenRef = useRef<symbol | null>(null);
  const submitting = (applyBinding?.submitting ?? false) || atomicSubmitting;
  const submitError = applyBinding?.error ?? null;
  const apply = applyBinding?.apply ?? null;

  // Captured so revert paths can force AG Grid to repaint restored cells.
  const gridApiRef = useRef<GridApi<VisibleRecord | MetaRowMarker> | null>(null);
  const onGridReady = useCallback((event: GridReadyEvent<VisibleRecord | MetaRowMarker>) => {
    gridApiRef.current = event.api;
  }, []);

  // External filter state. filterVersion forces AG Grid to re-run external
  // filters when controller-owned toggles change.
  const [activeBulkFilter, setActiveBulkFilter] = useState<string | null>(null);
  const [showChangesOnly, setShowChangesOnly] = useState<boolean>(false);
  const filterVersion = useMemo(() => {
    let hash = 0;
    if (activeBulkFilter) {
      for (let i = 0; i < activeBulkFilter.length; i += 1) {
        hash = (hash * 31 + activeBulkFilter.charCodeAt(i)) | 0;
      }
    }
    return hash * 2 + (showChangesOnly ? 1 : 0);
  }, [activeBulkFilter, showChangesOnly]);

  const rowsByKey = useMemo(() => {
    const map = new Map<string, VisibleRecord>();
    for (const row of rows) map.set(row.record_id, row);
    return map;
  }, [rows]);
  const rowsByKeyRef = useRef(rowsByKey);
  rowsByKeyRef.current = rowsByKey;
  const columnRowsByKey = hosted ? null : rowsByKey;
  const readRowsByKey = useCallback(
    () => columnRowsByKey ?? rowsByKeyRef.current,
    [columnRowsByKey],
  );

  const hostPrior = host?.prior;
  // The value last handed to the host for a cell while the host has not yet
  // reflected it; `undefined` when none is outstanding (always without a host).
  const hostOutstanding = host?.outstanding;
  // Host staging records who staged each cell; the buffer only keeps a row's last source.
  const hostSourceGetter = host?.source;
  const hostSettlingGetter = host?.settling;
  const getPrior = useCallback(
    (rowKey: string, fieldId: FieldId): FieldValue | null | undefined => {
      // A host-staged cell replaced the value the host recorded, not the row's.
      const prior = hostPrior?.(rowKey, fieldId);
      if (prior !== undefined) return prior;
      return readRowsByKey().get(rowKey)?.values[fieldId] ?? null;
    },
    [hostPrior, readRowsByKey],
  );

  const getProjectedValue = useCallback(
    (rowKey: string, fieldId: FieldId): FieldValue | null => {
      // Under host staging an edit handed over is the cell's value until the
      // host shows it (or refuses it): the cell never shows the old value in between.
      const outstanding = hostOutstanding?.(rowKey, fieldId);
      if (outstanding !== undefined) return outstanding;
      const edit = readBuffer().getEdit({ rowKey, fieldId });
      // A pending clear (`null`) projects as empty; only an absent edit falls
      // back to the row's current value.
      if (edit !== undefined) return edit;
      return readRowsByKey().get(rowKey)?.values[fieldId] ?? null;
    },
    [hostOutstanding, readBuffer, readRowsByKey],
  );

  const rowWithPendingValue = useCallback(
    (row: VisibleRecord, fieldId: FieldId, value: FieldValue | null): VisibleRecord =>
      rowWithPendingValues(row, readBuffer().entries(), { [fieldId]: value }),
    [readBuffer],
  );

  const editSourceForSourceKind = useCallback((kind: string): EditSource => {
    if (kind === "agent") return "agent";
    if (kind === "import" || kind === "data_import") return "import";
    return "user";
  }, []);

  const rowMetaForEdit = useCallback(
    (
      rowKey: string,
      opts?: {
        effectiveStart?: string;
        changeTypeId?: ChangeTypeId;
        bulkGroupId?: string;
        sourceKind?: string;
        sourceRef?: string | null;
      },
    ): EditMeta => {
      // The live buffer, so a row staged earlier in the same tick keeps its
      // subject and date.
      const pending = liveBuffer();
      const existingChangeTypeId = changeTypeIdForRow(rowKey, pending);
      const existingBulkGroupId = bulkGroupIdForRow(rowKey, pending);
      return {
        modelId,
        recordKey: recordKeyForRowEdit(rowKey, pending),
        newRecordId: newRecordIdForRowEdit(rowKey, pending),
        effectiveStart: opts?.effectiveStart ?? effectiveStartForRowEdit(rowKey, asOf, pending),
        sourceKind: opts?.sourceKind ?? "user",
        sourceRef: opts?.sourceRef ?? null,
        ...((opts?.bulkGroupId ?? existingBulkGroupId)
          ? { bulkGroupId: opts?.bulkGroupId ?? existingBulkGroupId }
          : {}),
        ...((opts?.changeTypeId ?? existingChangeTypeId)
          ? { changeTypeId: opts?.changeTypeId ?? existingChangeTypeId }
          : {}),
      };
    },
    [asOf, liveBuffer, modelId],
  );

  // Force AG Grid to drop cached renders after row.values restoration.
  const refreshCellsFor = useCallback(
    (rowKeys: ReadonlyArray<string>, fieldIds?: ReadonlyArray<FieldId>) => {
      const api = gridApiRef.current;
      if (!api || rowKeys.length === 0) return;
      const rowNodes = rowKeys
        .map((id) => api.getRowNode(id))
        .filter((n): n is IRowNode<VisibleRecord | MetaRowMarker> => n != null);
      if (rowNodes.length === 0) return;
      api.refreshCells({
        rowNodes,
        columns: fieldIds ? Array.from(fieldIds) : undefined,
        force: true,
      });
    },
    [],
  );

  // Drafts synthesized from new-record buffer entries, in the order the
  // user staged them (see `draftRowsFromEntries`).
  const newRowDrafts = useMemo<VisibleRecord[]>(
    () => Array.from(draftRowsFromEntries(buffer.entries(), customFieldIds).values()),
    [buffer, customFieldIds],
  );

  // Per-cell validation errors; keyed `${rowId}::${fieldId}` to match the
  // dirty-cell address shape. State so the AG Grid render picks up changes
  // via columnDefs deps rebuilding.
  const [invalidCells, setInvalidCells] = useState<Map<string, InvalidCell>>(() => new Map());

  const invalidRowCount = useMemo(() => {
    const rowsWithInvalidCells = new Set<string>();
    for (const key of invalidCells.keys()) {
      const separator = key.indexOf("::");
      rowsWithInvalidCells.add(separator === -1 ? key : key.slice(0, separator));
    }
    return rowsWithInvalidCells.size;
  }, [invalidCells]);

  const stageNewRecord = useCallback(
    (
      values: Record<FieldId, FieldValue>,
      options?: {
        effectiveStart?: string;
        changeTypeId?: ChangeTypeId;
        recordKey?: RecordKey;
        newRecordId?: RecordId;
        tempRowKey?: string;
        initialInvalidCells?: Readonly<Record<FieldId, string>>;
      },
    ) => {
      // Read mode rejects new-record staging too. The controller exposed in
      // read mode also returns a no-op `stageNewRecord`, but routing the
      // refusal through here as well means a stray caller can't sneak
      // entries into the buffer if the gating layer is bypassed.
      if (mode === "read" || submitting) return { tempRowKey: "" };
      // `safeUuid` requires `crypto.randomUUID()` so unsupported browser
      // environments fail loud before draft row grouping can degrade.
      const suppliedTempRowKey = options?.tempRowKey;
      const tempRowKey =
        suppliedTempRowKey && isEditableGridTempRowKey(suppliedTempRowKey)
          ? suppliedTempRowKey
          : `${EDITABLE_GRID_TEMP_ROW_KEY_PREFIX}${safeUuid()}`;
      const meta = {
        modelId,
        effectiveStart: options?.effectiveStart ?? asOf,
        recordKey: options?.recordKey,
        newRecordId: options?.newRecordId,
        sourceKind,
        sourceRef: sourceRef ?? null,
        ...(options?.changeTypeId ? { changeTypeId: options.changeTypeId } : {}),
      };
      const editSource = editSourceForSourceKind(sourceKind);
      // Stage one pending row with one value entry per provided field. Each
      // value still projects as a dirty cell, but source/provenance are
      // row-level.
      for (const [fieldId, value] of Object.entries(values)) {
        set({ rowKey: tempRowKey, fieldId }, value, editSource, meta);
      }
      const initialInvalidCells = options?.initialInvalidCells;
      if (
        options?.tempRowKey ||
        (initialInvalidCells && Object.keys(initialInvalidCells).length > 0)
      ) {
        setInvalidCells((current) => {
          const next = new Map(current);
          const prefix = `${tempRowKey}::`;
          for (const key of Array.from(next.keys())) {
            if (key.startsWith(prefix)) next.delete(key);
          }
          for (const [fieldId, message] of Object.entries(initialInvalidCells ?? {})) {
            next.set(`${tempRowKey}::${fieldId}`, {
              message,
              source: "seeded",
            });
          }
          return next;
        });
      }
      return { tempRowKey };
    },
    [asOf, editSourceForSourceKind, mode, modelId, set, sourceKind, sourceRef, submitting],
  );

  // Registry of per-field validators keyed by fieldId. Populated as a side
  // effect of `fieldSetter` / `fieldSetterFromValue` factory calls (schema
  // column construction invokes them, so the registry is repopulated on
  // every render where the column config rebuilds — fields without an
  // `options.validate` are explicitly cleared so a previous render's
  // validator can't haunt the registry after the column drops it).
  //
  // Side-effect-during-render note: writing to `validatorsRef.current` from
  // inside the factory runs during React's render phase. Strict-mode double-
  // invocation calls the factory twice; both invocations write the SAME
  // (validator, fieldId) pair, so the second overwrites the first
  // idempotently. Safe by construction; no useEffect indirection needed.
  //
  // Caveat — dropped-validator stale invalid: removing `options.validate`
  // from a column between renders updates the registry (eviction works) but
  // does NOT walk `invalidCells` to evict any entry that the dropped
  // validator previously created. Such an entry would persist red until the
  // next successful commit on that row (which re-evaluates via
  // `reevaluateRowSiblings` against the now-undefined sibling validator and
  // skips it) or a save success (which clears `invalidCells` wholesale).
  // Acceptable for V0 — apps don't dynamically toggle validators per render.
  //
  // Used by the successful-commit branches to re-evaluate OTHER invalid
  // cells in the same row whose validators may reference the just-committed
  // field via `ctx.row?.values[siblingFieldId]` (e.g. `dateBefore` reading
  // its partner end-date field). Without this, a stale invalidKey from a
  // rejected start_date commit would persist red on the cell even after
  // the user edits end_date to a value that makes the projected row valid.
  //
  // Scope: re-evaluates only entries already in `invalidCells`. Buffer
  // entries (successfully-committed values that may become invalid in
  // light of later edits) are out of scope — those are server-validated at
  // apply time and surface via the kernel's ErrorEnvelope path, not the
  // pre-commit field-validation engine.
  const validatorsRef = useRef<Map<FieldId, FieldValidator> | null>(null);
  if (validatorsRef.current === null) {
    validatorsRef.current = new Map();
  }

  // Treat modelId changes as a fresh mount; buffer metadata is model-scoped.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state -- model changes reset independent buffer, validation, save outcome, and filter stores.
  useLayoutEffect(() => {
    saveOperationTokenRef.current = null;
    setAtomicSubmitting(false);
    clear();
    setInvalidCells(EMPTY_INVALID_CELLS);
    validatorsRef.current!.clear();
    setLastSaveOutcome(EMPTY_SAVE_OUTCOME);
    setActiveBulkFilter(null);
    setShowChangesOnly(false);
  }, [modelId, clear]);

  const registerValidator = useCallback(
    (fieldId: FieldId, validator: FieldValidator | undefined) => {
      if (validator) {
        validatorsRef.current!.set(fieldId, validator);
      } else {
        validatorsRef.current!.delete(fieldId);
      }
    },
    [],
  );

  // Drop any sibling invalidKey in the same row whose registered validator
  // now passes against the projected row state.
  const reevaluateRowSiblings = useCallback((row: VisibleRecord, justCommittedFieldId: FieldId) => {
    setInvalidCells((current) => {
      const rowPrefix = `${row.record_id}::`;
      const next = new Map(current);
      let changed = false;
      for (const key of Array.from(next.keys())) {
        if (!key.startsWith(rowPrefix)) continue;
        const invalidCell = next.get(key);
        if (invalidCell?.source === "seeded") continue;
        const siblingFieldId = key.slice(rowPrefix.length);
        if (siblingFieldId === justCommittedFieldId) continue;
        const siblingValidator = validatorsRef.current!.get(siblingFieldId);
        if (!siblingValidator) continue;
        const siblingValue = row.values[siblingFieldId] ?? null;
        const result = siblingValidator(siblingValue, {
          row,
          fieldId: siblingFieldId,
        });
        if (result.ok) {
          next.delete(key);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, []);

  const clearInvalidCellIfCurrentValueIsValid = useCallback(
    (
      row: VisibleRecord,
      fieldId: FieldId,
      value: FieldValue | null,
      validate: FieldValidator | undefined,
    ) => {
      const invalidKey = `${row.record_id}::${fieldId}`;
      if (validate) {
        const result = validate(value, { row, fieldId });
        if (!result.ok) {
          setInvalidCells((current) => {
            const existing = current.get(invalidKey);
            if (existing?.source === "validator" && existing.message === result.message) {
              return current;
            }
            const updated = new Map(current);
            updated.set(invalidKey, {
              message: result.message,
              source: "validator",
            });
            return updated;
          });
          return;
        }
      }
      setInvalidCells((current) => {
        if (!current.has(invalidKey)) return current;
        const updated = new Map(current);
        updated.delete(invalidKey);
        return updated;
      });
    },
    [],
  );

  // Clearing a cell whose saved value is already empty is not a change: drop
  // any pending edit on it instead of staging a clear. Returns true when the
  // clear was absorbed this way. A staged new row has no saved row; its
  // baseline is empty, but a required field on it must still be refused.
  const dropRedundantClear = useCallback(
    (rowKey: string, fieldId: FieldId): boolean => {
      const row = readRowsByKey().get(rowKey);
      if (row ? (row.values[fieldId] ?? null) !== null : requiredFieldIds.has(fieldId)) {
        return false;
      }
      // A host-staged cell cleared is an edit the host stages, not a revert;
      // so is one whose edit the host has not reflected yet.
      if (
        hosted &&
        (readBuffer().has({ rowKey, fieldId }) || hostOutstanding?.(rowKey, fieldId) != null)
      )
        return false;
      if (readBuffer().has({ rowKey, fieldId })) {
        revert({ rowKey, fieldId });
        refreshCellsFor([rowKey], [fieldId]);
      }
      const invalidKey = `${rowKey}::${fieldId}`;
      setInvalidCells((current) => {
        if (!current.has(invalidKey)) return current;
        const next = new Map(current);
        next.delete(invalidKey);
        return next;
      });
      // The field is back at its saved (empty) value: cross-field errors on
      // its siblings may clear.
      if (row) reevaluateRowSiblings(rowWithPendingValue(row, fieldId, null), fieldId);
      return true;
    },
    [
      hosted,
      hostOutstanding,
      readBuffer,
      readRowsByKey,
      reevaluateRowSiblings,
      refreshCellsFor,
      requiredFieldIds,
      revert,
      rowWithPendingValue,
    ],
  );

  // A required field cannot be emptied: flag the cell instead of staging.
  // Returns true when the clear was refused.
  const refuseRequiredClear = useCallback(
    (rowKey: string, fieldId: FieldId): boolean => {
      if (!requiredFieldIds.has(fieldId)) return false;
      const invalidKey = `${rowKey}::${fieldId}`;
      setInvalidCells((current) => {
        const existing = current.get(invalidKey);
        if (existing?.message === REQUIRED_CLEAR_MESSAGE) return current;
        const next = new Map(current);
        next.set(invalidKey, { message: REQUIRED_CLEAR_MESSAGE, source: "validator" });
        return next;
      });
      refreshCellsFor([rowKey], [fieldId]);
      return true;
    },
    [refreshCellsFor, requiredFieldIds],
  );

  const fieldGetter = useCallback(
    (fieldId: FieldId) => {
      return (params: ValueGetterParams<VisibleRecord>) =>
        params.data ? fieldValuePrimitive(getProjectedValue(params.data.record_id, fieldId)) : null;
    },
    [getProjectedValue],
  );

  const fieldValueGetter = useCallback(
    (fieldId: FieldId) => {
      return (params: ValueGetterParams<VisibleRecord>): FieldValue | null =>
        params.data ? getProjectedValue(params.data.record_id, fieldId) : null;
    },
    [getProjectedValue],
  );

  const fieldSetterFromValue = useCallback(
    (fieldId: FieldId, options?: { validate?: FieldValidator }) => {
      // Register (or unregister) the validator at FACTORY-call time so the
      // validator is available for sibling re-evaluation even before the
      // user touches the cell. Schema-column construction invokes the factory
      // once per column per render, so this stays in sync with column config.
      registerValidator(fieldId, options?.validate);
      return (params: ValueSetterParams<VisibleRecord>): boolean => {
        // Backstop for read mode even if a column accidentally stays editable.
        if (mode === "read") return false;
        if (submitting) {
          // eslint-disable-next-line no-console
          console.warn("[editable-grid] ignoring fieldSetterFromValue during in-flight save");
          return false;
        }
        if (!params.data) return false;
        if (rowReadOnlyRef.current?.(params.data.record_id) === true) return false;
        const supplied = params.newValue as FieldValue | null | undefined;
        // Emptying an already-empty cell is a no-op (checked first, so a
        // required cell that is already empty is not flagged); emptying an
        // optional cell stages an explicit clear, a required one is refused.
        if (supplied == null && dropRedundantClear(params.data.record_id, fieldId)) return true;
        if (supplied == null && refuseRequiredClear(params.data.record_id, fieldId)) return false;
        const next: FieldValue | null = supplied == null ? null : supplied;
        if (
          next !== null &&
          (!next || typeof next !== "object" || typeof (next as FieldValue).type !== "string")
        ) {
          // Dev-loud misconfiguration: this setter only accepts FieldValue.
          // eslint-disable-next-line no-console
          console.warn(
            `[editable-grid] fieldSetterFromValue("${fieldId}") received non-FieldValue value:`,
            next,
            "Expected a wrapped FieldValue (e.g. { type: 'money_rate', value: {...} }). " +
              "Use ctx.fieldSetter(...) for primitive-emitting editors instead.",
          );
          return false;
        }
        const prior = getProjectedValue(params.data.record_id, fieldId);
        const projectedRow = rowWithPendingValue(params.data, fieldId, next);
        // Under host staging an edit the host has not reflected yet is what
        // the cell holds, so editing back to the shown value is still an edit.
        const outstanding = hostOutstanding?.(params.data.record_id, fieldId);
        if (fieldValueEqual(outstanding === undefined ? prior : outstanding, next)) {
          clearInvalidCellIfCurrentValueIsValid(projectedRow, fieldId, next, options?.validate);
          return false;
        }
        // Host staging sends every edit to the host, which decides; only an
        // explicit Restore unstages there.
        if (!hosted && fieldValueEqual(getPrior(params.data.record_id, fieldId), next)) {
          clearInvalidCellIfCurrentValueIsValid(projectedRow, fieldId, next, options?.validate);
          // Back at the saved value: cross-field errors on siblings may clear.
          reevaluateRowSiblings(projectedRow, fieldId);
          revert({ rowKey: params.data.record_id, fieldId });
          refreshCellsFor([params.data.record_id], [fieldId]);
          return true;
        }

        const invalidKey = `${params.data.record_id}::${fieldId}`;

        if (options?.validate) {
          const result = options.validate(next, { row: projectedRow, fieldId });
          if (!result.ok) {
            setInvalidCells((current) => {
              const updated = new Map(current);
              updated.set(invalidKey, {
                message: result.message,
                source: "validator",
              });
              return updated;
            });
            return false;
          }
        }

        setInvalidCells((current) => {
          if (!current.has(invalidKey)) return current;
          const updated = new Map(current);
          updated.delete(invalidKey);
          return updated;
        });

        // Re-run sibling invalid cells so cross-field errors can clear.
        reevaluateRowSiblings(projectedRow, fieldId);
        const meta = rowMetaForEdit(params.data.record_id, {
          sourceKind: "user",
          sourceRef: null,
        });
        set({ rowKey: params.data.record_id, fieldId }, next, "user", meta);
        refreshCellsFor([params.data.record_id], [fieldId]);
        return true;
      };
    },
    [
      clearInvalidCellIfCurrentValueIsValid,
      dropRedundantClear,
      getPrior,
      getProjectedValue,
      hosted,
      hostOutstanding,
      mode,
      reevaluateRowSiblings,
      refreshCellsFor,
      registerValidator,
      revert,
      rowMetaForEdit,
      rowWithPendingValue,
      refuseRequiredClear,
      set,
      submitting,
    ],
  );

  const fieldSetter = useCallback(
    (fieldId: FieldId, fieldType: FieldValue["type"], options?: { validate?: FieldValidator }) => {
      registerValidator(fieldId, options?.validate);
      return (params: ValueSetterParams<VisibleRecord>): boolean => {
        // Backstop for read mode even if a column accidentally stays editable.
        if (mode === "read") return false;
        if (submitting) {
          // eslint-disable-next-line no-console
          console.warn("[editable-grid] ignoring fieldSetter during in-flight save");
          return false;
        }
        if (!params.data) return false;
        if (rowReadOnlyRef.current?.(params.data.record_id) === true) return false;
        const prior = getProjectedValue(params.data.record_id, fieldId);
        // Emptying a cell (Delete key, a picker's Clear, or an editor
        // committing nothing) stages an explicit clear instead of an empty
        // value; required fields refuse it. Emptying an already-empty cell is
        // a no-op, checked first so it is never refused.
        const emptied = isEmptyPrimitive(params.newValue);
        if (emptied && dropRedundantClear(params.data.record_id, fieldId)) return true;
        if (emptied && refuseRequiredClear(params.data.record_id, fieldId)) return false;
        const next: FieldValue | null = emptied
          ? null
          : makeFieldValue(fieldType, params.newValue, prior);
        const projectedRow = rowWithPendingValue(params.data, fieldId, next);
        // Under host staging an edit the host has not reflected yet is what
        // the cell holds, so editing back to the shown value is still an edit.
        const outstanding = hostOutstanding?.(params.data.record_id, fieldId);
        if (fieldValueEqual(outstanding === undefined ? prior : outstanding, next)) {
          clearInvalidCellIfCurrentValueIsValid(projectedRow, fieldId, next, options?.validate);
          return false;
        }
        // Host staging sends every edit to the host, which decides; only an
        // explicit Restore unstages there.
        if (!hosted && fieldValueEqual(getPrior(params.data.record_id, fieldId), next)) {
          clearInvalidCellIfCurrentValueIsValid(projectedRow, fieldId, next, options?.validate);
          // Back at the saved value: cross-field errors on siblings may clear.
          reevaluateRowSiblings(projectedRow, fieldId);
          revert({ rowKey: params.data.record_id, fieldId });
          refreshCellsFor([params.data.record_id], [fieldId]);
          return true;
        }

        const invalidKey = `${params.data.record_id}::${fieldId}`;

        if (options?.validate) {
          const result = options.validate(next, { row: projectedRow, fieldId });
          if (!result.ok) {
            // Surface inline; don't mutate row data or dirty the buffer.
            setInvalidCells((current) => {
              const updated = new Map(current);
              updated.set(invalidKey, {
                message: result.message,
                source: "validator",
              });
              return updated;
            });
            return false;
          }
        }

        setInvalidCells((current) => {
          if (!current.has(invalidKey)) return current;
          const updated = new Map(current);
          updated.delete(invalidKey);
          return updated;
        });

        // Re-run sibling invalid cells so cross-field errors can clear.
        reevaluateRowSiblings(projectedRow, fieldId);
        const meta = rowMetaForEdit(params.data.record_id, {
          sourceKind: "user",
          sourceRef: null,
        });
        set({ rowKey: params.data.record_id, fieldId }, next, "user", meta);
        refreshCellsFor([params.data.record_id], [fieldId]);
        return true;
      };
    },
    [
      clearInvalidCellIfCurrentValueIsValid,
      dropRedundantClear,
      getPrior,
      getProjectedValue,
      hosted,
      hostOutstanding,
      mode,
      reevaluateRowSiblings,
      refreshCellsFor,
      registerValidator,
      revert,
      rowMetaForEdit,
      rowWithPendingValue,
      refuseRequiredClear,
      set,
      submitting,
    ],
  );

  const dirtyCellClassRules = useMemo<ColDef<VisibleRecord>["cellClassRules"]>(
    () => ({
      "ag-cell-dirty": (params) => {
        const fieldId = params.colDef.colId ?? params.colDef.field;
        if (!params.data || !fieldId) return false;
        return readBuffer().has({ rowKey: params.data.record_id, fieldId });
      },
    }),
    [readBuffer],
  );

  const invalidCellClassRules = useMemo<ColDef<VisibleRecord>["cellClassRules"]>(
    () => ({
      "ag-cell-invalid": (params) => {
        const fieldId = params.colDef.colId ?? params.colDef.field;
        if (!params.data || !fieldId) return false;
        return invalidCells.has(`${params.data.record_id}::${fieldId}`);
      },
    }),
    [invalidCells],
  );

  // Stage one field or a field map across rows under one bulk-group id.
  const stageBulkUpdate = useCallback(
    (
      opts:
        | {
            rows: ReadonlyArray<{ rowKey: string }>;
            fieldId: FieldId;
            value: FieldValue | null;
            bulkGroupId: string;
            effectiveStart?: string;
            changeTypeId?: ChangeTypeId;
            sourceKind?: string;
            sourceRef?: string | null;
            initialInvalidCells?: Readonly<Record<FieldId, string>>;
          }
        | {
            rows: ReadonlyArray<{ rowKey: string }>;
            values: Record<FieldId, FieldValue | null>;
            bulkGroupId: string;
            effectiveStart?: string;
            changeTypeId?: ChangeTypeId;
            sourceKind?: string;
            sourceRef?: string | null;
            initialInvalidCells?: Readonly<Record<FieldId, string>>;
          },
    ): StageBulkUpdateResult => {
      if (mode === "read") return { ok: true };
      const values: Record<FieldId, FieldValue | null> =
        "values" in opts ? opts.values : { [opts.fieldId]: opts.value };
      const fieldIds = Object.keys(values) as FieldId[];
      const initialInvalidCells = opts.initialInvalidCells;
      const hasInitialInvalidCells = Object.prototype.hasOwnProperty.call(
        opts,
        "initialInvalidCells",
      );
      if (fieldIds.length === 0 && !hasInitialInvalidCells) return { ok: true };
      if (submitting) {
        // eslint-disable-next-line no-console
        console.warn("[editable-grid] ignoring stageBulkUpdate during in-flight save");
        const blockedFieldIds =
          fieldIds.length > 0 ? fieldIds : (Object.keys(initialInvalidCells ?? {}) as FieldId[]);
        return {
          ok: false,
          failures: opts.rows.flatMap((target) =>
            blockedFieldIds.map((fieldId) => ({
              rowKey: target.rowKey,
              fieldId,
              message: "Save is already in flight. Wait for it to finish, then retry.",
            })),
          ),
        };
      }
      // Clearing a cell whose saved value is already empty is not a change,
      // matching `dropRedundantClear` in the cell setters. A staged new row
      // has an empty baseline, but a required field on it is still refused.
      const isRedundantClear = (rowKey: string, fieldId: FieldId) => {
        if (values[fieldId] !== null) return false;
        const saved = rowsByKey.get(rowKey);
        return saved ? (saved.values[fieldId] ?? null) === null : !requiredFieldIds.has(fieldId);
      };
      // Validators see the row as it would be after this whole update: a saved
      // row or a staged new row's draft, with its pending values and every
      // value of the update. Validation and staging both read the live
      // buffer, so a row staged earlier in the same tick has its context.
      const pending = liveBuffer().entries();
      const drafts = draftRowsFromEntries(pending, customFieldIds);
      const projectedRow = (rowKey: string): VisibleRecord | undefined => {
        const base = rowsByKey.get(rowKey) ?? drafts.get(rowKey);
        return base && rowWithPendingValues(base, pending, values);
      };
      // Validate all row/field candidates before staging; failure is atomic.
      const failures: Array<{ rowKey: string; fieldId: FieldId; message: string }> = [];
      for (const target of opts.rows) {
        const targetRow = projectedRow(target.rowKey);
        for (const fieldId of fieldIds) {
          const candidate = values[fieldId]!;
          if (isRedundantClear(target.rowKey, fieldId)) continue;
          // Optional fields may be cleared; required fields refuse it.
          if (candidate === null && requiredFieldIds.has(fieldId)) {
            failures.push({
              rowKey: target.rowKey,
              fieldId,
              message: REQUIRED_CLEAR_MESSAGE,
            });
            continue;
          }
          const validate = validatorsRef.current!.get(fieldId);
          if (!validate) continue;
          const result = validate(candidate, {
            row: targetRow,
            fieldId,
          });
          if (!result.ok) {
            failures.push({ rowKey: target.rowKey, fieldId, message: result.message });
          }
        }
      }
      if (failures.length > 0) {
        return { ok: false, failures };
      }
      const stagedSourceKind = opts.sourceKind ?? sourceKind;
      const stagedSourceRef = Object.prototype.hasOwnProperty.call(opts, "sourceRef")
        ? opts.sourceRef
        : sourceRef;
      const editSource = editSourceForSourceKind(stagedSourceKind);
      for (const target of opts.rows) {
        // Draft rows stay anchored to their first staged effective_start
        // unless the caller explicitly overrides it.
        const meta = rowMetaForEdit(target.rowKey, {
          effectiveStart: opts.effectiveStart,
          bulkGroupId: opts.bulkGroupId,
          changeTypeId: opts.changeTypeId,
          sourceKind: stagedSourceKind,
          sourceRef: stagedSourceRef ?? null,
        });
        for (const fieldId of fieldIds) {
          if (isRedundantClear(target.rowKey, fieldId)) {
            if (liveBuffer().has({ rowKey: target.rowKey, fieldId })) {
              revert({ rowKey: target.rowKey, fieldId });
              // Back at its saved (empty) value: sibling errors may clear.
              const saved = rowsByKey.get(target.rowKey);
              if (saved) {
                const row = rowWithPendingValues(saved, liveBuffer().entries(), {
                  [fieldId]: null,
                });
                reevaluateRowSiblings(row, fieldId);
              }
            }
            continue;
          }
          const value = values[fieldId]!;
          set({ rowKey: target.rowKey, fieldId }, value, editSource, meta);
        }
      }
      refreshCellsFor(
        opts.rows.map((target) => target.rowKey),
        fieldIds,
      );
      if (hasInitialInvalidCells) {
        setInvalidCells((current) => {
          const next = new Map(current);
          for (const target of opts.rows) {
            const prefix = `${target.rowKey}::`;
            for (const key of Array.from(next.keys())) {
              if (key.startsWith(prefix)) next.delete(key);
            }
            for (const [fieldId, message] of Object.entries(initialInvalidCells ?? {})) {
              next.set(`${target.rowKey}::${fieldId}`, {
                message,
                source: "seeded",
              });
            }
          }
          return next;
        });
      }
      return { ok: true };
    },
    [
      customFieldIds,
      editSourceForSourceKind,
      liveBuffer,
      mode,
      reevaluateRowSiblings,
      refreshCellsFor,
      revert,
      rowMetaForEdit,
      rowsByKey,
      set,
      requiredFieldIds,
      sourceKind,
      sourceRef,
      submitting,
    ],
  );

  // Per-cell revert: drop the field from the pending row and let the cell
  // projection fall back to the immutable baseline row value.
  const revertField = useCallback(
    (rowKey: string, fieldId: FieldId) => {
      // In-flight discard would show local revert, then reload the saved value
      // after apply succeeds. Refuse until save settles; see interaction-footguns.
      if (submitting) {
        // eslint-disable-next-line no-console
        console.warn("[editable-grid] ignoring revertField during in-flight save");
        return;
      }
      revert({ rowKey, fieldId });
      // Drop stale validation errors for the reverted cell.
      const invalidKey = `${rowKey}::${fieldId}`;
      setInvalidCells((current) => {
        if (!current.has(invalidKey)) return current;
        const next = new Map(current);
        next.delete(invalidKey);
        return next;
      });
      // Force AG Grid to drop its cached render for this cell so the baseline
      // value surfaces visually.
      refreshCellsFor([rowKey], [fieldId]);
    },
    [refreshCellsFor, revert, submitting],
  );

  // Stable getter into the invalidCells map so the diff renderer can
  // surface the per-cell error message inline without re-rendering on
  // every key. Captured by reference so the renderer reads the current
  // map snapshot on each AG Grid repaint (which fires when
  // `invalidCellClassRules` changes — see the rebuild dep on
  // `invalidCells`). Returns undefined for clean cells.
  const getInvalidMessage = useCallback(
    (rowKey: string, fieldId: FieldId): string | undefined => {
      return invalidCells.get(`${rowKey}::${fieldId}`)?.message;
    },
    [invalidCells],
  );

  // The host's notes and pins change with its pending set: under host staging
  // the renderer reads the latest ones, like the buffer.
  const columnCellNote = useHostCellGetter(hosted, cellNote);
  const columnCellPin = useHostCellGetter(hosted, cellPin);
  const columnCellMark = useHostCellGetter(hosted, cellMark);

  // Diff-cell renderer factory exposed via the GridColumnContext so apps
  // can spread it into a column's `cellRenderer`. The factory closes over
  // the buffer + baseline getter + revert handler so apps don't have to wire
  // any of the diff plumbing themselves.
  const diffCellRenderer = useCallback(
    (opts: {
      formatValue: (value: unknown, fieldValue: FieldValue | null | undefined) => string;
    }) => {
      return makeDiffCellRenderer({
        buffer: {
          has: (addr) => readBuffer().has(addr),
          getEdit: (addr) => readBuffer().getEdit(addr),
        },
        priorValueGetter: getPrior,
        invalidMessageGetter: getInvalidMessage,
        cellNote: columnCellNote,
        cellPin: columnCellPin,
        cellMark: columnCellMark,
        sourceGetter: hostSourceGetter,
        settlingGetter: hostSettlingGetter,
        onRevert: revertField,
        formatValue: opts.formatValue,
      });
    },
    [
      columnCellNote,
      columnCellPin,
      columnCellMark,
      getPrior,
      getInvalidMessage,
      hostSettlingGetter,
      hostSourceGetter,
      readBuffer,
      revertField,
    ],
  );

  const ctx = useMemo<GridColumnContext>(
    () => ({
      asOf,
      mode,
      fieldGetter,
      fieldValueGetter,
      fieldSetter,
      fieldSetterFromValue,
      dirtyCellClassRules,
      invalidCellClassRules,
      diffCellRenderer,
    }),
    [
      asOf,
      mode,
      fieldGetter,
      fieldValueGetter,
      fieldSetter,
      fieldSetterFromValue,
      dirtyCellClassRules,
      invalidCellClassRules,
      diffCellRenderer,
    ],
  );

  const schemaBuildOptions = useMemo<BuildSchemaColumnsOptions>(
    () => ({
      fieldOverrides,
      fieldOrder,
      hidden,
      relationOptionsByModel,
      relationSearchByModel,
      onRelationOptionPicked,
    }),
    [
      fieldOverrides,
      fieldOrder,
      hidden,
      relationOptionsByModel,
      relationSearchByModel,
      onRelationOptionPicked,
    ],
  );

  const readOnlyRows = rowReadOnly !== undefined;
  const columnDefs = useMemo(() => {
    const built = columnSchema
      ? buildSchemaColumnDefs(ctx, columnSchema, model, schemaBuildOptions)
      : EMPTY_COLUMN_DEFS;
    // Read mode forces every column non-editable, even if the app's
    // ColDef set `editable: true`. The library owns this override so apps
    // don't have to thread mode through every column-spec branch — read
    // means "no commits land," period. Tweak and edit modes pass through
    // the app's per-column `editable` unchanged.
    if (mode === "read") {
      return built.map((col) => ({ ...col, editable: false }));
    }
    // Rows the host keeps read-only take no edit in any column; the host's
    // latest answer is read per cell, so the columns stay the same.
    if (readOnlyRows) {
      return built.map((col) => {
        const editable = col.editable;
        if (!editable) return col;
        return {
          ...col,
          editable: (params: EditableCallbackParams<VisibleRecord>) =>
            !rowReadOnlyRef.current?.(params.data?.record_id ?? "") &&
            (typeof editable === "function" ? editable(params) : true),
        };
      });
    }
    return built;
  }, [columnSchema, model, schemaBuildOptions, ctx, mode, readOnlyRows]);

  // Host staging keeps the columns across host changes (see `readBuffer`):
  // repaint the cells instead. AG Grid skips a cell being edited.
  const hostBuffer = hosted ? buffer : null;
  const hostRowsByKey = hosted ? rowsByKey : null;
  const hostCellNote = hosted ? cellNote : undefined;
  const hostCellPin = hosted ? cellPin : undefined;
  const hostCellMark = hosted ? cellMark : undefined;
  const hostSettled = host?.settled;
  useLayoutEffect(() => {
    if (hosted) gridApiRef.current?.refreshCells({ force: true });
  }, [hosted, hostBuffer, hostRowsByKey, hostCellNote, hostCellPin, hostCellMark, hostSettled]);

  // Per-row digest of pending edits. Walks the buffer once, groups by
  // rowKey, derives `changeType` once per row from the union of touched
  // field ids via `inferChangeType` (or falls back to the config's
  // `changeTypeId` when no callback is provided). Apps render the
  // row-meta strip from this; the library renders the strip itself via
  // the synthetic full-width meta rows we inject into the surface
  // `rowData` below — same data, two surfaces.
  const pendingChangesByRow = useMemo<ReadonlyMap<string, RowChangeSummary>>(() => {
    const byRow = new Map<
      string,
      {
        fieldChanges: RowChangeSummary["fieldChanges"];
        effectiveDate: string;
        bulkGroupId?: string;
        sourceKind?: string;
        sourceRef?: string | null;
        explicitChangeType?: ChangeTypeId;
      }
    >();
    for (const entry of buffer.entries()) {
      const rowKey = entry.addr.rowKey;
      const fieldId = entry.addr.fieldId;
      const meta = entry.meta;
      const bulkGroupId = meta?.bulkGroupId;
      const changeTypeId = meta?.changeTypeId;
      let bucket = byRow.get(rowKey);
      if (!bucket) {
        bucket = {
          fieldChanges: [],
          effectiveDate: meta?.effectiveStart ?? asOf,
          bulkGroupId,
          // Meta is stored at the record (row) level, so every entry of a row
          // carries the same last-`set` meta — the first entry's sourceKind IS
          // the row's last-touched provenance. (A human edit onto an agent row
          // rewrites the whole record's meta to `"user"` while keeping the
          // agent bulkGroupId.)
          sourceKind: meta?.sourceKind,
          sourceRef: meta?.sourceRef,
          explicitChangeType: changeTypeId,
        };
        byRow.set(rowKey, bucket);
      } else {
        if (!bucket.bulkGroupId && bulkGroupId) {
          // First entry didn't carry a bulk id but a later one does —
          // adopt it so the row's strip surfaces the group affordances.
          // Mixing groups within one row is undefined behavior the
          // library doesn't enforce; apps stamp consistently by
          // construction.
          bucket.bulkGroupId = bulkGroupId;
        }
        if (!bucket.explicitChangeType && changeTypeId) {
          // Same first-non-null adopt rule for the change_type override.
          // Apps that stamp inconsistently across a row get whichever
          // explicit value lands first; the row's strip then narrates
          // by that verb. The bulk-action sidebar stamps a single value
          // across all touched fields per row, so this is consistent in
          // practice.
          bucket.explicitChangeType = changeTypeId;
        }
      }
      bucket.fieldChanges.push({
        fieldId,
        prior: getPrior(rowKey, fieldId) ?? null,
        next: entry.value,
      });
    }
    const out = new Map<string, RowChangeSummary>();
    for (const [rowKey, bucket] of byRow) {
      const fieldIds = bucket.fieldChanges.map((c) => c.fieldId);
      // Leave unresolved change_type as undefined so UI and save guards stay loud.
      const resolved: ChangeTypeId | undefined =
        bucket.explicitChangeType ?? (inferChangeType ? inferChangeType(fieldIds) : changeTypeId);
      const summary: RowChangeSummary = {
        fieldChanges: bucket.fieldChanges,
        changeType: resolved,
        effectiveDate: bucket.effectiveDate,
      };
      if (bucket.bulkGroupId) summary.bulkGroupId = bucket.bulkGroupId;
      if (bucket.sourceKind !== undefined) summary.sourceKind = bucket.sourceKind;
      if (bucket.sourceRef !== undefined) summary.sourceRef = bucket.sourceRef;
      out.set(rowKey, summary);
    }
    return out;
  }, [buffer, asOf, changeTypeId, inferChangeType, getPrior]);

  // Drop every pending edit on a row.
  const revertRowEdits = useCallback(
    (rowKey: string) => {
      // Same in-flight save guard as per-cell revert.
      if (submitting) {
        // eslint-disable-next-line no-console
        console.warn("[editable-grid] ignoring revertRowEdits during in-flight save");
        return;
      }
      // Snapshot field ids before dropping the buffer so AG Grid can refresh
      // exactly the projected cells that fell back to baseline values. Read
      // the LIVE buffer, not the render snapshot: revert may run in the same
      // event tick as the stages it is rolling back (agent stage rollback).
      const dirtyFieldIds: FieldId[] = [];
      for (const entry of liveBuffer().entries()) {
        if (entry.addr.rowKey !== rowKey) continue;
        dirtyFieldIds.push(entry.addr.fieldId);
      }
      revertRow(rowKey);
      // Also drop any invalid-cell entries on this row.
      const rowPrefix = `${rowKey}::`;
      setInvalidCells((current) => {
        let changed = false;
        const next = new Map(current);
        for (const key of Array.from(next.keys())) {
          if (key.startsWith(rowPrefix)) {
            next.delete(key);
            changed = true;
          }
        }
        return changed ? next : current;
      });
      // One batched refresh covers every reverted cell on the row. AG Grid
      // will re-read each column's valueGetter, surfacing the baseline value.
      if (dirtyFieldIds.length > 0) {
        refreshCellsFor([rowKey], dirtyFieldIds);
      }
    },
    [liveBuffer, refreshCellsFor, revertRow, submitting],
  );

  // Drop every pending edit across all rows that share `bulkGroupId`.
  // Walks the LIVE buffer (NOT `pendingChangesByRow`, a render-time useMemo)
  // to find the affected rows, then defers to `revertRowEdits` per row so
  // each row's invalid cells + priors also clear. Liveness is load-bearing:
  // the agent stage path stages N rows and rolls the group back in the SAME
  // event tick on partial failure — rows staged this tick are not in the
  // memoized map yet, so the memo-walking version silently reverted nothing.
  const revertBulkGroup = useCallback(
    (bulkGroupId: string) => {
      // Refuse once at the bulk boundary instead of warning per affected row.
      if (submitting) {
        // eslint-disable-next-line no-console
        console.warn("[editable-grid] ignoring revertBulkGroup during in-flight save");
        return;
      }
      const affected = new Set<string>();
      for (const entry of liveBuffer().entries()) {
        if (entry.meta?.bulkGroupId === bulkGroupId) affected.add(entry.addr.rowKey);
      }
      for (const rowKey of affected) revertRowEdits(rowKey);
    },
    [liveBuffer, revertRowEdits, submitting],
  );

  // Default bulk-link click behavior; apps may override.
  const onClickBulkLink = useCallback(
    (bulkGroupId: string) => {
      if (onClickBulkLinkProp) {
        onClickBulkLinkProp(bulkGroupId);
        return;
      }
      setActiveBulkFilter(bulkGroupId);
    },
    [onClickBulkLinkProp],
  );

  // Row-meta setters mutate only the requested meta key. During save, keep
  // meta stable so revertMatching can evict the applied snapshot.
  const setRowEffectiveDate = useCallback(
    (rowKey: string, effectiveStart: string) => {
      if (mode === "read") return;
      if (submitting) {
        // eslint-disable-next-line no-console
        console.warn("[editable-grid] ignoring setRowEffectiveDate during in-flight save");
        return;
      }
      for (const entry of readBuffer().entries()) {
        if (entry.addr.rowKey !== rowKey) continue;
        updateMeta(entry.addr, { effectiveStart });
      }
    },
    [mode, readBuffer, submitting, updateMeta],
  );

  const setRowChangeType = useCallback(
    (rowKey: string, changeTypeId: ChangeTypeId) => {
      if (mode === "read") return;
      if (submitting) {
        // eslint-disable-next-line no-console
        console.warn("[editable-grid] ignoring setRowChangeType during in-flight save");
        return;
      }
      for (const entry of readBuffer().entries()) {
        if (entry.addr.rowKey !== rowKey) continue;
        updateMeta(entry.addr, { changeTypeId });
      }
    },
    [mode, readBuffer, submitting, updateMeta],
  );

  const setBulkGroupEffectiveDate = useCallback(
    (bulkGroupId: string, effectiveStart: string) => {
      if (mode === "read") return;
      if (submitting) {
        // eslint-disable-next-line no-console
        console.warn("[editable-grid] ignoring setBulkGroupEffectiveDate during in-flight save");
        return;
      }
      for (const entry of buffer.entries()) {
        if (entry.meta?.bulkGroupId !== bulkGroupId) continue;
        updateMeta(entry.addr, { effectiveStart });
      }
    },
    [buffer, mode, submitting, updateMeta],
  );

  // Default labels keep ids renderable until the app supplies lookup maps.
  const bulkGroupLabel = bulkGroupLabelProp ?? identityLabel;
  const changeTypeLabel = changeTypeLabelProp ?? identityLabel;
  // Empty options keep the row-meta type picker inert.
  const changeTypeOptions = changeTypeOptionsProp ?? EMPTY_CHANGE_TYPE_OPTIONS;

  // Last save outcome drives app status banners.
  const [lastSaveOutcome, setLastSaveOutcome] = useState<SaveOutcome | null>(null);

  const performSave = useCallback(async (): Promise<SaveOutcome> => {
    if (invalidCells.size > 0) {
      const error: ErrorEnvelope = {
        code: "editable_grid_invalid_cells",
        message: "Fix highlighted cells before saving.",
        details: Array.from(invalidCells.entries()).map(([key, invalidCell]) => ({
          path: key,
          code: "invalid_cell",
          message: invalidCell.message,
        })),
      };
      const outcome: SaveOutcome = {
        savedStageCount: 0,
        remainingStageCount: buffer.cellCount,
        perChangeSet: [
          {
            changeTypeId: changeTypeId ?? "",
            stageCount: buffer.cellCount,
            status: "failed",
            error,
          },
        ],
      };
      setLastSaveOutcome(outcome);
      onApplyError?.(error);
      return outcome;
    }
    if (!isDirty) return lastSaveOutcome ?? EMPTY_SAVE_OUTCOME;
    // Snapshot the entries we're about to submit BEFORE awaiting apply, so
    // the success path can revert exactly the submitted set. Edit, revert,
    // and row-meta mutators are gated while `submitting`; `revertMatching`
    // remains the engine backstop for stale callbacks or direct buffer use.
    const allEntries = buffer.entries();
    const originalDirtyCount = allEntries.length;
    if (originalDirtyCount === 0) return lastSaveOutcome ?? EMPTY_SAVE_OUTCOME;

    // Partition by the same per-row change_type rule shown in row-meta chrome.
    // Persist row-level last-touched provenance unless the host explicitly
    // owns one authoritative source for the reviewed Save envelope.
    const defaultChangeType = changeTypeId ?? "";
    const partitions = partitionEntriesForSave(allEntries, {
      inferChangeType,
      defaultChangeType,
      defaultSourceKind: sourceKind,
      defaultSourceRef: sourceRef ?? null,
      ...(saveSource ? { saveSource } : {}),
    });

    // Serial apply keeps outcome order deterministic and stops on first failure.
    const perChangeSet: SaveChangeSetResult[] = [];
    let savedStageCount = 0;
    let lastError: ErrorEnvelope | null = null;

    for (const partition of partitions) {
      const groupSnapshot = partition.entries;
      const writes = finalizeWrites(entriesToWrites(groupSnapshot, modelId));
      if (writes.length === 0) {
        perChangeSet.push({
          changeTypeId: partition.changeTypeId,
          stageCount: groupSnapshot.length,
          status: "empty",
        });
        continue;
      }

      // Only homogeneous bulk partitions get ApplyChangeSet.notes.
      const notes =
        partition.bulkGroupId !== undefined ? bulkGroupNotes?.(partition.bulkGroupId) : undefined;

      try {
        const payload: ApplyChangeSetPayload = {
          app_id: scope.appId,
          customer_id: scope.customerId,
          source_kind: partition.sourceKind,
          ...(partition.sourceRef == null ? {} : { source_ref: partition.sourceRef }),
          change_type_id: partition.changeTypeId,
          mode: saveMode,
          writes,
        };
        if (notes !== undefined) payload.notes = notes;
        const idempotencyKey = idempotencyKeyForChangeType?.(partition.changeTypeId, payload);
        if (idempotencyKey) payload.idempotency_key = idempotencyKey;
        if (apply === null) {
          throw new Error("Preview-only editable grids cannot save.");
        }
        const result = await apply(payload);
        if (isSingleFlightBlocked(result)) {
          // Concurrent save hit the apply hook's single-flight gate; no write fired.
          perChangeSet.push({
            changeTypeId: partition.changeTypeId,
            stageCount: groupSnapshot.length,
            status: "blocked",
          });
          break;
        }
        const appliedChangeSetId = extractAppliedChangeSetId(result);
        if (appliedChangeSetId == null) {
          throw {
            code: "invalid_apply_response",
            message: "Server response did not include a change_set id.",
            details: [
              {
                path: "change_set.id",
                code: "missing_change_set_id",
                message: "Server response did not include a change_set id.",
              },
            ],
          } satisfies ErrorEnvelope;
        }
        revertMatching(groupSnapshot);
        savedStageCount += groupSnapshot.length;
        perChangeSet.push({
          changeTypeId: partition.changeTypeId,
          stageCount: groupSnapshot.length,
          status: "saved",
          appliedChangeSetId,
        });
      } catch (e) {
        // Failed partition stays dirty for retry. useApplyChangeSet keeps the
        // idempotency key stable for the unchanged failed payload.
        const envelope = e as ErrorEnvelope;
        lastError = envelope;
        perChangeSet.push({
          changeTypeId: partition.changeTypeId,
          stageCount: groupSnapshot.length,
          status: "failed",
          error: envelope,
        });
        onApplyError?.(envelope);
        break;
      }
    }

    const outcome: SaveOutcome = {
      savedStageCount,
      remainingStageCount: originalDirtyCount - savedStageCount,
      perChangeSet,
    };
    setLastSaveOutcome(outcome);

    // Reset per-cell validation errors only when EVERY partition saved.
    // A partial-save leaves some entries still dirty in the buffer; the
    // user might re-edit them, and the prior validation errors on those
    // cells are still meaningful.
    if (savedStageCount === originalDirtyCount && lastError === null) {
      // Mirrors the legacy success path: any pre-commit validation errors
      // were on values the user never committed; clearing them keeps the
      // post-reload grid free of stale red.
      setInvalidCells(EMPTY_INVALID_CELLS);
    }

    // Fire `onApplied` once at the end if anything was saved (the page
    // reloads its rows; fresh server state lands for every saved record
    // in one round-trip rather than N reloads between partitions). Failed
    // partitions' entries remain in the buffer on top of the reloaded
    // rows because their meta is preserved.
    if (savedStageCount > 0) {
      onApplied?.();
    }

    return outcome;
  }, [
    apply,
    buffer,
    bulkGroupNotes,
    changeTypeId,
    finalizeWrites,
    idempotencyKeyForChangeType,
    inferChangeType,
    invalidCells,
    isDirty,
    lastSaveOutcome,
    modelId,
    onApplied,
    onApplyError,
    revertMatching,
    saveMode,
    scope,
    sourceRef,
    sourceKind,
    saveSource,
  ]);

  const save = useCallback(async (): Promise<SaveOutcome> => {
    if (saveOperationTokenRef.current !== null) {
      return {
        savedStageCount: 0,
        remainingStageCount: buffer.cellCount,
        perChangeSet: [
          {
            changeTypeId: changeTypeId ?? "",
            stageCount: buffer.cellCount,
            status: "blocked",
          },
        ],
      };
    }
    const token = Symbol("grid-save");
    saveOperationTokenRef.current = token;
    try {
      return await performSave();
    } finally {
      if (saveOperationTokenRef.current === token) {
        saveOperationTokenRef.current = null;
      }
    }
  }, [buffer.cellCount, changeTypeId, performSave]);

  const prepareAtomicSave = useCallback(() => {
    if (mode === "read") return null;
    if (invalidCells.size > 0) {
      throw new Error("Fix highlighted cells before saving.");
    }
    if (saveOperationTokenRef.current !== null) {
      throw new Error("A save is already in flight for this grid.");
    }
    const snapshot = buffer.entries();
    const writes = finalizeWrites(entriesToWrites(snapshot, modelId));
    const token = Symbol("atomic-grid-save");
    saveOperationTokenRef.current = token;
    setAtomicSubmitting(true);
    const release = () => {
      if (saveOperationTokenRef.current !== token) {
        return;
      }
      saveOperationTokenRef.current = null;
      setAtomicSubmitting(false);
    };
    return {
      writes,
      stageCount: snapshot.length,
      acknowledge: () => {
        if (saveOperationTokenRef.current !== token) return;
        release();
        revertMatching(snapshot);
        setInvalidCells(EMPTY_INVALID_CELLS);
        onApplied?.();
      },
      cancel: release,
    };
  }, [buffer, finalizeWrites, invalidCells, mode, modelId, onApplied, revertMatching]);

  // Add draft rows and synthetic meta rows to the data AG Grid receives.
  const hostOwnsRowMeta = host !== null;
  const mergedRows = useMemo<Array<VisibleRecord | MetaRowMarker>>(() => {
    const base = newRowDrafts.length > 0 ? [...newRowDrafts, ...rows] : rows;
    // The host owns each row's effective date and change type: no meta strip.
    if (pendingChangesByRow.size === 0 || hostOwnsRowMeta) return base;
    const out: Array<VisibleRecord | MetaRowMarker> = [];
    for (const row of base) {
      out.push(row);
      // Draft rows are already the staged change; no extra meta strip.
      if (isEditableGridTempRowKey(row.record_id)) continue;
      const summary = pendingChangesByRow.get(row.record_id);
      if (summary) {
        const marker: MetaRowMarker = {
          __metaRow: true,
          record_id: `${META_ROW_KEY_PREFIX}${row.record_id}`,
          parentRowKey: row.record_id,
          changeType: summary.changeType,
          effectiveDate: summary.effectiveDate,
          effective_start: summary.effectiveDate,
          effective_end: null,
          values: {},
          custom_fields: [],
        };
        if (summary.bulkGroupId) marker.bulkGroupId = summary.bulkGroupId;
        out.push(marker);
      }
    }
    return out;
  }, [newRowDrafts, rows, pendingChangesByRow, hostOwnsRowMeta]);

  // Meta rows delegate filtering to their parent row.
  const externalFilterPresent = activeBulkFilter !== null || showChangesOnly;
  const externalFilterPass = useCallback(
    (node: IRowNode<VisibleRecord | MetaRowMarker>): boolean => {
      const data = node.data;
      if (!data) return true;
      const parentRowKey = isMetaRow(data) ? data.parentRowKey : data.record_id;
      const summary = pendingChangesByRow.get(parentRowKey);
      if (showChangesOnly && !summary) return false;
      if (activeBulkFilter !== null) {
        if (!summary) return false;
        if (summary.bulkGroupId !== activeBulkFilter) return false;
      }
      return true;
    },
    [activeBulkFilter, pendingChangesByRow, showChangesOnly],
  );

  // Read mode exposes a no-op controller while still honoring Rules of Hooks.
  const controller: EditableGridController =
    mode === "read"
      ? {
          isDirty: false,
          dirtyCount: 0,
          // Edits staged before read-mode still exist but are not actionable.
          pendingEditsHidden: buffer.cellCount,
          submitting: false,
          submitError: null,
          save: NO_OP_SAVE,
          prepareAtomicSave: NO_OP_PREPARE_ATOMIC_SAVE,
          lastSaveOutcome: null,
          stageNewRecord: NO_OP_STAGE_NEW_RECORD,
          newRowDrafts: EMPTY_DRAFTS,
          pendingChangesByRow: EMPTY_PENDING_CHANGES,
          invalidRowCount: 0,
          invalidCellCount: 0,
          activeBulkFilter: null,
          setBulkFilter: NO_OP_SET_BULK_FILTER,
          showChangesOnly: false,
          setShowChangesOnly: NO_OP_SET_SHOW_CHANGES_ONLY,
          stageBulkUpdate: NO_OP_STAGE_BULK_UPDATE,
          revertField: NO_OP_REVERT_FIELD,
          revertRowEdits: NO_OP_REVERT_ROW,
          revertBulkGroup: NO_OP_REVERT_BULK,
          setRowEffectiveDate: NO_OP_SET_ROW_EFFECTIVE_DATE,
          setRowChangeType: NO_OP_SET_ROW_CHANGE_TYPE,
          setBulkGroupEffectiveDate: NO_OP_SET_BULK_EFFECTIVE_DATE,
        }
      : {
          isDirty,
          dirtyCount: buffer.cellCount,
          pendingEditsHidden: 0,
          submitting,
          submitError,
          save,
          prepareAtomicSave,
          lastSaveOutcome,
          stageNewRecord,
          newRowDrafts,
          pendingChangesByRow,
          invalidRowCount,
          invalidCellCount: invalidCells.size,
          activeBulkFilter,
          setBulkFilter: setActiveBulkFilter,
          showChangesOnly,
          setShowChangesOnly,
          stageBulkUpdate,
          revertField,
          revertRowEdits,
          revertBulkGroup,
          setRowEffectiveDate,
          setRowChangeType,
          setBulkGroupEffectiveDate,
        };

  // Stable params for full-width meta-row rendering.
  const fullWidthCellRendererParams = useMemo(
    () => ({
      onDiscardRow: revertRowEdits,
      setRowEffectiveDate,
      setRowChangeType,
      onClickBulkLink,
      bulkGroupLabel,
      changeTypeLabel,
      changeTypeOptions,
      // Collapse row-level bulk copy when the page-level filter owns it.
      bulkFilterActive: activeBulkFilter !== null,
    }),
    [
      revertRowEdits,
      setRowEffectiveDate,
      setRowChangeType,
      onClickBulkLink,
      bulkGroupLabel,
      changeTypeLabel,
      changeTypeOptions,
      activeBulkFilter,
    ],
  );

  // Read mode suppresses inert meta rows.
  const surfaceRows: Array<VisibleRecord | MetaRowMarker> = mode === "read" ? rows : mergedRows;
  const isFullWidthRowCallback = useCallback(
    (params: IsFullWidthRowParams<VisibleRecord | MetaRowMarker>): boolean => {
      if (mode === "read") return false;
      return isMetaRow(params.rowNode.data);
    },
    [mode],
  );

  // Meta rows are shorter; data rows keep AG Grid's default height.
  const getRowHeightCallback = useCallback(
    (params: RowHeightParams<VisibleRecord | MetaRowMarker>): number | undefined => {
      if (isMetaRow(params.data)) return ROW_META_HEIGHT_PX;
      return undefined;
    },
    [],
  );

  return {
    controller,
    surfaceProps: {
      rows: surfaceRows,
      columnDefs,
      mode,
      isFullWidthRow: isFullWidthRowCallback,
      fullWidthCellRendererParams,
      externalFilterPresent: mode === "read" ? false : externalFilterPresent,
      externalFilterPass,
      filterVersion,
      getRowHeight: getRowHeightCallback,
      onGridReady,
    },
  };
}

// Numeric height for meta rows; keep in sync with theme.css.
const ROW_META_HEIGHT_PX = 28;

// Stable no-op references for the read-mode controller.
async function NO_OP_SAVE(): Promise<SaveOutcome> {
  return EMPTY_SAVE_OUTCOME;
}

function NO_OP_PREPARE_ATOMIC_SAVE() {
  return null;
}
function NO_OP_STAGE_NEW_RECORD(): { tempRowKey: string } {
  return { tempRowKey: "" };
}
function NO_OP_SET_BULK_FILTER(_id: string | null): void {}
function NO_OP_SET_SHOW_CHANGES_ONLY(_on: boolean): void {}
function NO_OP_REVERT_FIELD(_rowKey: string, _fieldId: FieldId): void {}
function NO_OP_REVERT_ROW(_rowKey: string): void {}
function NO_OP_REVERT_BULK(_bulkGroupId: string): void {}
function NO_OP_SET_ROW_EFFECTIVE_DATE(_rowKey: string, _effectiveStart: string): void {}
function NO_OP_SET_ROW_CHANGE_TYPE(_rowKey: string, _changeTypeId: ChangeTypeId): void {}
function NO_OP_SET_BULK_EFFECTIVE_DATE(_bulkGroupId: string, _effectiveStart: string): void {}
function NO_OP_STAGE_BULK_UPDATE(
  _opts:
    | {
        rows: ReadonlyArray<{ rowKey: string }>;
        fieldId: FieldId;
        value: FieldValue | null;
        bulkGroupId: string;
        effectiveStart?: string;
        changeTypeId?: ChangeTypeId;
        initialInvalidCells?: Readonly<Record<FieldId, string>>;
      }
    | {
        rows: ReadonlyArray<{ rowKey: string }>;
        values: Record<FieldId, FieldValue | null>;
        bulkGroupId: string;
        effectiveStart?: string;
        changeTypeId?: ChangeTypeId;
        initialInvalidCells?: Readonly<Record<FieldId, string>>;
      },
): StageBulkUpdateResult {
  return { ok: true };
}
const EMPTY_DRAFTS: VisibleRecord[] = [];
const EMPTY_PENDING_CHANGES: ReadonlyMap<string, RowChangeSummary> = new Map();
const EMPTY_COLUMN_DEFS: ColDef<VisibleRecord>[] = [];
const EMPTY_CHANGE_TYPE_OPTIONS: ReadonlyArray<ChangeTypeOption> = [];

type InvalidCell = {
  message: string;
  source: "seeded" | "validator";
};

// Synthetic meta-row ids stay outside the kernel record_id namespace.
const META_ROW_KEY_PREFIX = "meta:";

function identityLabel(id: string): string {
  return id;
}

function recordKeyForRowEdit(rowKey: string, buffer: EditBuffer): RecordKey | undefined {
  if (!isEditableGridTempRowKey(rowKey)) return { type: "record_id", value: rowKey };
  // Import previews can seed deterministic create keys on temp rows. Preserve
  // that key across user edits so Save remains idempotent and relation targets
  // keep pointing at the same external identity.
  for (const entry of buffer.entries()) {
    if (entry.addr.rowKey !== rowKey) continue;
    if (entry.meta?.recordKey) return entry.meta.recordKey;
  }
  return undefined;
}

function newRecordIdForRowEdit(rowKey: string, buffer: EditBuffer): RecordId | undefined {
  if (!isEditableGridTempRowKey(rowKey)) return undefined;
  for (const entry of buffer.entries()) {
    if (entry.addr.rowKey !== rowKey) continue;
    if (entry.meta?.newRecordId) return entry.meta.newRecordId;
  }
  return undefined;
}

// Preserve bulk grouping across follow-up cell edits on the same row.
function bulkGroupIdForRow(rowKey: string, buffer: EditBuffer): string | undefined {
  for (const entry of buffer.entries()) {
    if (entry.addr.rowKey !== rowKey) continue;
    const id = entry.meta?.bulkGroupId;
    if (id) return id;
  }
  return undefined;
}

// Preserve explicit change_type overrides across follow-up cell edits.
function changeTypeIdForRow(rowKey: string, buffer: EditBuffer): ChangeTypeId | undefined {
  for (const entry of buffer.entries()) {
    if (entry.addr.rowKey !== rowKey) continue;
    const id = entry.meta?.changeTypeId;
    if (id) return id;
  }
  return undefined;
}

export { EDITABLE_GRID_TEMP_ROW_KEY_PREFIX, isEditableGridTempRowKey };

function effectiveStartForRowEdit(rowKey: string, defaultAsOf: string, buffer: EditBuffer): string {
  // Pending rows stay anchored to their first staged effective_start. This
  // relies on buffer.entries() preserving insertion order, so follow-up edits
  // cannot split a record into multiple dates inside one save.
  const existing = buffer.entries().find((entry) => entry.addr.rowKey === rowKey);
  return existing?.meta?.effectiveStart ?? defaultAsOf;
}

// Shared read-only reset reference; do not mutate in place.
const EMPTY_INVALID_CELLS: Map<string, InvalidCell> = (() => {
  const m = new Map<string, InvalidCell>();
  const throwReadonly = () => {
    throw new Error("EMPTY_INVALID_CELLS is shared; clone with `new Map(current)` before mutating");
  };
  m.set = throwReadonly as typeof m.set;
  m.delete = throwReadonly as typeof m.delete;
  m.clear = throwReadonly as typeof m.clear;
  return m;
})();

const EMPTY_FIELD_IDS: ReadonlySet<FieldId> = new Set();

// An editor commit that carries no value: AG Grid's Delete/Backspace clear
// (null), or a text-backed editor committing an empty string.
function isEmptyPrimitive(value: unknown): boolean {
  return value == null || (typeof value === "string" && value.trim() === "");
}

// Draft rows for the new-record entries among `entries` (those on temp row
// keys), keyed by temp row key in the order they were staged. A draft takes
// its first entry's effective_start; a clear on it just leaves the cell empty.
// Drafts carry their staged custom values in both shapes, like a read record
// after projection: `values` for the grid, `custom_fields` for consumers that
// read the wire shape.
function draftRowsFromEntries(
  entries: ReadonlyArray<EditEntry>,
  customFieldIds: ReadonlySet<FieldId>,
): Map<string, VisibleRecord> {
  const drafts = new Map<string, VisibleRecord>();
  for (const entry of entries) {
    const rowKey = entry.addr.rowKey;
    if (!entry.meta || !isEditableGridTempRowKey(rowKey)) continue;
    let draft = drafts.get(rowKey);
    if (!draft) {
      draft = {
        record_id: rowKey,
        effective_start: entry.meta.effectiveStart,
        effective_end: null,
        values: {},
        custom_fields: [],
      };
      drafts.set(rowKey, draft);
    }
    if (entry.value !== null) draft.values[entry.addr.fieldId] = entry.value;
  }
  if (customFieldIds.size > 0) {
    for (const draft of drafts.values()) {
      draft.custom_fields = customEntries(draft, customFieldIds);
    }
  }
  return drafts;
}

// `row` with its pending entries applied, then `overlay`; a null clears.
function rowWithPendingValues(
  row: VisibleRecord,
  entries: ReadonlyArray<EditEntry>,
  overlay: Readonly<Record<FieldId, FieldValue | null>>,
): VisibleRecord {
  const values = { ...row.values };
  const apply = (fieldId: FieldId, value: FieldValue | null | undefined) => {
    if (value == null) delete values[fieldId];
    else values[fieldId] = value;
  };
  for (const entry of entries) {
    if (entry.addr.rowKey === row.record_id) apply(entry.addr.fieldId, entry.value);
  }
  for (const [fieldId, value] of Object.entries(overlay)) apply(fieldId, value);
  return { ...row, values };
}

// Wire-shape custom entries for a draft row's projected custom values.
function customEntries(
  draft: VisibleRecord,
  customFieldIds: ReadonlySet<FieldId>,
): CustomFieldEntry[] {
  const entries: CustomFieldEntry[] = [];
  for (const [fieldId, value] of Object.entries(draft.values)) {
    if (customFieldIds.has(fieldId)) {
      entries.push({ field_id: fieldId, ...value } as CustomFieldEntry);
    }
  }
  return entries;
}

const REQUIRED_CLEAR_MESSAGE = "This field can't be cleared.";

const hostCellKey = (addr: CellAddress) => `${addr.rowKey}::${addr.fieldId}`;

// A pending set's identity: the host may rebuild an equal array every render,
// which must not rebuild the columns (that would reset an open editor).
function hostPendingSignature(pending: ReadonlyArray<HostStagedCell>): string {
  return JSON.stringify(
    pending.map((cell) => [
      cell.rowKey,
      cell.fieldId,
      cell.value,
      cell.prior,
      cell.source ?? null,
      cell.settling === true,
    ]),
  );
}

type HostStagingBuffer = EditBufferState & {
  // The value the host recorded before staging this cell; `undefined` when
  // the cell is not staged. Both getters read the latest pending set.
  prior: (rowKey: string, fieldId: FieldId) => FieldValue | null | undefined;
  source: (rowKey: string, fieldId: FieldId) => string | undefined;
  // Whether the cell's entry has left the host and awaits its next read.
  settling: (rowKey: string, fieldId: FieldId) => boolean;
  // The value last handed to the host for this cell, until the host's pending
  // set shows it or its stage settles; `undefined` when none is outstanding.
  outstanding: (rowKey: string, fieldId: FieldId) => FieldValue | null | undefined;
  // Counts outstanding edits that settled: the cells repaint, so a refused
  // edit shows the host's value again.
  settled: number;
};

// Under host staging, a stable stand-in for a host cell getter that calls its
// latest version, so a new getter does not rebuild the columns; otherwise the
// getter itself.
function useHostCellGetter<R>(
  hosted: boolean,
  getter: ((rowKey: string, fieldId: FieldId) => R | undefined) | undefined,
): ((rowKey: string, fieldId: FieldId) => R | undefined) | undefined {
  const getterRef = useRef(getter);
  getterRef.current = getter;
  const present = getter !== undefined;
  const latest = useMemo(
    () =>
      present
        ? (rowKey: string, fieldId: FieldId) => getterRef.current?.(rowKey, fieldId)
        : undefined,
    [present],
  );
  return hosted ? latest : getter;
}

// The edit-buffer surface over a host's pending set (see `HostStaging`). The
// buffer is derived from `pending` on every change of its content; mutators
// hand edits and reverts to the host and never change it locally.
function useHostStagingBuffer(
  hostStaging: HostStaging | undefined,
  modelId: ModelId,
  asOf: string,
): HostStagingBuffer | null {
  const pending = hostStaging?.pending;
  const signature = pending ? hostPendingSignature(pending) : null;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const callbacksRef = useRef(hostStaging);
  callbacksRef.current = hostStaging;
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- rebuilt by pending content, not array identity.
  const derived = useMemo(() => {
    const cells = pendingRef.current;
    if (!cells) return null;
    let buffer = createEditBuffer();
    const priors = new Map<string, FieldValue | null>();
    const sources = new Map<string, string>();
    const settling = new Set<string>();
    for (const cell of cells) {
      const addr = { rowKey: cell.rowKey, fieldId: cell.fieldId };
      buffer = buffer.set(addr, cell.value, cell.source ?? "user", {
        modelId,
        recordKey: { type: "record_id", value: cell.rowKey },
        effectiveStart: asOf,
        sourceKind: cell.source ?? "user",
        sourceRef: null,
      });
      priors.set(hostCellKey(addr), cell.prior);
      sources.set(hostCellKey(addr), cell.source ?? "user");
      if (cell.settling === true) settling.add(hostCellKey(addr));
    }
    return { buffer, priors, sources, settling };
  }, [signature, modelId, asOf]);
  const derivedRef = useRef(derived);
  derivedRef.current = derived;

  // Edits handed to the host that its pending set does not show yet, by cell.
  const outstandingRef = useRef(new Map<string, FieldValue | null>());
  const [settled, setSettled] = useState(0);
  useEffect(() => {
    const cells = new Map((pendingRef.current ?? []).map((cell) => [hostCellKey(cell), cell]));
    for (const [key, value] of outstandingRef.current) {
      const cell = cells.get(key);
      if (cell !== undefined && fieldValueEqual(cell.value, value))
        outstandingRef.current.delete(key);
    }
  }, [signature]);

  const set = useCallback((addr: CellAddress, value: PendingFieldValue) => {
    const key = hostCellKey(addr);
    outstandingRef.current.set(key, value);
    const staged = callbacksRef.current?.onStage({
      rowKey: addr.rowKey,
      fieldId: addr.fieldId,
      value,
    });
    // Settled: the host's pending set (or its refusal) speaks for the cell again.
    void Promise.resolve(staged)
      .catch(() => {})
      .then(() => {
        if (outstandingRef.current.get(key) !== value) return;
        outstandingRef.current.delete(key);
        setSettled((count) => count + 1);
      });
  }, []);
  const revert = useCallback((addr: CellAddress) => {
    callbacksRef.current?.onRevert({ rowKey: addr.rowKey, fieldId: addr.fieldId });
  }, []);
  const revertRow = useCallback((rowKey: string) => {
    for (const entry of derivedRef.current?.buffer.entries() ?? [])
      if (entry.addr.rowKey === rowKey) callbacksRef.current?.onRevert(entry.addr);
  }, []);
  // Row meta, save cleanup and model resets belong to the host.
  const noop = useCallback(() => {}, []);
  const current = useCallback(() => derivedRef.current?.buffer ?? createEditBuffer(), []);
  const prior = useCallback((rowKey: string, fieldId: FieldId) => {
    const priors = derivedRef.current?.priors;
    const key = hostCellKey({ rowKey, fieldId });
    return priors?.has(key) ? (priors.get(key) ?? null) : undefined;
  }, []);
  const source = useCallback(
    (rowKey: string, fieldId: FieldId) =>
      derivedRef.current?.sources.get(hostCellKey({ rowKey, fieldId })),
    [],
  );
  const settling = useCallback(
    (rowKey: string, fieldId: FieldId) =>
      derivedRef.current?.settling.has(hostCellKey({ rowKey, fieldId })) === true,
    [],
  );
  const outstanding = useCallback((rowKey: string, fieldId: FieldId) => {
    const key = hostCellKey({ rowKey, fieldId });
    return outstandingRef.current.has(key) ? (outstandingRef.current.get(key) ?? null) : undefined;
  }, []);

  if (derived === null) return null;
  return {
    buffer: derived.buffer,
    prior,
    source,
    settling,
    outstanding,
    settled,
    set,
    updateMeta: noop,
    revert,
    revertRow,
    revertMatching: noop,
    clear: noop,
    isDirty: derived.buffer.cellCount > 0,
    current,
  };
}
