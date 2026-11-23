import {
  formatCompactCurrency,
  formatCompactMoneyRate,
  formatCompactPercent,
  formatField,
  formatIsoDateLong,
  formatMoneyRatePeriod,
} from "../index";

import nodeAssert from "node:assert/strict";
import { describe, it } from "vite-plus/test";

function assert(condition: unknown, message: string): asserts condition {
  nodeAssert(condition, message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  nodeAssert.equal(actual, expected, message);
}

function testFormatEngine() {
  assertEqual(formatCompactCurrency("157500", "USD"), "$158K", "compact currency rounds 3sf");
  assertEqual(formatCompactCurrency("7500", "USD"), "$7.5K", "compact currency 7.5K");
  assertEqual(formatCompactCurrency("150", "USD"), "$150", "compact currency under 1K");
  assertEqual(formatCompactCurrency("1234567", "EUR"), "€1.23M", "compact currency EUR 1.23M");

  const negativeSigned = formatCompactCurrency("-7500", "USD", { signed: true });
  assert(
    negativeSigned.startsWith("-") && !negativeSigned.startsWith("+-"),
    `signed negative starts with -, got ${negativeSigned}`,
  );
  assertEqual(
    formatCompactCurrency("7500", "USD", { signed: true }),
    "+$7.5K",
    "signed positive prefix",
  );
  assertEqual(formatCompactCurrency("0", "USD", { signed: true }), "$0", "signed zero has no sign");
  assertEqual(formatCompactCurrency("", "USD"), "", "empty input returns empty");
  assertEqual(formatCompactCurrency("not a number", "USD"), "", "invalid input returns empty");

  assertEqual(formatMoneyRatePeriod("annual"), "yr", "money-rate annual suffix");
  assertEqual(formatMoneyRatePeriod("hourly"), "hr", "money-rate hourly suffix");
  assertEqual(
    formatMoneyRatePeriod("custom_period"),
    "custom_period",
    "unknown money-rate period passes through",
  );
  assertEqual(
    formatCompactMoneyRate("150000.00", "USD", "annual"),
    "$150K/yr",
    "compact money-rate annual",
  );
  assertEqual(formatCompactMoneyRate("75", "USD", "hourly"), "$75/hr", "compact money-rate hourly");
  assertEqual(
    formatCompactMoneyRate("not a number", "USD", "annual"),
    "",
    "invalid money-rate returns empty",
  );
  assertEqual(formatIsoDateLong("2026-05-15"), "May 15, 2026", "ISO date long form");
  assertEqual(formatIsoDateLong("2026-02-31"), "2026-02-31", "invalid ISO date day passes through");
  assertEqual(
    formatIsoDateLong("2026-04-31"),
    "2026-04-31",
    "invalid ISO date month length passes through",
  );
  assertEqual(formatIsoDateLong("not-a-date"), "not-a-date", "invalid ISO date passes through");

  assertEqual(
    formatField(
      { type: "date", value: "2026-05-15" },
      { id: "start_date", label: "Start date", type: "date" },
    ),
    "May 15, 2026",
    "formatField formats dates",
  );
  assertEqual(
    formatField({ type: "bool", value: false }, { id: "remote", label: "Remote", type: "bool" }),
    "No",
    "formatField formats booleans",
  );
  assertEqual(
    formatField(
      { type: "money_rate", value: { amount: "150000.00", currency: "USD", period: "annual" } },
      { id: "base_salary", label: "Base salary", type: "money_rate" },
    ),
    "$150K/yr",
    "formatField formats money rates",
  );
  assertEqual(
    formatField(
      { type: "relation", value: { type: "record_id", value: "dep-eng" } },
      { id: "department", label: "Department", type: "relation" },
      { relationLabel: (key) => (key.value === "dep-eng" ? "Engineering" : null) },
    ),
    "Engineering",
    "formatField uses relation labels",
  );
  assertEqual(
    formatField(
      {
        type: "relation",
        value: { type: "lookup_or_create", value: { label: "Finance" } },
      },
      { id: "department", label: "Department", type: "relation" },
    ),
    "Finance",
    "formatField uses lookup_or_create labels as relation fallback",
  );
  assertEqual(
    formatField(
      {
        type: "relation_list",
        value: [
          { type: "record_id", value: "dep-eng" },
          { type: "lookup_or_create", value: { label: "Finance" } },
        ],
      },
      { id: "departments", label: "Departments", type: "relation" },
      { relationLabel: (key) => (key.type === "record_id" ? "Engineering" : null) },
    ),
    "Engineering, Finance",
    "formatField formats relation lists with resolved labels and key fallbacks",
  );
  assertEqual(
    formatField(
      { type: "schema_lifecycle", value: "retired" },
      { id: "lifecycle", label: "Lifecycle", type: "text" },
    ),
    "Retired",
    "formatField formats schema lifecycle values",
  );
  assertEqual(
    formatField(
      { type: "enum", value: "active" },
      {
        id: "status",
        label: "Status",
        type: "enum",
        option_set: [{ id: "active", label: "Active", aliases: ["current"] }],
      },
    ),
    "Active",
    "formatField formats enum option labels",
  );
  assertEqual(
    formatField(
      { type: "enum", value: "paused" },
      {
        id: "status",
        label: "Status",
        type: "enum",
        option_set: [{ id: "active", label: "Active", aliases: [] }],
      },
    ),
    "paused",
    "formatField falls back to unknown enum option ids",
  );
  assertEqual(
    formatField(
      { type: "enum", value: "paused" },
      {
        id: "status",
        label: "Status",
        type: "enum",
      },
    ),
    "paused",
    "formatField falls back when enum option metadata is missing",
  );

  assertEqual(formatCompactPercent(5), "5%", "percent integer");
  assertEqual(formatCompactPercent(5.13), "5.1%", "percent rounds to 1dp");
  assertEqual(formatCompactPercent(0, { signed: true }), "0%", "signed zero percent");
  assertEqual(formatCompactPercent(5, { signed: true }), "+5%", "signed positive percent");
  assertEqual(formatCompactPercent(-5, { signed: true }), "-5%", "signed negative percent");
  assertEqual(formatCompactPercent(Number.NaN), "", "NaN percent returns empty");
}

describe("format engine", () => {
  it("formats compact values", () => {
    testFormatEngine();
  });
});
