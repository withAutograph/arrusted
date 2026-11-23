import { describe, expect, it } from "vite-plus/test";
import {
  convertCurrency,
  effectiveCurrencyPeriods,
  resolveCurrencyRate,
  validateCurrencyRate,
  type CurrencyRate,
} from "../rates";

const automatic: CurrencyRate = {
  sourceCurrency: "EUR",
  targetCurrency: "USD",
  rate: "1.1",
  effectiveStart: "2026-01-01",
  effectiveEnd: null,
  origin: "frankfurter",
  observationDate: "2025-12-31",
};
const request = (asOf: string) => ({ sourceCurrency: "EUR", targetCurrency: "USD", asOf });
describe("currency rates", () => {
  it("rolls monthly periods on the first and leaves the latest open-ended", () => {
    const rates = [
      { ...automatic, effectiveEnd: "2026-01-31" },
      { ...automatic, effectiveStart: "2026-02-01", rate: "1.2" },
    ];
    expect(resolveCurrencyRate(rates, request("2026-01-31"))).toMatchObject({
      status: "found",
      rate: "1.1",
    });
    expect(resolveCurrencyRate(rates, request("2026-02-01"))).toMatchObject({
      status: "found",
      rate: "1.2",
    });
    expect(resolveCurrencyRate(rates, request("2027-01-01"))).toMatchObject({
      status: "found",
      rate: "1.2",
    });
  });
  it("prefers custom regardless of order, then returns to automatic after inclusive expiry", () => {
    const custom: CurrencyRate = {
      ...automatic,
      origin: "custom",
      rate: "1.3",
      effectiveStart: "2026-01-10",
      effectiveEnd: "2026-01-20",
    };
    for (const rates of [
      [automatic, custom],
      [custom, automatic],
    ]) {
      expect(resolveCurrencyRate(rates, request("2026-01-09"))).toMatchObject({ rate: "1.1" });
      expect(resolveCurrencyRate(rates, request("2026-01-10"))).toMatchObject({ rate: "1.3" });
      expect(resolveCurrencyRate(rates, request("2026-01-20"))).toMatchObject({ rate: "1.3" });
      expect(resolveCurrencyRate(rates, request("2026-01-21"))).toMatchObject({ rate: "1.1" });
    }
  });
  it("shows only the effective rate across partial and fully covered automatic periods", () => {
    const custom: CurrencyRate = {
      ...automatic,
      origin: "custom",
      rate: "1.3",
      effectiveStart: "2026-01-10",
      effectiveEnd: "2026-01-20",
    };
    const history = [automatic, custom];
    const timeline = effectiveCurrencyPeriods(history, request("2026-01-01"));
    expect(
      timeline.map(({ effectiveStart, effectiveEnd, origin }) => ({
        effectiveStart,
        effectiveEnd,
        origin,
      })),
    ).toEqual([
      { effectiveStart: "2026-01-21", effectiveEnd: null, origin: "frankfurter" },
      { effectiveStart: "2026-01-10", effectiveEnd: "2026-01-20", origin: "custom" },
      { effectiveStart: "2026-01-01", effectiveEnd: "2026-01-09", origin: "frankfurter" },
    ]);
    for (const day of [
      "2026-01-01",
      "2026-01-09",
      "2026-01-10",
      "2026-01-20",
      "2026-01-21",
      "2027-01-01",
    ]) {
      const visible = timeline.filter(
        (rate) => rate.effectiveStart <= day && (!rate.effectiveEnd || rate.effectiveEnd >= day),
      );
      expect(visible).toHaveLength(1);
      expect(resolveCurrencyRate(history, request(day))).toMatchObject({
        rate: visible[0]!.rate,
        origin: visible[0]!.origin,
      });
    }
    expect(
      effectiveCurrencyPeriods(
        [automatic, { ...custom, effectiveStart: automatic.effectiveStart, effectiveEnd: null }],
        request("2026-01-01"),
      ),
    ).toHaveLength(1);
  });
  it("keeps automatic gaps around multiple overrides and monthly boundaries", () => {
    const history: CurrencyRate[] = [
      { ...automatic, effectiveEnd: "2026-01-31" },
      { ...automatic, effectiveStart: "2026-02-01" },
      { ...automatic, origin: "custom", effectiveStart: "2026-01-25", effectiveEnd: "2026-02-05" },
      { ...automatic, origin: "custom", effectiveStart: "2026-02-10", effectiveEnd: null },
    ];
    expect(
      effectiveCurrencyPeriods(history, request("2026-01-01"))
        .filter((rate) => rate.origin === "frankfurter")
        .map((rate) => [rate.effectiveStart, rate.effectiveEnd]),
    ).toEqual([
      ["2026-02-06", "2026-02-09"],
      ["2026-01-01", "2026-01-24"],
    ]);
    expect(history[0]!.effectiveEnd).toBe("2026-01-31");
  });
  it("infers the reverse quote but does not invent missing periods or cross rates", () => {
    expect(resolveCurrencyRate([automatic], request("2025-12-31"))).toEqual({
      status: "missing",
      ...request("2025-12-31"),
    });
    expect(
      convertCurrency("10", [automatic], {
        ...request("2026-01-01"),
        sourceCurrency: "USD",
        targetCurrency: "EUR",
      }),
    ).toMatchObject({
      status: "found",
      operation: "divide",
      amount: "9.090909090909090909090909091",
    });
    expect(
      resolveCurrencyRate([automatic], { ...request("2026-01-01"), sourceCurrency: "GBP" }),
    ).toMatchObject({ status: "missing" });
  });
  it("resolves same currency without stored rates", () => {
    expect(
      convertCurrency("100.00", [], {
        sourceCurrency: "USD",
        targetCurrency: "USD",
        asOf: "2026-01-01",
      }),
    ).toEqual({
      status: "found",
      rate: "1",
      operation: "multiply",
      origin: "identity",
      entry: null,
      amount: "100",
    });
  });
  it("multiplies decimals exactly, including large and negative amounts", () => {
    expect(
      convertCurrency("9007199254740993.01", [automatic], request("2026-01-01")),
    ).toMatchObject({ amount: "9907919180215092.311" });
    expect(convertCurrency("-0.01", [automatic], request("2026-01-01"))).toMatchObject({
      amount: "-0.011",
    });
    expect(convertCurrency("0.00", [automatic], request("2026-01-01"))).toMatchObject({
      amount: "0",
    });
    expect(convertCurrency("100", [automatic], request("2026-01-01"))).toMatchObject({
      amount: "110",
    });
  });
  it("uses one entered quote in both directions, with exact terminating division", () => {
    const quote: CurrencyRate = {
      ...automatic,
      sourceCurrency: "USD",
      targetCurrency: "EUR",
      origin: "custom",
      rate: "0.8",
    };
    const history = [automatic, quote];
    expect(convertCurrency("10", history, request("2026-01-01"))).toMatchObject({
      rate: "0.8",
      operation: "divide",
      amount: "12.5",
      origin: "custom",
    });
    expect(
      convertCurrency("10", history, {
        ...request("2026-01-01"),
        sourceCurrency: "USD",
        targetCurrency: "EUR",
      }),
    ).toMatchObject({ rate: "0.8", operation: "multiply", amount: "8", origin: "custom" });
    expect(effectiveCurrencyPeriods(history, request("2026-01-01"))).toEqual([quote]);
    expect(convertCurrency("-1", [{ ...quote, rate: "8" }], request("2026-01-01"))).toMatchObject({
      amount: "-0.125",
    });
    expect(
      convertCurrency(
        "79228162514264337593543950335",
        [{ ...quote, rate: "1" }],
        request("2026-01-01"),
      ),
    ).toMatchObject({ amount: "79228162514264337593543950335" });
  });
  it("rounds only repeating division to 28 significant digits, including tiny and negative results", () => {
    const quote: CurrencyRate = {
      ...automatic,
      sourceCurrency: "USD",
      targetCurrency: "EUR",
      rate: "3",
    };
    for (const [amount, expected] of [
      ["1", `0.${"3".repeat(28)}`],
      ["2", `0.${"6".repeat(27)}7`],
      ["-2", `-0.${"6".repeat(27)}7`],
      ["0", "0"],
      ["0.0000000000000000000000000001", `0.${"0".repeat(28)}${"3".repeat(28)}`],
    ]) {
      expect(convertCurrency(amount!, [quote], request("2026-01-01"))).toMatchObject({
        amount: expected,
      });
    }
    expect(
      convertCurrency(
        "10000000000000000000000000000",
        [{ ...quote, rate: "0.3" }],
        request("2026-01-01"),
      ),
    ).toMatchObject({ amount: "33333333333333333333333333330" });
  });
  it("uses corrected visible facts on the next calculation", () => {
    expect(
      convertCurrency("10", [{ ...automatic, rate: "1.234" }], request("2026-01-01")),
    ).toMatchObject({ amount: "12.34" });
  });
  it("rejects ambiguity within either origin even beneath a custom override", () => {
    expect(() =>
      resolveCurrencyRate(
        [automatic, automatic, { ...automatic, origin: "custom" }],
        request("2026-01-01"),
      ),
    ).toThrow(/Ambiguous/);
    expect(() =>
      resolveCurrencyRate(
        [
          { ...automatic, origin: "custom" },
          { ...automatic, origin: "custom" },
        ],
        request("2026-01-01"),
      ),
    ).toThrow(/Ambiguous/);
  });
  it("rejects invalid rates, dates and currencies", () => {
    for (const rate of ["0", "-1", "NaN", "1e3", "Infinity", ""])
      expect(() => validateCurrencyRate({ ...automatic, rate })).toThrow();
    for (const effectiveStart of ["2026-02-29", "2026-13-01", "2026-1-01"])
      expect(() => validateCurrencyRate({ ...automatic, effectiveStart })).toThrow();
    expect(() => validateCurrencyRate({ ...automatic, sourceCurrency: "ZZZ" })).toThrow();
    expect(() => validateCurrencyRate({ ...automatic, effectiveEnd: "2025-12-31" })).toThrow();
    expect(() => convertCurrency("1e3", [automatic], request("2026-01-01"))).toThrow();
  });
  it("normalizes trailing fractional zeros before enforcing kernel precision", () => {
    const maximum = "79228162514264337593543950335";
    for (const suffix of [".0", ".000"]) {
      expect(() => validateCurrencyRate({ ...automatic, rate: maximum + suffix })).not.toThrow();
      expect(
        convertCurrency(maximum + suffix, [{ ...automatic, rate: "1" }], request("2026-01-01")),
      ).toMatchObject({ amount: maximum });
      expect(
        convertCurrency("1", [{ ...automatic, rate: maximum + suffix }], request("2026-01-01")),
      ).toMatchObject({ amount: maximum });
    }
  });

  it("accepts the kernel decimal parser's sign and digit separators", () => {
    expect(convertCurrency("+1_000.25", [automatic], request("2026-01-01"))).toMatchObject({
      amount: "1100.275",
    });
    expect(() => validateCurrencyRate({ ...automatic, rate: "+1_000.25" })).not.toThrow();
  });
  it("rejects non-tender currencies and decimal inputs outside kernel precision", () => {
    for (const sourceCurrency of ["XAU", "XXX", "USN"]) {
      expect(() => validateCurrencyRate({ ...automatic, sourceCurrency })).toThrow();
      expect(() =>
        resolveCurrencyRate([], {
          sourceCurrency,
          targetCurrency: sourceCurrency,
          asOf: "2026-01-01",
        }),
      ).toThrow();
    }
    for (const value of [
      "79228162514264337593543950336",
      "7922816251426433759354395033.6",
      "0.00000000000000000000000000001",
    ]) {
      expect(() => validateCurrencyRate({ ...automatic, rate: value })).toThrow(/precision/);
      expect(() => convertCurrency(value, [automatic], request("2026-01-01"))).toThrow(/precision/);
      expect(() => convertCurrency(`-${value}`, [automatic], request("2026-01-01"))).toThrow(
        /precision/,
      );
    }
    expect(
      convertCurrency(
        "79228162514264337593543950335",
        [{ ...automatic, rate: "2" }],
        request("2026-01-01"),
      ),
    ).toMatchObject({ amount: "158456325028528675187087900670" });
    expect(
      convertCurrency(
        "0.0000000000000000000000000001",
        [{ ...automatic, rate: "0.1" }],
        request("2026-01-01"),
      ),
    ).toMatchObject({ amount: "0.00000000000000000000000000001" });
  });
});
