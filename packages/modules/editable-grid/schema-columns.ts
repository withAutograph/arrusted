// Schema-driven AG Grid `ColDef` construction.
//
// The editable-grid hook owns the `GridColumnContext` (the bundle of
// `fieldGetter` / `fieldSetter` / `dirtyCellClassRules` / `diffCellRenderer`
// factories). Apps that drive the grid off a typed schema (substrate-style:
// each model declares a list of fields with a type + label + target_model)
// would otherwise have to hand-roll the per-column plumbing for every field
// — same shape every time, with only the per-field validator / formatter /
// width hint actually varying.
//
// This module is the helper that walks a schema's model, maps each field's
// type to the right `cellEditor` + `valueGetter` + `valueSetter` + diff
// renderer, and applies per-field overrides supplied by the app. The hook
// calls into it when an app passes `{ schema, model, fieldOverrides? }`.
//
// Layer rules: this module CANNOT import from an app-generated client (or any
// app-narrowed client). It imports generic wire DTOs from `@contracts`.

import type {
  ColDef,
  ValueFormatterParams,
  ValueGetterParams,
  ValueSetterParams,
} from "ag-grid-community";

import {
  parseDatetimeText,
  splitTextListText,
  type RelationOptionItem,
  type RelationOptionSearch,
} from "@autograph/components";
import { invalid, VALID, type FieldValidator } from "@engines/field-validation/index";
import { serializeRecordKey } from "@engines/field-value-adapter/index";
import { formatIsoDateLong, formatMoneyRatePeriod } from "@engines/format/index";
import type { Field, FieldValue, Model, RecordKey, Schema, VisibleRecord } from "@contracts";

import { agGridLeafEditor, type LeafEditorKind } from "./cell-editors";
import { isEditableGridField } from "./field-capabilities";
// Type-only circular import: `index.tsx` re-exports from this module, so we
// must NOT import any runtime symbol from it here (would deadlock the module
// graph). `GridColumnContext` and `EditableGridMode` are types — TypeScript
// erases them at compile time, so the runtime import edge is one-way (index
// → schema-columns) and the type edge is bidirectional.
import type { GridColumnContext, EditableGridMode } from "./index";

// Apps may carry additional metadata on Field (e.g. `cluster` for logical
// field grouping in sidebar forms / header groups / filter-to-cluster).
// Editable-grid does not own those concepts — they live in the app's
// schema layer and are consumed by whichever surface needs them.

// Relation option shape the relation/person picker editors consume via
// `cellEditorParams.fieldType.relationOptions`. Re-declared here (rather than
// pulled from the editor module) so apps depend on one stable surface.
type RelationOptionKey =
  | { type: "record_id"; value: string }
  | { type: "external_key"; value: string };

export type RelationOption = {
  key: RelationOptionKey;
  label: string;
  searchText?: string;
  // Other keys that name the same record (e.g. its external key). Stored
  // values keyed this way resolve to this option's label and selection.
  aliasKeys?: ReadonlyArray<RelationOptionKey>;
  // A retired target: it still labels stored values, but is never offered
  // as a new choice (writes reject retired targets).
  retired?: boolean;
};

// The options a picker or paste may choose: retired targets left out.
function selectableRelationOptions(
  options: ReadonlyArray<RelationOption>,
): ReadonlyArray<RelationOption> {
  return options.some((option) => option.retired)
    ? options.filter((option) => !option.retired)
    : options;
}

// Options by every key that names them (`<type>:<value>`), aliases included.
export function relationOptionsByKey(
  options: ReadonlyArray<RelationOption>,
): ReadonlyMap<string, RelationOption> {
  const byKey = new Map<string, RelationOption>();
  for (const option of options) {
    byKey.set(serializeRecordKey(option.key), option);
    for (const alias of option.aliasKeys ?? []) byKey.set(serializeRecordKey(alias), option);
  }
  return byKey;
}

type RelationEditorKind = Extract<LeafEditorKind, "relation-picker" | "person-picker">;
type EditableSchemaFieldType = Extract<
  Field["type"],
  "text" | "iso_country" | "iso_currency" | "number" | "date" | "money_rate" | "relation"
>;

// Per-field override the app supplies inside `fieldOverrides[fieldId]`. Every
// slot is optional — the schema-driven default is applied when an override is
// absent.
//
// - `validate`: per-cell validator wired into the column's `valueSetter` so
//   pre-commit failures surface inline (red border + tooltip) without
//   touching the buffer.
// - `formatValue`: per-cell formatter used by the diff renderer for BOTH the
//   current value and the `was X` micro-text. Defaults to `String(primitive)`
//   for fields whose type doesn't carry an obvious shape (text/number/date);
//   relation falls back to the raw key when no formatter is supplied (apps
//   typically supply one so the cell renders "Engineering" instead of a UUID).
// - `relationOptions`: options for relation/person fields: the picker's list,
//   and the labels of stored values. A relation field is editable when it has
//   options or `searchRelationOptions`.
// - `searchRelationOptions`: searches the target's records as the user types,
//   so the picker offers records that are not loaded; `relationOptions` then
//   only label values (and resolve pastes). Apps add the records picked from
//   search to `relationOptions`, told of each pick by `onRelationOptionPicked`.
// - `valueOptions`: fixed vocabulary options for text fields that should
//   render as a single-select dropdown instead of a freeform text input.
// - `width` / `flex` / `minWidth`: per-field AG Grid sizing hints, surfaced
//   so the page can pin a narrow boolean column or flex a long text column
//   without re-declaring the whole `ColDef`.
// - `headerName`: override the schema's `label` for the column header.
//   Defaults to `field.label`.
// - `editor`: override the schema-driven editor choice. Relation fields only
//   accept relation-compatible editors (`relation-picker` / `person-picker`);
//   incompatible relation overrides throw at column-build time before a user
//   can commit a malformed relation value.
// - `editable`: per-mode editability. Boolean → unconditional outside read
//   mode; function → called with the current `mode` so the override can
//   toggle per-mode (e.g. tweak mode allows only `is_open` and `end_date`
//   editing). Edit mode defaults to true; tweak mode defaults to false unless
//   the app explicitly opts the field in. `Field.required` is independent —
//   `editable` here is the AG Grid per-column flag, not a required-validator.
// - `editorDefaults`: per-row defaults the editor uses for an EMPTY value
//   (money_rate: the currency and period it starts on, shown in its selects).
//   Opt-in; without it an empty money value starts on the field type's first
//   currency and period, as before. A stored value always keeps its own unit.
export type EditorDefaults = { currency?: string; period?: string };
export type FieldOverride = {
  validate?: FieldValidator;
  editorDefaults?: (row: VisibleRecord) => EditorDefaults | undefined;
  formatValue?: (value: unknown, fieldValue: FieldValue | null | undefined) => string;
  relationOptions?: ReadonlyArray<RelationOption>;
  searchRelationOptions?: RelationOptionSearch;
  onRelationOptionPicked?: (option: RelationOptionItem) => void;
  valueOptions?: ReadonlyArray<string>;
  width?: number;
  flex?: number;
  minWidth?: number;
  headerName?: string;
  editor?: LeafEditorKind;
  editable?: boolean | ((mode: EditableGridMode) => boolean);
};

// Map of fieldId → override. Fields with no entry use schema defaults.
export type FieldOverrides = Readonly<Record<string, FieldOverride | undefined>>;

// Map of target model id → picker options for relations into that model.
export type RelationOptionsByModel = Readonly<
  Record<string, ReadonlyArray<RelationOption> | undefined>
>;

// Map of target model id → search for relations into that model.
export type RelationSearchByModel = Readonly<Record<string, RelationOptionSearch | undefined>>;

// Options the hook (or an app-direct caller) passes alongside the schema
// + model. `fieldOrder` reorders the schema's natural order; `hidden`
// omits fields entirely (useful for internal-only fields the schema
// declares but the view shouldn't surface). `relationOptionsByModel`
// supplies picker options and labels for relation fields that have no
// per-field override, keyed by the field's target model; `relationSearchByModel`
// likewise supplies their search, and `onRelationOptionPicked` hears of each
// option picked from it.
export type BuildSchemaColumnsOptions = {
  fieldOverrides?: FieldOverrides;
  fieldOrder?: ReadonlyArray<string>;
  hidden?: ReadonlyArray<string>;
  relationOptionsByModel?: RelationOptionsByModel;
  relationSearchByModel?: RelationSearchByModel;
  onRelationOptionPicked?: OnRelationOptionPicked;
};

// Told which searched option was picked for a link into `targetModelId`.
export type OnRelationOptionPicked = (targetModelId: string, option: RelationOptionItem) => void;

// Relation cells never show a raw record key. A key with no known label (the
// target's records are not loaded, or it is not visible) renders as this.
export const UNRESOLVED_RELATION_LABEL = "Unknown record";

// A stored relation key's label from picker options. A lookup-or-create key
// names the record it will create; a key no option names reads as
// `unknownLabel`, never as the key itself.
export function relationKeyLabeler(
  options: ReadonlyArray<RelationOption>,
  unknownLabel: string = UNRESOLVED_RELATION_LABEL,
): (key: RecordKey) => string {
  const byKey = relationOptionsByKey(options);
  return (key) =>
    key.type === "lookup_or_create"
      ? key.value.label
      : (byKey.get(serializeRecordKey(key))?.label ?? unknownLabel);
}

// The options a bare key value (a paste, or the set-filter list's primitive)
// names as a record id and as an external key.
function relationOptionsForPrimitive(
  byKey: ReadonlyMap<string, RelationOption>,
  value: string,
): { byRecordId?: RelationOption; byExternalKey?: RelationOption } {
  return {
    byRecordId: byKey.get(serializeRecordKey({ type: "record_id", value })),
    byExternalKey: byKey.get(serializeRecordKey({ type: "external_key", value })),
  };
}

// Cell and filter-list formatter for a relation column.
export function relationLabelFormatter(
  options: ReadonlyArray<RelationOption>,
  unknownLabel: string = UNRESOLVED_RELATION_LABEL,
): (value: unknown, fieldValue: FieldValue | null | undefined) => string {
  const byKey = relationOptionsByKey(options);
  const labelKey = relationKeyLabeler(options, unknownLabel);
  return (value, fieldValue) => {
    if (fieldValue?.type === "relation") return labelKey(fieldValue.value);
    // Only a primitive (the filter list): the bare key value, read as a
    // record id, else as an external key.
    if (typeof value !== "string" || value === "") return "";
    const { byRecordId, byExternalKey } = relationOptionsForPrimitive(byKey, value);
    // One record's id and another's external key: ambiguous, so unknown.
    if (byRecordId && byExternalKey && byRecordId !== byExternalKey) return unknownLabel;
    return (byRecordId ?? byExternalKey)?.label ?? unknownLabel;
  };
}

// Fills relation picker options, labels and search from the target model when
// the app supplied no per-field override for them.
function withRelationTargetDefaults(
  field: Field,
  override: FieldOverride | undefined,
  options: BuildSchemaColumnsOptions,
): FieldOverride | undefined {
  if (field.type !== "relation") return override;
  const target = field.target_model ?? undefined;
  const relationOptions =
    override?.relationOptions ??
    (target ? options.relationOptionsByModel?.[target] : undefined) ??
    EMPTY_RELATION_OPTIONS;
  const searchRelationOptions =
    override?.searchRelationOptions ??
    (target ? options.relationSearchByModel?.[target] : undefined);
  const onPicked = options.onRelationOptionPicked;
  return {
    ...override,
    relationOptions,
    formatValue: override?.formatValue ?? relationLabelFormatter(relationOptions),
    ...(searchRelationOptions ? { searchRelationOptions } : {}),
    ...(!override?.onRelationOptionPicked && target && onPicked
      ? { onRelationOptionPicked: (option: RelationOptionItem) => onPicked(target, option) }
      : {}),
  };
}

// Resolve a model from a schema by id. Returns `null` when the model isn't
// in the schema (apps may render against a not-yet-loaded schema; the hook
// gracefully returns no columns rather than throwing).
export function findModel(schema: Schema, modelId: string): Model | null {
  for (const m of schema.models) {
    if (m.id === modelId) return m;
  }
  return null;
}

function enumOptionValidator(
  field: Field,
  optionIds: ReadonlySet<string>,
  overrideValidate: FieldValidator | undefined,
): FieldValidator {
  return (next, context) => {
    if (next != null && (next.type !== "enum" || !optionIds.has(next.value))) {
      return invalid(`Select a valid ${field.label}`);
    }
    return overrideValidate ? overrideValidate(next, context) : VALID;
  };
}

// Pick the `LeafEditorKind` for a given field. Relation columns use the
// generic `relation-picker` by default. App-local person-like relations can
// opt into `person-picker` through `fieldOverrides[fieldId].editor`, keeping
// app model names out of this reusable module.
//
// Returns `null` for fields whose type has no native editor today; column-
// build renders them display-only (no `cellEditor`, no `valueSetter`):
//
//   - `bool` — handled by AG Grid's built-in `agCheckboxCellEditor` branch
//     in `buildSchemaColumnDef` below, NOT via a leaf-editor bundle.
//   - `datetime` / `text_list` — handled by their own branch in
//     `buildSchemaColumnDef` (the editors commit full FieldValues), not here.
//   - `json` / `known_aliases` — DELIBERATELY non-editable. Routing through
//     `text-cell-editor` would coerce structured values through
//     `makeFieldValue` and lose shape — the silent-data-loss path that
//     cubic + the merge reviewer flagged on PR #62.
//
// Unsupported field types are gated read-only: every type still RENDERS (via
// the diff-cell renderer + formatter), users see the value, but the edit
// path is gated until a type-aware editor lands.
function editorForFieldType(field: Field): LeafEditorKind | null {
  switch (field.type) {
    case "text":
    case "iso_country":
    case "iso_currency":
    case "number":
      return field.type === "number" ? "number-cell-editor" : "text-cell-editor";
    case "date":
      return "date-picker";
    case "money_rate":
      return "money-rate-editor";
    case "relation":
      return "relation-picker";
    case "bool":
      // Bool is handled via the built-in AG Grid checkbox editor at the
      // ColDef level (string `agCheckboxCellEditor`), NOT one of our leaf
      // editor bundles — see `buildSchemaColumnDef` below for the special-
      // case branch.
      return null;
    default:
      return null;
  }
}

function isEditableSchemaFieldType(fieldType: Field["type"]): fieldType is EditableSchemaFieldType {
  return (
    fieldType === "text" ||
    fieldType === "iso_country" ||
    fieldType === "iso_currency" ||
    fieldType === "number" ||
    fieldType === "date" ||
    fieldType === "money_rate" ||
    fieldType === "relation"
  );
}

function fieldSetterValueType(fieldType: EditableSchemaFieldType): FieldValue["type"] {
  switch (fieldType) {
    case "text":
    case "iso_country":
    case "iso_currency":
      return "text";
    case "number":
    case "date":
    case "money_rate":
    case "relation":
      return fieldType;
    default: {
      const _exhaustive: never = fieldType;
      return _exhaustive;
    }
  }
}

function relationEditorForField(
  field: Field,
  override: FieldOverride | undefined,
): RelationEditorKind {
  const editor = override?.editor;
  if (!editor) return "relation-picker";
  if (editor === "relation-picker" || editor === "person-picker") return editor;
  throw new Error(
    `[editable-grid] relation field "${field.id}" cannot use non-relation editor "${editor}"`,
  );
}

// Default per-type primitive formatter. Apps override via
// `fieldOverrides[id].formatValue` for richer renders (e.g. money_rate's
// `$155K/yr` shape, or relation's id → label resolution).
function defaultFormatValue(value: unknown, _fieldValue: FieldValue | null | undefined): string {
  if (value == null) return "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function defaultMoneyRateFormat(fieldValue: FieldValue | null | undefined): string {
  if (fieldValue?.type !== "money_rate") return "";
  const { amount, currency, period } = fieldValue.value;
  // Complete, not compact: the shared fallback never rounds the stored amount.
  return `${groupDigits(amount)} ${currency}/${formatMoneyRatePeriod(period)}`;
}

// Thousands separators on a decimal string without passing it through a float.
function groupDigits(amount: string): string {
  const match = /^(-?)(\d+)(\.\d+)?$/u.exec(amount);
  if (!match) return amount;
  const [, sign, whole, fraction = ""] = match;
  return `${sign}${whole!.replace(/\B(?=(\d{3})+(?!\d))/gu, ",")}${fraction}`;
}

// Dates read as "Nov 2, 2026" unless the app formats them; ISO strings stay
// the stored value and the sort key.
export function defaultDateFormat(
  value: unknown,
  fieldValue: FieldValue | null | undefined,
): string {
  const iso = fieldValue?.type === "date" ? fieldValue.value : value;
  return typeof iso === "string" && iso !== "" ? formatIsoDateLong(iso) : "";
}

// Date-times read as "Nov 2, 2026, 14:30 UTC" (the zone the editor uses); the
// stored ISO string stays the cell value for sort, filter and copy.
export function defaultDatetimeFormat(
  value: unknown,
  fieldValue: FieldValue | null | undefined,
): string {
  const iso = fieldValue?.type === "datetime" ? fieldValue.value : value;
  if (typeof iso !== "string" || iso === "") return "";
  const canonical = parseDatetimeText(iso);
  if (!canonical) return iso;
  return `${formatIsoDateLong(canonical.slice(0, 10))}, ${canonical.slice(11, 16)} UTC`;
}

// Resolve the column's `editable` flag from the override + current mode.
// Defaults to `true` (every field editable in `edit` mode) when no override
// applies; functions get called with the mode so apps can express tweak-
// mode opt-in editability per field.
function resolveEditable(override: FieldOverride | undefined, mode: EditableGridMode): boolean {
  if (!override || override.editable === undefined) return mode === "tweak" ? false : true;
  if (typeof override.editable === "function") return override.editable(mode);
  if (mode === "tweak") return override.editable === true;
  return override.editable;
}

// Build a single ColDef for one field. Reads `ctx` for the value-bridge
// factories and `override` for per-field tweaks. Returns a ColDef ready to
// drop into AG Grid's `columnDefs`. Bool gets the special-case branch
// (built-in checkbox editor + diff renderer); everything else routes through
// `agGridLeafEditor(...)`.
export function buildSchemaColumnDef(
  ctx: GridColumnContext,
  field: Field,
  override: FieldOverride | undefined,
): ColDef<VisibleRecord> {
  const headerName = override?.headerName ?? field.label;
  const editable = resolveEditable(override, ctx.mode) && isEditableGridField(field, override);
  const formatValue =
    override?.formatValue ??
    (field.type === "money_rate"
      ? (_value: unknown, fieldValue: FieldValue | null | undefined) =>
          defaultMoneyRateFormat(fieldValue)
      : field.type === "date"
        ? defaultDateFormat
        : field.type === "datetime"
          ? defaultDatetimeFormat
          : defaultFormatValue);
  const cellRenderer = ctx.diffCellRenderer({ formatValue });

  // Bool: built-in AG Grid checkbox editor + diff renderer. Mirrors the
  // hand-rolled column today — the checkbox stays the inline edit affordance,
  // but the renderer carries the `Yes / was No` diff cue so dirty state
  // matches every other column's visual treatment.
  if (field.type === "bool") {
    const col: ColDef<VisibleRecord> = {
      colId: field.id,
      headerName,
      editable,
      cellEditor: "agCheckboxCellEditor",
      valueGetter: ctx.fieldGetter(field.id),
      valueSetter: ctx.fieldSetter(field.id, "bool" as FieldValue["type"], {
        validate: override?.validate,
      }),
      cellClassRules: { ...ctx.dirtyCellClassRules, ...ctx.invalidCellClassRules },
      cellRenderer,
    };
    applySizingOverrides(col, override);
    return col;
  }

  // money_rate: editor commits a fully-formed FieldValue, so the column
  // pairs `fieldValueGetter` + `fieldSetterFromValue`. The diff renderer's
  // formatter reads from the FieldValue (the primitive alone can't recover
  // currency + period). Apps may supply richer compact formatting, while the
  // shared fallback always renders the complete stored value.
  if (field.type === "money_rate") {
    const col: ColDef<VisibleRecord> = {
      colId: field.id,
      headerName,
      editable,
      ...agGridLeafEditor("money-rate-editor"),
      cellEditorParams: {
        fieldType: { type: "money_rate", label: headerName, required: field.required },
        editorDefaults: override?.editorDefaults,
      },
      valueGetter: ctx.fieldValueGetter(field.id),
      valueSetter: ctx.fieldSetterFromValue(field.id, { validate: override?.validate }),
      valueFormatter: (p: ValueFormatterParams<VisibleRecord>) =>
        formatValue(undefined, p.data?.values[field.id]),
      cellClassRules: { ...ctx.dirtyCellClassRules, ...ctx.invalidCellClassRules },
      cellRenderer,
    };
    applySizingOverrides(col, override);
    return col;
  }

  // Relation / person: editor takes `relationOptions` via `cellEditorParams`.
  // AG Grid's built-in set filter would render the raw value (a record_id /
  // UUID) in its dropdown without `filterParams.valueFormatter` — thread the
  // same formatter through so the dropdown shows labels.
  if (field.type === "relation") {
    const editor = relationEditorForField(field, override);
    const relationOptions = selectableRelationOptions(
      override?.relationOptions ?? EMPTY_RELATION_OPTIONS,
    );
    // The row's FieldValue lets formatters tell a record key from a
    // lookup-or-create label; the filter list only has the primitive.
    // With no options to pick (e.g. the target's records failed to load), an
    // optional link that holds a value still opens, so its picker can offer
    // Clear. Required links and read mode stay closed.
    const currentValue = ctx.fieldValueGetter(field.id);
    const relationEditable: ColDef<VisibleRecord>["editable"] =
      !editable && !field.required && resolveEditable(override, ctx.mode)
        ? (params) =>
            params.data != null &&
            currentValue({ data: params.data } as ValueGetterParams<VisibleRecord>) != null
        : editable;
    const labelFormatter = (params: { value?: unknown; data?: VisibleRecord }) =>
      formatValue(params.value, params.data?.values[field.id]);
    const col: ColDef<VisibleRecord> = {
      colId: field.id,
      headerName,
      editable: relationEditable,
      ...agGridLeafEditor(editor),
      cellEditorParams: {
        fieldType: {
          type: "relation",
          label: headerName,
          relationOptions,
          ...(override?.searchRelationOptions
            ? {
                searchRelationOptions: override.searchRelationOptions,
                onRelationOptionPicked: override.onRelationOptionPicked,
              }
            : {}),
        },
        clearable: !field.required,
        // The stored value with its key type, so the picker starts on the
        // right option even when the link is stored by external key.
        currentValue: (data: VisibleRecord) =>
          currentValue({ data } as ValueGetterParams<VisibleRecord>),
      },
      valueGetter: ctx.fieldGetter(field.id),
      valueFormatter: labelFormatter,
      filterParams: { valueFormatter: labelFormatter },
      valueSetter: relationValueSetter(
        ctx.fieldSetterFromValue(field.id, { validate: override?.validate }),
        relationOptions,
      ),
      cellClassRules: { ...ctx.dirtyCellClassRules, ...ctx.invalidCellClassRules },
      cellRenderer,
    };
    applySizingOverrides(col, override);
    return col;
  }

  if (field.type === "enum") {
    const options = field.option_set ?? [];
    // Retired options keep their labels for stored values but are not valid
    // new values, so a paste cannot stage one the write path rejects.
    const activeOptions = options.filter((option) => option.lifecycle !== "retired");
    const optionIds = new Set(activeOptions.map((option) => option.id));
    const enumLabel = (value: unknown, fieldValue: FieldValue | null | undefined) => {
      const optionId =
        fieldValue?.type === "enum" ? fieldValue.value : typeof value === "string" ? value : null;
      if (optionId == null) return "";
      return options.find((option) => option.id === optionId)?.label ?? optionId;
    };
    const enumFormatter = override?.formatValue ?? enumLabel;
    const enumCellRenderer = ctx.diffCellRenderer({ formatValue: enumFormatter });
    const col: ColDef<VisibleRecord> = {
      colId: field.id,
      headerName,
      editable,
      ...agGridLeafEditor("value-select"),
      cellEditorParams: {
        fieldType: {
          type: "enum",
          label: headerName,
          valueOptions: activeOptions.map((option) => ({ value: option.id, label: option.label })),
        },
        clearable: !field.required,
      },
      valueGetter: ctx.fieldGetter(field.id),
      valueFormatter: (p: ValueFormatterParams<VisibleRecord>) =>
        enumFormatter(p.value, p.data?.values[field.id]),
      valueSetter: ctx.fieldSetter(field.id, "enum" as FieldValue["type"], {
        validate: enumOptionValidator(field, optionIds, override?.validate),
      }),
      cellClassRules: { ...ctx.dirtyCellClassRules, ...ctx.invalidCellClassRules },
      cellRenderer: enumCellRenderer,
    };
    applySizingOverrides(col, override);
    return col;
  }

  // datetime / text_list: the editors commit full FieldValues (or null to
  // clear) and read the row's live value through `currentValue`; the cell
  // keeps the primitive (ISO string / comma-joined items) for display, sort,
  // filter and copy. Pasted text is parsed into the same FieldValue.
  if (field.type === "datetime" || field.type === "text_list") {
    const currentValue = ctx.fieldValueGetter(field.id);
    const isDatetime = field.type === "datetime";
    const col: ColDef<VisibleRecord> = {
      colId: field.id,
      headerName,
      editable,
      ...agGridLeafEditor(isDatetime ? "datetime-editor" : "text-list-editor"),
      cellEditorParams: {
        fieldType: { type: field.type, label: headerName, required: field.required },
        clearable: !field.required,
        currentValue: (data: VisibleRecord) =>
          currentValue({ data } as ValueGetterParams<VisibleRecord>),
      },
      valueGetter: ctx.fieldGetter(field.id),
      valueSetter: pastedTextValueSetter(
        ctx.fieldSetterFromValue(field.id, {
          validate: isDatetime ? datetimeValidator(override?.validate) : override?.validate,
        }),
        isDatetime ? pastedDatetime : pastedTextList,
      ),
      cellClassRules: { ...ctx.dirtyCellClassRules, ...ctx.invalidCellClassRules },
      cellRenderer,
    };
    applySizingOverrides(col, override);
    return col;
  }

  if (field.type === "text" && override?.valueOptions !== undefined) {
    // Explicit text vocabularies, including empty ones, use the select leaf so
    // constrained fields cannot silently fall back to freeform editing.
    const col: ColDef<VisibleRecord> = {
      colId: field.id,
      headerName,
      editable,
      ...agGridLeafEditor("value-select"),
      cellEditorParams: {
        fieldType: { type: "text", label: headerName, valueOptions: [...override.valueOptions] },
      },
      valueGetter: ctx.fieldGetter(field.id),
      valueSetter: ctx.fieldSetter(field.id, "text" as FieldValue["type"], {
        validate: override?.validate,
      }),
      cellClassRules: { ...ctx.dirtyCellClassRules, ...ctx.invalidCellClassRules },
      cellRenderer,
    };
    applySizingOverrides(col, override);
    return col;
  }

  const editor = editorForFieldType(field);
  const fieldType = field.type;
  if (!editor || !isEditableSchemaFieldType(fieldType)) {
    // Loud-but-safe: warn at column-build time, but render display-only.
    // This avoids coercing structured types like text_list/json through a
    // primitive string editor.
    // eslint-disable-next-line no-console
    console.warn(
      `[editable-grid] no leaf editor mapped for field type "${field.type}" (field "${field.id}"); rendering non-editable column`,
    );
    const col: ColDef<VisibleRecord> = {
      colId: field.id,
      headerName,
      editable: false,
      valueGetter: ctx.fieldGetter(field.id),
      cellClassRules: { ...ctx.dirtyCellClassRules, ...ctx.invalidCellClassRules },
      cellRenderer,
    };
    applySizingOverrides(col, override);
    return col;
  }

  const col: ColDef<VisibleRecord> = {
    colId: field.id,
    headerName,
    editable,
    ...agGridLeafEditor(editor),
    cellEditorParams: {
      fieldType: { type: fieldType, label: headerName, required: field.required },
    },
    valueGetter: ctx.fieldGetter(field.id),
    valueSetter: ctx.fieldSetter(field.id, fieldSetterValueType(fieldType), {
      validate: override?.validate,
    }),
    cellClassRules: { ...ctx.dirtyCellClassRules, ...ctx.invalidCellClassRules },
    cellRenderer,
  };
  applySizingOverrides(col, override);
  return col;
}

// Stable empty array reference for relation columns with no options. Reusing
// the same identity keeps `cellEditorParams` referentially stable across
// renders when no options are supplied.
const EMPTY_RELATION_OPTIONS: ReadonlyArray<RelationOption> = [];

function applySizingOverrides(
  col: ColDef<VisibleRecord>,
  override: FieldOverride | undefined,
): void {
  if (!override) return;
  if (override.width !== undefined) col.width = override.width;
  if (override.flex !== undefined) col.flex = override.flex;
  if (override.minWidth !== undefined) col.minWidth = override.minWidth;
}

// Build the full columnDefs array for a model, honoring `fieldOrder`
// (defaults to schema order) and `hidden`. Returns `[]` when the model is
// not found in the schema — apps that mount during schema load see an empty
// grid until the schema arrives.
export function buildSchemaColumnDefs(
  ctx: GridColumnContext,
  schema: Schema | null | undefined,
  modelId: string,
  options: BuildSchemaColumnsOptions = {},
): ColDef<VisibleRecord>[] {
  if (!schema) return [];
  const model = findModel(schema, modelId);
  if (!model) return [];

  const hidden = new Set(options.hidden ?? []);
  const fieldsById = new Map<string, Field>();
  for (const f of model.fields) fieldsById.set(f.id, f);

  // Field ordering: explicit `fieldOrder` first (filtered to ids the schema
  // actually carries), then schema-order tail for any field not in the
  // explicit list (so apps don't have to enumerate every id just to reorder
  // a few). Hidden ids drop out at the end.
  const ordered: Field[] = [];
  const seen = new Set<string>();
  if (options.fieldOrder) {
    for (const id of options.fieldOrder) {
      const f = fieldsById.get(id);
      if (f && !seen.has(id)) {
        ordered.push(f);
        seen.add(id);
      }
    }
  }
  for (const f of model.fields) {
    if (!seen.has(f.id)) {
      ordered.push(f);
      seen.add(f.id);
    }
  }

  const overrides = options.fieldOverrides ?? {};
  const out: ColDef<VisibleRecord>[] = [];
  for (const f of ordered) {
    if (hidden.has(f.id)) continue;
    const override = withRelationTargetDefaults(
      f,
      overrides[f.id] as FieldOverride | undefined,
      options,
    );
    out.push(buildSchemaColumnDef(ctx, f, override));
  }
  return out;
}

// Editors commit a FieldValue (or null); a paste, fill or Delete arrives as
// text or null. Empty text is a clear; other text is parsed into the column's
// FieldValue and staged (and validated) like an editor commit.
function pastedTextValueSetter(
  setFieldValue: (params: ValueSetterParams<VisibleRecord>) => boolean,
  parse: (text: string) => FieldValue | null,
): (params: ValueSetterParams<VisibleRecord>) => boolean {
  return (params) => {
    if (typeof params.newValue !== "string") return setFieldValue(params);
    return setFieldValue({ ...params, newValue: parse(params.newValue) });
  };
}

// Unparseable text stays as typed so the datetime validator flags the cell.
function pastedDatetime(text: string): FieldValue | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  return { type: "datetime", value: parseDatetimeText(trimmed) ?? trimmed };
}

function pastedTextList(text: string): FieldValue | null {
  const items = splitTextListText(text);
  return items.length === 0 ? null : { type: "text_list", value: items };
}

const DATETIME_INVALID_MESSAGE = "Enter a date and time, like 2026-05-04 14:30 (UTC)";

// Accepts exactly what the kernel stores: RFC 3339 with seconds and a `Z` or
// `±HH:MM` offset, naming a real instant.
function datetimeValidator(overrideValidate: FieldValidator | undefined): FieldValidator {
  return (next, context) => {
    if (next != null && (next.type !== "datetime" || !isKernelDatetime(next.value))) {
      return invalid(DATETIME_INVALID_MESSAGE);
    }
    return overrideValidate ? overrideValidate(next, context) : VALID;
  };
}

function isKernelDatetime(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    parseDatetimeText(value) !== null
  );
}

// Pickers commit the full relation FieldValue (key type included). A pasted
// primitive is a key value: resolve it to the option it names and stage that
// option's own key, or treat an empty paste as a clear. Anything else, or a
// value naming different options as record id and external key, is rejected
// rather than guessed.
function relationValueSetter(
  setFieldValue: (params: ValueSetterParams<VisibleRecord>) => boolean,
  options: ReadonlyArray<RelationOption>,
): (params: ValueSetterParams<VisibleRecord>) => boolean {
  return (params) => {
    if (typeof params.newValue !== "string") return setFieldValue(params);
    const pasted = params.newValue.trim();
    if (pasted === "") return setFieldValue({ ...params, newValue: null });
    const { byRecordId, byExternalKey } = relationOptionsForPrimitive(
      relationOptionsByKey(options),
      pasted,
    );
    // A value naming one record by id and another by external key is ambiguous.
    if (byRecordId && byExternalKey && byRecordId !== byExternalKey) return false;
    const option = byRecordId ?? byExternalKey;
    if (!option) return false;
    return setFieldValue({ ...params, newValue: { type: "relation", value: option.key } });
  };
}
