import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { Badge, BoolCellEditor, Button, Card, type EditorContext } from "../components";

const editorContext: EditorContext = {
  rowKey: { type: "external_key", value: "item-alpha" },
  fieldId: "remote",
  fieldType: { type: "bool", label: "Remote" },
  asOf: "2026-09-01",
};

const meta = {
  title: "Design System/Editors/BoolCellEditor",
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

export const DefaultUnset: Story = {
  render: () => <BoolEditorHarness initialValue={null} />,
};

export const TrueValue: Story = {
  render: () => <BoolEditorHarness initialValue={true} />,
};

export const FalseValue: Story = {
  render: () => <BoolEditorHarness initialValue={false} />,
};

export const ToggleToFalse: Story = {
  render: () => (
    <BoolEditorHarness initialValue={true} initialReceipt={{ kind: "commit", value: false }} />
  ),
};

export const EscapeCancel: Story = {
  render: () => <BoolEditorHarness initialValue={null} initialReceipt={{ kind: "cancel" }} />,
};

export const TabNavigation: Story = {
  render: () => (
    <BoolEditorHarness
      initialValue={null}
      initialReceipt={{ kind: "navigate", direction: "next" }}
    />
  ),
};

type InitialReceipt =
  | { kind: "commit"; value: boolean }
  | { kind: "cancel" }
  | { kind: "navigate"; direction: "next" | "previous" };

function BoolEditorHarness(props: {
  initialValue: boolean | null;
  initialReceipt?: InitialReceipt;
}) {
  const [lastCommit, setLastCommit] = useState<boolean | null>(
    props.initialReceipt?.kind === "commit" ? props.initialReceipt.value : null,
  );
  const [cancelCount, setCancelCount] = useState(props.initialReceipt?.kind === "cancel" ? 1 : 0);
  const [navigation, setNavigation] = useState<"next" | "previous" | null>(
    props.initialReceipt?.kind === "navigate" ? props.initialReceipt.direction : null,
  );
  const [resetKey, setResetKey] = useState(0);
  const [active, setActive] = useState(!props.initialReceipt);
  const Component = BoolCellEditor.Component;

  function resetEditor() {
    setLastCommit(props.initialReceipt?.kind === "commit" ? props.initialReceipt.value : null);
    setCancelCount(props.initialReceipt?.kind === "cancel" ? 1 : 0);
    setNavigation(
      props.initialReceipt?.kind === "navigate" ? props.initialReceipt.direction : null,
    );
    setActive(true);
    setResetKey((current) => current + 1);
  }

  return (
    <Card
      title="Bool Cell Editor"
      actions={
        <Button size="sm" intent="secondary" onClick={resetEditor}>
          Reset Editor
        </Button>
      }
    >
      <div className="grid gap-[var(--space-4)]">
        <div className="max-w-[360px] rounded-[var(--radius-panel)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-subtle)] p-[var(--space-3)]">
          {active ? (
            <Component
              key={resetKey}
              initialValue={props.initialValue}
              context={editorContext}
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
            Commit: {lastCommit === null ? "none" : lastCommit ? "true" : "false"}
          </Badge>
          <Badge tone={cancelCount ? "warning" : "neutral"}>Cancels: {cancelCount}</Badge>
          <Badge tone={navigation ? "info" : "neutral"}>Navigation: {navigation ?? "none"}</Badge>
        </div>
        <p className="m-0 text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
          Unset is a no-value editor state. Only explicit Yes or No emits a bool value.
        </p>
      </div>
    </Card>
  );
}
