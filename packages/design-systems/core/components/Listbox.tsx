import type { SelectHTMLAttributes } from "react";

import { ChevronDown } from "../icons";
import { cx, focusRing } from "./utils";

export type NativeSelectOption = { value: string; label: string; disabled?: boolean };

export type NativeSelectProps = Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  "aria-label" | "children" | "className" | "defaultValue" | "multiple" | "onChange" | "value"
> & {
  value: string;
  options: readonly NativeSelectOption[];
  onValueChange: (value: string) => void;
  ariaLabel: string;
  className?: string;
};

export function NativeSelect(props: NativeSelectProps) {
  const { value, options, onValueChange, ariaLabel, disabled, className, ...rest } = props;
  return (
    <span className={cx("relative block w-full", className)}>
      <select
        {...rest}
        aria-label={ariaLabel}
        value={value}
        disabled={disabled}
        onChange={(event) => onValueChange(event.target.value)}
        className={cx(
          "h-[var(--size-input-md)] w-full appearance-none rounded-[var(--radius-control)] border border-[var(--color-border-strong)] bg-[var(--color-bg-surface)] px-[var(--space-3)] pr-[var(--space-8)] text-[length:var(--text-control-md)] shadow-[var(--shadow-subtle)]",
          disabled && "cursor-not-allowed opacity-50",
          focusRing,
        )}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-[var(--space-3)] size-[var(--size-icon-sm)] -translate-y-1/2 text-[var(--color-text-muted)]"
      />
    </span>
  );
}

/** @deprecated Use `NativeSelect`; this component renders a native `<select>`, not a listbox popup. */
export const Listbox = NativeSelect;

/** @deprecated Use `NativeSelectOption`. */
export type ListboxOption = NativeSelectOption;

/** @deprecated Use `NativeSelectProps`. */
export type ListboxProps = NativeSelectProps;
