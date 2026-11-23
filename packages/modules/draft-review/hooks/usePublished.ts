// usePublished — load the recent-mainline activity list + fan out per-id
// to /api/diff. Returns the same `DraftWithDiff` shape as useDrafts so the
// card-grouping helpers handle both lists with one code path.
//
// Layer rules:
//   - Module hook; injects a `KernelClient` rather than importing one.
//   - Apps thread their own `source_kinds` filter (defaults below to the
//     human/agent UI-originated subset — see comment) so seed/import traffic
//     doesn't drown the real user history.
//
// Loads on mount (no `enabled` gate) so the filter bar's `Published (N)`
// count reflects reality from first paint instead of staying at 0 until
// the user clicks the Published tab.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  AppId,
  ChangeSetDiff,
  CustomerId,
  KernelClient,
  RecentActivityEntry,
} from "@contracts";

import type { DraftsLoadState } from "./useDrafts";
import type { DraftWithDiff } from "../helpers/cards";

// Stable default for `sourceKinds`. Defining inline in the destructure
// would mint a fresh array per render — `reload`'s useCallback dep
// would see a new identity each render, the `useEffect(..., [reload])`
// would fire perpetually, and the loader would loop. Module-level
// constant keeps identity stable across renders.
const DEFAULT_SOURCE_KINDS: ReadonlyArray<string> = ["user", "agent", "revert"];

export function usePublished(args: {
  client: KernelClient;
  scope: { appId: AppId; customerId: CustomerId };
  // Cap on the recent_activity response. The kernel default returns the
  // full history; review surfaces are not audit logs. Defaults to 25.
  limit?: number;
  // Provenance INCLUDE filter forwarded to /api/activity (`source_kinds`).
  // The kernel writes seed imports with `source_kind: "seed"` style
  // values; leaving them in drowns user-originated history. Apps thread
  // the values they DO want to surface here. Defaults to `["user",
  // "agent", "revert"]` to cover human grid saves, agent-staged saves,
  // and `/api/revert`.
  //
  // CONTRACT: the hook internally memoizes `sourceKinds` by stringified
  // contents, so callers do NOT need to wrap their array in `useMemo`.
  // A fresh array literal each render is fine — the `useCallback` deps
  // below see a stable identity until the CONTENTS actually change. This
  // prevents the perpetual-reload loop that would otherwise fire when a
  // parent component re-renders for unrelated reasons.
  sourceKinds?: ReadonlyArray<string>;
}): DraftsLoadState {
  const { client, scope, limit = 25, sourceKinds = DEFAULT_SOURCE_KINDS } = args;
  const [data, setData] = useState<ReadonlyArray<DraftWithDiff>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown | null>(null);
  // Stabilize `sourceKinds` against caller-supplied reference churn —
  // see the prop-doc above for the rationale. The dep is the JSON
  // stringification of a SORTED copy so callers swapping element order
  // (e.g. `["ui","revert"]` vs `["revert","ui"]`) collapse to the same
  // memo key — order doesn't affect the kernel filter (`source_kinds`
  // is a set on the wire), so a spurious reload from a reorder would
  // burn an unnecessary round-trip. The wire payload still uses the
  // sorted form for the same reason (deterministic request bodies →
  // friendlier to any future request-fingerprint cache).
  //
  // `toSorted()` preserves the caller's array while giving the wire path
  // deterministic ordering.
  const sourceKindsKey = JSON.stringify(sourceKinds.toSorted());
  const sourceKindsStable = useMemo(
    // The returned reference is the SORTED copy, not the caller's
    // original, so downstream `reload`'s body sees a stable
    // element-order across renders too.
    () => sourceKinds.toSorted(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sourceKindsKey],
  );
  // Request-id counter: prevents an older reload's response from
  // overwriting a newer one's state when the user triggers two reloads
  // in quick succession (e.g. action-handler refetch racing the
  // initial-mount load). Same pattern as `useDrafts`.
  const reqIdRef = useRef(0);

  const reload = useCallback(async () => {
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const entries = await client.postJson<RecentActivityEntry[]>("/api/activity", {
        app_id: scope.appId,
        customer_id: scope.customerId,
        limit,
        statuses: ["mainline"],
        source_kinds: sourceKindsStable,
      });
      const diffs = await Promise.all(
        entries.map((e) =>
          client.postJson<ChangeSetDiff>("/api/diff", {
            app_id: scope.appId,
            customer_id: scope.customerId,
            change_set_id: e.change_set_id,
          }),
        ),
      );
      if (reqId !== reqIdRef.current) return;
      setData(
        entries.map((entry, idx) => ({
          // Synthesize a DraftSummary-shaped entry so the cards builder
          // consumes both lists with one code path. The renderer relabels
          // status to "published" via buildPublishedCards.
          //
          // `schema_revision_id` is intentionally omitted here.
          // The `RecentActivityEntry` doesn't carry it (the kernel issues
          // no real revision id for this row), so `DraftWithDiff.draft` is
          // `Omit<DraftSummary, "schema_revision_id">` so this synthesis
          // satisfies the shape honestly while real drafts (which DO
          // carry the field) still flow through `useDrafts` unchanged.
          draft: {
            id: entry.change_set_id,
            actor_id: entry.actor_id,
            source_kind: entry.source_kind,
            source_ref: entry.source_ref,
            change_type_id: entry.change_type_id,
            notes: entry.notes,
            created_at: entry.created_at,
          },
          records: diffs[idx]!.records,
        })),
      );
    } catch (e) {
      // Stash for the component-state consumer (loading badge / error
      // banner read from `error`). Also re-throw so callers that AWAIT
      // `reload()` (`useDraftReview`'s `refetchAfterAction`) can branch
      // on success vs failure for the post-action toast. Per FR-A F2.
      if (reqId === reqIdRef.current) setError(e);
      throw e;
    } finally {
      // Only the latest call clears `loading`; a stale call finishing
      // mustn't flip a still-pending newer call's spinner off.
      if (reqId === reqIdRef.current) setLoading(false);
    }
  }, [client, scope.appId, scope.customerId, limit, sourceKindsStable]);

  useEffect(() => {
    // Initial-mount reload: errors land in `error` state for the
    // component to render; we swallow the throw here because there's
    // no caller to surface it to. Action-handler callers AWAIT
    // `reload()` directly and observe the rejection per FR-A F2.
    reload().catch(() => {});
  }, [reload]);

  return { data, loading, error, reload };
}
