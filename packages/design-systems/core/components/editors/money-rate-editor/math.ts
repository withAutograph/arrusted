import { parseDecimalInput } from "../decimal";

/**
 * Normalize a plain decimal string to canonical form (no leading zeros except 0.x,
 * up to 28 fractional digits). Mirrors number-cell-editor's normalizeDecimalInput.
 */
export function normalizeDecimalString(value: string): string | null {
  const parsed = parseDecimalInput(value);
  if (!parsed) {
    return null;
  }
  const trimmedFraction = parsed.fractionPart.replace(/0+$/, "");
  const trimmedInteger = parsed.integerPart.replace(/^0+/, "") || "0";
  const canonical =
    trimmedFraction.length > 0 ? `${trimmedInteger}.${trimmedFraction}` : trimmedInteger;
  if (canonical === "0" || canonical === "0.0") {
    return "0";
  }
  return `${parsed.negative && canonical !== "0" ? "-" : ""}${canonical}`;
}

export function decimalToScaled(value: string): { coefficient: bigint; scale: number } | null {
  const normalized = normalizeDecimalString(value);
  if (!normalized) {
    return null;
  }
  const negative = normalized.startsWith("-");
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [integerPart = "", fractionPart = ""] = unsigned.split(".");
  const digits = `${integerPart}${fractionPart}`.replace(/^0+/, "") || "0";
  const coefficient = BigInt(digits) * (negative ? -1n : 1n);
  return { coefficient, scale: fractionPart.length };
}

export function scaleCoefficient(
  value: { coefficient: bigint; scale: number },
  targetScale: number,
) {
  return value.coefficient * 10n ** BigInt(targetScale - value.scale);
}

export function scaledDecimalToString(coefficient: bigint, scale: number): string | null {
  if (coefficient < 0n) {
    return null;
  }
  const digits = coefficient.toString().padStart(scale + 1, "0");
  const integerPart = scale === 0 ? digits : digits.slice(0, -scale);
  const fractionPart = scale === 0 ? "" : digits.slice(-scale).replace(/0+$/, "");
  return normalizeDecimalString(
    fractionPart.length > 0 ? `${integerPart}.${fractionPart}` : integerPart,
  );
}

export function isZero(value: { coefficient: bigint; scale: number }) {
  return value.coefficient === 0n;
}

export function addDecimalStrings(a: string, b: string): string | null {
  const left = decimalToScaled(a);
  const right = decimalToScaled(b);
  if (!left || !right) {
    return null;
  }
  const scale = Math.max(left.scale, right.scale);
  return scaledDecimalToString(
    scaleCoefficient(left, scale) + scaleCoefficient(right, scale),
    scale,
  );
}

export function multiplyDecimalStrings(a: string, b: string): string | null {
  const left = decimalToScaled(a);
  const right = decimalToScaled(b);
  if (!left || !right) {
    return null;
  }
  return scaledDecimalToString(left.coefficient * right.coefficient, left.scale + right.scale);
}

export function divideDecimalStrings(a: string, b: string, outputScale = 2): string | null {
  const left = decimalToScaled(a);
  const right = decimalToScaled(b);
  if (!left || !right || isZero(right) || right.coefficient < 0n) {
    return null;
  }
  const numerator = left.coefficient * 10n ** BigInt(right.scale + outputScale);
  const denominator = right.coefficient * 10n ** BigInt(left.scale);
  let quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder * 2n >= denominator) {
    quotient += 1n;
  }
  return scaledDecimalToString(quotient, outputScale);
}

export type ParseExpressionResult = { ok: true; value: string } | { ok: false; reason: string };

/**
 * Parse a money-rate amount expression. Grammar:
 *   - "165000" / "1234.56"  → plain number (absolute)
 *   - "165k" / "1.5m"       → shorthand (k=thousand, m=million; case-insensitive)
 *   - "+5000" / "-2500"     → relative add/subtract from initialAmount
 *   - "+5%"   / "-2.5%"     → percent of initialAmount
 *   - "*1.1"  / "/2"        → multiply or divide initialAmount
 * Whitespace is tolerated. Bare digits without a sign are absolute (negative absolutes
 * are not supported — money rates can't be negative).
 */
export function parseMoneyRateExpression(
  input: string,
  initialAmount: string,
): ParseExpressionResult {
  const raw = input.trim();
  if (raw.length === 0) {
    return { ok: false, reason: "empty" };
  }

  // Multiply / divide (highest specificity prefix)
  if (raw.startsWith("*") || raw.startsWith("/")) {
    const op = raw[0];
    const factorText = raw.slice(1).trim();
    const factor = parsePlainUnsignedDecimal(factorText);
    if (!factor) {
      return { ok: false, reason: "invalid factor" };
    }
    if (op === "/" && factor === "0") {
      return { ok: false, reason: "divide by zero" };
    }
    if (!normalizeDecimalString(initialAmount)) {
      return { ok: false, reason: "no base value" };
    }
    const normalized =
      op === "*"
        ? multiplyDecimalStrings(initialAmount, factor)
        : divideDecimalStrings(initialAmount, factor);
    return normalized ? { ok: true, value: normalized } : { ok: false, reason: "out of range" };
  }

  // Percent
  const percentMatch = raw.match(/^([+-])\s*([0-9]*\.?[0-9]+)\s*%$/);
  if (percentMatch) {
    const sign = percentMatch[1] === "-" ? "-" : "+";
    const pct = parsePlainUnsignedDecimal(percentMatch[2]!);
    if (!pct) {
      return { ok: false, reason: "invalid percent" };
    }
    if (!normalizeDecimalString(initialAmount)) {
      return { ok: false, reason: "no base value" };
    }
    const deltaProduct = multiplyDecimalStrings(initialAmount, pct);
    const delta = deltaProduct ? divideDecimalStrings(deltaProduct, "100") : null;
    const normalized = delta
      ? addDecimalStrings(initialAmount, sign === "-" ? `-${delta}` : delta)
      : null;
    return normalized ? { ok: true, value: normalized } : { ok: false, reason: "out of range" };
  }

  // Relative add / subtract: leading sign with no trailing %
  if ((raw.startsWith("+") || raw.startsWith("-")) && !raw.endsWith("%")) {
    const sign = raw[0] === "-" ? "-" : "+";
    const body = raw.slice(1).trim();
    const operand = parseAbsoluteAmount(body);
    if (!operand) {
      return { ok: false, reason: "invalid number" };
    }
    const signed = sign === "-" ? `-${operand}` : operand;
    const result = addDecimalStrings(initialAmount, signed);
    return result ? { ok: true, value: result } : { ok: false, reason: "out of range" };
  }

  // Absolute (plain number or k/m suffix)
  const absolute = parseAbsoluteAmount(raw);
  return absolute ? { ok: true, value: absolute } : { ok: false, reason: "invalid number" };
}

export function parseAbsoluteAmount(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const suffixMatch = trimmed.match(/^([0-9]*\.?[0-9]+)\s*([kKmM])$/);
  if (suffixMatch) {
    const base = parsePlainUnsignedDecimal(suffixMatch[1]!);
    const multiplier = suffixMatch[2]!.toLowerCase() === "k" ? 1_000 : 1_000_000;
    if (!base) {
      return null;
    }
    return multiplyDecimalStrings(base, String(multiplier));
  }
  // Plain unsigned number; reject negatives (no negative money-rate amounts).
  return parsePlainUnsignedDecimal(trimmed);
}

export function parsePlainUnsignedDecimal(text: string): string | null {
  const trimmed = text.trim();
  if (!/^[0-9]*\.?[0-9]+$/.test(trimmed)) {
    return null;
  }
  return normalizeDecimalString(trimmed);
}

export function displayDecimalParts(
  amount: string,
): { negative: boolean; integerPart: string; fractionPart: string } | null {
  const parsed = decimalToScaled(amount);
  if (!parsed) {
    return null;
  }
  const negative = parsed.coefficient < 0n;
  let coefficient = negative ? -parsed.coefficient : parsed.coefficient;
  let scale = parsed.scale;
  if (scale > 2) {
    const divisor = 10n ** BigInt(scale - 2);
    let quotient = coefficient / divisor;
    const remainder = coefficient % divisor;
    if (remainder * 2n >= divisor) {
      quotient += 1n;
    }
    coefficient = quotient;
    scale = 2;
  }
  const digits = coefficient.toString().padStart(scale + 1, "0");
  const integerPart = scale === 0 ? digits : digits.slice(0, -scale);
  const fractionPart = scale === 0 ? "" : digits.slice(-scale).replace(/0+$/, "");
  return { negative, integerPart, fractionPart };
}

export function formatMoneyRateDisplay(amount: string, currency: string): string {
  const parts = displayDecimalParts(amount);
  const symbol = currencySymbol(currency);
  if (!parts) {
    return `${symbol}${amount}`;
  }
  const groupedInteger = parts.integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const displayFraction = parts.fractionPart.length > 0 ? `.${parts.fractionPart}` : "";
  return `${symbol}${parts.negative ? "-" : ""}${groupedInteger}${displayFraction}`;
}

export function currencySymbol(currency: string): string {
  switch (currency) {
    case "USD":
    case "CAD":
      return "$";
    case "EUR":
      return "€";
    case "GBP":
      return "£";
    default:
      return "";
  }
}
