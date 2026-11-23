import { useEffect, useLayoutEffect, useMemo, useRef } from "react";

import { SegmentedControl } from "@autograph/components";
import {
  DraftReviewSurface,
  useDraftReview,
  type CardRow,
  type DraftReviewController,
  type DraftWithDiff,
  type RelationLabelLookup,
} from "@modules/draft-review";
import { createLabelIndex } from "@autograph/work-session-tools/labels";

import type { CanvasClient, CanvasDrafts } from "./client";
import { DraftCardThreads } from "./draft-threads";
import { useRecordNames, type RecordRef } from "./record-names";
import { gridSchema, relationKey } from "./record-values";
import { recordLabel, type RecordName } from "./thread-popover";
import type { CanvasSession } from "./use-canvas-session";

/** Work on the session's plane, or Review the workspace's saved changes. */
export type CanvasMode = "work" | "review";

/**
 * The host's transport binds the tenant; the module still sends a scope in
 * its request bodies, which the canvas host ignores.
 */
const REVIEW_SCOPE = { appId: "canvas", customerId: "canvas" };
/** Published history shows canvas Saves and approvals, other app writes, and reverts. */
const PUBLISHED_SOURCES = ["work_session", "user", "agent", "revert"];

/**
 * The review module's controller over the host's drafts transport, scoped to
 * the session's models: one card per draft (two drafts touching the same
 * cell never merge): pending drafts, the published changelog and a Rejected
 * tab. With no models on
 * the plane yet, every change is listed. Re-reads when the events stream
 * says published data changed, and on every (re)connect, which may follow a
 * gap in which changes went unheard.
 */
export function useReview(
  client: CanvasClient,
  drafts: CanvasDrafts,
  sessionId: string,
  modelIds: readonly string[],
): DraftReviewController {
  const schema = useMemo(
    // Every column a draft may change, retired ones too, labelled by header.
    () => gridSchema(client.definition, (model) => model.fields),
    [client.definition],
  );
  const controller = useDraftReview({
    client: drafts.kernel,
    scope: REVIEW_SCOPE,
    schema,
    primaryModel: modelIds[0] ?? client.definition.models[0]?.id ?? "",
    // No change types: no type filter and no type pill.
    defaultChangeTypeId: "",
    publishedSourceKinds: PUBLISHED_SOURCES,
    models: modelIds.length === 0 ? undefined : modelIds,
    cardPerDraft: true,
    // Every Save is a draft: pending and rejected drafts always have their tabs.
    pending: true,
    rejected: true,
  });
  const reload = useRef(controller.reload);
  useLayoutEffect(() => {
    reload.current = controller.reload;
  });
  useEffect(
    () =>
      client.subscribe(sessionId, {
        onRevision: () => {},
        onConnect: () => void reload.current(),
        onData: () => void reload.current(),
      }),
    [client, sessionId],
  );
  return controller;
}

/**
 * The Work/Review toggle, for every member. Review carries the count of
 * pending drafts in scope; without pending drafts to count (an app whose
 * Saves publish straight away) it has none and opens the changelog.
 */
export function ReviewSwitch({
  mode,
  pending,
  onModeChange,
}: {
  mode: CanvasMode;
  /** Pending drafts in scope; null when this app has no drafts. */
  pending: number | null;
  onModeChange: (mode: CanvasMode) => void;
}) {
  const waiting = pending ?? 0;
  return (
    <span className="flex items-center" data-review-switch>
      <SegmentedControl<CanvasMode>
        ariaLabel="Canvas mode"
        options={[
          { value: "work", label: "Work" },
          {
            value: "review",
            label: "Review",
            count: waiting,
            ariaLabel:
              waiting === 0
                ? "Review"
                : `Review, ${waiting} ${waiting === 1 ? "draft" : "drafts"} waiting`,
          },
        ]}
        size="sm"
        value={mode}
        onChange={onModeChange}
      />
    </span>
  );
}

/** The records draft rows change and the records their link values name. */
function reviewRefs(
  client: CanvasClient,
  entries: readonly (readonly DraftWithDiff[])[],
): RecordRef[] {
  const refs: RecordRef[] = [];
  for (const list of entries)
    for (const entry of list)
      for (const record of entry.records) {
        refs.push([record.model_id, { type: "record_id", value: record.record_id }]);
        const model = client.definition.models.find((item) => item.id === record.model_id);
        for (const field of record.fields) {
          const target = model?.fields.find((item) => item.id === field.field_id)?.target_model;
          if (typeof target !== "string") continue;
          for (const value of [field.before, field.after]) {
            const key = value?.type === "relation" ? relationKey(value.value) : null;
            if (key !== null) refs.push([target, key]);
          }
        }
      }
  return refs;
}

/**
 * Review mode's surface: the review module's cards, each row naming its
 * record by its title column, each card with the draft's threads and their
 * reply boxes. Every member reads it; only an approver gets Publish, Discard
 * (which asks first and takes an optional note) and Revert.
 */
export function ReviewSurface({
  client,
  drafts,
  session,
  controller,
}: {
  client: CanvasClient;
  drafts: CanvasDrafts;
  session: Pick<CanvasSession, "session" | "generation">;
  controller: DraftReviewController;
}) {
  const labels = useMemo(() => createLabelIndex(client.definition), [client.definition]);
  const recordName = useRecordNames(
    client,
    session,
    reviewRefs(client, [
      controller.drafts.data,
      controller.published.data,
      controller.rejected.data,
    ]),
    // Another person's draft is named as published, never by the reviewer's staged values.
    { overlay: false },
  );
  // A related record by name; while names load a placeholder; never its id.
  const relationLabel: RelationLabelLookup = (fieldId, key) => {
    const target = client.definition.models
      .flatMap((model) => model.fields)
      .find((field) => field.id === fieldId)?.target_model;
    return typeof target === "string"
      ? recordLabel(
          recordName,
          target,
          key.value,
          `a ${labels.modelLabel(target)} record`,
          key.type,
        )
      : "a related record";
  };
  return (
    <div className="flex min-h-[var(--space-0)] flex-1 flex-col" data-review-surface>
      <DraftReviewSurface
        authorLabel={(actorId) => drafts.authorName?.(actorId)}
        controller={controller}
        discardNote
        emptyStateDrafts={{
          title: "No drafts to review",
          body: "Drafts saved from canvas sessions show here.",
        }}
        emptyStatePublished={{
          title: "No published changes",
          body: "Published drafts show here.",
        }}
        emptyStateRejected={{
          title: "No rejected drafts",
          body: "Rejected drafts show here, with their notes.",
        }}
        readOnly={!drafts.canApprove}
        primaryColumnHeader="Record"
        relationLabel={relationLabel}
        renderCardFooter={(card) =>
          card.kind === "named" ? (
            <DraftCardThreads
              changeSetId={card.change_set_id}
              client={client}
              drafts={drafts}
              session={session}
            />
          ) : null
        }
        renderPrimaryCell={(row) => (
          <RecordCell
            modelLabel={labels.modelLabel(row.model_id)}
            recordName={recordName}
            row={row}
          />
        )}
      />
    </div>
  );
}

/** A row's record by its title column, with its model's name below. */
function RecordCell({
  row,
  modelLabel,
  recordName,
}: {
  row: CardRow;
  modelLabel: string;
  recordName: RecordName;
}) {
  const unknown = `A ${modelLabel} outside this view`;
  const byId = recordLabel(recordName, row.model_id, row.record_id, unknown);
  const name =
    byId !== unknown || !row.external_key
      ? byId
      : recordLabel(recordName, row.model_id, row.external_key, unknown, "external_key");
  return (
    <div className="flex min-w-[var(--space-0)] flex-col" data-record-cell={row.record_id}>
      <span className="truncate font-[var(--font-weight-medium)] text-[var(--color-text-primary)]">
        {name}
      </span>
      <span className="text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
        {modelLabel}
      </span>
    </div>
  );
}
