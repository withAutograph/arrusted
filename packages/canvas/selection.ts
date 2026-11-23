import { useCallback, useMemo, useSyncExternalStore } from "react";
import type {
  DataDefinition,
  QueryInput,
  WorkSelectionTarget,
} from "@autograph/generated-app-runtime/data";
import { createLabelIndex } from "@autograph/work-session-tools/labels";

import type { RelationKey } from "./record-values";

/** What the user selected in one unit; hosts pass it to the agent. */
export type CanvasSelection =
  | {
      kind: "cells";
      unit_id: string;
      model_id: string;
      cells: readonly { record_id: string; field_id: string }[];
    }
  | { kind: "rows"; unit_id: string; model_id: string; record_ids: readonly string[] }
  /** One chart bar: the group key value of `field_id`. */
  | { kind: "segment"; unit_id: string; model_id: string; field_id: string; value: unknown }
  /**
   * Graph nodes. `field_id`, when set, is the field each node is a value of
   * (the graph's relation), so one node can filter `model_id` by it. `key`
   * is the relation key the field stores for that node (its record id or
   * external key); the filter compares it, else the record id.
   */
  | {
      kind: "nodes";
      unit_id: string;
      model_id: string;
      record_ids: readonly string[];
      field_id?: string;
      key?: RelationKey;
    };
export type CanvasFilter = {
  model_id: string;
  field_id: string;
  op: "eq";
  value: string | boolean;
};

/** Scalar field types the data client filters with `eq`. */
const filterable = new Set([
  "text",
  "number",
  "bool",
  "date",
  "datetime",
  "enum",
  "iso_country",
  "iso_currency",
  "relation",
]);

/**
 * The filter a selection sets: only one chart bar or one graph node on a
 * filterable scalar field filters. Cells, rows, several nodes, null groups
 * and bins (money bins included) select without filtering.
 */
export function selectionFilter(
  definition: DataDefinition,
  selection: CanvasSelection | null,
): CanvasFilter | null {
  if (selection === null) return null;
  const picked =
    selection.kind === "segment"
      ? { field_id: selection.field_id, value: selection.value }
      : selection.kind === "nodes" &&
          selection.record_ids.length === 1 &&
          selection.field_id !== undefined
        ? { field_id: selection.field_id, value: selection.key?.value ?? selection.record_ids[0] }
        : null;
  if (picked === null) return null;
  const labels = createLabelIndex(definition);
  const field = labels.fieldById(labels.modelById(selection.model_id), picked.field_id);
  if (field === undefined || !filterable.has(field.type)) return null;
  // A relation group key is a record key; its record id is the filter value.
  const raw =
    field.type === "relation" &&
    picked.value !== null &&
    typeof picked.value === "object" &&
    (picked.value as { type?: unknown }).type === "record_id"
      ? (picked.value as { value: unknown }).value
      : picked.value;
  if (typeof raw !== "string" && typeof raw !== "boolean") return null;
  return { model_id: selection.model_id, field_id: field.id, op: "eq", value: raw };
}

export type SelectionStore = ReturnType<typeof createSelectionStore>;

/** The one canvas-level selection; the filter is derived from it. */
export function createSelectionStore(definition: DataDefinition) {
  let state: { selection: CanvasSelection | null; filter: CanvasFilter | null } = {
    selection: null,
    filter: null,
  };
  const listeners = new Set<() => void>();
  return {
    definition,
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    select(selection: CanvasSelection | null) {
      state = { selection, filter: selectionFilter(definition, selection) };
      for (const listener of listeners) listener();
    },
  };
}

/** The selection, its filter, and the query filter each unit applies. */
export function useCanvasSelection(store: SelectionStore) {
  const { selection, filter } = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const labels = useMemo(() => createLabelIndex(store.definition), [store.definition]);
  /** The `where` for a unit: the filter applies to other units on its model, by field name. */
  const whereFor = useCallback(
    (unitId: string, modelId: string): NonNullable<QueryInput["where"]> => {
      if (filter === null || filter.model_id !== modelId || selection?.unit_id === unitId)
        return [];
      const field = labels.fieldById(labels.modelById(modelId), filter.field_id);
      return field === undefined ? [] : [{ field: field.name, op: "eq", value: filter.value }];
    },
    [filter, labels, selection],
  );
  return {
    selection,
    filter,
    whereFor,
    select: store.select,
    clear: useCallback(() => store.select(null), [store]),
  };
}

/**
 * Whether a selection no longer stands because its unit's query changed (or
 * the unit went) between two layouts; `before` is null for the first layout.
 * Configs are compared as JSON, by unit id.
 */
export function selectionOutdated(
  selection: CanvasSelection | null,
  before: ReadonlyMap<string, string> | null,
  now: ReadonlyMap<string, string>,
): boolean {
  if (selection === null || before === null || !before.has(selection.unit_id)) return false;
  return before.get(selection.unit_id) !== now.get(selection.unit_id);
}

/** How long a selection settles before it is written as presence. */
export const PRESENCE_DEBOUNCE_MS = 500;
/** The most targets one presence write carries. */
export const PRESENCE_MAX_TARGETS = 200;

/** A selection as presence targets: cells, rows or graph nodes; a chart bar names no record. */
export function presenceTargets(selection: CanvasSelection | null): WorkSelectionTarget[] {
  if (selection === null) return [];
  const targets: WorkSelectionTarget[] =
    selection.kind === "cells"
      ? selection.cells.map((cell) => ({
          model_id: selection.model_id,
          record_id: cell.record_id,
          field_id: cell.field_id,
        }))
      : selection.kind === "rows" || selection.kind === "nodes"
        ? selection.record_ids.map((record_id) => ({ model_id: selection.model_id, record_id }))
        : [];
  return targets.slice(0, PRESENCE_MAX_TARGETS);
}

/** Targets compared by what they name, whatever their keys' order (jsonb sorts them). */
const presenceKey = (targets: readonly WorkSelectionTarget[]) =>
  JSON.stringify(
    targets.map((target) => [target.model_id, target.record_id, target.field_id ?? null]),
  );

/**
 * Writes the person's selection as presence once it settles: each new
 * selection cancels the pending write first, so a selection undone within
 * the debounce (empty → selected → empty, A → B → A) writes nothing new.
 * Store changes that leave the selection as it is (filters, views) neither
 * write nor delay a pending write. Nothing is written until `known` says
 * what presence holds (the session's `get`): then the current selection is
 * written once if it differs, so a reopened canvas never leaves an old
 * selection standing. Writes are serialized: while one is in flight the
 * latest settled selection waits and is sent after it, so a slow write of A
 * never lands after B.
 */
export function createPresenceWriter(
  /** Writes one selection; a returned promise holds the next write until it settles. */
  write: (targets: WorkSelectionTarget[]) => unknown,
  timers: {
    setTimeout: (run: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  } = {
    setTimeout: (run, ms) => globalThis.setTimeout(run, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
) {
  /** What presence holds, as last written or read; null until known. */
  let written: string | null = null;
  let latest: WorkSelectionTarget[] = [];
  let pending: { key: string; timer: unknown } | null = null;
  /** A write in flight, and the settled selection to send once it is done. */
  let inFlight = false;
  let queued: WorkSelectionTarget[] | null = null;
  /** Disposed (the canvas left this session): nothing more is sent. */
  let disposed = false;
  const send = (targets: WorkSelectionTarget[]) => {
    if (disposed) return;
    if (inFlight) {
      queued = targets;
      return;
    }
    const settled = () => {
      inFlight = false;
      const next = queued;
      queued = null;
      if (next !== null) send(next);
    };
    inFlight = true;
    let result: unknown;
    try {
      result = write(targets);
    } catch {
      result = undefined;
    }
    if (typeof (result as PromiseLike<unknown> | undefined)?.then === "function")
      void Promise.resolve(result)
        .catch(() => {})
        .finally(settled);
    else settled();
  };
  const cancel = () => {
    if (pending !== null) timers.clearTimeout(pending.timer);
    pending = null;
  };
  const next = (targets: WorkSelectionTarget[]) => {
    latest = targets;
    if (written === null || disposed) return;
    const key = presenceKey(targets);
    if (key === (pending?.key ?? written)) return;
    cancel();
    if (key === written) return;
    pending = {
      key,
      timer: timers.setTimeout(() => {
        pending = null;
        written = key;
        send(targets);
      }, PRESENCE_DEBOUNCE_MS),
    };
  };
  return {
    next,
    /** What presence holds now (from the session's `get`); once, then the current selection follows. */
    known(stored: readonly WorkSelectionTarget[]) {
      if (written !== null) return;
      written = presenceKey(stored);
      next(latest);
    },
    cancel,
    /** Leave the session: cancel the pending write and drop the queued one. */
    dispose() {
      disposed = true;
      cancel();
      queued = null;
    },
  };
}
