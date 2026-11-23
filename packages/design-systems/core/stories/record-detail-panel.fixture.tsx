import { useState } from "react";

import { Button } from "../components";
import {
  RecordDetailPanel,
  type RecordDetailPanelProps,
  type RecordDetailValue,
} from "../compositions";

const defaultDetailSpec: RecordDetailPanelProps = {
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
        { type: "field", id: "active", label: "Available", value: true, control: "checkbox" },
      ],
    },
  ],
};

export function EditableFixture({ spec = defaultDetailSpec }: { spec?: RecordDetailPanelProps }) {
  const [values, setValues] = useState<Record<string, RecordDetailValue>>({
    name: "Item Alpha",
    category: "group-a",
    description: "A reusable example record with deliberately neutral vocabulary.",
    active: true,
  });
  const [draftValues, setDraftValues] = useState<Record<string, RecordDetailValue>>({});
  const [lastAction, setLastAction] = useState("None");
  const [mode, setMode] = useState<"read" | "edit">("read");
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
    <div className="mx-auto grid w-full max-w-[720px] gap-[var(--space-3)]">
      <p className="m-0 text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
        Last action: {lastAction}
      </p>
      <RecordDetailPanel
        {...spec}
        mode={mode}
        values={mode === "edit" ? draftValues : values}
        originalValues={values}
        errors={
          mode === "edit"
            ? { description: "Example validation message supplied by the host." }
            : undefined
        }
        actions={
          mode === "edit"
            ? [
                { id: "cancel", label: "Cancel", intent: "secondary" },
                { id: "save", label: "Save changes", intent: "primary" },
              ]
            : undefined
        }
        onEdit={
          mode === "read"
            ? () => {
                setDraftValues(values);
                setMode("edit");
              }
            : undefined
        }
        onClose={() => setOpen(false)}
        onValueChange={(fieldId, value) =>
          setDraftValues((current) => ({ ...current, [fieldId]: value }))
        }
        onRevertField={(fieldId, originalValue) =>
          setDraftValues((current) => ({ ...current, [fieldId]: originalValue }))
        }
        onAction={(actionId) => {
          setLastAction(actionId);
          if (actionId === "save") setValues(draftValues);
          if (actionId === "cancel" || actionId === "save") setMode("read");
        }}
      />
    </div>
  );
}
