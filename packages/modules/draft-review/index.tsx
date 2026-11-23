// @modules/draft-review — spec-driven review-surface module.
//
// Two-tab review UI (Drafts | Published) over a kernel substrate that
// exposes change_sets. Apps inject:
//   - a `KernelClient` + `scope` for substrate calls;
//   - the app's `schema` (the module reads `models[primaryModel].fields`
//     to label columns, and `change_types` to filter + label cards);
//   - `renderPrimaryCell(row)` — how the leftmost cell renders (e.g. an
//     avatar + title block for a `position`, a code + description block
//     for a `discount`);
//   - `relationLabel(fieldId, recordId)` — how the diff renderer resolves
//     relation cells. Module doesn't name HC-domain relations (e.g.
//     `department`, `manager`); the app's callback dispatches.
//
// Layer rules:
//   - Imports `@contracts` as type-only; `@autograph/components` for chrome;
//     does NOT import any app-generated client or app-narrowed surface.
//
// Hook + surface split mirrors @modules/editable-grid:
//   const controller = useDraftReview({ ... });
//   return <DraftReviewSurface controller={controller} renderPrimaryCell={...} />;
//
// The controller exposes everything the surface needs PLUS the action
// handlers (onDiscard / onPublish / onRevert), the tab state, the type
// filter state, and the loader states. Apps can read those to render
// custom chrome (e.g. an asOf-pill in the toolbar) and call the action
// handlers from their own affordances if they choose.

import { useCallback, useMemo, useState, type ReactNode } from "react";

import { useToast } from "@autograph/components";
import { customFieldDefinitionAsField } from "../../engines/custom-field-projection/index";
import type {
  AppId,
  ChangeType,
  ChangeTypeId,
  CustomerId,
  KernelClient,
  Model,
  ModelId,
  Schema,
} from "@contracts";

import { useDrafts, type DraftsLoadState } from "./hooks/useDrafts";
import { usePublished } from "./hooks/usePublished";
import {
  buildDraftCards,
  buildPublishedCards,
  type ApprovalCard,
  type DraftWithDiff,
  type RelationLabelLookup,
} from "./helpers/cards";
import { FilterBar, ALL_TYPES, type ReviewTab } from "./components/filter-bar";
import {
  CardView,
  type AuthorLabel,
  type RenderCardFooter,
  type RenderDiffCell,
  type RenderPrimaryCell,
} from "./components/card-view";
import { EmptyState, type EmptyStateProps } from "./components/empty-state";

// Re-export the helpers + hook + component types so apps consuming the
// barrel don't have to dig.
export {
  avatarInitials,
  buildDraftCards,
  buildPublishedCards,
  columnsForCard,
  formatEffectiveDate,
  formatFieldValue,
  isMaterialDiff,
  isNamedDraft,
  pluralizeChangeTypeLabel,
} from "./helpers/cards";
export type {
  ApprovalCard,
  CardRow,
  CardStatus,
  ColumnSpec,
  DraftWithDiff,
  RelationLabelLookup,
} from "./helpers/cards";
export { useDrafts } from "./hooks/useDrafts";
export type { DraftsLoadState } from "./hooks/useDrafts";
export { usePublished } from "./hooks/usePublished";
export type {
  AuthorLabel,
  RenderCardFooter,
  RenderPrimaryCell,
  RenderDiffCell,
} from "./components/card-view";
export type { ReviewTab } from "./components/filter-bar";
export type { EmptyStateProps } from "./components/empty-state";

// ---------------------------------------------------------------------------
// Controller API
// ---------------------------------------------------------------------------

export type UseDraftReviewConfig = {
  client: KernelClient;
  scope: { appId: AppId; customerId: CustomerId };
  // App's schema. Module reads `models.find(id === primaryModel).fields`
  // for column labels and `change_types` for the type-filter dropdown.
  schema: Schema | null;
  // Which model's change_types to surface in the type filter. The module
  // narrows `schema.change_types` to entries whose `target_model` matches.
  // Card grouping itself is model-agnostic — cards are produced for every
  // change_set the loaders return.
  primaryModel: ModelId;
  // Fallback change_type id for drafts whose wire `change_type_id` is null.
  // Apps thread their catch-all type id here (e.g. HC's `position_update`).
  defaultChangeTypeId: ChangeTypeId;
  // Provenance INCLUDE filter for the Published tab. Apps thread the
  // `source_kind` values they want surfaced (default
  // `["user", "agent", "revert"]` covers user-driven writes,
  // agent-staged writes, and intentional reverts).
  publishedSourceKinds?: ReadonlyArray<string>;
  // Cap on the recent_activity response for the Published tab. Defaults to 25.
  publishedLimit?: number;
  // Only drafts that change at least one of these models are listed and
  // counted (a draft is shown whole). Columns of every record are then
  // labelled from its own model in `schema`.
  models?: ReadonlyArray<ModelId>;
  // One card per draft, with its author, time and note, instead of grouping
  // unnamed drafts by change type.
  cardPerDraft?: boolean;
  // Lists pending drafts (the Drafts tab, its count and `pendingDrafts`).
  // On by default; off for an app whose Saves publish straight away, whose
  // review is then its published history. "when-any" lists them and shows the
  // tab only while drafts exist (e.g. drafts saved before the app switched to
  // direct Saves).
  pending?: boolean | "when-any";
  // Adds the Rejected tab: discarded drafts from `GET /api/drafts/rejected`
  // (same summary shape as `/api/drafts`), read-only with their notes. Off by
  // default, for apps whose API does not serve it. "when-any" shows it only
  // while rejected drafts exist.
  rejected?: boolean | "when-any";
};

export type DraftReviewController = {
  tab: ReviewTab;
  setTab: (next: ReviewTab) => void;
  drafts: DraftsLoadState;
  published: DraftsLoadState;
  // Empty and never loaded unless `rejected` is on.
  rejected: DraftsLoadState;
  // Whether the Drafts tab is shown (`pending`).
  draftsTab: boolean;
  // Whether the Rejected tab is shown.
  rejectedTab: boolean;
  // Cards for the ACTIVE tab, already type-filtered. Apps render these
  // through the surface; reading them directly is fine for custom chrome
  // (e.g. count-only views).
  cards: ReadonlyArray<ApprovalCard>;
  // Counts per tab (pre-type-filter): records, or drafts with
  // `cardPerDraft`. Used by the filter-bar's segmented control labels
  // ("Drafts (3)").
  draftsCount: number;
  publishedCount: number;
  rejectedCount: number;
  // Pending drafts in scope (one per change set), e.g. for a badge.
  pendingDrafts: number;
  // Who saved each pending draft in scope (its actor id, when known), by
  // change set, so an app can count the drafts waiting on its viewer.
  pendingAuthors: ReadonlyMap<number, string | null>;
  // Re-reads every tab, e.g. when the app hears that data changed.
  reload: () => Promise<void>;
  typeFilter: string;
  setTypeFilter: (next: string) => void;
  // Change_types narrowed to `primaryModel`. Apps that want a different
  // filter set can pull `schema.change_types` directly.
  primaryChangeTypes: ReadonlyArray<ChangeType>;
  // Resolved primary-model definition (or null until schema loads). Apps
  // that need to render a primary-cell using the model's `fields` (e.g.
  // dispatch on title vs name fieldId) read this from the controller
  // rather than re-deriving from `schema`.
  primaryModelDef: Model | null;
  // Action handlers RESOLVE to `true` when the kernel action succeeded
  // (regardless of whether the post-action reload also succeeded — a
  // reload failure narrates softer but the data DID change), and `false`
  // when the action itself failed (the toast already fired; callers
  // should NOT trigger app-specific follow-ups like data refetches).
  // Card / CardTable callsites ignore the return; app wrappers (e.g.
  // HC's ApprovalsPage) branch on it so they don't fire redundant
  // refetches on failure.
  // `note`, when non-empty, is saved on the draft first (`POST
  // /api/draft/notes`); the draft is not discarded if that fails.
  onDiscard: (change_set_id: number, note?: string) => Promise<boolean>;
  onPublish: (change_set_id: number) => Promise<boolean>;
  onRevert: (change_set_id: number) => Promise<boolean>;
};

export function useDraftReview(config: UseDraftReviewConfig): DraftReviewController {
  const {
    client,
    scope,
    schema,
    primaryModel,
    defaultChangeTypeId,
    publishedSourceKinds,
    publishedLimit,
    models,
    cardPerDraft,
  } = config;
  const loadsRejected = config.rejected === true || config.rejected === "when-any";
  const loadsDrafts = config.pending !== false;
  const [chosenTab, setTab] = useState<ReviewTab>(
    config.pending === "when-any" || !loadsDrafts ? "published" : "drafts",
  );
  const [typeFilter, setTypeFilter] = useState<string>(ALL_TYPES);
  // Toast surface is fired from inside the module so apps don't have to
  // wire pass-through callbacks for every action outcome. Pages must
  // mount a `<ToastProvider>` above the surface (App.tsx does this for
  // HC; storybook stories opt in via a decorator).
  const toast = useToast();

  const drafts = useDrafts({ client, scope, enabled: loadsDrafts });
  const rejected = useDrafts({
    client,
    scope,
    path: "/api/drafts/rejected",
    enabled: loadsRejected,
  });
  // A "when-any" tab shows while it has drafts; a hidden tab is never active.
  const draftsTab = config.pending === "when-any" ? drafts.data.length > 0 : loadsDrafts;
  const rejectedTab =
    config.rejected === "when-any" ? rejected.data.length > 0 : config.rejected === true;
  const tab: ReviewTab =
    (chosenTab === "drafts" && !draftsTab) || (chosenTab === "rejected" && !rejectedTab)
      ? "published"
      : chosenTab;
  // Loads on mount (not gated on tab) so the bar's "Published (N)" count
  // is accurate before the user clicks the tab.
  const published = usePublished({
    client,
    scope,
    sourceKinds: publishedSourceKinds,
    limit: publishedLimit,
  });

  const primaryModelDef = useMemo<Model | null>(() => {
    if (!schema) return null;
    const model = schema.models.find((m) => m.id === primaryModel) ?? null;
    if (!model) return null;
    // Tenant custom fields label their diff columns too, retired ones
    // included: a draft may predate the retirement.
    const present = new Set(model.fields.map((field) => field.id));
    const custom = (schema.custom_fields ?? []).flatMap((definition) =>
      definition.model_id === model.id && !present.has(definition.field_id)
        ? [customFieldDefinitionAsField(definition)]
        : [],
    );
    return custom.length === 0 ? model : { ...model, fields: [...model.fields, ...custom] };
  }, [schema, primaryModel]);

  const allChangeTypes = useMemo<ReadonlyArray<ChangeType>>(
    () => schema?.change_types ?? [],
    [schema],
  );

  const primaryChangeTypes = useMemo(
    () => allChangeTypes.filter((ct) => ct.target_model === primaryModel),
    [allChangeTypes, primaryModel],
  );

  // Every model with its custom fields, for per-record column labels. Scoped
  // and one-card-per-draft reviews show records of any model, so they label
  // each from its own model even when no scope is set.
  const scopeModelDefs = useMemo<ReadonlyArray<Model> | undefined>(
    () => (models === undefined && !cardPerDraft ? undefined : (schema?.models ?? [])),
    [models, cardPerDraft, schema],
  );
  const modelsKey = models === undefined ? null : JSON.stringify(models);
  const inScope = useMemo(() => {
    const ids = modelsKey === null ? null : new Set<string>(JSON.parse(modelsKey) as string[]);
    return (entries: ReadonlyArray<DraftWithDiff>) =>
      ids === null
        ? entries
        : entries.filter((entry) => entry.records.some((record) => ids.has(record.model_id)));
  }, [modelsKey]);
  const cardOptions = useMemo(
    () => ({
      primaryModel: primaryModelDef,
      changeTypes: allChangeTypes,
      defaultChangeTypeId,
      models: scopeModelDefs,
      cardPerDraft,
    }),
    [primaryModelDef, allChangeTypes, defaultChangeTypeId, scopeModelDefs, cardPerDraft],
  );

  const draftCards = useMemo(
    () => buildDraftCards({ ...cardOptions, drafts: inScope(drafts.data) }),
    [drafts.data, inScope, cardOptions],
  );
  const publishedCards = useMemo(
    () => buildPublishedCards({ ...cardOptions, entries: inScope(published.data) }),
    [published.data, inScope, cardOptions],
  );
  const rejectedCards = useMemo(
    () =>
      buildPublishedCards({ ...cardOptions, entries: inScope(rejected.data), status: "rejected" }),
    [rejected.data, inScope, cardOptions],
  );

  const cards = useMemo<ReadonlyArray<ApprovalCard>>(() => {
    const source =
      tab === "drafts" ? draftCards : tab === "published" ? publishedCards : rejectedCards;
    if (typeFilter === ALL_TYPES) return source;
    return source.filter((c) => c.change_type_id === typeFilter);
  }, [draftCards, publishedCards, rejectedCards, tab, typeFilter]);

  // Tab counts are records, or drafts when each draft is its own card.
  const count = (list: ReadonlyArray<ApprovalCard>) =>
    cardPerDraft ? list.length : list.reduce((acc, c) => acc + c.rows.length, 0);
  const draftsCount = count(draftCards);
  const publishedCount = count(publishedCards);
  const rejectedCount = count(rejectedCards);
  const pendingDrafts = new Set(draftCards.flatMap((c) => c.rows.map((r) => r.change_set_id))).size;
  const pendingAuthors = useMemo(() => {
    const pending = new Set(draftCards.flatMap((c) => c.rows.map((r) => r.change_set_id)));
    return new Map(
      inScope(drafts.data)
        .filter((entry) => pending.has(entry.draft.id))
        .map((entry) => [entry.draft.id, entry.draft.actor_id ?? null] as const),
    );
  }, [draftCards, drafts.data, inScope]);

  // Refetch both tabs after any action so counts stay accurate after
  // cross-tab mutations.
  // Both loaders run in parallel via `Promise.all`, so the cost is one
  // extra round-trip per action; the correctness win (segmented-control
  // counts stay accurate across the whole surface, not just the active
  // tab) is worth it.
  //
  // Action handlers await this and only fire the
  // success toast after the reload resolves, so a successful action
  // followed by a failed reload narrates as the softer "Action completed,
  // but failed to refresh" copy rather than a confident success over
  // stale data. The Promise rejects when at least one loader fails;
  // the action handler's catch branch surfaces the softer warning toast.
  //
  // P11 B4: `Promise.all` short-circuits on the first rejection but
  // leaves the still-pending sibling promise un-awaited from this
  // closure's perspective. If the slower loader ALSO rejects after the
  // first, its rejection has no handler attached → Node / browser
  // surfaces it as `unhandledRejection`. Switch to `allSettled` so we
  // attach a handler to BOTH promises, then synthesize a meaningful
  // error from the rejected ones so the action handler's catch branch
  // still fires the softer warning toast. The composed Error carries
  // the underlying envelope messages so a future telemetry hook can
  // surface them.
  const refetchAfterAction = useCallback(async () => {
    const settled = await Promise.allSettled([
      drafts.reload(),
      published.reload(),
      ...(loadsRejected ? [rejected.reload()] : []),
    ]);
    const failed = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed.length === 0) return;
    // Compose into one Error so the caller's `catch` sees a single
    // rejection regardless of whether one or both loaders failed. The
    // describeError consumer (toast composition) reads `.message`, so
    // joining the underlying reasons preserves diagnostic content.
    const reasons = failed.flatMap((r) => {
      const reason = describeError(r.reason);
      return reason.length > 0 ? [reason] : [];
    });
    throw new Error(
      reasons.length > 0 ? `refetch failed: ${reasons.join("; ")}` : "refetch failed",
    );
  }, [drafts, published, rejected, loadsRejected]);

  const reload = useCallback(async () => {
    await refetchAfterAction().catch(() => {});
  }, [refetchAfterAction]);

  const onRevert = useCallback(
    async (change_set_id: number): Promise<boolean> => {
      try {
        await client.postJson<{ ok: true }>("/api/revert", {
          app_id: scope.appId,
          customer_id: scope.customerId,
          change_set_id,
        });
      } catch (e) {
        toast.error(`Revert failed: ${describeError(e)}`);
        return false;
      }
      // Action landed; await the reload before firing the confident
      // success toast so the user doesn't see a green confirmation over
      // a still-rendering stale list. Reload failure narrates softer
      // but the action DID succeed — return true so callers can fire
      // their own post-action refresh.
      try {
        await refetchAfterAction();
        // No Undo: revert IS the undo for a publish; re-undoing would
        // invite a publish/revert ping-pong.
        toast.success("Reverted published change.");
      } catch {
        toast.warning("Reverted, but failed to refresh — try reloading.");
      }
      return true;
    },
    [client, scope.appId, scope.customerId, refetchAfterAction, toast],
  );

  const onDiscard = useCallback(
    async (change_set_id: number, note?: string): Promise<boolean> => {
      const notes = note?.trim() ?? "";
      try {
        // The note travels with the discard, so it is saved only if the
        // discard lands; without a note the body is as before.
        await client.postJson<{ ok: true }>(
          "/api/draft/discard",
          notes === "" ? { change_set_id } : { change_set_id, notes },
        );
      } catch (e) {
        toast.error(`Discard failed: ${describeError(e)}`);
        return false;
      }
      try {
        await refetchAfterAction();
        // No Undo: the kernel has no "restore discarded" endpoint.
        toast.success("Discarded draft.");
      } catch {
        toast.warning("Discarded, but failed to refresh — try reloading.");
      }
      return true;
    },
    [client, refetchAfterAction, toast],
  );

  const onPublish = useCallback(
    async (change_set_id: number): Promise<boolean> => {
      try {
        await client.postJson<{ ok: true }>("/api/draft/approve", {
          change_set_id,
        });
      } catch (e) {
        toast.error(`Publish failed: ${describeError(e)}`);
        return false;
      }
      try {
        await refetchAfterAction();
        // No Undo on publish: `/api/revert` is audit-only (compensating
        // change_set, not draft restoration), so calling it from an
        // "Undo" affordance would mislead the user about restorability.
        // Intentional Revert lives on published cards.
        toast.success("Published draft.");
      } catch {
        toast.warning("Published, but failed to refresh — try reloading.");
      }
      return true;
    },
    [client, refetchAfterAction, toast],
  );

  return {
    tab,
    setTab,
    drafts,
    published,
    rejected,
    draftsTab,
    rejectedTab,
    cards,
    draftsCount,
    publishedCount,
    rejectedCount,
    pendingDrafts,
    pendingAuthors,
    reload,
    typeFilter,
    setTypeFilter,
    primaryChangeTypes,
    primaryModelDef,
    onDiscard,
    onPublish,
    onRevert,
  };
}

// ---------------------------------------------------------------------------
// Surface component
// ---------------------------------------------------------------------------

export type DraftReviewSurfaceProps = {
  controller: DraftReviewController;
  // How to render the leftmost cell of a card row. The library doesn't
  // know what "primary" looks like for an app — apps supply this.
  renderPrimaryCell: RenderPrimaryCell;
  // Optional override for diff-cell rendering. Library default uses
  // `formatFieldValue` + the `relationLabel` callback below; apps pass
  // their own to inject custom display per field-id (e.g. a status pill
  // for a particular boolean).
  renderDiffCell?: RenderDiffCell;
  // Header copy for the leftmost column. Defaults to "Record".
  primaryColumnHeader?: string;
  // Resolves a relation diff value (`field_id`, `record_id`) → display
  // label. Required because the module is model-agnostic; apps thread
  // their lookups in here.
  relationLabel: RelationLabelLookup;
  // Empty-state copy. Apps customize the wording + the CTA action.
  // Defaults below describe a generic review surface.
  emptyStateDrafts?: EmptyStateProps;
  emptyStatePublished?: EmptyStateProps;
  emptyStateRejected?: EmptyStateProps;
  // App content under each card's table, e.g. the draft's comment threads.
  renderCardFooter?: RenderCardFooter;
  // Names a draft's author from its actor id on per-draft cards; without it
  // the author is not shown (never the raw id).
  authorLabel?: AuthorLabel;
  // Discard asks first in a dialog that takes an optional note for the
  // author, saved on the draft before it is discarded.
  discardNote?: boolean;
  // Cards without Publish, Discard or Revert, for a viewer who may read the
  // review but not act on it. Off by default.
  readOnly?: boolean;
  // Optional slot rendered to the right of the toolbar (between the
  // filter bar and the right edge). Pages typically put an as-of date
  // pill here.
  toolbarTrailing?: ReactNode;
  // Optional slot rendered inside the filter bar, to the right of the
  // type select. Pages use this for app-specific filters (e.g. an Author
  // dropdown).
  filterBarTrailing?: ReactNode;
};

const DEFAULT_EMPTY_DRAFTS: EmptyStateProps = {
  title: "No pending changes",
  body: "Stage edits in the editing surface to see them here for review.",
};
const DEFAULT_EMPTY_PUBLISHED: EmptyStateProps = {
  title: "No published changes",
  body: "Approve a draft to see it appear in the published history.",
};
const DEFAULT_EMPTY_REJECTED: EmptyStateProps = {
  title: "No rejected drafts",
  body: "Drafts you discard stay here, with their notes.",
};

export function DraftReviewSurface(props: DraftReviewSurfaceProps): ReactNode {
  const { controller } = props;
  const active =
    controller.tab === "drafts"
      ? controller.drafts
      : controller.tab === "published"
        ? controller.published
        : controller.rejected;
  const isLoading = active.loading && active.data.length === 0;
  const loadError = active.error;
  const emptyState =
    controller.tab === "drafts"
      ? (props.emptyStateDrafts ?? DEFAULT_EMPTY_DRAFTS)
      : controller.tab === "published"
        ? (props.emptyStatePublished ?? DEFAULT_EMPTY_PUBLISHED)
        : (props.emptyStateRejected ?? DEFAULT_EMPTY_REJECTED);

  return (
    <div data-page="draft-review" className="flex h-full flex-col">
      <div
        data-page-toolbar
        className="flex items-center justify-between gap-[var(--space-3)] border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-[var(--space-6)] py-[var(--space-3)]"
      >
        <FilterBar
          tab={controller.tab}
          onTabChange={controller.setTab}
          draftsCount={controller.draftsTab ? controller.draftsCount : null}
          publishedCount={controller.publishedCount}
          rejectedCount={controller.rejectedTab ? controller.rejectedCount : null}
          typeFilter={controller.typeFilter}
          onTypeFilterChange={controller.setTypeFilter}
          changeTypes={controller.primaryChangeTypes}
          extras={props.filterBarTrailing}
        />
        {props.toolbarTrailing ? (
          <div className="flex items-center gap-[var(--space-3)]">{props.toolbarTrailing}</div>
        ) : null}
      </div>
      <div
        className="flex-1 overflow-auto px-[var(--space-6)] py-[var(--space-4)]"
        style={{ background: "var(--color-bg-page)", minHeight: 0 }}
      >
        {isLoading ? (
          <EmptyState title="Loading…" />
        ) : loadError ? (
          <EmptyState title={`Could not load: ${describeError(loadError)}`} />
        ) : controller.cards.length === 0 ? (
          <EmptyState {...emptyState} />
        ) : (
          <div className="grid gap-[var(--space-3)]">
            {controller.cards.map((card) => (
              <CardView
                key={card.key}
                card={card}
                renderPrimaryCell={props.renderPrimaryCell}
                renderDiffCell={props.renderDiffCell}
                primaryColumnHeader={props.primaryColumnHeader}
                relationLabel={props.relationLabel}
                onDiscard={controller.onDiscard}
                onPublish={controller.onPublish}
                onRevert={controller.onRevert}
                renderFooter={props.renderCardFooter}
                authorLabel={props.authorLabel}
                discardNote={props.discardNote}
                readOnly={props.readOnly}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function describeError(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  if (typeof err === "string") return err;
  return "Unknown error";
}
