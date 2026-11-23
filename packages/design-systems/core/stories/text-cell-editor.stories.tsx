import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { Badge, Button, Card, TextCellEditor, type EditorContext } from "../components";

const editorContext: EditorContext = {
  rowKey: { type: "external_key", value: "item-alpha" },
  fieldId: "label",
  fieldType: { type: "text", label: "Label" },
  asOf: "2026-09-01",
};

const meta = {
  title: "Design System/Editors/TextCellEditor",
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
  render: () => <TextEditorHarness initialValue="" />,
};

export const WithPrefilledValue: Story = {
  render: () => <TextEditorHarness initialValue="Sample label" />,
};

export const FocusedEditing: Story = {
  render: () => (
    <TextEditorHarness initialValue="Editing in progress" helper="The input is focused on mount." />
  ),
};

export const EnterCommit: Story = {
  render: () => (
    <TextEditorHarness
      initialValue="Committed value"
      initialReceipt={{ kind: "commit", value: "Committed value" }}
    />
  ),
};

export const EscapeCancel: Story = {
  render: () => (
    <TextEditorHarness initialValue="Cancelled value" initialReceipt={{ kind: "cancel" }} />
  ),
};

type InitialReceipt = { kind: "commit"; value: string } | { kind: "cancel" };

function TextEditorHarness(props: {
  initialValue: string;
  helper?: string;
  initialReceipt?: InitialReceipt;
}) {
  const [lastCommit, setLastCommit] = useState<string | null>(
    props.initialReceipt?.kind === "commit" ? props.initialReceipt.value : null,
  );
  const [cancelCount, setCancelCount] = useState(props.initialReceipt?.kind === "cancel" ? 1 : 0);
  const [navigation, setNavigation] = useState<"next" | "previous" | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [active, setActive] = useState(!props.initialReceipt);
  const Component = TextCellEditor.Component;

  function resetEditor() {
    setLastCommit(props.initialReceipt?.kind === "commit" ? props.initialReceipt.value : null);
    setCancelCount(props.initialReceipt?.kind === "cancel" ? 1 : 0);
    setNavigation(null);
    setActive(true);
    setResetKey((current) => current + 1);
  }

  return (
    <Card
      title="Text Cell Editor"
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
            Commit: {lastCommit ?? "none"}
          </Badge>
          <Badge tone={cancelCount ? "warning" : "neutral"}>Cancels: {cancelCount}</Badge>
          <Badge tone={navigation ? "info" : "neutral"}>Navigation: {navigation ?? "none"}</Badge>
        </div>
        <p className="m-0 text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
          {props.helper ??
            "Enter commits, Escape cancels, Tab commits and requests next-cell focus."}
        </p>
      </div>
    </Card>
  );
}
