import { expect, test } from "vite-plus/test";
import { createOperations, definition, type Asset } from "./asset-operations.generated";
import { createDataClient } from "../data";
import { KernelFailure } from "../../kernel-client/postgres";

const formContext = {
  scope: { appId: "asset-register", customerId: "parser-proof" },
  authorize: async () => {
    throw new Error("Parsing must not authorize");
  },
  transaction: async () => {
    throw new Error("Parsing must not access persistence");
  },
};
const operations = createOperations(formContext);
const legacyOperations = createDataClient(
  {
    ...definition,
    constraints: definition.constraints.map((constraint) => ({
      id: constraint.id,
      model: constraint.model,
      authority: constraint.authority,
    })),
  },
  formContext,
);
const capableOperations = createDataClient(
  { ...definition, capabilities: { versionPreconditions: true } as const },
  formContext,
);
const { capabilities: _capabilities, ...legacyDefinition } = definition;
void _capabilities;
const legacyVersionOperations = createDataClient(legacyDefinition, formContext);
const form = (values: Record<string, string>) => {
  const result = new FormData();
  for (const [name, value] of Object.entries(values)) result.set(name, value);
  return result;
};

test("version precondition types distinguish capable records and legacy definitions", () => {
  const proveTypes = async () => {
    const record = await capableOperations.asset.get({
      key: { type: "record_id", value: "00000000-0000-0000-0000-000000000001" },
      asOf: "2026-09-15",
    });
    if (record) {
      capableOperations.asset.writes.update(
        record,
        { title: "Guarded" },
        { ifVersion: record.$version },
      );
      capableOperations.asset.writes.delete(record, { ifVersion: record.$version });
    }

    const exact = await capableOperations.asset.get({
      key: { type: "record_id", value: "00000000-0000-0000-0000-000000000001" },
      asOf: "2026-09-15",
      select: ["id", "$version"] as const,
    });
    if (exact) {
      const version: string = exact.$version;
      void version;
      // @ts-expect-error Version provenance is readonly.
      exact.$version = version;
      // @ts-expect-error Exact selection does not include unselected fields.
      const unselectedTitle = exact.title;
      void unselectedTitle;
    }

    const dynamicFields: readonly ("id" | "$version")[] = ["id", "$version"];
    const dynamic = await capableOperations.asset.get({
      key: { type: "record_id", value: "00000000-0000-0000-0000-000000000001" },
      asOf: "2026-09-15",
      select: dynamicFields,
    });
    if (dynamic) {
      const version: string | undefined = dynamic.$version;
      void version;
    }

    const selected = await capableOperations.asset.get({
      key: { type: "record_id", value: "00000000-0000-0000-0000-000000000001" },
      asOf: "2026-09-15",
      select: ["id", "title", "$version"] as const,
    });
    if (selected) {
      const version: string = selected.$version;
      void version;
      // @ts-expect-error Selected records have no write provenance.
      capableOperations.asset.writes.update(selected, { title: "Rejected" });
    }

    legacyVersionOperations.asset.writes.update(
      "00000000-0000-0000-0000-000000000001",
      { title: "Legacy" },
      // @ts-expect-error Legacy definitions reject version conditions.
      { ifVersion: "00000000-0000-0000-0000-000000000001" },
    );
    capableOperations.asset.writes.create(
      { title: "Created" },
      // @ts-expect-error Creates never accept version conditions.
      { ifVersion: "00000000-0000-0000-0000-000000000001" },
    );
    void legacyVersionOperations.asset.get({
      key: { type: "record_id", value: "00000000-0000-0000-0000-000000000001" },
      asOf: "2026-09-15",
      // @ts-expect-error Legacy definitions cannot select $version.
      select: ["$version"] as const,
    });
  };
  void proveTypes;
});

test("version precondition runtime gates reject legacy, create, and malformed conditions", () => {
  expect(() =>
    legacyVersionOperations.asset.writes.update(
      "00000000-0000-0000-0000-000000000001",
      { title: "Legacy" },
      // @ts-expect-error Runtime gate input is compile-time forbidden for legacy definitions.
      { ifVersion: "00000000-0000-0000-0000-000000000001" },
    ),
  ).toThrow("ifVersion");
  expect(() =>
    capableOperations.asset.writes.create(
      { title: "Create" },
      // @ts-expect-error Creates never accept version conditions.
      { ifVersion: "00000000-0000-0000-0000-000000000001" },
    ),
  ).toThrow("ifVersion");
  expect(() =>
    capableOperations.asset.writes.update(
      "00000000-0000-0000-0000-000000000001",
      { title: "Malformed" },
      { ifVersion: "not-a-uuid" },
    ),
  ).toThrow("record UUID");
});

test("form codecs preserve scalar semantics and custom relation identity", () => {
  const result = operations.asset.parseForm(
    form({
      title: "  clear:null  ",
      cost: "9007199254740993.125",
      active: "false",
      placedOn: "2024-02-29",
      changedAt: "2026-09-15T09:30:00-04:00",
      aliases: '["Alias"]',
      attributes: '{"nested":[null,true]}',
      status: "available",
      country: "US",
      currency: "USD",
      customCustodian: '{"type":"external_key","value":"employee-a"}',
    }),
    {
      fields: [
        "title",
        "cost",
        "active",
        "placedOn",
        "changedAt",
        "aliases",
        "attributes",
        "status",
        "country",
        "currency",
        "customCustodian",
      ],
      mode: "create",
    },
  );
  expect(result.values).toEqual({
    title: "  clear:null  ",
    cost: "9007199254740993.125",
    active: false,
    placedOn: "2024-02-29",
    changedAt: "2026-09-15T09:30:00-04:00",
    aliases: ["Alias"],
    attributes: { nested: [null, true] },
    status: "available",
    country: "US",
    currency: "USD",
    customCustodian: { type: "external_key", value: "employee-a" },
  });
  const status: "available" | "assigned" | undefined = result.values.status;
  const requiredTitle: string = result.values.title;
  expect(requiredTitle).toBe("  clear:null  ");
  expect(status).toBe("available");
});

test.each([
  ["cost", "1e3"],
  ["cost", ""],
  ["active", "on"],
  ["active", "0"],
  ["placedOn", "2023-02-29"],
  ["changedAt", "2026-09-15T09:30:00"],
  ["status", "Available"],
  ["tags", "[1]"],
  ["aliases", '"alias"'],
  ["attributes", "undefined"],
  ["rate", '{"amount":1,"currency":"USD","period":"monthly"}'],
  ["customCustodian", '{"type":"lookup_or_create","value":"employee-a"}'],
] as const)("rejects invalid %s control %s", (field, value) => {
  expect(() =>
    operations.asset.parseForm(form({ [field]: value }), {
      fields: [field],
      mode: "update",
    }),
  ).toThrow();
});

test("clearing is explicit and restricted to selected optional update fields", () => {
  for (const marker of ["false", "", "1"]) {
    expect(() =>
      operations.asset.parseForm(form({ "clear:cost": marker }), {
        fields: ["cost"],
        mode: "update",
      }),
    ).toThrow();
  }
  const duplicate = form({ "clear:cost": "true" });
  duplicate.append("clear:cost", "true");
  expect(() =>
    operations.asset.parseForm(duplicate, { fields: ["cost"], mode: "update" }),
  ).toThrow();
  expect(() =>
    operations.asset.parseForm(form({ "clear:title": "true" }), {
      fields: ["title"],
      mode: "update",
    }),
  ).toThrow();
  expect(() =>
    operations.asset.parseForm(form({ "clear:cost": "true" }), {
      fields: ["cost"],
      mode: "create",
    }),
  ).toThrow();
  expect(
    operations.asset.parseForm(form({ "clear:title": "true", active: "true" }), {
      fields: ["cost", "tags"],
      mode: "update",
    }),
  ).toEqual({ values: {}, clear: [] });
});

test("selectors are nonempty and unique; final create still requires server-owned fields", () => {
  expect(() =>
    operations.asset.parseForm(new FormData(), {
      // @ts-expect-error An empty field tuple is not a parser contract.
      fields: [],
      mode: "update",
    }),
  ).toThrow();
  expect(() =>
    operations.asset.parseForm(new FormData(), {
      fields: ["cost", "cost"],
      mode: "update",
    }),
  ).toThrow();
  const subset = operations.asset.parseForm(form({ cost: "1.25" }), {
    fields: ["cost"],
    mode: "create",
  });
  expect(subset.values).toEqual({ cost: "1.25" });
  operations.asset.writes.create({ ...subset.values, title: "Supplied on server" });
  const proveTypes = () => {
    // @ts-expect-error Selected create inputs do not satisfy omitted required fields.
    operations.asset.writes.create(subset.values);
    // @ts-expect-error Parsed values have no generated-record provenance.
    operations.asset.writes.update(subset.values, { title: "Changed" });
    // @ts-expect-error Unselected fields are absent from the inferred object.
    return subset.values.title;
  };
  void proveTypes;
});

test("read-only fields cannot be selected by the parser", () => {
  const readonlyOperations = createDataClient(
    {
      formatVersion: 1,
      schemaVersion: "readonly-proof",
      models: [
        {
          id: "projection",
          name: "projection",
          relations: [],
          fields: [
            { id: "computed", name: "computed", type: "text", required: false, readOnly: true },
          ],
        },
      ],
    },
    {
      scope: { appId: "readonly-proof", customerId: "parser-proof" },
      authorize: async () => {
        throw new Error("Unexpected authorization");
      },
      transaction: async () => {
        throw new Error("Unexpected persistence");
      },
    },
  );
  expect(() =>
    readonlyOperations.projection.parseForm(form({ computed: "forged" }), {
      // @ts-expect-error Read-only fields are excluded from form selections.
      fields: ["computed"],
      mode: "update",
    }),
  ).toThrow("unsupported form field");
  const proveReadOnlyFormErrorType = () => {
    return readonlyOperations.projection.toFormError(new Error("ignored"), {
      // @ts-expect-error Read-only fields cannot be selected for error attribution either.
      fields: ["computed"] as const,
    });
  };
  void proveReadOnlyFormErrorType;
});

test("retired generated fields cannot be parsed or written", () => {
  expect(() =>
    operations.asset.parseForm(form({ legacyNote: "forged" }), {
      // @ts-expect-error Retired fixture fields are excluded from form selections.
      fields: ["legacyNote"],
      mode: "update",
    }),
  ).toThrow("unsupported form field");
  const proveRetiredRead = (record: Asset) => {
    const legacy: string | null = record.legacyNote;
    // @ts-expect-error Retired fields may be null on read.
    const nonNullableLegacy: string = record.legacyNote;
    void nonNullableLegacy;
    return legacy;
  };
  void proveRetiredRead;
  const proveRetiredSelectedRead = async () => {
    const record = await operations.asset.get({
      key: { type: "record_id", value: "00000000-0000-0000-0000-000000000001" },
      asOf: "2026-09-15",
      select: ["legacyNote"] as const,
    });
    if (record) {
      const legacy: string | null = record.legacyNote;
      // @ts-expect-error Retired selected fields may be null on read.
      const nonNullableLegacy: string = record.legacyNote;
      void nonNullableLegacy;
      return legacy;
    }
    return null;
  };
  void proveRetiredSelectedRead;
  const proveInvalidFormErrorFields = () => {
    // @ts-expect-error Retired fields are excluded from error attribution.
    operations.asset.toFormError(new Error("ignored"), { fields: ["legacyNote"] as const });
    // @ts-expect-error Unknown fields are excluded from error attribution.
    operations.asset.toFormError(new Error("ignored"), { fields: ["notAField"] as const });
  };
  void proveInvalidFormErrorFields;
  expect(() =>
    operations.asset.writes.create({
      title: "Allowed",
      // @ts-expect-error Retired fixture fields cannot produce a generated write.
      legacyNote: "forged",
    }),
  ).toThrow("field is not writable: legacyNote");
});

test("toFormError projects only declared, accepted structured errors", () => {
  let parserError: unknown;
  try {
    operations.asset.parseForm(form({ cost: "1e3" }), {
      fields: ["cost"] as const,
      mode: "update",
    });
  } catch (error) {
    parserError = error;
  }
  const parserFormError = operations.asset.toFormError(parserError, { fields: ["cost"] as const });
  expect(parserFormError).toEqual({
    ok: false,
    code: "invalid_input",
    message: "Enter a valid value",
    fieldErrors: { cost: { code: "invalid_input", message: "Enter a valid value" } },
  });
  if (parserFormError) {
    const costError = parserFormError.fieldErrors.cost;
    // @ts-expect-error Exact selected form fields cannot report an unselected field.
    const titleError = parserFormError.fieldErrors.title;
    void costError;
    void titleError;
  }

  const uniqueTitle = new KernelFailure({
    code: "unique_field_conflict",
    message: "secret",
    details: [
      { path: "model", code: "unique_field_conflict", message: "asset" },
      { path: "field", code: "unique_field_conflict", message: "title" },
      { path: "value", code: "unique_field_conflict", message: "do-not-leak" },
    ],
  });
  expect(operations.asset.toFormError(uniqueTitle, { fields: ["title"] as const })).toEqual({
    ok: false,
    code: "conflict",
    message: "This value is already in use",
    fieldErrors: { title: { code: "conflict", message: "This value is already in use" } },
  });
  const nonUniqueCost = new KernelFailure({
    code: "unique_field_conflict",
    message: "secret",
    details: [
      { path: "model", code: "unique_field_conflict", message: "asset" },
      { path: "field", code: "unique_field_conflict", message: "cost" },
    ],
  });
  expect(
    operations.asset.toFormError(nonUniqueCost, { fields: ["cost"] as const }),
  ).toBeUndefined();

  const declaredConstraint = new KernelFailure({
    code: "constraint_violation",
    message: "secret",
    details: [
      { path: "model", code: "constraint_violation", message: "asset" },
      { path: "constraint", code: "constraint_violation", message: "asset_cost_nonnegative" },
      { path: "field", code: "constraint_violation", message: "cost" },
    ],
  });
  expect(operations.asset.toFormError(declaredConstraint, { fields: ["cost"] as const })).toEqual({
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
  expect(
    operations.asset.toFormError(declaredConstraint, { fields: ["title"] as const }),
  ).toBeUndefined();
  expect(
    legacyOperations.asset.toFormError(declaredConstraint, { fields: ["cost"] as const }),
  ).toBeUndefined();
  const unknownConstraint = new KernelFailure({
    code: "constraint_violation",
    message: "secret",
    details: [
      { path: "model", code: "constraint_violation", message: "asset" },
      { path: "constraint", code: "constraint_violation", message: "unknown" },
      { path: "field", code: "constraint_violation", message: "cost" },
    ],
  });
  expect(
    operations.asset.toFormError(unknownConstraint, { fields: ["cost"] as const }),
  ).toBeUndefined();
});

test("version conflict is fieldless safe state only for an exact empty envelope", () => {
  const exact = new KernelFailure({
    code: "version_conflict",
    message: "private version",
    details: [],
  });
  expect(capableOperations.asset.toFormError(exact, { fields: ["cost"] as const })).toEqual({
    ok: false,
    code: "conflict",
    message: "This record has changed. Reload and try again.",
    fieldErrors: {},
  });
  const detailed = new KernelFailure({
    code: "version_conflict",
    message: "private",
    details: [{ path: "secret", code: "x", message: "secret" }],
  });
  expect(
    capableOperations.asset.toFormError(detailed, { fields: ["cost"] as const }),
  ).toBeUndefined();
});
