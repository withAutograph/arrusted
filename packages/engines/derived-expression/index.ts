/**
 * TypeScript evaluator for the compiler-owned derived-expression AST
 * (`DerivedExpr` in the generated wire contract). It follows the generated
 * SQL runtime's rules exactly; `packages/contracts/__fixtures__/derived-expressions.json`
 * holds the cases every evaluator must agree on. It renders previews only:
 * the kernel remains the authority for stored, aggregated and agent values.
 */
import type { DerivedExpr } from "../../contracts/wire.generated";
import {
  addDecimal,
  compareDecimal,
  divideDecimal,
  formatDecimal,
  multiplyDecimal,
  parseDecimal,
  subtractDecimal,
  type Decimal,
} from "../decimal";

export type DerivedType = "text" | "number" | "bool" | "date" | "datetime" | "money_rate";
export type MoneyRatePeriod = "hourly" | "daily" | "weekly" | "monthly" | "annual";
export type DerivedMoney = { amount: string; currency: string; period: MoneyRatePeriod };
/** A read value: decimal strings for numbers, `{ amount, currency, period }` for money. */
export type DerivedValue = string | boolean | DerivedMoney | null;
/**
 * Fields an expression may read, as `kernel_derived_environment` builds them:
 * stored fields by type, derived fields by expression, and for a declared
 * relation the active stored fields of its target model by type.
 */
export type DerivedEnvironment = Readonly<
  Record<
    string,
    {
      readonly type: string;
      readonly expression?: DerivedExpr | null;
      readonly target_fields?: Readonly<Record<string, string>>;
    }
  >
>;
/** Typed working-session rule parameters; derived fields have none. */
export type DerivedParameters = Readonly<
  Record<string, { readonly type: string; readonly value: unknown }>
>;
/**
 * What an evaluation reads besides the record's own values: per relation, the
 * related record's stored values (absent when the relation is empty or the
 * related record is unreadable), and a rule's parameters.
 */
export type DerivedContext = {
  readonly related?: Readonly<Record<string, Readonly<Record<string, unknown>> | null>>;
  readonly parameters?: DerivedParameters;
};
export type DerivedIssue = { code: string; message: string };

const SUPPORTED: readonly string[] = ["text", "number", "bool", "date", "datetime", "money_rate"];
const MAX_NODES = 256;
const MAX_DEPTH = 32;
const PER_YEAR: Record<MoneyRatePeriod, bigint> = {
  hourly: 2080n,
  daily: 260n,
  weekly: 52n,
  monthly: 12n,
  annual: 1n,
};

const issue = (code: string, message: string): DerivedIssue => ({ code, message });
const mismatch = (message: string) => issue("type_mismatch", message);

function validLiteral(type: string, value: unknown): boolean {
  if (type === "text") return typeof value === "string";
  if (type === "bool") return typeof value === "boolean";
  if (typeof value !== "string") return false;
  if (type === "number") {
    const match = /^-?(\d+)(?:\.(\d+))?$/.exec(value);
    return (
      match !== null &&
      (match[2]?.length ?? 0) <= 28 &&
      BigInt(`${match[1]}${match[2] ?? ""}`) <= 79228162514264337593543950335n
    );
  }
  if (type === "date") return validDate(value);
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [, date, hour, minute, second, offsetHour = "00", offsetMinute = "00"] = match;
  return (
    validDate(date!) &&
    Number(hour) <= 23 &&
    Number(minute) <= 59 &&
    // Leap seconds and offsets as PostgreSQL and the compiler both accept.
    Number(second) <= 60 &&
    Number(offsetHour) <= 15 &&
    Number(offsetMinute) <= 59
  );
}

const PERIODS: readonly string[] = ["hourly", "daily", "weekly", "monthly", "annual"];
const COMPARISONS: readonly string[] = ["eq", "not_eq", "lt", "lte", "gt", "gte"];
const COMPARABLE: readonly string[] = ["text", "number", "bool", "date", "datetime", "money_rate"];
const ORDERED: readonly string[] = ["number", "date", "datetime", "money_rate"];
const malformed = () => issue("invalid_derived_expression", "derived expression node is malformed");
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hasExactly = (value: Record<string, unknown>, keys: readonly string[]) =>
  keys.every((key) => key in value) && Object.keys(value).every((key) => keys.includes(key));

/**
 * Runtime JSON can carry nodes outside the generated type. Check each node's
 * shape the way `kernel_derived_infer` does before dispatching on its type.
 */
function checkShape(node: unknown): void {
  if (!isObject(node) || typeof node.type !== "string") throw malformed();
  switch (node.type) {
    case "field":
      if (!hasExactly(node, ["type", "field"]) || typeof node.field !== "string") throw malformed();
      return;
    case "literal": {
      const literal = node.value;
      if (
        !hasExactly(node, ["type", "value"]) ||
        !isObject(literal) ||
        typeof literal.type !== "string" ||
        !hasExactly(literal, ["type", "value"])
      )
        throw malformed();
      if (["enum", "iso_country", "iso_currency"].includes(literal.type))
        throw issue(
          "unsupported_derived_type",
          "derived literals are text, number, bool, date, or datetime",
        );
      if (!SUPPORTED.includes(literal.type) || literal.type === "money_rate") throw malformed();
      return;
    }
    case "coalesce":
    case "concat":
      if (!hasExactly(node, ["type", "expressions"]) || !Array.isArray(node.expressions))
        throw malformed();
      return;
    case "add":
    case "subtract":
    case "multiply":
    case "divide":
    case "min":
    case "max":
      if (!hasExactly(node, ["type", "left", "right"])) throw malformed();
      return;
    case "clamp":
      if (!hasExactly(node, ["type", "expression", "min", "max"])) throw malformed();
      return;
    case "compare":
      if (
        !hasExactly(node, ["type", "op", "left", "right"]) ||
        typeof node.op !== "string" ||
        !COMPARISONS.includes(node.op)
      )
        throw malformed();
      return;
    case "if":
      if (!hasExactly(node, ["type", "condition", "then", "else"])) throw malformed();
      return;
    case "relation_field":
      if (
        !hasExactly(node, ["type", "relation", "field"]) ||
        typeof node.relation !== "string" ||
        typeof node.field !== "string"
      )
        throw malformed();
      return;
    case "parameter":
      if (!hasExactly(node, ["type", "parameter"]) || typeof node.parameter !== "string")
        throw malformed();
      return;
    case "normalize_money_rate":
      if (
        !hasExactly(node, ["type", "expression", "period"]) ||
        typeof node.period !== "string" ||
        !PERIODS.includes(node.period)
      )
        throw malformed();
      return;
    case "inverse_aggregate":
      return;
    default:
      throw issue(
        "unsupported_derived_expression",
        `derived expression type \`${node.type}\` is not supported`,
      );
  }
}

/** A real calendar date in `YYYY-MM-DD` from year 1, including leap years. */
function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return days !== undefined && day >= 1 && day <= days;
}

const own = <T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined =>
  record && Object.hasOwn(record, key) ? record[key] : undefined;

/**
 * Infers an expression's type exactly as the compiler and SQL runtime do, or
 * returns the first structured issue. `fieldId` is the definition's own field.
 * `parameters` is given only for working-session rules.
 */
export function inferDerivedType(
  expression: DerivedExpr,
  environment: DerivedEnvironment,
  fieldId: string,
  parameters?: DerivedParameters,
): { type: DerivedType } | DerivedIssue {
  let nodes = 0;
  const visit = (node: DerivedExpr, depth: number, visiting: readonly string[]): string => {
    nodes++;
    if (nodes > MAX_NODES || depth > MAX_DEPTH)
      throw issue(
        "derived_expression_too_large",
        "derived expressions are limited to 256 nodes and depth 32 after expanding referenced derived fields",
      );
    checkShape(node);
    switch (node.type) {
      case "field": {
        const target = own(environment, node.field);
        if (!target)
          throw issue(
            "unknown_field",
            `field \`${node.field}\` is not an active field on the model`,
          );
        if (!target.expression) return target.type;
        if (visiting.includes(node.field))
          throw issue("derived_cycle", `derived field \`${node.field}\` references itself`);
        return visit(target.expression, depth + 1, [...visiting, node.field]);
      }
      case "literal":
        if (!validLiteral(node.value.type, node.value.value))
          throw mismatch("derived literal value is invalid");
        return node.value.type;
      case "coalesce":
      case "concat": {
        if (node.expressions.length === 0)
          throw issue(
            "empty_derived_expression",
            `${node.type} must contain at least one expression`,
          );
        let expected = node.type === "concat" ? "text" : undefined;
        for (const item of node.expressions) {
          const type = visit(item, depth + 1, visiting);
          expected ??= type;
          if (type !== expected)
            throw mismatch(
              node.type === "concat"
                ? "concat expressions must be text"
                : "coalesce expressions must have one type",
            );
        }
        return expected!;
      }
      case "add":
      case "subtract":
      case "multiply":
      case "divide": {
        const left = visit(node.left, depth + 1, visiting);
        const right = visit(node.right, depth + 1, visiting);
        if (node.type === "add" || node.type === "subtract") {
          if (left === right && (left === "number" || left === "money_rate")) return left;
          throw mismatch("add/subtract requires matching number or money_rate operands");
        }
        if (left === "number" && right === "number") return "number";
        // A ratio of two amounts of one unit is a number (null on a unit mismatch).
        if (node.type === "divide" && left === "money_rate" && right === "money_rate")
          return "number";
        if (
          (node.type === "multiply" &&
            ((left === "money_rate" && right === "number") ||
              (left === "number" && right === "money_rate"))) ||
          (node.type === "divide" && left === "money_rate" && right === "number")
        )
          return "money_rate";
        throw mismatch(
          "multiply/divide operands are not a supported number or money_rate combination",
        );
      }
      case "normalize_money_rate":
        if (visit(node.expression, depth + 1, visiting) !== "money_rate")
          throw mismatch("normalize_money_rate requires money_rate input");
        return "money_rate";
      case "relation_field": {
        const target = own(environment, node.relation);
        if (target?.type !== "relation" || !target.target_fields)
          throw issue(
            "unknown_field",
            `\`${node.relation}\` is not an active relation field on the model`,
          );
        const type = own(target.target_fields, node.field);
        if (type === undefined)
          throw issue(
            "unknown_field",
            `field \`${node.field}\` is not an active stored field on the related model`,
          );
        return type;
      }
      case "parameter": {
        if (!parameters)
          throw issue(
            "unsupported_derived_expression",
            "parameters are valid only in working-session rules",
          );
        const parameter = own(parameters, node.parameter);
        if (!parameter)
          throw issue("unknown_parameter", `parameter \`${node.parameter}\` has no value`);
        return parameter.type;
      }
      case "compare": {
        const left = visit(node.left, depth + 1, visiting);
        const right = visit(node.right, depth + 1, visiting);
        if (
          left !== right ||
          !COMPARABLE.includes(left) ||
          (node.op !== "eq" && node.op !== "not_eq" && !ORDERED.includes(left))
        )
          throw mismatch("compare requires matching comparable operands");
        return "bool";
      }
      case "if": {
        if (visit(node.condition, depth + 1, visiting) !== "bool")
          throw mismatch("if condition must be bool");
        const type = visit(node.then, depth + 1, visiting);
        if (visit(node.else, depth + 1, visiting) !== type)
          throw mismatch("if branches must have one type");
        return type;
      }
      case "min":
      case "max":
      case "clamp": {
        const operands =
          node.type === "clamp" ? [node.expression, node.min, node.max] : [node.left, node.right];
        let expected: string | undefined;
        for (const operand of operands) {
          const type = visit(operand, depth + 1, visiting);
          if (
            (expected !== undefined && type !== expected) ||
            (type !== "number" && type !== "money_rate")
          )
            throw mismatch(
              `${node.type === "clamp" ? "clamp" : "min/max"} requires matching number or money_rate operands`,
            );
          expected = type;
        }
        return expected!;
      }
      case "inverse_aggregate":
        throw issue(
          "unsupported_derived_expression",
          "inverse_aggregate is not evaluated by the SQL runtime",
        );
      default:
        return unreachable(node);
    }
  };
  try {
    const type = visit(expression, 1, [fieldId]);
    if (!SUPPORTED.includes(type))
      return issue(
        "unsupported_derived_type",
        "derived fields evaluate to text, number, bool, date, datetime, or money_rate",
      );
    return { type: type as DerivedType };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) return error as DerivedIssue;
    throw error;
  }
}

/** Issues for a definition, mirroring `kernel_derived_issues`. */
export function derivedIssues(
  expression: DerivedExpr,
  declaredType: string,
  environment: DerivedEnvironment,
  fieldId: string,
  parameters?: DerivedParameters,
): DerivedIssue[] {
  if (!SUPPORTED.includes(declaredType))
    return [
      issue(
        "unsupported_derived_type",
        "derived fields evaluate to text, number, bool, date, datetime, or money_rate",
      ),
    ];
  const result = inferDerivedType(expression, environment, fieldId, parameters);
  if ("code" in result) return [result];
  if (result.type !== declaredType)
    return [
      mismatch(
        `declared type \`${declaredType}\` does not match expression type \`${result.type}\``,
      ),
    ];
  return [];
}

type Money = { amount: Decimal; currency: string; period: MoneyRatePeriod };
type Evaluated =
  | { kind: "number"; value: Decimal | null }
  | { kind: "money"; value: Money | null }
  | { kind: "scalar"; type: string; value: string | boolean | null };

/**
 * Evaluates a validated expression over one record's read values. Null
 * operands and division by zero yield null; money combines, compares and
 * bounds only within one currency and period. `context` supplies related
 * records' stored values for `relation_field` and a rule's parameters.
 */
export function evaluateDerived(
  expression: DerivedExpr,
  environment: DerivedEnvironment,
  values: Readonly<Record<string, unknown>>,
  context: DerivedContext = {},
): DerivedValue {
  const result = evaluate(expression, environment, values, context);
  if (result.value === null) return null;
  if (result.kind === "number") return formatDecimal(result.value);
  if (result.kind === "money")
    return { ...result.value, amount: formatDecimal(result.value.amount) };
  return result.value;
}

/** A stored or parameter value as one read value, as the SQL lowering reads it. */
function typedValue(type: string, value: unknown): Evaluated {
  if (type === "number")
    return { kind: "number", value: value == null ? null : parseDecimal(value as string) };
  if (type === "money_rate") {
    if (value == null) return { kind: "money", value: null };
    const money = value as DerivedMoney;
    return {
      kind: "money",
      value: { amount: parseDecimal(money.amount), currency: money.currency, period: money.period },
    };
  }
  return { kind: "scalar", type, value: (value ?? null) as string | boolean | null };
}

const sameUnit = (left: Money | null, right: Money | null): [Money, Money] | null =>
  left && right && left.currency === right.currency && left.period === right.period
    ? [left, right]
    : null;

const DAY_MICROSECONDS = 86_400_000_000n;

/** Days from 1970-01-01 to a proleptic Gregorian date. */
function epochDay(year: number, month: number, day: number): bigint {
  const y = BigInt(month <= 2 ? year - 1 : year);
  const era = (y >= 0n ? y : y - 399n) / 400n;
  const yearOfEra = y - era * 400n;
  const dayOfYear = BigInt(Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1);
  const dayOfEra = yearOfEra * 365n + yearOfEra / 4n - yearOfEra / 100n + dayOfYear;
  return era * 146_097n + dayOfEra - 719_468n;
}

/**
 * A datetime as UTC microseconds, as PostgreSQL reads `timestamptz`: hour 24
 * and second 60 roll over, and fractional seconds are parsed as a double and
 * rounded half-even to microseconds.
 */
function datetimeMicroseconds(value: string): bigint {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match) throw new Error(`Invalid datetime: ${value}`);
  const [, year, month, day, hour, minute, second, fraction, sign, offsetHour, offsetMinute] =
    match;
  const scaled = Number(fraction ?? "0") * 1_000_000;
  const rounded = Math.abs(scaled % 1) === 0.5 ? 2 * Math.round(scaled / 2) : Math.round(scaled);
  const offset =
    sign === undefined
      ? 0n
      : (sign === "-" ? -1n : 1n) * BigInt(Number(offsetHour) * 3600 + Number(offsetMinute) * 60);
  const seconds = BigInt(Number(hour) * 3600 + Number(minute) * 60 + Number(second)) - offset;
  return (
    epochDay(Number(year), Number(month), Number(day)) * DAY_MICROSECONDS +
    seconds * 1_000_000n +
    BigInt(rounded)
  );
}

/** `kernel_derived_compare` and the numeric comparison: null when either side is. */
function compare(op: string, left: Evaluated, right: Evaluated): boolean | null {
  if (left.value === null || right.value === null) return null;
  let difference: number;
  if (left.kind === "number" && right.kind === "number")
    difference = compareDecimal(left.value, right.value);
  else if (left.kind === "money" && right.kind === "money") {
    const pair = sameUnit(left.value, right.value);
    if (!pair) return null;
    difference = compareDecimal(pair[0].amount, pair[1].amount);
  } else if (left.kind === "scalar" && left.type === "date")
    // `YYYY-MM-DD` from year 1 orders as text.
    difference = left.value < right.value ? -1 : left.value > right.value ? 1 : 0;
  else if (left.kind === "scalar" && left.type === "datetime") {
    const [a, b] = [left.value, right.value].map((value) => datetimeMicroseconds(value as string));
    difference = a! < b! ? -1 : a! > b! ? 1 : 0;
  } else difference = left.value === right.value ? 0 : 1;
  switch (op) {
    case "eq":
      return difference === 0;
    case "not_eq":
      return difference !== 0;
    case "lt":
      return difference < 0;
    case "lte":
      return difference <= 0;
    case "gt":
      return difference > 0;
    default:
      return difference >= 0;
  }
}

/** min (`greatest` false) or max of two numbers or two money values of one unit. */
function bound(left: Evaluated, right: Evaluated, greatest: boolean): Evaluated {
  const pick = (a: Decimal, b: Decimal) => (compareDecimal(a, b) < 0 === greatest ? b : a);
  if (left.kind === "money" && right.kind === "money") {
    const pair = sameUnit(left.value, right.value);
    return {
      kind: "money",
      value: pair && { ...pair[0], amount: pick(pair[0].amount, pair[1].amount) },
    };
  }
  const [a, b] = [left.value, right.value] as [Decimal | null, Decimal | null];
  return { kind: "number", value: a === null || b === null ? null : pick(a, b) };
}

function evaluate(
  node: DerivedExpr,
  environment: DerivedEnvironment,
  values: Readonly<Record<string, unknown>>,
  context: DerivedContext,
): Evaluated {
  const recurse = (child: DerivedExpr) => evaluate(child, environment, values, context);
  switch (node.type) {
    case "field": {
      const target = own(environment, node.field);
      if (!target) throw new Error(`derived field references an inactive field: ${node.field}`);
      if (target.expression) return recurse(target.expression);
      return typedValue(target.type, own(values, node.field));
    }
    case "relation_field": {
      const type = own(own(environment, node.relation)?.target_fields, node.field);
      if (type === undefined)
        throw new Error(`relation field references an inactive field: ${node.field}`);
      return typedValue(type, own(own(context.related, node.relation) ?? undefined, node.field));
    }
    case "parameter": {
      const parameter = own(context.parameters, node.parameter);
      if (!parameter) throw new Error(`parameter has no value: ${node.parameter}`);
      return typedValue(parameter.type, parameter.value);
    }
    case "literal":
      return node.value.type === "number"
        ? { kind: "number", value: parseDecimal(node.value.value) }
        : { kind: "scalar", type: node.value.type, value: node.value.value };
    case "coalesce": {
      let last: Evaluated = { kind: "scalar", type: "text", value: null };
      for (const item of node.expressions) {
        last = recurse(item);
        if (last.value !== null) return last;
      }
      return last;
    }
    case "concat": {
      let text = "";
      for (const item of node.expressions) {
        const part = recurse(item).value;
        if (part === null) return { kind: "scalar", type: "text", value: null };
        text += part as string;
      }
      return { kind: "scalar", type: "text", value: text };
    }
    case "add":
    case "subtract":
    case "multiply":
    case "divide": {
      const left = recurse(node.left);
      const right = recurse(node.right);
      if (left.kind === "number" && right.kind === "number") {
        if (left.value === null || right.value === null) return { kind: "number", value: null };
        const operation = {
          add: addDecimal,
          subtract: subtractDecimal,
          multiply: multiplyDecimal,
          divide: divideDecimal,
        }[node.type];
        return { kind: "number", value: operation(left.value, right.value) };
      }
      if (node.type === "divide" && left.kind === "money" && right.kind === "money") {
        const pair = sameUnit(left.value as Money | null, right.value as Money | null);
        return {
          kind: "number",
          value: pair ? divideDecimal(pair[0].amount, pair[1].amount) : null,
        };
      }
      if (node.type === "add" || node.type === "subtract") {
        const pair = sameUnit(left.value as Money | null, right.value as Money | null);
        if (!pair) return { kind: "money", value: null };
        const amount = (node.type === "add" ? addDecimal : subtractDecimal)(
          pair[0].amount,
          pair[1].amount,
        );
        return { kind: "money", value: { ...pair[0], amount } };
      }
      const [money, factor] = (
        left.kind === "money" ? [left.value, right.value] : [right.value, left.value]
      ) as [Money | null, Decimal | null];
      if (!money || factor === null) return { kind: "money", value: null };
      const amount =
        node.type === "divide"
          ? divideDecimal(money.amount, factor)
          : multiplyDecimal(money.amount, factor);
      return { kind: "money", value: amount === null ? null : { ...money, amount } };
    }
    case "normalize_money_rate": {
      const money = recurse(node.expression).value as Money | null;
      if (!money) return { kind: "money", value: null };
      const amount = divideDecimal(
        multiplyDecimal(money.amount, { coefficient: PER_YEAR[money.period], scale: 0 }),
        { coefficient: PER_YEAR[node.period], scale: 0 },
      )!;
      return { kind: "money", value: { ...money, amount, period: node.period } };
    }
    case "compare":
      return {
        kind: "scalar",
        type: "bool",
        value: compare(node.op, recurse(node.left), recurse(node.right)),
      };
    case "if":
      // A null or false condition takes `else`.
      return recurse(recurse(node.condition).value === true ? node.then : node.else);
    case "min":
    case "max":
      return bound(recurse(node.left), recurse(node.right), node.type === "max");
    case "clamp":
      // clamp(x, lo, hi) = max(lo, min(x, hi)).
      return bound(
        recurse(node.min),
        bound(recurse(node.expression), recurse(node.max), false),
        true,
      );
    case "inverse_aggregate":
      throw new Error(`${node.type} is not evaluated at runtime`);
    default:
      return unreachable(node);
  }
}

function unreachable(node: never): never {
  throw new Error(`unsupported derived expression ${JSON.stringify(node)}`);
}
