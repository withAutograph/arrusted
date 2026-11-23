import { expect, test } from "vite-plus/test";
import { KernelFailure } from "../../kernel-client/postgres";
import { createOperations } from "./asset-operations.generated";

const operations = createOperations({
  scope: { appId: "asset-register", customerId: "error-security-proof" },
  authorize: async () => {
    throw new Error("Mapping errors must not authorize");
  },
  transaction: async () => {
    throw new Error("Mapping errors must not access persistence");
  },
});
const fields = ["title", "cost"] as const;
const secret = "private SQL credential customer-123 /srv/internal/file.sql";

// The runtime boundary accepts unknown failures, including malformed transport data.
test.each(
  [
    null,
    undefined,
    false,
    42,
    secret,
    [],
    {},
    { code: "invalid_input", message: secret },
    new Error(`contract_validation_failed: ${secret}`),
    new Error(`unique_field_conflict: ${secret}`),
  ].map((error) => ({ error })),
)("unknown failure %# is not turned into a form result", ({ error }) => {
  expect(operations.asset.toFormError(error, { fields })).toBeUndefined();
});

test.each([
  "database_error",
  "schema_drift",
  "idempotency_conflict",
  "record_target_missing",
  "unrecognized_failure",
])("unexpected canonical code %s remains an error-boundary failure", (code) => {
  const error = new KernelFailure({
    code,
    message: secret,
    details: [{ path: "field", code: "invalid_input", message: "cost" }],
  });
  expect(operations.asset.toFormError(error, { fields })).toBeUndefined();
});

test.each(
  [
    null,
    undefined,
    [],
    { code: "authorization_denied" },
    { code: "authorization_denied", message: 42 },
    { code: "authorization_denied", message: secret, details: secret },
    { code: "authorization_denied", message: secret, details: [null] },
    { code: "authorization_denied", message: secret, details: [{ message: secret }] },
  ].map((envelope) => ({ envelope })),
)(
  "malformed canonical envelope %# is neither classified nor thrown by the mapper",
  ({ envelope }) => {
    const error = new KernelFailure({ code: "placeholder", message: secret });
    Object.defineProperty(error, "envelope", { value: envelope });
    expect(operations.asset.toFormError(error, { fields })).toBeUndefined();
  },
);

test("a recognized denial returns only fixed browser-safe details", () => {
  const result = operations.asset.toFormError(
    new KernelFailure({
      code: "authorization_denied",
      message: secret,
      details: [{ path: secret, code: "authorization_denied", message: secret }],
    }),
    { fields },
  );
  expect(result).toMatchObject({ ok: false, code: "forbidden", fieldErrors: {} });
  expect(JSON.stringify(result)).not.toContain(secret);
});

test.each([
  { constraint: "unknown_constraint", field: "cost" },
  { constraint: "asset_cost_nonnegative", field: "title" },
])("constraint $constraint cannot attribute unrelated field $field", ({ constraint, field }) => {
  const error = new KernelFailure({
    code: "constraint_violation",
    message: secret,
    details: [
      { path: "model", code: "constraint_violation", message: "asset" },
      { path: "constraint", code: "constraint_violation", message: constraint },
      { path: "field", code: "constraint_violation", message: field },
    ],
  });
  expect(operations.asset.toFormError(error, { fields })).toBeUndefined();
});

test("a uniqueness error must identify a declared unique field", () => {
  const error = new KernelFailure({
    code: "unique_field_conflict",
    message: secret,
    details: [
      { path: "model", code: "unique_field_conflict", message: "asset" },
      { path: "field", code: "unique_field_conflict", message: "cost" },
    ],
  });
  expect(operations.asset.toFormError(error, { fields })).toBeUndefined();
});
