import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Button, cx } from "@autograph/components";
import { ChevronRight } from "@autograph/icons";
import type { DataModel, QueryInput, WorkChange } from "@autograph/generated-app-runtime/data";
import { createLabelIndex, fieldHeader, modelLabel } from "@autograph/work-session-tools/labels";
import type { FieldValue, VisibleRecord } from "@contracts";
import {
  EditableRowVersionGrid,
  useEditableRowVersionGridPreview,
  type CellNote,
  agGridEnterpriseEnabled,
  type CellFocusedEvent,
  type CellSelectionChangedEvent,
  type GridApi,
  type SelectionChangedEvent,
  type CellPin,
  type EditableRowVersionGridSurfaceProps,
  type FieldOverrides,
  type HostStagedCell,
  type RelationOption,
  type RelationOptionsByModel,
  type RelationSearchByModel,
} from "@modules/editable-grid";

import { failureMessage, type CanvasClient, type CanvasRecord } from "./client";
import { formatMoney, formatNumber } from "./money";
import {
  creationMarkField,
  draftMark,
  draftOrigin,
  formatValue,
  gridSchema,
  naturalOrder,
  naturalRecordOrder,
  moneyDefaults,
  recordTitle,
  relationKey,
  relationKeyFilter,
  relationKeyId,
  shownFields,
  titleField,
  toVisibleRecord,
  type RelationKey,
} from "./record-values";

import { useLeavingEntries } from "./leaving";
import { replacedYours } from "./provenance";
import { useCanvasSelection, type SelectionStore } from "./selection";
import type { CanvasSession } from "./use-canvas-session";

/** A money cell (and its "was …") as people read it: `$150,000`, `$42.50/hr`. */
const moneyCell = (_value: unknown, value: FieldValue | null | undefined) =>
  value?.type === "money_rate" ? formatMoney(value.value.amount, value.value) : "";
/**
 * A derived number cell, rounded for reading (a quotient has ~28 decimals).
 * The cell's own value comes first, as the grid's default formatter reads it.
 */
const numberCell = (raw: unknown, value: FieldValue | null | undefined) =>
  typeof raw === "string" || typeof raw === "number"
    ? formatNumber(raw)
    : value?.type === "number"
      ? formatNumber(String(value.value))
      : "";

export type GridUnitProps = {
  client: CanvasClient;
  /** The canvas's session (`useCanvasSession`): staged entries, revision and `stage`. */
  session: CanvasSession;
  selection: SelectionStore;
  unitId: string;
  modelId: string;
  /**
   * Opens a record. Each row offers it as its own control at the row's start
   * (shown on hover or focus, and Enter on it); a click on a cell only
   * selects or edits the cell.
   */
  onOpenRecord?: (recordId: string) => void;
  /**
   * Comment mode: while set, a click on a cell goes here (by record and field
   * id) instead of opening the record.
   */
  onCellClicked?: (cell: { recordId: string; fieldId: string }) => void;
  /** A marker on a cell, e.g. its open threads; keep it stable across renders. */
  cellPin?: (recordId: string, fieldId: string) => CellPin | undefined;
  /** Rows a page; the data client's page limit. */
  pageSize?: number;
  /** Hears the grid's `reveal` once mounted, and null when it goes. */
  onReveal?: (reveal: GridReveal | null) => void;
};

/**
 * Whether the grid shows a record's cell: the record is among its loaded,
 * displayed rows and the column is displayed. It also scrolls to the cell,
 * unless `scroll` is false; nothing scrolls when it is not shown.
 */
export type GridReveal = (
  recordId: string,
  fieldId: string,
  options?: { scroll?: boolean },
) => boolean;

/** The column of each row's open control: not a field, so never staged or selected. */
export const openColumnId = "__open_record";

type OpenCellParams = {
  data?: VisibleRecord;
  open: (recordId: string) => void;
  name: (recordId: string) => string;
};

/**
 * The field cells a grid's cell ranges cover, in order. The row's open
 * control is not a field: a range across it selects only the fields.
 */
export function rangeCells(
  ranges: readonly {
    startRow?: { rowIndex: number } | null;
    endRow?: { rowIndex: number } | null;
    columns: readonly { getColId(): string }[];
  }[],
  rowAt: (index: number) => { record_id?: string } | undefined,
): { record_id: string; field_id: string }[] {
  const cells: { record_id: string; field_id: string }[] = [];
  for (const range of ranges) {
    if (!range.startRow || !range.endRow) continue;
    const from = Math.min(range.startRow.rowIndex, range.endRow.rowIndex);
    const to = Math.max(range.startRow.rowIndex, range.endRow.rowIndex);
    const fields = range.columns
      .map((column) => column.getColId())
      .filter((id) => id !== openColumnId);
    for (let index = from; index <= to; index += 1) {
      const recordId = rowAt(index)?.record_id;
      if (recordId === undefined) continue;
      for (const field_id of fields) cells.push({ record_id: recordId, field_id });
    }
  }
  return cells;
}

/** The field cell a focus event names; checkbox, open and other grid-made columns are not fields. */
export function focusedCell(
  event: {
    rowIndex: number | null;
    rowPinned?: unknown;
    column: { getColId(): string } | string | null;
  },
  fieldIds: ReadonlySet<string>,
  rowAt: (index: number) => { record_id?: string } | undefined,
): { record_id: string; field_id: string } | null {
  if (event.rowIndex === null || event.rowPinned) return null;
  const field_id = typeof event.column === "string" ? event.column : event.column?.getColId();
  if (field_id === undefined || !fieldIds.has(field_id)) return null;
  const record_id = rowAt(event.rowIndex)?.record_id;
  return record_id === undefined ? null : { record_id, field_id };
}

/** A row's open control: a quiet icon button that shows on row hover or focus. */
function OpenRecordCell({ data, open, name }: OpenCellParams) {
  if (data?.record_id === undefined) return null;
  const recordId = data.record_id;
  return (
    <button
      aria-label={`Open ${name(recordId)}`}
      className="flex size-[var(--size-control-xs)] items-center justify-center rounded-[var(--radius-control)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]"
      data-open-record={recordId}
      title="Open"
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        open(recordId);
      }}
    >
      <ChevronRight aria-hidden className="size-[var(--size-icon-sm)]" />
    </button>
  );
}

/** A staged row with a note under its "was …" line is three lines tall. */
const tallRowHeight = 66;
const searchLimit = 20;
/** Matches a picker reads to rank by name: the data client's largest page. */
const searchScan = 100;

/**
 * A picker's options from `found`, the kernel's first matches in its text
 * order (at most `scan`). All of them (fewer than `scan`): the first `limit`
 * in natural order (L2 before L10). A full scan may stop short of the rest,
 * so it keeps the kernel's order rather than rank a partial set.
 */
export function pickerPage<T extends { label: string }>(
  found: readonly T[],
  limit: number,
  scan: number,
): { options: T[]; truncated: boolean } {
  const complete = found.length < scan;
  const ordered = complete
    ? found.toSorted((a, b) => naturalOrder.compare(a.label, b.label))
    : found;
  return { options: ordered.slice(0, limit), truncated: found.length > limit };
}
/** Pages a grid loads on its own to reach a row another unit selected. */
const followPageLimit = 5;
/** The kernel's largest list offset: a grid pages no further (a filter narrows it). */
export const maxListOffset = 10_000;
/** Linked records outside the picker's page are read by key, this many at a time. */
const keyReadBatch = 10;
/** Widths that fit a staged cell's "agent was …" line; narrower units scroll sideways. */
const minWidths: Record<string, number> = {
  money_rate: 200,
  relation: 180,
  number: 120,
  bool: 100,
  enum: 140,
};

/**
 * How a rendered header lays out: its label font, and the width around the
 * label (cell padding, menu and filter buttons, gaps). Read from the grid once
 * it renders, so headers size to the theme rather than to a guess.
 */
type HeaderMetrics = { font: string; chrome: number };
/** Room for the sort arrow a sorted header adds beside its label. */
const sortIndicatorWidth = 24;
/** Before the grid renders (and in tests): a wide-enough estimate per character, and Quartz's chrome. */
const fallbackHeaderMetrics = { charWidth: 8.5, chrome: 80 };
let measureCanvas: HTMLCanvasElement | undefined;

/** The width a header needs to show its whole label. */
function headerWidth(label: string, metrics: HeaderMetrics | null): number {
  const context =
    metrics === null ? null : (measureCanvas ??= document.createElement("canvas")).getContext("2d");
  if (metrics === null || context === null)
    return Math.ceil(
      label.length * fallbackHeaderMetrics.charWidth +
        fallbackHeaderMetrics.chrome +
        sortIndicatorWidth,
    );
  context.font = metrics.font;
  return Math.ceil(context.measureText(label).width + metrics.chrome + sortIndicatorWidth);
}

/** The header layout of a rendered grid, or null when nothing is laid out yet. */
function readHeaderMetrics(root: HTMLElement | null): HeaderMetrics | null {
  const text = [...(root?.querySelectorAll<HTMLElement>(".ag-header-cell-text") ?? [])].find(
    (element) => element.textContent !== "",
  );
  const cell = text?.closest<HTMLElement>(".ag-header-cell");
  const label = text?.closest<HTMLElement>(".ag-header-cell-label");
  // Layout widths (offsetWidth) ignore the canvas's zoom transform.
  if (text == null || cell == null || label == null) return null;
  const font = getComputedStyle(text).font;
  const chrome = cell.offsetWidth - label.offsetWidth;
  // No font or no chrome: nothing real is laid out (a DOM without layout).
  return font === "" || chrome <= 0 ? null : { font, chrome };
}

type Rows = {
  key: string;
  records: CanvasRecord[];
  total: number | null;
  status: "loading" | "ready" | "error";
  error: string | null;
  /** The `begin` number of the read shown, when the caller numbers reads. */
  read: number | null;
};

const noRecords: CanvasRecord[] = [];
const failure = (error: unknown) => failureMessage(error, "The records could not be read.");

/**
 * One model's records over the session, read a page at a time. Every new
 * revision, filter or as-of re-reads the pages already shown, so staged
 * values (including the agent's) appear as they land.
 */
export function useSessionRows(
  client: CanvasClient,
  model: DataModel | undefined,
  input: {
    sessionId: string | null;
    asOf: string | null;
    where: QueryInput["where"];
    revision: number | null;
    /** The session's read generation: a read at the same revision re-reads too. */
    generation: number;
  },
  pageSize: number,
  /** Numbers each read as it begins (see `useLeavingEntries`). */
  begin?: () => number,
) {
  const whereKey = JSON.stringify(input.where ?? []);
  const key = `${model?.id}|${input.sessionId}|${input.asOf}|${whereKey}`;
  const [rows, setRows] = useState<Rows>({
    key,
    records: [],
    total: null,
    status: "loading",
    error: null,
    read: null,
  });
  const beginRef = useRef(begin);
  beginRef.current = begin;
  const pages = useRef(1);
  const latest = useRef(0);
  /** The newest read whose rows are shown, and the query it answered. */
  const applied = useRef(0);
  const currentKey = useRef(key);
  currentKey.current = key;
  const title = model === undefined ? undefined : titleField(model);

  const query = useCallback(
    (offset: number, limit: number): QueryInput => ({
      asOf: input.asOf!,
      work: { sessionId: input.sessionId! },
      where: JSON.parse(whereKey) as QueryInput["where"],
      orderBy: [
        ...(title === undefined ? [] : [{ field: title.name, direction: "asc" as const }]),
        { field: "id", direction: "asc" as const },
      ],
      offset,
      limit,
    }),
    [input.asOf, input.sessionId, whereKey, title],
  );

  const read = useCallback(
    async (count: number) => {
      if (model === undefined || input.sessionId === null || input.asOf === null) return;
      const ticket = (latest.current += 1);
      const read = beginRef.current?.() ?? null;
      try {
        const records: CanvasRecord[] = [];
        for (let page = 0; page < count; page += 1) {
          const batch = await client.data.list(model.id, query(page * pageSize, pageSize));
          records.push(...batch);
          if (batch.length < pageSize) break;
        }
        const { asOf, work, where } = query(0, pageSize);
        const counted = await client.data.aggregate(model.id, {
          asOf,
          work,
          where,
          metrics: [{ fn: "count" }],
        });
        // Any read newer than the rows shown lands, even while a later one is
        // still running: re-reads restart on every revision, so waiting for the
        // latest alone could leave staged values (and derived ones) unshown
        // for as long as revisions keep coming.
        if (ticket <= applied.current || key !== currentKey.current) return;
        applied.current = ticket;
        const total = Number(counted.total.metrics[0] ?? records.length);
        // A refresh that began before loadMore must not shrink its reserved page window.
        pages.current = Math.max(pages.current, 1, Math.ceil(records.length / pageSize));
        // Every record loaded: names in natural order (L4 … L10). A partial
        // set keeps the kernel's text order, which its next page continues.
        const ordered = records.length >= total ? naturalRecordOrder(model, records) : records;
        setRows({ key, records: ordered, total, status: "ready", error: null, read });
      } catch (error) {
        if (ticket !== latest.current) return;
        // Rows of another query are not this one's: keep them only for the same query.
        setRows((current) =>
          current.key === key
            ? // The rows shown stay with their own read: leaving entries keep
              // settling (beside "Could not refresh") rather than show a
              // staged value as if it were saved.
              { ...current, status: "error", error: failure(error) }
            : { key, records: [], total: null, status: "error", error: failure(error), read },
        );
      }
    },
    [client, model, input.sessionId, input.asOf, query, pageSize, key],
  );

  // A new filter or session starts from the first page; a new revision re-reads what is shown.
  const shownKey = useRef(key);
  useEffect(() => {
    if (shownKey.current !== key) {
      shownKey.current = key;
      pages.current = 1;
    }
    void read(pages.current);
  }, [read, key, input.revision, input.generation]);

  const loading = useRef(false);
  /** Reads one more page; false when it read nothing (a load running, or past the kernel's offset). */
  const loadMore = useCallback(async (): Promise<boolean> => {
    if (loading.current || pages.current * pageSize > maxListOffset) return false;
    loading.current = true;
    try {
      // Counted at once, so a re-read that starts meanwhile reads this page too.
      pages.current += 1;
      await read(pages.current);
      return true;
    } finally {
      loading.current = false;
    }
  }, [read, pageSize]);

  const current =
    rows.key === key
      ? rows
      : { ...rows, records: noRecords, total: null, status: "loading" as const, read: null };
  return { ...current, loadMore };
}

/**
 * The records a link column can choose: the target model's first page, plus
 * the grid's own rows for a link into its own model, plus any found by search,
 * plus the records the loaded rows and staged entries link to, read by key so
 * they are named even when outside the first page.
 */
function useRelationOptions(
  client: CanvasClient,
  model: DataModel | undefined,
  input: {
    sessionId: string | null;
    asOf: string | null;
    revision: number | null;
    generation: number;
  },
  own: readonly CanvasRecord[],
  entries: readonly WorkChange[],
  pageSize: number,
) {
  const definition = client.definition;
  const targets = useMemo(
    () =>
      [
        ...new Set(
          (model === undefined ? [] : shownFields(model))
            .filter((field) => field.type === "relation" && typeof field.target_model === "string")
            .map((field) => field.target_model as string),
        ),
      ].flatMap((id) => {
        const target = definition.models.find((item) => item.id === id);
        return target === undefined ? [] : [target];
      }),
    [definition, model],
  );
  const [loaded, setLoaded] = useState<Record<string, RelationOption[]>>({});
  const [picked, setPicked] = useState<Record<string, RelationOption[]>>({});
  const [linked, setLinked] = useState<Record<string, RelationOption[]>>({});
  const option = (target: DataModel, record: CanvasRecord): RelationOption => ({
    key: { type: "record_id", value: record.id },
    label: recordTitle(target, record),
    ...(typeof record.externalKey === "string"
      ? { aliasKeys: [{ type: "external_key" as const, value: record.externalKey }] }
      : {}),
  });

  useEffect(() => {
    if (input.sessionId === null || input.asOf === null || targets.length === 0) return;
    let live = true;
    void Promise.all(
      targets.map(async (target) => {
        const title = titleField(target);
        const records = await client.data.list(target.id, {
          asOf: input.asOf!,
          work: { sessionId: input.sessionId! },
          ...(title === undefined ? {} : { orderBy: [{ field: title.name, direction: "asc" }] }),
          limit: pageSize,
        });
        return [target.id, records.map((record) => option(target, record))] as const;
      }),
    )
      .then((entries) => {
        if (live) setLoaded(Object.fromEntries(entries));
      })
      .catch(() => {
        // Links then label as unknown records; the grid itself still loads.
      });
    return () => {
      live = false;
    };
  }, [client, targets, input.sessionId, input.asOf, input.revision, input.generation, pageSize]);

  // Keys the loaded rows and staged entries link to that the first pages do not name, by target.
  const missingKey = useMemo(() => {
    if (model === undefined) return "[]";
    const known = new Set<string>();
    const knows = (targetId: string, items: readonly RelationOption[]) => {
      for (const item of items)
        for (const key of [item.key, ...(item.aliasKeys ?? [])])
          known.add(`${targetId}|${relationKeyId(key)}`);
    };
    for (const target of targets) {
      // A pick is not known: its record is re-read so a rename after the pick shows.
      knows(target.id, loaded[target.id] ?? []);
      if (target.id === model.id)
        knows(
          target.id,
          own.map((record) => option(target, record)),
        );
    }
    const missing = new Map<string, [string, RelationKey]>();
    const want = (targetId: string, value: unknown) => {
      const key = relationKey(value);
      if (key === null) return;
      const id = `${targetId}|${relationKeyId(key)}`;
      if (!known.has(id)) missing.set(id, [targetId, key]);
    };
    for (const field of shownFields(model)) {
      if (field.type !== "relation" || typeof field.target_model !== "string") continue;
      const targetId = field.target_model;
      for (const record of own) want(targetId, record[field.name]);
      for (const entry of entries)
        if (entry.model_id === model.id && entry.field_id === field.id)
          for (const value of [entry.value, entry.baseline, entry.current_value])
            want(targetId, value?.value);
    }
    return JSON.stringify(
      [...missing.values()].toSorted(([a, x], [b, y]) =>
        `${a}|${relationKeyId(x)}`.localeCompare(`${b}|${relationKeyId(y)}`),
      ),
    );
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `option` is pure.
  }, [model, targets, loaded, picked, own, entries]);

  useEffect(() => {
    const missing = JSON.parse(missingKey) as [string, RelationKey][];
    if (input.sessionId === null || input.asOf === null || missing.length === 0) return;
    const scope = { asOf: input.asOf, work: { sessionId: input.sessionId } };
    let live = true;
    void (async () => {
      const found: Record<string, RelationOption[]> = {};
      // At most one read per linked key of the loaded rows, a few at a time.
      for (let start = 0; start < missing.length && live; start += keyReadBatch)
        await Promise.all(
          missing.slice(start, start + keyReadBatch).map(async ([targetId, key]) => {
            const target = targets.find((item) => item.id === targetId);
            if (target === undefined) return;
            // A link that cannot be read stays an unknown record.
            const [record] = await client.data
              .list(target.id, { ...scope, where: [relationKeyFilter(key)], limit: 1 })
              .catch(() => []);
            if (record !== undefined) (found[target.id] ??= []).push(option(target, record));
          }),
        );
      if (live) setLinked(found);
    })();
    return () => {
      live = false;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `option` is pure.
  }, [client, targets, missingKey, input.sessionId, input.asOf, input.revision, input.generation]);

  const computedOptions = useMemo<RelationOptionsByModel>(
    () =>
      Object.fromEntries(
        targets.map((target) => {
          const merged = new Map<string, RelationOption>();
          // Later reads rename a record; the aliases earlier ones gave it are kept.
          const add = (items: readonly RelationOption[]) => {
            for (const item of items)
              merged.set(item.key.value, { ...merged.get(item.key.value), ...item });
          };
          // A pick is only a fallback until a read of its record names it afresh.
          add(picked[target.id] ?? []);
          add(linked[target.id] ?? []);
          add(loaded[target.id] ?? []);
          if (target.id === model?.id) add(own.map((record) => option(target, record)));
          return [
            target.id,
            [...merged.values()].toSorted((a, b) => naturalOrder.compare(a.label, b.label)),
          ];
        }),
      ),
    [targets, loaded, linked, own, picked, model],
  );
  // Rebuilding the grid's columns closes an open editor, and every revision
  // re-reads the options: keep the previous object while its content is equal.
  const optionsRef = useRef(computedOptions);
  if (!sameOptions(optionsRef.current, computedOptions)) optionsRef.current = computedOptions;
  const optionsByModel = optionsRef.current;

  const sessionRef = useRef(input);
  sessionRef.current = input;
  const searchByModel = useMemo<RelationSearchByModel>(
    () =>
      Object.fromEntries(
        targets.flatMap((target) => {
          const title = titleField(target);
          if (title === undefined) return [];
          return [
            [
              target.id,
              async (query: string) => {
                const { sessionId, asOf } = sessionRef.current;
                if (sessionId === null || asOf === null) return { options: [], truncated: false };
                const records = await client.data.list(target.id, {
                  asOf,
                  work: { sessionId },
                  // An empty query (the picker opening) lists the first options.
                  ...(query.trim() === "" ? {} : { search: { query, fields: [title.name] } }),
                  orderBy: [{ field: title.name, direction: "asc" }],
                  // Enough to rank by name: the kernel orders names as text.
                  limit: searchScan,
                });
                return pickerPage(
                  records.map((record) => option(target, record)),
                  searchLimit,
                  searchScan,
                );
              },
            ],
          ];
        }),
      ),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `option` is pure.
    [client, targets],
  );
  const onPicked = useCallback((targetId: string, item: { key: unknown; label: unknown }) => {
    const key = item.key as RelationOption["key"];
    if (key.type !== "record_id" || typeof item.label !== "string") return;
    const label = item.label;
    setPicked((current) => ({
      ...current,
      [targetId]: [
        ...(current[targetId] ?? []).filter((entry) => entry.key.value !== key.value),
        { key, label },
      ],
    }));
  }, []);
  return { optionsByModel, searchByModel, onPicked };
}

const cellKey = (recordId: string, fieldId: string) => `${recordId}:${fieldId}`;

const stagedCell = (entry: WorkChange, settling: boolean): HostStagedCell => ({
  rowKey: entry.record_id,
  fieldId: entry.field_id,
  value: entry.value,
  prior: entry.baseline,
  source: entry.source,
  ...(settling ? { settling } : {}),
});

/**
 * One model of the app on the shared editable grid, over the work session.
 * Rows are the session's view of the records (staged values applied); the
 * session's staged entries are the grid's host-owned pending set, so a
 * staged cell shows its value, "was …" and the agent marker, and its revert
 * unstages it. Cell edits stage through the session; the kernel judges them,
 * and a rejected edit shows why on its cell. Selecting cells or rows sets the
 * canvas selection; a filter set by another unit narrows the rows.
 */
export function GridUnit({
  client,
  session,
  selection: store,
  unitId,
  modelId,
  onOpenRecord,
  onCellClicked,
  cellPin,
  pageSize = 100,
  onReveal,
}: GridUnitProps) {
  const definition = client.definition;
  const labels = useMemo(() => createLabelIndex(definition), [definition]);
  const model = labels.modelById(modelId);
  const schema = useMemo(() => gridSchema(definition), [definition]);
  const { whereFor, filter, select, clear } = useCanvasSelection(store);
  const where = whereFor(unitId, modelId);
  const header = session.session;
  const sessionId = header?.id ?? null;
  const asOf = header?.as_of ?? null;
  const revision = session.revision;
  const generation = session.generation;
  const title = model === undefined ? undefined : titleField(model);

  const entries = useMemo(
    () => session.entries.filter((entry) => entry.model_id === modelId),
    [session.entries, modelId],
  );
  const left = useLeavingEntries(entries);
  const rows = useSessionRows(
    client,
    model,
    { sessionId, asOf, where, revision, generation },
    pageSize,
    left.begin,
  );
  const relations = useRelationOptions(
    client,
    model,
    { sessionId, asOf, revision, generation },
    rows.records,
    entries,
    pageSize,
  );

  // Rebuilt only when a read lands (a new revision, filter or page), not every render.
  const readRows = useMemo<VisibleRecord[]>(
    () =>
      model === undefined || asOf === null
        ? []
        : rows.records.map((record) => toVisibleRecord(labels, model, record, asOf)),
    [labels, model, rows.records, asOf],
  );
  // An entry that left after the shown read began stays staged, with a
  // spinner, until a read begun after it left shows the value beneath.
  const leaving = left.leaving(rows.read);
  const pending = [
    ...entries.map((entry) => stagedCell(entry, false)),
    ...leaving.map((entry) => stagedCell(entry, true)),
  ];

  // What shows from pending drafts (Show drafts on), by record: a quiet
  // "draft" mark on those values, and records only a draft creates stay
  // read-only here (they are edited in Review).
  const origins = useMemo(
    () =>
      new Map(
        model === undefined
          ? []
          : rows.records.flatMap((record) => {
              const origin = draftOrigin(model, record);
              return origin === null ? [] : [[record.id, origin] as const];
            }),
      ),
    [model, rows.records],
  );
  const created = useMemo(
    () => new Set([...origins].flatMap(([id, origin]) => (origin.created === null ? [] : [id]))),
    [origins],
  );
  const createdRef = useRef(created);
  createdRef.current = created;
  const markFieldId = creationMarkField(model);
  const cellMark = useCallback(
    (recordId: string, fieldId: string) =>
      draftMark(origins.get(recordId) ?? null, fieldId, markFieldId),
    [origins, markFieldId],
  );
  const rowReadOnly = useCallback((recordId: string) => createdRef.current.has(recordId), []);

  // Edits the kernel did not stage, by cell, until that cell stages or reverts.
  const [rejected, setRejected] = useState<ReadonlyMap<string, string>>(new Map());
  const gridRoot = useRef<HTMLDivElement>(null);
  const [headerMetrics, setHeaderMetrics] = useState<HeaderMetrics | null>(null);
  const settle = useCallback((recordId: string, fieldId: string, message: string | null) => {
    setRejected((current) => {
      const key = cellKey(recordId, fieldId);
      if (message === null && !current.has(key)) return current;
      const next = new Map(current);
      if (message === null) next.delete(key);
      else next.set(key, message);
      return next;
    });
  }, []);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  // Edits stage one at a time, in order, each at the revision the last one left.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const inOrder = useCallback(<T,>(run: () => Promise<T>): Promise<T> => {
    const next = queue.current.then(run);
    queue.current = next.catch(() => {});
    return next;
  }, []);
  const onStage = useCallback(
    async (edit: { rowKey: string; fieldId: string; value: FieldValue | null }) => {
      // A record only a pending draft creates is edited in Review, never staged here.
      if (createdRef.current.has(edit.rowKey)) {
        settle(
          edit.rowKey,
          edit.fieldId,
          "Not staged: this record is new in a draft. Edit it in Review.",
        );
        return;
      }
      const change = {
        model_id: modelId,
        record_id: edit.rowKey,
        field_id: edit.fieldId,
        value: edit.value,
      };
      const outcome = await inOrder(async () => {
        const first = await sessionRef.current.stage([change]);
        // An agent staged meanwhile: the user's edit still stands, so it stages once more.
        return !first.ok && first.code === "revision_conflict"
          ? sessionRef.current.stage([change])
          : first;
      });
      settle(
        edit.rowKey,
        edit.fieldId,
        outcome.ok
          ? null
          : outcome.code === "outcome_unknown"
            ? "Not confirmed: check the value"
            : `Edit not kept. ${outcome.message}`,
      );
    },
    [modelId, settle, inOrder],
  );
  /** "Restore yours": the user's value the agent replaced, staged again as theirs. */
  const onRestore = useCallback(
    async (entry: WorkChange) => {
      const outcome = await inOrder(() => sessionRef.current.restore(entry));
      settle(
        entry.record_id,
        entry.field_id,
        outcome.ok
          ? null
          : outcome.code === "revision_conflict"
            ? "Not restored. The session changed; check the value and try again."
            : outcome.code === "outcome_unknown"
              ? "Not confirmed: check the value"
              : `Not restored. ${outcome.message}`,
      );
    },
    [settle, inOrder],
  );
  const onRevert = useCallback(
    async (cell: { rowKey: string; fieldId: string }) => {
      settle(cell.rowKey, cell.fieldId, null);
      const target = { model_id: modelId, record_id: cell.rowKey, field_id: cell.fieldId };
      // The entry the user chose to restore; if it changed by the time this runs, it stays.
      const shown = sessionRef.current.entries.find(
        (entry) =>
          entry.model_id === modelId &&
          entry.record_id === cell.rowKey &&
          entry.field_id === cell.fieldId,
      );
      const outcome = await inOrder(() => sessionRef.current.unstage(target, shown));
      // A conflict is not retried: what is staged there now may not be what the user restored.
      settle(
        cell.rowKey,
        cell.fieldId,
        outcome.ok
          ? null
          : outcome.code === "outcome_unknown"
            ? "Not confirmed: check the value"
            : outcome.code === "revision_conflict"
              ? "Not restored. The session changed; check the value and try again."
              : `Not restored. ${outcome.message}`,
      );
    },
    [modelId, settle, inOrder],
  );

  const display = useCallback(
    (fieldId: string, value: FieldValue | null | undefined) => {
      const field = schema.models
        .find((item) => item.id === modelId)
        ?.fields.find((f) => f.id === fieldId);
      if (field === undefined || value == null) return "empty";
      return (
        formatValue(
          field,
          value,
          (key) =>
            relations.optionsByModel[field.target_model ?? ""]?.find((option) =>
              [option.key, ...(option.aliasKeys ?? [])].some(
                (known) => known.type === key.type && known.value === key.value,
              ),
            )?.label,
        ) || "empty"
      );
    },
    [schema, modelId, relations.optionsByModel],
  );

  // The currency and period an empty money value takes, by record (its editor starts there).
  const defaults = useMemo(
    () =>
      new Map(
        model === undefined
          ? []
          : rows.records.map(
              (record) =>
                [
                  record.id,
                  moneyDefaults(model, record, client.moneyDefaults?.[model.id]),
                ] as const,
            ),
      ),
    [model, rows.records, client.moneyDefaults],
  );
  // Notes under cells: the user's edit the agent replaced, a staged value
  // the record moved away from since, and rejected edits (later ones win).
  // An empty money cell stays blank, as the spike's grid shows it; the
  // currency and period it takes show in the record panel and its editor.
  const notes = new Map<string, CellNote>();
  const restorable = new Map<string, WorkChange>();
  for (const entry of entries)
    if (replacedYours(entry)) {
      restorable.set(cellKey(entry.record_id, entry.field_id), entry);
      notes.set(cellKey(entry.record_id, entry.field_id), {
        // The cell's agent marker says who: the note keeps to one short line.
        text: "Replaced your edit",
        action: { label: "Restore", ariaLabel: "Restore yours", onSelect: () => {} },
      });
    }
  // A stale value says what the record holds now, as one quiet line under
  // "was …"; an agent value that replaced yours keeps saying so, with
  // Restore, beside it.
  for (const entry of entries)
    if (entry.stale && !entry.gone) {
      const key = cellKey(entry.record_id, entry.field_id);
      const changed = `Changed to ${display(entry.field_id, entry.current_value)}`;
      notes.set(
        key,
        restorable.has(key)
          ? {
              text: `${changed} · Replaced your edit`,
              action: { label: "Restore", ariaLabel: "Restore yours", onSelect: () => {} },
            }
          : { text: changed },
      );
    }
  // A refusal shows in place of the note, keeping Restore when the entry still offers it.
  for (const [key, message] of rejected)
    notes.set(key, {
      text: message,
      tone: "danger",
      ...(restorable.has(key)
        ? { action: { label: "Restore", ariaLabel: "Restore yours", onSelect: () => {} } }
        : {}),
    });
  const notesKey = JSON.stringify([...notes]);
  const restoreRef = useRef({ restorable, onRestore });
  restoreRef.current = { restorable, onRestore };
  const cellNote = useMemo(
    () => {
      const current = new Map(notes);
      return (rowKey: string, fieldId: string) => {
        const note = current.get(cellKey(rowKey, fieldId));
        if (note?.action === undefined) return note;
        // The action restores the entry as it is when chosen.
        return {
          ...note,
          action: {
            ...note.action,
            onSelect: () => {
              const { restorable: now, onRestore: restore } = restoreRef.current;
              const entry = now.get(cellKey(rowKey, fieldId));
              if (entry !== undefined) void restore(entry);
            },
          },
        };
      };
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- keyed by content.
    [notesKey],
  );

  const defaultsRef = useRef(defaults);
  defaultsRef.current = defaults;
  const fieldOverrides = useMemo<FieldOverrides>(
    () =>
      Object.fromEntries(
        (model === undefined ? [] : shownFields(model)).map((field) => [
          field.id,
          {
            headerName: fieldHeader(field),
            ...(field.readOnly || field.type === "json" ? { editable: false } : {}),
            // An empty money value starts on the default its note shows.
            ...(field.type === "money_rate"
              ? {
                  formatValue: moneyCell,
                  editorDefaults: (row: VisibleRecord) => defaultsRef.current.get(row.record_id),
                }
              : // Only derived numbers round; an editable one (and its "was …") keeps every digit.
                field.type === "number" && (field.readOnly || "expression" in field)
                ? { formatValue: numberCell }
                : {}),
            // Wide enough for its whole header, and for a staged value's "agent was …" line.
            minWidth: Math.max(
              field.id === title?.id ? 180 : (minWidths[field.type] ?? 140),
              headerWidth(fieldHeader(field), headerMetrics),
            ),
            flex: field.id === title?.id ? 1.2 : 1,
          },
        ]),
      ),
    [model, title, headerMetrics],
  );

  // The records' name column leads; key columns (an identifier such as
  // "Employee Ref") start hidden, still offered in the Columns panel.
  const keyColumns = useMemo(
    () =>
      new Set(
        (model === undefined ? [] : shownFields(model))
          .filter((field) => field.is_unique === true && field.id !== title?.id)
          .map((field) => field.id),
      ),
    [model, title],
  );
  const fieldOrder = useMemo(() => (title === undefined ? [] : [title.id]), [title]);

  const { surfaceProps } = useEditableRowVersionGridPreview({
    modelId,
    asOf: asOf ?? "",
    scope: { appId: schema.app_id, customerId: schema.customer_id },
    rows: readRows,
    schema,
    model: modelId,
    mode: "edit",
    fieldOverrides,
    fieldOrder,
    relationOptionsByModel: relations.optionsByModel,
    relationSearchByModel: relations.searchByModel,
    onRelationOptionPicked: relations.onPicked,
    hostStaging: {
      pending,
      onStage,
      onRevert: (cell) => void onRevert(cell),
    },
    cellNote,
    cellPin,
    cellMark,
    rowReadOnly,
  });

  // A cell with a note (under a staged cell, three lines) makes its row grow.
  const tallKey = JSON.stringify([
    ...new Set([...notes.keys()].map((key) => key.slice(0, key.indexOf(":")))),
  ]);
  const tall = useMemo(() => new Set(JSON.parse(tallKey) as string[]), [tallKey]);
  const api = useRef<GridApi | null>(null);
  useEffect(() => {
    api.current?.resetRowHeights();
  }, [tall]);
  useEffect(() => {
    if (onReveal === undefined) return;
    onReveal((recordId, fieldId, options) => {
      const grid = api.current;
      if (grid === null || grid.isDestroyed()) return false;
      const node = grid.getRowNode(recordId);
      if (node === undefined || !node.displayed || node.rowIndex === null) return false;
      if (grid.getColumn(fieldId)?.isVisible() !== true) return false;
      if (options?.scroll === false) return true;
      grid.ensureNodeVisible(node, "middle");
      grid.ensureColumnVisible(fieldId, "middle");
      return true;
    });
    return () => onReveal(null);
  }, [onReveal]);
  // Each row's open control reads the latest handler and names when used.
  const openRef = useRef({ onOpenRecord, records: rows.records });
  openRef.current = { onOpenRecord, records: rows.records };
  const canOpen = onOpenRecord !== undefined;
  const openColumn = useMemo(() => {
    if (!canOpen) return null;
    const open = (recordId: string) => openRef.current.onOpenRecord?.(recordId);
    return {
      colId: openColumnId,
      headerName: "",
      pinned: "left" as const,
      lockPinned: true,
      lockPosition: "left" as const,
      width: 36,
      minWidth: 36,
      maxWidth: 36,
      resizable: false,
      sortable: false,
      filter: false,
      editable: false,
      suppressMovable: true,
      suppressHeaderMenuButton: true,
      suppressColumnsToolPanel: true,
      cellStyle: { display: "flex", alignItems: "center", justifyContent: "center", padding: 0 },
      cellRenderer: OpenRecordCell,
      cellRendererParams: {
        open,
        name: (recordId: string) =>
          model === undefined
            ? "record"
            : recordTitle(
                model,
                openRef.current.records.find((record) => record.id === recordId),
              ),
      },
      // Enter on the focused cell opens the row's record, as its button does.
      suppressKeyboardEvent: (params: { event: KeyboardEvent; data?: unknown }): boolean => {
        const recordId = (params.data as VisibleRecord | undefined)?.record_id;
        if (params.event.key !== "Enter" || recordId === undefined) return false;
        // The focused button activates itself; only the focused cell opens here.
        const target = params.event.target;
        const onButton = target instanceof Element && target.closest("[data-open-record]") !== null;
        if (!onButton && params.event.type === "keydown") open(recordId);
        return true;
      },
    };
  }, [canOpen, model]);
  const enterprise = agGridEnterpriseEnabled();
  // `initialHide`: hidden when the column is made, so a column shown from the panel stays shown.
  // Community has no Columns panel, so key columns stay visible there.
  const columnDefs = useMemo(
    () => [
      ...(openColumn === null ? [] : [openColumn as (typeof surfaceProps.columnDefs)[number]]),
      ...surfaceProps.columnDefs.map((column) =>
        enterprise && column.colId !== undefined && keyColumns.has(column.colId)
          ? { ...column, initialHide: true }
          : column,
      ),
    ],
    [surfaceProps.columnDefs, keyColumns, openColumn, enterprise],
  );
  const getRowHeight: EditableRowVersionGridSurfaceProps["getRowHeight"] = (params) =>
    surfaceProps.getRowHeight(params) ??
    (params.data && "record_id" in params.data && tall.has(params.data.record_id)
      ? tallRowHeight
      : undefined);

  // Rows another unit selected (a chart's point) are selected and scrolled to
  // here, again whenever the grid's rows reload; a record not loaded yet
  // loads the next page (bounded by the model's records) until it shows.
  const followRef = useRef<() => void>(() => {});
  useEffect(() => {
    let shown: readonly string[] = [];
    let scrolledFor: unknown = null;
    // Each load re-reads the pages shown, so following a far-off row is bounded.
    let loadsFor: unknown = null;
    let loads = 0;
    const follow = () => {
      const grid = api.current;
      if (grid === null || grid.isDestroyed()) return;
      const selection = store.getSnapshot().selection;
      // The grid's own selection: it holds its rows, adopted ones included.
      if (selection?.kind === "rows" && selection.unit_id === unitId) {
        shown = [];
        return;
      }
      const wanted =
        selection?.kind === "rows" && selection.unit_id !== unitId && selection.model_id === modelId
          ? selection.record_ids
          : [];
      if (wanted.length === 0 && shown.length === 0) return;
      // Adopting another unit's selection replaces whatever the grid holds,
      // its own checkbox picks included; clearing drops only what it adopted.
      const stale =
        wanted.length > 0
          ? grid.getSelectedNodes().flatMap((node) => (node.id === undefined ? [] : [node.id]))
          : shown;
      for (const id of stale)
        if (!wanted.includes(id)) grid.getRowNode(id)?.setSelected(false, false, "api");
      shown = wanted;
      let missing = false;
      for (const id of wanted) {
        const node = grid.getRowNode(id);
        if (node === undefined) {
          missing = true;
          continue;
        }
        node.setSelected(true, false, "api");
        // Scrolled to once per selection, not on every reload.
        if (scrolledFor !== selection && node.displayed) {
          grid.ensureNodeVisible(node, "middle");
          scrolledFor = selection;
        }
      }
      if (loadsFor !== selection) {
        loadsFor = selection;
        loads = 0;
      }
      // Only a load that read a page counts toward the limit.
      if (missing && canLoadMoreRef.current && loads < followPageLimit)
        void loadMoreRef.current().then((loaded) => {
          if (loaded && loadsFor === selection) {
            loads += 1;
            // A newer refresh can land while this load runs. Resume even when
            // its row-change notification already tried to follow a busy load.
            setTimeout(() => followRef.current(), 0);
          }
        });
    };
    followRef.current = follow;
    follow();
    const unsubscribe = store.subscribe(follow);
    return () => {
      followRef.current = () => {};
      unsubscribe();
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the load-more refs are read when it runs.
  }, [store, unitId, modelId]);
  useEffect(() => {
    // After the grid has the new rows.
    const timer = setTimeout(() => followRef.current(), 0);
    return () => clearTimeout(timer);
  }, [rows.records]);

  // Selection: a cell range selects cells, row checkboxes select rows.
  const selectRef = useRef({ select, store, unitId, modelId });
  selectRef.current = { select, store, unitId, modelId };
  const releaseOwn = (kind: "cells" | "rows") => {
    const { store: current, unitId: own } = selectRef.current;
    const shown = current.getSnapshot().selection;
    if (shown?.unit_id === own && shown.kind === kind) selectRef.current.select(null);
  };
  const onCellSelection = (event: CellSelectionChangedEvent) => {
    if (!event.finished) return;
    const grid = event.api;
    const cells = rangeCells(
      grid.getCellRanges() ?? [],
      (index) => grid.getDisplayedRowAtIndex(index)?.data as VisibleRecord | undefined,
    );
    const { unitId: own, modelId: ownModel } = selectRef.current;
    if (cells.length === 0) releaseOwn("cells");
    else selectRef.current.select({ kind: "cells", unit_id: own, model_id: ownModel, cells });
  };
  const fieldIdsRef = useRef<ReadonlySet<string>>(new Set());
  fieldIdsRef.current = new Set(model?.fields.map((field) => String(field.id)));
  const onCellFocused = (event: CellFocusedEvent) => {
    const focused = focusedCell(
      event,
      fieldIdsRef.current,
      (index) => event.api.getDisplayedRowAtIndex(index)?.data as VisibleRecord | undefined,
    );
    if (focused === null) {
      releaseOwn("cells");
      return;
    }
    const { unitId: own, modelId: ownModel } = selectRef.current;
    selectRef.current.select({
      kind: "cells",
      unit_id: own,
      model_id: ownModel,
      cells: [focused],
    });
  };
  const onSelectionChanged = (event: SelectionChangedEvent) => {
    if (event.source === "rowDataChanged" || event.source === "api") return;
    const recordIds = event.api
      .getSelectedRows()
      .flatMap((row: unknown) =>
        row !== null && typeof row === "object" && "record_id" in row
          ? [(row as VisibleRecord).record_id]
          : [],
      );
    const { unitId: own, modelId: ownModel } = selectRef.current;
    if (recordIds.length === 0) releaseOwn("rows");
    else
      selectRef.current.select({
        kind: "rows",
        unit_id: own,
        model_id: ownModel,
        record_ids: recordIds,
      });
  };

  const loadMoreRef = useRef(rows.loadMore);
  loadMoreRef.current = rows.loadMore;
  // The next page starts at the rows shown; the kernel reads no further than its offset bound.
  const beyondOffset = rows.records.length > maxListOffset;
  const canLoadMore =
    rows.status === "ready" &&
    rows.total !== null &&
    rows.records.length < rows.total &&
    !beyondOffset;
  const canLoadMoreRef = useRef(canLoadMore);
  canLoadMoreRef.current = canLoadMore;
  const onGridReady: EditableRowVersionGridSurfaceProps["onGridReady"] = (event) => {
    api.current = event.api as unknown as GridApi;
    // Row checkboxes stay centred in taller (staged-with-note) rows.
    // A narrow, quiet column: its checkboxes show on hover or once rows are selected.
    event.api.setGridOption("selectionColumnDef", {
      cellStyle: { display: "flex", alignItems: "center" },
      width: 36,
      minWidth: 36,
      maxWidth: 36,
      resizable: false,
      suppressHeaderMenuButton: true,
    });
    if (agGridEnterpriseEnabled())
      event.api.addEventListener("cellSelectionChanged", onCellSelection);
    // Community has no cell ranges: the focused cell is the selection.
    else {
      event.api.addEventListener("cellFocused", onCellFocused);
      event.api.addEventListener("headerFocused", () => releaseOwn("cells"));
    }
    // Scrolling to the last rows reads the next page.
    event.api.addEventListener("bodyScrollEnd", () => {
      const last = event.api.getLastDisplayedRowIndex();
      if (canLoadMoreRef.current && last >= event.api.getDisplayedRowCount() - 3)
        void loadMoreRef.current();
    });
    surfaceProps.onGridReady(event);
    // Once the headers are laid out, size columns to their measured labels.
    requestAnimationFrame(() => {
      const measured = readHeaderMetrics(gridRoot.current);
      if (measured !== null)
        setHeaderMetrics((current) =>
          current?.font === measured.font && current.chrome === measured.chrome
            ? current
            : measured,
        );
    });
  };

  const filterText = useMemo(() => {
    if (filter === null || where.length === 0) return null;
    const field = labels.fieldById(model, filter.field_id);
    if (field === undefined) return null;
    const value =
      field.type === "enum" && typeof filter.value === "string"
        ? labels.optionLabel(field, filter.value)
        : field.type === "relation"
          ? (relations.optionsByModel[String(field.target_model)]?.find((option) =>
              [option.key, ...(option.aliasKeys ?? [])].some((key) => key.value === filter.value),
            )?.label ?? "one record")
          : typeof filter.value === "boolean"
            ? filter.value
              ? "Yes"
              : "No"
            : filter.value;
    return `${fieldHeader(field)}: ${value}`;
  }, [filter, where.length, labels, model, relations.optionsByModel]);

  if (model === undefined) return <Message>This model is not in the app.</Message>;
  const noun = modelLabel(model);
  return (
    <div
      className={cx(
        "flex h-full min-h-[var(--space-0)] flex-col",
        // Row checkboxes stay out of the way until the pointer is over the
        // table or a row is selected (a focused checkbox shows too).
        // Each row's open control shows the same way: on hover, focus or a focused cell.
        "[&_[data-open-record]]:opacity-0 [&_.ag-row-hover_[data-open-record]]:opacity-100 [&_.ag-cell-focus_[data-open-record]]:opacity-100 [&_[data-open-record]:focus-visible]:opacity-100",
        "[&_.ag-selection-checkbox]:opacity-0 [&_.ag-header-select-all]:opacity-0 hover:[&_.ag-selection-checkbox]:opacity-100 hover:[&_.ag-header-select-all]:opacity-100 [&_.ag-row-selected_.ag-selection-checkbox]:opacity-100 [&_.ag-selection-checkbox:focus-within]:opacity-100",
      )}
      data-grid-unit={unitId}
    >
      <div className="min-h-[var(--space-0)] flex-1" ref={gridRoot}>
        {rows.status === "error" && rows.records.length === 0 ? (
          <Message tone="danger">Could not load records: {rows.error}</Message>
        ) : rows.status === "ready" && rows.records.length === 0 ? (
          <Message>
            {where.length > 0 ? "No records match this filter." : `No ${noun} records yet.`}
          </Message>
        ) : (
          <EditableRowVersionGrid
            {...surfaceProps}
            columnDefs={columnDefs}
            getRowHeight={getRowHeight}
            onGridReady={onGridReady}
            rowSelection={{
              mode: "multiRow",
              checkboxes: true,
              headerCheckbox: true,
              enableClickSelection: false,
            }}
            onSelectionChanged={onSelectionChanged}
            onCellClicked={({ rowKey, fieldId }) => {
              // The open control is its own button; a cell click only selects or edits.
              if (fieldId === openColumnId) return;
              onCellClicked?.({ recordId: rowKey, fieldId });
            }}
          />
        )}
      </div>
      {rows.status === "error" && rows.records.length === 0 ? null : (
        <footer className="flex min-h-[var(--size-control-md)] flex-wrap items-center gap-x-[var(--space-3)] gap-y-[var(--space-1)] border-t border-[var(--color-border-subtle)] px-[var(--space-3)] py-[var(--space-1-5)] text-[length:var(--text-caption)] leading-[var(--leading-caption)] text-[var(--color-text-muted)]">
          <span role="status">
            {rows.status === "loading" && rows.records.length === 0
              ? "Loading…"
              : rows.total === null
                ? null
                : `${rows.records.length} of ${rows.total} ${noun} records`}
          </span>
          {rows.status === "error" && rows.records.length > 0 ? (
            <span className="text-[var(--color-status-danger)]">
              Could not refresh: {rows.error}
            </span>
          ) : null}
          {filterText === null ? null : (
            <span className="flex items-center gap-[var(--space-1)]">
              <span>Filtered by {filterText}</span>
              <Button intent="ghost" size="xs" onClick={clear}>
                Clear filter
              </Button>
            </span>
          )}
          {beyondOffset && rows.total !== null && rows.records.length < rows.total ? (
            <span className="ml-auto">Filter to see the rest</span>
          ) : null}
          {canLoadMore ? (
            <Button
              className="ml-auto"
              intent="secondary"
              size="xs"
              onClick={() => void rows.loadMore()}
            >
              Load {Math.min(pageSize, (rows.total ?? 0) - rows.records.length)} more
            </Button>
          ) : null}
        </footer>
      )}
    </div>
  );
}

function Message({ children, tone }: { children: ReactNode; tone?: "danger" }) {
  return (
    <p
      role={tone === "danger" ? "alert" : undefined}
      className={
        tone === "danger"
          ? "m-0 p-[var(--space-4)] text-[length:var(--text-body)] text-[var(--color-status-danger)]"
          : "m-0 p-[var(--space-4)] text-[length:var(--text-body)] text-[var(--color-text-muted)]"
      }
    >
      {children}
    </p>
  );
}

function sameOptions(a: RelationOptionsByModel, b: RelationOptionsByModel): boolean {
  const models = Object.keys(a);
  if (models.length !== Object.keys(b).length) return false;
  return models.every((id) => {
    const left = a[id] ?? [];
    const right = b[id];
    return (
      right !== undefined &&
      left.length === right.length &&
      left.every(
        (item, index) =>
          item.key.value === right[index]!.key.value &&
          item.label === right[index]!.label &&
          JSON.stringify(item.aliasKeys) === JSON.stringify(right[index]!.aliasKeys),
      )
    );
  });
}
