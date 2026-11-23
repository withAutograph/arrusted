import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import type { ApplyChangeSet, FieldValue, Schema } from "@contracts";
import {
  buildCsvWorkspacePresentation,
  type WorkspaceDraft,
  type WorkspaceRow,
} from "@autograph/csv-workspace";
import {
  createCsvWorkspaceRequestHandler,
  createCsvWorkspaceService,
  KernelFailure,
  type CanonicalKernelOperations,
  type CsvWorkspaceServiceOptions,
} from "@autograph/csv-workspace/server";
import {
  expected,
  freshCustomerContext,
  freshCustomerInstructions,
  freshCustomerPolicies,
  freshCustomerRecordLabel,
  FRESH_IDS,
  initialInstruction,
  seedRecordsByModel,
} from "./fixtures/fresh-customer";

// A static independent customer schema exercises public installation without app runtime wiring.
const schema = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/fresh-customer/schema.json"),
    "utf8",
  ),
) as Schema;
const csv = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/fresh-customer/intake.csv"),
  "utf8",
);
const emptyDraft: WorkspaceDraft = { revision: 0, rows: [] };
const text = (value: string): FieldValue => ({ type: "text", value });
const relation = (value: string): FieldValue => ({
  type: "relation",
  value: { type: "record_id", value },
});
type Runner = NonNullable<CsvWorkspaceServiceOptions["runner"]>;
type Grant = Pick<WorkspaceRow, "rowId" | "recordId" | "modelId" | "operation"> & {
  kind: "resolved";
  currentValues: WorkspaceRow["values"] | null;
};

function installation(runner?: Runner) {
  const populations = seedRecordsByModel();
  const readVisibleRecords = vi.fn<CanonicalKernelOperations["readVisibleRecords"]>(
    async (request) => structuredClone(populations.get(request.model_id) ?? []),
  );
  const validateChangeSetDryRun = vi.fn<CanonicalKernelOperations["validateChangeSetDryRun"]>(
    async () => ({ alreadyApplied: false }),
  );
  const applyChangeSet = vi.fn<CanonicalKernelOperations["applyChangeSet"]>(async () => {
    throw new KernelFailure({ code: "fixture_rejection", message: "Observed apply boundary" });
  });
  const service = createCsvWorkspaceService({
    schema,
    schemaRevisionId: "71",
    context: freshCustomerContext,
    policies: freshCustomerPolicies,
    domainInstructions: freshCustomerInstructions,
    agent: { model: { provider: "test", model: "test" } },
    kernel: {
      readVisibleRecords,
      validateChangeSetDryRun,
      applyChangeSet,
      recentActivity: async () => [],
      changeSetDiff: async () => {
        throw new Error("Unexpected receipt read after rejected apply");
      },
    },
    runner,
  });
  return {
    service,
    handler: createCsvWorkspaceRequestHandler(service),
    readVisibleRecords,
    validateChangeSetDryRun,
    applyChangeSet,
  };
}

it("installs unrelated laboratory models through public tools, presentation and one ordinary Save", async () => {
  const installed = installation(async ({ tools }) => {
    const call = (id: string, input: unknown) => {
      const tool = tools?.find((entry) => entry.definition.id === id);
      expect(tool, `Installed tool ${id}`).toBeDefined();
      return tool!.execute(input);
    };
    expect(await call("inspect_workspace", {})).toMatchObject({
      schema: {
        app_id: freshCustomerContext.appId,
        models: expected.modelIds.map((id) => ({ id })),
      },
      identityPolicies: freshCustomerPolicies,
      sourceRowCount: expected.rowCount,
    });
    const source = await call("read_source_rows", { offset: 0, limit: 10 });
    expect(source).toMatchObject({
      total: 2,
      rows: [{ Accession: "LAB-001" }, { Accession: "LAB-002" }],
    });
    const resolve = async (modelId: string, values: WorkspaceRow["values"]) => {
      const grant = (await call("resolve_identity", {
        modelId,
        valuesJson: JSON.stringify(values),
        effectiveStart: freshCustomerContext.asOf,
      })) as Grant;
      expect(grant.kind).toBe("resolved");
      return grant;
    };
    const row = (grant: Grant, values: WorkspaceRow["values"]): WorkspaceRow => ({
      rowId: grant.rowId,
      recordId: grant.recordId,
      modelId: grant.modelId,
      operation: grant.operation,
      effectiveStart: freshCustomerContext.asOf,
      values,
      clearFields: [],
    });
    expect(await resolve("rack", { caption: text(expected.exactCaption.input) })).toMatchObject({
      recordId: expected.exactCaption.recordId,
      operation: "update",
    });
    expect(await resolve("rack", { caption: text(expected.alias.input) })).toMatchObject({
      recordId: expected.alias.recordId,
      operation: "update",
      currentValues: { caption: text(expected.alias.canonicalCaption) },
    });
    const existing = await resolve("specimen", { accession: text(expected.existing.accession) });
    expect(existing).toMatchObject({ recordId: FRESH_IDS.existingSpecimen, operation: "update" });
    const rackValues = { caption: text(expected.newRackCaption) };
    const rack = await resolve("rack", rackValues);
    const specimenValues = {
      accession: text(expected.created.accession),
      title: text(expected.created.title),
      rack: relation(rack.recordId),
    };
    const specimen = await resolve("specimen", specimenValues);
    // Repeated references within this file reuse the allocation and remain creates.
    expect(await resolve("rack", rackValues)).toMatchObject({
      rowId: rack.rowId,
      recordId: rack.recordId,
      operation: "create",
    });
    expect(
      await resolve("specimen", { accession: text(expected.created.accession) }),
    ).toMatchObject({
      rowId: specimen.rowId,
      recordId: specimen.recordId,
      operation: "create",
    });
    const observations: WorkspaceRow[] = [];
    for (const [target, reading] of [
      [existing, expected.existing.reading],
      [specimen, expected.created.reading],
    ] as const) {
      const values: WorkspaceRow["values"] = {
        specimen: relation(target.recordId),
        observed_on: { type: "date", value: freshCustomerContext.asOf },
        reading: { type: "number", value: reading },
      };
      observations.push(row(await resolve("observation", values), values));
    }
    const additions = [
      row(existing, { notes: text(expected.existing.notes) }),
      row(rack, rackValues),
      row(specimen, specimenValues),
      ...observations,
    ];
    expect(
      await call("compute_draft", {
        code: `input => ({ additions: ${JSON.stringify(additions)}, amendments: [] })`,
      }),
    ).toMatchObject({
      accepted: true,
      rowCount: 5,
      issues: [],
    });
    return {
      text: "Intake prepared",
      toolCalls: [],
      toolResults: [],
      steps: [],
      metadata: {
        runId: "contract",
        identityId: "laboratory-review",
        executionProfileId: "contract",
        provider: "test",
        model: "test",
        toolSurface: [],
      },
    };
  });
  const result = await installed.service.turn({
    schemaRevisionId: "71",
    csv,
    draft: emptyDraft,
    instruction: initialInstruction,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  expect(result.draft.rows).toHaveLength(5);
  expect(result.draft.rows[0]).toMatchObject({
    recordId: FRESH_IDS.existingSpecimen,
    operation: "update",
    values: { notes: text(expected.existing.notes) },
  });
  expect(Object.keys(result.draft.rows[0]!.values)).toEqual(["notes"]);
  expect(result.draft.rows.filter((row) => row.modelId === "rack")).toHaveLength(1);
  expect(result.draft.rows.every((row) => row.effectiveStart === freshCustomerContext.asOf)).toBe(
    true,
  );
  expect(installed.applyChangeSet).not.toHaveBeenCalled();

  const context = await installed.service.inspect();
  const presentation = buildCsvWorkspacePresentation(
    context,
    result.draft,
    freshCustomerRecordLabel,
  );
  expect(presentation.models.map((model) => model.modelId)).toEqual(expected.modelIds);
  expect(presentation.scope).toEqual({
    appId: freshCustomerContext.appId,
    customerId: freshCustomerContext.customerId,
  });
  expect(presentation.asOf).toBe(freshCustomerContext.asOf);
  expect(
    presentation.fieldOverridesByModel?.specimen?.rack?.relationOptions?.map(
      (option) => option.label,
    ),
  ).toEqual(["Cold Storage", "Archive", "Ambient Bench"]);
  expect(
    presentation.fieldOverridesByModel?.observation?.specimen?.relationOptions?.map(
      (option) => option.label,
    ),
  ).toEqual(["Plasma aliquot", "Control vial"]);
  expect(schema.change_types.map((changeType) => changeType.id)).toEqual([
    "catalog-maintenance",
    "specimen-intake",
    "record-result",
  ]);
  expect(schema.change_types.every((changeType) => !changeType.is_import_default)).toBe(true);
  for (const [request] of installed.readVisibleRecords.mock.calls) {
    expect(request).toMatchObject({
      app_id: freshCustomerContext.appId,
      customer_id: freshCustomerContext.customerId,
      as_of: freshCustomerContext.asOf,
    });
    expect(expected.modelIds).toContain(request.model_id);
  }
  expect(installed.validateChangeSetDryRun).toHaveBeenCalled();
  const response = await installed.handler(
    new Request("http://fixture.test/api/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        draft: result.draft,
        sourceFilename: "customer-import.csv",
        schemaRevisionId: "71",
        idempotencyKey: "laboratory-contract-save-1",
        recoveryContext: freshCustomerContext,
      }),
    }),
  );
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({
    outcome: "not_applied",
    error: { code: "fixture_rejection" },
  });
  expect(installed.applyChangeSet).toHaveBeenCalledTimes(1);
  const applied = installed.applyChangeSet.mock.calls[0]![0];
  expect(applied).toMatchObject({
    app_id: freshCustomerContext.appId,
    customer_id: freshCustomerContext.customerId,
    actor_id: freshCustomerContext.actorId,
    schema_revision_id: "71",
    source_kind: "human",
    mode: "mainline",
    idempotency_key: "laboratory-contract-save-1",
  });
  expect(applied.writes).toHaveLength(5);
  expect(applied.writes[0]).toMatchObject({
    record_key: { type: "record_id", value: FRESH_IDS.existingSpecimen },
    values: { notes: text(expected.existing.notes) },
  });
  for (const [validated] of installed.validateChangeSetDryRun.mock.calls) {
    const { idempotency_key: _key, source_ref: _source, ...ordinaryApply } = applied;
    const {
      idempotency_key: _validatedKey,
      source_ref: _validatedSource,
      ...ordinaryValidated
    } = validated;
    expect(ordinaryValidated).toEqual(ordinaryApply satisfies ApplyChangeSet);
  }
});

it.each(["appId", "customerId", "actorId", "asOf"] as const)(
  "rejects recovered Save from another %s before canonical apply",
  async (key) => {
    const installed = installation();
    const response = await installed.handler(
      new Request("http://fixture.test/api/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          draft: emptyDraft,
          sourceFilename: "customer-import.csv",
          schemaRevisionId: "71",
          idempotencyKey: "laboratory-contract-save-1",
          recoveryContext: { ...freshCustomerContext, [key]: "different" },
        }),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Save context does not match this authenticated scope, actor and frozen date",
      outcome: "not_applied",
    });
    expect(installed.applyChangeSet).not.toHaveBeenCalled();
  },
);
