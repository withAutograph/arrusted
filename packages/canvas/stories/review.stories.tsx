// The review surface: staged-change log with provenance on hover, the Save
// bar and the impact strip, over the in-memory canvas client.
import { useMemo } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { ToastProvider } from "../../design-systems/core/components";

import type { CanvasClient } from "../client";
import { ImpactStrip } from "../impact-strip";
import type { MemoryCanvas } from "../memory-client";
import { SaveBar } from "../save-bar";
import { StagedLog } from "../staged-log";
import { useCanvasSession } from "../use-canvas-session";
import {
  budget,
  ids,
  project,
  projectBudgets,
  pullProposal,
  reviewMemory,
  sessionId,
  stage,
  turns,
  twoTurnsAndEdits,
  values,
} from "./fixtures/review";

function Review(props: { client: CanvasClient; showLog: boolean }) {
  const session = useCanvasSession(props.client, sessionId);
  if (session.status !== "ready")
    return (
      <p className="p-[var(--space-6)] text-[length:var(--text-body)] text-[var(--color-text-muted)]">
        {session.status === "error" ? String(session.error) : "Loading…"}
      </p>
    );
  return (
    <div className="flex min-h-screen flex-col gap-[var(--space-4)] bg-[var(--color-bg-page)] p-[var(--space-6)]">
      <div className="flex flex-wrap items-center justify-between gap-[var(--space-4)] rounded-[var(--radius-panel)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-[var(--space-4)] py-[var(--space-2-5)]">
        <div className="min-w-[var(--space-0)] flex-1">
          <ImpactStrip client={props.client} session={session} />
        </div>
        <SaveBar client={props.client} session={session} />
      </div>
      {props.showLog ? (
        <div className="w-[412px] max-w-full rounded-[var(--radius-panel)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] shadow-[var(--shadow-raised)]">
          <StagedLog client={props.client} session={session} />
        </div>
      ) : null}
    </div>
  );
}

function ReviewStory(props: { memory: MemoryCanvas; client?: CanvasClient; showLog?: boolean }) {
  return (
    <ToastProvider>
      <Review client={props.client ?? props.memory.client} showLog={props.showLog ?? true} />
    </ToastProvider>
  );
}

/** Clicks the first enabled button matching `selector` once it renders. */
async function click(root: HTMLElement, selector: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const button = root.querySelector<HTMLButtonElement>(selector);
    if (button !== null && !button.disabled) {
      button.click();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const meta = {
  title: "Canvas/Review",
  component: ReviewStory,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ReviewStory>;
export default meta;
type Story = StoryObj<typeof meta>;

const seeded = (setup: (memory: MemoryCanvas) => Promise<void>) => [
  async () => {
    const memory = reviewMemory();
    await setup(memory);
    return { memory };
  },
];
type Loaded = { memory: MemoryCanvas };

/** Nothing staged: the log says so and Save is off. */
export const EmptySession: Story = {
  args: { memory: reviewMemory() },
  loaders: seeded(async () => {}),
  render: (_, { loaded }) => <ReviewStory memory={(loaded as Loaded).memory} />,
};

/** A few of the user's own edits. */
export const HumanEdits: Story = {
  args: { memory: reviewMemory() },
  loaders: seeded(async (memory) => {
    await stage(memory, [
      project("Atlas migration", "f_budget", budget("440000")),
      project("Customer portal", "f_headcount", values.num("6")),
      project("Support tooling", "f_status", values.status("on_track")),
      project("Partner API", "f_lead", values.person(ids.person("Aiko Tanaka"))),
    ]);
  }),
  render: (_, { loaded }) => <ReviewStory memory={(loaded as Loaded).memory} />,
};

/** Two agent turns by time, then the user's edits and a change pulled from a thread. */
export const AgentTurnsAndEdits: Story = {
  args: { memory: reviewMemory() },
  loaders: seeded(async (memory) => {
    await twoTurnsAndEdits(memory);
    await pullProposal(memory, "Can the portal take one more engineer this quarter?", [
      project("Customer portal", "f_headcount", values.num("6")),
    ]);
  }),
  render: (_, { loaded }) => <ReviewStory memory={(loaded as Loaded).memory} />,
};

/** Dozens of entries: the log scrolls inside itself, group headers stay in view. */
export const ManyEntries: Story = {
  args: { memory: reviewMemory() },
  loaders: seeded(async (memory) => {
    await stage(
      memory,
      projectBudgets.map(({ name, amount, currency }) =>
        project(name, "f_budget", budget(String(Math.round(Number(amount) * 1.04)), currency)),
      ),
      turns.first,
    );
    await stage(
      memory,
      projectBudgets.map(({ name }, n) =>
        project(name, "f_headcount", values.num(String(3 + (n % 4)))),
      ),
      turns.second,
    );
    await stage(
      memory,
      projectBudgets
        .slice(0, 6)
        .map(({ name }) => project(name, "f_status", values.status("on_track"))),
    );
  }),
  render: (_, { loaded }) => <ReviewStory memory={(loaded as Loaded).memory} />,
};

const staleAndGone = seeded(async (memory) => {
  await twoTurnsAndEdits(memory);
  // Published changes after staging: one record changed, one removed.
  memory.writeCanonical("m_project", ids.project("Mobile checkout"), {
    f_budget: budget("355000"),
  });
  memory.removeRecord("m_project", ids.project("Field app"));
});

/** Stale and gone entries are marked in the log; Save lists them for confirmation. */
export const StaleAndGoneSaveConfirmation: Story = {
  args: { memory: reviewMemory() },
  loaders: staleAndGone,
  render: (_, { loaded }) => <ReviewStory memory={(loaded as Loaded).memory} />,
  play: async ({ canvasElement }) => click(canvasElement, "[data-save-button]"),
};

/** Stale and gone entries in the log, before Save. */
export const StaleAndGone: Story = {
  args: { memory: reviewMemory() },
  loaders: staleAndGone,
  render: (_, { loaded }) => <ReviewStory memory={(loaded as Loaded).memory} />,
};

/** Reverting an agent turn asks first, and says what it does not bring back. */
export const TurnRevertConfirmation: Story = {
  args: { memory: reviewMemory() },
  loaders: seeded(twoTurnsAndEdits),
  render: (_, { loaded }) => <ReviewStory memory={(loaded as Loaded).memory} />,
  play: async ({ canvasElement }) => click(canvasElement, "[data-staged-group='agent'] button"),
};

/** Discarding all of the agent's changes asks first too. */
export const DiscardAgentConfirmation: Story = {
  args: { memory: reviewMemory() },
  loaders: seeded(twoTurnsAndEdits),
  render: (_, { loaded }) => <ReviewStory memory={(loaded as Loaded).memory} />,
  play: async ({ canvasElement }) =>
    click(canvasElement, "[data-staged-log] > div:last-of-type button"),
};

/** The impact strip with budgets in two currencies changed. */
export const ImpactTwoCurrencies: Story = {
  args: { memory: reviewMemory() },
  loaders: seeded(twoTurnsAndEdits),
  render: (_, { loaded }) => <ReviewStory memory={(loaded as Loaded).memory} showLog={false} />,
};

function UnansweredSave({ memory }: { memory: MemoryCanvas }) {
  const client = useMemo<CanvasClient>(
    () => ({
      ...memory.client,
      session: {
        request: (input) =>
          input.operation === "save"
            ? Promise.reject(new TypeError("Failed to fetch"))
            : memory.client.session.request(input),
      },
    }),
    [memory],
  );
  return <ReviewStory client={client} memory={memory} />;
}

/** A Save whose answer never arrives: the outcome-unknown toast, nothing re-applied. */
export const SaveOutcomeUnknown: Story = {
  args: { memory: reviewMemory() },
  loaders: seeded(async (memory) => {
    await stage(memory, [project("Atlas migration", "f_budget", budget("440000"))]);
  }),
  render: (_, { loaded }) => <UnansweredSave memory={(loaded as Loaded).memory} />,
  play: async ({ canvasElement }) => click(canvasElement, "[data-save-button]"),
};
