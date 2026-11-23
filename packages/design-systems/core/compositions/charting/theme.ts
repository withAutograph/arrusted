import { useEffect, useState } from "react";
import type { ChartPaletteColor } from "./types";

export type ChartCanvasTheme = {
  palette: Record<ChartPaletteColor, string>;
  axisText: string;
  gridLine: string;
  fontFamily: string;
  fontSize: number;
  cornerRadius: number;
};

// Token names spelled out in full: Tailwind emits a theme variable only when
// its name appears in scanned source, so a built-up `--color-${key}` would
// leave the palette undefined in any app that does not mention it elsewhere.
const PALETTE_TOKENS: Record<ChartPaletteColor, string> = {
  "chart-1": "--color-chart-1",
  "chart-2": "--color-chart-2",
  "chart-3": "--color-chart-3",
  "chart-4": "--color-chart-4",
};
const PALETTE_KEYS = Object.keys(PALETTE_TOKENS) as ChartPaletteColor[];

export function useResolvedChartTheme(): ChartCanvasTheme | null {
  const [theme, setTheme] = useState<ChartCanvasTheme | null>(null);

  useEffect(() => {
    const resolve = () => {
      const styles = getComputedStyle(document.documentElement);
      const token = (name: string) => styles.getPropertyValue(name).trim();
      const probe = document.createElement("span");
      probe.style.position = "fixed";
      probe.style.visibility = "hidden";
      document.documentElement.append(probe);
      const resolved = (property: string, tokenName: string) => {
        probe.style.setProperty(property, `var(${tokenName})`);
        return getComputedStyle(probe).getPropertyValue(property).trim();
      };
      const palette = Object.fromEntries(
        PALETTE_KEYS.map((key) => [key, resolved("color", PALETTE_TOKENS[key])]),
      ) as Record<ChartPaletteColor, string>;
      const required = [
        ...Object.values(palette),
        resolved("color", "--color-text-secondary"),
        resolved("color", "--color-border-subtle"),
        token("--font-sans"),
        token("--text-caption"),
        token("--radius-xs"),
      ];
      if (required.some((value) => !value)) {
        probe.remove();
        return;
      }
      setTheme({
        palette,
        axisText: resolved("color", "--color-text-secondary"),
        gridLine: resolved("color", "--color-border-subtle"),
        fontFamily: resolved("font-family", "--font-sans"),
        fontSize: cssPixels(resolved("font-size", "--text-caption")),
        cornerRadius: cssPixels(resolved("border-top-left-radius", "--radius-xs")),
      });
      probe.remove();
    };

    resolve();
    const observer = new MutationObserver(resolve);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  return theme;
}

export function chartColor(
  theme: ChartCanvasTheme,
  color: ChartPaletteColor | undefined,
  index: number,
) {
  return theme.palette[color ?? (`chart-${(index % 4) + 1}` as ChartPaletteColor)];
}

export function chartAxis(theme: ChartCanvasTheme) {
  return {
    label: {
      color: theme.axisText,
      fontFamily: theme.fontFamily,
      fontSize: theme.fontSize,
    },
    gridLine: { style: [{ stroke: theme.gridLine }] },
  };
}

function cssPixels(value: string) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
