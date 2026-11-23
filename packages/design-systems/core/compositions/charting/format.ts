import type { ChartValueFormat } from "./types";

const DEFAULT_FORMAT: ChartValueFormat = { kind: "number", maximumFractionDigits: 1 };

export function createChartValueFormatter(format: ChartValueFormat = DEFAULT_FORMAT) {
  if (format.kind === "currency") {
    const formatter = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: format.currency,
      notation: "compact",
      maximumFractionDigits: format.maximumFractionDigits ?? 1,
    });
    return (value: number) => formatter.format(value);
  }

  if (format.kind === "percent") {
    const formatter = new Intl.NumberFormat(undefined, {
      style: "percent",
      maximumFractionDigits: format.maximumFractionDigits ?? 1,
    });
    return (value: number) => formatter.format(value);
  }

  const formatter = new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: format.maximumFractionDigits ?? 1,
  });
  return (value: number) => formatter.format(value);
}
