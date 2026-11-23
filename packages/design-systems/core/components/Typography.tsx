import type { ReactNode } from "react";
import { cx } from "./utils";

export type TypographyTone = "primary" | "secondary" | "muted" | "danger";
export type TypographyVariant =
  | "page-title"
  | "section-title"
  | "title"
  | "body"
  | "body-strong"
  | "caption"
  | "micro";

const variantClass: Record<TypographyVariant, string> = {
  "page-title":
    "text-[length:var(--text-page-title)] leading-[var(--leading-page-title)] font-[var(--font-weight-semibold)]",
  "section-title":
    "text-[length:var(--text-section-title)] leading-[var(--leading-section-title)] font-[var(--font-weight-semibold)]",
  title:
    "text-[length:var(--text-title)] leading-[var(--leading-title)] font-[var(--font-weight-semibold)]",
  body: "text-[length:var(--text-body)] leading-[var(--leading-body)] font-[var(--font-weight-normal)]",
  "body-strong":
    "text-[length:var(--text-body)] leading-[var(--leading-body)] font-[var(--font-weight-semibold)]",
  caption:
    "text-[length:var(--text-caption)] leading-[var(--leading-caption)] font-[var(--font-weight-normal)]",
  micro:
    "text-[length:var(--text-micro)] leading-[var(--leading-micro)] font-[var(--font-weight-medium)] uppercase tracking-[var(--tracking-micro)]",
};

const toneClass: Record<TypographyTone, string> = {
  primary: "text-[var(--color-text-primary)]",
  secondary: "text-[var(--color-text-secondary)]",
  muted: "text-[var(--color-text-muted)]",
  danger: "text-[var(--color-status-danger)]",
};

export type TypographyProps = {
  as?: "p" | "span" | "div" | "h1" | "h2" | "h3";
  variant?: TypographyVariant;
  tone?: TypographyTone;
  className?: string;
  children: ReactNode;
};

export function Typography(props: TypographyProps) {
  const { as, variant = "body", tone = "primary", className, children } = props;
  const Element =
    as ?? (variant === "page-title" ? "h1" : variant === "section-title" ? "h2" : "p");
  return (
    <Element className={cx(variantClass[variant], toneClass[tone], className)}>{children}</Element>
  );
}
