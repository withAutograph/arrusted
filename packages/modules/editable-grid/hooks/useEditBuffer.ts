// useEditBuffer — React hook over `packages/engines/edit-buffer/createEditBuffer`.
//
// The engine is pure + immutable; this hook provides referentially-stable
// `set` / `revert` / `clear` callbacks so callers don't re-render their
// columnDefs on every state change. `buffer` itself is the latest engine
// instance and is what callers read.

import { useCallback, useRef, useState } from "react";

import {
  createEditBuffer,
  type CellAddress,
  type EditBuffer,
  type EditEntry,
  type EditMeta,
  type EditSource,
  type PendingFieldValue,
  type RowKey,
} from "@engines/edit-buffer/index";

export type EditBufferState = {
  buffer: EditBuffer;
  set: (addr: CellAddress, value: PendingFieldValue, source?: EditSource, meta?: EditMeta) => void;
  // Shallow-merge `partial` into the entry's existing meta. Used by the
  // editable-grid module's row-meta strip pickers (per-row effective-date
  // / change_type pickers) to retarget pending edits without re-issuing
  // the value. No-op (same buffer identity returned) when the address
  // isn't in the buffer OR when the merged meta is structurally equal to
  // the live meta — re-picking the same date / change_type / bulk_group
  // doesn't churn the downstream memo + AG Grid recompute chain.
  updateMeta: (addr: CellAddress, partial: Partial<EditMeta>) => void;
  revert: (addr: CellAddress) => void;
  revertRow: (rowKey: RowKey) => void;
  // Value-aware revert against a snapshot. Used by the apply-success path
  // to clear submitted entries while preserving any cells the user edited
  // during the in-flight apply. See engine `revertMatching` for the
  // matching contract.
  revertMatching: (snapshot: ReadonlyArray<EditEntry>) => void;
  clear: () => void;
  isDirty: boolean;
  // The LIVE buffer, including mutations applied earlier in the same event
  // tick. `buffer` is the render-time state snapshot — a multi-step handler
  // (stage N rows, then roll back on failure) that reads `buffer` sees the
  // PREVIOUS render's state and silently no-ops. React defers functional
  // setState updaters, so liveness requires eager application (see below).
  current: () => EditBuffer;
};

export function useEditBuffer(): EditBufferState {
  // Eager-application pattern: the ref is authoritative and advanced
  // synchronously in each mutator (the engine is pure/immutable, so applying
  // eagerly in the event handler is safe and StrictMode-idempotent); state
  // mirrors it purely to trigger re-render. Functional `setBuffer((b) => …)`
  // would NOT work here — React may defer updaters to the next render, so
  // same-tick readers (revertBulkGroup after stageBulkUpdate) would still see
  // stale state.
  const [buffer, setBufferState] = useState<EditBuffer>(() => createEditBuffer());
  const bufferRef = useRef(buffer);
  const advance = useCallback((next: EditBuffer) => {
    bufferRef.current = next;
    setBufferState(next);
  }, []);

  const set = useCallback(
    (addr: CellAddress, value: PendingFieldValue, source: EditSource = "user", meta?: EditMeta) => {
      advance(bufferRef.current!.set(addr, value, source, meta));
    },
    [advance],
  );
  const updateMeta = useCallback(
    (addr: CellAddress, partial: Partial<EditMeta>) => {
      advance(bufferRef.current!.updateMeta(addr, partial));
    },
    [advance],
  );
  const revert = useCallback(
    (addr: CellAddress) => advance(bufferRef.current!.revert(addr)),
    [advance],
  );
  const revertRow = useCallback(
    (rowKey: RowKey) => advance(bufferRef.current!.revertRow(rowKey)),
    [advance],
  );
  const revertMatching = useCallback(
    (snapshot: ReadonlyArray<EditEntry>) => advance(bufferRef.current!.revertMatching(snapshot)),
    [advance],
  );
  const clear = useCallback(() => advance(bufferRef.current!.clear()), [advance]);
  const current = useCallback(() => bufferRef.current!, []);

  const isDirty = buffer.cellCount > 0;

  return { buffer, set, updateMeta, revert, revertRow, revertMatching, clear, isDirty, current };
}
