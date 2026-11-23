import { createEditBuffer, type CellAddress, type EditMeta, type RowResolver } from "../index";
import type { FieldValue, ModelId, RecordId, RecordKey } from "../../../contracts/index";

import nodeAssert from "node:assert/strict";
import { describe, it } from "vite-plus/test";

function assert(condition: unknown, message: string): asserts condition {
  nodeAssert(condition, message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  nodeAssert.equal(actual, expected, message);
}

function testEditBufferEngine() {
  const a: CellAddress = { rowKey: "row-1", fieldId: "name" };
  const b: CellAddress = { rowKey: "row-1", fieldId: "active" };
  const c: CellAddress = { rowKey: "row-2", fieldId: "name" };

  const empty = createEditBuffer();
  assertEqual(empty.cellCount, 0, "empty.cellCount is 0");
  assertEqual(empty.rowCount, 0, "empty.rowCount is 0");
  assertEqual(empty.has(a), false, "empty.has(addr) is false");

  const v1: FieldValue = { type: "text", value: "Alpha" };
  const one = empty.set(a, v1);
  assert(one !== empty, "set returns a new buffer instance");
  assertEqual(one.cellCount, 1, "set adds one cell");
  assertEqual(one.has(a), true, "set marks dirty");
  assertEqual((one.getEdit(a) as { value: string }).value, "Alpha", "getEdit returns the value");

  // Falsy edit: explicit false must register as dirty (not value nullability)
  const vFalse: FieldValue = { type: "bool", value: false };
  const withBool = one.set(b, vFalse);
  assertEqual(withBool.has(b), true, "explicit false bool is dirty");
  assertEqual((withBool.getEdit(b) as { value: boolean }).value, false, "getEdit returns false");

  // revert removes one cell
  const reverted = withBool.revert(b);
  assertEqual(reverted.has(b), false, "revert clears the cell");
  assertEqual(reverted.cellCount, 1, "revert leaves the other cell");

  // revertRow removes everything for a row
  const multi = withBool.set(c, v1);
  assertEqual(multi.cellCount, 3, "multi-cell setup");
  assertEqual(multi.rowCount, 2, "rowCount counts unique rows");
  const rowReverted = multi.revertRow("row-1");
  assertEqual(rowReverted.cellCount, 1, "revertRow clears all row-1 edits");
  assertEqual(rowReverted.has(c), true, "revertRow leaves row-2 edit");

  // clear empties everything
  const cleared = multi.clear();
  assertEqual(cleared.cellCount, 0, "clear empties");
  assertEqual(cleared.rowCount, 0, "clear empties rows");

  // immutability: original bufs unchanged after derived ops
  assertEqual(empty.cellCount, 0, "empty unchanged after set");
  assertEqual(one.cellCount, 1, "one unchanged after subsequent ops");
  assertEqual(withBool.cellCount, 2, "withBool unchanged after revert");

  // priorValue uses the supplied accessor
  const accessor = (rowKey: string, fieldId: string): FieldValue | undefined =>
    rowKey === "row-1" && fieldId === "name" ? { type: "text", value: "PRIOR" } : undefined;
  const prior = one.priorValue(a, accessor);
  assert(prior?.type === "text" && prior.value === "PRIOR", "priorValue delegates to accessor");

  // Idempotent set with same value still produces a new buffer (engine does
  // not deduplicate set; React identity discipline is at the consumer layer).
  const reset = one.set(a, v1);
  assert(reset !== one, "set always returns a new buffer");
  assertEqual(reset.cellCount, 1, "set replacement does not double-count");

  // entries() iteration is exhaustive and source-tagged
  const entries = withBool.entries();
  assertEqual(entries.length, 2, "entries length");
  assert(
    entries.every((e) => e.source === "user"),
    "default source is user",
  );

  // toApplyChangeSet round-trip: per-row collapse + provenance + idempotency
  const recordKey: RecordKey = { type: "external_key", value: "alpha" };
  const recordKey2: RecordKey = { type: "external_key", value: "beta" };
  const resolver: RowResolver = (rowKey) => {
    if (rowKey === "row-1") {
      return { modelId: "model_a", recordKey, effectiveStart: "2026-07-01" };
    }
    return { modelId: "model_a", recordKey: recordKey2, effectiveStart: "2026-07-01" };
  };
  const apply = multi.toApplyChangeSet({
    scope: { appId: "app", customerId: "cust" },
    mode: "mainline",
    sourceKind: "test",
    idempotencyKey: "IDEM-1",
    resolveRow: resolver,
    actorId: "tester",
  });
  assertEqual(apply.app_id, "app", "apply app_id");
  assertEqual(apply.customer_id, "cust", "apply customer_id");
  assertEqual(apply.idempotency_key, "IDEM-1", "apply idempotency_key");
  assertEqual(apply.mode, "mainline", "apply mode");
  assertEqual(apply.actor_id, "tester", "apply actor_id");
  assertEqual(apply.writes.length, 2, "two rows produce two writes");
  const row1 = apply.writes.find((w) => w.record_key?.value === "alpha");
  assert(row1 !== undefined, "row-1 write present");
  if (row1) {
    assertEqual(Object.keys(row1.values ?? {}).length, 2, "row-1 has both fields collapsed");
    assert("name" in (row1.values ?? {}), "row-1 has name field");
    assert("active" in (row1.values ?? {}), "row-1 has active field");
    assertEqual(row1.effective_start, "2026-07-01", "effective_start carried");
    delete row1.values?.name;
    assertEqual(multi.has(a), true, "toApplyChangeSet: returned values do not alias buffer state");
  }

  // Empty buffer produces zero writes (caller must guard against empty submit)
  const emptyApply = empty.toApplyChangeSet({
    scope: { appId: "app", customerId: "cust" },
    mode: "draft",
    sourceKind: "test",
    idempotencyKey: "IDEM-EMPTY",
    resolveRow: resolver,
  });
  assertEqual(emptyApply.writes.length, 0, "empty buffer produces zero writes");
  assertEqual(emptyApply.mode, "draft", "draft mode passes through");

  const proposedRecordId = "018f6bf3-1ea5-7812-9a5a-a1f5b04f0100" as RecordId;
  const preaddressedCreate = empty.set(a, v1, "import", {
    modelId: "model_a" as ModelId,
    newRecordId: proposedRecordId,
    effectiveStart: "2026-07-01",
  });
  const preaddressedApply = preaddressedCreate.toApplyChangeSet({
    scope: { appId: "app", customerId: "cust" },
    mode: "mainline",
    sourceKind: "data_import",
    resolveRow: resolver,
  });
  assertEqual(
    preaddressedApply.writes[0]?.new_record_id,
    proposedRecordId,
    "pre-addressed create forwards new_record_id",
  );
  assert(
    preaddressedApply.writes[0]?.record_key === undefined,
    "pre-addressed create omits record_key",
  );

  // Source tagging propagates through entries()
  const agentBuf = empty.set(a, v1, "agent");
  assertEqual(agentBuf.getSource(a), "agent", "agent source recorded");
  assertEqual(agentBuf.entries()[0]?.source, "agent", "entries surface source");

  // ----- meta snapshot tests -----
  // Without meta: writes use the resolver's (recordKey, effectiveStart) — the
  // old behavior other callers still rely on.
  const noMetaBuf = empty.set(a, v1);
  const noMetaApply = noMetaBuf.toApplyChangeSet({
    scope: { appId: "app", customerId: "cust" },
    mode: "mainline",
    sourceKind: "test",
    idempotencyKey: null,
    resolveRow: resolver,
  });
  assertEqual(noMetaApply.writes.length, 1, "no-meta produces one write");
  assertEqual(
    noMetaApply.writes[0]?.effective_start,
    "2026-07-01",
    "no-meta uses resolver effective_start",
  );

  // With meta: writes anchor to the meta's effective_start, NOT the
  // resolver's current value. Simulates: edit at asOf=X, then asOf changes.
  const metaA = {
    modelId: "model_a" as ModelId,
    recordKey: { type: "external_key", value: "alpha" } as RecordKey,
    effectiveStart: "2026-04-01",
  };
  const metaBuf = empty.set(a, v1, "user", metaA);
  // Resolver still reports a different (post-asOf-change) effective_start.
  const driftedResolver: RowResolver = (rowKey) => {
    if (rowKey === "row-1") {
      return { modelId: "model_a", recordKey, effectiveStart: "2026-09-15" };
    }
    return { modelId: "model_a", recordKey: recordKey2, effectiveStart: "2026-09-15" };
  };
  const metaApply = metaBuf.toApplyChangeSet({
    scope: { appId: "app", customerId: "cust" },
    mode: "mainline",
    sourceKind: "test",
    idempotencyKey: null,
    resolveRow: driftedResolver,
  });
  assertEqual(metaApply.writes.length, 1, "meta write count");
  assertEqual(
    metaApply.writes[0]?.effective_start,
    "2026-04-01",
    "meta anchors to edit-time effective_start, not current resolver value",
  );

  // getMeta surfaces the snapshot back to consumers.
  const meta = metaBuf.getMeta(a);
  assert(meta !== undefined, "getMeta returns snapshot");
  if (meta) {
    assertEqual(meta.effectiveStart, "2026-04-01", "getMeta effectiveStart");
  }

  // Mixed: same row, two edits at different effective_starts → one pending
  // row write. The editable-grid module owns the stronger caller invariant
  // that follow-up edits preserve the row's first staged effective_start; the
  // engine itself stays a simple row-level buffer and uses the row's live meta.
  const metaB = {
    modelId: "model_a" as ModelId,
    recordKey: { type: "external_key", value: "alpha" } as RecordKey,
    effectiveStart: "2026-06-01",
  };
  const splitBuf = empty.set(a, v1, "user", metaA).set(b, vFalse, "user", metaB);
  const splitApply = splitBuf.toApplyChangeSet({
    scope: { appId: "app", customerId: "cust" },
    mode: "mainline",
    sourceKind: "test",
    idempotencyKey: null,
    resolveRow: driftedResolver,
  });
  assertEqual(splitApply.writes.length, 1, "one pending row produces one write");
  assertEqual(splitApply.writes[0]?.effective_start, "2026-06-01", "row write uses live row meta");
  assert(
    splitApply.writes[0] && "name" in (splitApply.writes[0].values ?? {}),
    "row write carries name field",
  );
  assert(
    splitApply.writes[0] && "active" in (splitApply.writes[0].values ?? {}),
    "row write carries active field",
  );

  // Meta-anchored row that has dropped out of the resolver's visible set
  // (e.g., asOf moved past the record's effective_end) must STILL submit —
  // the meta is self-sufficient and the resolver should never be called for
  // it. A throwing resolver proves the engine bypasses it entirely.
  const throwingResolver: RowResolver = () => {
    throw new Error("resolver should not be called for meta-anchored rows");
  };
  const orphanedMetaApply = metaBuf.toApplyChangeSet({
    scope: { appId: "app", customerId: "cust" },
    mode: "mainline",
    sourceKind: "test",
    idempotencyKey: null,
    resolveRow: throwingResolver,
  });
  assertEqual(
    orphanedMetaApply.writes.length,
    1,
    "meta-anchored row submits even when resolver would throw",
  );
  assertEqual(
    orphanedMetaApply.writes[0]?.model_id,
    "model_a",
    "meta carries modelId; no resolver round-trip needed",
  );

  // ----- Bug-shape lock-in: meta MUST carry the edit-time asOf, not the
  // existing record's effective_start. -----
  //
  // Real-world scenario the live-kernel E2E exposed: a record exists at
  // effective_start=2026-01-01 (long-lived row); the user opens the grid at
  // asOf=2026-09-15 (the normal case for a long-lived record); they edit a
  // cell. The module's `handleEditCommit` must capture
  // `meta.effectiveStart = asOf` (2026-09-15), NOT
  // `meta.effectiveStart = record.effective_start` (2026-01-01). The latter
  // is what the prior buggy build did, and it tripped the kernel's
  // `timeline_conflict` rule on every mainline edit because the
  // (record_id, effective_start)=(rec, 2026-01-01) mainline version
  // already exists.
  //
  // This test locks in the contract at the engine layer: a buffer entry
  // whose meta carries the edit-time asOf produces a write at THAT date,
  // even when the resolver still reports the record's original date.
  const editTimeAsOf = "2026-09-15";
  const recordOriginalDate = "2026-01-01";
  const editAtAsOfMeta = {
    modelId: "model_a" as ModelId,
    recordKey: { type: "record_id", value: "rec-001" } as RecordKey,
    effectiveStart: editTimeAsOf,
  };
  const editAtAsOfBuf = empty.set(a, v1, "user", editAtAsOfMeta);
  // Resolver mirrors the (buggy) "use record's existing effective_start"
  // behavior — proving the meta capture is what saves us.
  const recordDateResolver: RowResolver = () => ({
    modelId: "model_a",
    recordKey: { type: "record_id", value: "rec-001" } as RecordKey,
    effectiveStart: recordOriginalDate,
  });
  const editAtAsOfApply = editAtAsOfBuf.toApplyChangeSet({
    scope: { appId: "app", customerId: "cust" },
    mode: "mainline",
    sourceKind: "test",
    idempotencyKey: null,
    resolveRow: recordDateResolver,
  });
  assertEqual(
    editAtAsOfApply.writes[0]?.effective_start,
    editTimeAsOf,
    "meta captures EDIT-TIME asOf, not the existing record's effective_start (timeline_conflict guard)",
  );
  assert(
    editAtAsOfApply.writes[0]?.effective_start !== recordOriginalDate,
    "meta MUST NOT replay the record's original effective_start (would trip timeline_conflict)",
  );

  // idempotencyKey is now optional and surfaces as null on the wire when
  // omitted (callers like useApplyMutation stamp the real key later).
  const noKeyApply = noMetaBuf.toApplyChangeSet({
    scope: { appId: "app", customerId: "cust" },
    mode: "mainline",
    sourceKind: "test",
    resolveRow: resolver,
  });
  assertEqual(noKeyApply.idempotency_key, null, "omitted idempotencyKey serializes as null");

  // Mid-flight edits survive submit success: the module reverts only the
  // submitted addresses, not the whole buffer. Engine-level surface: a
  // snapshot of submitted addresses, then revert(addr) per snapshot, leaves
  // any cell edited after the snapshot intact in `entries()`.
  const submitted = empty.set(a, v1);
  const submittedAddrs = submitted.entries().map((entry) => entry.addr);
  // Cell B edited DURING the in-flight apply (after the snapshot was taken).
  const midFlight = submitted.set(b, vFalse);
  let postSubmit = midFlight;
  for (const addr of submittedAddrs) {
    postSubmit = postSubmit.revert(addr);
  }
  assertEqual(postSubmit.cellCount, 1, "mid-flight edit survives submit success");
  assertEqual(postSubmit.has(a), false, "submitted cell A reverted");
  assertEqual(postSubmit.has(b), true, "mid-flight cell B retained");
  assertEqual(
    (postSubmit.getEdit(b) as { value: boolean }).value,
    false,
    "mid-flight cell B retains its edited value",
  );

  // ----- H1: SAME-cell mid-flight survives submit success. -----
  // Module's submit-success path uses value-aware revert: the snapshotted
  // entry is compared against the live buffer entry at the same address. If
  // the user re-edited the same cell during the apply, the live entry's
  // value differs from the snapshot and we MUST NOT revert. Re-running the
  // module's equality check against engine surface proves the pattern.
  function bufferEntryStillMatches(
    live: ReturnType<typeof createEditBuffer>,
    snapshot: { addr: CellAddress; value: FieldValue | null; source: string; meta?: unknown },
  ): boolean {
    if (!live.has(snapshot.addr)) return false;
    const liveValue = live.getEdit(snapshot.addr);
    if (JSON.stringify(liveValue) !== JSON.stringify(snapshot.value)) return false;
    if (live.getSource(snapshot.addr) !== snapshot.source) return false;
    return JSON.stringify(live.getMeta(snapshot.addr)) === JSON.stringify(snapshot.meta);
  }

  const sameCellInitial = empty.set(a, v1, "user");
  const sameCellSnapshot = sameCellInitial.entries();
  // User re-edits the SAME cell with a different value while apply is in
  // flight. The live buffer now holds the new value at addr A.
  const v1Reedited: FieldValue = { type: "text", value: "Beta" };
  const sameCellReedited = sameCellInitial.set(a, v1Reedited, "user");
  // Apply value-aware revert: snapshot does NOT match live; cell A retained.
  let sameCellPostSubmit = sameCellReedited;
  for (const snap of sameCellSnapshot) {
    if (bufferEntryStillMatches(sameCellPostSubmit, snap)) {
      sameCellPostSubmit = sameCellPostSubmit.revert(snap.addr);
    }
  }
  assertEqual(
    sameCellPostSubmit.cellCount,
    1,
    "same-cell mid-flight: re-edited cell retained after submit success",
  );
  assertEqual(
    (sameCellPostSubmit.getEdit(a) as { value: string }).value,
    "Beta",
    "same-cell mid-flight: re-edited value preserved",
  );

  // Sanity: when the live entry DOES match the snapshot (no mid-flight
  // re-edit), value-aware revert removes it like the original code path.
  const noReedit = empty.set(a, v1, "user");
  const noReeditSnapshot = noReedit.entries();
  let noReeditPostSubmit = noReedit;
  for (const snap of noReeditSnapshot) {
    if (bufferEntryStillMatches(noReeditPostSubmit, snap)) {
      noReeditPostSubmit = noReeditPostSubmit.revert(snap.addr);
    }
  }
  assertEqual(
    noReeditPostSubmit.cellCount,
    0,
    "same-cell mid-flight: matching entry still revertable",
  );

  // ----- engine.revertMatching(snapshot): same value-aware contract, but
  // owned by the engine rather than re-implemented by every caller. The
  // probe above (lines ~891-967) exercised the pattern via
  // bufferEntryStillMatches + per-entry revert; this section asserts the
  // engine method gives identical semantics so callers can drop the
  // ad-hoc helper.
  const buf0 = empty.set(a, v1, "user");
  const snap0 = buf0.entries();
  const buf0Reverted = buf0.revertMatching(snap0);
  assertEqual(buf0Reverted.cellCount, 0, "revertMatching: matching entry removed");

  // Mid-flight ADD survives.
  const buf1 = empty.set(a, v1, "user");
  const snap1 = buf1.entries();
  const buf1Mid = buf1.set(b, vFalse, "user");
  const buf1After = buf1Mid.revertMatching(snap1);
  assertEqual(buf1After.cellCount, 1, "revertMatching: mid-flight add survives");
  assertEqual(buf1After.has(a), false, "revertMatching: snapshotted addr A reverted");
  assertEqual(buf1After.has(b), true, "revertMatching: mid-flight addr B retained");

  // Same-cell re-edit survives (live value differs from snapshot).
  const buf2 = empty.set(a, v1, "user");
  const snap2 = buf2.entries();
  const buf2Reedited = buf2.set(a, v1Reedited, "user");
  const buf2After = buf2Reedited.revertMatching(snap2);
  assertEqual(buf2After.cellCount, 1, "revertMatching: re-edited cell A retained");
  assertEqual(
    (buf2After.getEdit(a) as { value: string }).value,
    "Beta",
    "revertMatching: re-edited value preserved",
  );

  // Source mismatch still reverts when the value and meta match. Source is
  // row-level last-touched provenance, so a mid-flight edit to another field
  // can legitimately update the row source without changing this field.
  const buf3 = empty.set(a, v1, "user");
  const snap3 = buf3.entries();
  const buf3Agent = buf3.set(a, v1, "agent");
  const buf3After = buf3Agent.revertMatching(snap3);
  assertEqual(
    buf3After.cellCount,
    0,
    "revertMatching: source-only mismatch still removes the saved value",
  );

  // Meta mismatch counts as "no match" — same value/source but different
  // recordKey on meta means a different write target.
  const metaSnap: EditMeta = {
    modelId: "m1",
    recordKey: { type: "record_id", value: "rec-1" },
    effectiveStart: "2026-05-13",
  };
  const metaLive: EditMeta = {
    modelId: "m1",
    recordKey: { type: "record_id", value: "rec-2" },
    effectiveStart: "2026-05-13",
  };
  const buf4 = empty.set(a, v1, "user", metaSnap);
  const snap4 = buf4.entries();
  const buf4Remeta = buf4.set(a, v1, "user", metaLive);
  const buf4After = buf4Remeta.revertMatching(snap4);
  assertEqual(buf4After.cellCount, 1, "revertMatching: meta mismatch retains the live entry");

  // Json FieldValues with equivalent object content but different key insertion
  // order still count as matching. This guards against regressing to
  // JSON.stringify order-sensitive equality in the apply-success cleanup path.
  const jsonA: FieldValue = { type: "json", value: { a: 1, b: { c: true, d: [1, 2] } } };
  const jsonB: FieldValue = { type: "json", value: { b: { d: [1, 2], c: true }, a: 1 } };
  const jsonAddr = { rowKey: "r-json", fieldId: "json_field" };
  const jsonBuf = empty.set(jsonAddr, jsonA, "user");
  const jsonSnap = jsonBuf.entries();
  const jsonAfter = jsonBuf.set(jsonAddr, jsonB, "user").revertMatching(jsonSnap);
  assertEqual(
    jsonAfter.cellCount,
    0,
    "revertMatching: object-key order does not prevent equivalent json cleanup",
  );

  // ----- engine.updateMeta(addr, partial): merge a partial meta onto an
  // existing entry without disturbing value or source. The row-meta strip's
  // per-row effective-date and change_type pickers are the load-bearing
  // consumer; the contract surfaces three behaviors:
  //   (a) Address NOT in the buffer → no-op; SAME instance returned so
  //       consumers' identity-based memo deps don't churn on misses.
  //   (b) Address present → meta merged; value + source untouched; the
  //       wire payload reflects the new effective_start.
  //   (c) `partial` keys with `undefined` values do NOT erase existing keys
  //       (callers wanting erasure must reach for `set` with a fresh meta).
  const updateMetaInitial: EditMeta = {
    modelId: "model_a",
    recordKey: { type: "record_id", value: "rec-1" } as RecordKey,
    effectiveStart: "2026-05-13",
    bulkGroupId: "bulk-q1",
    changeTypeId: "compensation_change",
  };
  const updateMetaBuf = empty.set(a, v1, "user", updateMetaInitial);

  // (a) Address absent → same instance, no churn.
  const missingAddr: CellAddress = { rowKey: "row-not-present", fieldId: "title" };
  const updateMetaMissing = updateMetaBuf.updateMeta(missingAddr, {
    effectiveStart: "2026-08-01",
  });
  assert(
    updateMetaMissing === updateMetaBuf,
    "updateMeta: missing address returns same buffer instance",
  );

  // (b) Address present, partial merged. Value + source unchanged.
  const updateMetaMerged = updateMetaBuf.updateMeta(a, {
    effectiveStart: "2026-08-01",
    changeTypeId: "title_change",
  });
  const merged = updateMetaMerged.getMeta(a);
  assert(merged !== undefined, "updateMeta: merged meta present");
  if (merged) {
    assertEqual(merged.effectiveStart, "2026-08-01", "updateMeta: effectiveStart updated");
    assertEqual(merged.changeTypeId, "title_change", "updateMeta: changeTypeId updated");
    // Untouched keys preserved.
    assertEqual(merged.modelId, "model_a", "updateMeta: modelId preserved");
    assertEqual(merged.bulkGroupId, "bulk-q1", "updateMeta: bulkGroupId preserved");
    assert(
      merged.recordKey?.type === "record_id" && merged.recordKey.value === "rec-1",
      "updateMeta: recordKey preserved",
    );
  }
  // Value + source untouched.
  assertEqual(
    (updateMetaMerged.getEdit(a) as { value: string }).value,
    "Alpha",
    "updateMeta: value untouched",
  );
  assertEqual(updateMetaMerged.getSource(a), "user", "updateMeta: source untouched");
  const updateMetaRowScoped = updateMetaBuf
    .set(b, vFalse, "user", updateMetaInitial)
    .revert(a)
    .updateMeta(a, {
      effectiveStart: "2026-10-01",
    });
  assertEqual(
    updateMetaRowScoped.getMeta(b)?.effectiveStart,
    "2026-10-01",
    "updateMeta: address field may be absent when row still has pending values",
  );
  // Wire payload reflects the new effective_start (the load-bearing
  // consumer of meta).
  const updateMetaApply = updateMetaMerged.toApplyChangeSet({
    scope: { appId: "app", customerId: "cust" },
    mode: "mainline",
    sourceKind: "test",
    idempotencyKey: null,
    resolveRow: throwingResolver,
  });
  assertEqual(
    updateMetaApply.writes[0]?.effective_start,
    "2026-08-01",
    "updateMeta: wire payload reflects merged effectiveStart",
  );

  // (c) `undefined` in `partial` does NOT erase existing keys.
  const updateMetaUndefined = updateMetaBuf.updateMeta(a, {
    bulkGroupId: undefined,
    effectiveStart: "2026-09-01",
  });
  const undefMerged = updateMetaUndefined.getMeta(a);
  assert(undefMerged !== undefined, "updateMeta: meta after undefined-merge present");
  if (undefMerged) {
    assertEqual(
      undefMerged.bulkGroupId,
      "bulk-q1",
      "updateMeta: undefined value does not erase existing bulkGroupId",
    );
    assertEqual(
      undefMerged.effectiveStart,
      "2026-09-01",
      "updateMeta: defined value still applied",
    );
  }

  // Original buffer unchanged (immutability).
  assertEqual(
    updateMetaBuf.getMeta(a)?.effectiveStart,
    "2026-05-13",
    "updateMeta: original buffer unchanged",
  );

  // (d) No-op identity: merged meta structurally equals live meta →
  // same instance returned. Two paths exercise this:
  //   - empty partial `{}` (the merge produces a value-identical meta);
  //   - partial that re-pastes the same effectiveStart already on the
  //     live entry (the load-bearing real-world case is the date-picker
  //     pill being clicked through to the same date).
  // Both paths exist so consumers' `pendingChangesByRow` memo + the
  // downstream AG Grid recompute chain don't churn on a no-op re-pick.
  const noOpEmptyPartial = updateMetaBuf.updateMeta(a, {});
  assert(
    noOpEmptyPartial === updateMetaBuf,
    "updateMeta: empty partial returns same buffer instance",
  );
  const noOpSameDate = updateMetaBuf.updateMeta(a, {
    effectiveStart: "2026-05-13", // identical to the seeded value
  });
  assert(
    noOpSameDate === updateMetaBuf,
    "updateMeta: re-pasting the same effectiveStart returns same buffer instance",
  );
  const noOpFullMatch = updateMetaBuf.updateMeta(a, {
    effectiveStart: "2026-05-13",
    changeTypeId: "compensation_change",
    bulkGroupId: "bulk-q1",
  });
  assert(
    noOpFullMatch === updateMetaBuf,
    "updateMeta: full-match merge returns same buffer instance",
  );
}

describe("edit buffer engine", () => {
  it("tracks draft edits and save state", () => {
    testEditBufferEngine();
  });
});
