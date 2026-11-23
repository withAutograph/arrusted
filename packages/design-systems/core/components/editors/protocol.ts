import type { ComponentType, ReactNode } from "react";
import type { FieldId, FieldValue, ModelId, RecordKey } from "@contracts";

export type LocalDateIso = `${number}-${number}-${number}`;

export type ValueSelectOption =
  | string
  | {
      value: string;
      label: string;
    };

export type RelationOptionItem = {
  key: RecordKey;
  label: ReactNode;
  detail?: ReactNode;
  searchText?: string;
  disabled?: boolean;
};

/** The best matches for a query; `truncated` when more records match than these. */
export type RelationOptionResults = {
  options: RelationOptionItem[];
  truncated: boolean;
};

/**
 * Searches the records a link may choose; `signal` aborts a search the
 * picker no longer needs.
 */
export type RelationOptionSearch = (
  query: string,
  signal: AbortSignal,
) => Promise<RelationOptionResults>;

export type FieldTypeMeta = {
  type: string;
  label?: string;
  required?: boolean;
  targetModel?: ModelId | null;
  currencyOptions?: string[];
  periodOptions?: string[];
  /** Allowed values for fields rendered as a single-select dropdown. */
  valueOptions?: ValueSelectOption[];
  relationOptions?: RelationOptionItem[];
  /** When set, the relation picker searches with it as the user types instead of filtering `relationOptions`. */
  searchRelationOptions?: RelationOptionSearch;
  /** Called with a searched option the user picks, so its label can be shown once picked. */
  onRelationOptionPicked?: (option: RelationOptionItem) => void;
};

export type EditorContext = {
  rowKey: RecordKey;
  fieldId: FieldId;
  fieldType: FieldTypeMeta;
  asOf?: LocalDateIso;
};

export type EditorProps<TValue, TCommitValue = TValue> = {
  initialValue: TValue;
  context: EditorContext;
  onCommit(next: TCommitValue): void;
  onCancel(): void;
  onNavigate?: (direction: "next" | "previous") => void;
  /** Reports every draft change, so a host that closes the editor itself (e.g. a grid on Tab) can keep it. */
  onDraftChange?: (draft: TCommitValue | null) => void;
  /** When set, the editor offers a Clear action that calls it. */
  onClear?: () => void;
};

export type FieldEditor<
  TEditValue,
  TFieldValue extends FieldValue = FieldValue,
  TCommitValue = TEditValue,
> = {
  Component: ComponentType<EditorProps<TEditValue, TCommitValue>>;
  mode: "inline" | "popover";
  parse(fieldValue: TFieldValue | undefined, ctx: EditorContext): TEditValue;
  serialize(uiValue: TCommitValue, ctx: EditorContext): TFieldValue;
};
