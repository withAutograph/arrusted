// AgentChatPanel — the assembled live surface, in its four load-bearing
// states: empty, mid-turn (tool-calls streaming), draft-ready (stage card),
// and clarification. Presentational props stand in for the session hook so the
// panel can be proven in isolation against the playground bar.

import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { AgentChatPanel } from "./AgentChatPanel";
import type { ChatMessageView, ClarificationView, StageProposalView } from "./types";
import { anchor, conversation, proposal, toolRunning } from "./fixtures";

const meta = {
  title: "Agent Chat / Panel",
  component: AgentChatPanel,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div
        style={{
          minHeight: "100vh",
          background: "var(--color-bg-page)",
          fontFamily: "var(--font-sans)",
          display: "flex",
          justifyContent: "flex-end",
        }}
      >
        <div style={{ width: "400px", height: "760px" }}>
          <Story />
        </div>
      </div>
    ),
  ],
} satisfies Meta<typeof AgentChatPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

const baseProps = {
  anchor,
  isRunning: false,
  proposal: null,
  clarification: null,
  continuation: null,
  staging: false,
  error: null,
  onSend: () => {},
  onStop: () => {},
  onStage: () => {},
  onDiscard: () => {},
  onAnswerClarification: () => {},
  onContinueRun: () => {},
  onClose: () => {},
} as const;

export const Empty: Story = {
  args: { ...baseProps, messages: [] },
};

// The grounding anchor now lives in the composer dock (above the input), and
// the header carries only the "Agent" title + close. This narrow-bound story
// proves the dock chip + composer don't wrap/clip at 380px (Hari).
export const Narrow: Story = {
  args: { ...baseProps, messages: conversation },
  decorators: [
    (Story) => (
      <div
        style={{
          minHeight: "100vh",
          background: "var(--color-bg-page)",
          fontFamily: "var(--font-sans)",
          display: "flex",
          justifyContent: "flex-end",
        }}
      >
        <div style={{ width: "380px", height: "760px" }}>
          <Story />
        </div>
      </div>
    ),
  ],
};

// Mid-turn: the human asked, the agent has queried and is drafting — a
// running tool-call sits in the live assistant turn.
const midTurn: readonly ChatMessageView[] = [
  {
    id: "m1",
    role: "human",
    parts: [
      {
        kind: "text",
        text: "Give the three selected Engineering roles a 4% base-pay bump.",
      },
    ],
  },
  {
    id: "m2",
    role: "agent",
    parts: [
      { kind: "text", text: "Confirming which roles are in scope…" },
      {
        kind: "tool",
        tool: { ...toolRunning, title: "Drafting changes", detail: undefined },
      },
    ],
  },
];

export const MidTurn: Story = {
  args: { ...baseProps, messages: midTurn, isRunning: true },
};

const draftProposal: StageProposalView = proposal;

export const DraftReady: Story = {
  args: {
    ...baseProps,
    messages: conversation,
    proposal: { preview: draftProposal, staged: false },
  },
  render: (args) => {
    const [staged, setStaged] = useState(false);
    return (
      <AgentChatPanel
        {...args}
        proposal={{ preview: draftProposal, staged }}
        onStage={() => setStaged(true)}
        onDiscard={() => setStaged(false)}
      />
    );
  },
};

const clarification: ClarificationView = {
  headline: "Which roles should the 4% bump apply to?",
  reasoning:
    "Your selection has three Engineering roles, but two are contractors. Confirm the scope before I draft.",
  choices: [
    { id: "all", label: "All three selected", intent: "primary" },
    { id: "fte", label: "Full-time employees only", intent: "default" },
  ],
  canAskFollowUp: true,
};

export const Clarification: Story = {
  args: {
    ...baseProps,
    messages: [
      {
        id: "m1",
        role: "human",
        parts: [{ kind: "text", text: "Bump the selected Engineering roles 4%." }],
      },
      {
        id: "m2",
        role: "agent",
        parts: [{ kind: "text", text: "One quick check before I draft this." }],
      },
    ],
    clarification,
  },
};

// Stage conflict: the draft overlaps rows that already carry pending changes.
// The panel blocks staging and offers an informed "Replace…" override via the
// generic `errorAction` (the app supplies the label + handler).
export const StageConflict: Story = {
  args: {
    ...baseProps,
    messages: conversation,
    proposal: { preview: draftProposal, staged: false },
    error:
      "Some of these rows already have pending changes from an earlier suggestion. This replaces them on 2 rows.",
    errorAction: { label: "Replace on those rows", onAction: () => {} },
  },
};
