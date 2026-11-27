import { expect, test } from "vitest";
import {
  createDataClient,
  type DataContext,
  type DataDefinition,
} from "@autograph/generated-app-runtime/data";
import { KernelFailure, type PostgresDataContext } from "@autograph/generated-app-runtime/postgres";
import { workSessionEventsResponse } from "../src/policy/verified-data-context";

test("workSessionEventsResponse resolves additive successor schema_version when workSessions is supplied", async () => {
  const sessionId = "10000000-0000-4000-8000-000000000001";
  const scope = { appId: "sunlight", customerId: "sunlight" };
  const v1Def = {
    formatVersion: 1,
    schemaVersion: "v3",
    models: [
      {
        id: "item",
        name: "item",
        fields: [{ id: "label", name: "label", type: "text", required: true, readOnly: false }],
        relations: [],
      },
    ],
  } as const satisfies DataDefinition;

  const dataContext: DataContext = {
    scope,
    authorize: async () => {},
    transaction: (run) =>
      run({
        actorId: "alice",
        sourceKind: "human",
        call: async (operation: string, input: Record<string, unknown>) => {
          if (operation === "kernel_read_active_schema_revision") {
            return {
              schema_revision_id: "4",
              effective_hash: "b".repeat(64),
              schema: {
                app_id: scope.appId,
                customer_id: scope.customerId,
                version: "v4",
                models: [
                  {
                    id: "item",
                    fields: [
                      { id: "label", type: "text", required: true },
                      { id: "note", type: "text", required: false },
                    ],
                  },
                ],
              },
            };
          }
          if (operation === "kernel_read_runtime_release_observability") {
            return {
              releases: [
                {
                  schema_revision_id: 3,
                  effective_revision: "v3",
                  base_revision: "v3",
                  release_id: "v3",
                  timestamps: { ready_at: "2026-11-13T00:00:00Z" },
                },
                {
                  schema_revision_id: 4,
                  effective_revision: "v4",
                  base_revision: "v4",
                  release_id: "v4",
                  timestamps: { ready_at: "2026-11-13T01:00:00Z" },
                },
              ],
            };
          }
          if (operation === "kernel_work_session") {
            if (input.schema_version !== "v4") {
              throw new KernelFailure({
                code: "schema_drift",
                message: "Schema drift detected",
              });
            }
            return {
              id: sessionId,
              owner_id: "alice",
              title: "Session",
              as_of: "2026-11-26",
              scope: null,
              layout: null,
              pinned: false,
              status: "open",
              revision: 7,
              rules: {},
              threads: {},
            };
          }
          throw new Error(`unexpected ${operation}`);
        },
      }),
  };
  const context = dataContext as unknown as PostgresDataContext;

  let ended = false;
  const abortController = new AbortController();
  const response = await workSessionEventsResponse({
    context,
    schemaVersion: v1Def.schemaVersion,
    workSessions: createDataClient(v1Def, context).workSessions,
    runtime: {
      databaseUrl: "postgres://crm_app:pass@127.0.0.1:5432/sunlight",
      database: "sunlight",
      hostname: "127.0.0.1",
      port: 5432,
      runtimeRole: "crm_app",
      environment: "local",
    },
    sessionId,
    signal: abortController.signal,
    connect: async () => ({
      query: async () => ({}),
      on: () => ({}),
      end: async () => {
        ended = true;
      },
    }),
  });

  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const firstChunk = await reader.read();
  expect(new TextDecoder().decode(firstChunk.value)).toBe("event: revision\ndata: 7\n\n");
  abortController.abort();
  await reader.cancel();
  expect(ended).toBe(true);
});
