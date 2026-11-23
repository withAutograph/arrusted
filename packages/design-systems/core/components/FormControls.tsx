import type {
  ChangeEvent,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { ChevronDown } from "../icons";
import { cx, focusRing, type Size } from "./utils";

const sizeClass: Record<Size, string> = {
  xs: "h-[var(--size-input-xs)] px-[var(--space-2)] text-[length:var(--text-control-xs)]",
  sm: "h-[var(--size-input-sm)] px-[var(--space-2-5)] text-[length:var(--text-control-sm)]",
  md: "h-[var(--size-input-md)] px-[var(--space-3)] text-[length:var(--text-control-md)]",
  lg: "h-[var(--size-input-lg)] px-[var(--space-4)] text-[length:var(--text-control-lg)]",
};

const controlClass =
  "w-full rounded-[var(--radius-control)] border border-[var(--color-border-strong)] bg-[var(--color-bg-surface)] font-[family-name:var(--font-sans)] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-disabled)]";

export type FieldFrameProps = {
  label?: ReactNode;
  helper?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  htmlFor?: string;
  messageId?: string;
  children: ReactNode;
  className?: string;
};

export function FieldFrame(props: FieldFrameProps) {
  const { label, helper, error, required, htmlFor, messageId, children, className } = props;
  const content = (
    <>
      {label ? (
        htmlFor ? (
          <label
            htmlFor={htmlFor}
            className="text-[length:var(--text-caption)] font-[var(--font-weight-semibold)] text-[var(--color-text-secondary)]"
          >
            {label}
            {required ? (
              <>
                <span
                  aria-hidden="true"
                  className="ml-[var(--space-1)] text-[var(--color-status-danger)]"
                >
                  *
                </span>
                <span className="sr-only"> (required)</span>
              </>
            ) : null}
          </label>
        ) : (
          <span className="text-[length:var(--text-caption)] font-[var(--font-weight-semibold)] text-[var(--color-text-secondary)]">
            {label}
            {required ? (
              <>
                <span
                  aria-hidden="true"
                  className="ml-[var(--space-1)] text-[var(--color-status-danger)]"
                >
                  *
                </span>
                <span className="sr-only"> (required)</span>
              </>
            ) : null}
          </span>
        )
      ) : null}
      {children}
      {error ? (
        <span
          id={messageId}
          className="text-[length:var(--text-caption)] text-[var(--color-status-danger)]"
        >
          {error}
        </span>
      ) : helper ? (
        <span
          id={messageId}
          className="text-[length:var(--text-caption)] text-[var(--color-text-muted)]"
        >
          {helper}
        </span>
      ) : null}
    </>
  );
  if (htmlFor) {
    return (
      <div className={cx("flex w-full flex-col gap-[var(--space-1)] text-left", className)}>
        {content}
      </div>
    );
  }
  return (
    <label className={cx("flex w-full flex-col gap-[var(--space-1)] text-left", className)}>
      {content}
    </label>
  );
}

export type TextFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "size"> & {
  size?: Size;
  trailing?: ReactNode;
  trailingClassName?: string;
  onValueChange?: (value: string) => void;
};

export function TextField(props: TextFieldProps) {
  const { size = "md", trailing, trailingClassName, onValueChange, className, ...rest } = props;
  const hasTrailing = trailing !== null && trailing !== undefined && trailing !== false;
  const input = (
    <input
      {...rest}
      className={cx(
        controlClass,
        focusRing,
        sizeClass[size],
        "aria-[invalid=true]:border-[var(--color-status-danger)]",
        hasTrailing && "pr-[var(--space-8)]",
        className,
      )}
      onChange={(event: ChangeEvent<HTMLInputElement>) => onValueChange?.(event.target.value)}
    />
  );
  if (!hasTrailing) {
    return input;
  }
  return (
    <div className="relative w-full">
      {input}
      <span
        className={cx(
          "absolute right-[var(--space-2)] top-1/2 -translate-y-1/2",
          trailingClassName,
        )}
      >
        {trailing}
      </span>
    </div>
  );
}

export type TextAreaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange"> & {
  onValueChange?: (value: string) => void;
};

export function TextArea(props: TextAreaProps) {
  const { onValueChange, className, rows = 4, ...rest } = props;
  return (
    <textarea
      {...rest}
      rows={rows}
      className={cx(
        controlClass,
        focusRing,
        "min-h-[calc(var(--size-input-md)*2.4)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-body)]",
        className,
      )}
      onChange={(event: ChangeEvent<HTMLTextAreaElement>) => onValueChange?.(event.target.value)}
    />
  );
}

export type SelectOption = { value: string; label: ReactNode; disabled?: boolean };
export type SelectProps = Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  "children" | "onChange" | "size"
> & {
  size?: Size;
  options: SelectOption[];
  onValueChange?: (value: string) => void;
};

export function Select(props: SelectProps) {
  const { size = "md", options, onValueChange, className, ...rest } = props;
  const rootSizingClasses =
    className?.split(/\s+/u).filter((token) => token === "w-auto" || token.startsWith("max-w-")) ??
    [];
  return (
    <span
      className={cx(
        "relative",
        rootSizingClasses.length
          ? ["inline-block", ...rootSizingClasses].join(" ")
          : "block w-full",
      )}
    >
      <select
        {...rest}
        className={cx(
          controlClass,
          focusRing,
          sizeClass[size],
          "appearance-none pr-[var(--space-8)]",
          className,
        )}
        onChange={(event: ChangeEvent<HTMLSelectElement>) => onValueChange?.(event.target.value)}
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

export type CheckboxProps = {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  required?: boolean;
  className?: string;
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
};

export function Checkbox(props: CheckboxProps) {
  const {
    checked,
    onCheckedChange,
    label,
    disabled,
    required,
    className,
    id,
    "aria-describedby": ariaDescribedBy,
    "aria-invalid": ariaInvalid,
  } = props;
  return (
    <label className={cx("inline-flex items-center gap-[var(--space-2)]", className)}>
      {/* `.checkbox` (defined in `tokens/theme.css`) gives the
       * round shape, centered SVG checkmark, and primary-fill checked
       * state — matching AG Grid Quartz's row-selection / filter-list
       * checkboxes so every checkbox in the app reads as the same atom. */}
      <input
        type="checkbox"
        id={id}
        checked={checked}
        disabled={disabled}
        required={required}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        className={cx("checkbox", focusRing)}
        onChange={(event) => onCheckedChange(event.target.checked)}
      />
      {label ? (
        <span className="text-[length:var(--text-body)] text-[var(--color-text-secondary)]">
          {label}
          {required ? (
            <span
              aria-hidden="true"
              className="ml-[var(--space-1)] text-[var(--color-status-danger)]"
            >
              *
            </span>
          ) : null}
        </span>
      ) : null}
    </label>
  );
}

export type ToggleProps = {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
};

export function Toggle(props: ToggleProps) {
  const { checked, onCheckedChange, label, disabled } = props;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cx("inline-flex items-center gap-[var(--space-2)]", disabled && "opacity-50")}
    >
      <span
        className={cx(
          "inline-flex h-[var(--size-toggle-track-height)] w-[var(--size-toggle-track-width)] items-center rounded-[var(--radius-pill)] p-[var(--space-1)] transition-colors",
          checked ? "bg-[var(--color-action-primary)]" : "bg-[var(--color-bg-toggle-off)]",
        )}
      >
        <span
          className={cx(
            "h-[var(--size-toggle-thumb)] w-[var(--size-toggle-thumb)] rounded-[var(--radius-pill)] bg-[var(--color-bg-surface)] transition-transform",
            checked &&
              "translate-x-[calc(var(--size-toggle-track-width)-var(--size-toggle-thumb)-var(--space-2))]",
          )}
        />
      </span>
      {label ? <span className="text-[length:var(--text-body)]">{label}</span> : null}
    </button>
  );
}
