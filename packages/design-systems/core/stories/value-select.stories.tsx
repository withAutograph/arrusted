// ValueSelect atom story. The wrapper mimics consumer-provided popup chrome.
import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { Badge, Button, Card, ValueSelect, type EditorContext } from "../components";

const OPTIONS = ["Enabled", "Pending", "Archived"] as const;

function editorContext(valueOptions: readonly string[]): EditorContext {
  return {
    rowKey: { type: "external_key", value: "item-alpha" },
    fieldId: "status",
    fieldType: { type: "text", label: "Status", valueOptions: [...valueOptions] },
    asOf: "2026-09-01",
  };
}

const meta = {
  title: "Design System/Editors/ValueSelect",
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <div className="min-h-screen bg-[var(--color-bg-page)] p-[var(--space-6)] text-[var(--color-text-primary)]">
        <div className="mx-auto max-w-[720px]">
          <Story />
        </div>
      </div>
    ),
  ],
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <ValueSelectHarness initialValue="" />,
};

export const WithSelection: Story = {
  render: () => <ValueSelectHarness initialValue="Pending" />,
};

export const EmptyOptions: Story = {
  render: () => (
    <ValueSelectHarness
      initialValue=""
      options={[]}
      helper="No options are rendered when the consumer has not supplied a vocabulary."
    />
  ),
};

export const OutOfVocabularyValue: Story = {
  render: () => (
    <ValueSelectHarness
      initialValue="Legacy"
      helper="The current value is prepended when it is outside the current vocabulary."
    />
  ),
};

export const EnterCommit: Story = {
  render: () => (
    <ValueSelectHarness
      initialValue="Enabled"
      initialReceipt={{ kind: "commit", value: "Enabled" }}
    />
  ),
};

export const EscapeCancel: Story = {
  render: () => <ValueSelectHarness initialValue="Archived" initialReceipt={{ kind: "cancel" }} />,
};

type InitialReceipt = { kind: "commit"; value: string } | { kind: "cancel" };

function ValueSelectHarness(props: {
  initialValue: string;
  helper?: string;
  initialReceipt?: InitialReceipt;
  options?: readonly string[];
}) {
  const options = props.options ?? OPTIONS;
  const [lastCommit, setLastCommit] = useState<string | null>(
    props.initialReceipt?.kind === "commit" ? props.initialReceipt.value : null,
  );
  const [cancelCount, setCancelCount] = useState(props.initialReceipt?.kind === "cancel" ? 1 : 0);
  const [resetKey, setResetKey] = useState(0);
  const [active, setActive] = useState(!props.initialReceipt);
  const Component = ValueSelect.Component;

  function resetEditor() {
    setLastCommit(props.initialReceipt?.kind === "commit" ? props.initialReceipt.value : null);
    setCancelCount(props.initialReceipt?.kind === "cancel" ? 1 : 0);
    setActive(true);
    setResetKey((current) => current + 1);
  }

  return (
    <Card
      title="Value Select"
      actions={
        <Button size="sm" intent="secondary" onClick={resetEditor}>
          Reset Editor
        </Button>
      }
    >
      <div className="grid gap-[var(--space-4)]">
        <div className="w-max min-w-[var(--size-editor-value-select-min)] max-w-[var(--size-editor-popover-md)] rounded-[var(--radius-panel)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-[var(--space-2)] shadow-[var(--shadow-raised)]">
          {active ? (
            <Component
              key={resetKey}
              initialValue={props.initialValue}
              context={editorContext(options)}
              onCommit={(next) => {
                setLastCommit(next);
                setActive(false);
              }}
              onCancel={() => {
                setCancelCount((current) => current + 1);
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
            Commit: {lastCommit ?? "none"}
          </Badge>
          <Badge tone={cancelCount ? "warning" : "neutral"}>Cancels: {cancelCount}</Badge>
        </div>
        <p className="m-0 text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
          {props.helper ?? "Arrow keys move the active option, Enter commits, Escape cancels."}
        </p>
      </div>
    </Card>
  );
}
