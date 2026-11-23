import {
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { FieldValue, RecordKey } from "@contracts";

import { SearchableListbox, type SearchableListboxOption } from "../../searchable-listbox";
import { serializeRecordKey } from "../record-key";
import type {
  EditorContext,
  EditorProps,
  FieldEditor,
  RelationOptionItem,
  RelationOptionSearch,
} from "../protocol";

export type RelationPickerValue = RecordKey | null;
export type RelationPickerCommitValue = RecordKey;
type RelationPickerProps = EditorProps<RelationPickerValue, RelationPickerCommitValue> & {
  initialQuery?: string;
};
type RelationOption = RelationOptionItem;
const EMPTY_OPTIONS: readonly RelationOption[] = [];
// Wait for a pause in typing before searching; an empty query searches at once.
export const RELATION_SEARCH_DEBOUNCE_MS = 200;

type SearchState = {
  // The trimmed query these options answer.
  query: string;
  options: readonly RelationOption[];
  truncated: boolean;
  failed: boolean;
};

// The best matches from `search` for the current query, after a pause in
// typing. Results for a query the user has since changed are never shown, and
// its search is aborted.
export function useRelationOptionSearch(search: RelationOptionSearch | undefined, query: string) {
  const [state, setState] = useState<SearchState | null>(null);
  const trimmed = query.trim();

  useEffect(() => {
    if (!search) return;
    const controller = new AbortController();
    const timer = window.setTimeout(
      () => {
        search(trimmed, controller.signal).then(
          (results) => {
            if (controller.signal.aborted) return;
            setState({
              query: trimmed,
              options: results.options,
              truncated: results.truncated,
              failed: false,
            });
          },
          () => {
            if (controller.signal.aborted) return;
            setState({ query: trimmed, options: EMPTY_OPTIONS, truncated: false, failed: true });
          },
        );
      },
      trimmed ? RELATION_SEARCH_DEBOUNCE_MS : 0,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [search, trimmed]);

  const current = state?.query === trimmed ? state : null;
  return {
    options: current?.options ?? EMPTY_OPTIONS,
    // Searching for this query, and nothing to show for it yet.
    loading: !current,
    failed: current?.failed ?? false,
    truncated: current?.truncated ?? false,
  };
}

function textFromNode(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map((child) => textFromNode(child)).join("");
  if (isValidElement(node)) return textFromNode((node.props as { children?: ReactNode }).children);
  return "";
}

function displayText(option: RelationOption) {
  return textFromNode(option.label) || option.searchText || "";
}

function RelationPickerComponent(props: RelationPickerProps) {
  const { initialValue, context, initialQuery } = props;
  const search = context.fieldType.searchRelationOptions;
  const [query, setQuery] = useState(initialQuery ?? "");
  const searched = useRelationOptionSearch(search, query);
  const options = search ? searched.options : (context.fieldType.relationOptions ?? EMPTY_OPTIONS);
  const currentKey = serializeRecordKey(initialValue);
  const initialOption = options.find((option) => serializeRecordKey(option.key) === currentKey);
  const [selected, setSelected] = useState<RelationPickerValue>(initialOption?.key ?? initialValue);
  const [error, setError] = useState<string | null>(null);
  const finishedRef = useRef(false);
  const activeValueRef = useRef<RecordKey | null>(null);
  const fieldLabel = context.fieldType.label ?? "Relation";
  // A searched page need not hold the current value, so only a full option
  // list can show that it is unavailable.
  const currentUnavailable =
    !search &&
    currentKey.length > 0 &&
    !options.some((option) => !option.disabled && serializeRecordKey(option.key) === currentKey);
  const listboxOptions = useMemo<readonly SearchableListboxOption<RecordKey>[]>(
    () =>
      options.map((option) => ({
        value: option.key,
        label: option.label,
        searchText: [option.searchText, textFromNode(option.label)].filter(Boolean).join(" "),
        disabled: option.disabled,
      })),
    [options],
  );

  function commit(next: RecordKey | null, emptyNoopAction: "cancel" | "none" = "cancel") {
    if (finishedRef.current) return false;
    if (!next) {
      if (query.trim().length === 0) {
        finishedRef.current = true;
        if (emptyNoopAction === "cancel") props.onCancel();
        return true;
      }
      setError("Select a related record.");
      return false;
    }
    if (serializeRecordKey(next) === currentKey) {
      finishedRef.current = true;
      if (emptyNoopAction === "cancel") props.onCancel();
      return true;
    }
    finishedRef.current = true;
    if (search) {
      const picked = options.find(
        (option) => serializeRecordKey(option.key) === serializeRecordKey(next),
      );
      if (picked) context.fieldType.onRelationOptionPicked?.(picked);
    }
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
    // The option the list highlights: searched options already match the
    // query (best first), listed options are filtered by it.
    const queryMatch = needle
      ? options.find(
          (option) =>
            !option.disabled &&
            (search ||
              [option.searchText, textFromNode(option.label)]
                .filter(Boolean)
                .join(" ")
                .toLocaleLowerCase()
                .includes(needle)),
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
        placeholder={`Search ${fieldLabel.toLowerCase()}`}
        autoFocus
        error={error}
        {...(search ? searchedListboxProps(searched, query) : {})}
        renderOption={(option) => (
          <span className="block text-[var(--color-text-primary)]">{option.label}</span>
        )}
      />
      {currentUnavailable && !error ? (
        <p className="m-[var(--space-0)] text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
          Current value unavailable. Cancel or leave unchanged.
        </p>
      ) : null}
    </div>
  );
}

export const RelationPicker: FieldEditor<
  RelationPickerValue,
  Extract<FieldValue, { type: "relation" }>,
  RelationPickerCommitValue
> = {
  Component: RelationPickerComponent,
  mode: "popover",
  parse: (fieldValue) => fieldValue?.value ?? null,
  serialize: (uiValue, _ctx: EditorContext) => ({ type: "relation", value: uiValue }),
};

// Listbox props that show searched options as given.
function searchedListboxProps(searched: ReturnType<typeof useRelationOptionSearch>, query: string) {
  return {
    filterOptions: false,
    loading: searched.loading,
    maxResults: searched.options.length,
    emptyMessage: searched.failed
      ? "Could not load options"
      : query.trim()
        ? "No matches"
        : "Nothing to choose yet",
    footer: searched.truncated ? "Keep typing to narrow" : undefined,
  };
}

export type RelationSearchSelectProps = {
  ariaLabel: string;
  placeholder: string;
  search: RelationOptionSearch;
  value: RecordKey | null;
  /** The picked option, or null once the user edits or clears the text. */
  onValueChange: (option: RelationOptionItem | null) => void;
  invalid?: boolean;
};

/**
 * A form field choosing one related record by searching as the user types.
 * The chosen record's label stays in the field; editing the text clears the
 * choice, so the field never holds a value it does not show.
 */
export function RelationSearchSelect(props: RelationSearchSelectProps) {
  const [query, setQuery] = useState("");
  const searched = useRelationOptionSearch(props.search, query);
  const options = useMemo<readonly SearchableListboxOption<RecordKey>[]>(
    () =>
      searched.options.map((option) => ({
        value: option.key,
        label: option.label,
        searchText: displayText(option),
        disabled: option.disabled,
      })),
    [searched.options],
  );
  return (
    <SearchableListbox
      options={options}
      value={props.value}
      query={query}
      onQueryChange={(next) => {
        setQuery(next);
        if (props.value) props.onValueChange(null);
      }}
      onValueChange={(next) => {
        const option = searched.options.find(
          (candidate) => serializeRecordKey(candidate.key) === serializeRecordKey(next),
        );
        if (!option) return;
        setQuery(displayText(option));
        props.onValueChange(option);
      }}
      getOptionKey={serializeRecordKey}
      ariaLabel={props.ariaLabel}
      placeholder={props.placeholder}
      invalid={props.invalid}
      {...searchedListboxProps(searched, query)}
    />
  );
}
