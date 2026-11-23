import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { DataTableComposition, RecordDetailPanel } from "../compositions";

const meta = {
  title: "Design System/Compositions/Record Selection",
  parameters: { layout: "padded" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
function RecordSelection({ empty = false }: { empty?: boolean }) {
  const [selectedRowId, selectRow] = useState<string>();
  const rows = empty
    ? []
    : [
        { id: "a", name: "Item Alpha", status: "Enabled" },
        { id: "b", name: "Item Beta", status: "Pending" },
      ];
  const selected = rows.find((row) => row.id === selectedRowId);
  return (
    <div className="grid gap-[var(--space-4)]">
      <DataTableComposition
        spec={{
          type: "data_table",
          config: {
            ariaLabel: "Records",
            columns: [
              { id: "name", label: "Name" },
              { id: "status", label: "Status" },
            ],
            rows,
            density: "compact",
            emptyLabel: "No matching records. Clear filters to see all records.",
          },
        }}
        getRowId={(row) => String(row.id)}
        selectedRowId={selectedRowId}
        onRowSelect={selectRow}
      />
      {selected ? (
        <RecordDetailPanel
          title={selected.name}
          onClose={() => selectRow(undefined)}
          sections={[
            {
              id: "overview",
              title: "Overview",
              items: [{ type: "field", id: "status", label: "Status", value: selected.status }],
            },
          ]}
        />
      ) : (
        <p>Select a record to see its details.</p>
      )}
    </div>
  );
}
export const SelectionAndDetail: Story = { render: () => <RecordSelection /> };
export const Empty: Story = { render: () => <RecordSelection empty /> };
