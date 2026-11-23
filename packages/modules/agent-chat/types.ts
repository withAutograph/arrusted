// Presentational contracts for the agent-chat leaves.
//
// Boundary: this module is UI-only. It renders a conversation surface, a
// composer, tool-call rows, a stage-changes affordance, and a grounding chip.
// It does NOT know app domain semantics (proposal schemas, kernel verdicts,
// grid-buffer internals, orchestration policy). Everything comes in via props;
// the consuming app resolves domain meaning at the call site and hands this
// module already-humanized strings + typed structural shapes.
//
// The shapes below are deliberately structural (plain strings + enums), NOT
// re-exports of agent-foundation / contracts types, so a leaf can be rendered
// in isolation (Storybook) without a runtime, a client, or a backend.

/** Author of a turn. `agent` is the assistant; `human` is the operator. */
export type ChatRole = "human" | "agent";

/** Lifecycle of a single agent tool call, as the surface should present it. */
export type ToolCallStatus = "running" | "done" | "error";

/**
 * A tool call rendered in a DOMAIN-READABLE way. The app maps its raw
 * `{toolName, args, result}` onto this humanized shape at the call site — the
 * module never parses args or results itself (raw-JSON tool viewers are
 * rejected by the spec).
 */
export type ToolCallView = {
  /** Stable id for React keys / selection. */
  id: string;
  /**
   * Human label for what the tool did, e.g. "Queried Positions" or
   * "Staged base_salary change". Verb-first, sentence case.
   */
  title: string;
  /**
   * Optional qualifier line rendered muted after the title, e.g.
   * "dept = Engineering". Kept terse; this is the "how", not a JSON dump.
   */
  detail?: string;
  /**
   * Optional outcome fragment rendered emphasized, e.g. "3 matches" or
   * "no matches". For a `running` call this is omitted (the spinner speaks).
   */
  outcome?: string;
  status: ToolCallStatus;
};

/**
 * A single conversation part inside an agent turn. A turn can interleave prose
 * with tool calls — the spec's "tool-call-nested-in-assistant-message"
 * pattern. Human turns are text-only.
 */
export type MessagePartView =
  | {
      kind: "text";
      text: string;
      /**
       * DISPLAY-ONLY: rendered in the transcript but excluded from the history
       * serialization the backend replays (see `toHistory`). Used for the quiet
       * "Stopped." cancel notice and for the answer line of a settled
       * clarification (the question's `historyText` already carries the answer as
       * a compact marker, so the display answer part must not double it into
       * history). Absent ⇒ part is part of history.
       */
      displayOnly?: boolean;
      /**
       * HISTORY OVERRIDE: when present, `toHistory` serializes this part as
       * `historyText` instead of `text`. Used to settle an answered clarification
       * — the transcript shows the plain question (`text`) while history carries
       * a compact single-line marker ("Asked: <q> — user answered: <a>") so the
       * model can see it already asked AND what the user answered, without
       * re-asking. Absent ⇒ history uses `text`.
       */
      historyText?: string;
    }
  | { kind: "tool"; tool: ToolCallView };

/**
 * A single accumulated step in the status ticker (§3). The app maps its wire
 * events (phase / tool_start / tool_end) onto these PRE-HUMANIZED shapes — the
 * module renders labels + reuses `ToolCallRow` for tool steps, never parsing
 * raw args/results itself.
 */
export type TickerStep =
  | {
      kind: "phase";
      /** Stable key for React. */
      id: string;
      /**
       * The humanized phase line, e.g. "Searching positions…",
       * "Checking 12 changes…", or a repair attempt "Fixing 2 issues —
       * attempt 2". Rendered verbatim; the app owns the wording.
       */
      label: string;
      /** Repair attempt ordinal, when this phase is a repair pass. */
      attempt?: number;
    }
  | {
      kind: "tool";
      id: string;
      /** The humanized tool row, reused via `ToolCallRow` in the disclosure. */
      tool: ToolCallView;
    };

/**
 * The accumulated ticker for one agent turn (§3). Collapsed shows only the
 * latest state while `running`; after the turn settles it shows a quiet
 * "Worked for Xs · N steps". Both are expandable to the full `steps` list.
 */
export type TickerState = {
  /** The ordered accumulated steps (phases, tool calls, repair attempts). */
  steps: readonly TickerStep[];
  /** True while the turn is still in flight (drives the shimmer). */
  running: boolean;
  /**
   * Wall-clock the turn took, in ms. Present once settled; drives the
   * "Worked for Xs" summary. Omitted while running.
   */
  elapsedMs?: number;
};

/** One turn in the ephemeral conversation. */
export type ChatMessageView = {
  id: string;
  role: ChatRole;
  parts: readonly MessagePartView[];
  /**
   * The status ticker for an agent turn (§3). Its settled tool rows fold INTO
   * the ticker's disclosure instead of rendering inline, quieting the
   * transcript to prose + cards. Absent on human turns and on legacy agent
   * turns with no tracked steps.
   */
  ticker?: TickerState;
  /**
   * A quiet, card-less transcript notice rendered as a muted caption (§4): the
   * "Stopped." line after a cancel. Not an agent bubble — no avatar, no prose
   * styling.
   */
  variant?: "notice";
};

/**
 * A grounding anchor: what view the conversation is anchored to. Rendered as a
 * chip above the composer so the human always sees what the agent is grounded
 * in. Purely descriptive — the module does not resolve the selection.
 */
export type ChatAnchorView = {
  /** e.g. "Positions grid". */
  surface: string;
  /**
   * Optional scope qualifier, e.g. "3 rows selected" or "filtered to
   * Engineering". Omitted when the anchor is the whole surface.
   */
  scope?: string;
};

/**
 * A settled draft proposal awaiting the human's explicit STAGE decision.
 *
 * IMPORTANT semantics: staging commits the draft into the editable-grid
 * buffer (where human edits live) — it is NOT a kernel write. The canonical
 * write is still grid-Save. The affordance therefore says "Stage changes",
 * never "Save".
 */
export type StageProposalView = {
  /**
   * One-line headline the app pre-humanizes, e.g.
   * "base_salary +4%". The module renders it verbatim.
   */
  headline: string;
  /** How many cell changes this proposal stages. */
  changeCount: number;
  /**
   * The affected targets, pre-humanized by the app, e.g.
   * ["Eng Mgr", "Staff SWE", "PM II"]. Rendered as a terse inline list.
   * The app is responsible for keeping this to a sane length; the leaf caps
   * how many it renders (with a "+N more" overflow) so an unbounded proposal
   * cannot blow out the panel.
   */
  targets: readonly string[];
  /**
   * The TRUE number of affected targets when `targets` was capped by the app.
   * The leaf's "+N more" overflow counts against this, not `targets.length` —
   * otherwise a 50-row proposal capped to 12 targets reads as "+6 more".
   * Omitted ⇒ `targets` is complete.
   */
  targetCount?: number;
  /**
   * The kernel dry-run verdict, pre-humanized by the app into a single terse
   * line (spec §4: the surface must show the kernel verdict, not just counts),
   * e.g. "Kernel validated · 3 records". Omitted when no verdict is available.
   */
  verdict?: string;
  /**
   * PARTIAL-ADD variant (§6): present only when the agent exhausted repair with
   * a partially-valid set. The proposal's `draft` carries the passing subset;
   * this describes the offer so the card can say "Add the N that passed" and
   * list the failures legibly. Absent ⇒ the ordinary all-valid card.
   *
   * All strings arrive PRE-HUMANIZED — `reason` is plain workplace language the
   * app derived from the kernel verdict, not raw kernel vocabulary.
   */
  partial?: {
    /** How many writes passed and will be staged by the primary action. */
    passedCount: number;
    /** The writes that failed, each with a legible target + reason. */
    failures: readonly {
      /** Pre-humanized target, e.g. "Staff SWE · base pay". */
      target: string;
      /** Plain-language reason it didn't pass, e.g. "above the band max". */
      reason: string;
    }[];
  };
};

/**
 * A choice the agent offered when it asked a clarifying question instead of
 * proposing. Structural mirror of agent-foundation's `AgentClarificationChoice`
 * so the leaf renders without importing the substrate type.
 */
export type ClarificationChoiceView = {
  id: string;
  label: string;
  intent: "primary" | "default" | "secondary";
};

/**
 * A clarification the agent raised. The app pre-humanizes it from the
 * substrate `AgentClarificationRequest`; the module renders it as a card with
 * choice buttons + an optional free-text follow-up. Purely presentational.
 */
export type ClarificationView = {
  /** The question, e.g. "Which roles should the bump apply to?" */
  headline: string;
  /** Optional rationale rendered muted under the headline. */
  reasoning?: string;
  /** The offered choices. Empty ⇒ free-text only. */
  choices: readonly ClarificationChoiceView[];
  /** When true, a free-text follow-up field is offered alongside choices. */
  canAskFollowUp: boolean;
};

/**
 * A settled run that can continue only in a fresh backend run. The consuming
 * app owns both strings; the generic session owns transcript + run semantics.
 * `actionLabel` is also sent as the next human prompt so the visible transcript
 * and backend history never diverge.
 */
export type RunContinuationView = {
  /** Concise, app-humanized explanation of why the run stopped. */
  message: string;
  /** The explicit human action, e.g. "Continue". */
  actionLabel: string;
};

/**
 * The generic result of one agent turn, as the SESSION consumes it. The app's
 * injected `runAgent` returns this shape; the module never sees raw wire DTOs,
 * proposal schemas, or kernel verdicts. `draft` is an OPAQUE payload
 * (`TDraft`) the module carries back to `onStage` verbatim — the module never
 * inspects it (that would leak grid-buffer / proposal-schema knowledge).
 *
 * The app maps its real backend response (e.g. HC's `HcAgentRunResponse`) onto
 * this at the call site: `turn.text` → text, `turn.toolCalls` → humanized
 * `ToolCallView[]`, `draftPendingWrites` → `{ proposal, draft }`,
 * `clarification` → `clarification`.
 */
export type AgentTurnResult<TDraft = unknown> = {
  /** The assistant's prose for this turn. */
  text: string;
  /** Domain-readable tool-call rows, pre-humanized by the app. */
  toolCalls: readonly ToolCallView[];
  /**
   * A settled, kernel-valid draft awaiting the human's Stage decision. Present
   * only when the agent proposed changes. `proposal` is the humanized preview;
   * `draft` is the opaque payload the app needs to actually stage.
   */
  proposal?: { preview: StageProposalView; draft: TDraft };
  /** Present when the agent asked instead of proposing. */
  clarification?: ClarificationView;
  /** Present when this settled turn may continue in a fresh run. */
  continuation?: RunContinuationView;
};
