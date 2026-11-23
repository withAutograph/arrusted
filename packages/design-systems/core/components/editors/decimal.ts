const DECIMAL_PATTERN = /^-?(?:\d+|\d*\.\d+)$/;
const MAX_RUST_DECIMAL_COEFFICIENT = "79228162514264337593543950335";
const MAX_FRACTION_DIGITS = 28;

export type ParsedDecimalInput = {
  negative: boolean;
  unsigned: string;
  integerPart: string;
  fractionPart: string;
  coefficient: string;
};

export function parseDecimalInput(value: string): ParsedDecimalInput | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || !DECIMAL_PATTERN.test(trimmed)) {
    return null;
  }

  const negative = trimmed.startsWith("-");
  let unsigned = negative ? trimmed.slice(1) : trimmed;
  if (unsigned.startsWith(".")) {
    unsigned = `0${unsigned}`;
  }

  const [integerPart = "", fractionPart = ""] = unsigned.split(".");
  if (fractionPart.length > MAX_FRACTION_DIGITS) {
    return null;
  }

  const coefficient = `${integerPart}${fractionPart}`.replace(/^0+/, "") || "0";
  if (
    coefficient.length > MAX_RUST_DECIMAL_COEFFICIENT.length ||
    (coefficient.length === MAX_RUST_DECIMAL_COEFFICIENT.length &&
      coefficient > MAX_RUST_DECIMAL_COEFFICIENT)
  ) {
    return null;
  }

  return { negative, unsigned, integerPart, fractionPart, coefficient };
}

export function normalizeDecimalInput(value: string): string | null {
  const parsed = parseDecimalInput(value);
  return parsed ? `${parsed.negative ? "-" : ""}${parsed.unsigned}` : null;
}
