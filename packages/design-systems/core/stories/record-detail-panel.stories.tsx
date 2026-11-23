import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { Button, Sheet, Tag } from "../components";
import {
  RecordDetailComposition,
  RecordDetailPanel,
  type RecordDetailPanelProps,
  type RecordDetailSpec,
  type RecordDetailValue,
} from "../compositions";
import { EditableFixture } from "./record-detail-panel.fixture";

const meta = {
  title: "Design System/Compositions/Record Detail Panel",
  component: RecordDetailPanel,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="min-h-screen bg-[var(--color-bg-page)] p-[var(--space-6)] text-[var(--color-text-primary)]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const detailSpec: RecordDetailSpec = {
  title: "Item Alpha",
  subtitle: "Primary record in Group A",
  status: { label: "Enabled", tone: "success" },
  tabs: [
    { id: "summary", label: "Summary" },
    { id: "activity", label: "Activity" },
    { id: "audit", label: "Audit log" },
  ],
  activeTabId: "summary",
  metadata: [
    { id: "record-key", label: "Record key", value: "item-alpha-001" },
    { id: "updated", label: "Updated", value: "Today at 10:42" },
  ],
  sections: [
    {
      id: "overview",
      title: "Overview",
      items: [
        { type: "field", id: "name", label: "Name", value: "Item Alpha", control: "text" },
        {
          type: "field",
          id: "category",
          label: "Category",
          value: "group-a",
          control: "select",
          options: [
            { value: "group-a", label: "Group A" },
            { value: "group-b", label: "Group B" },
          ],
        },
        {
          type: "field",
          id: "description",
          label: "Description",
          value: "A reusable example record with deliberately neutral vocabulary.",
          control: "textarea",
        },
        {
          type: "field",
          id: "active",
          label: "Available",
          value: true,
          control: "checkbox",
        },
      ],
    },
    {
      id: "related",
      title: "Related values",
      items: [
        {
          type: "table",
          id: "related-table",
          ariaLabel: "Linked records",
          columns: [
            { id: "label", label: "Label" },
            { id: "group", label: "Group" },
            { id: "enabled", label: "Enabled", align: "center" },
          ],
          rows: [
            { label: "Item Beta", group: "Group B", enabled: true },
            { label: "Item Gamma", group: "Group A", enabled: false },
          ],
        },
      ],
    },
    {
      id: "activity",
      title: "Additional context",
      defaultOpen: false,
      items: [
        {
          type: "note",
          id: "review-note",
          title: "Review suggested",
          body: "Confirm the related values before applying a change.",
          tone: "info",
        },
        { type: "field", id: "optional", label: "Optional value", value: null },
      ],
    },
  ],
};

const narrowDetailSpec: RecordDetailSpec = {
  ...detailSpec,
  metadata: [
    {
      id: "record-key",
      label: "Record key",
      value: "item-alpha-with-an-intentionally-long-unbroken-record-identifier-001",
    },
  ],
  sections: detailSpec.sections.map((section) => {
    if (section.id !== "related") return section;
    return {
      ...section,
      items: section.items.map((item) =>
        item.type === "table"
          ? {
              ...item,
              columns: [
                ...item.columns,
                { id: "reference", label: "External reference" },
                { id: "owner", label: "Responsible group" },
              ],
              rows: item.rows.map((row, index) => ({
                ...row,
                reference: `external-reference-${index + 1}-with-a-long-unbroken-identifier`,
                owner: index === 0 ? "Operations East" : "Operations West",
              })),
            }
          : item,
      ),
    };
  }),
};

const scrollableDetailSpec: RecordDetailSpec = {
  ...detailSpec,
  sections: [
    ...detailSpec.sections.map((section) => ({ ...section, defaultOpen: true })),
    {
      id: "history",
      title: "Record history",
      items: Array.from({ length: 14 }, (_, index) => ({
        type: "field" as const,
        id: `history-${index + 1}`,
        label: `History entry ${index + 1}`,
        value: `Example recorded value ${index + 1}`,
      })),
    },
  ],
};

export const ReadOnly: Story = {
  args: detailSpec,
  render: (args) => (
    <div className="mx-auto w-full max-w-[640px]">
      <RecordDetailPanel {...args} />
    </div>
  ),
};

/** Read mode over values that replaced others: each changed field shows what it was, and notes. */
export const ReadWithChanges: Story = {
  args: detailSpec,
  render: (args) => (
    <div className="mx-auto w-full max-w-[640px]">
      <RecordDetailPanel
        {...args}
        values={{ name: "Item Beta", description: "An updated example description." }}
        originalValues={{
          name: "Item Alpha",
          description: "A reusable example record with deliberately neutral vocabulary.",
        }}
        fieldNotes={{
          name: <Tag label="agent" tone="blue" />,
          category: "in draft #4",
        }}
      />
    </div>
  ),
};

export const Editable: Story = {
  args: detailSpec,
  render: (args) => <EditableFixture spec={args} />,
};

export const WithFieldChanges: Story = {
  args: detailSpec,
  render: (args) => <ChangedFieldsFixture spec={args} />,
};

export const NarrowEditable: Story = {
  args: detailSpec,
  render: (args) => (
    <div className="w-[340px] max-w-full">
      <EditableFixture spec={args} />
    </div>
  ),
};

export const InSheet: Story = {
  args: detailSpec,
  render: (args) => (
    <>
      <div className="mx-auto max-w-[880px] rounded-[var(--radius-panel)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-[var(--space-6)]">
        <h1 className="m-0 text-[length:var(--text-page-title)]">Record workspace</h1>
        <p className="text-[var(--color-text-secondary)]">
          The page remains visible and interactive while the detail composition is hosted in a
          Sheet.
        </p>
      </div>
      <Sheet open title="Inspect record" width="min(560px, calc(100vw - 32px))" onClose={() => {}}>
        <RecordDetailPanel {...args} className="border-0 shadow-none" />
      </Sheet>
    </>
  ),
};

export const AgentSpec: Story = {
  args: detailSpec,
  render: (args) => (
    <div className="mx-auto w-full max-w-[640px]">
      <RecordDetailComposition spec={{ type: "record_detail", config: args as RecordDetailSpec }} />
    </div>
  ),
};

export const Narrow: Story = {
  args: narrowDetailSpec,
  render: (args) => (
    <div className="w-[340px] max-w-full">
      <RecordDetailPanel {...args} />
    </div>
  ),
};

export const Scrollable: Story = {
  args: scrollableDetailSpec,
  render: (args) => (
    <div className="mx-auto h-[640px] w-full max-w-[560px]">
      <RecordDetailPanel {...args} className="h-full" />
    </div>
  ),
};

function ChangedFieldsFixture({ spec = detailSpec }: { spec?: RecordDetailPanelProps }) {
  const initialValues: Record<string, RecordDetailValue> = {
    name: "Item Alpha",
    category: "group-a",
    description: "A reusable example record with deliberately neutral vocabulary.",
    active: true,
  };
  const [values, setValues] = useState(initialValues);
  const [draftValues, setDraftValues] = useState<Record<string, RecordDetailValue>>({
    ...initialValues,
    category: "group-b",
    description: "Updated description awaiting save.",
  });
  const [open, setOpen] = useState(true);

  if (!open) {
    return (
      <div className="mx-auto grid w-full max-w-[720px] place-items-center gap-[var(--space-3)] rounded-[var(--radius-panel)] border border-dashed border-[var(--color-border-strong)] p-[var(--space-6)]">
        <p className="m-0 text-[var(--color-text-secondary)]">The detail panel is closed.</p>
        <Button intent="secondary" onClick={() => setOpen(true)}>
          Reopen panel
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[720px]">
      <RecordDetailPanel
        {...spec}
        mode="edit"
        values={draftValues}
        originalValues={values}
        onClose={() => setOpen(false)}
        actions={[
          { id: "cancel", label: "Cancel", intent: "secondary" },
          { id: "save", label: "Save changes", intent: "primary" },
        ]}
        onValueChange={(fieldId, value) =>
          setDraftValues((current) => ({ ...current, [fieldId]: value }))
        }
        onRevertField={(fieldId, originalValue) =>
          setDraftValues((current) => ({ ...current, [fieldId]: originalValue }))
        }
        onAction={(actionId) => {
          if (actionId === "cancel") setDraftValues(values);
          if (actionId === "save") setValues(draftValues);
        }}
      />
    </div>
  );
}
