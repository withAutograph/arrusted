// Shared helpers for AG Grid cell-editor adapters.
//
// Bridges AG Grid's `ICellEditorParams` to the storybook-leaf
// `EditorContext` shape. The leaves model rowKey as `RecordKey` and carry a
// `FieldTypeMeta` (label, relation options, currency options, etc.). AG Grid
// gives us the `record_id` on `params.data`; the leaf-config metadata comes
// from `cellEditorParams` per column.
//
// We type the helpers against `unknown` TData (instead of `VisibleRecord`)
// because AG Grid's `CustomCellEditorProps<TData=any, ...>` widens TData
// when the adapter is referenced from the cellEditor registry. The runtime
// shape is the same; we narrow to `VisibleRecord` defensively when reading
// `params.data.record_id`.

import type { FieldValue, RecordKey, VisibleRecord } from "@contracts";
import type { FieldTypeMeta, LocalDateIso } from "@autograph/components";
import { serializeRecordKey } from "@engines/field-value-adapter/index";

// Minimal slice of the AG Grid params surface our helpers consume. Avoids
// pulling in the full `ICellEditorParams<TData, TValue>` generic chain
// which fights with `CustomCellEditorProps<unknown, TValue>` at the
// adapter boundary.
export type EditorParamsSlice = {
  data?: unknown;
  column: { getColId(): string };
  colDef: { headerName?: string | null | (() => string) };
  fieldType?: FieldTypeMeta;
  asOf?: LocalDateIso;
};

export type LeafCellEditorParams = {
  fieldType?: FieldTypeMeta;
  asOf?: LocalDateIso;
};

export function rowKeyFromParams(params: EditorParamsSlice): RecordKey {
  const data = params.data as VisibleRecord | undefined;
  const recordId = data?.record_id;
  return { type: "record_id", value: recordId ?? "" };
}

export function fieldTypeMetaFromParams(
  params: EditorParamsSlice,
  defaultType: FieldTypeMeta["type"],
): FieldTypeMeta {
  if (params.fieldType) return params.fieldType;
  const headerName =
    typeof params.colDef.headerName === "string" ? params.colDef.headerName : undefined;
  return {
    type: defaultType,
    label: headerName ?? params.column.getColId(),
  };
}

// Columns whose value may be removed pass `clearable: true` in
// `cellEditorParams`; picker adapters then offer a "Clear" action that
// commits `null`, which the column's setter stages as a clear.
export type ClearableEditorParams = {
  clearable?: boolean;
};

// Columns whose primitive cell value loses shape (a relation's key type, a
// list's items) pass a getter for the row's live FieldValue.
export type CurrentValueEditorParams = {
  currentValue?: (data: VisibleRecord) => FieldValue | null;
};

// Relation columns pass a getter for the stored value (key type included).
export type RelationEditorParams = CurrentValueEditorParams;

// The row's live FieldValue for an adapter, when the column supplies it.
export function currentFieldValue(
  props: { data?: unknown } & CurrentValueEditorParams,
): FieldValue | null {
  return props.currentValue && props.data ? props.currentValue(props.data as VisibleRecord) : null;
}

type KeyedOption = { key: RecordKey; aliasKeys?: ReadonlyArray<RecordKey> };

// The key a relation picker starts on: the stored key, mapped to the option
// that names it (an external-key link selects the record's own option), or
// the stored key itself when no option names it.
export function initialRelationKey(
  props: { value?: unknown; data?: unknown } & RelationEditorParams,
  options: ReadonlyArray<KeyedOption> | undefined,
): RecordKey | null {
  const stored =
    props.currentValue && props.data ? props.currentValue(props.data as VisibleRecord) : null;
  const key: RecordKey | null =
    stored?.type === "relation" && stored.value.type !== "lookup_or_create"
      ? stored.value
      : typeof props.value === "string" && props.value.length > 0
        ? { type: "record_id", value: props.value }
        : null;
  if (!key) return null;
  const id = serializeRecordKey(key);
  const option = options?.find(
    (candidate) =>
      serializeRecordKey(candidate.key) === id ||
      (candidate.aliasKeys ?? []).some((alias) => serializeRecordKey(alias) === id),
  );
  return option ? option.key : key;
}
