export type ClassValue =
  | string
  | false
  | null
  | undefined
  | Record<string, boolean | null | undefined>;

export function cx(...values: ClassValue[]): string {
  const classes: string[] = [];
  for (const value of values) {
    if (!value) continue;
    if (typeof value === "string") {
      classes.push(value);
      continue;
    }
    for (const [key, enabled] of Object.entries(value)) {
      if (enabled) classes.push(key);
    }
  }
  return classes.join(" ");
}

export type Size = "xs" | "sm" | "md" | "lg";
export type Intent = "primary" | "secondary" | "danger" | "ghost";

export const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-action-primary)]/30";
