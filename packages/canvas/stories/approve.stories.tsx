// Review mode over the in-memory drafts client: the bell and Work/Review
// toggle, pending drafts as cards (two changing the same budget), a card's
// thread with a reply box, the Discard dialog, the Rejected tab, a member's
// read-only review, the published changelog, and the author's Comments pane
// with threads on drafts this session saved.
import type { Meta, StoryObj } from "@storybook/react-vite";

import { bootstrapAgGrid } from "../../modules/editable-grid";
import { Canvas } from "../canvas";
import type { MemoryCanvas } from "../memory-client";
import {
  approveMemory,
  authors,
  seedDrafts,
  seedPublished,
  seedRejected,
} from "./fixtures/approve";
import { seedTypical, send, sessionId, unitIds } from "./fixtures/canvas";
import { projectId } from "./fixtures/grid";

bootstrapAgGrid({ allowMissingLicense: true });

function ApproveStory({ memory }: { memory: MemoryCanvas }) {
  return (
    <div className="flex h-screen w-full overflow-hidden">
      <Canvas client={memory.client} sessionId={sessionId} />
    </div>
  );
}

type Loaded = { memory: MemoryCanvas };
const seeded = (setup: (memory: MemoryCanvas) => Promise<unknown>, canApprove = true) => [
  async (): Promise<Loaded> => {
    const memory = approveMemory(canApprove);
    await seedTypical(memory);
    await setup(memory);
    return { memory };
  },
];

/** Waits for `selector` (panes and dialogs render on the body) and clicks it. */
async function click(selector: string, text?: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const target = [...document.querySelectorAll<HTMLElement>(selector)].find(
      (item) => text === undefined || item.textContent?.trim().startsWith(text),
    );
    if (target !== undefined) {
      target.click();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`story: ${selector} never rendered`);
}

const meta = {
  title: "Canvas/Review mode",
  component: ApproveStory,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ApproveStory>;
export default meta;
type Story = StoryObj<typeof meta>;
const memory = approveMemory();
const render: Story["render"] = (_, { loaded }) => (
  <ApproveStory memory={(loaded as Loaded).memory} />
);

/** Work mode for an approver: Review counts three pending drafts on this session's models. */
export const WorkWithReviewCount: Story = {
  args: { memory },
  loaders: seeded(async (live) => seedDrafts(live)),
  render,
};

/**
 * Review mode for an approver: each pending draft is its own card with its author and time.
 * Ravi's and Mei's drafts both change Atlas's budget; Ravi's carries a thread.
 */
export const PendingDrafts: Story = {
  args: { memory },
  loaders: seeded(async (live) => seedDrafts(live)),
  render,
  play: async () => click("[data-segmented-option='review']"),
};

/** Discard asks first and takes an optional note for the author. */
export const DiscardDialog: Story = {
  args: { memory },
  loaders: seeded(async (live) => seedDrafts(live)),
  render,
  play: async () => {
    await click("[data-segmented-option='review']");
    await click("[data-card] button", "Discard");
  },
};

/** The Rejected tab: a discarded draft, read-only, with its rejection note. */
export const RejectedTab: Story = {
  args: { memory },
  loaders: seeded(async (live) => {
    seedDrafts(live);
    await seedRejected(live);
  }),
  render,
  play: async () => {
    await click("[data-segmented-option='review']");
    await click("[role='radio']", "Rejected");
  },
};

/**
 * Review mode for a member who does not approve (Hana): the same cards,
 * authors and threads, with reply boxes but no Publish, Discard or Revert.
 * Hana resolves the thread on her own draft; Ravi's has no Resolve for her.
 */
export const MemberReview: Story = {
  args: { memory },
  loaders: seeded(async (live) => {
    seedDrafts(live);
    live.seedDraft({
      actorId: authors.hana,
      sessionId: "s-hana",
      changes: [
        {
          model_id: "m_project",
          record_id: projectId(5),
          field_id: "f_status",
          value: { type: "enum", value: "on_hold" },
        },
      ],
      threads: [
        {
          id: "e0000000-0000-4000-8000-000000000002",
          anchor: { unit_id: unitIds.grid, model_id: "m_project", record_id: projectId(5) },
          messages: [{ actor_id: authors.ravi, message: "Why on hold? The client is waiting." }],
        },
      ],
    });
  }, false),
  render,
  play: async () => click("[data-segmented-option='review']"),
};

/**
 * The workspace's published changes in Review, with Revert for an approver.
 */
export const PublishedChangelog: Story = {
  args: { memory },
  loaders: seeded(async (live) => {
    await seedPublished(live);
  }),
  render,
  play: async () => {
    await click("[role='radio']", "Review");
    await click("[role='radio']", "Published");
  },
};

/**
 * The author's Comments pane: this session saved a draft that carried a
 * thread, and a reviewer replied on it.
 */
export const AuthorComments: Story = {
  args: { memory },
  loaders: seeded(async (live) => {
    const threadId = "f0000000-0000-4000-8000-000000000001";
    await send(live.client.session, {
      operation: "thread_open",
      thread_id: threadId,
      anchor: {
        unit_id: unitIds.grid,
        model_id: "m_project",
        record_id: projectId(4),
        field_id: "f_status",
      },
    });
    await send(live.client.session, {
      operation: "thread_reply",
      thread_id: threadId,
      message: "Marking this done; the client signed off on Friday.",
    });
    const header = await live.client.session.request({
      operation: "get",
      session_id: sessionId,
      overlay: false,
    });
    await live.client.session.request({
      operation: "save",
      session_id: sessionId,
      expected_revision: header.revision,
      request_id: crypto.randomUUID(),
    });
    const [saved] = await live.client.drafts!.threads.forSession(sessionId);
    await live.client.drafts!.threads.reply(
      saved!.change_set_id,
      threadId,
      "Can you attach the sign-off before I publish?",
    );
  }, false),
  render,
  play: async () => click("[data-pane-button='comments']"),
};
