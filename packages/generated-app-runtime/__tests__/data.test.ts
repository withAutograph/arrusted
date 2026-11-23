import { capabilityRoleFixture } from "./capability-role-fixture";
import { afterAll, beforeAll, expect, test, vi } from "vite-plus/test";
import { KernelFailure } from "../../kernel-client/postgres";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
import { Pool, type PoolClient } from "pg";
import { buildGeneratedRelease } from "../../../.config/mise/scripts/repository/schema-release";
import {
  createGeneratedAppRuntime,
  createPostgresDataContext,
  generatedAppLocalDatabaseUrl,
  setupGeneratedAppLocal,
  verifyCheckedRelease,
} from "../server";
import { createOperations, definition } from "./asset-operations.generated";
import { createDataClient } from "../data";

const root = path.resolve(testDirectory, "../../..");
const directory = mkdtempSync(path.join(tmpdir(), "data-plane-proof-"));
const database = `data_plane_${randomUUID().replaceAll("-", "")}`;
const url = new URL(generatedAppLocalDatabaseUrl({ root, appId: "data-plane-proof" }));
url.pathname = "/postgres";
const admin = new Pool({ connectionString: url.toString() });
let runtime: ReturnType<typeof createGeneratedAppRuntime>;
let operations: ReturnType<typeof createOperations>;
let releaseDirectory: string;
let capabilityRoles: string[] = [];
let roleFixture: Awaited<ReturnType<typeof capabilityRoleFixture>> | undefined;
let databaseCreated = false;
const asOf = "2026-09-15";
const options = (key: string) => ({ effectiveStart: asOf, idempotencyKey: key });

function withKernelResponses(responses: Readonly<Record<string, unknown>>) {
  const context = runtime.dataContext({
    actorId: "test-reviewer",
    sourceKind: "human",
    authorize: async () => {},
  });
  return createOperations({
    ...context,
    transaction: (run) =>
      context.transaction(async (session) => {
        const call = vi.spyOn(session, "call").mockImplementation(async (operation, input) => {
          if (!Object.hasOwn(responses, operation))
            throw new Error(`unexpected operation ${operation}`);
          const response = responses[operation];
          if (
            operation === "kernel_data_query" &&
            input.kind === "aggregate" &&
            response &&
            typeof response === "object"
          )
            return {
              as_of: input.as_of,
              units: (input.metrics as unknown[]).map(() => null),
              ...response,
            };
          return response;
        });
        try {
          return await run(session);
        } finally {
          call.mockRestore();
        }
      }),
  });
}

beforeAll(async () => {
  try {
    await admin.query("select 1");
  } catch {
    throw new Error(
      "Data-plane tests require local PostgreSQL. Run `mise run test:data-plane` for an owned fixture or configure DATA_PLANE_PROOF_DATABASE_URL for a disposable test database.",
    );
  }
  const release = buildGeneratedRelease("asset-register", directory, [
    "packages/schema-compiler/cue/app-manifest.cue",
    "packages/generated-app-runtime/__tests__/asset-register.cue",
  ]);
  releaseDirectory = release.directory;
  expect(readFileSync(path.join(release.directory, "data-operations.ts"), "utf8")).toBe(
    readFileSync(path.join(testDirectory, "asset-operations.generated.ts"), "utf8"),
  );
  roleFixture = await capabilityRoleFixture(admin);
  await admin.query(`create database "${database}"`);
  databaseCreated = true;
  url.pathname = `/${database}`;
  await setupGeneratedAppLocal({
    appId: "asset-register",
    customerId: "local-demo",
    databaseUrl: url.toString(),
    releaseDirectory,
  });
  const installed = new Pool({ connectionString: url.toString() });
  capabilityRoles = (
    await installed.query(
      "select kernel_installer_capability_role(capability) as name from unnest(array['query','runtime','schema_admin','execution_owner']) capability",
    )
  ).rows.map((row) => String(row.name));
  const principal = (await installed.query("select session_user::text as name")).rows[0].name;
  await roleFixture.grantRuntime(installed, capabilityRoles[1]!, String(principal));
  for (const [operation, payload] of [
    ["kernel_bind_principal_scope", { capability: "runtime" }],
    ...["test-reviewer", "test"].map(
      (actor_id) =>
        [
          "kernel_bind_actor_membership",
          { actor_id, actor_kind: "human", role: "fixture" },
        ] as const,
    ),
  ] as const) {
    const result = await installed.query(`select ${operation}($1::jsonb) result`, [
      JSON.stringify({
        principal_name: principal,
        app_id: "asset-register",
        customer_id: "local-demo",
        ...payload,
      }),
    ]);
    expect(result.rows[0].result.ok).toBe(true);
  }
  await installed.end();
  runtime = createGeneratedAppRuntime({
    appId: "asset-register",
    customerId: "local-demo",
    databaseUrl: url.toString(),
    releaseDirectory,
  });
  operations = createOperations(
    runtime.dataContext({
      actorId: "test-reviewer",
      sourceKind: "human",
      authorize: async () => {},
    }),
  );
}, 120000);
afterAll(async () => {
  await runtime?.close();
  if (databaseCreated) await admin.query(`drop database if exists "${database}"`);
  await roleFixture?.cleanup(capabilityRoles);
  await admin.end();
  rmSync(directory, { recursive: true, force: true });
});

test("round trips all scalar field types without losing decimal precision", async () => {
  const values = {
    title: "Precision asset",
    cost: "9007199254740993.125",
    active: false,
    placedOn: asOf,
    changedAt: "2026-09-15T10:00:00Z",
    tags: ["hardware"],
    aliases: ["laptop"],
    attributes: { nested: [1, true] },
    status: "available" as const,
    country: "US",
    currency: "USD",
    rate: { amount: "123.45", currency: "USD", period: "monthly" as const },
    customSerial: "S-001",
  };
  const receipt = await operations.asset
    .create(values, { ...options("all-fields") })
    .catch((error) => {
      throw new Error(`create all fields: ${error}`);
    });
  const replay = await operations.asset
    .create(values, { ...options("all-fields") })
    .catch((error) => {
      throw new Error(`replay all fields: ${error}`);
    });
  expect(replay.id).toBe(receipt.id);
  const [asset] = await operations.asset
    .list({ asOf, where: [{ field: "title", op: "eq", value: values.title }] })
    .catch((error) => {
      throw new Error(`read all fields: ${error}`);
    });
  expect(asset).toMatchObject(values);
  expect(
    await operations.asset.count({
      asOf,
      where: [{ field: "customSerial", op: "eq", value: "S-001" }],
    }),
  ).toBe("1");
  await expect(
    operations.asset.create({ ...values, title: "Changed" }, { ...options("all-fields") }),
  ).rejects.toThrow();
  await operations.asset
    .update(
      asset!.id,
      { title: "Renamed asset" },
      { ...options("clear-fields"), clear: ["cost", "customSerial"] },
    )
    .catch((error) => {
      throw new Error(`clear fields: ${error}`);
    });
  const updated = await operations.asset.get({
    key: { type: "record_id", value: asset!.id },
    asOf,
  });
  expect(updated?.cost).toBeNull();
  expect(updated?.customSerial).toBeNull();
  expect(updated?.active).toBe(false);
  expect(
    (
      await operations.asset.history({ id: asset!.id }).catch((error) => {
        throw new Error(`history: ${error}`);
      })
    ).length,
  ).toBeGreaterThan(1);
});

test("round trips an explicit canonical UUIDv7 record identifier", async () => {
  const id = "018f4e70-0000-7000-8000-000000000000";
  await operations.apply({
    ...options("explicit-v7-record-id"),
    writes: [operations.asset.writes.create({ title: "Explicit UUIDv7 asset" }, { id })],
  });
  await expect(
    operations.asset.get({ key: { type: "record_id", value: id }, asOf }),
  ).resolves.toMatchObject({ id, title: "Explicit UUIDv7 asset" });
});

test("guards update and delete against the visible record version", async () => {
  const title = `Version guard ${randomUUID()}`;
  await operations.asset.create({ title }, options("version-guard-create"));
  const record = (
    await operations.asset.list({
      asOf,
      where: [{ field: "title", op: "eq", value: title }],
      limit: 1,
    })
  )[0];
  if (!record) throw new Error("Expected version guard record");
  const version = record.$version;
  expect(version).toMatch(/^[0-9a-f-]{36}$/i);
  const guardedOptions = { ifVersion: version };
  const guardedUpdate = operations.asset.writes.update(
    record,
    { title: `${title} updated` },
    guardedOptions,
  );
  guardedOptions.ifVersion = randomUUID();
  await operations.apply({ ...options("version-guard-update"), writes: [guardedUpdate] });
  const staleError = await operations.asset
    .update(
      record,
      { title: `${title} stale` },
      { ...options("version-guard-stale"), ifVersion: version },
    )
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  if (!(staleError instanceof KernelFailure))
    throw new Error("Expected a canonical version conflict");
  expect(staleError.envelope).toMatchObject({ code: "version_conflict", details: [] });
  await expect(
    operations.asset.delete(record, {
      ...options("version-guard-stale-delete"),
      ifVersion: version,
    }),
  ).rejects.toMatchObject({ envelope: { code: "version_conflict", details: [] } });
  const current = (
    await operations.asset.list({
      asOf,
      where: [{ field: "title", op: "eq", value: `${title} updated` }],
      limit: 1,
    })
  )[0];
  if (!current) throw new Error("Expected updated version guard record");
  await operations.asset.delete(current, {
    ...options("version-guard-delete"),
    ifVersion: current.$version,
  });
  expect(
    await operations.asset.get({ key: { type: "record_id", value: current.id }, asOf }),
  ).toBeNull();
});

test("requires a valid version on capable full and token-selected wire results", async () => {
  for (const version of [undefined, null, "not-a-uuid"]) {
    const context = runtime.dataContext({
      actorId: "test-reviewer",
      sourceKind: "human",
      authorize: async () => {},
    });
    const malformed = createOperations({
      ...context,
      transaction: (run) =>
        context.transaction(async (session) => {
          const call = vi
            .spyOn(session, "call")
            .mockResolvedValueOnce([
              { record_id: randomUUID(), version_id: version, values: {}, custom_fields: [] },
            ]);
          try {
            return await run(session);
          } finally {
            call.mockRestore();
          }
        }),
    });
    await expect(malformed.asset.list({ asOf })).rejects.toThrow(
      "kernel_data_query response.version_id",
    );
    await expect(malformed.asset.list({ asOf, select: ["$version"] })).rejects.toThrow(
      "kernel_data_query response.version_id",
    );
  }
});

test("rejects malformed operation responses without converting them into form errors", async () => {
  const malformedList = withKernelResponses({ kernel_data_query: { rows: [] } });
  const listError = await malformedList.asset.list({ asOf }).catch((error: unknown) => error);
  expect(String(listError)).toContain("kernel_data_query response expected record array");
  expect(malformedList.asset.toFormError(listError, { fields: ["title"] })).toBeUndefined();

  const sentinel = "__private_response_key__";
  const leakedKey = withKernelResponses({ kernel_data_query: [{ [sentinel]: "secret" }] });
  const leakedError = await leakedKey.asset.list({ asOf }).catch((error: unknown) => error);
  expect(String(leakedError)).not.toContain(sentinel);
  expect(JSON.stringify(leakedError)).not.toContain(sentinel);

  const valueSentinel = "__private_response_value__";
  const leakedValue = withKernelResponses({
    kernel_data_query: [{ values: { title: { type: "number", value: valueSentinel } } }],
  });
  const leakedValueError = await leakedValue.asset
    .list({ asOf, select: ["title"] })
    .catch((error: unknown) => error);
  expect(String(leakedValueError)).not.toContain(valueSentinel);
  expect(JSON.stringify(leakedValueError)).not.toContain(valueSentinel);

  const missingRequired = withKernelResponses({
    kernel_data_query: [{ record_id: randomUUID(), values: {} }],
  });
  await expect(missingRequired.asset.list({ asOf, select: ["title"] })).rejects.toThrow(
    "required declared field value",
  );

  const missingSelectedId = withKernelResponses({ kernel_data_query: [{}] });
  await expect(missingSelectedId.asset.list({ asOf, select: ["id"] })).rejects.toThrow(
    "response.record_id",
  );
  const selectedExternalNull = withKernelResponses({ kernel_data_query: [{ external_key: null }] });
  await expect(selectedExternalNull.asset.list({ asOf, select: ["externalKey"] })).resolves.toEqual(
    [{ externalKey: null }],
  );

  const malformedCustom = withKernelResponses({
    kernel_data_query: [
      { custom_fields: [{ field_id: "serial", type: "relation_list", value: [] }] },
    ],
  });
  await expect(malformedCustom.asset.list({ asOf, select: ["customSerial"] })).rejects.toThrow(
    "custom field value type",
  );

  const malformedCount = withKernelResponses({
    kernel_data_query: { groups: [], total: { metrics: ["-1"] } },
  });
  await expect(malformedCount.asset.count({ asOf })).rejects.toThrow("non-negative integer string");

  const malformedGroups = withKernelResponses({
    kernel_data_query: {
      groups: Array.from({ length: 101 }, () => ({ key: ["available"], metrics: ["1"] })),
      total: { metrics: ["101"] },
    },
  });
  await expect(malformedGroups.asset.countBy({ asOf, groupBy: "status" })).rejects.toThrow(
    "at most 100 groups",
  );

  const malformedHistory = withKernelResponses({
    kernel_field_history: [
      {
        version_id: randomUUID(),
        change_set_id: 1,
        stage: "mainline",
        effective_start: asOf,
        field_id: "cost",
        withheld: false,
        tombstones_record: false,
        untombstones_record: false,
        source_kind: "ui",
        value: { type: "number", value: "not-a-decimal" },
      },
    ],
  });
  await expect(malformedHistory.asset.history({ id: randomUUID() })).rejects.toThrow(
    "decimal string",
  );

  const legacyHistory = withKernelResponses({
    kernel_field_history: [
      {
        version_id: randomUUID(),
        change_set_id: 1,
        stage: "mainline",
        effective_start: asOf,
        field_id: "status",
        withheld: false,
        tombstones_record: false,
        untombstones_record: false,
        source_kind: "ui",
        value: { type: "enum", value: "retired-option" },
        enum_value: {
          option_id: "retired-option",
          event_schema_revision_id: 1,
          event_label: "Retired option",
          current_label: null,
        },
      },
    ],
  });
  await expect(legacyHistory.asset.history({ id: randomUUID() })).resolves.toMatchObject([
    {
      value: { type: "enum", value: "retired-option" },
      enum_value: { event_schema_revision_id: "1" },
    },
  ]);

  const mismatchedHistory = withKernelResponses({
    kernel_field_history: [
      {
        version_id: randomUUID(),
        change_set_id: 1,
        stage: "mainline",
        effective_start: asOf,
        field_id: "status",
        withheld: false,
        tombstones_record: false,
        untombstones_record: false,
        source_kind: "ui",
        value: { type: "enum", value: "available" },
        enum_value: {
          option_id: "assigned",
          event_schema_revision_id: "1",
          event_label: "Assigned",
        },
      },
    ],
  });
  await expect(mismatchedHistory.asset.history({ id: randomUUID() })).rejects.toThrow(
    "matching historical enum value",
  );
});

test("decodes active revisions and apply receipts before exposing a mutation result", async () => {
  const invalidActive = withKernelResponses({
    kernel_read_active_schema_revision: {
      schema_revision_id: "0",
      schema: { version: definition.schemaVersion },
    },
  });
  await expect(
    invalidActive.asset.create({ title: "Active response" }, options("invalid-active")),
  ).rejects.toThrow("positive signed 64-bit schema revision ID");

  const invalidReceipt = withKernelResponses({
    kernel_read_active_schema_revision: {
      schema_revision_id: "1",
      schema: { version: definition.schemaVersion },
    },
    kernel_apply_change_set: { id: Number.MAX_SAFE_INTEGER + 1, schema_revision_id: "1" },
  });
  await expect(
    invalidReceipt.asset.create({ title: "Receipt response" }, options("invalid-receipt")),
  ).rejects.toThrow("safe integer");
});

test("parses allowlisted form controls without changing omitted updates", () => {
  const form = new FormData();
  form.set("title", "Form asset");
  form.set("active", "false");
  form.set("tags", "[]");
  form.set("owner", JSON.stringify({ type: "external_key", value: "owner-1" }));
  form.set("rate", JSON.stringify({ amount: "1.25", currency: "USD", period: "monthly" }));
  form.set("customSerial", "FORM-1");
  const parsed = operations.asset.parseForm(form, {
    fields: ["title", "active", "tags", "owner", "rate", "customSerial"] as const,
    mode: "create",
  });
  expect(parsed).toEqual({
    values: {
      title: "Form asset",
      active: false,
      tags: [],
      owner: { type: "external_key", value: "owner-1" },
      rate: { amount: "1.25", currency: "USD", period: "monthly" },
      customSerial: "FORM-1",
    },
    clear: [],
  });
  const createClear: readonly [] = parsed.clear;
  void createClear;
  const canonicalOwner: { type: "record_id" | "external_key"; value: string } | undefined =
    parsed.values.owner;
  void canonicalOwner;
  const proveDynamicCreateIsPartial = (dynamicFields: readonly ("title" | "active")[]) => {
    const dynamicParsed = operations.asset.parseForm(new FormData(), {
      fields: dynamicFields,
      mode: "create",
    });
    // @ts-expect-error Dynamic selections do not guarantee a field was supplied.
    const dynamicTitle: string = dynamicParsed.values.title;
    return dynamicTitle;
  };
  void proveDynamicCreateIsPartial;
  const proveModeUnion = (mode: "create" | "update") => {
    const modeResult = operations.asset.parseForm(form, { fields: ["title"] as const, mode });
    // @ts-expect-error The update branch makes title optional.
    const requiredTitle: string = modeResult.values.title;
    return requiredTitle;
  };
  void proveModeUnion;
  const clearTypes = operations.asset.parseForm(new FormData(), {
    fields: ["cost"] as const,
    mode: "update",
  }).clear;
  const costClear: readonly "cost"[] = clearTypes;
  void costClear;
  // @ts-expect-error Required names cannot be cleared.
  const titleClear: readonly "title"[] = clearTypes;
  void titleClear;
  const proveTupleUnionIsNotBoth = (fields: readonly ["title"] | readonly ["active"]) => {
    const tupleUnion = operations.asset.parseForm(form, { fields, mode: "create" });
    // @ts-expect-error A union of literal tuples cannot promise both branches.
    const both: string = tupleUnion.values.title;
    return both;
  };
  void proveTupleUnionIsNotBoth;
  const update = new FormData();
  update.set("clear", "unrelated");
  update.set("clear:cost", "true");
  expect(
    operations.asset.parseForm(update, {
      fields: ["active", "tags", "cost"] as const,
      mode: "update",
    }),
  ).toEqual({
    values: {},
    clear: ["cost"],
  });
  const malformed = new FormData();
  malformed.append("active", "true");
  malformed.append("active", "false");
  let duplicateError: unknown;
  try {
    operations.asset.parseForm(malformed, { fields: ["active"] as const, mode: "update" });
  } catch (error) {
    duplicateError = error;
  }
  expect(operations.asset.toFormError(duplicateError, { fields: ["active"] as const })).toEqual({
    ok: false,
    code: "invalid_input",
    message: "Enter a valid value",
    fieldErrors: { active: { code: "invalid_input", message: "Enter a valid value" } },
  });
  const expectInvalidFormError = (
    input: FormData,
    fields: Parameters<typeof operations.asset.toFormError>[1]["fields"],
    mode: "create" | "update" = "update",
  ) => {
    let error: unknown;
    try {
      operations.asset.parseForm(input, { fields, mode });
    } catch (caught) {
      error = caught;
    }
    expect(operations.asset.toFormError(error, { fields })).toEqual({
      ok: false,
      code: "invalid_input",
      message: "Enter a valid value",
      fieldErrors: Object.fromEntries(
        fields.map((field) => [field, { code: "invalid_input", message: "Enter a valid value" }]),
      ),
    });
  };

  const conflict = new FormData();
  conflict.set("cost", "1");
  conflict.set("clear:cost", "true");
  expectInvalidFormError(conflict, ["cost"] as const);
  expectInvalidFormError(new FormData(), ["title"] as const, "create");
  const invalidRelation = new FormData();
  invalidRelation.set("owner", JSON.stringify({ type: "record_id", value: "not-a-uuid" }));
  expectInvalidFormError(invalidRelation, ["owner"] as const);
  const invalidMoney = new FormData();
  invalidMoney.set("rate", "not-json");
  expectInvalidFormError(invalidMoney, ["rate"] as const);
  expect(() =>
    // @ts-expect-error Read-only and unknown names are excluded from parser fields.
    operations.asset.parseForm(new FormData(), { fields: ["computed"] as const, mode: "update" }),
  ).toThrow("unsupported");
  const file = new FormData();
  file.set("title", new File(["ignored"], "title.txt"));
  expectInvalidFormError(file, ["title"] as const, "create");
  const many = new FormData();
  many.set(
    "relatedAssets",
    JSON.stringify([{ type: "record_id", value: "00000000-0000-0000-0000-000000000001" }]),
  );
  const parsedMany = operations.category.parseForm(many, {
    fields: ["relatedAssets"] as const,
    mode: "update",
  });
  const canonicalMany:
    | readonly { type: "record_id" | "external_key"; value: string }[]
    | undefined = parsedMany.values.relatedAssets;
  void canonicalMany;
  expect(parsedMany.values).toEqual({
    relatedAssets: [{ type: "record_id", value: "00000000-0000-0000-0000-000000000001" }],
  });
});

test("parsed form syntax does not replace PostgreSQL constraints", async () => {
  const form = new FormData();
  form.set("title", "Constraint form asset");
  form.set("cost", "-1");
  const parsed = operations.asset.parseForm(form, {
    fields: ["title", "cost"] as const,
    mode: "create",
  });
  let failure: unknown;
  try {
    await operations.asset.create(parsed.values, options("parsed-constraint-rejection"));
  } catch (error) {
    failure = error;
  }
  expect(operations.asset.toFormError(failure, { fields: ["title", "cost"] })).toEqual({
    ok: false,
    code: "constraint_violation",
    message: "This value does not satisfy the required rules",
    fieldErrors: {
      cost: {
        code: "constraint_violation",
        message: "This value does not satisfy the required rules",
      },
    },
  });
});

test("required retired fields are omitted from creates and remain readable", async () => {
  await operations.asset.create(
    { title: "Retired field omission" },
    options("retired-required-omission"),
  );
  const [record] = await operations.asset.list({
    asOf,
    where: [{ field: "title", op: "eq", value: "Retired field omission" }],
  });
  expect(record?.legacyNote).toBeNull();
});

test("countBy preserves typed grouped values and canonical decimal counts", async () => {
  const prefix = `Grouped ${randomUUID()}`;
  await operations.apply({
    ...options("typed-group-values"),
    writes: [
      operations.asset.writes.create({
        title: `${prefix} available`,
        active: true,
        status: "available",
        customSerial: "group-a",
      }),
      operations.asset.writes.create({
        title: `${prefix} assigned`,
        active: false,
        status: "assigned",
        customSerial: "group-b",
      }),
      operations.asset.writes.create({
        title: `${prefix} unassigned`,
        active: false,
        status: "assigned",
      }),
    ],
  });

  const input = {
    asOf,
    where: [{ field: "title" as const, op: "contains" as const, value: prefix }],
  };

  expect(await operations.asset.count(input)).toBe("3");
  expect(await operations.asset.countBy({ ...input, groupBy: "status" })).toEqual([
    { value: "available", count: "1" },
    { value: "assigned", count: "2" },
  ]);
  expect(await operations.asset.countBy({ ...input, groupBy: "active" })).toEqual([
    { value: false, count: "2" },
    { value: true, count: "1" },
  ]);
  expect(await operations.asset.countBy({ ...input, groupBy: "customSerial" })).toEqual([
    { value: "group-a", count: "1" },
    { value: "group-b", count: "1" },
    { value: null, count: "1" },
  ]);
  expect(await operations.asset.countBy({ ...input, groupBy: "legacyNote" })).toEqual([
    { value: null, count: "3" },
  ]);
  expect(
    await operations.asset.countBy({
      ...input,
      where: [{ field: "title", op: "contains", value: `missing ${prefix}` }],
      groupBy: "status",
    }),
  ).toEqual([]);
});

test("restricted database principals cannot cross tenants or access physical tables", async () => {
  const rolePassword = randomUUID();
  const principal = `data_caller_${randomUUID().replaceAll("-", "")}`;
  const groupPrefix = `Restricted grouped ${randomUUID()}`;
  await operations.apply({
    ...options(`restricted-grouped-${randomUUID()}`),
    writes: [
      operations.asset.writes.create({ title: `${groupPrefix} assigned`, status: "assigned" }),
      operations.asset.writes.create({ title: `${groupPrefix} available`, status: "available" }),
    ],
  });
  const owner = new Pool({ connectionString: url.toString() });
  let caller: Pool | undefined;
  try {
    await admin.query(`create role "${principal}" login password '${rolePassword}'`);
    await owner.query(`grant "${capabilityRoles[1]!.replaceAll('"', '""')}" to "${principal}"`);
    const binding = (
      await owner.query("select kernel_bind_principal_scope($1::jsonb) as result", [
        JSON.stringify({
          principal_name: principal,
          capability: "runtime",
          app_id: "asset-register",
          customer_id: "local-demo",
        }),
      ])
    ).rows[0].result;
    expect(binding.ok).toBe(true);
    const callerUrl = new URL(url);
    callerUrl.username = principal;
    callerUrl.password = rolePassword;
    caller = new Pool({ connectionString: callerUrl.toString() });
    const request = {
      app_id: "asset-register",
      customer_id: "local-demo",
      schema_version: "data-plane-test-v1",
      model_id: "asset",
      as_of: asOf,
      kind: "aggregate",
      metrics: [{ fn: "count" }],
      where: [{ field: "title", op: "contains", value: groupPrefix }],
    };
    expect(
      (
        await caller.query("select kernel_data_query($1::jsonb) as result", [
          JSON.stringify(request),
        ])
      ).rows[0].result.ok,
    ).toBe(true);
    const grouped = (
      await caller.query("select kernel_data_query($1::jsonb) as result", [
        JSON.stringify({ ...request, group_by: ["status"] }),
      ])
    ).rows[0].result;
    expect(grouped.ok).toBe(true);
    expect(grouped.data).toEqual({
      as_of: asOf,
      units: [null],
      groups: [
        { key: ["available"], metrics: ["1"] },
        { key: ["assigned"], metrics: ["1"] },
      ],
      total: { metrics: ["2"] },
    });
    for (const deniedRequest of [
      { ...request, customer_id: "another-tenant" },
      { ...request, customer_id: "another-tenant", group_by: ["status"] },
    ]) {
      const denied = (
        await caller.query("select kernel_data_query($1::jsonb) as result", [
          JSON.stringify(deniedRequest),
        ])
      ).rows[0].result;
      expect(denied.ok).toBe(false);
      expect(denied.error.code).toBe("authorization_denied");
    }
    await expect(caller.query("select * from asset_record")).rejects.toThrow();
    await expect(caller.query("insert into asset_record default values")).rejects.toThrow();
    await expect(caller.query("select kernel_bind_principal_scope('{}'::jsonb)")).rejects.toThrow();
    const deniedWrite = (
      await caller.query("select kernel_apply_change_set($1::jsonb) as result", [
        JSON.stringify({
          app_id: "asset-register",
          customer_id: "another-tenant",
          source_kind: "human",
          mode: "mainline",
          idempotency_key: "forged-scope",
          writes: [
            {
              model_id: "asset",
              new_record_id: randomUUID(),
              effective_start: asOf,
              values: { title: { type: "text", value: "Forged" } },
            },
          ],
        }),
      ])
    ).rows[0].result;
    expect(deniedWrite.ok).toBe(false);
  } finally {
    await caller?.end();
    await owner.query("delete from kernel_principal_scope where principal_name=$1", [principal]);
    await owner.end();
    await admin.query(`drop role if exists "${principal}"`);
  }
});

test("supports cyclic creates and inverse relation reads in one atomic change set", async () => {
  const assetId = randomUUID(),
    employeeId = randomUUID();
  await operations.apply({
    ...options("cyclic"),
    writes: [
      operations.asset.writes.create(
        {
          title: "Assigned asset",
          cost: "10",
          owner: { type: "record_id", value: employeeId },
        },
        { id: assetId },
      ),
      operations.employee.writes.create(
        { name: "Mira", primaryAsset: { type: "record_id", value: assetId } },
        { id: employeeId },
      ),
    ],
  });
  expect(
    (await operations.employee.relations.assets.list({ id: employeeId, asOf })).map(
      (asset) => asset.id,
    ),
  ).toEqual([assetId]);
  const selected = await operations.employee.relations.assets.list({
    id: employeeId,
    asOf,
    select: ["id", "tags"] as const,
  });
  expect(selected).toEqual([{ id: assetId, tags: null }]);
});

test("filters and sorts numeric values in PostgreSQL, pages stably, and counts independently", async () => {
  await operations.apply({
    ...options("page-fixture"),
    writes: ["2", "10", "20"].map((cost) =>
      operations.asset.writes.create({ title: `Page ${cost}`, cost, status: "available" }),
    ),
  });
  const query = {
    asOf,
    where: [{ field: "title" as const, op: "contains" as const, value: "Page" }],
    orderBy: [{ field: "cost" as const, direction: "asc" as const }],
    limit: 2,
  };
  expect((await operations.asset.list(query)).map((asset) => asset.cost)).toEqual(["2", "10"]);
  expect((await operations.asset.list({ ...query, offset: 2 })).map((asset) => asset.cost)).toEqual(
    ["20"],
  );
  expect(await operations.asset.count(query)).toBe("3");
  expect(await operations.asset.countBy({ ...query, groupBy: "status" })).toEqual([
    { value: "available", count: "3" },
  ]);
  expect(
    await operations.asset.aggregate({
      asOf,
      where: query.where,
      groupBy: ["status"],
      metrics: [{ fn: "count" }, { fn: "sum", field: "cost" }],
    }),
  ).toEqual({
    as_of: asOf,
    units: [null, null],
    groups: [{ key: ["available"], metrics: ["3", "32"] }],
    total: { metrics: ["3", "32"] },
  });
  await expect(operations.asset.list({ ...query, limit: 101 })).rejects.toThrow();
  await expect(operations.asset.list({ ...query, offset: 10001 })).rejects.toThrow();
});

test("rolls back a valid sibling when another write violates a database constraint", async () => {
  await expect(
    operations.apply({
      ...options("rollback"),
      writes: [
        operations.employee.writes.create({ name: "Must roll back" }),
        operations.asset.writes.create({ title: "Invalid asset", cost: "-1" }),
      ],
    }),
  ).rejects.toThrow();
  expect(
    await operations.employee.count({
      asOf,
      where: [{ field: "name", op: "eq", value: "Must roll back" }],
    }),
  ).toBe("0");
  expect(
    await operations.asset.count({
      asOf,
      where: [{ field: "title", op: "eq", value: "Invalid asset" }],
    }),
  ).toBe("0");
});

test("updates cannot create and deletes retain history", async () => {
  await expect(
    operations.asset.update(randomUUID(), { title: "Must not create" }, { ...options("missing") }),
  ).rejects.toThrow();
  const assetId = randomUUID();
  await operations.apply({
    ...options("delete-create"),
    writes: [operations.asset.writes.create({ title: "Delete me", cost: "1" }, { id: assetId })],
  });
  await operations.asset.delete(assetId, { ...options("delete") });
  expect(
    await operations.asset.get({ key: { type: "record_id", value: assetId }, asOf }),
  ).toBeNull();
  expect((await operations.asset.history({ id: assetId })).length).toBeGreaterThan(0);
});

test("authorizes every invocation and rejects caller-supplied trusted scope", async () => {
  const denied = createOperations(
    runtime.dataContext({
      actorId: "test",
      sourceKind: "human",
      authorize: async () => {
        throw new Error("forbidden");
      },
    }),
  );
  await expect(denied.asset.list({ asOf })).rejects.toThrow("forbidden");
  await expect(denied.asset.create({ title: "Denied" }, { ...options("denied") })).rejects.toThrow(
    "forbidden",
  );
  // @ts-expect-error Trusted scope is deliberately absent from generated inputs.
  await expect(operations.asset.list({ asOf, customerId: "other-tenant" })).rejects.toThrow(
    "unknown input",
  );
  await expect(
    // @ts-expect-error Unknown fields remain rejected.
    operations.asset.update(randomUUID(), { sql: "drop table" }, { ...options("forged") }),
  ).rejects.toThrow();
  await expect(
    // @ts-expect-error Decimal values must remain strings.
    operations.asset.create({ title: "Invalid numeric", cost: 12.5 }, { ...options("numeric") }),
  ).rejects.toThrow();
  await expect(
    // @ts-expect-error Required fields are generated from the schema.
    operations.asset.create({ cost: "1" }, { ...options("required") }),
  ).rejects.toThrow();
  expect(() => verifyCheckedRelease(path.join(directory, "missing"))).toThrow();
});

test("a failed rollback preserves the original error and discards the connection", async () => {
  const pool = new Pool({ connectionString: url.toString(), max: 1 });
  let acquired: PoolClient | undefined;
  pool.on("acquire", (connection) => {
    acquired = connection;
  });
  const context = createPostgresDataContext({
    pool,
    appId: "asset-register",
    customerId: "local-demo",
    actorId: "test",
    sourceKind: "human",
    authorize: async () => {},
    verifyRelease: () => {},
  });
  const original = new Error("original operation failure");
  try {
    await expect(
      context.transaction(async () => {
        if (!acquired) throw new Error("Expected an acquired connection");
        await acquired.end();
        throw original;
      }),
    ).rejects.toBe(original);
    expect(pool.totalCount).toBe(0);
  } finally {
    await pool.end();
  }
});

test("query types match supported SQL fields and operators", async () => {
  await operations.asset.list({
    asOf,
    where: [{ field: "active", op: "eq", value: false }],
    orderBy: [{ field: "cost", direction: "asc" }],
  });
  await operations.asset.countBy({ asOf, groupBy: "status" });
  await expect(
    // @ts-expect-error Lists cannot be scalar filter operands.
    operations.asset.list({ asOf, where: [{ field: "tags", op: "eq", value: "hardware" }] }),
  ).rejects.toThrow();
  await expect(
    // @ts-expect-error Boolean ordering comparisons are unsupported.
    operations.asset.list({ asOf, where: [{ field: "active", op: "gt", value: false }] }),
  ).rejects.toThrow();
  await expect(
    // @ts-expect-error Relations cannot be ordered.
    operations.asset.list({ asOf, orderBy: [{ field: "owner", direction: "asc" }] }),
  ).rejects.toThrow();
  await expect(
    // @ts-expect-error Numeric fields cannot be grouped by this query contract.
    operations.asset.countBy({ asOf, groupBy: "cost" }),
  ).rejects.toThrow();
  await expect(
    // @ts-expect-error Grouped counts do not select records.
    operations.asset.countBy({ asOf, groupBy: "status", select: ["title"] }),
  ).rejects.toThrow();
  expect(() =>
    operations.asset.writes.create({
      title: "Unsupported key",
      // @ts-expect-error Lookup-or-create is not a canonical relation identity.
      owner: { type: "lookup_or_create", value: { label: "Someone" } },
    }),
  ).toThrow();
});

test("selection types retain only requested fields and do not grant record provenance", async () => {
  const literal = await operations.asset.list({
    asOf,
    select: ["id", "title", "customSerial"] as const,
  });
  const selected = literal[0]!;
  expect(selected.id).toEqual(expect.any(String));
  expect(selected.title).toEqual(expect.any(String));
  expect("cost" in selected).toBe(false);
  await expect(
    operations.asset.update(
      // @ts-expect-error A selected result is intentionally not a full generated record.
      selected,
      { title: "Cannot use selection as target" },
      options("selected-target"),
    ),
  ).rejects.toThrow("reference");
  expect(() =>
    // @ts-expect-error A selected result cannot be used as a relation reference.
    operations.asset.writes.create({ title: "Cannot use selection as relation", owner: selected }),
  ).toThrow("unknown input id");
  const dynamic: readonly ("id" | "title")[] = ["id", "title"];
  const dynamicResult = await operations.asset.list({ asOf, select: dynamic });
  // @ts-expect-error A dynamic selection may omit every declared selected key at runtime.
  const title: string = dynamicResult[0]!.title;
  expect(title).toBeDefined();
  const proveUnionTupleIsPartial = async (field: "id" | "title") => {
    const unionTuple = await operations.asset.list({ asOf, select: [field] as const });
    // @ts-expect-error A union-valued tuple element may select a different field at runtime.
    const unionTitle: string = unionTuple[0]!.title;
    return unionTitle;
  };
  void proveUnionTupleIsPartial;
  const listOptional = (select: readonly ("id" | "title")[] | undefined) =>
    operations.asset.list({ asOf, select });
  const optionalResult = await listOptional(dynamic);
  // @ts-expect-error Optional selection results may be partial.
  const optionalTitle: string = optionalResult[0]!.title;
  expect(optionalTitle).toBeDefined();
  const proveExplicitSelectionRequiresInput = () => {
    // @ts-expect-error An explicitly selected generic requires a supplied selection.
    void operations.asset.list<readonly ["title"]>({ asOf });
  };
  void proveExplicitSelectionRequiresInput;
  // @ts-expect-error Literal empty selections are rejected before runtime.
  await expect(operations.asset.list({ asOf, select: [] as const })).rejects.toThrow("select");
  // @ts-expect-error Counts do not accept selections.
  await expect(operations.asset.count({ asOf, select: ["title"] as const })).rejects.toThrow(
    "select",
  );
  const derived = createDataClient(
    {
      formatVersion: 1,
      schemaVersion: definition.schemaVersion,
      models: [
        {
          id: "derived",
          name: "derived",
          fields: [
            { id: "title", name: "title", type: "text", required: true, readOnly: false },
            {
              id: "computed",
              name: "computed",
              type: "text",
              storage: "custom",
              required: false,
              readOnly: true,
            },
          ],
          relations: [],
        },
      ],
    } as const,
    runtime.dataContext({ actorId: "test", sourceKind: "human", authorize: async () => {} }),
  );
  const proveDerivedFieldsAreReadOnly = () => {
    void derived.derived.list({ asOf, select: ["computed"] as const });
    void derived.derived.create({ title: "t" }, options("derived-create"));
    // @ts-expect-error Derived fields are never create inputs.
    void derived.derived.create({ title: "t", computed: "x" }, options("derived-create"));
  };
  void proveDerivedFieldsAreReadOnly;
});

test("selected wire responses omit non-selected values and containers", async () => {
  const result = await operations.asset.list({
    asOf,
    select: ["id", "title", "customSerial"] as const,
  });
  expect(result.length).toBeGreaterThan(0);
  for (const record of result)
    expect(Object.keys(record).sort()).toEqual(["customSerial", "id", "title"]);
  const directPool = new Pool({ connectionString: url.toString() });
  try {
    const direct = await directPool.query("select kernel_data_query($1::jsonb) as result", [
      JSON.stringify({
        app_id: "asset-register",
        customer_id: "local-demo",
        schema_version: definition.schemaVersion,
        model_id: "asset",
        as_of: asOf,
        kind: "list",
        // Omit the custom field in this wire projection. Rows with a
        // serial legitimately include custom_fields when serial is selected.
        select: ["$id", "title"],
      }),
    ]);
    const wire = direct.rows[0]!.result.data[0];
    expect(Object.keys(wire).sort()).toEqual(["record_id", "values"]);
    expect(Object.keys(wire.values)).toEqual(["title"]);
    expect(wire).not.toHaveProperty("custom_fields");
    expect(wire).not.toHaveProperty("metadata");
    expect(wire).not.toHaveProperty("effective_start");
    expect(wire).not.toHaveProperty("many_relations");
  } finally {
    await directPool.end();
  }
});

test("rejects altered release members and stale schema bindings", async () => {
  const member = path.join(releaseDirectory, "data-server.ts");
  const original = readFileSync(member);
  try {
    writeFileSync(member, "// changed outside the compiler\n");
    expect(() => verifyCheckedRelease(releaseDirectory)).toThrow("checksum");
  } finally {
    writeFileSync(member, original);
  }
  expect(() =>
    createGeneratedAppRuntime({
      appId: "wrong-app",
      customerId: "local-demo",
      databaseUrl: url.toString(),
      releaseDirectory,
    }),
  ).toThrow("another application");
  const stale = createDataClient(
    { ...definition, schemaVersion: "stale" },
    runtime.dataContext({ actorId: "test", sourceKind: "human", authorize: async () => {} }),
  );
  await expect(stale.asset.list({ asOf })).rejects.toThrow();
  await expect(
    stale.asset.create({ title: "Stale write" }, { ...options("stale") }),
  ).rejects.toThrow("schema version");
});

test("round trips opted-in metadata and lookup many relations", async () => {
  const assetId = randomUUID(),
    categoryId = randomUUID();
  await operations.apply({
    ...options("extensions"),
    writes: [
      operations.asset.writes.create(
        { title: "Metadata asset", cost: "1" },
        { id: assetId, metadataPatch: { set: { source: "fixture" } } },
      ),
      operations.category.writes.create(
        { name: "Hardware", relatedAssets: [{ type: "record_id", value: assetId }] },
        { id: categoryId },
      ),
    ],
  });
  expect(
    (await operations.asset.get({ key: { type: "record_id", value: assetId }, asOf }))?.metadata,
  ).toEqual({ source: "fixture" });
  expect(
    (await operations.category.get({ key: { type: "record_id", value: categoryId }, asOf }))
      ?.relatedAssets,
  ).toEqual([{ type: "record_id", value: assetId }]);
  await operations.asset.update(
    assetId,
    {},
    { ...options("metadata-clear"), metadataPatch: { clear: true } },
  );
  expect(
    (await operations.asset.get({ key: { type: "record_id", value: assetId }, asOf }))?.metadata,
  ).toEqual({});
  await expect(
    operations.asset.update(
      assetId,
      {},
      { ...options("metadata-limit"), metadataPatch: { set: { tooLong: "x".repeat(200) } } },
    ),
  ).rejects.toThrow();
});

test("normalizes typed references, snapshots inputs, and replays equivalent canonical writes", async () => {
  const employee = operations.employee.writes.create({ name: "Reference owner" });
  const values = {
    title: "Reference asset",
    owner: employee,
    customCustodian: employee,
    tags: ["original"],
  };
  const asset = operations.asset.writes.create(values);
  const category = operations.category.writes.create({
    name: "Reference category",
    relatedAssets: [asset],
  });
  values.title = "Changed after preparation";
  values.tags.push("changed");
  await expect(
    operations.apply({ ...options("missing-dependency"), writes: [asset] }),
  ).rejects.toThrow("same atomic batch");
  const receipt = await operations.apply({
    ...options("references"),
    writes: [employee, asset, category],
  });
  const key = (value: string) => ({ type: "record_id" as const, value });
  const replay = await operations.apply({
    ...options("references"),
    writes: [
      operations.employee.writes.create({ name: "Reference owner" }, { id: employee.recordId }),
      operations.asset.writes.create(
        {
          title: "Reference asset",
          owner: key(employee.recordId),
          customCustodian: key(employee.recordId),
          tags: ["original"],
        },
        { id: asset.recordId },
      ),
      operations.category.writes.create(
        { name: "Reference category", relatedAssets: [key(asset.recordId)] },
        { id: category.recordId },
      ),
    ],
  });
  expect(replay.id).toBe(receipt.id);
  const record = (await operations.asset.get({ key: key(asset.recordId), asOf }))!;
  expect(record.title).toBe("Reference asset");
  expect(record.tags).toEqual(["original"]);
  expect(record.owner).toEqual(key(employee.recordId));
  expect(record.customCustodian).toEqual(key(employee.recordId));
  const owner = (await operations.employee.get({ key: key(employee.recordId), asOf }))!;
  await operations.asset.update(
    record,
    { owner, customCustodian: owner },
    options("record-update"),
  );
  await operations.category.create(
    { name: "Existing relation list", relatedAssets: [record] },
    options("existing-list"),
  );
  const update = operations.asset.writes.update(record, {}, { clear: ["customCustodian"] });
  record.id = randomUUID();
  await operations.apply({ ...options("clear-reference"), writes: [update] });
  expect(
    (await operations.asset.get({ key: key(asset.recordId), asOf }))?.customCustodian,
  ).toBeNull();
  await operations.asset.delete(record, options("record-delete"));
  expect(await operations.asset.get({ key: key(asset.recordId), asOf })).toBeNull();
});

test("rejects mismatched models, forged references, and pending create update targets", async () => {
  const employee = operations.employee.writes.create({ name: "Uncommitted" });
  const asset = operations.asset.writes.create({ title: "Uncommitted" });
  // @ts-expect-error Asset relations require employee references.
  expect(() => operations.asset.writes.create({ title: "Wrong model", owner: asset })).toThrow(
    "matching",
  );
  // @ts-expect-error Pending creates are not existing update targets.
  expect(() => operations.asset.writes.update(asset, { title: "Invalid update" })).toThrow(
    "matching",
  );
  // @ts-expect-error Pending creates are not existing delete targets.
  expect(() => operations.asset.writes.delete(asset)).toThrow("matching");
  expect(() =>
    operations.asset.writes.create({ title: "Copied handle", owner: { ...employee } }),
  ).toThrow();
  const [record] = await operations.employee.list({ asOf });
  expect(record).toBeDefined();
  expect(() =>
    operations.asset.writes.create({ title: "Copied record", owner: { ...record! } }),
  ).toThrow();
  // @ts-expect-error Existing targets must match the model.
  expect(() => operations.asset.writes.delete(record!)).toThrow("matching");
  expect(() =>
    // @ts-expect-error Plain objects are not generated references.
    operations.asset.writes.create({ title: "Forged", owner: { id: randomUUID() } }),
  ).toThrow();
  // @ts-expect-error The nested-input API is removed.
  expect(() => operations.asset.writes.create({ values: { title: "Old API" } })).toThrow();
});

test("references retain scope and schema provenance without granting authorization", async () => {
  const context = runtime.dataContext({
    actorId: "test",
    sourceKind: "human",
    authorize: async () => {},
  });
  const otherTenant = createOperations({
    ...context,
    scope: { ...context.scope, customerId: "other" },
  });
  const otherApp = createOperations({ ...context, scope: { ...context.scope, appId: "other" } });
  const otherSchema = createDataClient({ ...definition, schemaVersion: "other" }, context);
  for (const source of [otherTenant, otherApp]) {
    const owner = source.employee.writes.create({ name: "Foreign" });
    expect(() => operations.asset.writes.create({ title: "Foreign", owner })).toThrow("matching");
    await expect(
      operations.apply({ ...options("foreign-batch"), writes: [owner] }),
    ).rejects.toThrow("generated builder");
  }
  const wrongSchema = otherSchema.employee.writes.create({ name: "Foreign schema" });
  expect(() =>
    // @ts-expect-error References retain their generated schema type.
    operations.asset.writes.create({ title: "Foreign schema", owner: wrongSchema }),
  ).toThrow("matching");
  const [owner] = await operations.employee.list({ asOf });
  const denied = createOperations({
    ...context,
    authorize: async () => {
      throw new Error("forbidden");
    },
  });
  await expect(
    denied.asset.create({ title: "Denied reference", owner: owner! }, options("denied-reference")),
  ).rejects.toThrow("forbidden");
});
