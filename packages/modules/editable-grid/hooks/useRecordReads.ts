// useRecordReads — load `VisibleRecord[]` for a model at the current asOf,
// reload when asOf changes. Stale-response guarded so a quick asOf change
// doesn't paint stale rows.

import { useCallback, useEffect, useRef, useState } from "react";

import type { KernelClient, ModelId, VisibleRecord } from "@contracts";

export type RecordReadsState = {
  records: VisibleRecord[];
  loading: boolean;
  error: unknown | null;
  loadedAsOf: string | null;
  reload: () => Promise<void>;
};

export function useRecordReads(
  client: KernelClient,
  modelId: ModelId,
  asOf: string,
): RecordReadsState {
  const [records, setRecords] = useState<VisibleRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown | null>(null);
  const [loadedAsOf, setLoadedAsOf] = useState<string | null>(null);
  // Stale-response guard: every load increments the seq; only the latest
  // response writes state.
  const seqRef = useRef(0);
  const reload = useCallback(async () => {
    const mySeq = seqRef.current + 1;
    seqRef.current = mySeq;
    const issued = { modelId, asOf };
    if (!issued.modelId) {
      setRecords([]);
      setLoading(false);
      setError(null);
      setLoadedAsOf(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const url = `/api/records?model_id=${encodeURIComponent(issued.modelId)}&as_of=${encodeURIComponent(issued.asOf)}`;
      const payload = await client.getJson<VisibleRecord[]>(url);
      // Defense in depth: seq guard alone catches the common case (a
      // newer reload superseded this one), but ALSO check that issued
      // params still match current — handles the edge case where a
      // caller toggles props back to the original value mid-flight and
      // the seq has incremented but params look identical.
      if (mySeq === seqRef.current) {
        setRecords(payload);
        setLoadedAsOf(issued.asOf);
      }
    } catch (e) {
      if (mySeq === seqRef.current) {
        setError(e);
      }
    } finally {
      if (mySeq === seqRef.current) setLoading(false);
    }
  }, [asOf, client, modelId]);

  useEffect(() => {
    void reload();
  }, [asOf, modelId, reload]);

  return { records, loading, error, loadedAsOf, reload };
}
