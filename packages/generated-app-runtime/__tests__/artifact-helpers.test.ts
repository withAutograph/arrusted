import { expect, test } from "vitest";
import { createArtifactHelpers } from "../artifact-helpers";

const hcIds = {
  models: ["employee"],
  fields: { employee: ["name", "score", "pay"] },
  enumOptions: {},
  changeTypes: [],
  constraints: [],
} as const;
const vendorIds = {
  models: ["vendor"],
  fields: { vendor: ["name", "default_chart_account"] },
  enumOptions: {},
  changeTypes: [],
  constraints: [],
} as const;
const hc = createArtifactHelpers({
  appId: "fixture-hc",
  schemaVersion: "fixture-v1",
  staticIds: hcIds,
  models: [
    {
      id: "employee",
      fields: [
        { id: "name", type: "text" },
        { id: "score", type: "number" },
        { id: "pay", type: "money_rate" },
      ],
    },
  ],
});
const vendor = createArtifactHelpers({
  appId: "fixture-vendor",
  schemaVersion: "fixture-v1",
  staticIds: vendorIds,
  models: [{ id: "vendor", fields: [{ id: "name", type: "text" }] }],
});
type HcFieldId<M extends keyof typeof hcIds.fields> = (typeof hcIds.fields)[M][number];
type VendorFieldId<M extends keyof typeof vendorIds.fields> = (typeof vendorIds.fields)[M][number];

const hcField: HcFieldId<"employee"> = "name";
const vendorField: VendorFieldId<"vendor"> = "name";
// @ts-expect-error Vendor-only fields must not be accepted by HC.
const invalidHcField: HcFieldId<"employee"> = "default_chart_account";
void invalidHcField;

test("artifact helpers retain test-owned artifact IDs", () => {
  expect(hcIds.models).toContain("employee");
  expect(vendorIds.models).toContain("vendor");
  expect(hcIds.fields.employee).toContain(hcField);
  expect(vendorIds.fields.vendor).toContain(vendorField);
  expect(
    hc.dataQuery({
      kind: "list",
      model_id: "employee",
      customer_id: "tenant",
      as_of: "2026-09-28",
      select: ["name"],
    }),
  ).toEqual({
    kind: "list",
    model_id: "employee",
    customer_id: "tenant",
    as_of: "2026-09-28",
    select: ["name"],
    app_id: "fixture-hc",
    schema_version: expect.any(String),
  });
  expect(
    vendor.dataQuery({
      kind: "list",
      model_id: "vendor",
      customer_id: "tenant",
      as_of: "2026-09-28",
      select: ["name"],
    }).model_id,
  ).toBe("vendor");
  expect(hc.value.record(hc.recordId("00000000-0000-0000-0000-000000000001"))).toEqual({
    type: "record_id",
    value: "00000000-0000-0000-0000-000000000001",
  });
  expect(() => hc.recordId("employee-1")).toThrow(TypeError);
  expect(
    hc.runtimeValue(
      hc.runtimeModelId("tenant_model"),
      hc.runtimeFieldId("tenant_field"),
      hc.value.text("x"),
    ),
  ).toEqual({
    model_id: "tenant_model",
    field_id: "tenant_field",
    value: { type: "text", value: "x" },
  });
});

test("schema-admin builders preserve the generated SQL function and request", () => {
  const request = {
    customer_id: "tenant",
    actor_id: "admin",
    reason: "Add a field",
    idempotency_key: "request-1",
    expected_revision_id: vendor.schemaRevisionId("42"),
    expected_effective_hash: "a".repeat(64),
    operations: [{ kind: "add_field" }],
  };
  expect(vendor.schemaAdmin.dryRunTenantSchemaRevision(request)).toEqual({
    function: "kernel_dry_run_tenant_schema_revision",
    request: { ...request, app_id: "fixture-vendor" },
  });
  expect(vendor.schemaAdmin.commitTenantSchemaRevision(request).function).toBe(
    "kernel_commit_tenant_schema_revision",
  );
  expect(() => vendor.schemaRevisionId("0")).toThrow(TypeError);
});

test("artifact helpers forward aggregate operands and attach artifact scope", () => {
  expect(
    hc.dataQuery({
      kind: "aggregate",
      model_id: "employee",
      customer_id: "tenant",
      as_of: "2026-10-24",
      group_by: ["name"],
      metrics: [{ fn: "count" }],
    }),
  ).toEqual({
    kind: "aggregate",
    model_id: "employee",
    customer_id: "tenant",
    as_of: "2026-10-24",
    group_by: ["name"],
    metrics: [{ fn: "count" }],
    app_id: "fixture-hc",
    schema_version: "fixture-v1",
  });
});

function aggregateTypeChecks() {
  const base = {
    kind: "aggregate",
    model_id: "employee",
    customer_id: "tenant",
    as_of: "2026-10-24",
    metrics: [{ fn: "count" }],
  } as const;
  hc.dataQuery({ ...base, group_by: [] } as const);
  hc.dataQuery({ ...base, group_by: [{ field: "score", bins: { edges: ["0", "1"] } }] } as const);
  hc.dataQuery({
    ...base,
    group_by: [
      { field: "pay", bins: { edges: ["0", "1"] }, unit: { currency: "USD", period: "annual" } },
    ],
  } as const);
  hc.dataQuery({
    ...base,
    group_by: ["name", "score"],
    metrics: [
      base.metrics[0],
      base.metrics[0],
      base.metrics[0],
      base.metrics[0],
      base.metrics[0],
      base.metrics[0],
      base.metrics[0],
      base.metrics[0],
    ],
  } as const);
  hc.dataQuery({
    kind: "list",
    model_id: "employee",
    customer_id: "tenant",
    as_of: base.as_of,
    limit: 1,
    offset: 1,
  });
  // @ts-expect-error pagination is list-only
  hc.dataQuery({ ...base, limit: 1 } as const);
  // @ts-expect-error pagination is list-only
  hc.dataQuery({ ...base, offset: 1 } as const);
  // @ts-expect-error at most two group dimensions
  hc.dataQuery({ ...base, group_by: ["name", "name", "name"] } as const);
  // @ts-expect-error at least one metric
  hc.dataQuery({ ...base, metrics: [] } as const);
  const count = { fn: "count" } as const;
  hc.dataQuery({
    ...base,
    // @ts-expect-error at most eight metrics
    metrics: [count, count, count, count, count, count, count, count, count],
  } as const);
  hc.dataQuery({
    ...base,
    group_by: [
      // @ts-expect-error numeric bins cannot carry a money unit
      { field: "score", bins: { edges: ["0", "1"] }, unit: { currency: "USD", period: "annual" } },
    ],
  } as const);
  // @ts-expect-error money bins require a unit
  hc.dataQuery({ ...base, group_by: [{ field: "pay", bins: { edges: ["0", "1"] } }] } as const);
  hc.dataQuery({
    ...base,
    // @ts-expect-error money unit requires currency
    group_by: [{ field: "pay", bins: { edges: ["0", "1"] }, unit: { period: "annual" } }],
  } as const);
  hc.dataQuery({
    ...base,
    group_by: [
      // @ts-expect-error money unit uses the contract period union
      { field: "pay", bins: { edges: ["0", "1"] }, unit: { currency: "USD", period: "yearly" } },
    ],
  } as const);
}
void aggregateTypeChecks;
