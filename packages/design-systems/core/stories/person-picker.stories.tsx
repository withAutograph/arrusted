import { useState, type ComponentType } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { RecordKey } from "@contracts";

import {
  Badge,
  Button,
  Card,
  PersonPicker,
  type EditorContext,
  type EditorProps,
} from "../components";
import type { PersonPickerValue } from "../components/editors/person-picker";

const avaKey: RecordKey = { type: "external_key", value: "person-ava" };
const miKey: RecordKey = { type: "external_key", value: "person-mi" };
const noahKey: RecordKey = { type: "external_key", value: "person-noah" };
const missingKey: RecordKey = { type: "external_key", value: "person-missing" };
const recordIdKey: RecordKey = { type: "record_id", value: "8a34bdb9-60f6-4e80-87e2-3208a9c93077" };

const personOptions = [
  {
    key: avaKey,
    label: "Ava Patel",
    detail: "Group Alpha - Primary reviewer",
    searchText: "ava patel group alpha primary reviewer",
  },
  {
    key: miKey,
    label: "Mi Kim",
    detail: "Group Beta - Secondary reviewer",
    searchText: "mi kim group beta secondary reviewer",
  },
  {
    key: noahKey,
    label: "Noah Rivera",
    detail: "Group Gamma - Backup reviewer",
    searchText: "noah rivera group gamma backup reviewer",
  },
  {
    key: recordIdKey,
    label: "Sam Record",
    detail: "Group Delta - Record ID relation",
    searchText: "sam record group delta record id",
  },
];

const disabledCurrentOptions = personOptions.map((option) =>
  option.key === avaKey ? { ...option, disabled: true } : option,
);

function editorContext(options = personOptions): EditorContext {
  return {
    rowKey: { type: "external_key", value: "item-alpha" },
    fieldId: "owner",
    fieldType: { type: "relation", label: "Owner", relationOptions: options },
    asOf: "2026-09-01",
  };
}

const meta = {
  title: "Design System/Editors/PersonPicker",
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <div className="min-h-screen bg-[var(--color-bg-page)] p-[var(--space-6)] text-[var(--color-text-primary)]">
        <div className="mx-auto max-w-[820px]">
          <Story />
        </div>
      </div>
    ),
  ],
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <PersonPickerHarness initialValue={null} />,
};

export const WithSelection: Story = {
  render: () => <PersonPickerHarness initialValue={avaKey} />,
};

export const EmptyResults: Story = {
  render: () => (
    <PersonPickerHarness
      initialValue={null}
      initialQuery="zzz"
      helper="No matches are shown when the app-supplied options do not match the query."
    />
  ),
};

export const Loading: Story = {
  render: () => <PersonPickerLoadingHarness />,
};

export const MissingCurrentValue: Story = {
  render: () => (
    <PersonPickerHarness
      initialValue={missingKey}
      helper="A current person outside the option set is shown as unavailable and can be cancelled."
    />
  ),
};

export const DisabledCurrentValue: Story = {
  render: () => (
    <PersonPickerHarness
      initialValue={avaKey}
      options={disabledCurrentOptions}
      helper="A disabled current value is treated as unavailable and exits without writing a replacement."
    />
  ),
};

export const ClearSearch: Story = {
  render: () => (
    <PersonPickerHarness
      initialValue={avaKey}
      initialQuery="Ava Patel"
      helper="Clear resets the search locally; it does not persist a null relation."
    />
  ),
};

export const ErrorNoSelection: Story = {
  render: () => (
    <PersonPickerHarness
      initialValue={null}
      initialQuery="No match"
      helper="Enter with no selected person reports an error instead of writing null."
    />
  ),
};

export const EnterCommit: Story = {
  render: () => (
    <PersonPickerHarness
      initialValue={null}
      initialQuery="Mi"
      helper="Press Enter to commit the active option."
    />
  ),
};

export const EscapeCancel: Story = {
  render: () => (
    <PersonPickerHarness initialValue={miKey} helper="Press Escape to cancel without a write." />
  ),
};

export const RecordIdRoundTrip: Story = {
  render: () => (
    <PersonPickerHarness
      initialValue={null}
      initialQuery="Sam"
      helper="Choose Sam Record to commit a record_id key without coercing it to an external key."
    />
  ),
};

export const TabNavigation: Story = {
  render: () => (
    <PersonPickerHarness
      initialValue={null}
      initialQuery="Mi"
      helper="Tab commits the selected value and reports navigation direction."
    />
  ),
};

function PersonPickerHarness(props: {
  initialValue: PersonPickerValue;
  initialQuery?: string;
  options?: typeof personOptions;
  helper?: string;
}) {
  const [lastCommit, setLastCommit] = useState<RecordKey | null>(null);
  const [cancelCount, setCancelCount] = useState(0);
  const [lastNavigation, setLastNavigation] = useState<"next" | "previous" | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [active, setActive] = useState(true);
  const Component = PersonPicker.Component as ComponentType<
    EditorProps<PersonPickerValue, RecordKey> & { initialQuery?: string }
  >;

  function resetEditor() {
    setLastCommit(null);
    setCancelCount(0);
    setLastNavigation(null);
    setActive(true);
    setResetKey((current) => current + 1);
  }

  return (
    <Card
      title="Person Picker"
      actions={
        <Button size="sm" intent="secondary" onClick={resetEditor}>
          Reset Editor
        </Button>
      }
    >
      <div className="grid gap-[var(--space-4)]">
        {/* Wrapping div mimics the popover surface a real consumer (AG Grid
            popup, sheet form popover) provides. The atom itself carries no
            border / shadow / padding. */}
        <div className="w-[var(--size-editor-popover-lg)] rounded-[var(--radius-panel)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-[var(--space-3)] shadow-[var(--shadow-raised)]">
          {active ? (
            <Component
              key={resetKey}
              initialValue={props.initialValue}
              initialQuery={props.initialQuery}
              context={editorContext(props.options)}
              onCommit={(next) => {
                setLastCommit(next);
                setActive(false);
              }}
              onCancel={() => {
                setCancelCount((current) => current + 1);
                setActive(false);
              }}
              onNavigate={(direction) => {
                setLastNavigation(direction);
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
          <Badge tone={lastNavigation ? "success" : "neutral"}>
            Navigate: {lastNavigation ?? "none"}
          </Badge>
        </div>
        <p className="m-0 text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
          {props.helper ??
            "Search, choose a person, then click or press Enter to commit the selected RecordKey."}
        </p>
      </div>
    </Card>
  );
}

function PersonPickerLoadingHarness() {
  return (
    <Card title="Person Picker">
      <div className="w-[var(--size-editor-popover-lg)] rounded-[var(--radius-panel)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-[var(--space-3)] shadow-[var(--shadow-raised)]">
        <div className="h-[var(--size-input-sm)] w-full animate-pulse rounded-[var(--radius-control)] bg-[var(--color-bg-skeleton)]" />
        <div className="mt-[var(--space-2)] h-[var(--size-skeleton-long)] animate-pulse rounded-[var(--radius-control)] bg-[var(--color-bg-skeleton)]" />
      </div>
    </Card>
  );
}
