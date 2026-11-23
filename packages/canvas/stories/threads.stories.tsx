import { useRef, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import type { CanvasClient } from "../client";
import { ThreadPopover } from "../thread-popover";
import { useCanvasSession } from "../use-canvas-session";
import {
  act,
  dayRate,
  definition,
  ids,
  recordName,
  useSeededCanvas,
  type StoryCanvas,
} from "./fixtures/threads-rules";

const THREAD = "d0000000-0000-4000-8000-000000000001";
const units: Record<string, string> = { "unit-people": "People", "unit-projects": "Projects" };

type Seed = { agentMessages: Set<string> };
type Setup = (canvas: StoryCanvas) => Promise<Seed>;

/** Opens the story's thread and plays its conversation. */
async function conversation(
  canvas: StoryCanvas,
  anchor: Record<string, string>,
  lines: [who: "you" | "agent", text: string][],
) {
  await act(canvas, { operation: "thread_open", thread_id: THREAD, anchor });
  const agentMessages = new Set<string>();
  for (const [who, message] of lines) {
    const result = await act(
      canvas,
      { operation: "thread_reply", thread_id: THREAD, message },
      who === "agent" ? ids.turn : undefined,
    );
    if (who === "agent") agentMessages.add((result.message as { id: string }).id);
  }
  return { agentMessages };
}
const cell = (record_id: string, field_id: string, model_id = "m_person") => ({
  unit_id: model_id === "m_person" ? "unit-people" : "unit-projects",
  model_id,
  record_id,
  field_id,
});
const proposeRates = (canvas: StoryCanvas, amounts: [string, string][]) =>
  act(
    canvas,
    {
      operation: "propose",
      thread_id: THREAD,
      changes: amounts.map(([record_id, amount]) => ({
        model_id: "m_person",
        record_id,
        field_id: "f_day_rate",
        value: dayRate(amount),
      })),
    },
    ids.turn,
  );

function ThreadStory({
  setup,
  wrap,
}: {
  setup: Setup;
  wrap?: (client: CanvasClient, canvas: StoryCanvas) => CanvasClient;
}) {
  const { canvas, seed, ready } = useSeededCanvas(setup);
  const [client] = useState(() => wrap?.(canvas.client, canvas) ?? canvas.client);
  const session = useCanvasSession(client, ids.session);
  const [open, setOpen] = useState(true);
  /** Stands in for the cell or unit the thread is pinned to. */
  const anchor = useRef<HTMLButtonElement | null>(null);
  const thread = session.threads.find((item) => item.id === THREAD) ?? null;
  if (!ready || seed === undefined) return null;
  return (
    <div className="min-h-screen bg-[var(--color-bg-page)] p-[var(--space-6)] font-[var(--font-sans)]">
      <button
        className="rounded-[var(--radius-control)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-[var(--space-3)] py-[var(--space-1-5)] text-[length:var(--text-control-sm)] text-[var(--color-text-primary)]"
        ref={anchor}
        type="button"
        onClick={() => setOpen(true)}
      >
        The pinned cell
      </button>
      <ThreadPopover
        anchorRef={anchor}
        definition={definition}
        recordName={recordName}
        session={session}
        thread={open ? thread : null}
        unitTitle={(id) => units[id]}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}

const meta = {
  title: "Canvas/Threads",
  component: ThreadStory,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ThreadStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const WithMessages: Story = {
  args: {
    setup: (canvas) =>
      conversation(canvas, cell(ids.chen, "f_day_rate"), [
        [
          "you",
          "Chen's rate looks high against the rest of engineering. Is that from the new contract?",
        ],
        [
          "agent",
          "Yes. Chen moved to the senior band on 1 September, which set the day rate to £845.",
        ],
        ["you", "Thanks. Leave it as it is for now."],
      ]),
  },
};

/** A long agent reply scrolls inside the popover, which stays small. */
export const LongReply: Story = {
  args: {
    setup: (canvas) =>
      conversation(canvas, cell(ids.chen, "f_day_rate"), [
        ["you", "Why is Chen's rate higher than the rest of engineering?"],
        [
          "agent",
          [
            "Chen moved to the senior band on 1 September, which set the day rate to £845.",
            "The senior band starts at £820 and tops out at £900; Chen's contract places him one step above the bottom because of the platform lead role he took on in the summer.",
            "The rest of engineering is still on the standard band, between £640 and £780, so Chen sits £65 above the highest of them.",
            "Two other engineers, Amara and Dara, are due for their band review in December. If they move up too, the gap closes to within the band's normal spread.",
            "Nothing in the staged changes touches Chen's rate, so Save leaves it as it is.",
          ].join("\n\n"),
        ],
        ["you", "Thanks, that makes sense."],
      ]),
  },
};

export const PendingProposal: Story = {
  args: {
    setup: async (canvas) => {
      const seed = await conversation(canvas, { unit_id: "unit-people" }, [
        ["you", "Bring every engineer up to at least £800 a day."],
        [
          "agent",
          "Amara is the only engineer under £800. I've also proposed Dara, who moves to engineering next month.",
        ],
      ]);
      await proposeRates(canvas, [
        [ids.amara, "800"],
        [ids.dara, "800"],
      ]);
      return seed;
    },
  },
};

export const ProposalChanged: Story = {
  args: {
    setup: async (canvas) => {
      const seed = await conversation(canvas, { unit_id: "unit-people" }, [
        ["you", "Bring every engineer up to at least £800 a day."],
        ["agent", "Proposed Amara at £800."],
      ]);
      await proposeRates(canvas, [[ids.amara, "800"]]);
      return seed;
    },
    // The agent replaces its proposal just before the user's Pull lands.
    wrap: (client, canvas) => ({
      ...client,
      session: {
        request: async (input) => {
          if (input.operation === "pull") {
            await proposeRates(canvas, [
              [ids.amara, "820"],
              [ids.dara, "800"],
            ]);
          }
          return client.session.request(input);
        },
      },
    }),
  },
};

export const Resolved: Story = {
  args: {
    setup: async (canvas) => {
      const seed = await conversation(canvas, cell(ids.beacon, "f_status", "m_project"), [
        ["you", "Why is Beacon at risk?"],
        [
          "agent",
          "Its budget is £320,000, above the £300,000 line in your rule for large projects.",
        ],
        ["you", "Makes sense, closing this."],
      ]);
      await act(canvas, { operation: "thread_resolve", thread_id: THREAD });
      return seed;
    },
  },
};

export const Empty: Story = {
  args: {
    setup: async (canvas) => conversation(canvas, cell(ids.atlas, "f_budget", "m_project"), []),
  },
};
