// The grid unit and the record panel over the in-memory canvas client.
import { useMemo, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { bootstrapAgGrid } from "../../modules/editable-grid";

import { withPendingDrafts } from "../client";
import { GridUnit } from "../grid-unit";
import { RecordPanel } from "../record-panel";
import { createSelectionStore, type CanvasSelection } from "../selection";
import { useCanvasSession } from "../use-canvas-session";
import { gridMemory, money, projectId, sessionId, withStagedValues } from "./fixtures/grid";

bootstrapAgGrid({ allowMissingLicense: true });

type Memory = ReturnType<typeof gridMemory>;

function GridStory({
  memory,
  selection = null,
  openRecord = null,
  drafts = false,
}: {
  memory: Memory;
  selection?: CanvasSelection | null;
  openRecord?: string | null;
  /** Read as the canvas does with Show drafts on. */
  drafts?: boolean;
}) {
  const client = useMemo(() => withPendingDrafts(memory.client, drafts), [memory, drafts]);
  const session = useCanvasSession(client, sessionId);
  const store = useMemo(() => {
    const created = createSelectionStore(memory.client.definition);
    if (selection !== null) created.select(selection);
    return created;
  }, [memory, selection]);
  const [open, setOpen] = useState<string | null>(openRecord);
  return (
    <div className="flex h-screen gap-[var(--space-4)] bg-[var(--color-bg-page)] p-[var(--space-6)]">
      <section className="flex min-w-[var(--space-0)] flex-1 flex-col overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)]">
        {session.status === "ready" ? (
          <GridUnit
            client={client}
            session={session}
            selection={store}
            unitId="grid-1"
            modelId="m_project"
            onOpenRecord={setOpen}
          />
        ) : null}
      </section>
      {open !== null && session.status === "ready" ? (
        <aside className="flex w-[400px] shrink-0">
          <RecordPanel
            client={client}
            session={session}
            modelId="m_project"
            recordId={open}
            onClose={() => setOpen(null)}
          />
        </aside>
      ) : null}
    </div>
  );
}

const meta = {
  title: "Canvas/Grid",
  component: GridStory,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof GridStory>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Every project, nothing staged yet. */
export const NoStagedValues: Story = {
  args: { memory: gridMemory() },
  loaders: [async () => ({ memory: gridMemory() })],
  render: (_, { loaded }) => <GridStory memory={loaded.memory as Memory} />,
};

/** The user's edits and two agent turns: "was …" under each, the agent marker on the agent's. */
export const StagedValues: Story = {
  args: { memory: gridMemory() },
  loaders: [async () => ({ memory: await withStagedValues(gridMemory()) })],
  render: (_, { loaded }) => <GridStory memory={loaded.memory as Memory} />,
};

/** A budget the agent staged, then someone changed the record outside the session. */
export const StaleEntry: Story = {
  args: { memory: gridMemory() },
  loaders: [
    async () => {
      const memory = await withStagedValues(gridMemory());
      memory.writeCanonical("m_project", projectId(2), { f_budget: money("70000") });
      return { memory };
    },
  ],
  render: (_, { loaded }) => <GridStory memory={loaded.memory as Memory} />,
};

/** A chart bar ("Status: Active") elsewhere on the canvas filters the grid. */
export const Filtered: Story = {
  args: { memory: gridMemory() },
  loaders: [async () => ({ memory: await withStagedValues(gridMemory(40)) })],
  render: (_, { loaded }) => (
    <GridStory
      memory={loaded.memory as Memory}
      selection={{
        kind: "segment",
        unit_id: "chart-1",
        model_id: "m_project",
        field_id: "f_status",
        value: "active",
      }}
    />
  ),
};

/** 250 projects: the first 100 load; scrolling to the end or "Load more" reads the next page. */
export const ManyRows: Story = {
  args: { memory: gridMemory() },
  loaders: [async () => ({ memory: await withStagedValues(gridMemory(250)) })],
  render: (_, { loaded }) => <GridStory memory={loaded.memory as Memory} />,
};

/** The record panel open on a project the agent staged a budget and owner for. */
export const RecordPanelOpen: Story = {
  args: { memory: gridMemory() },
  loaders: [async () => ({ memory: await withStagedValues(gridMemory()) })],
  render: (_, { loaded }) => (
    <GridStory memory={loaded.memory as Memory} openRecord={projectId(5)} />
  ),
};

/** The data service cannot be reached. */
export const LoadError: Story = {
  args: { memory: gridMemory() },
  loaders: [
    async () => {
      const memory = gridMemory();
      const data = {
        ...memory.client.data,
        list: () => Promise.reject(new Error("The data service is unavailable.")),
      };
      return { memory: { ...memory, client: { ...memory.client, data } } };
    },
  ],
  render: (_, { loaded }) => <GridStory memory={loaded.memory as Memory} />,
};

/** Others' pending drafts: a changed estimate and budget, and a new project. */
async function withPendingDraftValues(memory: Memory) {
  await withStagedValues(memory);
  memory.seedDraft({
    actorId: "user-ravi",
    changes: [
      {
        model_id: "m_project",
        record_id: projectId(4),
        field_id: "f_estimate",
        value: { type: "number", value: "64" },
      },
      {
        model_id: "m_project",
        record_id: projectId(6),
        field_id: "f_budget",
        value: money("120000"),
      },
    ],
  });
  memory.seedDraft({
    actorId: "user-hana",
    changes: [],
    creates: [
      {
        model_id: "m_project",
        record_id: projectId(90),
        values: {
          f_name: { type: "text", value: "Partner onboarding" },
          f_client: { type: "text", value: "Lumen" },
          f_status: { type: "enum", value: "planned" },
          f_estimate: { type: "number", value: "18" },
          f_budget: money("85000"),
        },
      },
    ],
  });
  return memory;
}

/** Show drafts on: draft values carry a quiet "draft" tag; a draft's new project is tagged on its name. */
export const PendingDrafts: Story = {
  args: { memory: gridMemory() },
  loaders: [async () => ({ memory: await withPendingDraftValues(gridMemory()) })],
  render: (_, { loaded }) => <GridStory drafts memory={loaded.memory as Memory} />,
};

/** The record panel over a value a pending draft changed. */
export const PendingDraftsRecordPanel: Story = {
  args: { memory: gridMemory() },
  loaders: [async () => ({ memory: await withPendingDraftValues(gridMemory()) })],
  render: (_, { loaded }) => (
    <GridStory drafts memory={loaded.memory as Memory} openRecord={projectId(4)} />
  ),
};

/** The record panel of a project only a pending draft creates. */
export const PendingDraftCreatedRecordPanel: Story = {
  args: { memory: gridMemory() },
  loaders: [async () => ({ memory: await withPendingDraftValues(gridMemory()) })],
  render: (_, { loaded }) => (
    <GridStory drafts memory={loaded.memory as Memory} openRecord={projectId(90)} />
  ),
};
