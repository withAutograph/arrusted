import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { RecordList, StatusPill } from "../components";
import { RecordDetailPanel, RecordListDetailLayout } from "../compositions";

const meta = {
  title: "Design System/Compositions/Record List Detail",
  parameters: { layout: "padded" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const records = [
  { id: "alpha", name: "Item Alpha", evidence: "3 / 18", severity: "Critical" },
  { id: "beta", name: "Item Beta", evidence: "11 / 24", severity: "Low" },
] as const;

function Fixture() {
  const [selectedId, setSelectedId] = useState<string>(records[0].id);
  const selected = records.find((record) => record.id === selectedId);
  return (
    <RecordListDetailLayout
      hasSelection={Boolean(selected)}
      selectedId={selectedId || undefined}
      onBack={() => setSelectedId("")}
      list={
        <RecordList
          ariaLabel="Records to review"
          heading="Records to review"
          summary="Current / target"
          selectedId={selectedId}
          onSelect={setSelectedId}
          items={records.map((record) => ({
            id: record.id,
            primary: record.name,
            secondary: `Record ${record.id}`,
            trailing: (
              <>
                <StatusPill
                  label={record.severity}
                  tone={record.severity === "Critical" ? "danger" : "warning"}
                  size="xs"
                />
                <strong>{record.evidence}</strong>
              </>
            ),
          }))}
        />
      }
      detail={
        selected ? (
          <RecordDetailPanel
            title={selected.name}
            sections={[
              {
                id: "stock",
                title: "Record details",
                items: [
                  {
                    type: "field",
                    id: "evidence",
                    label: "Current / target",
                    value: selected.evidence,
                  },
                ],
              },
            ]}
          />
        ) : null
      }
    />
  );
}

export const SelectionAndDetail: Story = { render: () => <Fixture /> };
