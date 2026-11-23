// Draft-review module — pure helpers (grouping + diff stringification).
//
// Layer rules:
//   - Lives under `packages/modules/draft-review/`. Imports `@contracts`
//     type-only.
//   - No app-narrowed identifiers (no `position`, no `department`, no
//     `person` in names or string literals here). App-specific dispatch
//     for relation labels is delegated to the `relationLabel` callback
//     supplied to value-formatting helpers.
//
// Concept map (USER COPY, not substrate):
//   draft     — change_set with status=draft (USER WORD: "Draft")
//   published — change_set with status=mainline (USER WORD: "Published")
//
// Grouping (same shape both tabs):
//   Named bulks      = drafts WHERE notes is non-empty → one card per change_set,
//                      header-level Discard / Publish actions.
//   Unnamed by type  = drafts WHERE notes is null/empty → group by change_type_id
//                      into ONE card per type. Each row inside is its own
//                      change_set, so per-row actions.
//
// Columns are driven by the change_type's `touches` set (NOT the per-record
// fields[] in the diff) so every row of a named bulk renders the same column
// set even if some rows didn't touch every column. Rows that don't touch a
// column show a muted em-dash.

// Relative import (not `@engines/format`): the `mise run test:app`
// runner uses Bun without a tsconfig path resolver, so the alias fails to
// load at module-eval time.
import { formatField, formatIsoDateLong } from "../../../engines/format/index";
import type {
  ChangeType,
  ChangeTypeId,
  DraftSummary,
  Field,
  FieldDiff,
  FieldType,
  FieldValue,
  Model,
  ModelId,
  RecordDiff,
  RecordId,
  RecordKey,
} from "@contracts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

// Subset of `DraftSummary` the card builders actually read. Mirrored as
// an `Omit<DraftSummary, "schema_revision_id">` because the published
// loader (`usePublished`) synthesizes this shape from a
// `RecentActivityEntry`, which the kernel does NOT issue with a
// `schema_revision_id` field — and the wire contract states 0 is never
// a valid value (kernel uses positive ids for real revisions). Keeping
// the field on `DraftWithDiff.draft` would have forced `usePublished`
// to stamp a fake `0`, which leaked a wire-contract violation into a
// shape that's structurally typed downstream. Now both real drafts
// (consume DraftSummary directly) and synthesized published entries
// (which never had a revision id) satisfy the shape honestly.
//
// P11 P4: see the helper file's CHANGELOG / FR-A flow.
export type DraftWithDiff = {
  // `entry_notes`: rule notes a working-session Save carried, keyed
  // `model:record:field`.
  draft: Omit<DraftSummary, "schema_revision_id"> & {
    entry_notes?: Readonly<Record<string, string>> | null;
  };
  records: ReadonlyArray<RecordDiff>;
};

// One row in a card.
export type CardRow = {
  // The model the record belongs to, so an app can name records of any model.
  model_id: ModelId;
  record_id: RecordId;
  // The record's external key, so an app can name a record it has not loaded
  // (e.g. one this draft creates) without showing its id.
  external_key?: string | null;
  effective_start: string;
  // The change_set id that owns THIS row. For named-bulk cards every row
  // shares the same id (the bulk's id); for unnamed type-group cards each
  // row has its own (one row = one whole change_set).
  change_set_id: number;
  // Map field_id → diff. Cells whose field_id isn't in the map render "—".
  diffByField: ReadonlyMap<string, FieldDiff>;
  // Map field_id → the rule note the value was staged with ("By rule: …").
  ruleNotes?: ReadonlyMap<string, string>;
};

// One card. `kind="named"` cards have a single `change_set_id`; the actions
// at the header act on the whole bulk. `kind="unnamed-by-type"` cards
// aggregate multiple change_sets of the same change_type — actions live in
// the per-row strip and target each row's `change_set_id`.
export type ApprovalCard =
  | {
      kind: "named";
      key: string;
      change_set_id: number;
      change_type_id: ChangeTypeId;
      // Schema-declared label for `change_type_id`, resolved at card-build
      // time so the named-bulk header pill renders the canonical label
      // rather than a snake_case-prettified fallback.
      change_type_label: string;
      title: string; // notes
      // Status drives the actions: drafts get Discard/Publish; published get
      // Revert; rejected (discarded) drafts are read-only.
      status: CardStatus;
      columns: ReadonlyArray<ColumnSpec>;
      rows: ReadonlyArray<CardRow>;
      // Per-draft cards (`cardPerDraft`) also carry who saved the draft,
      // when, and its note (on a rejected draft, the rejection note).
      author_id?: string | null;
      created_at?: string;
      note?: string | null;
    }
  | {
      kind: "unnamed-by-type";
      key: string;
      change_type_id: ChangeTypeId;
      title: string; // change_type.label, pluralized
      status: CardStatus;
      columns: ReadonlyArray<ColumnSpec>;
      rows: ReadonlyArray<CardRow>;
      // Number of distinct change_sets aggregated into this card. Useful
      // for the meta line ("2 records · 2 separate drafts").
      changeSetCount: number;
    };

export type CardStatus = "draft" | "published" | "rejected";

export type ColumnSpec = {
  field_id: string;
  // Pulled from `field.label` in the schema — NEVER snake_case.
  label: string;
  // The field's declared type — drives value formatting on both sides of
  // the diff.
  type: FieldType;
  option_set?: Field["option_set"];
};

// App-supplied resolver from a relation's (field_id, target record_id) to
// a display label. Returns null/undefined when the label hasn't loaded yet;
// the caller falls back to the raw record id.
//
// Why a callback instead of a typed lookup: the module deliberately does
// not name app-domain relations (e.g. `department`, `person`). The app
// captures whatever lookup tables it has in closure and dispatches on
// `field_id` itself.
// Receives the stored key with its type, so an external key is never read as
// a record id (or the reverse).
export type RelationLabelLookup = (
  fieldId: string,
  key: Extract<RecordKey, { type: "record_id" | "external_key" }>,
) => string | null | undefined;

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

// Whether a draft's notes counts as "named". Empty / whitespace-only notes
// fall back to the unnamed-by-type bucket.
export function isNamedDraft(notes: string | null | undefined): boolean {
  return typeof notes === "string" && notes.trim().length > 0;
}

// Drop records that have no actual field changes (and no tombstone changes).
// Seeded data and round-trip no-ops can produce these.
export function isMaterialDiff(record: RecordDiff): boolean {
  if (record.fields.length > 0 || (record.custom_fields ?? []).length > 0) return true;
  if (
    record.before_tombstones_record !== record.after_tombstones_record ||
    record.before_untombstones_record !== record.after_untombstones_record
  ) {
    return true;
  }
  return false;
}

// Build the column spec list for a change_type — these are the columns the
// CARD displays, regardless of what any individual row touches. Falls back
// to the union of touched fields across the diff if `change_type.touches`
// is empty (catch-all types).
export function columnsForCard(args: {
  changeType: ChangeType | null;
  fieldsById: ReadonlyMap<string, Field>;
  diffs: ReadonlyArray<RecordDiff>;
}): ColumnSpec[] {
  const { changeType, fieldsById, diffs } = args;
  const ids = new Set<string>();
  if (changeType && changeType.touches.length > 0) {
    for (const f of changeType.touches) ids.add(f);
  } else {
    for (const r of diffs) {
      for (const f of r.fields) ids.add(f.field_id);
    }
  }
  // Tenant custom fields are never in a change type's touches; show every
  // one the diffs change, after the declared columns.
  for (const r of diffs) {
    for (const f of r.custom_fields ?? []) ids.add(f.field_id);
  }
  const columns: ColumnSpec[] = [];
  for (const id of ids) {
    const field = fieldsById.get(id);
    columns.push({
      field_id: id,
      // Schema lookup wins over the raw id — "no snake_case in user copy".
      label: field ? field.label : id,
      type: field ? field.type : "text",
      option_set: field?.option_set,
    });
  }
  return columns;
}

// Build the card list from the loaded drafts + their diffs.
//
// Order:
//   - Named bulks first, sorted by change_set id desc (newest first).
//   - Then unnamed type-group cards, sorted by change_type label asc.
//
// Each card's rows are sorted by record_id for stable paint.
export function buildDraftCards(args: {
  drafts: ReadonlyArray<DraftWithDiff>;
  primaryModel: Model | null;
  changeTypes: ReadonlyArray<ChangeType>;
  // Default change_type to attribute drafts to when the wire's
  // `change_type_id` is null. Apps thread their catch-all type id here;
  // module doesn't pick.
  defaultChangeTypeId: ChangeTypeId;
  // Every model a draft may touch. When given, each record's columns are
  // labelled from its own model (drafts spanning several models), and
  // per-draft card titles name the models.
  models?: ReadonlyArray<Model>;
  // One card per draft, never grouped by change type, carrying its author,
  // time and note. Two drafts touching the same cell stay apart.
  cardPerDraft?: boolean;
}): ApprovalCard[] {
  const { drafts, primaryModel, changeTypes, defaultChangeTypeId, models } = args;
  const fieldMap = (diffs: ReadonlyArray<RecordDiff>) => buildFieldMap(primaryModel, models, diffs);
  const changeTypeById = new Map<string, ChangeType>();
  for (const ct of changeTypes) changeTypeById.set(ct.id, ct);

  const named: ApprovalCard[] = [];
  const unnamedByType = new Map<string, DraftWithDiff[]>();

  for (const entry of drafts) {
    const draftId = entry.draft.id;
    const records = entry.records.filter(isMaterialDiff);
    if (records.length === 0) continue;
    const ctId = entry.draft.change_type_id ?? defaultChangeTypeId;
    if (args.cardPerDraft) {
      const ct = changeTypeById.get(ctId) ?? null;
      named.push({
        kind: "named",
        key: `draft:${draftId}`,
        change_set_id: draftId,
        change_type_id: ctId,
        // No pill for a change type the schema does not declare.
        change_type_label: ct ? ct.label : "",
        title: modelsTitle(records, models),
        status: "draft",
        columns: columnsForCard({ changeType: ct, fieldsById: fieldMap(records), diffs: records }),
        rows: records
          .map((r) => buildCardRow(r, draftId, entry.draft.entry_notes))
          .sort(compareRows),
        author_id: entry.draft.actor_id ?? null,
        created_at: entry.draft.created_at,
        note: isNamedDraft(entry.draft.notes) ? (entry.draft.notes ?? "").trim() : null,
      });
    } else if (isNamedDraft(entry.draft.notes)) {
      const ct = changeTypeById.get(ctId) ?? null;
      named.push({
        kind: "named",
        key: `named:${draftId}`,
        change_set_id: draftId,
        change_type_id: ctId,
        change_type_label: ct ? ct.label : ctId,
        title: (entry.draft.notes ?? "").trim(),
        status: "draft",
        columns: columnsForCard({ changeType: ct, fieldsById: fieldMap(records), diffs: records }),
        rows: records
          .map((r) => buildCardRow(r, draftId, entry.draft.entry_notes))
          .sort((a, b) => a.record_id.localeCompare(b.record_id)),
      });
    } else {
      const bucket = unnamedByType.get(ctId);
      if (bucket) {
        bucket.push(entry);
      } else {
        unnamedByType.set(ctId, [entry]);
      }
    }
  }

  named.sort((a, b) =>
    a.kind === "named" && b.kind === "named" ? b.change_set_id - a.change_set_id : 0,
  );

  const unnamed: ApprovalCard[] = [];
  for (const [ctId, entries] of unnamedByType.entries()) {
    const ct = changeTypeById.get(ctId) ?? null;
    const allRecords: RecordDiff[] = [];
    for (const e of entries) {
      for (const r of e.records.filter(isMaterialDiff)) allRecords.push(r);
    }
    if (allRecords.length === 0) continue;
    const rows: CardRow[] = [];
    for (const e of entries) {
      for (const r of e.records.filter(isMaterialDiff)) {
        rows.push(buildCardRow(r, e.draft.id, e.draft.entry_notes));
      }
    }
    unnamed.push({
      kind: "unnamed-by-type",
      key: `unnamed:${ctId}`,
      change_type_id: ctId,
      title: pluralizeChangeTypeLabel(ct ? ct.label : ctId),
      status: "draft",
      columns: columnsForCard({
        changeType: ct,
        fieldsById: fieldMap(allRecords),
        diffs: allRecords,
      }),
      rows: rows.sort((a, b) => a.record_id.localeCompare(b.record_id)),
      changeSetCount: entries.length,
    });
  }
  unnamed.sort((a, b) => a.title.localeCompare(b.title));

  return [...named, ...unnamed];
}

// Build the card list for the Published tab. Same shape as drafts; relabels
// status="published" so the renderer swaps actions (Revert) and pill color.
export function buildPublishedCards(args: {
  entries: ReadonlyArray<DraftWithDiff>;
  primaryModel: Model | null;
  changeTypes: ReadonlyArray<ChangeType>;
  defaultChangeTypeId: ChangeTypeId;
  models?: ReadonlyArray<Model>;
  cardPerDraft?: boolean;
  // Defaults to "published"; the Rejected tab passes "rejected".
  status?: Exclude<CardStatus, "draft">;
}): ApprovalCard[] {
  const { entries, status = "published", ...rest } = args;
  const cards = buildDraftCards({ ...rest, drafts: entries });
  return cards.map((c) => ({ ...c, status }));
}

function buildCardRow(
  record: RecordDiff,
  change_set_id: number,
  entryNotes?: Readonly<Record<string, string>> | null,
): CardRow {
  const m = new Map<string, FieldDiff>();
  for (const f of record.fields) m.set(f.field_id, f);
  // Custom-field diffs share the declared diff shape; one map serves both.
  for (const f of record.custom_fields ?? []) m.set(f.field_id, f as FieldDiff);
  const ruleNotes = new Map<string, string>();
  for (const fieldId of m.keys()) {
    const note = entryNotes?.[`${record.model_id}:${record.record_id}:${fieldId}`];
    if (typeof note === "string" && note.trim() !== "") ruleNotes.set(fieldId, note.trim());
  }
  return {
    model_id: record.model_id,
    record_id: record.record_id,
    external_key: record.external_key ?? null,
    effective_start: record.effective_start,
    change_set_id,
    diffByField: m,
    ...(ruleNotes.size > 0 ? { ruleNotes } : {}),
  };
}

// Field labels for a card: the primary model's, or (when the app passes
// every model) the fields of each model the card's records belong to.
function buildFieldMap(
  model: Model | null,
  models: ReadonlyArray<Model> | undefined,
  diffs: ReadonlyArray<RecordDiff>,
): ReadonlyMap<string, Field> {
  const m = new Map<string, Field>();
  // With every model given, labels come from each record's own model only.
  if (model && !models) {
    for (const f of model.fields) m.set(f.id, f);
  }
  if (models) {
    for (const id of new Set(diffs.map((r) => r.model_id))) {
      for (const f of models.find((item) => item.id === id)?.fields ?? []) {
        if (!m.has(f.id)) m.set(f.id, f);
      }
    }
  }
  return m;
}

// A per-draft card's title: the labels of the models it changes.
function modelsTitle(
  records: ReadonlyArray<RecordDiff>,
  models: ReadonlyArray<Model> | undefined,
): string {
  const labels = [...new Set(records.map((r) => r.model_id))].map(
    (id) => models?.find((item) => item.id === id)?.label ?? "Records",
  );
  return [...new Set(labels)].join(", ");
}

const compareRows = (a: CardRow, b: CardRow) =>
  a.model_id.localeCompare(b.model_id) || a.record_id.localeCompare(b.record_id);

// Hyper-naive pluralization: append 's' if not already plural. Good enough
// for the labels apps typically have ("Title change" → "Title changes";
// already-plural labels untouched).
export function pluralizeChangeTypeLabel(label: string): string {
  if (label.endsWith("s")) return label;
  return `${label}s`;
}

// ---------------------------------------------------------------------------
// Value formatting (diff-cell stringification)
// ---------------------------------------------------------------------------

export function formatFieldValue(
  value: FieldValue | null | undefined,
  type: FieldType,
  fieldId: string,
  relationLabel: RelationLabelLookup,
  optionSet?: Field["option_set"],
): string {
  if (value?.type === "relation_list") {
    return value.value
      .map((key) => {
        if (key.type === "lookup_or_create") return key.value.label;
        return relationLabel(fieldId, key) ?? key.value;
      })
      .join(", ");
  }
  if (value?.type === "schema_lifecycle") {
    return value.value === "active" ? "Active" : "Retired";
  }
  return formatField(
    value,
    { id: fieldId, label: fieldId, type, option_set: optionSet },
    {
      relationLabel: (key) =>
        key.type === "lookup_or_create" ? key.value.label : relationLabel(fieldId, key),
    },
  );
}

// ---------------------------------------------------------------------------
// Effective-date formatting — long form (May 15, 2026) to match cards/grid.
// ---------------------------------------------------------------------------

export function formatEffectiveDate(iso: string): string {
  return formatIsoDateLong(iso);
}

// ---------------------------------------------------------------------------
// Avatar initials — generic 2-character initial from a label string. Used
// by `renderPrimaryCell` implementations that surface an avatar block.
// ---------------------------------------------------------------------------

export function avatarInitials(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "??";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}
