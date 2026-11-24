// Date-and-time and list-of-text columns in the shared editable grid, declared
// and custom alike. Stories:
//   - Columns: saved values and empty cells (editors closed).
//   - PendingEdits: a changed date and time, a changed list and a cleared
//     list, as the user sees them before Save.
// Open-editor proof is captured from `Columns` by pressing Enter on a cell.
//
// Fixture names are generic so the module stays free of app vocabulary.

import { useLayoutEffect, useRef } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import type { CustomFieldEntry, FieldValue, Schema, VisibleRecord } from "../../contracts";

import { bootstrapAgGrid } from "./bootstrap";
import { EditableRowVersionGrid } from "./EditableRowVersionGrid";
import { useEditableRowVersionGridPreview } from "./useEditableRowVersionGrid";

bootstrapAgGrid();

const SCHEMA: Schema = {
  app_id: "demo",
  customer_id: "demo",
  version: "1",
  models: [
    {
      id: "widget",
      kind: "entity",
      label: "Widget",
      extensions: { typed_custom_fields: true },
      fields: [
        { id: "name", label: "Name", type: "text", required: true },
        { id: "checked_at", label: "Last checked", type: "datetime", required: true },
        { id: "labels", label: "Labels", type: "text_list", required: false },
      ],
    },
  ],
  custom_fields: [
    {
      id: "cfd_inspected",
      model_id: "widget",
      field_id: "cf_inspected",
      label: "Inspected",
      type: "datetime",
    },
    { id: "cfd_tags", model_id: "widget", field_id: "cf_tags", label: "Tags", type: "text_list" },
  ],
  change_types: [
    {
      id: "widget_update",
      label: "Widget update",
      target_model: "widget",
      touches: [],
      required: [],
    },
  ],
};

function row(
  recordId: string,
  name: string,
  checkedAt: string,
  labels: string[] | null,
  customFields: CustomFieldEntry[],
): VisibleRecord {
  const values: Record<string, FieldValue> = {
    name: { type: "text", value: name },
    checked_at: { type: "datetime", value: checkedAt },
  };
  if (labels) values.labels = { type: "text_list", value: labels };
  return {
    record_id: recordId,
    effective_start: "2026-01-01",
    effective_end: null,
    values,
    custom_fields: customFields,
  };
}

const ROWS: VisibleRecord[] = [
  row(
    "w-1",
    "North gate",
    "2026-10-14T08:30:00Z",
    ["perimeter"],
    [
      { field_id: "cf_inspected", type: "datetime", value: "2026-10-02T14:15:00Z" },
      { field_id: "cf_tags", type: "text_list", value: ["outdoor", "priority", "night shift"] },
    ],
  ),
  row(
    "w-2",
    "South yard",
    "2026-10-15T16:00:00Z",
    ["storage", "fenced"],
    [{ field_id: "cf_tags", type: "text_list", value: ["indoor"] }],
  ),
  row("w-3", "East annex", "2026-09-30T09:45:00Z", null, []),
];

function DatetimeTextListGrid(props: { stagePendingEdits?: boolean }) {
  const { controller, surfaceProps } = useEditableRowVersionGridPreview({
    modelId: "widget",
    asOf: "2026-10-17",
    scope: { appId: "demo", customerId: "demo" },
    rows: ROWS,
    schema: SCHEMA,
    model: "widget",
    changeTypeId: "widget_update",
    changeTypeLabel: () => "Widget update",
    bulkGroupLabel: () => "Quarterly review",
    mode: "edit",
  });
  const staged = useRef(false);
  useLayoutEffect(() => {
    if (!props.stagePendingEdits || staged.current) return;
    staged.current = true;
    controller.stageBulkUpdate({
      rows: [{ rowKey: "w-1" }],
      values: {
        cf_inspected: { type: "datetime", value: "2026-10-16T09:00:00Z" },
        cf_tags: { type: "text_list", value: ["outdoor", "priority"] },
      },
      bulkGroupId: "story",
      sourceKind: "user",
      sourceRef: null,
    });
    controller.stageBulkUpdate({
      rows: [{ rowKey: "w-2" }],
      values: { labels: null },
      bulkGroupId: "story",
      sourceKind: "user",
      sourceRef: null,
    });
  }, [controller, props.stagePendingEdits]);
  return (
    <div className="h-[540px] w-full">
      <EditableRowVersionGrid {...surfaceProps} />
    </div>
  );
}

const meta = {
  title: "Editable Grid/Date-time and list columns",
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

export const Columns: Story = {
  render: () => <DatetimeTextListGrid />,
};

export const PendingEdits: Story = {
  render: () => <DatetimeTextListGrid stagePendingEdits />,
};
