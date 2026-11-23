import type { Meta, StoryObj } from "@storybook/react-vite";

import { MessageThread } from "./Message";
import { conversation, tickerRunning, tickerSettled, toolRunning } from "./fixtures";
import type { ChatMessageView } from "./types";

const meta = {
  title: "Agent Chat / Message",
  component: MessageThread,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div
        style={{
          minHeight: "100vh",
          background: "var(--color-bg-page)",
          fontFamily: "var(--font-sans)",
          display: "flex",
          justifyContent: "center",
          padding: "var(--space-6)",
        }}
      >
        <div style={{ width: "100%", maxWidth: "640px" }}>
          <Story />
        </div>
      </div>
    ),
  ],
} satisfies Meta<typeof MessageThread>;

export default meta;
type Story = StoryObj<typeof meta>;

// A user turn + an agent turn that interleaves prose with tool calls — the
// tool-call-nested-in-assistant-message pattern.
export const Conversation: Story = {
  args: { messages: conversation },
};

const singleUser: readonly ChatMessageView[] = [
  {
    id: "u1",
    role: "human",
    parts: [{ kind: "text", text: "Which roles are below the market midpoint?" }],
  },
];

export const UserOnly: Story = {
  args: { messages: singleUser },
};

const running: readonly ChatMessageView[] = [
  {
    id: "u1",
    role: "human",
    parts: [{ kind: "text", text: "Give Engineering a 4% bump." }],
  },
  {
    id: "a1",
    role: "agent",
    parts: [
      { kind: "text", text: "Checking which roles are in scope…" },
      { kind: "tool", tool: toolRunning },
    ],
  },
];

export const AgentWorking: Story = {
  args: { messages: running, isRunning: true },
};

// A turn is in flight and the agent has produced nothing yet — the thread
// shows the thinking indicator (staggered dots) beneath the human turn.
const awaitingAgent: readonly ChatMessageView[] = [
  {
    id: "u1",
    role: "human",
    parts: [{ kind: "text", text: "Give Engineering a 4% bump." }],
  },
];

export const Thinking: Story = {
  args: { messages: awaitingAgent, isRunning: true },
};

// Duplicate-avatar guard (bug fix): an EMPTY agent shell exists (stream started,
// no first token yet) WHILE running. The ThinkingIndicator owns this state, so
// the empty shell renders NOTHING — exactly ONE sparkle in the tree, not two
// stacked. This story is the visual proof that the second sparkle is gone.
const emptyShellRunning: readonly ChatMessageView[] = [
  {
    id: "u1",
    role: "human",
    parts: [{ kind: "text", text: "Give Engineering a 4% bump." }],
  },
  { id: "a1", role: "agent", parts: [{ kind: "text", text: "" }] },
];

export const EmptyShellSingleAvatar: Story = {
  args: { messages: emptyShellRunning, isRunning: true },
};

// The assistant is streaming its reply. With `isRunning`, the last agent turn's
// text part is `running`, so SmoothText eases it in character-wise (the capture
// lands mid- or end-reveal depending on timing). Static history above still
// renders instantly.
const streaming: readonly ChatMessageView[] = [
  {
    id: "u1",
    role: "human",
    parts: [{ kind: "text", text: "Which roles are below the market midpoint?" }],
  },
  {
    id: "a1",
    role: "agent",
    parts: [
      {
        kind: "text",
        text: "Three roles sit below the midpoint: Eng Mgr, Staff SWE, and PM II. I can draft a bump to bring them to the midpoint if you'd like.",
      },
    ],
  },
];

export const StreamingText: Story = {
  args: { messages: streaming, isRunning: true },
};

// Transcript fold-in (§3): a SETTLED agent turn renders prose only — the tool
// rows live in the ticker's disclosure ("Worked for 14s · N steps"), not inline.
const settledWithTicker: readonly ChatMessageView[] = [
  {
    id: "u1",
    role: "human",
    parts: [{ kind: "text", text: "Give the three Engineering roles a 4% bump." }],
  },
  {
    id: "a1",
    role: "agent",
    parts: [
      {
        kind: "text",
        text: "Done — I drafted a 4% base-pay bump for Eng Mgr, Staff SWE, and PM II. Review the card below, then Save to apply.",
      },
    ],
    ticker: tickerSettled,
  },
];

export const SettledFoldIn: Story = {
  args: { messages: settledWithTicker },
};

// A live turn: the running ticker narrates progress inside the agent bubble
// (the thinking indicator retires once the ticker exists).
const runningWithTicker: readonly ChatMessageView[] = [
  {
    id: "u1",
    role: "human",
    parts: [{ kind: "text", text: "Give Engineering a 4% bump." }],
  },
  {
    id: "a1",
    role: "agent",
    parts: [{ kind: "text", text: "" }],
    ticker: tickerRunning,
  },
];

export const RunningTicker: Story = {
  args: { messages: runningWithTicker, isRunning: true },
};

// A cancel notice (§4): the quiet, card-less "Stopped." caption.
const stopped: readonly ChatMessageView[] = [
  {
    id: "u1",
    role: "human",
    parts: [{ kind: "text", text: "Give Engineering a 4% bump." }],
  },
  {
    id: "n1",
    role: "agent",
    variant: "notice",
    parts: [{ kind: "text", text: "Stopped." }],
  },
];

export const StoppedNotice: Story = {
  args: { messages: stopped },
};
