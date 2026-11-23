import { describe, expect, it, vi } from "vitest";

import {
  createReferenceLookupTool,
  projectReferenceCandidates,
  referenceProjectionFieldIds,
  resolveReferenceEvidence,
  type ReferenceEvidenceResolution,
} from "../index";
import type { VisibleRecord } from "../../../contracts/index";

const candidates = [
  {
    id: "dept-1",
    label: "Finance",
    refs: ["FIN"],
    caseInsensitiveRefs: [],
    aliases: ["Fin"],
  },
  {
    id: "dept-2",
    label: "People",
    refs: ["PEO"],
    caseInsensitiveRefs: [],
    aliases: ["HR"],
  },
] as const;

const resolveEvidence = vi.fn((value: string): ReferenceEvidenceResolution =>
  value.trim().toLowerCase() === "hr"
    ? { kind: "matched", matchedBy: "alias", candidate: candidates[1] }
    : { kind: "unmatched", suggestions: [] },
);
const evidenceKey = (value: string) => value.trim().toLowerCase();

describe("createReferenceLookupTool", () => {
  it("uses the injected reader and reports deterministic resolution", async () => {
    const readCandidates = vi.fn(() => candidates);
    const tool = createReferenceLookupTool({
      id: "list_lookup_values",
      label: "List lookup values",
      description: "Read reference values",
      groupId: "csv",
      modelIds: ["department"],
      readCandidates,
      resolveEvidence,
      evidenceKey,
    });

    await expect(tool.execute({ modelId: "department", values: ["HR"] })).resolves.toMatchObject({
      resolutions: [
        {
          value: "HR",
          resolution: { kind: "matched", matchedBy: "alias", candidate: { id: "dept-2" } },
        },
      ],
    });
    expect(readCandidates).toHaveBeenCalledWith({ modelId: "department", values: ["HR"] });
  });

  it("leaves normalization and duplicate handling to the injected app policy", async () => {
    const tool = createReferenceLookupTool({
      id: "list_lookup_values",
      label: "List lookup values",
      description: "Read reference values",
      groupId: "csv",
      modelIds: ["department"],
      readCandidates: () => candidates,
      resolveEvidence,
      evidenceKey,
    });

    await expect(
      tool.execute({ modelId: "department", values: [" HR ", "hr", "  HR  "] }),
    ).resolves.toMatchObject({
      resolutions: [{ value: " HR ", resolution: { kind: "matched", matchedBy: "alias" } }],
    });
  });

  it("uses the app-supplied description without inventing matching policy", () => {
    const tool = createReferenceLookupTool({
      id: "lookup_values",
      label: "Lookup values",
      description: "Resolve lookup evidence.",
      groupId: "reference_data",
      modelIds: ["department"],
      readCandidates: () => [],
      resolveEvidence,
      evidenceKey,
    });

    expect(tool.definition.description).toBe("Resolve lookup evidence.");
  });

  it("rejects unknown models before invoking the reader", async () => {
    const readCandidates = vi.fn(() => candidates);
    const tool = createReferenceLookupTool({
      id: "list_lookup_values",
      label: "List lookup values",
      description: "Read reference values",
      groupId: "csv",
      modelIds: ["department"],
      readCandidates,
      resolveEvidence,
      evidenceKey,
    });

    await expect(tool.execute({ modelId: "employee", values: [] })).rejects.toThrow(
      "Unknown reference model",
    );
    expect(readCandidates).not.toHaveBeenCalled();
  });

  it("rejects malformed tool input with a controlled validation error", async () => {
    const readCandidates = vi.fn(() => candidates);
    const tool = createReferenceLookupTool({
      id: "list_lookup_values",
      label: "List lookup values",
      description: "Read reference values",
      groupId: "csv",
      modelIds: ["department"],
      readCandidates,
      resolveEvidence,
      evidenceKey,
    });

    await expect(tool.execute(null)).rejects.toThrow("Unknown reference model");
    expect(readCandidates).not.toHaveBeenCalled();
  });
});

describe("reference projection", () => {
  it("reads label and alias field ids from identity policy, not hardcoded names", () => {
    const policy = {
      modelId: "firm",
      rungs: [
        { fieldId: "legal_name", kind: "name" as const },
        { fieldId: "legal_name", aliasFieldId: "also_known_as", kind: "alias" as const },
        { fieldId: "code", kind: "ref" as const },
      ],
    };
    expect(referenceProjectionFieldIds(policy)).toEqual({
      labelFieldId: "legal_name",
      aliasFieldId: "also_known_as",
      refFieldIds: ["code"],
      caseInsensitiveRefFieldIds: [],
    });
    const records: VisibleRecord[] = [
      {
        record_id: "firm-1",
        effective_start: "2026-01-01",
        values: {
          legal_name: { type: "text", value: "Acme" },
          also_known_as: { type: "text_list", value: ["Acme Co"] },
          code: { type: "text", value: "ACM" },
        },
        custom_fields: [],
      },
    ];
    const projected = projectReferenceCandidates(records, policy);
    expect(projected).toEqual([
      {
        id: "firm-1",
        label: "Acme",
        refs: ["ACM"],
        caseInsensitiveRefs: [],
        aliases: ["Acme Co"],
      },
    ]);
    expect(resolveReferenceEvidence("ACM", projected)).toMatchObject({
      kind: "matched",
      matchedBy: "ref",
    });
    expect(resolveReferenceEvidence("acme co", projected)).toMatchObject({
      kind: "matched",
      matchedBy: "alias",
    });
  });
});
