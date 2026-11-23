import {
  createOpenAiStrictObjectSchema,
  type AgentRuntimeTool,
} from "../../agent-foundation/index";
import type { VisibleRecord } from "../../contracts/index";
import type { ImportIdentityPolicy } from "../../engines/import-classification/index";
export type ReferenceEvidenceCandidate = {
  id: string;
  label: string;
  refs: readonly string[];
  caseInsensitiveRefs: readonly string[];
  aliases: readonly string[];
};

export type ReferenceEvidenceResolution =
  | {
      kind: "matched";
      candidate: ReferenceEvidenceCandidate;
      matchedBy: "ref" | "label" | "alias";
    }
  | {
      kind: "unmatched";
      suggestions: readonly ReferenceEvidenceSuggestion[];
    }
  | {
      kind: "ambiguous";
      candidates: readonly ReferenceEvidenceCandidate[];
      candidateCount: number;
      truncated: boolean;
    };

export type ReferenceEvidenceSuggestion = {
  candidate: ReferenceEvidenceCandidate;
  score: number;
};

export const MAX_REFERENCE_AMBIGUOUS_CANDIDATES = 25;
export const MAX_REFERENCE_SUGGESTIONS = 3;

export type ReferenceProjectionFieldIds = {
  labelFieldId: string | null;
  aliasFieldId: string | null;
  refFieldIds: readonly string[];
  caseInsensitiveRefFieldIds: readonly string[];
};

export function referenceProjectionFieldIds(
  identityPolicy: ImportIdentityPolicy,
): ReferenceProjectionFieldIds {
  const refFieldIds: string[] = [];
  const caseInsensitiveRefFieldIds: string[] = [];
  let labelFieldId: string | null = null;
  let aliasFieldId: string | null = null;
  for (const rung of identityPolicy.rungs) {
    if (rung.kind === "name") labelFieldId ??= rung.fieldId;
    if (rung.kind === "alias") aliasFieldId ??= rung.aliasFieldId;
    if (
      rung.kind === "ref" ||
      (rung.kind === "unique" && rung.normalization !== "case_insensitive")
    ) {
      refFieldIds.push(rung.fieldId);
    }
    if (rung.kind === "unique" && rung.normalization === "case_insensitive") {
      caseInsensitiveRefFieldIds.push(rung.fieldId);
    }
  }
  return { labelFieldId, aliasFieldId, refFieldIds, caseInsensitiveRefFieldIds };
}

export function projectReferenceCandidates(
  records: readonly VisibleRecord[],
  identityPolicy: ImportIdentityPolicy,
): ReferenceEvidenceCandidate[] {
  const projection = referenceProjectionFieldIds(identityPolicy);
  const candidates: ReferenceEvidenceCandidate[] = [];
  for (const record of records) {
    const refs = textValues(record, projection.refFieldIds);
    const caseInsensitiveRefs = textValues(record, projection.caseInsensitiveRefFieldIds);
    const label =
      (projection.labelFieldId ? textValues(record, [projection.labelFieldId])[0] : undefined) ??
      refs[0] ??
      caseInsensitiveRefs[0] ??
      "";
    if (label.length === 0 && refs.length === 0 && caseInsensitiveRefs.length === 0) continue;
    candidates.push({
      id: record.record_id,
      label,
      refs,
      caseInsensitiveRefs,
      aliases: projection.aliasFieldId ? textListValues(record, projection.aliasFieldId) : [],
    });
  }
  return candidates;
}

export function resolveReferenceEvidence(
  value: string,
  candidates: readonly ReferenceEvidenceCandidate[],
): ReferenceEvidenceResolution {
  const normalized = referenceEvidenceKey(value);
  if (normalized.length === 0) return { kind: "unmatched", suggestions: [] };
  for (const matchedBy of ["ref", "caseInsensitiveRef", "label", "alias"] as const) {
    const matches = candidates.filter((candidate) =>
      evidenceValues(candidate, matchedBy).some((candidateValue) =>
        matchedBy === "ref"
          ? referenceRefKey(candidateValue) === referenceRefKey(value)
          : referenceEvidenceKey(candidateValue) === normalized,
      ),
    );
    if (matches.length === 1) {
      return {
        kind: "matched",
        candidate: matches[0]!,
        matchedBy: matchedBy === "caseInsensitiveRef" ? "ref" : matchedBy,
      };
    }
    if (matches.length > 1) {
      return {
        kind: "ambiguous",
        candidates: matches.slice(0, MAX_REFERENCE_AMBIGUOUS_CANDIDATES),
        candidateCount: matches.length,
        truncated: matches.length > MAX_REFERENCE_AMBIGUOUS_CANDIDATES,
      };
    }
  }
  const suggestions = candidates
    .flatMap((candidate) => {
      const suggestion = {
        candidate,
        score: Math.max(
          0,
          ...candidate.refs.map((candidateValue) =>
            suggestionScore(value.trim(), candidateValue.trim()),
          ),
          ...[candidate.label, ...candidate.caseInsensitiveRefs, ...candidate.aliases].map(
            (candidateValue) => suggestionScore(normalized, referenceEvidenceKey(candidateValue)),
          ),
        ),
      };
      return suggestion.score > 0 ? [suggestion] : [];
    })
    .toSorted(
      (left, right) =>
        right.score - left.score || left.candidate.label.localeCompare(right.candidate.label),
    )
    .slice(0, MAX_REFERENCE_SUGGESTIONS);
  return { kind: "unmatched", suggestions };
}

export function referenceEvidenceKey(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}

function referenceRefKey(value: string): string {
  return value.trim();
}

function suggestionScore(source: string, candidate: string): number {
  if (source.length === 0 || candidate.length === 0) return 0;
  if (source === candidate) return 1;
  const sourcePairs = adjacentPairs(source);
  const candidatePairs = adjacentPairs(candidate);
  if (sourcePairs.length === 0 || candidatePairs.length === 0) return 0;
  const remaining = new Map<string, number>();
  for (const pair of candidatePairs) remaining.set(pair, (remaining.get(pair) ?? 0) + 1);
  let overlap = 0;
  for (const pair of sourcePairs) {
    const count = remaining.get(pair) ?? 0;
    if (count === 0) continue;
    overlap += 1;
    remaining.set(pair, count - 1);
  }
  return (2 * overlap) / (sourcePairs.length + candidatePairs.length);
}

function adjacentPairs(value: string): string[] {
  return Array.from({ length: Math.max(0, value.length - 1) }, (_, index) =>
    value.slice(index, index + 2),
  );
}

function evidenceValues(
  candidate: ReferenceEvidenceCandidate,
  source: "ref" | "caseInsensitiveRef" | "label" | "alias",
): readonly string[] {
  if (source === "ref") return candidate.refs;
  if (source === "caseInsensitiveRef") return candidate.caseInsensitiveRefs;
  if (source === "label") return [candidate.label];
  return candidate.aliases;
}

function textValues(record: VisibleRecord, fieldIds: readonly string[]): string[] {
  return fieldIds.flatMap((fieldId) => {
    const value = record.values[fieldId];
    return value?.type === "text" && value.value.trim().length > 0 ? [value.value.trim()] : [];
  });
}

function textListValues(record: VisibleRecord, fieldId: string): string[] {
  const value = record.values[fieldId];
  if (value?.type !== "text_list") return [];
  return value.value.flatMap((entry) => {
    const trimmed = entry.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  });
}

export type ReferenceCandidateReader = (input: {
  modelId: string;
  values: readonly string[];
}) => Promise<readonly ReferenceEvidenceCandidate[]> | readonly ReferenceEvidenceCandidate[];

export function createReferenceLookupTool(input: {
  id: string;
  label: string;
  description: string;
  groupId: string;
  modelIds: readonly string[];
  readCandidates: ReferenceCandidateReader;
  resolveEvidence: (
    value: string,
    candidates: readonly ReferenceEvidenceCandidate[],
  ) => ReferenceEvidenceResolution;
  evidenceKey: (value: string) => string;
}): AgentRuntimeTool {
  const modelIds = [...new Set(input.modelIds)].sort();
  return {
    definition: {
      id: input.id,
      label: input.label,
      description: input.description,
      groupId: input.groupId,
      capability: "read_only",
      inputSchema: createOpenAiStrictObjectSchema({
        modelId: { type: "string" },
        values: { type: "array", items: { type: "string" }, maxItems: 100 },
      }),
      outputSchema: createOpenAiStrictObjectSchema({
        resolutions: {
          type: "array",
          items: createOpenAiStrictObjectSchema({
            value: { type: "string" },
            resolution: {
              anyOf: [
                createOpenAiStrictObjectSchema({
                  kind: { type: "string", enum: ["unmatched"] },
                  suggestions: {
                    type: "array",
                    maxItems: MAX_REFERENCE_SUGGESTIONS,
                    items: createOpenAiStrictObjectSchema({
                      candidate: createOpenAiStrictObjectSchema({
                        id: { type: "string" },
                        label: { type: "string" },
                        refs: { type: "array", items: { type: "string" } },
                        caseInsensitiveRefs: { type: "array", items: { type: "string" } },
                        aliases: { type: "array", items: { type: "string" } },
                      }),
                      score: { type: "number", minimum: 0, maximum: 1 },
                    }),
                  },
                }),
                createOpenAiStrictObjectSchema({
                  kind: { type: "string", enum: ["matched"] },
                  candidate: createOpenAiStrictObjectSchema({
                    id: { type: "string" },
                    label: { type: "string" },
                    refs: { type: "array", items: { type: "string" } },
                    caseInsensitiveRefs: { type: "array", items: { type: "string" } },
                    aliases: { type: "array", items: { type: "string" } },
                  }),
                  matchedBy: { type: "string", enum: ["ref", "label", "alias"] },
                }),
                createOpenAiStrictObjectSchema({
                  kind: { type: "string", enum: ["ambiguous"] },
                  candidates: {
                    type: "array",
                    maxItems: MAX_REFERENCE_AMBIGUOUS_CANDIDATES,
                    items: createOpenAiStrictObjectSchema({
                      id: { type: "string" },
                      label: { type: "string" },
                      refs: { type: "array", items: { type: "string" } },
                      caseInsensitiveRefs: { type: "array", items: { type: "string" } },
                      aliases: { type: "array", items: { type: "string" } },
                    }),
                  },
                  candidateCount: { type: "integer", minimum: 2 },
                  truncated: { type: "boolean" },
                }),
              ],
            },
          }),
        },
      }),
    },
    execute: async (raw) => {
      const args =
        raw != null && typeof raw === "object"
          ? (raw as { modelId?: unknown; values?: unknown })
          : {};
      const modelId = typeof args.modelId === "string" ? args.modelId : "";
      if (!modelIds.includes(modelId)) {
        throw new Error(
          `Unknown reference model \`${modelId}\`. Valid model ids: ${modelIds.join(", ")}.`,
        );
      }
      if (!Array.isArray(args.values) || !args.values.every((value) => typeof value === "string")) {
        throw new Error("Reference values must be an array of strings.");
      }
      if (args.values.length > 100) {
        throw new Error("Reference lookup accepts at most 100 values per call.");
      }
      const uniqueValues = new Map<string, string>();
      for (const value of args.values) {
        const key = input.evidenceKey(value);
        if (!uniqueValues.has(key)) uniqueValues.set(key, value);
      }
      const values = [...uniqueValues.values()];
      const candidates = [...(await input.readCandidates({ modelId, values }))];
      return {
        resolutions: values.map((value) => {
          const resolution = input.resolveEvidence(value, candidates);
          if (resolution.kind === "unmatched") {
            if (
              resolution.suggestions.length > MAX_REFERENCE_SUGGESTIONS ||
              resolution.suggestions.some(
                (suggestion) =>
                  !Number.isFinite(suggestion.score) ||
                  suggestion.score < 0 ||
                  suggestion.score > 1,
              )
            ) {
              throw new Error(
                "Reference resolver returned suggestions outside its output contract.",
              );
            }
          }
          return { value, resolution };
        }),
      };
    },
  };
}
