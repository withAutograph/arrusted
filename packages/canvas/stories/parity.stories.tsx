// The canvas's newer parts over the in-memory client: the sessions menu and
// editable as-of date in the top bar, an agent's rule
// replacing your edit (Restore yours), a note, key figures and a range chart
// with money in its currency and period, and the warning before saving
// changes the canvas does not show.
import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { bootstrapAgGrid } from "../../modules/editable-grid";
import { Canvas } from "../canvas";
import type { CanvasLayout } from "@autograph/work-session-tools/layout";
import type { MemoryCanvas } from "../memory-client";
import {
  agentReplacesYourEdit,
  memberId,
  noTableLayout,
  parityLayout,
  parityMemory,
  paritySession,
} from "./fixtures/parity";

bootstrapAgGrid();

/** The canvas; the sessions menu's Open switches it to that session. */
function ParityStory({ memory }: { memory: MemoryCanvas }) {
  const [sessionId, setSessionId] = useState(paritySession);
  const client =
    memory.client.sessions === undefined
      ? memory.client
      : { ...memory.client, sessions: { ...memory.client.sessions, open: setSessionId } };
  return (
    <div className="flex h-screen w-full overflow-hidden">
      <Canvas client={client} sessionId={sessionId} />
    </div>
  );
}

type Loaded = { memory: MemoryCanvas };
const seeded = (
  layout: CanvasLayout = parityLayout,
  setup: (memory: MemoryCanvas) => Promise<unknown> = async () => {},
) => [
  async (): Promise<Loaded> => {
    const memory = await parityMemory(layout);
    await setup(memory);
    return { memory };
  },
];

/** Waits for `selector` under `root` (popovers render on the body) and clicks it. */
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
  title: "Canvas/Parity",
  component: ParityStory,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ParityStory>;
export default meta;
type Story = StoryObj<typeof meta>;
const render: Story["render"] = (_, { loaded }) => (
  <ParityStory memory={(loaded as Loaded).memory} />
);
const placeholder = { memory: undefined as unknown as MemoryCanvas };

/** Key figures, the team's table, a range chart of base pay by level, and a note. */
export const NoteFiguresAndRange: Story = { args: placeholder, loaders: seeded(), render };

/** The sessions menu on the title: search, pinned first, New session, and each session's actions. */
export const SessionsMenu: Story = {
  args: placeholder,
  loaders: seeded(),
  render,
  play: async () => {
    await click(document, "[data-sessions-menu]");
    await click(document, "[data-session-row] button[aria-label^='Actions for']");
  },
};

/** The as-of date opens a calendar. */
export const AsOf: Story = {
  args: placeholder,
  loaders: seeded(),
  render,
  play: async () => click(document, "[data-as-of] button"),
};

/** The agent's rule replaced your edit of Kenji's pay: the cell says so and offers Restore yours. */
export const AgentReplacedYourEdit: Story = {
  args: placeholder,
  loaders: seeded(parityLayout, agentReplacesYourEdit),
  render,
};

/** The same, in the record drawer and the Staged changes pane (with the rule's note). */
export const AgentReplacedInPanels: Story = {
  args: placeholder,
  loaders: seeded(parityLayout, agentReplacesYourEdit),
  render,
  play: async ({ canvasElement }) => {
    await click(canvasElement, `[row-id="${memberId(4)}"] [col-id="f_name"]`);
    await click(document, "[data-pane-button='staged']");
  },
};

/** Save with staged changes no table shows: the staged list opens first, saying how many. */
export const HiddenChangesWarning: Story = {
  args: placeholder,
  loaders: seeded(noTableLayout, agentReplacesYourEdit),
  render,
  play: async () => click(document, "[data-save-button]"),
};

/** Add unit: tables, the five chart kinds, graphs, key figures and notes. */
export const AddUnitKinds: Story = {
  args: placeholder,
  loaders: seeded(),
  render,
  play: async () => {
    const byText = (selector: string, text: string) =>
      [...document.querySelectorAll<HTMLElement>(selector)].find(
        (element) => element.textContent?.trim() === text,
      );
    byText("header button", "Add unit")?.click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    byText("form[aria-label='Add a unit'] [role='radio']", "Chart")?.click();
  },
};
