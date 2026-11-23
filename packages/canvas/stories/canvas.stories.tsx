// The assembled canvas over the in-memory client: the plane with a table, a
// chart, a graph and the rule's card, the top bar's panes, a thread open in
// place, the record drawer, outside-change toasts and Save.
import type { Meta, StoryObj } from "@storybook/react-vite";

import { bootstrapAgGrid } from "../../modules/editable-grid";
import { Canvas } from "../canvas";
import type { CanvasLayout } from "@autograph/work-session-tools/layout";
import type { MemoryCanvas } from "../memory-client";
import {
  agentStagesTurn,
  canvasMemory,
  seedTypical,
  send,
  sessionId,
  threadIds,
  turns,
  typicalLayout,
} from "./fixtures/canvas";
import { money, projectId } from "./fixtures/grid";

bootstrapAgGrid({ allowMissingLicense: true });

function CanvasStory({
  memory,
  size,
  compact,
}: {
  memory: MemoryCanvas;
  size?: { width: number; height: number };
  compact?: boolean;
}) {
  return (
    <div className="flex h-screen w-full overflow-hidden" style={size}>
      <Canvas client={memory.client} compact={compact} sessionId={sessionId} />
    </div>
  );
}

type Loaded = { memory: MemoryCanvas };
const seeded = (
  layout: CanvasLayout | Record<string, never>,
  setup: (memory: MemoryCanvas) => Promise<unknown> = async () => {},
) => [
  async (): Promise<Loaded> => {
    const memory = canvasMemory(layout);
    await setup(memory);
    return { memory };
  },
];

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for `selector` under `root` (panes and popovers render on the body) and clicks it. */
async function click(root: ParentNode, selector: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const target = root.querySelector<HTMLElement>(selector);
    if (target !== null) {
      target.click();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`story: ${selector} never rendered`);
}

const meta = {
  title: "Canvas/Canvas",
  component: CanvasStory,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof CanvasStory>;
export default meta;
type Story = StoryObj<typeof meta>;
const memory = canvasMemory();

/** A new session: nothing on the plane yet, and the prompt to add a unit. */
export const EmptySession: Story = {
  args: { memory },
  loaders: seeded({}),
  render: (_, { loaded }) => <CanvasStory memory={(loaded as Loaded).memory} />,
};

/**
 * A typical session: projects in a table, a status chart, an owner graph and
 * the agent's rule as a card; values staged by two agent turns and by you,
 * and open threads pinned to a staged budget and to the chart.
 */
export const TypicalSession: Story = {
  args: { memory },
  loaders: seeded(typicalLayout, seedTypical),
  render: (_, { loaded }) => <CanvasStory memory={(loaded as Loaded).memory} />,
};

/** The Unsaved changes pane, down from the changes bar. */
export const StagedChangesPane: Story = {
  args: { memory },
  loaders: seeded(typicalLayout, seedTypical),
  render: (_, { loaded }) => <CanvasStory memory={(loaded as Loaded).memory} />,
  play: async () => click(document, "[data-pane-button='staged']"),
};

/** The Comments pane: Add a comment, then every open thread, by where it is pinned. */
export const CommentsPane: Story = {
  args: { memory },
  loaders: seeded(typicalLayout, seedTypical),
  render: (_, { loaded }) => <CanvasStory memory={(loaded as Loaded).memory} />,
  play: async () => click(document, "[data-pane-button='comments']"),
};

/** Comment mode on, from the Comments pane's Add a comment: Comments shows it is on. */
export const CommentModeOn: Story = {
  args: { memory },
  loaders: seeded(typicalLayout, seedTypical),
  render: (_, { loaded }) => <CanvasStory memory={(loaded as Loaded).memory} />,
  play: async () => {
    await click(document, "[data-pane-button='comments']");
    await click(document, "[data-add-comment]");
  },
};

/** The Rules pane: choosing a rule brings its card into view. */
export const RulesPane: Story = {
  args: { memory },
  loaders: seeded(typicalLayout, seedTypical),
  render: (_, { loaded }) => <CanvasStory memory={(loaded as Loaded).memory} />,
  play: async () => click(document, "[data-pane-button='rules']"),
};

/** The thread on the staged budget, open in place beside its cell. */
export const ThreadOpen: Story = {
  args: { memory },
  loaders: seeded(typicalLayout, seedTypical),
  render: (_, { loaded }) => <CanvasStory memory={(loaded as Loaded).memory} />,
  play: async ({ canvasElement }) => click(canvasElement, "[data-cell-pin]"),
};

/** A project opened from its name, in the drawer. */
export const RecordDrawer: Story = {
  args: { memory },
  loaders: seeded(typicalLayout, seedTypical),
  render: (_, { loaded }) => <CanvasStory memory={(loaded as Loaded).memory} />,
  play: async ({ canvasElement }) =>
    click(canvasElement, `[row-id="${projectId(2)}"] [col-id="f_name"]`),
};

/** A chat's inline canvas: one bar with the title, as-of, what is unsaved and Save. */
export const CompactInChat: Story = {
  args: { memory },
  loaders: seeded(typicalLayout, seedTypical),
  render: (_, { loaded }) => (
    <CanvasStory compact memory={(loaded as Loaded).memory} size={{ width: 760, height: 640 }} />
  ),
};

/** A narrow window: the top bar wraps, units shrink to the readable minimum, then the plane scrolls. */
export const NarrowViewport: Story = {
  args: { memory },
  loaders: seeded(typicalLayout, seedTypical),
  render: (_, { loaded }) => (
    <CanvasStory memory={(loaded as Loaded).memory} size={{ width: 900, height: 700 }} />
  ),
};

/**
 * The agent works in the background while the canvas is open: it stages a
 * new turn and replies on a thread. The badge pulses and each change is a toast.
 */
export const BackgroundAgent: Story = {
  args: { memory },
  loaders: seeded(typicalLayout, seedTypical),
  render: (_, { loaded }) => <CanvasStory memory={(loaded as Loaded).memory} />,
  play: async ({ loaded }) => {
    const live = (loaded as Loaded).memory;
    await wait(1200);
    await agentStagesTurn(live);
    await send(live.asAgent(turns.second), {
      operation: "thread_reply",
      thread_id: threadIds.chart,
      message: "Yes: on-hold projects keep their capacity until they are cancelled.",
    });
  },
};

/** Published data moves under staged values: a budget is changed and a project removed. */
export const ChangedBySomeoneElse: Story = {
  args: { memory },
  loaders: seeded(typicalLayout, seedTypical),
  render: (_, { loaded }) => <CanvasStory memory={(loaded as Loaded).memory} />,
  play: async ({ loaded }) => {
    const live = (loaded as Loaded).memory;
    await wait(1200);
    live.writeCanonical("m_project", projectId(2), { f_budget: money("70000") });
    live.removeRecord("m_project", projectId(5));
  },
};

/** The agent asks the person to Save: its reason on the Save bar, with Save and Not now. */
export const AgentAsksToSave: Story = {
  args: { memory },
  loaders: seeded(typicalLayout, async (live) => {
    await seedTypical(live);
    await send(live.asAgent(turns.second), {
      operation: "save_request",
      thread_id: "save-request-1",
      reason: "The Q4 budgets and statuses are staged and ready for review",
    });
  }),
  render: (_, { loaded }) => <CanvasStory memory={(loaded as Loaded).memory} />,
};

/** The session changed after the agent asked: the Save bar says so. */
export const ChangedSinceTheAgentAsked: Story = {
  args: { memory },
  loaders: seeded(typicalLayout, async (live) => {
    await seedTypical(live);
    await send(live.asAgent(turns.second), {
      operation: "save_request",
      thread_id: "save-request-1",
      reason: "Ready to Save",
    });
    await agentStagesTurn(live);
  }),
  render: (_, { loaded }) => <CanvasStory memory={(loaded as Loaded).memory} />,
};
