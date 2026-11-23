import { expect, test } from "vite-plus/test";
import type { DerivedExpr } from "../../contracts/wire.generated";
import fixture from "../../contracts/__fixtures__/derived-expressions.json";
import { parseDecimal } from "../../engines/decimal";
import {
  derivedIssues,
  evaluateDerived,
  inferDerivedType,
  type DerivedContext,
  type DerivedEnvironment,
  type DerivedParameters,
} from "../../engines/derived-expression";

// The same cases drive the compiler and the generated SQL runtime
// (packages/schema-compiler/tests/sql_parity_derived_expressions.rs), so
// passing here proves the TypeScript evaluator agrees with the kernel.
type Definition = { id: string; type: string; expression: DerivedExpr };

// Active declared and custom fields, as the runtime's derived environment.
// `manager` relates a position to a position, so its target fields are the
// model's active stored fields.
const active = (field: { lifecycle?: string }) => (field.lifecycle ?? "active") === "active";
const stored = [...fixture.fields, ...fixture.custom_fields].filter(active);
const targetFields = Object.fromEntries(stored.map((field) => [field.id, field.type]));

function environment(definitions: readonly Definition[]): DerivedEnvironment {
  return {
    ...Object.fromEntries(
      stored.map((field) => [
        field.id,
        field.type === "relation"
          ? { type: field.type, target_fields: targetFields }
          : { type: field.type },
      ]),
    ),
    ...Object.fromEntries(
      definitions.map((field) => [field.id, { type: field.type, expression: field.expression }]),
    ),
  };
}

test("validation agrees with the compiler and SQL runtime on every shared case", () => {
  const cases = [...fixture.validation];
  let deep: DerivedExpr = { type: "field", field: "salary" };
  for (let index = 0; index < 32; index++)
    deep = { type: "add", left: deep, right: { type: "field", field: "salary" } };
  cases.push({
    name: "nesting beyond the depth bound",
    derived_fields: [{ id: "d", type: "number", expression: deep as never }],
    error: "derived_expression_too_large",
  });
  for (const testCase of cases) {
    const definitions = testCase.derived_fields as unknown as Definition[];
    const env = environment(definitions);
    const code =
      definitions
        .map((field) => derivedIssues(field.expression, field.type, env, field.id)[0]?.code)
        .find((issue) => issue !== undefined) ?? null;
    expect(code, testCase.name).toBe(testCase.error);
  }
});

test("malformed runtime nodes return the SQL runtime's structured issues", () => {
  for (const testCase of fixture.runtime_validation) {
    const definitions = testCase.derived_fields as unknown as Definition[];
    const field = definitions[0]!;
    expect(
      derivedIssues(field.expression, field.type, environment(definitions), field.id)[0]?.code,
      testCase.name,
    ).toBe(testCase.error);
  }
});

test("evaluation produces exactly the SQL runtime's read values", () => {
  for (const testCase of fixture.evaluation) {
    const definitions = testCase.derived_fields as unknown as Definition[];
    const context = testCase as DerivedContext;
    const env = environment(definitions);
    for (const field of definitions) {
      expect(
        derivedIssues(field.expression, field.type, env, field.id, context.parameters),
        testCase.name,
      ).toEqual([]);
      expect(
        evaluateDerived(field.expression, env, testCase.values, context),
        `${testCase.name}: ${field.id}`,
      ).toEqual((testCase.expected as Record<string, unknown>)[field.id]);
    }
  }
});

test("stored decimal inputs parse exactly where the SQL runtime accepts them", () => {
  for (const input of fixture.number_inputs) {
    let valid = true;
    try {
      parseDecimal(input.value);
    } catch {
      valid = false;
    }
    expect(valid, input.value).toBe(input.valid);
  }
});

test("evaluation renders staged values without a kernel round trip", () => {
  const compaRatio: DerivedExpr = {
    type: "divide",
    left: { type: "field", field: "salary" },
    right: { type: "field", field: "midpoint" },
  };
  const env = environment([]);
  expect(evaluateDerived(compaRatio, env, { salary: "110", midpoint: "100" })).toBe("1.1");
  expect(evaluateDerived(compaRatio, env, { salary: "120", midpoint: "100" })).toBe("1.2");
});

test("parameters type-check only in working-session rules", () => {
  const env = environment([]);
  const cap: DerivedExpr = { type: "parameter", parameter: "cap" };
  const parameters: DerivedParameters = { cap: { type: "number", value: "10" } };
  expect(inferDerivedType(cap, env, "rule")).toMatchObject({
    code: "unsupported_derived_expression",
  });
  expect(inferDerivedType(cap, env, "rule", {})).toMatchObject({ code: "unknown_parameter" });
  expect(inferDerivedType(cap, env, "rule", parameters)).toEqual({ type: "number" });
});
