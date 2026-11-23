import { SegmentedControl } from "../../components/SegmentedControl";
import { Select } from "../../components/FormControls";
import { AsOfDatePill } from "../../components/as-of-date-pill";
import type { ChartControlSpec } from "./types";

export function ChartControls(props: {
  controls?: ChartControlSpec[];
  onChange?: (controlId: string, value: string) => void;
}) {
  if (!props.controls?.length) return null;
  return (
    <div className="flex flex-wrap items-end justify-end gap-[var(--space-3)]">
      {props.controls.map((control) => (
        <div key={control.id} className="flex flex-col gap-[var(--space-1)]">
          <span className="text-[length:var(--text-micro)] font-[var(--font-weight-medium)] text-[var(--color-text-muted)]">
            {control.label}
          </span>
          {control.kind === "date" && props.onChange ? (
            <AsOfDatePill
              value={control.value}
              label={control.label}
              minDate={control.minDate}
              maxDate={control.maxDate}
              onValueChange={(value) => props.onChange?.(control.id, value)}
            />
          ) : control.kind === "date" ? (
            <span className="rounded-[var(--radius-control)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-subtle)] px-[var(--space-3)] py-[var(--space-1)] text-[length:var(--text-control-sm)] text-[var(--color-text-secondary)]">
              {control.value}
            </span>
          ) : !props.onChange ? (
            <span className="rounded-[var(--radius-control)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-subtle)] px-[var(--space-3)] py-[var(--space-1)] text-[length:var(--text-control-sm)] text-[var(--color-text-secondary)]">
              {control.options.find((option) => option.value === control.value)?.label}
            </span>
          ) : control.display === "segmented" ? (
            <SegmentedControl
              size="sm"
              intent="neutral"
              ariaLabel={control.label}
              value={control.value}
              options={control.options}
              onChange={(value) => props.onChange?.(control.id, value)}
            />
          ) : (
            <Select
              size="sm"
              aria-label={control.label}
              className="w-auto min-w-[var(--size-chart-control-min-width)]"
              value={control.value}
              options={control.options}
              onValueChange={(value) => props.onChange?.(control.id, value)}
            />
          )}
        </div>
      ))}
    </div>
  );
}
