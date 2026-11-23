// useDrafts — load the pending drafts list + fan out per-id to /api/diff.
//
// Layer rules:
//   - Module hook; injects a `KernelClient` rather than importing one.
//   - Parameterized over the app's wire-type aliases (we don't bind to
//     app-narrowed `Schema`, `ChangeSetDiff`, etc. — the substrate shapes
//     in @contracts are sufficient).
//
// Promise.all keeps the round-trip count visible (and lets pages render
// the loading shell without a per-card waterfall once the diffs arrive).

import { useCallback, useEffect, useRef, useState } from "react";

import type { AppId, ChangeSetDiff, CustomerId, DraftSummary, KernelClient } from "@contracts";

import type { DraftWithDiff } from "../helpers/cards";

export type DraftsLoadState = {
  data: ReadonlyArray<DraftWithDiff>;
  loading: boolean;
  error: unknown | null;
  reload: () => Promise<void>;
};

export function useDrafts(args: {
  client: KernelClient;
  scope: { appId: AppId; customerId: CustomerId };
  // The summary list to read. Defaults to the pending drafts; the Rejected
  // tab reads `/api/drafts/rejected`, which answers the same shape.
  path?: string;
  // When false nothing loads (an app that does not serve `path`).
  enabled?: boolean;
}): DraftsLoadState {
  const { client, scope, path = "/api/drafts", enabled = true } = args;
  const [data, setData] = useState<ReadonlyArray<DraftWithDiff>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown | null>(null);
  // Request-id counter: when reload is called twice in quick succession
  // (e.g. action-handler refetch firing before initial mount load
  // resolves), the older response can land AFTER the newer one and
  // overwrite fresher state. Each call bumps the id; only the response
  // whose id matches the latest may commit to state.
  const reqIdRef = useRef(0);

  const reload = useCallback(async () => {
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const summaries = enabled ? await client.getJson<DraftSummary[]>(path) : [];
      const diffs = await Promise.all(
        summaries.map((s) =>
          client.postJson<ChangeSetDiff>("/api/diff", {
            app_id: scope.appId,
            customer_id: scope.customerId,
            change_set_id: s.id,
          }),
        ),
      );
      if (reqId !== reqIdRef.current) return;
      setData(summaries.map((draft, idx) => ({ draft, records: diffs[idx]!.records })));
    } catch (e) {
      // Stash for the component-state consumer (loading badge / error
      // banner read from `error`). Also re-throw so callers that AWAIT
      // `reload()` (`useDraftReview`'s `refetchAfterAction`) can branch
      // on success vs failure for the post-action toast. Per FR-A F2:
      // the post-action toast must not narrate confident success when
      // the follow-up reload failed.
      if (reqId === reqIdRef.current) setError(e);
      throw e;
    } finally {
      // Only the latest call clears `loading`; a stale call finishing
      // mustn't flip a still-pending newer call's spinner off.
      if (reqId === reqIdRef.current) setLoading(false);
    }
  }, [client, scope.appId, scope.customerId, path, enabled]);

  useEffect(() => {
    // Initial-mount reload: errors land in `error` state for the
    // component to render; we swallow the throw here because there's
    // no caller to surface it to. (Action-handler callers AWAIT
    // `reload()` directly and observe the rejection per FR-A F2.)
    reload().catch(() => {});
  }, [reload]);

  return { data, loading, error, reload };
}
