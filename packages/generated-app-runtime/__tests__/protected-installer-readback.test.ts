import type { PoolClient } from "pg";
import { expect, test } from "vite-plus/test";
import {
  classifyGeneratedInstallReconciliation,
  classifyGeneratedInstallReadback,
  classifyGeneratedPredecessorReadback,
  withProtectedAppCatalogReadback,
  withProtectedTenantReadback,
} from "../protected-installer-readback";

function scopedClient() {
  const state: {
    transaction: boolean;
    appId: string | null;
    customerId: string | null;
    catalogRead: boolean;
  } = { transaction: false, appId: null, customerId: null, catalogRead: false };
  const client = {
    async query(sql: string, values: unknown[] = []) {
      const query = sql.trim().toLowerCase();
      if (query === "begin read only") {
        state.transaction = true;
        return { rows: [], rowCount: 0 };
      }
      if (query.includes("set_config('kernel.app_id'")) {
        if (!state.transaction) throw new Error("scope outside transaction");
        state.appId = String(values[0]);
        state.customerId = query.includes("set_config('kernel.customer_id',''")
          ? ""
          : String(values[1]);
        state.catalogRead = query.includes("set_config('kernel.schema_catalog_read','on'");
        return { rows: [], rowCount: 1 };
      }
      if (query === "select tenant-visible") {
        const visible =
          state.transaction && state.appId === values[0] && state.customerId === values[1];
        return { rows: visible ? [{ customer_id: values[1] }] : [], rowCount: visible ? 1 : 0 };
      }
      if (query === "select catalog-visible") {
        const allowed = values[1] as string[];
        const visible = state.transaction && state.catalogRead && state.appId === values[0];
        return {
          rows: visible ? allowed.map((customer_id) => ({ customer_id })) : [],
          rowCount: visible ? allowed.length : 0,
        };
      }
      if (query === "rollback") {
        state.transaction = false;
        state.appId = null;
        state.customerId = null;
        state.catalogRead = false;
        return { rows: [], rowCount: 0 };
      }
      throw new Error("unexpected test query");
    },
  };
  return { client: client as unknown as PoolClient, state };
}

test("tenant readback context is visible only during its short read and is rolled back on failure", async () => {
  const { client, state } = scopedClient();
  const visible = await withProtectedTenantReadback(client, "app-a", "org-a", async () => {
    const result = await client.query<{ customer_id: string }>("select tenant-visible", [
      "app-a",
      "org-a",
    ]);
    return result.rows;
  });
  expect(visible).toEqual([{ customer_id: "org-a" }]);
  expect(state).toEqual({
    transaction: false,
    appId: null,
    customerId: null,
    catalogRead: false,
  });

  await expect(
    withProtectedTenantReadback(client, "app-a", "org-a", async () => {
      throw new Error("read failed");
    }),
  ).rejects.toThrow("read failed");
  expect(state.transaction).toBe(false);
  expect(state.appId).toBeNull();
  expect(state.customerId).toBeNull();
});

test("catalog readback resets the app metadata scope after reading the requested target set", async () => {
  const { client, state } = scopedClient();
  const approved = ["org-a", "org-b"];
  const visible = await withProtectedAppCatalogReadback(client, "app-a", async () => {
    const result = await client.query<{ customer_id: string }>("select catalog-visible", [
      "app-a",
      approved,
    ]);
    return result.rows.map((row) => row.customer_id);
  });
  expect(visible).toEqual(approved);
  expect(state).toEqual({
    transaction: false,
    appId: null,
    customerId: null,
    catalogRead: false,
  });
});

test("install readback recognizes exact resumable revisions without treating them as applied", () => {
  const exactPrepared: Parameters<typeof classifyGeneratedInstallReadback>[0] = {
    version: "release-1",
    base_schema_matches: true,
    overlay_empty: true,
    schema_matches: true,
    schema_hash_matches: true,
    revision_inactive: true,
    materialization_pending: true,
    release_id: "release-1",
    activation_kind: "app_base",
    base_artifact_hash: "a".repeat(64),
    effective_artifact_hash: "a".repeat(64),
    materialization_plan_hash: "b".repeat(64),
    seed_change_sets_empty: true,
    phase_plan_empty: true,
    ready_at: null,
    installation_inactive: true,
  };
  const classify = (row: Parameters<typeof classifyGeneratedInstallReadback>[0]) =>
    classifyGeneratedInstallReadback(row, "release-1", "a".repeat(64), "b".repeat(64));

  expect(classify(exactPrepared)).toBe("prepared");
  expect(
    classify({
      ...exactPrepared,
      materialization_pending: false,
      ready_at: new Date("2026-10-16T00:00:00Z"),
    }),
  ).toBe("prepared");
  expect(
    classify({
      ...exactPrepared,
      revision_inactive: false,
      materialization_pending: false,
      ready_at: new Date("2026-10-16T00:00:00Z"),
      installation_inactive: false,
    }),
  ).toBe("applied");
  expect(classify({ ...exactPrepared, effective_artifact_hash: "c".repeat(64) })).toBe("conflict");
  expect(classify({ ...exactPrepared, version: "other-release" })).toBe("conflict");
});

test("reconciliation retries only exact prepared revisions or missing managed completion phases", () => {
  expect(classifyGeneratedInstallReconciliation(["prepared"], false)).toBe("retryable");
  expect(classifyGeneratedInstallReconciliation(["applied", "prepared"], false)).toBe("retryable");
  expect(classifyGeneratedInstallReconciliation(["applied"], true)).toBe("retryable");
  expect(classifyGeneratedInstallReconciliation(["missing"], false)).toBe("incomplete");
  expect(classifyGeneratedInstallReconciliation(["applied", "missing"], false)).toBe("incomplete");
  expect(classifyGeneratedInstallReconciliation(["applied"], false)).toBe("applied");
});

test("verified new tenants resume without turning missing or conflicting tenants into new installs", () => {
  expect(classifyGeneratedInstallReconciliation(["new-tenant"], false)).toBe("retryable");
  expect(classifyGeneratedInstallReconciliation(["applied", "new-tenant"], false)).toBe(
    "retryable",
  );
  expect(classifyGeneratedInstallReconciliation(["prepared", "new-tenant"], true)).toBe(
    "retryable",
  );
  for (const states of [
    ["prepared", "missing"],
    ["new-tenant", "missing"],
    ["applied", "new-tenant", "missing"],
  ] as const) {
    expect(classifyGeneratedInstallReconciliation([...states], true)).toBe("incomplete");
  }
  expect(classifyGeneratedInstallReconciliation([], true)).toBe("incomplete");
});

// Only exact manifest-declared predecessor readback can enter this state; it is
// distinct from a missing or conflicting tenant and cannot make either safe.
test("mixed current and supported predecessor tenants resume while unknown state dominates", () => {
  expect(
    classifyGeneratedInstallReconciliation(["applied", "applied", "supported-predecessor"], false),
  ).toBe("retryable");
  expect(classifyGeneratedInstallReconciliation(["supported-predecessor"], false)).toBe(
    "retryable",
  );
  expect(
    classifyGeneratedInstallReconciliation(["applied", "supported-predecessor", "missing"], true),
  ).toBe("incomplete");
});

test("only exact ready active managed predecessors permit normal upgrade, independently of historical phase metadata", () => {
  const predecessor = {
    version: "fixture-v1",
    base_schema_matches: true,
    overlay_empty: true,
    schema_matches: true,
    schema_hash_matches: true,
    revision_inactive: false,
    materialization_pending: false,
    release_id: "fixture-v1",
    activation_kind: "app_base",
    base_artifact_hash: "a".repeat(64),
    effective_artifact_hash: "a".repeat(64),
    ready_at: new Date("2026-10-20T00:00:00Z"),
    installation_inactive: false,
    materialization_plan_hash: "b".repeat(64),
    seed_change_sets_empty: false,
    phase_plan_empty: false,
  };
  expect(classifyGeneratedPredecessorReadback(predecessor)).toBe(true);
  for (const change of [
    { base_schema_matches: false },
    { overlay_empty: false },
    { schema_matches: false },
    { schema_hash_matches: false },
    { revision_inactive: true },
    { materialization_pending: true },
    { release_id: "unrecognized-release" },
    { activation_kind: "tenant_overlay" },
    { effective_artifact_hash: "c".repeat(64) },
    { ready_at: null },
    { installation_inactive: true },
  ])
    expect(classifyGeneratedPredecessorReadback({ ...predecessor, ...change })).toBe(false);
});
