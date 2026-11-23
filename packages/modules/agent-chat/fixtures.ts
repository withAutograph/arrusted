// Shared story fixtures for the agent-chat leaves. Domain-flavored (HC
// positions) so the humanized tool/stage copy reads like the real surface,
// but the module itself stays app-agnostic — these live only in stories.

import type {
  ChatAnchorView,
  ChatMessageView,
  StageProposalView,
  TickerState,
  TickerStep,
  ToolCallView,
} from "./types";

export const anchor: ChatAnchorView = {
  surface: "Positions grid",
  scope: "3 rows selected",
};

export const toolRunning: ToolCallView = {
  id: "t-run",
  title: "Searching positions",
  detail: "dept = Engineering",
  status: "running",
};

export const toolDone: ToolCallView = {
  id: "t-done",
  title: "Searched positions",
  detail: "dept = Engineering",
  outcome: "3 found",
  status: "done",
};

export const toolEmpty: ToolCallView = {
  id: "t-empty",
  title: "Searched positions",
  detail: "level = Director",
  outcome: "nothing found",
  status: "done",
};

export const toolError: ToolCallView = {
  id: "t-err",
  title: "Couldn't find that field",
  detail: "field = tenure_band",
  outcome: "not a known field",
  status: "error",
};

export const proposal: StageProposalView = {
  headline: "base pay +4%",
  changeCount: 3,
  targets: ["Eng Mgr", "Staff SWE", "PM II"],
};

// --- Status ticker fixtures (§3) --------------------------------------------

// A full accumulated step list: phases + tool calls + a repair attempt, in the
// order they arrived across the turn (including the repair pass).
export const tickerSteps: readonly TickerStep[] = [
  { kind: "phase", id: "p-search", label: "Searching positions…" },
  {
    kind: "tool",
    id: "s-lookup",
    tool: {
      id: "s-lookup",
      title: "Searched positions",
      detail: "dept = Engineering",
      outcome: "3 found",
      status: "done",
    },
  },
  { kind: "phase", id: "p-draft", label: "Drafting changes…" },
  {
    kind: "tool",
    id: "s-propose",
    tool: {
      id: "s-propose",
      title: "Drafted changes",
      detail: "+4%",
      outcome: "3 changes",
      status: "done",
    },
  },
  { kind: "phase", id: "p-check", label: "Checking 3 changes…" },
  // Repair attempts — ticker states, never visible turns (§3). Both humanized
  // forms appear: with an issue count ("Fixing 2 issues — attempt 2") and
  // without ("Fixing issues — attempt 3"), matching humanizePhase's outputs.
  { kind: "phase", id: "p-repair", label: "Fixing 2 issues — attempt 2", attempt: 2 },
  { kind: "phase", id: "p-repair-2", label: "Fixing issues — attempt 3", attempt: 3 },
  {
    kind: "tool",
    id: "s-recheck",
    tool: {
      id: "s-recheck",
      title: "Re-checked changes",
      outcome: "all good",
      status: "done",
    },
  },
];

// While running: the latest step is a live phase, shimmering when collapsed.
export const tickerRunning: TickerState = {
  running: true,
  steps: [
    { kind: "phase", id: "p-search", label: "Searching positions…" },
    {
      kind: "tool",
      id: "s-lookup",
      tool: {
        id: "s-lookup",
        title: "Searching positions",
        detail: "dept = Engineering",
        status: "running",
      },
    },
    { kind: "phase", id: "p-check", label: "Checking 3 changes…" },
  ],
};

export const tickerSettled: TickerState = {
  running: false,
  elapsedMs: 14_000,
  steps: tickerSteps,
};

export const conversation: readonly ChatMessageView[] = [
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
      {
        kind: "text",
        text: "Let me confirm which roles are in scope before drafting the change.",
      },
      { kind: "tool", tool: toolDone },
      {
        kind: "text",
        text: "Found Eng Mgr, Staff SWE, and PM II. Drafting a +4% base-pay bump for each.",
      },
      {
        kind: "tool",
        tool: {
          id: "t-propose",
          title: "Checked base-pay change",
          detail: "+4%",
          outcome: "looks good",
          status: "done",
        },
      },
    ],
  },
];
