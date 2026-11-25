// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createDataClient } from "@autograph/generated-app-runtime/data";
import { mapImportCsv } from "@autograph/csv-workspace/mapping";
import { applyRecordImport, prepareRecordImport } from "../records";
import {
  agent,
  human,
  install,
  startPostgres,
  stopPostgres,
  type InstalledApp,
} from "./postgres-fixture";

let app: InstalledApp;
beforeAll(async () => {
  await startPostgres();
  app = await install("record-import", false);
}, 240_000);
afterAll(stopPostgres, 30_000);
test("member create, CSV preview, apply, dedup/replay, drafts and agent canonical refusal", async () => {
  const context = human(app);
  const data = createDataClient(app.definition, context) as unknown as {
    item: { list(input: unknown): Promise<Record<string, unknown>[]> };
  };
  const list = (includePendingDrafts = false) =>
    data.item.list({ asOf: "2026-11-19", select: ["id", "owner", "score"], includePendingDrafts });
  const input = {
    model: "Item",
    asOf: "2026-11-19",
    requestId: randomUUID(),
    rows: [{ values: { Owner: "Jane", Score: "1" } }],
  };
  const preview = await applyRecordImport(app.definition, context, input, { preview: true });
  expect(await list()).toHaveLength(0);
  const saved = await applyRecordImport(app.definition, context, input, {
    schemaRevisionId: preview.schemaRevisionId,
  });
  expect(await list()).toHaveLength(1);
  expect(
    await applyRecordImport(app.definition, context, input, {
      schemaRevisionId: preview.schemaRevisionId,
    }),
  ).toEqual(saved);

  const mapped = {
    ...input,
    requestId: randomUUID(),
    rows: mapImportCsv("key,person,points\nimport-1,Alex,3\nimport-2,Chris,4", {
      key: "$externalKey",
      person: "owner",
      points: "score",
    }),
  };
  await applyRecordImport(app.definition, context, mapped);
  expect(await list()).toHaveLength(3);
  await applyRecordImport(app.definition, context, {
    ...mapped,
    requestId: randomUUID(),
    rows: mapImportCsv("key,person,points\nimport-1,Alex,5\nimport-2,Chris,6", {
      key: "$externalKey",
      person: "owner",
      points: "score",
    }),
  });
  expect(await list()).toHaveLength(3);
  expect((await list()).find((row) => row.owner === "Alex")?.score).toBe("5");
  await expect(
    applyRecordImport(app.definition, context, {
      ...mapped,
      requestId: randomUUID(),
      rows: [{ values: { Owner: "Okay" } }, { values: { Score: "7" } }],
    }),
  ).rejects.toThrow();
  expect(await list()).toHaveLength(3);

  await applyRecordImport(
    app.definition,
    context,
    { ...input, requestId: randomUUID(), rows: [{ values: { Owner: "Draft" } }] },
    { mode: "draft" },
  );
  expect(await list()).toHaveLength(3);
  expect(await list(true)).toHaveLength(4);
  const handle = await agent(app);
  try {
    // Exercise the kernel boundary directly, not only the narrower tool capability list.
    const agentContext = handle.contextForTurn(randomUUID());
    const writes = prepareRecordImport(app.definition, {
      ...input,
      requestId: randomUUID(),
    }).writes;
    for (const mode of ["mainline", "draft"])
      await expect(
        agentContext.transaction((db) =>
          db.call("kernel_apply_change_set", {
            schema_revision_id: preview.schemaRevisionId,
            actor_id: db.actorId,
            source_kind: db.sourceKind,
            mode,
            idempotency_key: randomUUID(),
            writes,
          }),
        ),
      ).rejects.toThrow(/agent|canonical/i);
  } finally {
    await handle.close();
  }
}, 60_000);
