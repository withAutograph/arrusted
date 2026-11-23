import type { CompositionSpec } from "../compositions";

export const schemaFormStory: CompositionSpec<"schema_form"> = {
  type: "schema_form",
  title: "Request",
  config: {
    layout: "grid",
    submitLabel: "Save",
    resetLabel: "Reset",
    fields: [
      {
        id: "label",
        label: "Label",
        control: "text",
        value: "Quarterly plan",
        previousValue: "Annual plan",
        required: true,
      },
      {
        id: "start",
        label: "Start",
        control: "date",
        value: "2026-07-01",
        required: true,
      },
      {
        id: "priority",
        label: "Priority",
        control: "select",
        value: "urgent",
        previousValue: "standard",
        options: [
          { value: "standard", label: "Standard" },
          { value: "urgent", label: "Urgent" },
        ],
      },
      {
        id: "notes",
        label: "Notes",
        control: "textarea",
        helper: "Optional context for reviewers.",
      },
    ],
  },
};
