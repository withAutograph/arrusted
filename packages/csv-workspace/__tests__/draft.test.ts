import { describe, expect, it } from "vitest";
import {
  amendWorkspaceDraft,
  buildWorkspaceWrites,
  parseWorkspaceProposal,
  validateWorkspaceDraft,
  type WorkspaceDraft,
  type WorkspaceRow,
} from "../draft";
import { createWorkspaceIdentity, validateWorkspaceIdentity } from "../identity";
const current: WorkspaceDraft = {
  revision: 3,
  rows: [
    {
      rowId: "r",
      modelId: "item",
      recordId: "id",
      operation: "create",
      effectiveStart: "2026-01-01",
      values: {
        name: { type: "text", value: "Human correction" },
        ref: { type: "text", value: "42" },
      },
      clearFields: [],
    },
  ],
};
const identityInput = {
  policies: [{ modelId: "item", rungs: [{ kind: "unique" as const, fieldId: "ref" }] }],
  catalog: {
    models: new Map([["item", { fields: new Map([["ref", { type: "text", is_unique: true }]]) }]]),
  },
  recordsByModel: new Map(),
};
describe("workspace typed draft", () => {
  it("refines current human edits without replacing unmentioned values or IDs", () => {
    const next = amendWorkspaceDraft(current, {
      additions: [],
      amendments: [
        { rowId: "r", values: { note: { type: "text", value: "New" } }, clearFields: ["ref"] },
      ],
    });
    expect(next.rows[0]?.values.name).toEqual(current.rows[0]?.values.name);
    expect(next.rows[0]?.recordId).toBe("id");
    expect(buildWorkspaceWrites(next)[0]).toMatchObject({
      new_record_id: "id",
      clear_fields: ["ref"],
      effective_start: "2026-01-01",
    });
    expect(current.rows[0]?.values.ref).toBeDefined();
  });
  it("rejects repeated record/date writes and set/clear conflicts", () => {
    expect(() =>
      amendWorkspaceDraft(current, {
        amendments: [],
        additions: [{ ...current.rows[0]!, rowId: "other" }],
      }),
    ).toThrow("Repeated record/date");
    expect(() =>
      amendWorkspaceDraft(current, {
        additions: [],
        amendments: [
          { rowId: "r", values: { name: { type: "text", value: "x" } }, clearFields: ["name"] },
        ],
      }),
    ).toThrow("set and clear");
  });
  it("rejects multiple effective dates for one record in a draft", () => {
    expect(() =>
      amendWorkspaceDraft(current, {
        amendments: [],
        additions: [{ ...current.rows[0]!, rowId: "other", effectiveStart: "2026-02-01" }],
      }),
    ).toThrow("Multiple effective dates for one record are not supported");
  });
  it("returns canonical atomic dry-run issues without changing the draft", async () => {
    let called = false;
    const issues = await validateWorkspaceDraft(current, {
      dryRun: async () => {
        called = true;
        return [{ code: "required", message: "Canonical create requirement" }];
      },
    });
    expect(issues[0]?.code).toBe("required");
    expect(called).toBe(true);
    expect(current.revision).toBe(3);
  });
  it("rejects cancellation even if host dry-run completes", async () => {
    const cancel = new AbortController();
    await expect(
      validateWorkspaceDraft(
        current,
        {
          dryRun: async () => {
            cancel.abort();
            return [];
          },
        },
        cancel.signal,
      ),
    ).rejects.toThrow();
  });
  it("indexes human-edited staged creates and reuses new identity allocations", () => {
    let sequence = 0;
    const identity = createWorkspaceIdentity(
      identityInput,
      current,
      () => `allocated-${sequence++}`,
    );
    expect(
      identity.resolve("item", { ref: { type: "text", value: "42" } }, "2026-01-01"),
    ).toMatchObject({ rowId: "r", recordId: "id", operation: "create", currentValues: null });
    const first = identity.resolve("item", { ref: { type: "text", value: "new" } }, "2026-01-01");
    const again = identity.resolve("item", { ref: { type: "text", value: "new" } }, "2026-01-01");
    expect(again).toMatchObject({
      ...first,
      currentValues: null,
    });
    expect(() =>
      identity.assertAuthorized({ ...current.rows[0]!, recordId: "invented" }),
    ).toThrow();
  });
  it("excludes requested rows without mutating the previous draft", () => {
    expect(
      amendWorkspaceDraft(current, { additions: [], amendments: [], removeRowIds: ["r"] }).rows,
    ).toEqual([]);
    expect(current.rows).toHaveLength(1);
  });
});

it.each([
  [
    { additions: [], amendments: [], kind: "secret value" },
    "proposal",
    '"kind"',
    "additions, amendments, removeRowIds",
  ],
  [
    { additions: [{ ...current.rows[0], kind: "secret value" }], amendments: [] },
    "proposal.additions[0]",
    '"kind"',
    "rowId, modelId, recordId, operation, effectiveStart, values, clearFields",
  ],
  [
    {
      additions: [],
      amendments: [{ rowId: "r", values: {}, clearFields: [], kind: "secret value" }],
    },
    "proposal.amendments[0]",
    '"kind"',
    "rowId, values, clearFields",
  ],
  [
    {
      additions: [],
      amendments: [
        {
          rowId: "r",
          values: { name: { type: "text", value: "secret value", extra: "secret value" } },
          clearFields: [],
        },
      ],
    },
    'proposal.amendments[0].values["name"]',
    '"extra"',
    "type, value",
  ],
])(
  "identifies unknown keys at the precise proposal boundary without values",
  (proposal, path, key, allowed) => {
    let message = "";
    try {
      parseWorkspaceProposal(proposal);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(`at ${path}: ${key}. Allowed keys: ${allowed}`);
    expect(message).not.toContain("secret value");
  },
);

it("bounds unknown-key diagnostics", () => {
  expect(() =>
    parseWorkspaceProposal({ additions: [], amendments: [], ["x".repeat(10000)]: "private" }),
  ).toThrow(`"${"x".repeat(80)}…"`);
});

it("distinguishes repeated amendments from missing original draft rows", () => {
  const amendment = { rowId: "r", values: {}, clearFields: [] };
  expect(() =>
    amendWorkspaceDraft(current, { additions: [], amendments: [amendment, amendment] }),
  ).toThrow('Repeated amendment rowId "r" at proposal.amendments[1]. Combine field edits');
  expect(() =>
    amendWorkspaceDraft(current, {
      additions: [],
      amendments: [{ ...amendment, rowId: "not-staged" }],
    }),
  ).toThrow('Unknown amendment rowId "not-staged" at proposal.amendments[0]');
  expect(current.revision).toBe(3);
});

it("discloses only the resolved record values with draft overlays and independent copies", () => {
  const original = {
    record_id: "id",
    effective_start: "2026-01-01",
    values: {
      name: { type: "text" as const, value: "Canonical" },
      ref: { type: "text" as const, value: "42" },
      note: { type: "text" as const, value: "Remove" },
    },
    custom_fields: [],
  };
  const draft = structuredClone(current);
  draft.rows[0]!.operation = "update";
  draft.rows[0]!.clearFields = ["note"];
  const identity = createWorkspaceIdentity(
    { ...identityInput, recordsByModel: new Map([["item", [original]]]) },
    draft,
  );
  const resolved = identity.resolve("item", { ref: { type: "text", value: "42" } }, "2026-01-01");
  expect(resolved).toMatchObject({
    currentValues: {
      name: { type: "text", value: "Human correction" },
      ref: { type: "text", value: "42" },
    },
  });
  if (!("currentValues" in resolved) || !resolved.currentValues)
    throw new Error("Expected resolved values");
  expect(resolved.currentValues).not.toHaveProperty("note");
  resolved.currentValues.name = { type: "text", value: "Mutation" };
  expect(
    identity.resolve("item", { ref: { type: "text", value: "42" } }, "2026-01-01"),
  ).toMatchObject({ currentValues: { name: { type: "text", value: "Human correction" } } });
  expect(original.values.name.value).toBe("Canonical");
});

it("validates update identity over effective patched values and clears without filling create values", () => {
  let sequence = 0;
  const records = ["42", "other"].map((ref) => ({
    record_id: `id-${ref}`,
    effective_start: "2026-01-01",
    values: { ref: { type: "text" as const, value: ref } },
    custom_fields: [],
  }));
  const identity = createWorkspaceIdentity(
    { ...identityInput, recordsByModel: new Map([["item", records]]) },
    { revision: 0, rows: [] },
    () => `grant-${sequence++}`,
  );
  const grant = identity.resolve("item", { ref: { type: "text", value: "42" } }, "2026-01-01");
  if (!("rowId" in grant)) throw new Error("Expected grant");
  const update: WorkspaceRow = {
    rowId: grant.rowId,
    modelId: grant.modelId,
    recordId: grant.recordId,
    operation: grant.operation,
    effectiveStart: "2026-01-01",
    values: { name: { type: "text", value: "Requested note" } },
    clearFields: [],
  };
  expect(() => identity.assertAuthorized(update)).not.toThrow();
  expect(() => identity.assertAuthorized({ ...update, values: {} })).not.toThrow();
  const check = (...rows: WorkspaceRow[]) =>
    validateWorkspaceIdentity(
      { ...identityInput, recordsByModel: new Map([["item", records]]) },
      { revision: 1, rows },
    );
  expect(check(update)).toEqual([]);
  expect(check({ ...update, values: { ref: { type: "text", value: "other" } } })).toHaveLength(1);
  expect(check({ ...update, values: {}, clearFields: ["ref"] })).toHaveLength(1);
  expect(check({ ...update, values: { ref: { type: "text", value: "renamed" } } })).toEqual([]);
  const created = identity.resolve("item", { ref: { type: "text", value: "new" } }, "2026-01-01");
  if (!("rowId" in created)) throw new Error("Expected create grant");
  const create: WorkspaceRow = {
    ...update,
    rowId: created.rowId,
    recordId: created.recordId,
    operation: created.operation,
    values: {},
  };
  expect(check(create)).toHaveLength(1);
  expect(() =>
    identity.assertAuthorized({ ...create, values: { ref: { type: "text", value: "new" } } }),
  ).not.toThrow();
  expect(check({ ...create, values: { ref: { type: "text", value: "new" } } })).toEqual([]);
  expect(
    check(
      { ...create, values: { ref: { type: "text", value: "new" } } },
      {
        ...create,
        rowId: "second",
        recordId: "second",
        values: { ref: { type: "text", value: "new" } },
      },
    ),
  ).toHaveLength(2);
  expect(update.values).not.toHaveProperty("ref");
});
