// useDraftReview action handlers reload both tabs so segmented-control counts
// stay accurate after publish, discard, or revert.
//
// Test mounts `useDraftReview` against a fake client whose `getJson`
// (drafts) + `postJson` (activity for published, plus the action
// endpoint) are vi.fn-tracked. Each action handler invocation is
// asserted to trigger both loaders' reload — visible as a fresh
// `/api/drafts` GET AND a fresh `/api/activity` POST.

import { useEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, render, waitFor } from "@testing-library/react";

import { ToastProvider } from "@autograph/components";
import type { KernelClient, Schema } from "@contracts";

import { useDraftReview, useDrafts, usePublished, type DraftReviewController } from "../index";

function makeStubSchema(): Schema {
  return {
    app_id: "hc",
    customer_id: "demo",
    version: "test",
    models: [
      {
        id: "position",
        kind: "entity",
        label: "Position",
        fields: [],
      },
    ],
    change_types: [
      {
        id: "position_update",
        label: "Position update",
        target_model: "position",
        touches: [],
        required: [],
      },
    ],
  };
}

function makeFakeClient() {
  // /api/drafts → [], so the loader resolves with an empty list (no
  // per-draft diff calls fire). /api/activity → [], same. The action
  // endpoint (/api/draft/discard etc.) returns `{ ok: true }`.
  const getJson = vi.fn(async (path: string) => {
    if (path === "/api/drafts") return [];
    return [];
  });
  const postJson = vi.fn(async (path: string, _body: unknown) => {
    if (path === "/api/activity") return [];
    if (path === "/api/diff") return { records: [] };
    return { ok: true };
  });
  return { getJson, postJson } as KernelClient & {
    getJson: ReturnType<typeof vi.fn>;
    postJson: ReturnType<typeof vi.fn>;
  };
}

type CountSnapshot = {
  draftsReloads: number;
  publishedReloads: number;
};

function countCalls(client: ReturnType<typeof makeFakeClient>): CountSnapshot {
  const draftsReloads = client.getJson.mock.calls.filter(
    (call) => call[0] === "/api/drafts",
  ).length;
  const publishedReloads = client.postJson.mock.calls.filter(
    (call) => call[0] === "/api/activity",
  ).length;
  return { draftsReloads, publishedReloads };
}

// Action handlers await refetchAfterAction() and warn on reload failure
// instead of narrating success over stale data.
describe("useDraftReview: reload failure narrates softer toast (FR-A F2)", () => {
  it("publish then failed reload fires the warning toast, not success", async () => {
    const client = makeFakeClient();
    // Make ALL subsequent /api/drafts loads fail. The initial mount
    // load can resolve (we count past it via waitFor); the post-action
    // reload then throws, which the action handler's try/catch around
    // `await refetchAfterAction()` converts into the warning toast.
    let initialDraftsLoadResolved = false;
    client.getJson.mockImplementation(async (path: string) => {
      if (path === "/api/drafts") {
        if (!initialDraftsLoadResolved) {
          initialDraftsLoadResolved = true;
          return [];
        }
        throw new Error("network down");
      }
      return [];
    });

    let captured: DraftReviewController | null = null;
    function Harness() {
      const controller = useDraftReview({
        client,
        scope: { appId: "hc", customerId: "demo" },
        schema: makeStubSchema(),
        primaryModel: "position",
        defaultChangeTypeId: "position_update",
      });
      useEffect(() => {
        captured = controller;
      });
      return null;
    }

    render(
      <ToastProvider>
        <Harness />
      </ToastProvider>,
    );

    await waitFor(() => {
      expect(captured).not.toBeNull();
      // Initial mount load resolved so the "first call ok" branch above
      // already fired.
      expect(initialDraftsLoadResolved).toBe(true);
    });

    // Publish: POST resolves, refetchAfterAction fires both loaders.
    // /api/drafts now throws → Promise.all rejects → the catch branch
    // fires the softer warning toast.
    await act(async () => {
      await captured!.onPublish(42);
    });

    // Probe the rendered toast viewport (portaled into <body>). The
    // load-bearing assertions:
    //   1. NO confident "Published draft." copy ever rendered.
    //   2. The softer "Published, but failed to refresh — try reloading."
    //      copy DID render.
    await waitFor(() => {
      const body = document.body.textContent ?? "";
      expect(body).not.toContain("Published draft.");
      expect(body).toContain("Published, but failed to refresh");
    });
  });
});

describe("useDraftReview: refetchAfterAction reloads both tabs", () => {
  it("Publish, Discard, and Revert each reload BOTH drafts and published", async () => {
    const client = makeFakeClient();
    let captured: DraftReviewController | null = null;

    function Harness() {
      const controller = useDraftReview({
        client,
        scope: { appId: "hc", customerId: "demo" },
        schema: makeStubSchema(),
        primaryModel: "position",
        defaultChangeTypeId: "position_update",
      });
      useEffect(() => {
        captured = controller;
      });
      return null;
    }

    render(
      <ToastProvider>
        <Harness />
      </ToastProvider>,
    );

    // Wait for the initial mount loads to settle so the baseline is
    // stable.
    await waitFor(() => {
      const baseline = countCalls(client);
      expect(baseline.draftsReloads).toBeGreaterThanOrEqual(1);
      expect(baseline.publishedReloads).toBeGreaterThanOrEqual(1);
    });
    const baseline = countCalls(client);

    // Publish -> both tabs reload. Drafts loses an entry; Published gains one.
    await act(async () => {
      await captured!.onPublish(42);
    });
    await waitFor(() => {
      const after = countCalls(client);
      expect(after.draftsReloads).toBe(baseline.draftsReloads + 1);
      expect(after.publishedReloads).toBe(baseline.publishedReloads + 1);
    });
    const afterPublish = countCalls(client);

    // Discard → both tabs reload too. Strictly speaking only Drafts
    // changes, but reloading both is cheaper than action-aware
    // branching AND keeps the contract trivially "always both."
    await act(async () => {
      await captured!.onDiscard(43);
    });
    await waitFor(() => {
      const after = countCalls(client);
      expect(after.draftsReloads).toBe(afterPublish.draftsReloads + 1);
      expect(after.publishedReloads).toBe(afterPublish.publishedReloads + 1);
    });
    const afterDiscard = countCalls(client);

    // Revert → both tabs. Strictly Published changes, but the
    // compensating change_set may surface as a NEW draft entry the
    // user wants to see; both loaders cover both paths.
    await act(async () => {
      await captured!.onRevert(44);
    });
    await waitFor(() => {
      const after = countCalls(client);
      expect(after.draftsReloads).toBe(afterDiscard.draftsReloads + 1);
      expect(after.publishedReloads).toBe(afterDiscard.publishedReloads + 1);
    });
  });
});

// P11 B4 (FR-A landmine): refetchAfterAction used `Promise.all`, which
// short-circuits on the FIRST rejection — if the slower-rejecting loader
// throws AFTER the first, its rejection has no handler attached and the
// runtime surfaces it as an unhandledRejection. The fix uses
// `Promise.allSettled` so handlers attach to BOTH promises before any
// rejection lands, then synthesizes a composed Error from the rejected
// loaders so the action handler's catch branch still fires the softer
// warning toast.
describe("useDraftReview: both reloads failing produces no unhandledRejection (P11 B4)", () => {
  it("Publish then both reloads fail: composed error, no unhandledRejection", async () => {
    // Track unhandledRejection events for the test's duration.
    const unhandled: Array<unknown> = [];
    const onUnhandled = (event: PromiseRejectionEvent) => {
      // jsdom dispatches `unhandledrejection`; the reason is what we
      // care about. Push and prevent the default so the event doesn't
      // bubble to the vitest harness as a test failure.
      unhandled.push(event.reason);
      event.preventDefault();
    };
    window.addEventListener("unhandledrejection", onUnhandled);

    try {
      const client = makeFakeClient();
      // Drafts: first call succeeds (initial-mount load); subsequent
      // calls reject. Published: first call succeeds; subsequent reject.
      // Reject order is staggered (drafts rejects fast, published rejects
      // slowly) to prove both loader rejections are handled.
      let draftsCallCount = 0;
      let activityCallCount = 0;
      client.getJson.mockImplementation(async (path: string) => {
        if (path === "/api/drafts") {
          draftsCallCount += 1;
          if (draftsCallCount === 1) return [];
          throw new Error("drafts down");
        }
        return [];
      });
      client.postJson.mockImplementation(async (path: string, _body: unknown) => {
        if (path === "/api/activity") {
          activityCallCount += 1;
          if (activityCallCount === 1) return [];
          // Slow rejection to exercise the unhandled path of
          // Promise.all (drafts already rejected; this one rejects
          // 0 microtasks later).
          await Promise.resolve();
          throw new Error("activity down");
        }
        if (path === "/api/diff") return { records: [] };
        return { ok: true };
      });

      let captured: DraftReviewController | null = null;
      function Harness() {
        const controller = useDraftReview({
          client,
          scope: { appId: "hc", customerId: "demo" },
          schema: makeStubSchema(),
          primaryModel: "position",
          defaultChangeTypeId: "position_update",
        });
        useEffect(() => {
          captured = controller;
        });
        return null;
      }

      render(
        <ToastProvider>
          <Harness />
        </ToastProvider>,
      );

      await waitFor(() => {
        expect(captured).not.toBeNull();
        // Initial loads finished — `draftsCallCount` and
        // `activityCallCount` both equal 1.
        expect(draftsCallCount).toBe(1);
        expect(activityCallCount).toBe(1);
      });

      // Publish: POST resolves, then refetchAfterAction fires both
      // loaders. Both reject. The fix's Promise.allSettled attaches
      // a handler to BOTH before any rejects, so no unhandledRejection
      // fires. The composed Error reaches the action handler's catch
      // which renders the softer warning toast.
      await act(async () => {
        await captured!.onPublish(42);
      });

      // Drain microtasks so any unhandled-rejection event has a
      // chance to dispatch.
      await act(async () => {
        await new Promise((res) => setTimeout(res, 0));
      });

      // Load-bearing: zero unhandled-rejection events.
      expect(unhandled).toEqual([]);

      // The warning toast must still fire (composed Error reaches the
      // catch branch).
      const body = document.body.textContent ?? "";
      expect(body).toContain("Published, but failed to refresh");
    } finally {
      window.removeEventListener("unhandledrejection", onUnhandled);
    }
  });
});

// useDrafts.reload() race: two overlapping reload() calls can race; the
// slower-resolving older response must not overwrite newer state. The hook uses
// an internal request-id counter: only the latest committed call may mutate
// state. This test stages two reloads where the first one
// resolves AFTER the second, and asserts the SECOND's payload is the
// one that lands in `data`.
describe("useDrafts: reload race — older response cannot overwrite newer", () => {
  it("first reload resolves last; second reload's data wins", async () => {
    // Two pending /api/drafts deferreds; we control resolution order.
    let resolveFirst: ((value: unknown) => void) | null = null;
    let resolveSecond: ((value: unknown) => void) | null = null;
    let callCount = 0;
    const getJson = vi.fn(async (path: string) => {
      if (path !== "/api/drafts") return [];
      callCount += 1;
      if (callCount === 1) {
        return new Promise((res) => {
          resolveFirst = res;
        });
      }
      return new Promise((res) => {
        resolveSecond = res;
      });
    });
    const postJson = vi.fn(async (_path: string, _body: unknown) => ({ records: [] }));
    const client = { getJson, postJson } as KernelClient;

    type Captured = {
      data: ReturnType<typeof useDrafts>["data"];
      reload: ReturnType<typeof useDrafts>["reload"];
    };
    let captured: Captured | null = null;

    function Harness() {
      const state = useDrafts({
        client,
        scope: { appId: "hc", customerId: "demo" },
      });
      useEffect(() => {
        captured = { data: state.data, reload: state.reload };
      });
      return null;
    }

    render(<Harness />);

    // Wait for the initial mount load to have fired (first deferred is
    // queued; nothing has resolved yet).
    await waitFor(() => {
      expect(captured).not.toBeNull();
      expect(resolveFirst).not.toBeNull();
    });

    // Trigger the SECOND reload; it queues the second deferred.
    let secondReloadPromise: Promise<void>;
    act(() => {
      secondReloadPromise = captured!.reload();
    });
    await waitFor(() => {
      expect(resolveSecond).not.toBeNull();
    });

    // Resolve SECOND first (the newer call lands with its payload).
    await act(async () => {
      resolveSecond!([{ id: 200, schema_revision_id: 1 }]);
      await secondReloadPromise;
    });

    // Now resolve FIRST (the OLDER call). Without the request-id guard
    // it would overwrite state with its stale [first-call payload].
    // With the fix it's a no-op for state.
    await act(async () => {
      resolveFirst!([{ id: 100, schema_revision_id: 1 }]);
      // Drain microtasks so the catch from the initial mount's swallowed
      // throw (if any) settles before we read state.
      await Promise.resolve();
    });

    await waitFor(() => {
      // The committed data must be SECOND's payload (id: 200), not
      // FIRST's (id: 100).
      expect(captured!.data.length).toBe(1);
      expect(captured!.data[0]!.draft.id).toBe(200);
    });
  });
});

// P11 P3: `usePublished`'s sourceKinds memo was keyed by JSON of the
// caller-supplied order. Callers that pass `["ui","revert"]` vs
// `["revert","ui"]` would mint different memo keys → the `reload`
// useCallback's identity would change → the mount `useEffect(...,
// [reload])` would fire a spurious second reload for what is the SAME
// filter (the kernel treats `source_kinds` as a set, so order is
// semantically meaningless). The fix sorts before stringification AND
// before assigning the memoized reference so order swaps collapse to
// one reload. ALSO covers the existing useDrafts-style race guard for
// usePublished (the cubic-C6 test only covers useDrafts).
describe("usePublished: sourceKinds order swap does not trigger spurious reload (P11 P3)", () => {
  it("loads human and agent published changes by default", async () => {
    const getJson = vi.fn(async () => []);
    const postJson = vi.fn(async (path: string, _body: unknown) => {
      if (path === "/api/activity") return [];
      if (path === "/api/diff") return { records: [] };
      return [];
    });
    const client = { getJson, postJson } as KernelClient & {
      postJson: ReturnType<typeof vi.fn>;
    };

    function Harness() {
      usePublished({
        client,
        scope: { appId: "hc", customerId: "demo" },
      });
      return null;
    }

    render(<Harness />);

    await waitFor(() => {
      expect(client.postJson).toHaveBeenCalledWith(
        "/api/activity",
        expect.objectContaining({
          source_kinds: ["agent", "revert", "user"],
        }),
      );
    });
  });

  it("rerendering with reordered sourceKinds reuses the memoized hook", async () => {
    let activityCallCount = 0;
    const getJson = vi.fn(async () => []);
    const postJson = vi.fn(async (path: string, _body: unknown) => {
      if (path === "/api/activity") {
        activityCallCount += 1;
        return [];
      }
      if (path === "/api/diff") return { records: [] };
      return [];
    });
    const client = { getJson, postJson } as KernelClient;

    function Harness({ sourceKinds }: { sourceKinds: ReadonlyArray<string> }) {
      // Direct usePublished call (skip the useDraftReview wrapper) so
      // the test focuses on this hook's memo contract.
      usePublished({
        client,
        scope: { appId: "hc", customerId: "demo" },
        sourceKinds,
      });
      return null;
    }

    const { rerender } = render(<Harness sourceKinds={["ui", "revert"]} />);

    // Wait for the initial mount load to fire.
    await waitFor(() => {
      expect(activityCallCount).toBe(1);
    });

    // Rerender with the REVERSED order — same elements, different
    // array reference, different naive-key. With the sort-before-key
    // fix, the memo collapses to the same reference → reload identity
    // is stable → no extra /api/activity call fires.
    rerender(<Harness sourceKinds={["revert", "ui"]} />);

    // Drain microtasks so any spurious effect-triggered reload has
    // had a chance to fire.
    await act(async () => {
      await new Promise((res) => setTimeout(res, 0));
    });

    // Load-bearing: still ONE /api/activity call. Legacy code would
    // have fired a second here.
    expect(activityCallCount).toBe(1);

    // Re-confirm with a fresh literal of the original order — still
    // one call (the sort key is stable across all orderings).
    rerender(<Harness sourceKinds={["ui", "revert"]} />);
    await act(async () => {
      await new Promise((res) => setTimeout(res, 0));
    });
    expect(activityCallCount).toBe(1);
  });
});
