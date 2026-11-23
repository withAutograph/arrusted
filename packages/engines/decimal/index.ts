/** Exact decimal arithmetic over a bigint coefficient and a base-10 scale. */
export type Decimal = { coefficient: bigint; scale: number };

// The kernel's decimal input contract (`kernel_apply_typed_value_valid`):
// `_` may follow any digit and is ignored.
const DECIMAL = /^([+-]?)(\d[\d_]*)(?:\.([\d_]+))?(?:[eE]([+-]?\d+))?$/;

/** Parses a kernel decimal string (optional `_` separators and exponent). */
export function parseDecimal(value: string): Decimal {
  const match = typeof value === "string" ? DECIMAL.exec(value) : null;
  if (!match) throw new Error(`Invalid decimal: ${value}`);
  const [, sign, integer, fraction = "", exponent = "0"] = match;
  const digits = `${integer!.replaceAll("_", "")}${fraction.replaceAll("_", "")}`;
  let scale = fraction.replaceAll("_", "").length - Number(exponent);
  let coefficient = BigInt(digits);
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { coefficient: sign === "-" ? -coefficient : coefficient, scale };
}

/** Canonical decimal string without exponent or trailing fractional zeros. */
export function formatDecimal({ coefficient, scale }: Decimal): string {
  if (coefficient === 0n) return "0";
  if (scale < 0) return `${coefficient}${"0".repeat(-scale)}`;
  const digits = (coefficient < 0n ? -coefficient : coefficient)
    .toString()
    .padStart(scale + 1, "0");
  const unsigned =
    scale === 0
      ? digits
      : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, "");
  return `${coefficient < 0n ? "-" : ""}${unsigned}`;
}

function aligned(left: Decimal, right: Decimal): [bigint, bigint, number] {
  const scale = Math.max(left.scale, right.scale);
  return [
    left.coefficient * 10n ** BigInt(scale - left.scale),
    right.coefficient * 10n ** BigInt(scale - right.scale),
    scale,
  ];
}

export function addDecimal(left: Decimal, right: Decimal): Decimal {
  const [a, b, scale] = aligned(left, right);
  return { coefficient: a + b, scale };
}

export function subtractDecimal(left: Decimal, right: Decimal): Decimal {
  const [a, b, scale] = aligned(left, right);
  return { coefficient: a - b, scale };
}

export function multiplyDecimal(left: Decimal, right: Decimal): Decimal {
  return { coefficient: left.coefficient * right.coefficient, scale: left.scale + right.scale };
}

/**
 * Exact when the quotient terminates; otherwise 28 significant digits rounded
 * half-even, without binary floating point. Division by zero is null.
 */
export function divideDecimal(dividend: Decimal, divisor: Decimal): Decimal | null {
  if (divisor.coefficient === 0n) return null;
  if (dividend.coefficient === 0n) return { coefficient: 0n, scale: 0 };
  const negative = dividend.coefficient < 0n !== divisor.coefficient < 0n;
  const abs = (value: bigint) => (value < 0n ? -value : value);
  let numerator = abs(dividend.coefficient) * 10n ** BigInt(divisor.scale);
  let denominator = abs(divisor.coefficient) * 10n ** BigInt(dividend.scale);
  let a = numerator,
    b = denominator;
  while (b) [a, b] = [b, a % b];
  numerator /= a;
  denominator /= a;
  let residual = denominator;
  let twos = 0,
    fives = 0;
  while (residual % 2n === 0n) {
    residual /= 2n;
    twos++;
  }
  while (residual % 5n === 0n) {
    residual /= 5n;
    fives++;
  }
  // Large quotients round to a negative scale; normalize so every result
  // keeps a non-negative scale that later arithmetic can use as an exponent.
  const signed = (coefficient: bigint, scale: number) => {
    const normalized = scale < 0 ? coefficient * 10n ** BigInt(-scale) : coefficient;
    return { coefficient: negative ? -normalized : normalized, scale: Math.max(scale, 0) };
  };
  if (residual === 1n) {
    const scale = Math.max(twos, fives);
    return signed(numerator * 2n ** BigInt(scale - twos) * 5n ** BigInt(scale - fives), scale);
  }
  // Determine the decimal order without binary floating-point conversion.
  let exponent = numerator.toString().length - denominator.toString().length;
  if (
    exponent >= 0
      ? numerator < denominator * 10n ** BigInt(exponent)
      : numerator * 10n ** BigInt(-exponent) < denominator
  )
    exponent--;
  const scale = 27 - exponent;
  if (scale >= 0) numerator *= 10n ** BigInt(scale);
  else denominator *= 10n ** BigInt(-scale);
  let coefficient = numerator / denominator;
  const twiceRemainder = 2n * (numerator % denominator);
  if (twiceRemainder > denominator || (twiceRemainder === denominator && coefficient % 2n !== 0n))
    coefficient++;
  return signed(coefficient, scale);
}

/** Exact ordering: negative, zero or positive as `left` is below, equal to or above `right`. */
export function compareDecimal(left: Decimal, right: Decimal): number {
  const [a, b] = aligned(left, right);
  return a < b ? -1 : a > b ? 1 : 0;
}
