import { describe, expect, test } from "vitest";
import { mapImportCsv, readImportCsv } from "../../csv-workspace/mapping";
import { applyRecordImport, prepareRecordImport } from "../records";
import { definition, fakeContext } from "./fixture";

const input = {
  model: "Item",
  asOf: "2026-11-19",
  requestId: "01234567-0123-4012-8012-012345678901",
  rows: [{ values: { Owner: "Jane", Score: "12", Stage: "Planned" } }],
};
describe("record entry and mapped CSV use the ordinary write contract", () => {
  test("typed fields, aliases and stable record IDs", () => {
    const first = prepareRecordImport(definition, input);
    expect(first.writes).toEqual(prepareRecordImport(definition, input).writes);
    expect(first.writes[0]?.values).toEqual({
      owner: { type: "text", value: "Jane" },
      score: { type: "number", value: "12" },
      stage: { type: "enum", value: "draft" },
    });
    expect(
      prepareRecordImport(definition, { ...input, requestId: "a-new-request-key-1234" }).writes[0]
        ?.new_record_id,
    ).not.toEqual(first.writes[0]?.new_record_id);
  });
  test("quoted CSV, mapping and external keys preserve ordinary upsert subjects", () => {
    const rows = mapImportCsv('key,person,points\r\nrow-1,"Jane, Doe",12\r\nrow-2,Joe,\r\n', {
      key: "$externalKey",
      person: "owner",
      points: "score",
    });
    const { writes } = prepareRecordImport(definition, { ...input, rows });
    expect(writes[0]?.record_key).toEqual({ type: "external_key", value: "row-1" });
    expect(writes[0]?.new_record_id).toBeUndefined();
    expect(writes[0]?.values?.owner).toEqual({ type: "text", value: "Jane, Doe" });
    expect(writes[1]?.values).toEqual({ owner: { type: "text", value: "Joe" } });
  });
  test("refuses duplicate and empty keys, duplicate destinations, malformed dates, oversized imports", () => {
    expect(() =>
      mapImportCsv("key,name\na,Jane\na,Joe", { key: "$externalKey", name: "owner" }),
    ).toThrow(/duplicate external key/);
    expect(() => mapImportCsv("key,name\n,Jane", { key: "$externalKey", name: "owner" })).toThrow(
      /empty/,
    );
    expect(() => mapImportCsv("one,two\na,b", { one: "owner", two: "owner" })).toThrow(/only once/);
    expect(() => readImportCsv("name\n" + "Jane\n".repeat(101))).toThrow();
    expect(() => prepareRecordImport(definition, { ...input, asOf: "2026-02-30" })).toThrow();
    expect(() =>
      prepareRecordImport(definition, { ...input, rows: [{ values: { Owner: "a", owner: "b" } }] }),
    ).toThrow(/more than once/);
  });
  test("preview and apply share writes, actor and reviewed schema; input never supplies trusted scope", async () => {
    const fake = fakeContext(({ operation }) =>
      operation === "kernel_read_active_schema_revision"
        ? { schema_revision_id: "12" }
        : { id: 42 },
    );
    await applyRecordImport(definition, fake.context, input, { preview: true });
    await applyRecordImport(definition, fake.context, input, { schemaRevisionId: "12" });
    const calls = fake.calls.filter(
      (call) => call.operation !== "kernel_read_active_schema_revision",
    );
    expect(calls.map((call) => call.operation)).toEqual([
      "kernel_validate_change_set_dry_run",
      "kernel_apply_change_set",
    ]);
    expect(calls[0]?.input).toEqual(calls[1]?.input);
    expect(calls[1]?.input).toMatchObject({
      actor_id: "human",
      source_kind: "agent",
      schema_revision_id: "12",
      mode: "mainline",
    });
    expect(fake.capabilities).toEqual(["item.create", "item.create"]);
  });
});

test("MCP proposals return review input and never invoke a canonical write", async () => {
  const { createWorkSessionToolCore } = await import("../core");
  const { header, sessionId } = await import("./fixture");
  const fake = fakeContext(() => ({ ...header, as_of: "2026-11-19", overlay: [] }));
  const core = createWorkSessionToolCore(definition);
  for (const [id, args] of [
    ["propose_records", { rows: [{ values: { Owner: "Jane" } }] }],
    [
      "import_csv",
      { csv: "person,key\nJane,key-1", mapping: { person: "Owner", key: "$externalKey" } },
    ],
  ] as const) {
    const result = await core.call(
      id,
      { session_id: sessionId, model: "Item", ...args },
      { context: fake.context, conversationId: "chat", callId: id },
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        persisted: false,
        proposal: { model: "item", asOf: "2026-11-19", rows: [{ values: { owner: "Jane" } }] },
      },
    });
  }
  expect(
    fake.calls.every(
      (call) => call.operation === "kernel_work_session" && call.input.operation === "get",
    ),
  ).toBe(true);
});

test("record tools resolve a renamed table by its primary name and retained alias", () => {
  const renamed = {
    ...definition,
    models: [{ ...definition.models[0], name: "task", label: "Task", aliases: ["ticket"] }],
  };
  for (const model of ["Task", "task", "ticket", "item"]) {
    expect(prepareRecordImport(renamed, { ...input, model }).model.id).toBe("item");
  }
});
