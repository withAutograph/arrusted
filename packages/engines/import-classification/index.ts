// import-classification — domain-invariant import algorithms.
//
// Engine rules: no React, no DOM, no fetch, no app vocabulary, no app policy.
// Apps supply narrow declarative policy slices and neutral row/value inputs;
// the engine returns abstract CLASSIFICATIONS and structured events with codes.
// Outputs are write-target-agnostic: consumers map classifications to their own
// artifacts (kernel previews, request submissions); the engine never emits write
// shapes.
//
// The bar is behavior-identical with the HC compiler these algorithms were
// extracted from; new behavior belongs to feature slices, never here.

import { stableHashBase36 } from "../stable-hash/index";
import { isIso3166Alpha2Code, isIso4217TenderCurrencyCode } from "../reference-data/index";
import type {
  Field,
  FieldId,
  FieldValue,
  Model,
  MoneyRatePeriod,
  ModelId,
  RecordId,
  VisibleRecord,
} from "../../contracts/index";

// ---------------------------------------------------------------------------
// Policy (THE app/substrate contract — gated; declarative only)
// ---------------------------------------------------------------------------

type LegacyImportIdentityRung =
  | { fieldId: string; kind: "uuid" | "id" | "email" | "name" }
  // Reconciliation/mapping records: identity is composite over endpoint
  // entity-references plus an optional effective time (org assignments,
  // budget-vs-actuals, benchmark-vs-current).
  | {
      kind: "reconciliation";
      endpointRefs: readonly string[];
      effectiveTimeField?: string;
    };

export type ImportIdentityRung =
  | { fieldId: string; kind: "ref" | "name" }
  | { fieldId: string; aliasFieldId: string; kind: "alias" }
  | { fieldId: string; kind: "unique"; normalization?: "case_insensitive" }
  | { fieldIds: readonly string[]; kind: "composite" };

export type ImportIdentityPolicy = {
  modelId: string;
  rungs: readonly ImportIdentityRung[];
};

export type ImportIdentityPolicyIssue = {
  path: string;
  code: string;
  message: string;
};

export type ImportIdentityPolicyCatalog = {
  models: ReadonlyMap<
    string,
    {
      fields: ReadonlyMap<
        string,
        { type: string; target_model?: string | null; is_unique?: boolean }
      >;
    }
  >;
};

/** Validates domain identity declarations against the active schema before resolution. */
export function validateImportIdentityPolicies(
  catalog: ImportIdentityPolicyCatalog,
  policies: readonly unknown[],
  requiredModelIds: Iterable<string> = catalog.models.keys(),
  pathPrefix = "identityPolicies",
): ImportIdentityPolicyIssue[] {
  const issues: ImportIdentityPolicyIssue[] = [];
  const policyCounts = new Map<string, number>();
  for (const candidate of policies) {
    if (
      candidate &&
      typeof candidate === "object" &&
      "modelId" in candidate &&
      typeof candidate.modelId === "string"
    )
      policyCounts.set(candidate.modelId, (policyCounts.get(candidate.modelId) ?? 0) + 1);
  }
  for (const modelId of requiredModelIds) {
    if (!policyCounts.has(modelId))
      issues.push(
        identityPolicyIssue(
          pathPrefix,
          "missing_identity_policy",
          `Active model \`${modelId}\` requires an import identity policy`,
        ),
      );
  }
  for (const [modelId, count] of policyCounts) {
    if (count > 1)
      issues.push(
        identityPolicyIssue(
          pathPrefix,
          "duplicate_identity_policy",
          `Identity model \`${modelId}\` is declared more than once`,
        ),
      );
  }
  for (const [policyIndex, candidate] of policies.entries()) {
    const path = `${pathPrefix}[${policyIndex}]`;
    if (!candidate || typeof candidate !== "object") {
      issues.push(
        identityPolicyIssue(path, "malformed_identity_policy", "Policy must be an object"),
      );
      continue;
    }
    const policy = candidate as Partial<ImportIdentityPolicy>;
    if (
      typeof policy.modelId !== "string" ||
      !Array.isArray(policy.rungs) ||
      policy.rungs.length === 0
    ) {
      issues.push(
        identityPolicyIssue(
          path,
          "malformed_identity_policy",
          "Policy requires modelId and at least one rung",
        ),
      );
      continue;
    }
    const model = catalog.models.get(policy.modelId);
    if (!model) {
      issues.push(
        identityPolicyIssue(
          `${path}.modelId`,
          "unknown_identity_model",
          `Identity model \`${policy.modelId}\` is not active`,
        ),
      );
      continue;
    }
    for (const [rungIndex, rawRung] of policy.rungs.entries()) {
      const rungPath = `${path}.rungs[${rungIndex}]`;
      if (!rawRung || typeof rawRung !== "object" || !("kind" in rawRung)) {
        issues.push(
          identityPolicyIssue(rungPath, "malformed_identity_rung", "Identity rung is malformed"),
        );
        continue;
      }
      if (rawRung.kind === "composite") {
        if (
          !Array.isArray(rawRung.fieldIds) ||
          rawRung.fieldIds.length < 2 ||
          new Set(rawRung.fieldIds).size !== rawRung.fieldIds.length
        ) {
          issues.push(
            identityPolicyIssue(
              rungPath,
              "malformed_identity_rung",
              "Composite identity requires at least two distinct endpoint fields",
            ),
          );
          continue;
        }
        for (const fieldId of rawRung.fieldIds) {
          const field = model.fields.get(fieldId);
          if (!field) {
            issues.push(
              identityPolicyIssue(
                `${rungPath}.fieldIds`,
                "unknown_identity_field",
                `Identity field \`${String(fieldId)}\` is not active`,
              ),
            );
          } else if (field.type === "relation" && !catalog.models.has(field.target_model ?? "")) {
            issues.push(
              identityPolicyIssue(
                `${rungPath}.fieldIds`,
                "unknown_composite_endpoint",
                `Relation endpoint for \`${String(fieldId)}\` is not active`,
              ),
            );
          }
        }
        continue;
      }
      if (
        !["ref", "unique", "name", "alias"].includes(rawRung.kind) ||
        !("fieldId" in rawRung) ||
        typeof rawRung.fieldId !== "string"
      ) {
        issues.push(
          identityPolicyIssue(
            rungPath,
            "malformed_identity_rung",
            "Scalar identity rung is malformed",
          ),
        );
        continue;
      }
      if (
        rawRung.kind === "unique" &&
        "normalization" in rawRung &&
        rawRung.normalization !== undefined &&
        rawRung.normalization !== "case_insensitive"
      ) {
        issues.push(
          identityPolicyIssue(
            `${rungPath}.normalization`,
            "unsupported_identity_normalization",
            `Identity normalization \`${String(rawRung.normalization)}\` is not supported`,
          ),
        );
        continue;
      }
      const field = model.fields.get(rawRung.fieldId);
      if (!field) {
        issues.push(
          identityPolicyIssue(
            `${rungPath}.fieldId`,
            "unknown_identity_field",
            `Identity field \`${rawRung.fieldId}\` is not active`,
          ),
        );
      } else if (field.type !== "text") {
        issues.push(
          identityPolicyIssue(
            `${rungPath}.fieldId`,
            "invalid_identity_field_type",
            `Identity field \`${rawRung.fieldId}\` must be text`,
          ),
        );
      } else if (
        rawRung.kind === "alias" &&
        (!("aliasFieldId" in rawRung) || typeof rawRung.aliasFieldId !== "string")
      ) {
        issues.push(
          identityPolicyIssue(
            `${rungPath}.aliasFieldId`,
            "missing_alias_identity_field",
            "Alias identity requires an alias field id",
          ),
        );
      } else if (rawRung.kind === "alias") {
        const aliasField = model.fields.get(rawRung.aliasFieldId);
        if (!aliasField) {
          issues.push(
            identityPolicyIssue(
              `${rungPath}.aliasFieldId`,
              "unknown_identity_field",
              `Identity alias field \`${rawRung.aliasFieldId}\` is not active`,
            ),
          );
        } else if (aliasField.type !== "known_aliases") {
          issues.push(
            identityPolicyIssue(
              `${rungPath}.aliasFieldId`,
              "invalid_alias_identity_field_type",
              `Identity alias field \`${rawRung.aliasFieldId}\` must use known_aliases`,
            ),
          );
        }
      } else if (rawRung.kind !== "name" && field.is_unique !== true) {
        issues.push(
          identityPolicyIssue(
            `${rungPath}.fieldId`,
            "identity_field_not_unique",
            `Strong identity field \`${rawRung.fieldId}\` must be declared unique`,
          ),
        );
      }
    }
  }
  return issues;
}

function identityPolicyIssue(
  path: string,
  code: string,
  message: string,
): ImportIdentityPolicyIssue {
  return { path, code, message };
}

export type ImportIdentityResolution =
  | { kind: "matched"; record: VisibleRecord; rungIndex: number }
  | { kind: "unmatched" }
  | { kind: "strong_miss"; rungIndex: number }
  | { kind: "derivation_blocked"; rungIndex: number }
  | {
      kind: "contradictory";
      rungIndex: number;
      conflictingRungIndex: number;
      records: readonly VisibleRecord[];
    }
  | { kind: "ambiguous"; records: readonly VisibleRecord[]; rungIndex: number };

export type ImportIdentityRecordIndex = {
  readonly byRung: readonly ReadonlyMap<string, readonly VisibleRecord[]>[];
};

/** Index persisted identity evidence once for repeated import resolution. */
export function createImportIdentityRecordIndex(input: {
  policy: ImportIdentityPolicy;
  existingRecords: readonly VisibleRecord[];
}): ImportIdentityRecordIndex {
  return {
    byRung: input.policy.rungs.map((rung) => {
      const recordsByToken = new Map<string, VisibleRecord[]>();
      for (const record of input.existingRecords) {
        for (const token of existingIdentityTokens(rung, record)) {
          const records = recordsByToken.get(token) ?? [];
          records.push(record);
          recordsByToken.set(token, records);
        }
      }
      return recordsByToken;
    }),
  };
}

/** Resolve authored identity values in the domain policy's declared order. */
export function resolveImportIdentity(input: {
  policy: ImportIdentityPolicy;
  authoredValues: Readonly<Record<FieldId, FieldValue>>;
  existingRecords: readonly VisibleRecord[];
  existingRecordIndex?: ImportIdentityRecordIndex;
  failedFieldIds?: ReadonlySet<FieldId>;
}): ImportIdentityResolution {
  for (const [rungIndex, rung] of input.policy.rungs.entries()) {
    const fieldIds = "fieldId" in rung ? [rung.fieldId] : rung.fieldIds;
    if (
      rung.kind !== "name" &&
      rung.kind !== "alias" &&
      fieldIds.some((fieldId) => input.failedFieldIds?.has(fieldId as FieldId))
    ) {
      return { kind: "derivation_blocked", rungIndex };
    }
    const authored = fieldIds.map((fieldId) => input.authoredValues[fieldId]);
    if (authored.some((value) => value === undefined || isBlankIdentityValue(value))) continue;

    const records = matchingIdentityRecords(input, rungIndex, rung, authored as FieldValue[]);
    if (records.length === 1) {
      const contradiction = findWeakerIdentityContradiction(
        input,
        rungIndex,
        records[0]!.record_id,
      );
      if (contradiction) return { kind: "contradictory", rungIndex, ...contradiction };
      return { kind: "matched", record: records[0]!, rungIndex };
    }
    if (records.length > 1) return { kind: "ambiguous", records, rungIndex };
    if (rung.kind !== "name" && rung.kind !== "alias") {
      const contradiction = findWeakerIdentityContradiction(input, rungIndex);
      if (contradiction) return { kind: "contradictory", rungIndex, ...contradiction };
      return { kind: "strong_miss", rungIndex };
    }
  }
  return { kind: "unmatched" };
}

function findWeakerIdentityContradiction(
  input: {
    policy: ImportIdentityPolicy;
    authoredValues: Readonly<Record<FieldId, FieldValue>>;
    existingRecords: readonly VisibleRecord[];
    existingRecordIndex?: ImportIdentityRecordIndex;
    failedFieldIds?: ReadonlySet<FieldId>;
  },
  rungIndex: number,
  matchedRecordId?: RecordId,
): { conflictingRungIndex: number; records: readonly VisibleRecord[] } | null {
  for (
    let conflictingRungIndex = rungIndex + 1;
    conflictingRungIndex < input.policy.rungs.length;
    conflictingRungIndex += 1
  ) {
    const weakerRung = input.policy.rungs[conflictingRungIndex]!;
    if (weakerRung.kind === "name" || weakerRung.kind === "alias") continue;
    const weakerFieldIds = "fieldId" in weakerRung ? [weakerRung.fieldId] : weakerRung.fieldIds;
    if (weakerFieldIds.some((fieldId) => input.failedFieldIds?.has(fieldId as FieldId))) continue;
    const weakerAuthored = weakerFieldIds.map((fieldId) => input.authoredValues[fieldId]);
    if (weakerAuthored.some((value) => value === undefined || isBlankIdentityValue(value)))
      continue;
    const conflictingRecords = matchingIdentityRecords(
      input,
      conflictingRungIndex,
      weakerRung,
      weakerAuthored as FieldValue[],
    ).filter((record) => record.record_id !== matchedRecordId);
    if (conflictingRecords.length > 0) return { conflictingRungIndex, records: conflictingRecords };
  }
  return null;
}

function matchingIdentityRecords(
  input: {
    authoredValues: Readonly<Record<FieldId, FieldValue>>;
    existingRecords: readonly VisibleRecord[];
    existingRecordIndex?: ImportIdentityRecordIndex;
  },
  rungIndex: number,
  rung: ImportIdentityRung,
  authored: readonly FieldValue[],
): readonly VisibleRecord[] {
  const token = identityToken(rung, authored);
  if (token !== null && input.existingRecordIndex) {
    return input.existingRecordIndex.byRung[rungIndex]?.get(token) ?? [];
  }
  const fieldIds = "fieldId" in rung ? [rung.fieldId] : rung.fieldIds;
  return input.existingRecords.filter((record) =>
    fieldIds.every((fieldId, index) =>
      identityValuesEqual(rung, authored[index]!, record.values[fieldId], record.values),
    ),
  );
}

function identityToken(rung: ImportIdentityRung, values: readonly FieldValue[]): string | null {
  if (values.some(isBlankIdentityValue)) return null;
  return canonicalJson(values.map((value) => normalizeImportIdentityRungValue(rung, value)));
}

function existingIdentityTokens(
  rung: ImportIdentityRung,
  record: VisibleRecord,
): readonly string[] {
  if (rung.kind === "alias") {
    const aliases = record.values[rung.aliasFieldId as FieldId];
    if (aliases?.type !== "text_list") return [];
    return [
      ...new Set(
        aliases.value.flatMap((alias) => {
          const token = identityToken(rung, [{ type: "text", value: alias }]);
          return token === null ? [] : [token];
        }),
      ),
    ];
  }
  const fieldIds = "fieldId" in rung ? [rung.fieldId] : rung.fieldIds;
  const values = fieldIds.map((fieldId) => record.values[fieldId]);
  if (values.some((value) => value === undefined)) return [];
  const token = identityToken(rung, values as FieldValue[]);
  return token === null ? [] : [token];
}

function isBlankIdentityValue(value: FieldValue): boolean {
  return value.type === "text" && value.value.trim().length === 0;
}

function identityValuesEqual(
  rung: ImportIdentityRung,
  authored: FieldValue,
  existing: FieldValue | undefined,
  existingValues: Readonly<Record<FieldId, FieldValue>>,
): boolean {
  if (rung.kind === "alias") {
    if (authored.type !== "text") return false;
    const aliases = existingValues[rung.aliasFieldId as FieldId];
    if (aliases?.type !== "text_list") return false;
    const normalized = normalizeImportReferenceValue(authored.value);
    return aliases.value.some((alias) => normalizeImportReferenceValue(alias) === normalized);
  }
  if (existing === undefined) return false;
  return (
    canonicalJson(normalizeImportIdentityRungValue(rung, authored)) ===
    canonicalJson(normalizeImportIdentityRungValue(rung, existing))
  );
}

// Declarative external-key derivation: model-prefixed key token, or the bare
// token (lookup-style models keyed by their display value alone).
export type ImportExternalKeyPolicy = { kind: "model_token" } | { kind: "bare_token" };

// Legacy Vendor import policy only. HC uses ImportIdentityPolicy above and has
// no external-key matching or write-addressing path.
export type ImportIdentityModelPolicy = {
  modelId: string;
  identity: readonly LegacyImportIdentityRung[];
};
export type ImportReconciliationModelPolicy = ImportIdentityModelPolicy & {
  externalKey: ImportExternalKeyPolicy;
};

// ---------------------------------------------------------------------------
// Canonical serialization (merge/no-op decisions)
// ---------------------------------------------------------------------------

// Sorted-key serialization at every level: fixed-shape values are the norm,
// but a variable-key value must never false-differ an identical row.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      );
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export type ImportDateFormat =
  | "mdy"
  | "dmy"
  | "mdy_two_digit_year_2000"
  | "dmy_two_digit_year_2000"
  | null;

export type ImportMoneyPolicy = {
  currency: string;
  period: MoneyRatePeriod;
} | null;

export type ImportCoercionIssueCode =
  | "invalid_number"
  | "unsupported_date_year"
  | "ambiguous_date_format"
  | "invalid_date"
  | "invalid_datetime"
  | "invalid_bool"
  | "ambiguous_lookup_value"
  | "unresolved_lookup_policy"
  | "unresolved_relation"
  | "invalid_json"
  | "unknown_enum_value"
  | "ambiguous_enum_value"
  | "invalid_iso_country"
  | "invalid_iso_currency"
  | "invalid_money_rate"
  | "missing_money_policy";

export type ImportCoercionIssue = {
  path: string;
  code: ImportCoercionIssueCode;
  raw: string;
};

export type ImportDerivedLookup = {
  targetModelId: ModelId;
  key: string;
  text: string;
};

export type ImportRelationCoercionPolicy = {
  isLookupTarget: boolean;
  lookupCreateAllowed: boolean;
  lookupMatchExternalKeys?: ReadonlyMap<string, string>;
  lookupMatchRecordIds?: ReadonlyMap<string, RecordId>;
  ambiguousLookupCandidates?: ReadonlySet<string>;
};

export type ImportModelCatalogEntry = {
  model: Pick<Model, "kind">;
  fields: ReadonlyMap<FieldId, Field>;
};

export function isLookupImportModel(model: ImportModelCatalogEntry | undefined): boolean {
  return model?.model.kind === "lookup";
}

export function importLookupCreatePolicyKey(modelId: ModelId, sourceColumn: string): string {
  return `${modelId}:${sourceColumn}`;
}

export function relationCoercionPolicyForImport(input: {
  field: Field;
  sourceColumn: string;
  models: ReadonlyMap<ModelId, ImportModelCatalogEntry>;
  lookupCreateKeys: ReadonlySet<string>;
  existingRecordsByModel?: ReadonlyMap<ModelId, readonly VisibleRecord[]>;
}): ImportRelationCoercionPolicy | undefined {
  if (input.field.type !== "relation") return undefined;
  if (!input.field.target_model) {
    return { isLookupTarget: false, lookupCreateAllowed: false };
  }
  const targetModel = input.models.get(input.field.target_model);
  const isLookupTarget = isLookupImportModel(targetModel);
  const lookupMatches =
    isLookupTarget && targetModel
      ? lookupMatchExternalKeys(
          targetModel.fields,
          input.existingRecordsByModel?.get(input.field.target_model) ?? [],
        )
      : null;
  return {
    isLookupTarget,
    lookupCreateAllowed:
      isLookupTarget &&
      input.lookupCreateKeys.has(
        importLookupCreatePolicyKey(input.field.target_model, input.sourceColumn),
      ),
    ...(isLookupTarget && targetModel
      ? {
          lookupMatchExternalKeys: lookupMatches?.matches,
          ambiguousLookupCandidates: lookupMatches?.ambiguous,
        }
      : {}),
  };
}

export function lookupMatchExternalKeys(
  fields: ReadonlyMap<FieldId, Field>,
  records: readonly VisibleRecord[],
): {
  matches: ReadonlyMap<string, string>;
  ambiguous: ReadonlySet<string>;
} {
  return lookupMatchesByAddress(fields, records, (record) => record.external_key ?? null);
}

export function lookupMatchRecordIds(
  fields: ReadonlyMap<FieldId, Field>,
  records: readonly VisibleRecord[],
): {
  matches: ReadonlyMap<string, RecordId>;
  ambiguous: ReadonlySet<string>;
} {
  return lookupMatchesByAddress(fields, records, (record) => record.record_id);
}

function lookupMatchesByAddress<T extends string>(
  fields: ReadonlyMap<FieldId, Field>,
  records: readonly VisibleRecord[],
  addressFor: (record: VisibleRecord) => T | null,
): { matches: ReadonlyMap<string, T>; ambiguous: ReadonlySet<string> } {
  const matches = new Map<string, T>();
  const ambiguous = new Set<string>();
  for (const source of ["canonical", "display", "alias"] as const) {
    const tierMatches = new Map<string, T>();
    const tierAmbiguous = new Set<string>();
    for (const record of records) {
      const address = addressFor(record);
      if (!address) continue;
      const normalizedCandidates = new Set<string>();
      for (const candidate of lookupMatchCandidates(fields, record.values, source)) {
        const normalized = normalizeImportReferenceValue(candidate);
        if (normalized.length > 0) normalizedCandidates.add(normalized);
      }
      for (const candidate of normalizedCandidates) {
        if (matches.has(candidate) || ambiguous.has(candidate) || tierAmbiguous.has(candidate)) {
          continue;
        }
        const prior = tierMatches.get(candidate);
        if (prior && prior !== address) {
          tierMatches.delete(candidate);
          tierAmbiguous.add(candidate);
          continue;
        }
        tierMatches.set(candidate, address);
      }
    }
    for (const [candidate, address] of tierMatches) matches.set(candidate, address);
    for (const candidate of tierAmbiguous) ambiguous.add(candidate);
  }
  return { matches, ambiguous };
}

type LookupMatchCandidateSource = "canonical" | "display" | "alias";

function lookupMatchCandidates(
  fields: ReadonlyMap<FieldId, Field>,
  values: Readonly<Record<FieldId, FieldValue>>,
  source: LookupMatchCandidateSource,
): string[] {
  const candidates: string[] = [];
  for (const [fieldId, field] of fields.entries()) {
    const value = values[fieldId];
    if (
      source === "canonical" &&
      field.type === "text" &&
      field.is_unique === true &&
      value?.type === "text"
    ) {
      candidates.push(value.value);
      continue;
    }
    if (
      source === "display" &&
      field.type === "text" &&
      field.required &&
      field.is_unique !== true &&
      value?.type === "text"
    ) {
      candidates.push(value.value);
      continue;
    }
    if (source === "alias" && field.type === "known_aliases" && value?.type === "text_list") {
      candidates.push(...value.value);
    }
  }
  return candidates;
}

export type ImportFieldCoercionResult = {
  value: FieldValue | null;
  issues: ImportCoercionIssue[];
  derivedLookups: ImportDerivedLookup[];
};

export function coerceImportFieldValue(input: {
  field: Field;
  raw: string;
  path: string;
  dateFormat: ImportDateFormat;
  moneyPolicy: ImportMoneyPolicy;
  relationPolicy?: ImportRelationCoercionPolicy;
}): ImportFieldCoercionResult {
  const trimmed = input.raw.trim();
  const empty: ImportFieldCoercionResult = {
    value: null,
    issues: [],
    derivedLookups: [],
  };
  // Empty cells mean "no proposed value"; required-field validation is a
  // separate row-level concern.
  if (trimmed.length === 0) return empty;

  const issue = (code: ImportCoercionIssueCode): ImportCoercionIssue => ({
    path: input.path,
    code,
    raw: trimmed,
  });

  switch (input.field.type) {
    case "text":
      return {
        value: { type: "text", value: trimmed },
        issues: [],
        derivedLookups: [],
      };
    case "iso_country": {
      const normalized = trimmed.toUpperCase();
      if (!isIso3166Alpha2Code(normalized)) {
        return {
          value: null,
          issues: [issue("invalid_iso_country")],
          derivedLookups: [],
        };
      }
      return {
        value: { type: "text", value: normalized },
        issues: [],
        derivedLookups: [],
      };
    }
    case "iso_currency": {
      const normalized = trimmed.toUpperCase();
      if (!isIso4217TenderCurrencyCode(normalized)) {
        return {
          value: null,
          issues: [issue("invalid_iso_currency")],
          derivedLookups: [],
        };
      }
      return {
        value: { type: "text", value: normalized },
        issues: [],
        derivedLookups: [],
      };
    }
    case "number":
      if (!isFiniteNumberLiteral(trimmed)) {
        return {
          value: null,
          issues: [issue("invalid_number")],
          derivedLookups: [],
        };
      }
      return {
        value: { type: "number", value: trimmed },
        issues: [],
        derivedLookups: [],
      };
    case "date": {
      const date = parseFlexibleDate(trimmed, input.dateFormat);
      if (!date) {
        return {
          value: null,
          issues: [dateCoercionIssue(input.path, trimmed, input.dateFormat)],
          derivedLookups: [],
        };
      }
      return {
        value: { type: "date", value: date },
        issues: [],
        derivedLookups: [],
      };
    }
    case "datetime":
      if (!isIsoDateTime(trimmed)) {
        return {
          value: null,
          issues: [issue("invalid_datetime")],
          derivedLookups: [],
        };
      }
      return {
        value: { type: "datetime", value: trimmed },
        issues: [],
        derivedLookups: [],
      };
    case "bool": {
      const normalized = trimmed.toLowerCase();
      if (["true", "yes", "y", "1"].includes(normalized)) {
        return {
          value: { type: "bool", value: true },
          issues: [],
          derivedLookups: [],
        };
      }
      if (["false", "no", "n", "0"].includes(normalized)) {
        return {
          value: { type: "bool", value: false },
          issues: [],
          derivedLookups: [],
        };
      }
      return {
        value: null,
        issues: [issue("invalid_bool")],
        derivedLookups: [],
      };
    }
    case "relation": {
      const targetModelId = input.field.target_model;
      if (targetModelId && input.relationPolicy?.isLookupTarget === true) {
        const normalizedLookupValue = normalizeImportReferenceValue(trimmed);
        const matchedRecordId =
          input.relationPolicy.lookupMatchRecordIds?.get(normalizedLookupValue);
        const matchedExternalKey =
          input.relationPolicy.lookupMatchExternalKeys?.get(normalizedLookupValue);
        if (input.relationPolicy.ambiguousLookupCandidates?.has(normalizedLookupValue)) {
          return {
            value: null,
            issues: [issue("ambiguous_lookup_value")],
            derivedLookups: [],
          };
        }
        if (matchedRecordId) {
          return {
            value: relationRecordId(matchedRecordId),
            issues: [],
            derivedLookups: [],
          };
        }
        if (matchedExternalKey) {
          return {
            value: relationExternal(matchedExternalKey),
            issues: [],
            derivedLookups: [],
          };
        }
        if (!input.relationPolicy.lookupCreateAllowed) {
          return {
            value: null,
            issues: [issue("unresolved_lookup_policy")],
            derivedLookups: [],
          };
        }
        const key = lookupExternalKeyForImport(targetModelId, trimmed);
        return {
          value: relationExternal(key),
          issues: [],
          derivedLookups: [{ targetModelId, key, text: trimmed }],
        };
      }
      return {
        value: null,
        issues: [issue("unresolved_relation")],
        derivedLookups: [],
      };
    }
    case "text_list":
    case "known_aliases":
      return {
        value: {
          type: "text_list",
          value: trimmed.split(/[;,]/).flatMap((item) => {
            const value = item.trim();
            return value ? [value] : [];
          }),
        },
        issues: [],
        derivedLookups: [],
      };
    case "json":
      try {
        return {
          value: { type: "json", value: JSON.parse(trimmed) },
          issues: [],
          derivedLookups: [],
        };
      } catch {
        return {
          value: null,
          issues: [issue("invalid_json")],
          derivedLookups: [],
        };
      }
    case "enum": {
      const normalizedEnumValue = normalizeEnumOptionValue(trimmed);
      let matchedOptionId: string | null = null;
      for (const option of input.field.option_set ?? []) {
        // Retired options are not valid new values; writes reject them.
        if (option.lifecycle === "retired") continue;
        const candidates = [option.id, option.label, ...(option.aliases ?? [])];
        if (
          candidates.some(
            (candidate) => normalizeEnumOptionValue(candidate) === normalizedEnumValue,
          )
        ) {
          if (matchedOptionId !== null && matchedOptionId !== option.id) {
            return {
              value: null,
              issues: [issue("ambiguous_enum_value")],
              derivedLookups: [],
            };
          }
          matchedOptionId = option.id;
        }
      }
      if (matchedOptionId !== null) {
        return {
          value: { type: "enum", value: matchedOptionId },
          issues: [],
          derivedLookups: [],
        };
      }
      return {
        value: null,
        issues: [issue("unknown_enum_value")],
        derivedLookups: [],
      };
    }
    case "money_rate": {
      const money = parseMoneyAmount(trimmed);
      if (!money) {
        return {
          value: null,
          issues: [issue("invalid_money_rate")],
          derivedLookups: [],
        };
      }
      if (!input.moneyPolicy) {
        return {
          value: null,
          issues: [issue("missing_money_policy")],
          derivedLookups: [],
        };
      }
      return {
        value: {
          type: "money_rate",
          value: {
            amount: money,
            currency: input.moneyPolicy.currency,
            period: input.moneyPolicy.period,
          },
        },
        issues: [],
        derivedLookups: [],
      };
    }
    default: {
      const _exhaustive: never = input.field.type;
      throw new Error(`Unsupported import field type: ${_exhaustive}`);
    }
  }
}

function dateCoercionIssue(
  path: string,
  raw: string,
  dateFormat: ImportDateFormat,
): ImportCoercionIssue {
  if (
    /^\d{1,2}\/\d{1,2}\/\d{2}$/.test(raw.trim()) &&
    !dateFormat?.endsWith("_two_digit_year_2000")
  ) {
    return { path, code: "unsupported_date_year", raw };
  }
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(raw.trim()) && dateFormat === null) {
    return { path, code: "ambiguous_date_format", raw };
  }
  return { path, code: "invalid_date", raw };
}

export function parseFlexibleDate(value: string, dateFormat: ImportDateFormat): string | null {
  const trimmed = value.trim();
  if (isIsoDate(trimmed)) return trimmed;
  const match = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!match) return null;
  if (dateFormat === null) return null;
  const [, firstRaw, secondRaw, yearRaw] = match;
  if (firstRaw === undefined || secondRaw === undefined || yearRaw === undefined) return null;
  const allowsTwoDigitYear = dateFormat.endsWith("_two_digit_year_2000");
  if (yearRaw.length === 2 && !allowsTwoDigitYear) return null;
  const order = dateFormat.startsWith("mdy") ? "mdy" : "dmy";
  const monthRaw = order === "mdy" ? firstRaw : secondRaw;
  const dayRaw = order === "mdy" ? secondRaw : firstRaw;
  const expandedYear = yearRaw.length === 2 ? `20${yearRaw}` : yearRaw;
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const year = Number(expandedYear);
  if (!Number.isInteger(month) || !Number.isInteger(day) || !Number.isInteger(year)) return null;
  const iso = `${expandedYear}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return isIsoDate(iso) ? iso : null;
}

function parseMoneyAmount(value: string): string | null {
  const normalized = value.trim().replace(/[$,\s]/g, "");
  if (!isFiniteNumberLiteral(normalized)) return null;
  return normalized;
}

function isFiniteNumberLiteral(value: string): boolean {
  return /^[-+]?(?:\d+|\d*\.\d+)$/.test(value) && Number.isFinite(Number(value));
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isIsoDateTime(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value))
    return false;
  if (!isIsoDate(value.slice(0, 10))) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp);
}

export function relationExternal(value: string): FieldValue {
  return { type: "relation", value: { type: "external_key", value } };
}

export function relationRecordId(value: RecordId): FieldValue {
  return { type: "relation", value: { type: "record_id", value } };
}

// ---------------------------------------------------------------------------
// Value normalization
// ---------------------------------------------------------------------------

// Whitespace-collapsed, lowercased — the normalization for name-kind
// identity values and generated-id seeds.
export function normalizeImportReferenceValue(raw: string): string {
  return trimImportWhitespace(raw)
    .replace(/[\s\u0085]+/gu, " ")
    .toLowerCase();
}

function trimImportWhitespace(raw: string): string {
  return raw.replace(/^[\s\u0085]+|[\s\u0085]+$/gu, "");
}

/** Canonical comparison value for one declared identity rung. */
export function normalizeImportIdentityRungValue(
  rung: ImportIdentityRung,
  value: FieldValue,
): FieldValue {
  if (value.type !== "text") return value;
  return {
    ...value,
    value:
      rung.kind === "name" || rung.kind === "alias"
        ? normalizeImportReferenceValue(value.value)
        : rung.kind === "unique" && rung.normalization === "case_insensitive"
          ? trimImportWhitespace(value.value).toLowerCase()
          : trimImportWhitespace(value.value),
  };
}

function normalizeEnumOptionValue(raw: string): string {
  return raw
    .trim()
    .replace(/[\s_-]+/g, " ")
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Generated identifiers (content-keyed, visibly machine-made)
// ---------------------------------------------------------------------------

// `ag-` marks generated ids; the token derives from the STABLE model id
// (never an editable label — label edits must not re-key generated ids).
// Apps usually supply tokens via policy; this fallback derivation covers
// undeclared models.
export function defaultGeneratedIdToken(modelId: string): string {
  const token = modelId
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 4)
    .toLowerCase();
  return token || "rec";
}

// ---------------------------------------------------------------------------
// Display-value selection (which field seeds a generated id)
// ---------------------------------------------------------------------------

export type ImportFieldDescriptor = {
  id: string;
  label: string;
  type: string;
  required: boolean;
};

// Generic identifier-shaped fields used by legacy Vendor policy.
export function isGeneratedIdentifierField(field: ImportFieldDescriptor): boolean {
  if (field.type !== "text") return false;
  const id = field.id.toLowerCase();
  const label = field.label.toLowerCase();
  return (
    id.endsWith("_id") ||
    label === "identifier" ||
    label.endsWith(" id") ||
    label.endsWith(" identifier")
  );
}

// ---------------------------------------------------------------------------
// Key tokens / external keys (declarative kinds)
// ---------------------------------------------------------------------------

// Normalize a raw value into a stable key token (lowercased, non-alphanumeric
// runs collapsed to underscores).
export function importKeyToken(raw: string): string {
  const token = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return token || "unknown";
}

export function lookupExternalKeyForImport(modelId: string, raw: string): string {
  const normalized = normalizeImportReferenceValue(raw);
  const token = importKeyToken(normalized);
  const hash = stableHashBase36(`${modelId}:${normalized}`).slice(0, 12).toUpperCase();
  return `${modelId}:lookup:${token}:${hash}`;
}

export function externalKeyForImport(
  modelId: string,
  raw: string,
  kind: ImportExternalKeyPolicy,
): string {
  return kind.kind === "bare_token" ? importKeyToken(raw) : `${modelId}:${importKeyToken(raw)}`;
}

export function reconciliationExternalKey(input: {
  model: ImportReconciliationModelPolicy;
  components: readonly string[];
  effectiveTime: string;
}): string {
  requireReconciliationRung(input.model);
  const subject = input.components.filter(Boolean).join(":") || "row";
  return externalKeyForImport(
    input.model.modelId,
    `${subject}:${input.effectiveTime}`,
    input.model.externalKey,
  );
}

function requireReconciliationRung(model: ImportIdentityModelPolicy): void {
  if (model.identity.some((rung) => rung.kind === "reconciliation")) return;
  throw new Error(`Import reconciliation identity is not declared for model ${model.modelId}`);
}
