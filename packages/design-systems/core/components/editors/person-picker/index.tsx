import {
  isValidElement,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { FieldValue, RecordKey } from "@contracts";

import { SearchableListbox, type SearchableListboxOption } from "../../searchable-listbox";
import { serializeRecordKey } from "../record-key";
import type { EditorContext, EditorProps, FieldEditor } from "../protocol";

export type PersonPickerValue = RecordKey | null;
export type PersonPickerCommitValue = RecordKey;
type PersonPickerProps = EditorProps<PersonPickerValue, PersonPickerCommitValue> & {
  initialQuery?: string;
};
type RelationOption = NonNullable<EditorContext["fieldType"]["relationOptions"]>[number];
const EMPTY_OPTIONS: readonly RelationOption[] = [];

function textFromNode(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map((child) => textFromNode(child)).join("");
  if (isValidElement(node)) return textFromNode((node.props as { children?: ReactNode }).children);
  return "";
}

function displayText(option: RelationOption) {
  return textFromNode(option.label) || option.searchText || "";
}

function PersonPickerComponent(props: PersonPickerProps) {
  const { initialValue, context, initialQuery } = props;
  const options = context.fieldType.relationOptions ?? EMPTY_OPTIONS;
  const currentKey = serializeRecordKey(initialValue);
  const initialOption = options.find((option) => serializeRecordKey(option.key) === currentKey);
  const [query, setQuery] = useState(initialQuery ?? "");
  const [selected, setSelected] = useState<PersonPickerValue>(initialOption?.key ?? initialValue);
  const [error, setError] = useState<string | null>(null);
  const finishedRef = useRef(false);
  const activeValueRef = useRef<RecordKey | null>(null);
  const fieldLabel = context.fieldType.label ?? "Relation";
  const fieldLabelLower = fieldLabel.toLowerCase();
  const currentUnavailable =
    currentKey.length > 0 &&
    !options.some((option) => !option.disabled && serializeRecordKey(option.key) === currentKey);
  const listboxOptions = useMemo<readonly SearchableListboxOption<RecordKey>[]>(
    () =>
      options.map((option) => ({
        value: option.key,
        label: option.label,
        searchText: [option.searchText, textFromNode(option.label), textFromNode(option.detail)]
          .filter(Boolean)
          .join(" "),
        disabled: option.disabled,
      })),
    [options],
  );

  function commit(next: RecordKey | null, emptyNoopAction: "cancel" | "none" = "cancel") {
    if (finishedRef.current) return false;
    if (!next) {
      if (
        (currentKey.length === 0 && query.trim().length === 0) ||
        (currentKey.length > 0 && query.trim().length === 0)
      ) {
        finishedRef.current = true;
        if (emptyNoopAction === "cancel") props.onCancel();
        return true;
      }
      setError("Select an option.");
      return false;
    }
    if (serializeRecordKey(next) === currentKey) {
      finishedRef.current = true;
      if (emptyNoopAction === "cancel") props.onCancel();
      return true;
    }
    finishedRef.current = true;
    props.onCommit(next);
    return true;
  }

  function cancel() {
    if (finishedRef.current) return;
    finishedRef.current = true;
    props.onCancel();
  }

  function pendingValue() {
    const activeKey = serializeRecordKey(activeValueRef.current);
    const activeIsAvailable = options.some(
      (option) => !option.disabled && serializeRecordKey(option.key) === activeKey,
    );
    if (activeIsAvailable) return activeValueRef.current;
    const needle = query.trim().toLocaleLowerCase();
    const queryMatch = needle
      ? options.find(
          (option) =>
            !option.disabled &&
            [option.searchText, textFromNode(option.label), textFromNode(option.detail)]
              .filter(Boolean)
              .join(" ")
              .toLocaleLowerCase()
              .includes(needle),
        )?.key
      : null;
    return queryMatch ?? (currentUnavailable ? null : selected);
  }

  function handleLifecycleKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    } else if (event.key === "Tab" && props.onNavigate) {
      event.preventDefault();
      event.stopPropagation();
      if (commit(pendingValue(), "none")) props.onNavigate(event.shiftKey ? "previous" : "next");
    }
  }

  return (
    <div onKeyDown={handleLifecycleKey}>
      <SearchableListbox
        options={listboxOptions}
        value={selected}
        query={query}
        onQueryChange={(next) => {
          setQuery(next);
          setSelected(next === "" ? initialValue : null);
          if (error) setError(null);
        }}
        onValueChange={(next) => {
          const option = options.find(
            (candidate) => serializeRecordKey(candidate.key) === serializeRecordKey(next),
          );
          setSelected(next);
          if (option) setQuery(displayText(option));
          void commit(next);
        }}
        onActiveValueChange={(next) => {
          activeValueRef.current = next;
        }}
        onEmptyActivation={() => void commit(null)}
        getOptionKey={serializeRecordKey}
        ariaLabel={fieldLabel}
        placeholder={`Search ${fieldLabelLower}`}
        autoFocus
        error={error}
        renderOption={(option) => {
          const source = options.find(
            (candidate) => serializeRecordKey(candidate.key) === serializeRecordKey(option.value),
          );
          return (
            <>
              <span className="block font-[var(--font-weight-semibold)] text-[var(--color-text-primary)]">
                {option.label}
              </span>
              {source?.detail ? (
                <span className="block text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
                  {source.detail}
                </span>
              ) : null}
            </>
          );
        }}
      />
      {currentUnavailable && !error ? (
        <p className="m-[var(--space-0)] text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
          Current {fieldLabelLower} unavailable: {currentKey}. Cancel or choose another{" "}
          {fieldLabelLower}.
        </p>
      ) : null}
    </div>
  );
}

export const PersonPicker: FieldEditor<
  PersonPickerValue,
  Extract<FieldValue, { type: "relation" }>,
  PersonPickerCommitValue
> = {
  Component: PersonPickerComponent,
  mode: "popover",
  parse: (fieldValue) => fieldValue?.value ?? null,
  serialize: (uiValue, _ctx: EditorContext) => ({ type: "relation", value: uiValue }),
};
