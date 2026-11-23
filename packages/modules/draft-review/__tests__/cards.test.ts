import {
  avatarInitials,
  buildDraftCards,
  columnsForCard,
  formatEffectiveDate,
  formatFieldValue,
  isMaterialDiff,
  isNamedDraft,
  pluralizeChangeTypeLabel,
} from "../helpers/cards";
import type { FieldValue } from "../../../contracts/index";

import nodeAssert from "node:assert/strict";
import { describe, it } from "vite-plus/test";

function assert(condition: unknown, message: string): asserts condition {
  nodeAssert(condition, message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  nodeAssert.equal(actual, expected, message);
}

function testDraftReviewHelpers() {
  assert(isNamedDraft("Bulk update"), "isNamedDraft: non-empty notes");
  assert(!isNamedDraft(null), "isNamedDraft: null");
  assert(!isNamedDraft(""), "isNamedDraft: empty");
  assert(!isNamedDraft("   "), "isNamedDraft: whitespace");

  assertEqual(pluralizeChangeTypeLabel("Title change"), "Title changes", "pluralize Title change");
  assertEqual(
    pluralizeChangeTypeLabel("Close records"),
    "Close records",
    "already plural unchanged",
  );

  assertEqual(avatarInitials("Software Engineer"), "SE", "avatar initials two words");
  assertEqual(avatarInitials("Designer"), "DE", "avatar initials one word");
  assertEqual(avatarInitials(""), "??", "avatar initials empty");

  const noOpRecord = {
    model_id: "record" as const,
    record_id: "r-1",
    external_key: null,
    version_id: "v-1",
    change_set_id: 1,
    stage: "draft" as const,
    effective_start: "2026-05-15",
    effective_end: null,
    before_tombstones_record: false,
    after_tombstones_record: false,
    before_untombstones_record: false,
    after_untombstones_record: false,
    fields: [],
    custom_fields: [],
  };
  assert(
    !isMaterialDiff(noOpRecord),
    "isMaterialDiff: empty + no tombstone change is not material",
  );
  assert(
    isMaterialDiff({ ...noOpRecord, after_tombstones_record: true }),
    "isMaterialDiff: tombstone change is material",
  );
  assert(
    isMaterialDiff({
      ...noOpRecord,
      fields: [
        {
          field_id: "title",
          before: null,
          after: { type: "text", value: "x" } as FieldValue,
        },
      ],
    }),
    "isMaterialDiff: field change is material",
  );
  const customChange = {
    ...noOpRecord,
    custom_fields: [
      { field_id: "cf_code", before: null, after: { type: "text" as const, value: "RD-1" } },
    ],
  };
  assert(isMaterialDiff(customChange), "isMaterialDiff: custom field change is material");
  const customColumns = columnsForCard({
    changeType: {
      id: "rename",
      label: "Rename",
      target_model: "record",
      touches: ["title"],
      required: [],
    },
    fieldsById: new Map([
      ["title", { id: "title", label: "Title", type: "text", required: true }],
      ["cf_code", { id: "cf_code", label: "Cost code", type: "text", required: false }],
    ]),
    diffs: [customChange],
  });
  assertEqual(
    customColumns.map((column) => column.label).join(","),
    "Title,Cost code",
    "columnsForCard: custom field changes follow the change type's columns",
  );

  assertEqual(formatEffectiveDate("2026-05-15"), "May 15, 2026", "formatEffectiveDate happy path");
  assertEqual(
    formatEffectiveDate("2026-01-05"),
    "Jan 5, 2026",
    "formatEffectiveDate single-digit day",
  );
  assertEqual(formatEffectiveDate("not-a-date"), "not-a-date", "formatEffectiveDate falls back");

  const labels = (fieldId: string, key: { type: string; value: string }) =>
    fieldId === "owner" && key.type === "record_id" && key.value === "u-1" ? "Ada Lovelace" : null;
  assertEqual(
    formatFieldValue({ type: "text", value: "Hi" }, "text", "title", labels),
    "Hi",
    "formatFieldValue text",
  );
  assertEqual(
    formatFieldValue({ type: "enum", value: "active" }, "enum", "status", labels, [
      { id: "active", label: "Active", aliases: ["current"] },
    ]),
    "Active",
    "formatFieldValue enum label",
  );
  assertEqual(
    formatFieldValue({ type: "enum", value: "paused" }, "enum", "status", labels, [
      { id: "active", label: "Active", aliases: [] },
    ]),
    "paused",
    "formatFieldValue falls back to unknown enum option ids",
  );
  assertEqual(
    formatFieldValue({ type: "bool", value: true }, "bool", "active", labels),
    "Yes",
    "formatFieldValue bool true",
  );
  assertEqual(
    formatFieldValue({ type: "bool", value: false }, "bool", "active", labels),
    "No",
    "formatFieldValue bool false",
  );
  assertEqual(
    formatFieldValue(
      {
        type: "money_rate",
        value: { amount: "150000.00", currency: "USD", period: "annual" },
      },
      "money_rate",
      "rate",
      labels,
    ),
    "$150K/yr",
    "formatFieldValue money_rate compact + short period",
  );
  assertEqual(
    formatFieldValue(
      {
        type: "money_rate",
        value: { amount: "75", currency: "USD", period: "hourly" },
      },
      "money_rate",
      "rate",
      labels,
    ),
    "$75/hr",
    "formatFieldValue money_rate hourly compact",
  );
  assertEqual(
    formatFieldValue({ type: "date", value: "2026-01-15" }, "date", "start_date", labels),
    "Jan 15, 2026",
    "formatFieldValue date long-form",
  );
  assertEqual(
    formatFieldValue(
      { type: "relation", value: { type: "record_id", value: "u-1" } },
      "relation",
      "owner",
      labels,
    ),
    "Ada Lovelace",
    "formatFieldValue relation resolves label",
  );
  assertEqual(
    formatFieldValue(
      { type: "relation", value: { type: "record_id", value: "unknown-id" } },
      "relation",
      "owner",
      labels,
    ),
    "unknown-id",
    "formatFieldValue relation falls back to id",
  );
  assertEqual(formatFieldValue(null, "text", "title", labels), "", "formatFieldValue null");

  const model = {
    id: "record" as const,
    kind: "entity" as const,
    label: "Record",
    fields: [
      { id: "title", label: "Title", type: "text" as const, required: true },
      { id: "level", label: "Level", type: "text" as const, required: false },
      {
        id: "rate",
        label: "Rate",
        type: "money_rate" as const,
        required: false,
      },
      {
        id: "active",
        label: "Active",
        type: "bool" as const,
        required: true,
      },
    ],
  };
  const fieldsById = new Map(model.fields.map((field) => [field.id, field]));
  const titleChangeType = {
    id: "title_change" as const,
    label: "Title change",
    target_model: "record" as const,
    touches: ["title", "level", "rate"],
    required: [],
  };
  const titleColumns = columnsForCard({
    changeType: titleChangeType,
    fieldsById,
    diffs: [],
  });
  assertEqual(titleColumns.length, 3, "change_type touches drive column count");
  assertEqual(titleColumns[0]!.field_id, "title", "column order follows touches");
  assertEqual(titleColumns[0]!.label, "Title", "column label comes from schema");

  const catchAllColumns = columnsForCard({
    changeType: {
      ...titleChangeType,
      id: "record_update" as const,
      touches: [],
    },
    fieldsById,
    diffs: [
      {
        ...noOpRecord,
        fields: [
          {
            field_id: "title",
            before: null,
            after: { type: "text", value: "x" } as FieldValue,
          },
          {
            field_id: "active",
            before: null,
            after: { type: "bool", value: true } as FieldValue,
          },
        ],
      },
    ],
  });
  assertEqual(catchAllColumns.length, 2, "empty touches uses union of diff fields");

  const closeType = {
    id: "close_records" as const,
    label: "Close records",
    target_model: "record" as const,
    touches: ["active"],
    required: [],
  };
  const rateType = {
    id: "rate_change" as const,
    label: "Rate change",
    target_model: "record" as const,
    touches: ["rate"],
    required: [],
  };
  const cards = buildDraftCards({
    drafts: [
      {
        draft: {
          id: 100,
          actor_id: "user",
          source_kind: "ui",
          source_ref: null,
          change_type_id: "close_records" as const,
          notes: "Close 2 records",
          created_at: "2026-05-15T00:00:00Z",
        },
        records: [
          {
            ...noOpRecord,
            record_id: "r-1",
            change_set_id: 100,
            fields: [
              {
                field_id: "active",
                before: { type: "bool", value: true } as FieldValue,
                after: { type: "bool", value: false } as FieldValue,
              },
            ],
          },
          {
            ...noOpRecord,
            record_id: "r-2",
            change_set_id: 100,
            fields: [
              {
                field_id: "active",
                before: { type: "bool", value: true } as FieldValue,
                after: { type: "bool", value: false } as FieldValue,
              },
            ],
          },
        ],
      },
      {
        draft: {
          id: 101,
          actor_id: "user",
          source_kind: "ui",
          source_ref: null,
          change_type_id: "rate_change" as const,
          notes: null,
          created_at: "2026-05-15T00:00:00Z",
        },
        records: [
          {
            ...noOpRecord,
            record_id: "r-3",
            change_set_id: 101,
            fields: [
              {
                field_id: "rate",
                before: null,
                after: {
                  type: "money_rate",
                  value: { amount: "200000", currency: "USD", period: "annual" },
                } as FieldValue,
              },
            ],
          },
        ],
      },
      {
        draft: {
          id: 102,
          actor_id: "user",
          source_kind: "ui",
          source_ref: null,
          change_type_id: "rate_change" as const,
          notes: "  ",
          created_at: "2026-05-15T00:00:00Z",
        },
        records: [
          {
            ...noOpRecord,
            record_id: "r-4",
            change_set_id: 102,
            fields: [
              {
                field_id: "rate",
                before: null,
                after: {
                  type: "money_rate",
                  value: { amount: "300000", currency: "USD", period: "annual" },
                } as FieldValue,
              },
            ],
          },
        ],
      },
      {
        draft: {
          id: 103,
          actor_id: "user",
          source_kind: "ui",
          source_ref: null,
          change_type_id: "rate_change" as const,
          notes: null,
          created_at: "2026-05-15T00:00:00Z",
        },
        records: [{ ...noOpRecord, record_id: "r-5", change_set_id: 103, fields: [] }],
      },
    ],
    primaryModel: model,
    changeTypes: [titleChangeType, closeType, rateType],
    defaultChangeTypeId: "record_update",
  });

  assertEqual(cards.length, 2, "buildDraftCards produces named + unnamed-by-type cards");
  const namedCard = cards.find((card) => card.kind === "named");
  const unnamedCard = cards.find((card) => card.kind === "unnamed-by-type");
  assert(namedCard !== undefined, "named card present");
  assert(unnamedCard !== undefined, "unnamed card present");
  if (namedCard && namedCard.kind === "named") {
    assertEqual(namedCard.title, "Close 2 records", "named title from notes");
    assertEqual(namedCard.change_set_id, 100, "named card carries change_set id");
    assertEqual(namedCard.rows.length, 2, "named card has both rows");
    assertEqual(namedCard.columns.length, 1, "named card columns use touches");
    assertEqual(namedCard.status, "draft", "named card defaults to draft status");
  }
  if (unnamedCard && unnamedCard.kind === "unnamed-by-type") {
    assertEqual(unnamedCard.title, "Rate changes", "unnamed title pluralized");
    assertEqual(unnamedCard.rows.length, 2, "unnamed-by-type aggregates distinct drafts");
    assertEqual(unnamedCard.changeSetCount, 2, "changeSetCount counts distinct change_sets");
    const ids = new Set(unnamedCard.rows.map((row) => row.change_set_id));
    assert(ids.has(101) && ids.has(102), "unnamed rows carry their source change_set_id");
  }
}

describe("draft review cards", () => {
  it("builds draft review card helpers", () => {
    testDraftReviewHelpers();
  });
});
