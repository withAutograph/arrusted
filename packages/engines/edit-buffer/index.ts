// Edit buffer engine.
//
// Backing store for the editable-grid surface (see
// `docs/frontend-architecture.md` for the canonical doc of editable-grid
// surfaces): pure-function, immutable buffer keyed by record/row. Cell-level
// reads are projections over each row's pending `values` map.
// `set` / `revert` / `revertRow` / `clear` return a NEW buffer instance so
// React renders see a stable identity per state version.
//
// `has(addr)` is the dirty-state probe; consumers MUST NOT use the value
// nullability of `getEdit(addr)` to test dirtiness, because explicit `false`,
// empty string, and other falsy `FieldValue`s are valid edits.
//
// No React imports; no DOM. Tested as pure functions in
// `packages/engines/edit-buffer/__tests__`.

import type {
  ApplyChangeSet,
  ApplyMode,
  AppId,
  ChangeTypeId,
  CustomerId,
  FieldId,
  FieldValue,
  ModelId,
  RecordKey,
  RecordId,
  RowVersionWrite,
  SchemaRevisionId,
} from "@contracts";

// `RowKey` is opaque to the engine. The composition keeps it as a string for
// React identity; the module bridges it to `RecordKey` when emitting writes.
export type RowKey = string;

export type CellAddress = { rowKey: RowKey; fieldId: FieldId };

// `EditSource` annotates who made the edit for client-side chrome. Persisted
// source_kind/source_ref lives in row-level EditMeta.
export type EditSource = "user" | "agent" | "import";

// `EditMeta` snapshots the write context (model + record key + effective_start)
// for the pending row. Submit reads these from the buffer row,
// not from the current visible map, so changing `asOf` after editing does not
// re-anchor a pending edit to the new effective date — and a row that has
// since dropped out of the visible set (e.g., asOf moved before its effective
// range) can still submit because the resolver is bypassed entirely.
//
// Existing rows carry `recordKey`. Callers that need a pre-addressable create
// carry `newRecordId`; the two subject forms are mutually exclusive. Other
// generic create flows may omit both and let the kernel mint the UUID.
//
// `bulkGroupId` is OPTIONAL: an externally-assigned label that ties this
// entry to a multi-row staging group (e.g. a bulk "Close 5 Q1 positions"
// flow). Apps stamp it on the meta at edit time; the editable-grid module
// surfaces it on `pendingChangesByRow` so the row-meta strip and bulk-filter
// chrome can read which entries belong to which group. The id is opaque to
// the engine — apps own the in-memory store that maps id → human label.
// Today the kernel's apply path ignores it (groups live client-side until
// the bulk-action ticket lands a server-side concept).
//
// `changeTypeId` is OPTIONAL: an explicit change_type id that overrides the
// hook's `inferChangeType(touched)` heuristic for this pending row. The
// bulk-action sidebar passes the change_type the user PICKED from the
// dropdown so the row-meta strip + audit log narrate the action by the
// user's chosen verb (e.g. "Reorganization") rather than whatever the
// inference's touch-set rule resolves to (e.g. "Transfer department" when
// only 2 of the 4 touched fields were filled). Kernel ignores it on each
// write — apply-level `change_type_id` is set separately per save partition.
//
// `sourceKind` / `sourceRef` are row-level, last-touched provenance. They
// intentionally live beside the pending row's values instead of on cells:
// reverting a field only removes it from `values`; setting any field overwrites
// the row provenance.
export type EditMeta = {
  modelId: ModelId;
  recordKey?: RecordKey;
  newRecordId?: RecordId;
  effectiveStart: string;
  bulkGroupId?: string;
  changeTypeId?: ChangeTypeId;
  sourceKind?: string;
  sourceRef?: string | null;
};

// A pending cell value. `null` is an explicit clear: the field is removed from
// the record's next snapshot (`clear_fields` / `clear_custom_fields` on the
// write), which is distinct from leaving the field out of the edit, where it
// inherits its prior value.
export type PendingFieldValue = FieldValue | null;

export type EditEntry = {
  addr: CellAddress;
  value: PendingFieldValue;
  source: EditSource;
  meta?: EditMeta;
};

// `RowEditPayload` is the intermediate shape `toApplyChangeSet` works against
// before producing kernel `RowVersionWrite[]`. The module supplies the
// row→record-key resolver (rows are opaque strings here). The resolver is
// only consulted for entries that have NO `meta` snapshot; entries with meta
// use the snapshot directly.
export type RowResolver = (rowKey: RowKey) => {
  modelId: ModelId;
  recordKey: RecordKey;
  // Same effective_start the surface is editing at; the kernel needs one per
  // write. Composition's `asOf` flows through the module.
  effectiveStart: string;
};

export type ApplyChangeSetOpts = {
  scope: { appId: AppId; customerId: CustomerId };
  mode: ApplyMode;
  sourceKind: string;
  // Optional because production callers (`useApplyMutation`) stamp the real
  // key after they decide whether the attempt is a true retry. Engines and
  // tests can supply a key directly. Null/undefined leaves the wire field
  // blank for the caller to fill.
  idempotencyKey?: string | null;
  resolveRow: RowResolver;
  // Pinned schema revision; optional because the kernel resolves the active
  // revision when omitted (per docs/contracts.md "Apply API" rules).
  schemaRevisionId?: SchemaRevisionId | null;
  actorId?: string | null;
  changeTypeId?: ChangeTypeId | null;
  notes?: string | null;
  sourceRef?: string | null;
};

type PendingWriteRecord = {
  rowKey: RowKey;
  values: Record<FieldId, PendingFieldValue>;
  source: EditSource;
  meta?: EditMeta;
};

function structuralEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((value, index) => structuralEqual(value, b[index]));
  }

  if (typeof a === "object" && typeof b === "object") {
    if (!isPlainObject(a) || !isPlainObject(b)) return false;
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    if (aKeys.length !== bKeys.length) return false;
    if (!aKeys.every((key, index) => key === bKeys[index])) return false;
    return aKeys.every((key) => structuralEqual(a[key], b[key]));
  }

  return false;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export type EditBuffer = {
  readonly cellCount: number;
  readonly rowCount: number;
  has(addr: CellAddress): boolean;
  // `undefined` means the cell has no pending edit; `null` is a pending clear.
  getEdit(addr: CellAddress): PendingFieldValue | undefined;
  getSource(addr: CellAddress): EditSource | undefined;
  // Returns row-level pending metadata for this cell projection, if the caller
  // passed one to `set`. Submit uses this to anchor the kernel write and save
  // provenance. Returns undefined when the row was set without meta.
  getMeta(addr: CellAddress): EditMeta | undefined;
  set(
    addr: CellAddress,
    value: PendingFieldValue,
    source?: EditSource,
    meta?: EditMeta,
  ): EditBuffer;
  // Merge `partial` into the row's existing meta, returning a NEW immutable
  // buffer. Values and source are unchanged. Use this when the row's edit
  // context (effectiveStart, changeTypeId, bulkGroupId) needs to mutate
  // without re-issuing the cell value — the row-meta strip's per-row
  // change_type / effective-date pickers are the load-bearing consumer.
  //
  // Behavior:
  //   - Address NOT in buffer → no-op; returns the SAME buffer instance so
  //     consumers' identity-based memo deps don't churn on misses.
  //   - Address present but had NO meta → THROWS. `updateMeta` is for
  //     patching an existing snapshot, not minting one; merging a partial
  //     onto nothing and casting to `EditMeta` would let an invalid meta
  //     (missing required `modelId`/`effectiveStart`) reach the kernel
  //     on the next apply. Callers must commit a full meta via `set`
  //     first. Today's callers (`setRowEffectiveDate` /
  //     `setRowChangeType` in the editable-grid module) only mutate
  //     entries that already carry meta; entries set via
  //     `stageNewRecord` / `stageBulkUpdate` / cell setters all carry
  //     full meta from inception.
  //   - Address present WITH meta → shallow-merge `partial` over the
  //     existing meta. `partial`'s explicit `undefined` values do NOT
  //     erase existing keys (we use `??`-style spread, not destructive
  //     assignment); callers wanting to clear a field must pass an empty
  //     object and write a follow-up `set` with a fresh meta if true
  //     erasure is needed.
  //   - Merged meta structurally equals the live meta (e.g. user clicks
  //     the same date in the date-picker pill, or `partial` was empty)
  //     → no-op; returns the SAME buffer instance. Same rationale as
  //     the absent-address branch: consumers' `pendingChangesByRow`
  //     memo + downstream AG Grid recomputes don't churn on a no-op
  //     re-pick.
  updateMeta(addr: CellAddress, partial: Partial<EditMeta>): EditBuffer;
  revert(addr: CellAddress): EditBuffer;
  revertRow(rowKey: RowKey): EditBuffer;
  // Value-aware revert against a snapshot. For each entry in `snapshot`,
  // revert the address ONLY if the live entry at that address still matches
  // the snapshot (same value, source, and meta). Mid-flight edits — entries
  // the user added after the snapshot was taken, OR re-edits to a snapshot
  // address whose value has since changed — are preserved. The post-apply
  // success path uses this to clear submitted entries without destroying
  // user work added during the in-flight apply.
  revertMatching(snapshot: ReadonlyArray<EditEntry>): EditBuffer;
  clear(): EditBuffer;
  rowKeys(): RowKey[];
  // Returns every buffer entry in INSERTION-ORDER. Consumers in
  // `@modules/editable-grid` rely on this to keep deterministic UI/save order.
  // The contract is upheld by the engine's native `Map` store; swapping
  // the store implementation away from `Map` regresses all three rules.
  // See `docs/known-footguns.md` "Map iteration-order contract".
  entries(): EditEntry[];
  // Returns the prior value for an address, given an accessor over the
  // currently-visible row data. The accessor is supplied by the caller so the
  // engine stays React/data-source agnostic.
  priorValue(
    addr: CellAddress,
    accessor: (rowKey: RowKey, fieldId: FieldId) => FieldValue | undefined,
  ): FieldValue | undefined;
  // Build the kernel payload. One pending row becomes one write with all edited
  // fields collapsed into one `values` map. Throws if the resolver cannot
  // resolve a referenced row.
  toApplyChangeSet(opts: ApplyChangeSetOpts): ApplyChangeSet;
};

export function createEditBuffer(): EditBuffer {
  return wrap(new Map());
}

function wrap(store: ReadonlyMap<RowKey, PendingWriteRecord>): EditBuffer {
  let cachedCellCount: number | null = null;
  function deriveCellCount(): number {
    if (cachedCellCount != null) return cachedCellCount;
    let count = 0;
    for (const record of store.values()) {
      count += Object.keys(record.values).length;
    }
    cachedCellCount = count;
    return count;
  }

  function entryFor(
    addr: CellAddress,
  ): { record: PendingWriteRecord; value: PendingFieldValue } | undefined {
    const record = store.get(addr.rowKey);
    if (!record || !Object.prototype.hasOwnProperty.call(record.values, addr.fieldId)) {
      return undefined;
    }
    return { record, value: record.values[addr.fieldId]! };
  }

  // `self` is the buffer instance returned to consumers. Methods that
  // are no-ops return `self` (instead of a freshly-wrapped clone) so
  // identity-based memo deps don't churn when the user e.g. tries to
  // revert an already-clean cell or update meta on an unknown address.
  // Hoisted via `let` because the object literal below references `self`
  // inside its method closures; the assignment lands before any consumer
  // can call a method.
  let self!: EditBuffer;
  self = {
    get cellCount() {
      return deriveCellCount();
    },
    get rowCount() {
      return store.size;
    },
    has(addr) {
      return entryFor(addr) !== undefined;
    },
    getEdit(addr) {
      return entryFor(addr)?.value;
    },
    getSource(addr) {
      return entryFor(addr)?.record.source;
    },
    getMeta(addr) {
      return entryFor(addr)?.record.meta;
    },
    set(addr, value, source = "user", meta) {
      const next = new Map(store);
      const existing = next.get(addr.rowKey);
      const record: PendingWriteRecord = {
        rowKey: addr.rowKey,
        values: {
          ...(existing?.values ?? {}),
          [addr.fieldId]: value,
        },
        source,
        meta: meta ?? existing?.meta,
      };
      next.set(addr.rowKey, record);
      return wrap(next);
    },
    updateMeta(addr, partial) {
      const live = store.get(addr.rowKey);
      // Address absent: per the contract above, return the same buffer
      // instance so consumers' identity-based memo deps don't churn.
      if (!live) return self;
      // Entry exists but carries no meta yet: refuse the update. Merging
      // a partial onto nothing and casting `as EditMeta` would let an
      // invalid meta (missing required `modelId` / `effectiveStart`)
      // slip through to the kernel on the next apply. Callers must
      // commit a full meta via `set(addr, value, source, meta)` first;
      // `updateMeta` is for PATCHING an existing snapshot, not minting
      // one. Throw dev-loud so the bad call site surfaces immediately
      // instead of corrupting the wire payload silently.
      if (!live.meta) {
        throw new Error(
          `editBuffer.updateMeta: entry at ${addr.rowKey}/${addr.fieldId} has no meta yet; ` +
            `call set(addr, value, source, meta) with a full EditMeta first ` +
            `before patching via updateMeta.`,
        );
      }
      // Build the merged meta. Spread the partial AFTER the existing meta
      // so `partial`'s defined keys win; `undefined` values in the
      // partial do not erase existing keys because spread copies them
      // verbatim (and `getMeta`/wire serialization filter undefined).
      const definedPartial: Partial<EditMeta> = {};
      for (const [k, v] of Object.entries(partial)) {
        if (v !== undefined) (definedPartial as Record<string, unknown>)[k] = v;
      }
      const mergedMeta: EditMeta = { ...live.meta, ...definedPartial };
      // No-op short-circuit: when the merged meta is structurally equal
      // to the live meta (e.g. user clicks the same date in the date-
      // picker pill, or `partial` was empty {}), return the SAME buffer
      // instance so consumers' identity-based memo deps don't churn.
      // Mirrors the empty-partial / unchanged-merge case other ops
      // (revert / revertRow / clear) already handle by returning `self`.
      if (structuralEqual(mergedMeta, live.meta)) return self;
      const nextStore = new Map(store);
      const nextRecord: PendingWriteRecord = {
        rowKey: live.rowKey,
        values: live.values,
        source: live.source,
        meta: mergedMeta,
      };
      nextStore.set(addr.rowKey, nextRecord);
      return wrap(nextStore);
    },
    revert(addr) {
      const live = store.get(addr.rowKey);
      if (!live || !Object.prototype.hasOwnProperty.call(live.values, addr.fieldId)) return self;
      const nextValues = { ...live.values };
      delete nextValues[addr.fieldId];
      const next = new Map(store);
      if (Object.keys(nextValues).length === 0) {
        next.delete(addr.rowKey);
      } else {
        next.set(addr.rowKey, { ...live, values: nextValues });
      }
      return wrap(next);
    },
    revertRow(rowKey) {
      if (!store.has(rowKey)) return self;
      const next = new Map(store);
      next.delete(rowKey);
      return wrap(next);
    },
    revertMatching(snapshot) {
      // FieldValue / EditMeta are pure-data structures. Use structural
      // equality instead of JSON.stringify so json FieldValues with equivalent
      // object content but different key insertion order still match.
      const next = new Map(store);
      let changed = false;
      for (const snap of snapshot) {
        const { rowKey, fieldId } = snap.addr;
        const live = next.get(rowKey);
        if (!live || !Object.prototype.hasOwnProperty.call(live.values, fieldId)) continue;
        if (!structuralEqual(live.values[fieldId], snap.value)) continue;
        if (!structuralEqual(live.meta, snap.meta)) continue;
        const nextValues = { ...live.values };
        delete nextValues[fieldId];
        if (Object.keys(nextValues).length === 0) {
          next.delete(rowKey);
        } else {
          next.set(rowKey, { ...live, values: nextValues });
        }
        changed = true;
      }
      return changed ? wrap(next) : self;
    },
    clear() {
      if (store.size === 0) return self;
      return wrap(new Map());
    },
    rowKeys() {
      return [...store.keys()];
    },
    entries() {
      const out: EditEntry[] = [];
      for (const record of store.values()) {
        for (const [fieldId, value] of Object.entries(record.values)) {
          const entry: EditEntry = {
            addr: { rowKey: record.rowKey, fieldId },
            value,
            source: record.source,
          };
          if (record.meta) entry.meta = record.meta;
          out.push(entry);
        }
      }
      return out;
    },
    priorValue(addr, accessor) {
      return accessor(addr.rowKey, addr.fieldId);
    },
    toApplyChangeSet(opts) {
      const writes = buildWrites(store, opts.resolveRow);
      const apply: ApplyChangeSet = {
        app_id: opts.scope.appId,
        customer_id: opts.scope.customerId,
        source_kind: opts.sourceKind,
        idempotency_key: opts.idempotencyKey ?? null,
        mode: opts.mode,
        writes,
      };
      if (opts.schemaRevisionId != null) apply.schema_revision_id = opts.schemaRevisionId;
      if (opts.actorId != null) apply.actor_id = opts.actorId;
      if (opts.changeTypeId != null) apply.change_type_id = opts.changeTypeId;
      if (opts.notes != null) apply.notes = opts.notes;
      if (opts.sourceRef != null) apply.source_ref = opts.sourceRef;
      return apply;
    },
  };
  return self;
}

function buildWrites(
  store: ReadonlyMap<RowKey, PendingWriteRecord>,
  resolve: RowResolver,
): RowVersionWrite[] {
  // One pending record produces one RowVersionWrite. The editable-grid module
  // owns the invariant that a record cannot carry multiple pending effective
  // dates inside one change set.
  //
  // New-record staging: when meta carries no `recordKey`, the rowKey is a
  // client-side temp handle (e.g. `tmp:${uuid}`) that exists ONLY for grouping
  // here and as `record_id` for the AG Grid render. The resolver MUST NOT
  // fire for these entries — the resolver assumes the row is already in the
  // visible map, which a draft is not. The meta-present branch handles them
  // entirely; a supplied newRecordId forwards the permanent create UUID,
  // while absence of both subject forms lets the kernel mint one.
  const writes: RowVersionWrite[] = [];
  for (const record of store.values()) {
    // Resolve target context: meta is fully self-sufficient (the snapshot was
    // taken at edit time and carries modelId/recordKey/effectiveStart), so the
    // resolver is only used for non-meta callers (pre-meta/direct mode/stories
    // not threading meta). Skipping the resolver call when meta is present is
    // load-bearing: a row that has since dropped out of the visible set
    // (e.g., asOf moved before its effective_start) would make the resolver
    // throw, defeating the whole point of capturing a snapshot.
    let modelId: ModelId;
    let recordKey: RecordKey | undefined;
    let newRecordId: RecordId | undefined;
    let effectiveStart: string;
    if (record.meta) {
      modelId = record.meta.modelId;
      recordKey = record.meta.recordKey;
      newRecordId = record.meta.newRecordId;
      effectiveStart = record.meta.effectiveStart;
    } else {
      const resolved = resolve(record.rowKey);
      modelId = resolved.modelId;
      recordKey = resolved.recordKey;
      newRecordId = undefined;
      effectiveStart = resolved.effectiveStart;
    }
    if (recordKey && newRecordId) {
      throw new Error(`Row "${record.rowKey}" cannot have both recordKey and newRecordId.`);
    }
    const pending = splitPendingValues(record.values);
    const write: RowVersionWrite = {
      model_id: modelId,
      effective_start: effectiveStart,
      values: pending.values,
      provenance: { surface: "editable-grid" },
    };
    if (pending.clearFields.length > 0) write.clear_fields = pending.clearFields;
    // Omit `record_key` entirely (don't emit `null`) when staging a new
    // record: the kernel's `resolve_or_create_subject_record` branches on
    // `Some` vs `None` to decide create-vs-update.
    if (recordKey) write.record_key = recordKey;
    if (newRecordId) write.new_record_id = newRecordId;
    writes.push(write);
  }
  return writes;
}

// Split a pending row's values into set values and explicit clears. Declared
// and custom ids are not distinguished here; callers that project custom
// fields into `values` route their ids to `custom_fields` and
// `clear_custom_fields` (see `splitCustomFieldsFromWrites`).
export function splitPendingValues(values: Readonly<Record<FieldId, PendingFieldValue>>): {
  values: Record<FieldId, FieldValue>;
  clearFields: FieldId[];
} {
  const set: Record<FieldId, FieldValue> = {};
  const clearFields: FieldId[] = [];
  for (const [fieldId, value] of Object.entries(values)) {
    if (value === null) clearFields.push(fieldId);
    else set[fieldId] = value;
  }
  return { values: set, clearFields };
}
