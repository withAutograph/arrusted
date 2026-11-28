import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { rewriteRuntimeImports } from "../../../generated-app-runtime/compile-schema";
import type { DataDefinition } from "../../../generated-app-runtime/data";
import { KernelFailure } from "../../../generated-app-runtime/postgres";
import type { GeneratedAppRuntime } from "../../../generated-app-runtime/server";
import { runCoreCli } from "../src/cli";
import { nextAppConfig } from "../src/next";
import { createAppRoutes, gridSchema, toVisibleRecord } from "../src/routes";

const sampleDefinition: DataDefinition = {
  formatVersion: 1,
  schemaVersion: "0.1.0-alpha.1+deadbeef",
  capabilities: { versionPreconditions: true, authorization: true },
  models: [
    {
      id: "company",
      name: "company",
      label: "Company",
      fields: [
        { id: "name", name: "name", label: "Name", type: "text", required: true, readOnly: false },
        {
          id: "domain",
          name: "domain",
          label: "Domain",
          type: "text",
          required: false,
          readOnly: false,
        },
        {
          id: "legacy_code",
          name: "legacyCode",
          label: "Legacy",
          type: "text",
          required: false,
          readOnly: false,
          lifecycle: "retired",
        },
      ],
      relations: [],
    },
    {
      id: "company_financials",
      name: "companyFinancials",
      label: "Company Financials",
      fields: [
        {
          id: "arr_usd",
          name: "arrUsd",
          label: "ARR (USD)",
          type: "number",
          required: true,
          readOnly: false,
        },
      ],
      relations: [],
    },
  ],
};

const sampleGrants = [
  {
    role: "crm_user",
    model: "company",
    operations: ["read", "create", "update"],
    read_fields: ["$id", "$version", "name", "domain"],
    write_fields: ["name", "domain"],
  },
] as const;

describe("createAppRoutes & gridSchema", () => {
  test("gridSchema filters models and retired fields by role grants", () => {
    const schema = gridSchema(sampleDefinition, {
      appId: "sunlight",
      customerId: "sunlight",
      role: "crm_user",
      grants: sampleGrants,
    });
    expect(schema.models.map((m) => m.id)).toEqual(["company"]);
    expect(schema.models[0]?.fields.map((f) => f.id)).toEqual(["name", "domain"]);
  });

  test("toVisibleRecord encodes decoded ModelRecord fields into tagged FieldValues", () => {
    const record = toVisibleRecord(
      sampleDefinition,
      sampleDefinition.models[0]!,
      {
        id: "11111111-1111-4111-8111-111111111111",
        $version: "22222222-2222-4222-8222-222222222222",
        effectiveStart: "2026-11-27",
        name: "Acme Corp",
        domain: null,
      },
      "2026-11-27",
    );
    expect(record).toEqual({
      record_id: "11111111-1111-4111-8111-111111111111",
      version_id: "22222222-2222-4222-8222-222222222222",
      effective_start: "2026-11-27",
      values: {
        name: { type: "text", value: "Acme Corp" },
      },
      custom_fields: [],
    });
  });

  test("routes enforce session auth, role-scoped reads, and trusted human mainline apply", async () => {
    const calls: Array<{ op: string; input: Record<string, unknown> }> = [];
    const runtime: GeneratedAppRuntime = {
      appId: "sunlight",
      customerId: "sunlight",
      operations: {} as GeneratedAppRuntime["operations"],
      verifyRelease: () => {},
      close: async () => {},
      dataContext: ({ actorId, sourceKind }) => ({
        scope: { appId: "sunlight", customerId: "sunlight" },
        authorize: async () => {},
        requestTransaction: async (run) => run(),
        transaction: async (run) =>
          run({
            actorId,
            sourceKind,
            lockSchemaActivation: async () => {},
            call: async (op, input) => {
              calls.push({ op, input });
              if (op === "kernel_data_query") {
                return [
                  {
                    record_id: "11111111-1111-4111-8111-111111111111",
                    version_id: "22222222-2222-4222-8222-222222222222",
                    values: { name: { type: "text", value: "Acme" } },
                  },
                ];
              }
              if (op === "kernel_apply_change_set") {
                return {
                  change_set_id: 7,
                  mode: "mainline",
                  status: "applied",
                  replayed: false,
                  applied_version_ids: ["33333333-3333-4333-8333-333333333333"],
                };
              }
              throw new KernelFailure({
                code: "bad_request",
                message: "unexpected op",
                details: [],
              });
            },
          }),
      }),
    };

    const routes = createAppRoutes({
      runtime,
      definition: sampleDefinition,
      role: "crm_user",
      grants: sampleGrants,
      session: async (headers) => {
        if (headers.get("x-test-user") !== "alice") {
          throw Object.assign(new Error("Sign in required"), {
            status: 401,
            code: "auth_required",
          });
        }
        return { actorId: "actor-alice", customerId: "sunlight" };
      },
    });

    const unauth = await routes.schemaActiveGET(new Request("http://localhost/api/schema/active"));
    expect(unauth.status).toBe(401);

    const denied = await routes.recordsGET(
      new Request("http://localhost/api/records?model_id=company_financials&as_of=2026-11-27", {
        headers: { "x-test-user": "alice" },
      }),
    );
    expect(denied.status).toBe(403);

    const okRecords = await routes.recordsGET(
      new Request("http://localhost/api/records?model_id=company&as_of=2026-11-27", {
        headers: { "x-test-user": "alice" },
      }),
    );
    expect(okRecords.status).toBe(200);
    const recordsBody = await okRecords.json();
    expect(recordsBody).toHaveLength(1);
    expect(calls[0]?.input.select).toEqual(["$id", "$version", "name", "domain"]);

    const nullWriteRes = await routes.applyPOST(
      new Request("http://localhost/api/apply", {
        method: "POST",
        headers: { "x-test-user": "alice", "content-type": "application/json" },
        body: JSON.stringify({ idempotency_key: "idem-null", writes: [null] }),
      }),
    );
    expect(nullWriteRes.status).toBe(400);

    const applyRes = await routes.applyPOST(
      new Request("http://localhost/api/apply", {
        method: "POST",
        headers: { "x-test-user": "alice", "content-type": "application/json" },
        body: JSON.stringify({
          app_id: "spoofed",
          customer_id: "spoofed",
          actor_id: "spoofed",
          source_kind: "agent",
          mode: "draft",
          change_type_id: "undeclared_client_default",
          idempotency_key: "idem-1",
          writes: [
            {
              model_id: "company",
              effective_start: "2026-11-27",
              values: { name: { type: "text", value: "Beta Inc" } },
            },
          ],
        }),
      }),
    );
    expect(applyRes.status).toBe(200);
    const applyCall = calls.find((c) => c.op === "kernel_apply_change_set");
    expect(applyCall?.input).toMatchObject({
      actor_id: "actor-alice",
      source_kind: "human",
      mode: "mainline",
      idempotency_key: "idem-1",
    });
    expect(applyCall?.input).not.toHaveProperty("change_type_id");
    const submittedWrites = applyCall?.input.writes as Array<{ new_record_id?: string }>;
    expect(submittedWrites[0]?.new_record_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });

  test("loads grants from app-artifact.json extras.authorization_policy.grants", async () => {
    const tmpRelease = mkdtempSync(path.join(tmpdir(), "routes-artifact-test-"));
    try {
      writeFileSync(
        path.join(tmpRelease, "app-artifact.json"),
        JSON.stringify({
          schema: { change_types: [{ id: "declared_change", label: "Declared" }] },
          extras: { authorization_policy: { grants: sampleGrants } },
        }),
      );
      const runtime: GeneratedAppRuntime = {
        appId: "sunlight",
        customerId: "sunlight",
        operations: {} as GeneratedAppRuntime["operations"],
        verifyRelease: () => {},
        close: async () => {},
        dataContext: () => ({
          scope: { appId: "sunlight", customerId: "sunlight" },
          authorize: async () => {},
          requestTransaction: async (run) => run(),
          transaction: async () => {
            throw new Error("should not reach DB on unauthorized model");
          },
        }),
      };
      const routes = createAppRoutes({
        runtime,
        definition: sampleDefinition,
        releaseDirectory: tmpRelease,
        role: "crm_user",
        session: async () => ({ actorId: "actor-1", customerId: "sunlight" }),
      });

      const schemaRes = await routes.schemaActiveGET(
        new Request("http://localhost/api/schema/active"),
      );
      const { schema } = (await schemaRes.json()) as {
        schema: { models: Array<{ id: string }>; change_types: Array<{ id: string }> };
      };
      expect(schema.models.map((m) => m.id)).toEqual(["company"]);
      expect(schema.change_types.map((c) => c.id)).toEqual(["declared_change"]);

      const deniedRes = await routes.recordsGET(
        new Request("http://localhost/api/records?model_id=company_financials&as_of=2026-11-27"),
      );
      expect(deniedRes.status).toBe(403);
    } finally {
      rmSync(tmpRelease, { recursive: true, force: true });
    }
  });

  test("policy-enabled schemas fail closed when role, grants, or $id grant are missing or empty", async () => {
    const emptyRelease = mkdtempSync(path.join(tmpdir(), "routes-missing-artifact-"));
    const prevEnvRole = process.env.APP_KERNEL_ROLE;
    delete process.env.APP_KERNEL_ROLE;
    try {
      const runtime: GeneratedAppRuntime = {
        appId: "sunlight",
        customerId: "sunlight",
        operations: {} as GeneratedAppRuntime["operations"],
        verifyRelease: () => {},
        close: async () => {},
        dataContext: () => ({
          scope: { appId: "sunlight", customerId: "sunlight" },
          authorize: async () => {},
          requestTransaction: async (run) => run(),
          transaction: async () => {
            throw new Error("must fail closed before querying DB");
          },
        }),
      };

      const noRoleRoutes = createAppRoutes({
        runtime,
        definition: sampleDefinition,
        grants: sampleGrants,
        session: async () => ({ actorId: "actor-1", customerId: "sunlight" }),
      });
      expect(
        (await noRoleRoutes.schemaActiveGET(new Request("http://localhost/api/schema/active")))
          .status,
      ).toBe(403);
      expect(
        (
          await noRoleRoutes.recordsGET(
            new Request("http://localhost/api/records?model_id=company&as_of=2026-11-27"),
          )
        ).status,
      ).toBe(403);

      const missingArtifactRoutes = createAppRoutes({
        runtime,
        definition: sampleDefinition,
        releaseDirectory: emptyRelease,
        role: "crm_user",
        session: async () => ({ actorId: "actor-1", customerId: "sunlight" }),
      });
      expect(
        (
          await missingArtifactRoutes.schemaActiveGET(
            new Request("http://localhost/api/schema/active"),
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await missingArtifactRoutes.recordsGET(
            new Request("http://localhost/api/records?model_id=company&as_of=2026-11-27"),
          )
        ).status,
      ).toBe(403);

      const emptyGrantsRoutes = createAppRoutes({
        runtime,
        definition: sampleDefinition,
        role: "crm_user",
        grants: [],
        session: async () => ({ actorId: "actor-1", customerId: "sunlight" }),
      });
      const emptySchemaRes = await emptyGrantsRoutes.schemaActiveGET(
        new Request("http://localhost/api/schema/active"),
      );
      expect(emptySchemaRes.status).toBe(200);
      const emptySchemaBody = (await emptySchemaRes.json()) as {
        schema: { models: Array<{ id: string }> };
      };
      expect(emptySchemaBody.schema.models).toEqual([]);
      expect(
        (
          await emptyGrantsRoutes.recordsGET(
            new Request("http://localhost/api/records?model_id=company&as_of=2026-11-27"),
          )
        ).status,
      ).toBe(403);

      const missingIdGrantRoutes = createAppRoutes({
        runtime,
        definition: sampleDefinition,
        role: "crm_user",
        grants: [
          {
            role: "crm_user",
            model: "company",
            operations: ["read"],
            read_fields: ["name"],
          },
        ],
        session: async () => ({ actorId: "actor-1", customerId: "sunlight" }),
      });
      const missingIdSchemaRes = await missingIdGrantRoutes.schemaActiveGET(
        new Request("http://localhost/api/schema/active"),
      );
      expect(missingIdSchemaRes.status).toBe(200);
      const missingIdSchemaBody = (await missingIdSchemaRes.json()) as {
        schema: { models: Array<{ id: string }> };
      };
      expect(missingIdSchemaBody.schema.models).toEqual([]);
      expect(
        (
          await missingIdGrantRoutes.recordsGET(
            new Request("http://localhost/api/records?model_id=company&as_of=2026-11-27"),
          )
        ).status,
      ).toBe(403);
    } finally {
      if (prevEnvRole === undefined) delete process.env.APP_KERNEL_ROLE;
      else process.env.APP_KERNEL_ROLE = prevEnvRole;
      rmSync(emptyRelease, { recursive: true, force: true });
    }
  });

  test("excludes custom-storage fields, preserves unconditional row visibility, forwards schema_revision_id, keeps create UUIDs stable across upgrades, and sanitizes 500 errors", async () => {
    const defWithCustom: DataDefinition = {
      ...sampleDefinition,
      models: [
        {
          ...sampleDefinition.models[0]!,
          fields: [
            ...sampleDefinition.models[0]!.fields,
            {
              id: "internal_notes",
              name: "internalNotes",
              label: "Internal Notes",
              type: "text",
              required: false,
              readOnly: false,
            },
            {
              id: "serial",
              name: "serial",
              label: "Serial",
              type: "text",
              storage: "custom",
              required: false,
              readOnly: false,
            },
          ],
        },
      ],
    };

    const mixedGrants = [
      {
        role: "crm_user",
        model: "company",
        operations: ["read"],
        record: { kind: "all" },
        read_fields: ["$id", "$version", "name", "serial"],
      },
      {
        role: "crm_user",
        model: "company",
        operations: ["read"],
        record: { kind: "actor_equals_field", field: "owner_id" },
        read_fields: ["$id", "internal_notes"],
      },
    ] as const;

    const schema = gridSchema(defWithCustom, {
      role: "crm_user",
      grants: mixedGrants,
    });
    expect(schema.models[0]?.fields.map((f) => f.id)).toEqual(["name"]);

    const applyPayloads: Array<Record<string, unknown>> = [];
    const makeRuntime = (failDb = false): GeneratedAppRuntime => ({
      appId: "sunlight",
      customerId: "sunlight",
      operations: {} as GeneratedAppRuntime["operations"],
      verifyRelease: () => {},
      close: async () => {},
      dataContext: ({ actorId, sourceKind }) => ({
        scope: { appId: "sunlight", customerId: "sunlight" },
        authorize: async () => {},
        requestTransaction: async (run) => run(),
        transaction: async (run) =>
          run({
            actorId,
            sourceKind,
            lockSchemaActivation: async () => {},
            call: async (op, input) => {
              if (failDb) throw new Error("FATAL: relation company_record secret details");
              if (op === "kernel_apply_change_set") {
                applyPayloads.push(input);
                return {
                  change_set_id: 1,
                  mode: "mainline",
                  status: "applied",
                  replayed: false,
                  applied_version_ids: [],
                };
              }
              return [];
            },
          }),
      }),
    });

    const routesV1 = createAppRoutes({
      runtime: makeRuntime(),
      definition: { ...defWithCustom, schemaVersion: "build-v1" },
      role: "crm_user",
      grants: mixedGrants,
      session: async () => ({ actorId: "actor-1", customerId: "sunlight" }),
    });
    const routesV2 = createAppRoutes({
      runtime: makeRuntime(),
      definition: { ...defWithCustom, schemaVersion: "build-v2" },
      role: "crm_user",
      grants: mixedGrants,
      session: async () => ({ actorId: "actor-1", customerId: "sunlight" }),
    });

    const body = JSON.stringify({
      idempotency_key: "stable-create-47",
      schema_revision_id: "rev-12",
      writes: [{ model_id: "company", effective_start: "2026-11-27", values: {} }],
    });
    await routesV1.applyPOST(new Request("http://localhost/api/apply", { method: "POST", body }));
    await routesV2.applyPOST(new Request("http://localhost/api/apply", { method: "POST", body }));
    expect(applyPayloads[0]?.schema_revision_id).toBe("rev-12");
    const v1CreateId = (applyPayloads[0]?.writes as Array<{ new_record_id?: string }>)[0]
      ?.new_record_id;
    const v2CreateId = (applyPayloads[1]?.writes as Array<{ new_record_id?: string }>)[0]
      ?.new_record_id;
    expect(v1CreateId).toBeTruthy();
    expect(v1CreateId).toBe(v2CreateId);

    const faultRoutes = createAppRoutes({
      runtime: makeRuntime(true),
      definition: defWithCustom,
      role: "crm_user",
      grants: mixedGrants,
      session: async () => ({ actorId: "actor-1", customerId: "sunlight" }),
    });
    const faultRes = await faultRoutes.applyPOST(
      new Request("http://localhost/api/apply", { method: "POST", body }),
    );
    expect(faultRes.status).toBe(500);
    const faultJson = (await faultRes.json()) as { code: string; message: string };
    expect(faultJson).toEqual({ code: "internal_error", message: "Request failed", details: [] });
  });

  test("recordsGET paginates >50 rows in 100-row pages within one requestTransaction", async () => {
    const allRows = Array.from({ length: 135 }, (_, idx) => {
      const hex = (idx + 1).toString(16).padStart(12, "0");
      return {
        record_id: `00000000-0000-4000-8000-${hex}`,
        version_id: `11111111-1111-4111-8111-${hex}`,
        values: { name: { type: "text", value: `Company ${idx + 1}` } },
      };
    });
    let requestTxCount = 0;
    const queryCalls: Array<Record<string, unknown>> = [];

    const runtime: GeneratedAppRuntime = {
      appId: "sunlight",
      customerId: "sunlight",
      operations: {} as GeneratedAppRuntime["operations"],
      verifyRelease: () => {},
      close: async () => {},
      dataContext: ({ actorId, sourceKind }) => ({
        scope: { appId: "sunlight", customerId: "sunlight" },
        authorize: async () => {},
        requestTransaction: async (run) => {
          requestTxCount += 1;
          return run();
        },
        transaction: async (run) =>
          run({
            actorId,
            sourceKind,
            lockSchemaActivation: async () => {},
            call: async (op, input) => {
              if (op !== "kernel_data_query") throw new Error(`unexpected ${op}`);
              const req = input as {
                limit?: number;
                where?: Array<{ field: string; op: string; value?: string }>;
              };
              queryCalls.push(req);
              const afterId = req.where?.find((w) => w.field === "$id" && w.op === "gt")?.value;
              const filtered = afterId ? allRows.filter((r) => r.record_id > afterId) : allRows;
              return filtered.slice(0, req.limit ?? 50);
            },
          }),
      }),
    };

    const routes = createAppRoutes({
      runtime,
      definition: {
        ...sampleDefinition,
        staticIds: { changeTypes: ["static_edit"] },
      },
      role: "crm_user",
      grants: sampleGrants,
      session: async () => ({ actorId: "actor-alice", customerId: "sunlight" }),
    });

    const res = await routes.recordsGET(
      new Request("http://localhost/api/records?model_id=company&as_of=2026-11-27"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ record_id: string }>;
    expect(body).toHaveLength(135);
    expect(body[0]?.record_id).toBe(allRows[0]!.record_id);
    expect(body[134]?.record_id).toBe(allRows[134]!.record_id);
    expect(requestTxCount).toBe(1);
    expect(queryCalls).toHaveLength(2);
    expect(queryCalls[0]?.limit).toBe(100);
    expect(queryCalls[1]?.where).toEqual([
      { field: "$id", op: "gt", value: allRows[99]!.record_id },
    ]);
  });

  test("nextAppConfig merges caller outputFileTracingIncludes['/*'] with .generated/release", () => {
    const merged = nextAppConfig({
      outputFileTracingIncludes: {
        "/*": ["./custom-assets/**/*"],
        "/api/export": ["./templates/**/*"],
      },
    });
    expect(merged.outputFileTracingIncludes).toEqual({
      "/*": ["./.generated/release/**/*", "./custom-assets/**/*"],
      "/api/export": ["./templates/**/*"],
    });
  });

  test("rewriteRuntimeImports rewrites only emitted runtime import specifiers and preserves model labels", () => {
    const emitted = [
      "import {",
      "  createDataClient,",
      "  type DataDefinition,",
      '} from "@autograph/generated-app-runtime/data";',
      'import { createArtifactHelpers } from "@autograph/generated-app-runtime/artifact-helpers";',
      '/** Model label mentioning "@autograph/generated-app-runtime/data" */',
      'export const definition = { label: "@autograph/generated-app-runtime/data" } as const;',
    ].join("\n");
    const rewritten = rewriteRuntimeImports(emitted, "@arrusted/core");
    expect(rewritten).toContain('from "@arrusted/core/data";');
    expect(rewritten).toContain('from "@arrusted/core/artifact-helpers";');
    expect(rewritten).toContain('label: "@autograph/generated-app-runtime/data"');
    expect(rewritten).toContain('mentioning "@autograph/generated-app-runtime/data"');
  });

  test("runCoreCli migrate:undo rejects explicit --release while allowing plain undo invocation", async () => {
    const prevDbUrl = process.env.MIGRATION_DATABASE_URL;
    process.env.MIGRATION_DATABASE_URL = "not-a-postgres-url";
    try {
      await expect(runCoreCli(["migrate:undo", "--release", "./other"])).rejects.toThrow(
        "--release is not valid with undo.",
      );
      await expect(runCoreCli(["migrate:undo"])).rejects.not.toThrow(
        "--release is not valid with undo.",
      );
    } finally {
      if (prevDbUrl === undefined) delete process.env.MIGRATION_DATABASE_URL;
      else process.env.MIGRATION_DATABASE_URL = prevDbUrl;
    }
  });
});
