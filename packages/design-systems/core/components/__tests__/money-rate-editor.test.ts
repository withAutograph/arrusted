import {
  formatMoneyRateDisplay,
  MoneyRateEditor,
  parseMoneyRateExpression,
} from "../editors/money-rate-editor";
import type { EditorContext } from "../editors/protocol";

import nodeAssert from "node:assert/strict";
import { describe, it } from "vite-plus/test";

function assert(condition: unknown, message: string): asserts condition {
  nodeAssert(condition, message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  nodeAssert.equal(actual, expected, message);
}

function testMoneyRateExpressionParser() {
  function ok(input: string, base: string, expected: string, label: string) {
    const result = parseMoneyRateExpression(input, base);
    assert(result.ok, `${label}: expected ok, got ${result.ok ? "ok" : `error(${result.reason})`}`);
    if (result.ok) {
      assertEqual(result.value, expected, `${label}: value`);
    }
  }
  function bad(input: string, base: string, label: string) {
    const result = parseMoneyRateExpression(input, base);
    assert(
      !result.ok,
      `${label}: expected error, got ${result.ok ? `ok(${result.value})` : "error"}`,
    );
  }

  // Plain numbers
  ok("165000", "150000", "165000", "plain integer");
  ok("1234.56", "0", "1234.56", "plain decimal");
  ok("  150000  ", "0", "150000", "whitespace tolerant");

  // Suffix shorthand
  ok("165k", "0", "165000", "lowercase k suffix");
  ok("165K", "0", "165000", "uppercase K suffix");
  ok("1.5m", "0", "1500000", "lowercase m suffix");
  ok("2M", "0", "2000000", "uppercase M suffix");
  ok(
    "9007199254740.993k",
    "0",
    "9007199254740993",
    "suffix shorthand preserves large decimal strings",
  );

  // Add / subtract
  ok("+5000", "150000", "155000", "relative add");
  ok("-2500", "150000", "147500", "relative subtract");
  ok("+0", "150000", "150000", "relative no-op");
  ok("+1", "9007199254740993", "9007199254740994", "relative add preserves large decimal strings");
  ok("+0.01", "100.09", "100.1", "relative add preserves decimal strings");
  bad("-200", "100", "relative subtract below zero");

  // Percent
  ok("+5%", "150000", "157500", "+5 percent");
  ok("-2.5%", "150000", "146250", "-2.5 percent");
  ok("+10%", "200", "220", "small base percent");
  ok("+5%", "9007199254740993", "9457559217478042.65", "percent preserves large decimal strings");

  // Multiply / divide
  ok("*1.1", "100000", "110000", "multiply");
  ok("/2", "150000", "75000", "divide");
  ok(
    "*1",
    "9007199254740993",
    "9007199254740993",
    "multiply identity preserves large decimal strings",
  );
  ok(
    "/1",
    "9007199254740993",
    "9007199254740993",
    "divide identity preserves large decimal strings",
  );
  bad("/0", "150000", "divide by zero");

  // Invalid
  bad("blah", "150000", "non-numeric");
  bad("", "150000", "empty input");
  bad("  ", "150000", "whitespace only");
  bad("-150000", "100000", "bare negative absolute (sign reserved for relative)");
  bad("+5%%", "100000", "double percent");
  bad("*", "100000", "multiply with no factor");
  bad("/", "100000", "divide with no factor");
  bad("1.5x", "100000", "unknown suffix");
  bad("+abc", "100000", "relative with garbage");

  // Round-trip: a parsed value re-fed as input should match
  const sample = parseMoneyRateExpression("165k", "0");
  assert(sample.ok, "round-trip parse(165k) ok");
  if (sample.ok) {
    const second = parseMoneyRateExpression(sample.value, "0");
    assert(second.ok && second.value === sample.value, "round-trip stable");
  }
}

function testMoneyRateDisplayFormatter() {
  assertEqual(formatMoneyRateDisplay("1.236", "USD"), "$1.24", "money display rounds to 2dp");
  assertEqual(
    formatMoneyRateDisplay("-1.236", "USD"),
    "$-1.24",
    "money display rounds negative values away from zero",
  );
  assertEqual(
    formatMoneyRateDisplay("9457559217478042.65", "USD"),
    "$9,457,559,217,478,042.65",
    "money display preserves large decimal strings",
  );
  assertEqual(
    formatMoneyRateDisplay("1000.5", "EUR"),
    "€1,000.5",
    "money display keeps one fractional digit",
  );
}

function testMoneyRateEditorProtocol() {
  const ctx: EditorContext = {
    rowKey: { type: "external_key", value: "row-1" },
    fieldId: "comp",
    fieldType: { type: "money_rate", label: "Comp" },
  };

  // parse(undefined) returns defaults
  const blank = MoneyRateEditor.parse(undefined, ctx);
  assertEqual(blank.currency, "USD", "default currency is USD");
  assertEqual(blank.period, "annual", "default period is annual");
  assertEqual(blank.amount, "", "default amount is empty");
  assertEqual(blank.initialAmount, "0", "default initialAmount is 0");

  // parse(undefined) honours fieldType options
  const ctxEur: EditorContext = {
    rowKey: { type: "external_key", value: "row-1" },
    fieldId: "comp",
    fieldType: {
      type: "money_rate",
      label: "Comp",
      currencyOptions: ["EUR", "GBP"],
      periodOptions: ["monthly", "annual"],
    },
  };
  const blankEur = MoneyRateEditor.parse(undefined, ctxEur);
  assertEqual(blankEur.currency, "EUR", "first currency option used");
  assertEqual(blankEur.period, "monthly", "first period option used");

  // parse(value) preserves shape and freezes initialAmount
  const parsed = MoneyRateEditor.parse(
    { type: "money_rate", value: { amount: "150000", currency: "USD", period: "annual" } },
    ctx,
  );
  assertEqual(parsed.amount, "150000", "amount preserved");
  assertEqual(parsed.currency, "USD", "currency preserved");
  assertEqual(parsed.period, "annual", "period preserved");
  assertEqual(parsed.initialAmount, "150000", "initialAmount frozen from amount");

  // serialize produces FieldValue shape with decimal-string amount
  const serialized = MoneyRateEditor.serialize(
    { amount: "157500", currency: "USD", period: "annual" },
    ctx,
  );
  assertEqual(serialized.type, "money_rate", "serialize type");
  assertEqual(serialized.value.amount, "157500", "serialize amount is decimal string");
  assertEqual(serialized.value.currency, "USD", "serialize currency");
  assertEqual(serialized.value.period, "annual", "serialize period");

  // Falsy edge: amount "0"
  const zero = MoneyRateEditor.serialize({ amount: "0", currency: "USD", period: "annual" }, ctx);
  assertEqual(zero.value.amount, "0", "zero amount survives serialize");
}

function testMoneyRateEditorBehavior() {
  // Behavior is exercised by the parser + protocol contracts; verify the composition
  // a caller relies on (parse → expression resolve → serialize) produces the expected wire shape.
  const ctx: EditorContext = {
    rowKey: { type: "external_key", value: "row-1" },
    fieldId: "comp",
    fieldType: { type: "money_rate" },
  };
  const parsed = MoneyRateEditor.parse(
    { type: "money_rate", value: { amount: "150000", currency: "USD", period: "annual" } },
    ctx,
  );
  const expression = parseMoneyRateExpression("+5%", parsed.initialAmount);
  assert(expression.ok, "expression resolves");
  if (expression.ok) {
    const wire = MoneyRateEditor.serialize(
      { amount: expression.value, currency: parsed.currency, period: parsed.period },
      ctx,
    );
    assertEqual(wire.value.amount, "157500", "+5% commits as 157500");
    assertEqual(wire.value.currency, "USD", "currency carried through");
    assertEqual(wire.value.period, "annual", "period carried through");
  }

  // Invalid expression must not produce a serialize-eligible value.
  const invalid = parseMoneyRateExpression("blah", "150000");
  assert(!invalid.ok, "invalid expression blocks commit value");

  // Currency change with empty input commits the original amount with new currency.
  const switched = MoneyRateEditor.serialize(
    { amount: parsed.amount, currency: "EUR", period: parsed.period },
    ctx,
  );
  assertEqual(switched.value.currency, "EUR", "currency switch round-trip");
  assertEqual(switched.value.amount, "150000", "amount preserved on currency switch");
}

describe("money rate editor", () => {
  it("parses money-rate expressions", () => {
    testMoneyRateExpressionParser();
  });

  it("formats money-rate displays", () => {
    testMoneyRateDisplayFormatter();
  });

  it("preserves the editor protocol", () => {
    testMoneyRateEditorProtocol();
  });

  it("round-trips behavior through parse and serialize", () => {
    testMoneyRateEditorBehavior();
  });
});
