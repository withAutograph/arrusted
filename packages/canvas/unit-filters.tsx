import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { DataField } from "@autograph/generated-app-runtime/data";
import { Button, SearchableListbox, type ButtonSize } from "@autograph/components";
import { ChevronDown } from "@autograph/icons";
import { createLabelIndex, fieldHeader } from "@autograph/work-session-tools/labels";
import { chartFilterLimit, type ChartFilter } from "@autograph/work-session-tools/layout";

import { distinctLabels, resolveChartSpec } from "./chart-spec";
import type { CanvasClient } from "./client";
import { naturalOrder, titleField } from "./record-values";
import type { UnitSession } from "./use-canvas-session";

export type PickerOption = {
  value: string;
  label: string;
  /** Muted context after the label, e.g. the kind of record. */
  detail?: string;
};

/**
 * A compact picker (from the spike): a design-system button that becomes the
 * design-system searchable listbox while choosing. The listbox opens in place
 * (its option list floats over the page), so it works inside unit headers
 * without a second overlay.
 */
export function Picker({
  label,
  value,
  options,
  onChange,
  display,
  placeholder,
  size = "sm",
  width = "w-[var(--size-popover-min-width)]",
  leading,
  searchLabel,
}: {
  /** Accessible name of the control, e.g. "Department filter for Base pay vs range". */
  label: string;
  value: string | null;
  options: readonly PickerOption[];
  onChange: (value: string) => void;
  /** Text on the closed button; defaults to the selected option's label. */
  display?: ReactNode;
  placeholder?: string;
  size?: ButtonSize;
  /** Width of the open listbox (a token class). */
  width?: string;
  leading?: ReactNode;
  /** What the search field asks for, e.g. "Search departments". */
  searchLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = options.find((option) => option.value === value);
  if (!open)
    return (
      <Button
        aria-haspopup="listbox"
        aria-label={`${label}: ${selected?.label ?? placeholder ?? "none"}`}
        className="max-w-[var(--size-editor-popover-sm)] min-w-[var(--space-0)]"
        data-picker={label}
        intent="ghost"
        leading={leading}
        size={size}
        trailing={<ChevronDown aria-hidden className="size-[var(--size-icon-xs)] shrink-0" />}
        onClick={() => {
          setQuery("");
          setOpen(true);
        }}
      >
        <span className="block truncate">{display ?? selected?.label ?? placeholder}</span>
      </Button>
    );
  return (
    <div
      className={width}
      data-picker={label}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <SearchableListbox
        autoFocus
        ariaLabel={label}
        getOptionKey={(option: string) => option}
        options={options.map((option) => ({
          value: option.value,
          label: option.detail ? (
            <span className="flex items-baseline justify-between gap-[var(--space-2)]">
              <span className="truncate">{option.label}</span>
              <span className="shrink-0 text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
                {option.detail}
              </span>
            </span>
          ) : (
            option.label
          ),
          searchText: [option.label, option.detail].filter(Boolean).join(" "),
        }))}
        placeholder={searchLabel ?? `Search ${label.toLowerCase()}`}
        query={query}
        value={value}
        onQueryChange={setQuery}
        onValueChange={(next) => {
          setOpen(false);
          onChange(next);
        }}
      />
    </div>
  );
}

const all = "";
/** Related records a filter offers, at most. */
export const filterOptionLimit = 100;

/** Columns a header filter can offer: an enum's options or a relation's records. */
const filterable = (field: DataField | undefined): field is DataField =>
  field !== undefined && (field.type === "enum" || field.type === "relation");

/**
 * The columns a chart unit's header filters: the ones its config names, then
 * the column it groups by (a range chart's groups), each an enum or relation.
 */
export function chartFilterFields(client: CanvasClient, config: unknown): DataField[] {
  const resolved = resolveChartSpec(client.definition, config);
  if (!resolved.ok) return [];
  const { model, spec, group } = resolved.chart;
  const configured = spec.filters ?? [];
  const named = configured.map((filter) =>
    model.fields.find((field) => field.id === filter.field_id),
  );
  const fields = [...named, group].filter(filterable);
  const unique = fields.filter((field, index) => fields.indexOf(field) === index);
  // Every configured filter keeps its picker (the config holds at most the
  // limit); the group-by column gets one only while the config, counting
  // filters without a picker, has room to store its choice.
  const room =
    configured.length < chartFilterLimit ||
    configured.some((filter) => filter.field_id === group?.id);
  return room ? unique : unique.filter((field) => field !== group);
}

/**
 * The options of each relation column, named by their records' name column
 * and read over the session, in natural order (L3, L4 … L10).
 */
function useRelationOptions(
  client: CanvasClient,
  session: UnitSession,
  fields: readonly DataField[],
): Record<string, PickerOption[]> {
  const [options, setOptions] = useState<Record<string, PickerOption[]>>({});
  const sessionId = session.session?.id ?? null;
  const asOf = session.session?.as_of ?? null;
  const targets = fields
    .filter((field) => field.type === "relation" && typeof field.target_model === "string")
    .map((field) => field.target_model as string);
  const targetsKey = JSON.stringify([...new Set(targets)]);
  // A staged rename shows in the pickers: they re-read with the session.
  const revision = session.revision;
  const generation = session.generation;
  useEffect(() => {
    if (sessionId === null || asOf === null) return;
    let live = true;
    const labels = createLabelIndex(client.definition);
    void Promise.all(
      // Each target on its own: one unreadable lookup leaves the others' pickers.
      (JSON.parse(targetsKey) as string[]).map(async (target) => {
        const model = labels.modelById(target);
        const title = titleField(model);
        if (model === undefined || title === undefined) return [target, []] as const;
        try {
          const records = await client.data.list(model.id, {
            asOf,
            work: { sessionId },
            select: ["id", title.name],
            limit: filterOptionLimit,
          });
          const named = records
            .flatMap((record) => {
              const name = record[title.name];
              return typeof name === "string" && name.trim() !== ""
                ? [{ value: record.id, label: name }]
                : [];
            })
            .toSorted((a, b) => naturalOrder.compare(a.label, b.label));
          // Records named alike stay apart: "Sales", "Sales (2)", as charts name them.
          const distinct = distinctLabels(named.map((option) => [option.value, option.label]));
          return [
            target,
            named.map((option) => ({ ...option, label: distinct.get(option.value)! })),
          ] as const;
        } catch {
          // An unreadable lookup offers no records; its filter still shows "All".
          return [target, []] as const;
        }
      }),
    ).then(
      (entries) => {
        if (live) setOptions(Object.fromEntries(entries));
      },
      () => {
        // Unreadable lookups offer no records; the filter still shows "All".
      },
    );
    return () => {
      live = false;
    };
  }, [client, sessionId, asOf, targetsKey, revision, generation]);
  return options;
}

/**
 * A chart unit's header filters (the spike's `UnitFilters`): one picker per
 * column, "All Department" (the header as it is) or one value, stored in the unit's config. The
 * chart reads under them.
 */
export function ChartFilters({
  client,
  session,
  config,
  unitLabel,
  onChange,
}: {
  client: CanvasClient;
  session: UnitSession;
  /** The chart unit's config (`chartConfigSchema`). */
  config: unknown;
  unitLabel: string;
  onChange: (filters: ChartFilter[]) => void;
}) {
  const configKey = JSON.stringify(config ?? null);
  const fields = useMemo(
    () => chartFilterFields(client, JSON.parse(configKey) as unknown),
    [client, configKey],
  );
  const relations = useRelationOptions(client, session, fields);
  if (fields.length === 0) return null;
  const labels = createLabelIndex(client.definition);
  const configured = (config as { filters?: ChartFilter[] } | null)?.filters ?? [];
  const filters = configured.filter((filter) =>
    fields.some((field) => field.id === filter.field_id),
  );
  // Configured filters without a picker here are kept as they are.
  const untouched = configured.filter(
    (filter) => !fields.some((field) => field.id === filter.field_id),
  );
  return (
    <div
      className="flex flex-wrap items-center justify-end gap-[var(--space-1)]"
      data-chart-filters
    >
      {fields.map((field) => {
        const header = fieldHeader(field);
        const current = filters.find((filter) => filter.field_id === field.id)?.value;
        const options =
          field.type === "enum"
            ? (field.option_set ?? []).map((option) => ({
                value: option.id,
                label: labels.optionLabel(field, option.id),
              }))
            : (relations[field.target_model as string] ?? []);
        return (
          <Picker
            key={field.id}
            label={`${header} filter for ${unitLabel}`}
            searchLabel={`Search ${header}`}
            // The column header as it is, never pluralised: "All Job Family".
            options={[{ value: all, label: `All ${header}` }, ...options]}
            size="xs"
            value={typeof current === "string" ? current : all}
            onChange={(value) => {
              // Every offered column stays named; only its value changes.
              const next = fields.map((item): ChartFilter => {
                const kept = filters.find((filter) => filter.field_id === item.id)?.value;
                const chosen = item.id === field.id ? (value === all ? undefined : value) : kept;
                return chosen === undefined
                  ? { field_id: item.id }
                  : { field_id: item.id, value: chosen };
              });
              onChange([...untouched, ...next].slice(0, chartFilterLimit));
            }}
          />
        );
      })}
    </div>
  );
}
