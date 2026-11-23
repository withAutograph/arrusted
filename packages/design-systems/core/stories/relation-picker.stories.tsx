/*
 * RelationPicker — atom story.
 *
 * Renders the search+list inline (no outer popover wrapper) inside a panel
 * surface that mimics what the consumer's popover (cell-editor popup, sheet
 * popover) provides. The atom carries no border / shadow — those come from
 * the consumer.
 */
import { useState, type ComponentType } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { RecordKey } from "@contracts";

import {
  Badge,
  Button,
  Card,
  RelationPicker,
  type EditorContext,
  type EditorProps,
  type RelationOptionSearch,
} from "../components";
import type { RelationPickerValue } from "../components/editors/relation-picker";

const alphaKey: RecordKey = { type: "external_key", value: "record-alpha" };
const betaKey: RecordKey = { type: "external_key", value: "record-beta" };
const disabledKey: RecordKey = { type: "external_key", value: "record-disabled" };
const missingKey: RecordKey = { type: "external_key", value: "record-missing" };
const recordIdKey: RecordKey = { type: "record_id", value: "018f4ea6-6ab8-7b83-93f5-f9278d6b4221" };

const relationOptions = [
  { key: alphaKey, label: "Alpha record" },
  { key: betaKey, label: "Beta record" },
  { key: disabledKey, label: "Disabled record", disabled: true },
  { key: recordIdKey, label: "Record id option" },
];

function editorContext(options = relationOptions, search?: RelationOptionSearch): EditorContext {
  return {
    rowKey: { type: "external_key", value: "item-alpha" },
    fieldId: "related_record",
    fieldType: search
      ? { type: "relation", label: "Linked record", searchRelationOptions: search }
      : { type: "relation", label: "Related record", relationOptions: options },
    asOf: "2026-09-01",
  };
}

// A server-side search over a model too large to load: case-insensitive
// substring match on the label, the best 50 and whether more match, a short
// network delay. Labels come as the consumer makes them: two records named
// Cedar Atlas are told apart, one by external key and one (with none) by
// start date.
const FIRST_WORDS = [
  "Amber",
  "Birch",
  "Cedar",
  "Delta",
  "Ember",
  "Fjord",
  "Garnet",
  "Harbor",
  "Indigo",
  "Juniper",
];
const SECOND_WORDS = ["Atlas", "Beacon", "Comet", "Drift", "Echo", "Flint", "Grove", "Haven"];
const SEARCHABLE_RECORDS = FIRST_WORDS.flatMap((first, firstIndex) =>
  SECOND_WORDS.map((second, secondIndex) => {
    const index = firstIndex * SECOND_WORDS.length + secondIndex;
    const label = `${first} ${second}`;
    return {
      id: `record-${index}`,
      label: label === "Cedar Atlas" ? "Cedar Atlas (since 2024-03-04)" : label,
    };
  }),
)
  .concat([
    { id: "record-dup-1", label: "Cedar Atlas (R-2041)" },
    { id: "record-unnamed", label: "Unnamed record" },
  ])
  .sort((left, right) => left.label.localeCompare(right.label));
const SEARCH_LIMIT = 50;

const searchRecords: RelationOptionSearch = (query, signal) =>
  new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      const needle = query.toLocaleLowerCase();
      const matches = SEARCHABLE_RECORDS.filter((record) =>
        record.label.toLocaleLowerCase().includes(needle),
      );
      resolve({
        options: matches.slice(0, SEARCH_LIMIT).map((record) => ({
          key: { type: "record_id", value: record.id },
          label: record.label,
        })),
        truncated: matches.length > SEARCH_LIMIT,
      });
    }, 150);
    signal.addEventListener("abort", () => {
      window.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });

const meta = {
  title: "Design System/Editors/RelationPicker",
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <div className="min-h-screen bg-[var(--color-bg-page)] p-[var(--space-6)] text-[var(--color-text-primary)]">
        <div className="mx-auto max-w-[760px]">
          <Story />
        </div>
      </div>
    ),
  ],
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <RelationPickerHarness initialValue={null} />,
};

export const WithSelection: Story = {
  render: () => <RelationPickerHarness initialValue={betaKey} />,
};

export const RecordIdRoundTrip: Story = {
  render: () => (
    <RelationPickerHarness
      initialValue={recordIdKey}
      helper="RecordKey objects round-trip without flattening to external keys."
    />
  ),
};

export const EmptyOptions: Story = {
  render: () => (
    <RelationPickerHarness
      initialValue={null}
      options={[]}
      helper="No app lookup is embedded here; the consumer supplies relation options."
    />
  ),
};

export const DisabledCurrentValue: Story = {
  render: () => (
    <RelationPickerHarness
      initialValue={disabledKey}
      helper="A disabled current value exits as an unchanged no-op; disabled only blocks new selection."
    />
  ),
};

export const MissingCurrentValue: Story = {
  render: () => (
    <RelationPickerHarness
      initialValue={missingKey}
      helper="A current relation outside the lookup result is shown as unavailable and can exit unchanged."
    />
  ),
};

export const SearchEmptyQuery: Story = {
  render: () => (
    <RelationPickerHarness
      initialValue={null}
      search={searchRecords}
      helper="Searches the server as you type; an empty query shows the best 50 and asks to keep typing."
    />
  ),
};

export const SearchTyping: Story = {
  render: () => (
    <RelationPickerHarness
      initialValue={null}
      search={searchRecords}
      initialQuery="atlas"
      helper="Results for the typed query only, after a short pause in typing."
    />
  ),
};

export const SearchNoResults: Story = {
  render: () => (
    <RelationPickerHarness initialValue={null} search={searchRecords} initialQuery="zzz" />
  ),
};

export const EnterCommitsHighlight: Story = {
  render: () => (
    <RelationPickerHarness
      initialValue={null}
      initialReceipt={{ kind: "commit", value: alphaKey }}
    />
  ),
};

export const EscapeCancel: Story = {
  render: () => (
    <RelationPickerHarness initialValue={alphaKey} initialReceipt={{ kind: "cancel" }} />
  ),
};

export const TabNavigation: Story = {
  render: () => (
    <RelationPickerHarness
      initialValue={null}
      initialReceipt={{ kind: "navigate", direction: "next", value: alphaKey }}
    />
  ),
};

type InitialReceipt =
  | { kind: "commit"; value: RecordKey }
  | { kind: "cancel" }
  | { kind: "navigate"; direction: "next" | "previous"; value?: RecordKey };

function RelationPickerHarness(props: {
  initialValue: RelationPickerValue;
  helper?: string;
  initialReceipt?: InitialReceipt;
  options?: typeof relationOptions;
  search?: RelationOptionSearch;
  initialQuery?: string;
}) {
  const options = props.options ?? relationOptions;
  const [lastCommit, setLastCommit] = useState<RecordKey | null>(
    props.initialReceipt?.kind === "commit" || props.initialReceipt?.kind === "navigate"
      ? (props.initialReceipt.value ?? null)
      : null,
  );
  const [cancelCount, setCancelCount] = useState(props.initialReceipt?.kind === "cancel" ? 1 : 0);
  const [navigation, setNavigation] = useState<"next" | "previous" | null>(
    props.initialReceipt?.kind === "navigate" ? props.initialReceipt.direction : null,
  );
  const [resetKey, setResetKey] = useState(0);
  const [active, setActive] = useState(!props.initialReceipt);
  const Component = RelationPicker.Component as ComponentType<
    EditorProps<RelationPickerValue, RecordKey> & { initialQuery?: string }
  >;

  function resetEditor() {
    setLastCommit(
      props.initialReceipt?.kind === "commit" || props.initialReceipt?.kind === "navigate"
        ? (props.initialReceipt.value ?? null)
        : null,
    );
    setCancelCount(props.initialReceipt?.kind === "cancel" ? 1 : 0);
    setNavigation(
      props.initialReceipt?.kind === "navigate" ? props.initialReceipt.direction : null,
    );
    setActive(true);
    setResetKey((current) => current + 1);
  }

  return (
    <Card
      title="Relation Picker"
      actions={
        <Button size="sm" intent="secondary" onClick={resetEditor}>
          Reset Editor
        </Button>
      }
    >
      <div className="grid gap-[var(--space-4)]">
        {/* The wrapping div mimics the popover surface a real consumer
            (AG Grid popup, sheet form popover) would provide. The atom
            itself carries no border / shadow / padding. */}
        <div className="w-[var(--size-editor-popover-md)] rounded-[var(--radius-panel)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-[var(--space-3)] shadow-[var(--shadow-raised)]">
          {active ? (
            <Component
              key={resetKey}
              initialValue={props.initialValue}
              context={editorContext(options, props.search)}
              initialQuery={props.initialQuery}
              onCommit={(next) => {
                setLastCommit(next);
                setActive(false);
              }}
              onCancel={() => {
                setCancelCount((current) => current + 1);
                setActive(false);
              }}
              onNavigate={(direction) => {
                setNavigation(direction);
                setActive(false);
              }}
            />
          ) : (
            <div className="rounded-[var(--radius-control)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-body)] text-[var(--color-text-secondary)]">
              Editor closed. Reset to edit again.
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-[var(--space-2)]">
          <Badge tone={lastCommit === null ? "neutral" : "success"}>
            Commit: {lastCommit ? `${lastCommit.type}:${lastCommit.value}` : "none"}
          </Badge>
          <Badge tone={cancelCount ? "warning" : "neutral"}>Cancels: {cancelCount}</Badge>
          <Badge tone={navigation ? "info" : "neutral"}>Navigation: {navigation ?? "none"}</Badge>
        </div>
        <p className="m-0 text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
          {props.helper ??
            "Type to filter, ↑/↓ to highlight, Enter commits the highlighted option."}
        </p>
      </div>
    </Card>
  );
}
