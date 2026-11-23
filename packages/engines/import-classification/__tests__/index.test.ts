import {
  coerceImportFieldValue,
  externalKeyForImport,
  importLookupCreatePolicyKey,
  isLookupImportModel,
  lookupExternalKeyForImport,
  normalizeImportIdentityRungValue,
  normalizeImportReferenceValue,
  reconciliationExternalKey,
  relationCoercionPolicyForImport,
  relationExternal,
  createImportIdentityRecordIndex,
  resolveImportIdentity,
  validateImportIdentityPolicies,
  type ImportDateFormat,
  type ImportReconciliationModelPolicy,
} from "../index";
import type { Field, FieldValue, VisibleRecord } from "../../../contracts/index";

import nodeAssert from "node:assert/strict";
import { describe, it } from "vite-plus/test";

function assert(condition: unknown, message: string): asserts condition {
  nodeAssert(condition, message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  nodeAssert.equal(actual, expected, message);
}

function testImportClassificationEngine(): void {
  testOrderedIdentityResolution();
  testReconciliationKeys();
  testLookupRelationPolicyHelpers();
  testFieldValueCoercion();
}

function testOrderedIdentityResolution(): void {
  const policy = {
    modelId: "employee",
    rungs: [
      { fieldId: "ref", kind: "ref" },
      { fieldId: "work_email", kind: "unique", normalization: "case_insensitive" },
      { fieldId: "name", kind: "name" },
      { fieldId: "name", aliasFieldId: "known_aliases", kind: "alias" },
    ],
  } as const;
  const records: VisibleRecord[] = [
    {
      record_id: "employee-1",
      external_key: "must-not-matter",
      effective_start: "2025-01-01",
      effective_end: null,
      custom_fields: [],
      values: {
        ref: { type: "text", value: "EMP-1" },
        work_email: { type: "text", value: "one@example.com" },
        name: { type: "text", value: "Ada Lovelace" },
        known_aliases: {
          type: "text_list",
          value: ["Countess of Lovelace", " countess   of lovelace "],
        },
      },
    },
  ];
  const existingRecordIndex = createImportIdentityRecordIndex({ policy, existingRecords: records });
  const indexedResolutionCases: Array<Record<string, FieldValue>> = [
    { name: { type: "text", value: " countess   of lovelace " } },
    { work_email: { type: "text", value: "ONE@EXAMPLE.COM" } },
    { ref: { type: "text", value: "EMP-MISSING" } },
  ];
  for (const authoredValues of indexedResolutionCases) {
    nodeAssert.deepEqual(
      resolveImportIdentity({
        policy,
        authoredValues,
        existingRecords: records,
        existingRecordIndex,
      }),
      resolveImportIdentity({ policy, authoredValues, existingRecords: records }),
      "indexed identity resolution preserves ordered rung semantics for matches and misses",
    );
  }

  assertEqual(
    resolveImportIdentity({
      policy,
      authoredValues: { name: { type: "text", value: " countess   of lovelace " } },
      existingRecords: records,
    }).kind,
    "matched",
    "a declared alias rung matches normalized authored names against known aliases",
  );
  assertEqual(
    resolveImportIdentity({
      policy,
      authoredValues: { work_email: { type: "text", value: "one@example.com" } },
      existingRecords: records,
    }).kind,
    "matched",
    "an absent ref allows the next domain-owned rung to match",
  );
  assertEqual(
    resolveImportIdentity({
      policy,
      authoredValues: { work_email: { type: "text", value: "ONE@EXAMPLE.COM" } },
      existingRecords: records,
    }).kind,
    "matched",
    "declared unique text identity matches case-insensitively",
  );
  assertEqual(
    resolveImportIdentity({
      policy,
      authoredValues: {
        ref: { type: "text", value: "EMP-NEW" },
        name: { type: "text", value: "Ada Lovelace" },
      },
      existingRecords: records,
    }).kind,
    "strong_miss",
    "an authored strong identity miss does not fall through to name",
  );
  assertEqual(
    resolveImportIdentity({
      policy,
      authoredValues: {
        ref: { type: "text", value: "EMP-NEW" },
        work_email: { type: "text", value: "one@example.com" },
      },
      existingRecords: records,
    }).kind,
    "contradictory",
    "a strong miss with weaker identity evidence for an existing record blocks as contradictory",
  );

  const twoRecordContradiction = resolveImportIdentity({
    policy,
    authoredValues: {
      ref: { type: "text", value: "EMP-1" },
      work_email: { type: "text", value: "two@example.com" },
    },
    existingRecords: [
      records[0]!,
      {
        ...records[0]!,
        record_id: "employee-2",
        values: {
          ...records[0]!.values,
          ref: { type: "text", value: "EMP-2" },
          work_email: { type: "text", value: "two@example.com" },
        },
      },
    ],
  });
  assertEqual(
    twoRecordContradiction.kind,
    "contradictory",
    "a strong match that conflicts with another record on a weaker unique rung blocks",
  );

  const caseSensitiveUniquePolicy = {
    modelId: "employee",
    rungs: [{ fieldId: "work_email", kind: "unique" }],
  } as const;
  assertEqual(
    resolveImportIdentity({
      policy: caseSensitiveUniquePolicy,
      authoredValues: { work_email: { type: "text", value: " one@example.com " } },
      existingRecords: records,
    }).kind,
    "matched",
    "an unannotated unique text rung trims without changing case",
  );
  assertEqual(
    resolveImportIdentity({
      policy: caseSensitiveUniquePolicy,
      authoredValues: { work_email: { type: "text", value: "ONE@EXAMPLE.COM" } },
      existingRecords: records,
    }).kind,
    "strong_miss",
    "an unannotated unique text rung remains case-sensitive",
  );
  assertEqual(
    resolveImportIdentity({
      policy,
      authoredValues: { ref: { type: "text", value: "must-not-matter" } },
      existingRecords: records,
    }).kind,
    "strong_miss",
    "persisted external_key is not cross-run identity evidence",
  );
  assertEqual(
    resolveImportIdentity({
      policy,
      authoredValues: { name: { type: "text", value: "  ADA   LOVELACE " } },
      existingRecords: [...records, { ...records[0]!, record_id: "employee-2" }],
    }).kind,
    "ambiguous",
    "normalized exact-name ambiguity blocks deterministically",
  );
}

function testReconciliationKeys(): void {
  const reconciliationPolicy = {
    modelId: "link_record",
    identity: [
      {
        kind: "reconciliation",
        endpointRefs: ["left_ref", "right_ref"],
        effectiveTimeField: "effective_at",
      },
    ],
    externalKey: { kind: "model_token" },
  } satisfies ImportReconciliationModelPolicy;

  assertEqual(
    reconciliationExternalKey({
      model: reconciliationPolicy,
      components: ["GEN-100", "RIGHT-9"],
      effectiveTime: "2026-01-02",
    }),
    "link_record:gen_100_right_9_2026_01_02",
    "reconciliation key preserves caller component order before tokenization",
  );
  assertEqual(
    reconciliationExternalKey({
      model: reconciliationPolicy,
      components: ["", ""],
      effectiveTime: "",
    }),
    "link_record:row",
    "reconciliation key preserves the current empty-component fallback",
  );
  assertEqual(
    externalKeyForImport("lookup_record", "  Active Status! ", {
      kind: "bare_token",
    }),
    "active_status",
    "bare-token external keys omit the model prefix",
  );
}

function testFieldValueCoercion(): void {
  const field = (type: Field["type"], extra: Partial<Field> = {}): Field => ({
    id: "value",
    label: "Value",
    type,
    required: false,
    ...extra,
  });
  const coerce = (input: {
    field: Field;
    raw: string;
    dateFormat?: ImportDateFormat;
    moneyPolicy?: { currency: string; period: "monthly" | "annual" } | null;
    relationPolicy?: {
      isLookupTarget: boolean;
      lookupCreateAllowed: boolean;
      lookupMatchExternalKeys?: ReadonlyMap<string, string>;
      ambiguousLookupCandidates?: ReadonlySet<string>;
    };
  }) =>
    coerceImportFieldValue({
      field: input.field,
      raw: input.raw,
      path: "rows[0].value",
      dateFormat: input.dateFormat ?? null,
      moneyPolicy: input.moneyPolicy ?? null,
      ...(input.relationPolicy ? { relationPolicy: input.relationPolicy } : {}),
    });

  const empty = coerce({ field: field("text"), raw: "   " });
  assertEqual(empty.value, null, "empty cells coerce to null");
  assertEqual(empty.issues.length, 0, "empty cells do not emit coercion issues");

  assertDeepEqual(
    coerce({ field: field("text"), raw: "  Plain text  " }).value,
    { type: "text", value: "Plain text" },
    "non-empty text cells trim and preserve text values",
  );

  assertDeepEqual(
    coerce({ field: field("iso_country"), raw: " us " }).value,
    { type: "text", value: "US" },
    "iso_country cells canonicalize ISO 3166-1 alpha-2 codes as text values",
  );
  assertEqual(
    coerce({ field: field("iso_country"), raw: "USA" }).issues[0]?.code,
    "invalid_iso_country",
    "iso_country cells reject non-alpha-2 country identifiers",
  );
  assertDeepEqual(
    coerce({ field: field("iso_currency"), raw: " eUr " }).value,
    { type: "text", value: "EUR" },
    "iso_currency cells canonicalize ISO 4217 tender currency codes as text values",
  );
  assertDeepEqual(
    coerce({ field: field("iso_currency"), raw: " USD " }).value,
    { type: "text", value: "USD" },
    "iso_currency cells accept ISO 4217 tender currency codes as text values",
  );
  assertEqual(
    coerce({ field: field("iso_currency"), raw: "XXX" }).issues[0]?.code,
    "invalid_iso_currency",
    "iso_currency cells reject ISO 4217 special-purpose codes",
  );

  assertDeepEqual(
    coerce({ field: field("number"), raw: "+12.50" }).value,
    { type: "number", value: "+12.50" },
    "finite number literals are preserved as text-backed numbers",
  );
  assertEqual(
    coerce({ field: field("number"), raw: "1e3" }).issues[0]?.code,
    "invalid_number",
    "non-literal finite numbers are rejected",
  );
  const enumField = field("enum", {
    option_set: [
      { id: "active", label: "Active", aliases: ["current"] },
      { id: "on_leave", label: "On Leave", aliases: ["leave"] },
      { id: "paused", label: "Paused", aliases: ["on_hold", "on-hold"] },
    ],
  });
  assertDeepEqual(
    coerce({ field: enumField, raw: " active " }).value,
    { type: "enum", value: "active" },
    "enum source values match option ids",
  );
  assertDeepEqual(
    coerce({ field: enumField, raw: "On   Leave" }).value,
    { type: "enum", value: "on_leave" },
    "enum source values match option labels with whitespace normalization",
  );
  assertDeepEqual(
    coerce({ field: enumField, raw: "CURRENT" }).value,
    { type: "enum", value: "active" },
    "enum source values match option aliases case-insensitively",
  );
  assertDeepEqual(
    coerce({ field: enumField, raw: "On Hold" }).value,
    { type: "enum", value: "paused" },
    "enum source values match token-equivalent option aliases",
  );
  assertEqual(
    coerce({ field: enumField, raw: "Sabbatical" }).issues[0]?.code,
    "unknown_enum_value",
    "unknown enum source values are rejected before preview write binding",
  );
  assertEqual(
    coerce({
      field: field("enum", {
        option_set: [
          { id: "active", label: "Active", aliases: [] },
          { id: "old", label: "Old", aliases: ["legacy"], lifecycle: "retired" },
        ],
      }),
      raw: "legacy",
    }).issues[0]?.code,
    "unknown_enum_value",
    "retired enum options are not matched",
  );
  assertEqual(
    coerce({
      field: field("enum", {
        option_set: [
          { id: "active", label: "Active", aliases: ["current"] },
          { id: "inactive", label: "Inactive", aliases: ["current"] },
        ],
      }),
      raw: "CURRENT",
    }).issues[0]?.code,
    "ambiguous_enum_value",
    "enum source values that match multiple option aliases fail closed",
  );

  assertDeepEqual(
    coerce({ field: field("date"), raw: "04/05/2026", dateFormat: "dmy" }).value,
    { type: "date", value: "2026-05-04" },
    "dmy slash-date policy maps day before month",
  );
  assertDeepEqual(
    coerce({ field: field("date"), raw: "04/05/2026", dateFormat: "mdy" }).value,
    { type: "date", value: "2026-04-05" },
    "mdy slash-date policy maps month before day",
  );
  assertEqual(
    coerce({ field: field("date"), raw: "04/05/2026" }).issues[0]?.code,
    "ambiguous_date_format",
    "slash dates require explicit format policy",
  );
  assertEqual(
    coerce({ field: field("date"), raw: "04/05/26", dateFormat: "mdy" }).issues[0]?.code,
    "unsupported_date_year",
    "two-digit slash-date years stay unsupported",
  );
  assertDeepEqual(
    coerce({
      field: field("date"),
      raw: "04/05/26",
      dateFormat: "mdy_two_digit_year_2000",
    }).value,
    { type: "date", value: "2026-04-05" },
    "explicit MDY 2000-century policy expands two-digit years",
  );
  assertDeepEqual(
    coerce({
      field: field("date"),
      raw: "04/05/26",
      dateFormat: "dmy_two_digit_year_2000",
    }).value,
    { type: "date", value: "2026-05-04" },
    "explicit DMY 2000-century policy expands two-digit years",
  );
  assertEqual(
    coerce({ field: field("date"), raw: "2026-02-30", dateFormat: "mdy" }).issues[0]?.code,
    "invalid_date",
    "out-of-range ISO dates use the generic invalid-date classification",
  );

  assertDeepEqual(
    coerce({ field: field("datetime"), raw: "2026-05-04T12:30:00Z" }).value,
    { type: "datetime", value: "2026-05-04T12:30:00Z" },
    "RFC3339 datetimes are accepted",
  );
  assertEqual(
    coerce({ field: field("datetime"), raw: "2026-05-04 12:30:00" }).issues[0]?.code,
    "invalid_datetime",
    "non-RFC3339 datetimes are rejected",
  );

  assertDeepEqual(
    ["true", "yes", "y", "1"].map((raw) => coerce({ field: field("bool"), raw }).value),
    [
      { type: "bool", value: true },
      { type: "bool", value: true },
      { type: "bool", value: true },
      { type: "bool", value: true },
    ],
    "truthy bool spellings match the HC compiler set",
  );
  assertDeepEqual(
    ["false", "no", "n", "0"].map((raw) => coerce({ field: field("bool"), raw }).value),
    [
      { type: "bool", value: false },
      { type: "bool", value: false },
      { type: "bool", value: false },
      { type: "bool", value: false },
    ],
    "falsey bool spellings match the HC compiler set",
  );
  assertEqual(
    coerce({ field: field("bool"), raw: "maybe" }).issues[0]?.code,
    "invalid_bool",
    "unknown bool spellings are rejected",
  );

  assertDeepEqual(
    coerce({ field: field("text_list"), raw: " Alpha; Beta, ,Gamma " }).value,
    { type: "text_list", value: ["Alpha", "Beta", "Gamma"] },
    "text lists split on semicolon/comma and drop empty entries",
  );
  assertDeepEqual(
    coerce({ field: field("json"), raw: '{"ok":true}' }).value,
    { type: "json", value: { ok: true } },
    "json uses JSON.parse semantics",
  );
  assertEqual(
    coerce({ field: field("json"), raw: "{bad" }).issues[0]?.code,
    "invalid_json",
    "invalid json is surfaced as a neutral issue code",
  );

  assertDeepEqual(
    coerce({
      field: field("money_rate"),
      raw: " $ 1,250.50 ",
      moneyPolicy: { currency: "USD", period: "annual" },
    }).value,
    {
      type: "money_rate",
      value: { amount: "1250.50", currency: "USD", period: "annual" },
    },
    "money strips currency, commas, and whitespace before applying policy",
  );
  assertEqual(
    coerce({ field: field("money_rate"), raw: "$1,250.50" }).issues[0]?.code,
    "missing_money_policy",
    "money values require explicit policy",
  );
  assertEqual(
    coerce({
      field: field("money_rate"),
      raw: "not-money",
      moneyPolicy: { currency: "USD", period: "annual" },
    }).issues[0]?.code,
    "invalid_money_rate",
    "invalid money literals are rejected before policy application",
  );

  const lookup = coerce({
    field: field("relation", { target_model: "lookup_record" }),
    raw: "  In Review  ",
    relationPolicy: { isLookupTarget: true, lookupCreateAllowed: true },
  });
  const lookupKey = lookupExternalKeyForImport("lookup_record", "In Review");
  assertDeepEqual(
    lookup.value,
    relationExternal(lookupKey),
    "lookup relations use collision-resistant lookup external keys",
  );
  assertDeepEqual(
    lookup.derivedLookups,
    [{ targetModelId: "lookup_record", key: lookupKey, text: "In Review" }],
    "derived lookup evidence is neutral and carries the trimmed display text",
  );
  assert(
    lookupExternalKeyForImport("lookup_record", "A&B") !==
      lookupExternalKeyForImport("lookup_record", "A B"),
    "lookup external keys do not merge punctuation-distinct names with the same token",
  );
  assertEqual(
    coerce({
      field: field("relation", { target_model: "lookup_record" }),
      raw: "In Review",
      relationPolicy: { isLookupTarget: true, lookupCreateAllowed: false },
    }).issues[0]?.code,
    "unresolved_lookup_policy",
    "lookup relations require app-supplied create policy",
  );
  assertEqual(
    coerce({
      field: field("relation", { target_model: "subject_record" }),
      raw: "SUB-100",
      relationPolicy: { isLookupTarget: false, lookupCreateAllowed: false },
    }).issues[0]?.code,
    "unresolved_relation",
    "non-lookup relation text is not coerced by the generic engine",
  );
}

function testLookupRelationPolicyHelpers(): void {
  type TestImportModel = {
    model: { kind: "entity" | "lookup" };
    fields: ReadonlyMap<string, Field>;
  };
  const lookupModel = {
    model: { kind: "lookup" as const },
    fields: new Map<string, Field>([
      [
        "code",
        {
          id: "code",
          label: "Code",
          type: "text",
          required: true,
          is_unique: true,
        },
      ],
      ["label", { id: "label", label: "Label", type: "text", required: true }],
      [
        "known_aliases",
        {
          id: "known_aliases",
          label: "Aliases",
          type: "known_aliases",
          required: false,
        },
      ],
    ]),
  };
  const standardModel = {
    model: { kind: "entity" as const },
    fields: new Map<string, Field>([
      [
        "record_id",
        {
          id: "record_id",
          label: "Record ID",
          type: "text",
          required: true,
          is_unique: true,
        },
      ],
      ["name", { id: "name", label: "Name", type: "text", required: true }],
      [
        "known_aliases",
        {
          id: "known_aliases",
          label: "Aliases",
          type: "known_aliases",
          required: false,
        },
      ],
    ]),
  };
  const nameLookupModel = {
    model: { kind: "lookup" as const },
    fields: new Map<string, Field>([
      ["name", { id: "name", label: "Name", type: "text", required: true, is_unique: true }],
      [
        "known_aliases",
        {
          id: "known_aliases",
          label: "Aliases",
          type: "known_aliases",
          required: false,
        },
      ],
    ]),
  };
  const models: ReadonlyMap<string, TestImportModel> = new Map<string, TestImportModel>([
    ["lookup_record", lookupModel],
    ["name_lookup_record", nameLookupModel],
    ["standard_record", standardModel],
  ]);

  assert(isLookupImportModel(lookupModel), "lookup helper detects schema-declared lookup kind");
  assert(
    !isLookupImportModel(standardModel),
    "lookup helper rejects entity kind even when fields look lookup-shaped",
  );
  assertEqual(
    importLookupCreatePolicyKey("lookup_record", "Status"),
    "lookup_record:Status",
    "lookup create policy key preserves model/source-column pairing",
  );

  const lookupPolicy = relationCoercionPolicyForImport({
    field: {
      id: "status",
      label: "Status",
      type: "relation",
      required: false,
      target_model: "lookup_record",
    },
    sourceColumn: "Status",
    models,
    lookupCreateKeys: new Set(["lookup_record:Status"]),
    existingRecordsByModel: new Map([
      [
        "lookup_record",
        [
          {
            record_id: "lookup-1",
            external_key: "engineering",
            effective_start: "2025-01-01",
            effective_end: null,
            custom_fields: [],
            values: {
              code: { type: "text", value: "dept_eng" },
              label: { type: "text", value: "Engineering" },
              known_aliases: {
                type: "text_list",
                value: ["Eng", " eng "],
              },
            },
          },
          {
            record_id: "lookup-2",
            external_key: "growth",
            effective_start: "2025-01-01",
            effective_end: null,
            custom_fields: [],
            values: {
              code: { type: "text", value: "growth" },
              label: { type: "text", value: "Growth" },
              known_aliases: { type: "text_list", value: ["Sales"] },
            },
          },
          {
            record_id: "lookup-3",
            external_key: "revenue",
            effective_start: "2025-01-01",
            effective_end: null,
            custom_fields: [],
            values: {
              code: { type: "text", value: "revenue" },
              label: { type: "text", value: "Revenue" },
              known_aliases: { type: "text_list", value: ["sales"] },
            },
          },
        ],
      ],
    ]),
  });
  assert(lookupPolicy, "lookup relation policy is defined for lookup relation");
  assertEqual(lookupPolicy.isLookupTarget, true, "lookup relation policy marks lookup targets");
  assertEqual(
    lookupPolicy.lookupCreateAllowed,
    true,
    "lookup relation policy allows configured lookup creates",
  );
  assertEqual(
    lookupPolicy.lookupMatchExternalKeys?.get("dept_eng"),
    "engineering",
    "unique text fields are canonical lookup match candidates",
  );
  assertEqual(
    lookupPolicy.lookupMatchExternalKeys?.get("engineering"),
    "engineering",
    "required non-unique text fields are display lookup match candidates",
  );
  assertEqual(
    lookupPolicy.lookupMatchExternalKeys?.get("eng"),
    "engineering",
    "known_aliases values are normalized, case-folded, and deduped as lookup match candidates",
  );
  assertEqual(
    lookupPolicy.lookupMatchExternalKeys?.has("sales"),
    false,
    "ambiguous normalized aliases are not auto-matched",
  );
  assert(
    lookupPolicy.ambiguousLookupCandidates?.has("sales"),
    "ambiguous normalized aliases are retained as blocked candidates",
  );
  const normalizedNameCollisionPolicy = relationCoercionPolicyForImport({
    field: {
      id: "status",
      label: "Status",
      type: "relation",
      required: false,
      target_model: "name_lookup_record",
    },
    sourceColumn: "Status",
    models,
    lookupCreateKeys: new Set(["name_lookup_record:Status"]),
    existingRecordsByModel: new Map([
      [
        "name_lookup_record",
        [
          {
            record_id: "lookup-raw-1",
            external_key: "raw-sales",
            effective_start: "2025-01-01",
            effective_end: null,
            custom_fields: [],
            values: {
              name: { type: "text", value: "Sales" },
            },
          },
          {
            record_id: "lookup-raw-2",
            external_key: "raw-spaced-sales",
            effective_start: "2025-01-01",
            effective_end: null,
            custom_fields: [],
            values: {
              name: { type: "text", value: " sales " },
            },
          },
        ],
      ],
    ]),
  });
  assert(
    normalizedNameCollisionPolicy?.ambiguousLookupCandidates?.has("sales"),
    "raw-distinct lookup names that normalize together are ambiguous, not silently matched",
  );
  assertEqual(
    coerceImportFieldValue({
      field: {
        id: "status",
        label: "Status",
        type: "relation",
        required: false,
        target_model: "name_lookup_record",
      },
      raw: " Sales ",
      path: "rows[0].Status",
      dateFormat: null,
      moneyPolicy: null,
      relationPolicy: normalizedNameCollisionPolicy,
    }).issues[0]?.code,
    "ambiguous_lookup_value",
    "raw-distinct normalized lookup name collisions block instead of picking a row",
  );
  const canonicalPrecedenceRecords: VisibleRecord[] = [
    {
      record_id: "lookup-1",
      external_key: "active",
      effective_start: "2025-01-01",
      effective_end: null,
      custom_fields: [],
      values: {
        code: { type: "text", value: "active" },
        label: { type: "text", value: "Active" },
      },
    },
    {
      record_id: "lookup-2",
      external_key: "inactive",
      effective_start: "2025-01-01",
      effective_end: null,
      custom_fields: [],
      values: {
        code: { type: "text", value: "inactive" },
        label: { type: "text", value: "Inactive" },
        known_aliases: { type: "text_list", value: ["Active"] },
      },
    },
  ];
  const canonicalPrecedencePolicy = relationCoercionPolicyForImport({
    field: {
      id: "status",
      label: "Status",
      type: "relation",
      required: false,
      target_model: "lookup_record",
    },
    sourceColumn: "Status",
    models,
    lookupCreateKeys: new Set(),
    existingRecordsByModel: new Map([["lookup_record", canonicalPrecedenceRecords]]),
  });
  assert(canonicalPrecedencePolicy, "canonical precedence relation policy is defined");
  assertEqual(
    canonicalPrecedencePolicy.lookupMatchExternalKeys?.get("active"),
    "active",
    "canonical schema key matches win over lower-precedence aliases",
  );
  assertEqual(
    canonicalPrecedencePolicy.ambiguousLookupCandidates?.has("active"),
    false,
    "lower-precedence alias collisions do not block canonical key matches",
  );
  assertDeepEqual(
    coerceImportFieldValue({
      field: {
        id: "status",
        label: "Status",
        type: "relation",
        required: false,
        target_model: "lookup_record",
      },
      raw: " active ",
      path: "rows[0].Status",
      dateFormat: null,
      moneyPolicy: null,
      relationPolicy: canonicalPrecedencePolicy,
    }).value,
    relationExternal("active"),
    "lookup relation coercion resolves canonical schema key matches before aliases",
  );
  assertDeepEqual(
    coerceImportFieldValue({
      field: {
        id: "status",
        label: "Status",
        type: "relation",
        required: false,
        target_model: "lookup_record",
      },
      raw: " ENG ",
      path: "rows[0].Status",
      dateFormat: null,
      moneyPolicy: null,
      relationPolicy: lookupPolicy,
    }).value,
    relationExternal("engineering"),
    "lookup relation coercion resolves explicit alias matches before creating new lookup rows",
  );
  assertEqual(
    coerceImportFieldValue({
      field: {
        id: "status",
        label: "Status",
        type: "relation",
        required: false,
        target_model: "lookup_record",
      },
      raw: " Sales ",
      path: "rows[0].Status",
      dateFormat: null,
      moneyPolicy: null,
      relationPolicy: lookupPolicy,
    }).issues[0]?.code,
    "ambiguous_lookup_value",
    "ambiguous alias matches block instead of creating a new lookup row",
  );
  assertDeepEqual(
    relationCoercionPolicyForImport({
      field: {
        id: "owner",
        label: "Owner",
        type: "relation",
        required: false,
        target_model: "standard_record",
      },
      sourceColumn: "Owner",
      models,
      lookupCreateKeys: new Set(["standard_record:Owner"]),
    }),
    { isLookupTarget: false, lookupCreateAllowed: false },
    "standard relation policy does not become lookup-create allowed",
  );
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`);
  }
}

describe("import classification engine", () => {
  it("uses one Unicode whitespace contract for candidate and compiler identity", () => {
    nodeAssert.equal(
      normalizeImportReferenceValue("\ufeff\u0085 Acme\u00a0\u202fCorp \u3000\ufeff"),
      "acme corp",
    );
    nodeAssert.deepEqual(
      normalizeImportIdentityRungValue(
        { fieldId: "email", kind: "unique", normalization: "case_insensitive" },
        { type: "text", value: "\u0085 USER@example.com \u3000" },
      ),
      { type: "text", value: "user@example.com" },
    );
  });

  it("classifies and coerces import rows", () => {
    testImportClassificationEngine();
  });

  it("rejects unsupported unique-identity normalization", () => {
    const issues = validateImportIdentityPolicies(
      {
        models: new Map([
          [
            "employee",
            {
              fields: new Map([["work_email", { type: "text", is_unique: true }]]),
            },
          ],
        ]),
      },
      [
        {
          modelId: "employee",
          rungs: [{ fieldId: "work_email", kind: "unique", normalization: "lowercase" }],
        },
      ],
    );

    nodeAssert.deepEqual(issues, [
      {
        path: "identityPolicies[0].rungs[0].normalization",
        code: "unsupported_identity_normalization",
        message: "Identity normalization `lowercase` is not supported",
      },
    ]);
  });

  it("rejects duplicate fields in a composite identity rung", () => {
    const issues = validateImportIdentityPolicies(
      {
        models: new Map([
          [
            "assignment",
            {
              fields: new Map([["employee", { type: "relation", target_model: "employee" }]]),
            },
          ],
          ["employee", { fields: new Map() }],
        ]),
      },
      [
        {
          modelId: "assignment",
          rungs: [{ kind: "composite", fieldIds: ["employee", "employee"] }],
        },
      ],
      ["assignment"],
    );

    nodeAssert.deepEqual(issues, [
      {
        path: "identityPolicies[0].rungs[0]",
        code: "malformed_identity_rung",
        message: "Composite identity requires at least two distinct endpoint fields",
      },
    ]);
  });

  it("requires alias identity rungs to reference a known_aliases field", () => {
    const issues = validateImportIdentityPolicies(
      {
        models: new Map([
          [
            "employee",
            {
              fields: new Map([
                ["name", { type: "text" }],
                ["aliases", { type: "text_list" }],
              ]),
            },
          ],
        ]),
      },
      [
        {
          modelId: "employee",
          rungs: [{ fieldId: "name", aliasFieldId: "aliases", kind: "alias" }],
        },
      ],
    );

    nodeAssert.deepEqual(issues, [
      {
        path: "identityPolicies[0].rungs[0].aliasFieldId",
        code: "invalid_alias_identity_field_type",
        message: "Identity alias field `aliases` must use known_aliases",
      },
    ]);
  });
});
