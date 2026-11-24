// Tenant custom-field columns in the shared editable grid.
//
// The grid receives the wire shapes unchanged — `schema.custom_fields` and
// each row's `custom_fields` — and shows the model's active custom fields as
// ordinary columns after the declared ones. Stories:
//   - Columns: saved values for every custom type, plus empty cells.
//   - PendingEdits: a changed custom value, a cleared one, and a changed
//     choice, as the user sees them before Save.
//
// Fixture names are generic so the module stays free of app vocabulary.

import { useLayoutEffect, useRef } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import type { CustomFieldEntry, Schema, VisibleRecord } from "../../contracts";

import { bootstrapAgGrid } from "./bootstrap";
import { EditableRowVersionGrid } from "./EditableRowVersionGrid";
import type { RelationOptionsByModel } from "./schema-columns";
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
        { id: "opened_on", label: "Opened", type: "date", required: false },
      ],
    },
    {
      id: "group",
      kind: "lookup",
      label: "Group",
      display_field_id: "name",
      fields: [{ id: "name", label: "Name", type: "text", required: true }],
    },
  ],
  custom_fields: [
    {
      id: "cfd_code",
      model_id: "widget",
      field_id: "cf_code",
      label: "Cost code",
      type: "text",
    },
    {
      id: "cfd_tier",
      model_id: "widget",
      field_id: "cf_tier",
      label: "Tier",
      type: "enum",
      option_set: [
        { id: "opt_bronze", label: "Bronze" },
        { id: "opt_silver", label: "Silver" },
        { id: "opt_gold", label: "Gold" },
      ],
    },
    {
      id: "cfd_owner",
      model_id: "widget",
      field_id: "cf_owner",
      label: "Owning group",
      type: "relation",
      target_model_id: "group",
    },
    { id: "cfd_score", model_id: "widget", field_id: "cf_score", label: "Score", type: "number" },
    {
      id: "cfd_review",
      model_id: "widget",
      field_id: "cf_review",
      label: "Review date",
      type: "date",
    },
    { id: "cfd_flag", model_id: "widget", field_id: "cf_flag", label: "Flagged", type: "bool" },
    {
      id: "cfd_budget",
      model_id: "widget",
      field_id: "cf_budget",
      label: "Budget",
      type: "money_rate",
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

const RELATION_OPTIONS: RelationOptionsByModel = {
  group: [
    { key: { type: "record_id", value: "g-1" }, label: "Platform" },
    { key: { type: "record_id", value: "g-2" }, label: "Field operations" },
  ],
};

function row(
  recordId: string,
  name: string,
  customFields: CustomFieldEntry[],
  openedOn = "2026-01-12",
): VisibleRecord {
  return {
    record_id: recordId,
    effective_start: "2026-01-01",
    effective_end: null,
    values: {
      name: { type: "text", value: name },
      opened_on: { type: "date", value: openedOn },
    },
    custom_fields: customFields,
  };
}

const ROWS: VisibleRecord[] = [
  row("w-1", "North gate", [
    { field_id: "cf_code", type: "text", value: "RD-200" },
    { field_id: "cf_tier", type: "enum", value: "opt_gold" },
    { field_id: "cf_owner", type: "relation", value: { type: "record_id", value: "g-1" } },
    { field_id: "cf_score", type: "number", value: "82" },
    { field_id: "cf_review", type: "date", value: "2026-11-02" },
    { field_id: "cf_flag", type: "bool", value: true },
    {
      field_id: "cf_budget",
      type: "money_rate",
      value: { amount: "120000", currency: "USD", period: "annual" },
    },
    { field_id: "cf_tags", type: "text_list", value: ["outdoor", "priority"] },
  ]),
  row("w-2", "South yard", [
    { field_id: "cf_code", type: "text", value: "OPS-110" },
    { field_id: "cf_tier", type: "enum", value: "opt_silver" },
    { field_id: "cf_owner", type: "relation", value: { type: "record_id", value: "g-2" } },
    { field_id: "cf_score", type: "number", value: "64" },
    { field_id: "cf_flag", type: "bool", value: false },
  ]),
  row(
    "w-3",
    "East annex",
    [{ field_id: "cf_tier", type: "enum", value: "opt_bronze" }],
    "2025-08-03",
  ),
  row("w-4", "West hall", []),
];

function CustomFieldGrid(props: { stagePendingEdits?: boolean }) {
  const { controller, surfaceProps } = useEditableRowVersionGridPreview({
    modelId: "widget",
    asOf: "2026-10-17",
    scope: { appId: "demo", customerId: "demo" },
    rows: ROWS,
    schema: SCHEMA,
    model: "widget",
    relationOptionsByModel: RELATION_OPTIONS,
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
        cf_code: { type: "text", value: "RD-210" },
        cf_score: null,
      },
      bulkGroupId: "story",
      sourceKind: "user",
      sourceRef: null,
    });
    controller.stageBulkUpdate({
      rows: [{ rowKey: "w-2" }],
      values: { cf_tier: { type: "enum", value: "opt_gold" } },
      bulkGroupId: "story",
      sourceKind: "user",
      sourceRef: null,
    });
  }, [controller, props.stagePendingEdits]);
  return (
    <div className="h-[420px] w-full">
      <EditableRowVersionGrid {...surfaceProps} />
    </div>
  );
}

const meta = {
  title: "Editable Grid/Custom field columns",
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
  render: () => <CustomFieldGrid />,
};

export const PendingEdits: Story = {
  render: () => <CustomFieldGrid stagePendingEdits />,
};
