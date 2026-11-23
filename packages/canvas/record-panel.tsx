import { useEffect, useMemo, useState, type ReactNode } from "react";

import { Button, Sheet, Tag } from "@autograph/components";
import { RecordDetailPanel, type RecordDetailPanelProps } from "@autograph/compositions";
import { Spinner } from "@autograph/icons";
import {
  createLabelIndex,
  modelLabel,
  type LabelIndex,
} from "@autograph/work-session-tools/labels";
import type { FieldValue } from "@contracts";

import { failureMessage, type CanvasClient, type CanvasRecord } from "./client";
import { useCommentMode } from "./comment-mode";
import {
  creationMarkField,
  draftMark,
  draftOrigin,
  fieldValues,
  formatValue,
  gridSchema,
  moneyDefaultNote,
  moneyDefaults,
  recordTitle,
  relationKey,
  relationKeyFilter,
  relationKeyId,
  shownFields,
  titleField,
  type RelationKey,
} from "./record-values";
import { useLeavingEntries } from "./leaving";
import { replacedYours, ruleNote } from "./provenance";
import type { CanvasSession } from "./use-canvas-session";

type RecordSource = {
  client: CanvasClient;
  session: CanvasSession;
  modelId: string;
  recordId: string;
};

export type RecordPanelProps = RecordSource & {
  onClose?: () => void;
  className?: string;
};

export type RecordDrawerProps = RecordSource & {
  /** Where the drawer's top edge sits: below the host's header. */
  top?: string;
  onClose: () => void;
};

const linkId = (target: string, key: RelationKey) => `${target}:${relationKeyId(key)}`;
const noNames: ReadonlyMap<string, string> = new Map();

/**
 * The names of a record's linked records, in one batch: every distinct link
 * (by target, key type and value) is read at once, by its key. The data
 * client has no "any of these keys" filter, so a batch is one read per
 * distinct link, never one per value. A link that cannot be read stays
 * unnamed; the record still shows.
 */
async function readLinkNames(
  client: CanvasClient,
  labels: LabelIndex,
  scope: { asOf: string; work: { sessionId: string } },
  links: readonly { target: string; key: RelationKey }[],
): Promise<ReadonlyMap<string, string>> {
  const names = new Map<string, string>();
  await Promise.all(
    links.map(async (link) => {
      const target = labels.modelById(link.target);
      if (target === undefined) return;
      const [linked] = await client.data
        .list(target.id, { ...scope, where: [relationKeyFilter(link.key)], limit: 1 })
        .catch(() => []);
      if (linked !== undefined)
        names.set(linkId(link.target, link.key), recordTitle(target, linked));
    }),
  );
  return names;
}

type Loaded =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      record: CanvasRecord | null;
      /** The read's `useLeavingEntries` number. */
      read: number;
      /** Linked records' names; null while their read is still out. */
      names: ReadonlyMap<string, string> | null;
    };

/** A value still being read: a quiet bar in the design system's skeleton tokens. */
function ValueSkeleton({ long = false }: { long?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-[var(--size-skeleton-line)] max-w-full animate-pulse rounded-[var(--radius-xs)] bg-[var(--color-bg-skeleton)] align-middle ${
        long ? "w-[var(--size-skeleton-long)]" : "w-[var(--size-skeleton-short)]"
      }`}
      data-skeleton
    />
  );
}

/**
 * One record over the session on the design system's record detail panel, as
 * a read-only side panel. Values include what is staged; a staged field shows
 * what it replaced ("was …"), the agent marker when the agent staged it, and
 * a note when the record has changed since it was staged. In comment mode,
 * a field's label opens a thread on that field of the record.
 */
export function RecordPanel({ onClose, className, ...source }: RecordPanelProps) {
  const view = useRecordView(source);
  if (view === null) return null;
  return (
    <RecordDetailPanel
      {...view.detail}
      className={className}
      title={view.title}
      subtitle={view.named ? view.modelName : undefined}
      onClose={onClose}
    />
  );
}

/**
 * The record panel as a drawer flush with the right edge, below the host's
 * header: the record's name is its one heading, with the model as a small
 * line above it, and its fields follow without a card or headings of their own.
 */
export function RecordDrawer({ top, onClose, ...source }: RecordDrawerProps) {
  const view = useRecordView(source);
  // The title column's row only repeats the heading, unless it is staged
  // (it keeps what it replaced and who staged it) or comment mode is on (its
  // label opens a thread on that field).
  const namesOnly = (fieldId: string) =>
    view !== null &&
    view.named &&
    view.detail.onFieldSelect === undefined &&
    fieldId === view.titleFieldId &&
    !Object.hasOwn(view.detail.originalValues ?? {}, fieldId) &&
    !Object.hasOwn(view.detail.fieldNotes ?? {}, fieldId);
  return (
    <Sheet
      open
      eyebrow={view?.named ? view.modelName : undefined}
      placement="edge"
      title={view?.title ?? ""}
      top={top}
      onClose={() => onClose()}
    >
      {view === null ? null : (
        <RecordDetailPanel
          {...view.detail}
          embedded
          sections={view.detail.sections.map((section) => ({
            ...section,
            hideTitle: true,
            items: section.items.filter((item) => !(item.type === "field" && namesOnly(item.id))),
          }))}
          title={view.title}
        />
      )}
    </Sheet>
  );
}

type RecordView = {
  /** The record's name once it is read, else the model's. */
  title: string;
  /** Whether `title` is the record's own name. */
  named: boolean;
  modelName: string;
  /** The column the record is named by. */
  titleFieldId: string | undefined;
  detail: Omit<RecordDetailPanelProps, "title" | "subtitle" | "onClose" | "className">;
};

function useRecordView({ client, session, modelId, recordId }: RecordSource): RecordView | null {
  const definition = client.definition;
  const labels = useMemo(() => createLabelIndex(definition), [definition]);
  const model = labels.modelById(modelId);
  const fields = useMemo(
    () => gridSchema(definition).models.find((item) => item.id === modelId)?.fields ?? [],
    [definition, modelId],
  );
  const sessionId = session.session?.id ?? null;
  const asOf = session.session?.as_of ?? null;
  const revision = session.revision;
  const generation = session.generation;
  // What was read is for one record of one session; another record shows loading, not it.
  const identity = `${modelId}|${recordId}|${sessionId}`;
  const [result, setLoaded] = useState<Loaded & { identity: string }>({
    status: "loading",
    identity,
  });
  const loaded: Loaded = result.identity === identity ? result : { status: "loading" };
  const comment = useCommentMode();
  const ownEntries = useMemo(
    () =>
      session.entries.filter((entry) => entry.model_id === modelId && entry.record_id === recordId),
    [session.entries, modelId, recordId],
  );
  const left = useLeavingEntries(ownEntries);
  const [restoring, setRestoring] = useState(false);
  /** Why the last Restore yours did not happen, by field. */
  const [notRestored, setNotRestored] = useState<{ fieldId: string; message: string } | null>(null);

  useEffect(() => {
    if (model === undefined || sessionId === null || asOf === null) return;
    let live = true;
    const read = async () => {
      const readNumber = left.begin();
      const work = { sessionId };
      const [record] = await client.data.list(model.id, {
        asOf,
        work,
        where: [{ field: "id", op: "eq", value: recordId }],
        limit: 1,
      });
      if (!live) return;
      // The record shows as soon as it is read; its links' names follow. A
      // re-read keeps the names already shown meanwhile, so nothing flickers.
      setLoaded((current) => ({
        identity,
        status: "ready",
        record: record ?? null,
        read: readNumber,
        names: current.identity === identity && current.status === "ready" ? current.names : null,
      }));
      // Linked records are named by their title column, by target model, key type and value.
      const staged = session.entries.filter(
        (entry) => entry.model_id === model.id && entry.record_id === recordId,
      );
      const links = shownFields(model).flatMap((field) => {
        if (field.type !== "relation" || typeof field.target_model !== "string") return [];
        const values = [
          record?.[field.name],
          ...staged
            .filter((entry) => entry.field_id === field.id)
            .flatMap((entry) => [
              entry.value?.value,
              entry.baseline?.value,
              entry.current_value?.value,
            ]),
        ];
        return values.flatMap((value): { target: string; key: RelationKey }[] => {
          const key = relationKey(value);
          return key === null ? [] : [{ target: field.target_model as string, key }];
        });
      });
      const names = await readLinkNames(client, labels, { asOf, work }, [
        ...new Map(links.map((link) => [linkId(link.target, link.key), link])).values(),
      ]);
      if (live)
        setLoaded((current) =>
          current.identity === identity && current.status === "ready"
            ? { ...current, names }
            : current,
        );
    };
    read().catch((error: unknown) => {
      if (live)
        setLoaded({
          identity,
          status: "error",
          message: failureMessage(error, "The record could not be read."),
        });
    });
    return () => {
      live = false;
    };
    // Entries change with the revision; the revision is the re-read signal.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [client, labels, model, recordId, sessionId, asOf, revision, generation, identity]);

  if (model === undefined) return null;
  const record = loaded.status === "ready" ? loaded.record : null;
  // A field whose entry left after this read began stays staged, marked
  // updating, until a read begun after it left shows the value beneath.
  const leaving = left.leaving(loaded.status === "ready" ? loaded.read : null);
  const names = loaded.status === "ready" ? (loaded.names ?? noNames) : noNames;
  // Link fields whose names are still being read show a skeleton, not "Unknown record".
  // While the record itself is still being read, its names are pending too.
  const namesPending =
    loaded.status !== "error" && (loaded.status !== "ready" || loaded.names === null);
  const pendingLink = (fieldId: string) =>
    namesPending && fields.find((item) => item.id === fieldId)?.type === "relation";
  const format = (fieldId: string, value: FieldValue | null | undefined): string | null => {
    const field = fields.find((item) => item.id === fieldId);
    if (field === undefined || value == null) return null;
    // Read-only (derived) numbers round; editable ones keep every digit.
    const source = model?.fields.find((item) => item.id === fieldId);
    const readOnly = source !== undefined && (source.readOnly || "expression" in source);
    const text = formatValue({ ...field, readOnly }, value, (key) => {
      const typed = relationKey(key);
      return typed === null ? undefined : names.get(linkId(field.target_model ?? "", typed));
    });
    return text === "" ? null : text;
  };

  const current: Record<string, FieldValue> =
    record === null ? {} : fieldValues(labels, model, record);
  const values: Record<string, string | null> = {};
  const originalValues: Record<string, string | null> = {};
  const fieldNotes: Record<string, ReactNode> = {};
  for (const field of fields) values[field.id] = format(field.id, current[field.id]);
  // An empty money value says which currency and period it takes.
  if (record !== null) {
    const defaults = moneyDefaults(model, record, client.moneyDefaults?.[model.id]);
    for (const field of model.fields)
      if (
        field.type === "money_rate" &&
        !field.readOnly &&
        !("expression" in field) &&
        values[field.id] === null
      )
        fieldNotes[field.id] = (
          <span className="text-[var(--color-text-muted)]" data-money-default>
            {moneyDefaultNote(defaults)}
          </span>
        );
  }
  // Values from a pending draft (Show drafts on) carry the grid's quiet mark;
  // a record only a draft creates says so on its name.
  const origin = draftOrigin(model, record);
  for (const field of fields) {
    const mark = draftMark(origin, field.id, creationMarkField(model));
    if (mark !== undefined)
      fieldNotes[field.id] = (
        <>
          {fieldNotes[field.id] ?? null}
          <span key="draft" data-draft-mark title={mark.title}>
            <Tag label={mark.label} tone="gray" />
          </span>
        </>
      );
  }
  const settling = new Set(leaving.map((entry) => entry.field_id));
  for (const entry of [...ownEntries, ...leaving]) {
    // A link's "was …" waits for the names, so it never reads "was Unknown record".
    if (!pendingLink(entry.field_id))
      originalValues[entry.field_id] = format(entry.field_id, entry.baseline);
    const notes: ReactNode[] = [];
    if (settling.has(entry.field_id))
      notes.push(
        <span
          key="settling"
          className="inline-flex text-[var(--color-text-muted)]"
          role="status"
          aria-label="Updating"
          data-settling
        >
          <Spinner
            aria-hidden="true"
            className="size-[var(--size-icon-xs)] motion-safe:animate-spin"
          />
        </span>,
      );
    if (entry.source === "agent")
      notes.push(
        <span key="agent" data-agent-marker title="Changed by the agent: review before you Save">
          <Tag label="agent" tone="blue" />
        </span>,
      );
    const note = ruleNote(entry);
    if (note !== null)
      notes.push(
        <span key="rule" className="text-[var(--color-text-secondary)]" data-rule-note>
          {note}
        </span>,
      );
    if (replacedYours(entry))
      notes.push(
        <span
          key="replaced"
          className="inline-flex flex-wrap items-center gap-x-[var(--space-1)]"
          data-replaced-yours
        >
          <span className="text-[var(--color-text-secondary)]">
            Agent replaced your {format(entry.field_id, entry.replaced?.value) ?? "empty value"}
          </span>
          <Button
            disabled={restoring}
            intent="ghost"
            size="xs"
            onClick={() => {
              setRestoring(true);
              setNotRestored(null);
              void session
                .restore(entry)
                .then((outcome) => {
                  if (!outcome.ok)
                    setNotRestored({ fieldId: entry.field_id, message: outcome.message });
                })
                .finally(() => setRestoring(false));
            }}
          >
            Restore yours
          </Button>
          {notRestored?.fieldId === entry.field_id ? (
            <span className="text-[var(--color-status-danger)]" role="alert">
              Not restored. {notRestored.message}
            </span>
          ) : null}
        </span>,
      );
    if (entry.stale && !entry.gone && !pendingLink(entry.field_id))
      notes.push(
        <span key="stale" className="text-[var(--color-text-secondary)]" data-stale>
          Changed since the edit: now {format(entry.field_id, entry.current_value) ?? "empty"}
        </span>,
      );
    // The money default (an entry cleared to empty) stays beside provenance.
    if (notes.length > 0)
      fieldNotes[entry.field_id] = (
        <>
          {fieldNotes[entry.field_id] ?? null}
          {notes}
        </>
      );
  }

  const gone = loaded.status === "ready" && record === null;
  const named = loaded.status === "ready" && record !== null;
  return {
    title: named ? recordTitle(model, record) : modelLabel(model),
    named,
    modelName: modelLabel(model),
    titleFieldId: titleField(model)?.id,
    detail: {
      emptyValueLabel: "Empty",
      // While the record is read, its fields show as skeletons; then only links still being named.
      renderValue: (item) =>
        loaded.status === "loading" ? (
          <ValueSkeleton long={item.id === titleField(model)?.id} />
        ) : pendingLink(item.id) && values[item.id] !== null ? (
          <ValueSkeleton />
        ) : undefined,
      values,
      originalValues,
      fieldNotes,
      // In comment mode a field's label anchors a new thread to that field of the record.
      onFieldSelect: comment.on
        ? (fieldId) =>
            void comment.anchor({ model_id: modelId, record_id: recordId, field_id: fieldId })
        : undefined,
      sections:
        loaded.status === "error"
          ? [
              {
                id: "error",
                title: "Details",
                collapsible: false,
                items: [
                  {
                    type: "note",
                    id: "error",
                    tone: "danger",
                    title: "Could not load this record",
                    body: loaded.message,
                  },
                ],
              },
            ]
          : gone
            ? [
                {
                  id: "gone",
                  title: "Details",
                  collapsible: false,
                  items: [
                    {
                      type: "note",
                      id: "gone",
                      tone: "warning",
                      body: "This record is no longer in the app.",
                    },
                  ],
                },
              ]
            : [
                {
                  id: "details",
                  title: "Details",
                  collapsible: false,
                  items: fields.map((field) => ({
                    type: "field" as const,
                    id: field.id,
                    label: field.label,
                  })),
                },
              ],
    },
  };
}
