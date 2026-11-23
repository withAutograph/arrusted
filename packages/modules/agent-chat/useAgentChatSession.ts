// useAgentChatSession — the generic, app-agnostic conversation session.
//
// Owns the EPHEMERAL conversation (local React state; no transcript store, per
// spec §5) and drives the presentational panel. It calls the backend through
// an INJECTED `runAgent` dependency so the module stays app-agnostic — the
// consuming app supplies the real fetch (HC's `POST /api/agent/.../run`), maps
// its wire response onto the generic `AgentTurnResult`, and later stages the
// opaque `draft` into its own grid buffer.
//
// Boundary: this hook knows NOTHING about HC domain semantics, proposal
// schemas, the grid buffer, kernel verdicts, or the wire DTO. It sees only the
// already-humanized `AgentTurnResult` shape. `TDraft` is opaque — carried from
// `runAgent` back to `onStage` verbatim, never inspected.
//
// Runtime coupling stays VIEW-ONLY (spec §6): the hook is the source of truth
// for the conversation; assistant-ui's external store (via ChatRuntimeProvider
// in the panel) only renders `state.messages`. Truth is this React state, not
// the runtime.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  AgentTurnResult,
  ChatMessageView,
  ClarificationChoiceView,
  ClarificationView,
  MessagePartView,
  RunContinuationView,
  StageProposalView,
  TickerState,
  TickerStep,
  ToolCallView,
} from "./types";

/**
 * A progressive event the app's `runAgent` may emit WHILE a turn streams (the
 * §3 event contract, humanized). The module is transport-agnostic: the app maps
 * its wire SSE (phase / tool_start / tool_end / text_delta) onto these generic
 * shapes and calls `onEvent`. In non-streaming fallback the app never emits any
 * — the ticker settles at once from the terminal result (doc §3 severability).
 *
 * NOTE: labels + tool views arrive PRE-HUMANIZED. No raw args/results, no
 * transport/kernel vocabulary reaches the module.
 */
export type TurnStreamEvent =
  | { kind: "phase"; label: string; attempt?: number }
  | { kind: "tool_start"; callId: string; tool: ToolCallView }
  | { kind: "tool_end"; callId: string; tool: ToolCallView }
  | { kind: "text"; delta: string };

/** The handle the module passes into a streaming `runAgent` call. */
export type TurnStreamHandle = {
  onEvent: (event: TurnStreamEvent) => void;
};

/** How the app's `runAgent` is invoked for one turn. */
export type AgentRunRequest = {
  /** Host-generated per turn; the app forwards it as the provenance runId. */
  runId: string;
  /** The human's message for this turn. */
  prompt: string;
  /**
   * Prior turns as flat role/text pairs, so a stateless backend can rebuild
   * context. The module does not persist these beyond the live session.
   */
  history: readonly { role: "user" | "assistant"; content: string }[];
  /**
   * An in-flight clarification answer, when this turn resumes a pending
   * question rather than starting fresh. The app threads it into the backend.
   */
  clarificationAnswer?: { choiceId: string | null; followUp: string | null };
  abortSignal?: AbortSignal;
};

/**
 * The app-supplied backend call. Returns the generic `AgentTurnResult` (mapped
 * from the app's real wire response) or a plain error the session surfaces.
 *
 * STREAMING (optional): when the app supports SSE it calls `stream.onEvent` with
 * progressive ticker/text events and resolves with the TERMINAL result — which
 * is exactly the settled response, so the terminal path (proposal/clarification
 * mapping) is identical to fallback. `stream` is always passed; a JSON-only app
 * simply ignores it and the ticker settles at once (severable, doc §3).
 *
 * `retryable` on an error marks a STREAM DEATH (connection dropped before a
 * terminal) — the session offers Retry. Absent ⇒ an ordinary error.
 */
export type RunAgentError = { message: string; retryable?: boolean };

export type RunAgent<TDraft> = (
  request: AgentRunRequest,
  stream: TurnStreamHandle,
) => Promise<{ ok: true; result: AgentTurnResult<TDraft> } | { ok: false; error: RunAgentError }>;

/**
 * A secondary action the app attaches to a stage FAILURE. Purely generic: the
 * module carries a `label` + a `run` thunk and never interprets what it does.
 * The app uses it to offer an informed override (e.g. "Replace earlier
 * suggestion" / "Replace my edits") that clears a buffer conflict and re-stages.
 * `run` returns the SAME `StageOutcome` shape, so the session applies its result
 * exactly like the original stage attempt (staged, or another error + action).
 */
export type StageErrorAction = {
  label: string;
  run: () => StageOutcome;
};

/**
 * The result of a stage-into-buffer attempt. On failure the app MAY attach a
 * single `action` the session surfaces as a secondary affordance on the error.
 */
export type StageOutcome = { ok: true } | { ok: false; message: string; action?: StageErrorAction };

/**
 * A stage error's secondary action, resolved for the presentational panel: a
 * plain label + a click handler. The module derives this from the app's
 * `StageErrorAction` and threads it through `state.errorAction`; it stays
 * app-agnostic (no agent/staging semantics leak into the panel).
 */
export type SessionErrorAction = {
  label: string;
  onAction: () => void;
};

export type UseAgentChatSessionConfig<TDraft> = {
  /** The injected backend call (the app's real fetch). */
  runAgent: RunAgent<TDraft>;
  /**
   * Commit the opaque draft into the app's grid buffer. Returns a `StageOutcome`
   * so the session can surface a staging failure — and an optional override
   * action — without knowing why. This is the ONLY place the draft is consumed;
   * the session never inspects it.
   *
   * SEMANTICS: staging ≠ saving. This commits to the buffer; the canonical
   * kernel write stays the app's existing grid Save.
   */
  onStage: (draft: TDraft) => StageOutcome;
  /** Mint a host-authoritative runId per turn (provenance source_ref). */
  generateRunId: () => string;
};

/** The settled draft awaiting the human's Stage decision. */
export type SessionProposal<TDraft> = {
  preview: StageProposalView;
  draft: TDraft;
  /** True once the human staged it into the grid buffer. */
  staged: boolean;
};

export type AgentChatSessionState<TDraft> = {
  /** The ephemeral conversation, ready to feed the runtime + panel. */
  messages: readonly ChatMessageView[];
  /** True while a turn is in flight (drives the composer + working row). */
  isRunning: boolean;
  /** The current settled proposal, if the last turn produced one. */
  proposal: SessionProposal<TDraft> | null;
  /** The current open clarification, if the last turn asked one. */
  clarification: ClarificationView | null;
  /** A settled run-limit affordance, if the app mapped one for this turn. */
  continuation: RunContinuationView | null;
  /** A turn or stage error to surface inline. Cleared on the next action. */
  error: string | null;
  /**
   * A secondary action attached to the current stage error (e.g. an informed
   * "Replace…" override), when the app offered one. Cleared alongside `error`.
   */
  errorAction: SessionErrorAction | null;
};

export type AgentChatSessionActions = {
  /** Send a fresh human prompt. */
  send: (prompt: string) => void;
  /**
   * Abort the in-flight turn (§4). Abandon semantics: nothing is staged, no
   * proposal surfaces; the transcript keeps the user message + a quiet
   * "Stopped." notice. No-op when idle.
   */
  stop: () => void;
  /** Stage the current settled proposal into the grid buffer. */
  stageChanges: () => void;
  /** Discard the current settled proposal without staging. */
  discard: () => void;
  /** Answer the current clarification (resumes the run). */
  answerClarification: (choiceId: string | null, followUp?: string | null) => void;
  /** Continue a settled limited turn in a fresh run with frozen prior history. */
  continueRun: () => void;
};

export type UseAgentChatSessionResult<TDraft> = {
  state: AgentChatSessionState<TDraft>;
  actions: AgentChatSessionActions;
};

let sessionMessageSeq = 0;
function nextId(prefix: string): string {
  sessionMessageSeq += 1;
  return `${prefix}-${sessionMessageSeq}`;
}

function humanTurn(prompt: string): ChatMessageView {
  return {
    id: nextId("u"),
    role: "human",
    parts: [{ kind: "text", text: prompt }],
  };
}

// Copy for the distinct terminal-failure states (§4/§5). "Stopped." is the
// human's own cancel; the stream-death line is a lost connection — deliberately
// different words so the two never read as the same event.
const STOPPED_NOTICE = "Stopped.";
const STREAM_DEATH_ERROR = "The agent lost its connection before finishing. Nothing was changed.";
const RETRY_LABEL = "Try again";

// Build the SETTLED agent turn from the terminal result. Tool rows fold INTO
// the ticker (transcript fold-in, §3) — the bubble carries prose only. When the
// turn streamed, `streamedSteps` holds the richer phase+tool sequence; in
// fallback we derive the ticker from `result.toolCalls` so the settled state is
// identical either way (doc §3 parity).
function buildSettledTicker<TDraft>(
  result: AgentTurnResult<TDraft>,
  streamedSteps: readonly TickerStep[],
  elapsedMs: number,
): TickerState | undefined {
  const steps =
    streamedSteps.length > 0
      ? streamedSteps
      : result.toolCalls.map((tool): TickerStep => ({ kind: "tool", id: tool.id, tool }));
  if (steps.length === 0) return undefined;
  return { steps, running: false, elapsedMs };
}

function settledParts(text: string, hasTicker: boolean): MessagePartView[] {
  const parts: MessagePartView[] = [];
  if (text.trim().length > 0) parts.push({ kind: "text", text });
  // A turn that only asked / only proposed carries no prose. When it also has no
  // ticker, seed an empty text part so the message has a stable part to SETTLE
  // into later — `withSettledClarification` swaps this placeholder for the
  // question headline + answer once the human responds. It does NOT force a
  // visible bubble: an empty-text-only turn with no ticker is the pre-content
  // "empty shell" that `AgentMessage` renders as null (the duplicate-avatar
  // fix). The turn stays visible via its ticker, or — for a clarification/stage
  // — via the card rendered separately in the panel.
  if (parts.length === 0 && !hasTicker) parts.push({ kind: "text", text: "" });
  return parts;
}

// Settle an answered clarification into the agent turn that asked it, so the
// question stays legible in the transcript after the ephemeral card closes.
// Drops the placeholder empty text part a clarification-only turn carries, then
// appends the question headline as the DISPLAY question part and the chosen
// answer as a display line beneath it.
//
// HISTORY marker (loop fix): the headline part carries a compact `historyText`
// — "Asked: <q> — user answered: <a>" — so the model, on a LATER turn, sees it
// already asked AND what the user answered, and does not re-ask (the loop). The
// answer display line stays `displayOnly` so it never doubles into history; the
// summarized headline line is the single assistant-role trace. There is no
// triple-representation: on the RESUME turn the answer is in user role (the
// resumed prompt + structured `clarificationAnswer`); the summarized assistant
// line adds the answer at most once in assistant role — at most once per role.
// Cap for the ANSWER portion of the durable history summary. The full answer
// already reached the model once in user role at answer time (the resumed
// prompt); the summary is durable context that replays on every later turn, so
// keep it bounded — a pasted 7-row block should not balloon the assistant
// history line on every subsequent request.
const HISTORY_ANSWER_MAX = 500;

function capAnswerForHistory(answerLabel: string): string {
  // Collapse newlines so a pasted multi-line block stays one summary line (the
  // marker is a single "Asked … answered …" line the model replays each turn).
  const singleLine = answerLabel.replace(/\s*\n\s*/g, " ").trim();
  // Truncate by CODE POINT, not UTF-16 unit, so the cap can't split a surrogate
  // pair (an emoji / astral char) and leave a lone half in the summary.
  const codePoints = Array.from(singleLine);
  if (codePoints.length <= HISTORY_ANSWER_MAX) return singleLine;
  return `${codePoints.slice(0, HISTORY_ANSWER_MAX).join("")}…`;
}

function withSettledClarification(
  parts: readonly MessagePartView[],
  headline: string,
  answerLabel: string,
): MessagePartView[] {
  const kept = parts.filter((part) => !(part.kind === "text" && part.text.trim().length === 0));
  const historyText =
    answerLabel.length > 0
      ? `Asked: ${headline} — user answered: ${capAnswerForHistory(answerLabel)}`
      : `Asked: ${headline}`;
  const settled: MessagePartView[] = [{ kind: "text", text: headline, historyText }];
  if (answerLabel.length > 0) {
    settled.push({ kind: "text", text: `→ ${answerLabel}`, displayOnly: true });
  }
  return [...kept, ...settled];
}

function toHistory(messages: readonly ChatMessageView[]): {
  role: "user" | "assistant";
  content: string;
}[] {
  return messages.flatMap((message) => {
    const content = message.parts
      .flatMap((part) => {
        if (part.kind !== "text" || part.displayOnly === true) return [];
        // A settled clarification's question part carries a compact history
        // marker ("Asked: <q> — user answered: <a>"); serialize that so the
        // model sees the answered question and doesn't re-ask. Ordinary parts
        // serialize verbatim.
        return [part.historyText ?? part.text];
      })
      .join("\n")
      .trim();
    // Drop turns that serialize to nothing after the displayOnly filter — a
    // cancel's "Stopped."-only notice (all displayOnly) would otherwise inject an
    // empty {role:"assistant",content:""} turn into the model's replayed context.
    return content.length > 0
      ? [{ role: message.role === "human" ? ("user" as const) : ("assistant" as const), content }]
      : [];
  });
}

/**
 * The generic agent-chat session. `TDraft` is the app's opaque stage payload
 * (for HC: `CompiledPendingWrite[]`), never inspected here.
 */
export function useAgentChatSession<TDraft>(
  config: UseAgentChatSessionConfig<TDraft>,
): UseAgentChatSessionResult<TDraft> {
  const { runAgent, onStage, generateRunId } = config;

  const [messages, setMessages] = useState<readonly ChatMessageView[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [proposal, setProposal] = useState<SessionProposal<TDraft> | null>(null);
  const [clarification, setClarification] = useState<ClarificationView | null>(null);
  const [continuation, setContinuation] = useState<RunContinuationView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorAction, setErrorAction] = useState<SessionErrorAction | null>(null);

  // Guards concurrent turns: a send/answer while a turn is in flight is
  // ignored (the composer is disabled meanwhile, but refs make it airtight).
  const runningRef = useRef(false);
  // Guards re-entrant staging. `onStage` is synchronous today, so this never
  // renders a spinner — it only makes double-invocation (or a replace-override
  // click racing the first attempt) airtight without a render-visible flag.
  const stagingRef = useRef(false);
  // The transcript id of the agent turn that last asked a clarification, so an
  // answer can settle the Q&A into that turn (the card is ephemeral; without
  // this the question vanishes once answered).
  const clarifyingMessageIdRef = useRef<string | null>(null);
  // Snapshot of history at call time, read inside the async turn without
  // re-subscribing to `messages`.
  const messagesRef = useRef<readonly ChatMessageView[]>(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // The in-flight turn's abort controller (§4 cancel). `stop()` aborts it; the
  // finalize path reads `signal.aborted` to tell a cancel (abandon) apart from a
  // stream death (retry).
  const abortRef = useRef<AbortController | null>(null);
  // The re-run for the current stream-death error's Retry (§5). Captures the
  // exact turn args so retry is a FRESH send of the same prompt (new runId).
  const retryRef = useRef<(() => void) | null>(null);

  const runTurn = useCallback(
    async (
      prompt: string,
      humanMessage: ChatMessageView | null,
      clarificationAnswer?: AgentRunRequest["clarificationAnswer"],
      // The transcript to build history from. Defaults to the live ref, but a
      // caller that just synchronously settled messages (e.g. answering a
      // clarification) passes the settled array so the resumed request's history
      // includes the just-answered QUESTION — `messagesRef.current` still holds
      // the PRE-settle array until the next render. The ANSWER is not carried
      // here: it lives in a display-only part `toHistory` excludes, and reaches
      // the backend in user role via `prompt` + `clarificationAnswer`.
      historyOverride?: readonly ChatMessageView[],
      // A FROZEN, already-serialized history to send verbatim. Stream Retry (§5)
      // reuses the original pre-attempt snapshot after `humanMessage` is already
      // rendered; fresh-run Continue freezes the complete settled transcript
      // before rendering its action turn. In both cases, recomputing from
      // `messagesRef.current` would double the current prompt into sent history.
      // Absent ⇒ compute fresh.
      frozenHistory?: readonly { role: "user" | "assistant"; content: string }[],
    ) => {
      if (runningRef.current) return;
      runningRef.current = true;
      setIsRunning(true);
      setError(null);
      setErrorAction(null);
      // A fresh turn supersedes any open proposal / clarification.
      setProposal(null);
      setClarification(null);
      setContinuation(null);
      clarifyingMessageIdRef.current = null;

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        // Freeze the pre-send history snapshot ONCE. Retry replays this exact
        // array (never recomputed) so the doubled human turn can't leak in.
        const history = frozenHistory ?? toHistory(historyOverride ?? messagesRef.current);
        // Retry re-runs THIS same turn with the FROZEN history + no fresh human
        // message (it's already in the transcript); a new runId is minted inside.
        retryRef.current = () =>
          void runTurn(prompt, null, clarificationAnswer, historyOverride, history);
        if (humanMessage) {
          setMessages((prev) => [...prev, humanMessage]);
        }

        // --- Streaming accumulation state for THIS turn -----------------------
        // The live agent message is created lazily on the first stream event (or
        // at settle in fallback). Ticker steps + prose deltas accumulate in refs
        // and rebuild the live message on each event so the ticker narrates and
        // SmoothText streams the prose progressively.
        const startedAt = Date.now();
        let liveId: string | null = null;
        let stepSeq = 0;
        const steps: TickerStep[] = [];
        let liveText = "";

        const removeLive = () => {
          if (liveId == null) return;
          const gone = liveId;
          setMessages((prev) => prev.filter((message) => message.id !== gone));
          liveId = null;
        };

        const syncLive = () => {
          const id = liveId;
          if (id == null) return;
          const parts: MessagePartView[] = [{ kind: "text", text: liveText }];
          const ticker: TickerState = { steps: [...steps], running: true };
          setMessages((prev) =>
            prev.map((message) => (message.id === id ? { ...message, parts, ticker } : message)),
          );
        };

        const ensureLive = () => {
          if (liveId != null) return;
          liveId = nextId("a");
          const message: ChatMessageView = {
            id: liveId,
            role: "agent",
            parts: [{ kind: "text", text: "" }],
            ticker: { steps: [], running: true },
          };
          setMessages((prev) => [...prev, message]);
        };

        const stream: TurnStreamHandle = {
          onEvent: (event) => {
            if (controller.signal.aborted) return;
            ensureLive();
            switch (event.kind) {
              case "text":
                liveText += event.delta;
                break;
              case "phase":
                stepSeq += 1;
                steps.push({
                  kind: "phase",
                  id: `${liveId}-p${stepSeq}`,
                  label: event.label,
                  ...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
                });
                break;
              case "tool_start":
                steps.push({ kind: "tool", id: event.callId, tool: event.tool });
                break;
              case "tool_end":
                for (let i = 0; i < steps.length; i += 1) {
                  const step = steps[i];
                  if (step && step.kind === "tool" && step.id === event.callId) {
                    steps[i] = { kind: "tool", id: event.callId, tool: event.tool };
                  }
                }
                break;
            }
            syncLive();
          },
        };

        const runId = generateRunId();
        let response:
          | { ok: true; result: AgentTurnResult<TDraft> }
          | { ok: false; error: RunAgentError };
        try {
          response = await runAgent(
            {
              runId,
              prompt,
              history,
              abortSignal: controller.signal,
              ...(clarificationAnswer ? { clarificationAnswer } : {}),
            },
            stream,
          );
        } catch (caught) {
          response = {
            ok: false,
            error: {
              message:
                caught instanceof Error ? caught.message : "The agent couldn't finish. Try again.",
            },
          };
        }

        // Cancel wins over any late-arriving result: abandon (§4). Drop the
        // partial live turn, leave a quiet "Stopped." notice, surface no proposal.
        if (controller.signal.aborted) {
          removeLive();
          retryRef.current = null;
          setMessages((prev) => [
            ...prev,
            {
              id: nextId("n"),
              role: "agent",
              variant: "notice",
              // `displayOnly` keeps the notice out of `toHistory` — the model must
              // never see "Stopped." replayed as an assistant turn on the next
              // send (same mechanism as the settled-clarification answer).
              parts: [{ kind: "text", text: STOPPED_NOTICE, displayOnly: true }],
            },
          ]);
          return;
        }

        if (!response.ok) {
          // A partial streamed turn can't settle — drop it and surface the error.
          removeLive();
          if (response.error.retryable) {
            // Stream death (§5): distinct copy + a Retry affordance.
            setError(STREAM_DEATH_ERROR);
            setErrorAction({ label: RETRY_LABEL, onAction: () => retryRef.current?.() });
          } else {
            setError(response.error.message);
          }
          return;
        }

        retryRef.current = null;
        const result = response.result;
        const elapsedMs = Date.now() - startedAt;
        const ticker = buildSettledTicker(result, steps, elapsedMs);
        const finalText = result.text;
        const parts = settledParts(finalText, ticker !== undefined);

        let settledId: string;
        if (liveId != null) {
          // Finalize the streamed live message in place.
          const id = liveId;
          settledId = id;
          setMessages((prev) =>
            prev.map((message) =>
              message.id === id
                ? { ...message, parts, ...(ticker ? { ticker } : { ticker: undefined }) }
                : message,
            ),
          );
        } else {
          // Fallback (no events streamed): append the settled turn fresh.
          settledId = nextId("a");
          setMessages((prev) => [
            ...prev,
            { id: settledId, role: "agent", parts, ...(ticker ? { ticker } : {}) },
          ]);
        }

        if (result.clarification) {
          clarifyingMessageIdRef.current = settledId;
          setClarification(result.clarification);
        } else if (result.proposal) {
          setProposal({
            preview: result.proposal.preview,
            draft: result.proposal.draft,
            staged: false,
          });
        } else if (result.continuation) {
          setContinuation(result.continuation);
        }
      } finally {
        // Every exit — settle, cancel, error, stream death — clears the
        // in-flight flags and the abort handle exactly once.
        runningRef.current = false;
        setIsRunning(false);
        abortRef.current = null;
      }
    },
    [runAgent, generateRunId],
  );

  const send = useCallback(
    (prompt: string) => {
      const trimmed = prompt.trim();
      if (trimmed.length === 0) return;
      void runTurn(trimmed, humanTurn(trimmed));
    },
    [runTurn],
  );

  const stop = useCallback(() => {
    if (!runningRef.current) return;
    abortRef.current?.abort();
  }, []);

  const answerClarification = useCallback(
    (choiceId: string | null, followUp?: string | null) => {
      const open = clarification;
      if (!open) return;
      const chosen: ClarificationChoiceView | undefined = choiceId
        ? open.choices.find((choice) => choice.id === choiceId)
        : undefined;
      const trimmedFollowUp = followUp?.trim() ? followUp.trim() : null;
      // Guard against sending an empty clarification answer: with no RESOLVED
      // choice AND no follow-up text there is nothing to answer, so resuming
      // the run would post an empty prompt. Guarding on `chosen` (not the raw
      // choiceId) also drops stale/invalid ids, which would otherwise send an
      // empty invisible turn.
      if (!chosen && !trimmedFollowUp) return;
      // Echo the human's answer as a turn so the transcript reads naturally.
      const echo = [chosen?.label, trimmedFollowUp].filter(Boolean).join(" — ");
      const humanMessage = echo.length > 0 ? humanTurn(echo) : null;
      // Settle the Q&A into the asking agent turn BEFORE resuming, so the
      // question survives the card closing (and a failed resume can't orphan
      // it). `runTurn` clears the ref, so read it here first.
      //
      // Compute the settled array ONCE and use it for BOTH the render
      // (setMessages) and the resumed turn's history override — `messagesRef`
      // still holds the pre-settle array synchronously here. The QUESTION lands
      // in the resumed request's assistant history (legitimate context). The
      // ANSWER reaches the backend AT MOST ONCE PER ROLE: once in USER role via
      // the resumed `prompt` + `clarificationAnswer`, and once (capped) in
      // ASSISTANT role via the settled question part's `historyText` marker
      // ("Asked: <q> — user answered: <a>"). The display-only answer line
      // (`→ <answer>`) is NOT a third copy — `toHistory` excludes display-only
      // parts, so it never serializes.
      const settledId = clarifyingMessageIdRef.current;
      const settledMessages = settledId
        ? messagesRef.current.map((message) =>
            message.id === settledId
              ? { ...message, parts: withSettledClarification(message.parts, open.headline, echo) }
              : message,
          )
        : messagesRef.current;
      if (settledId) setMessages(settledMessages);
      void runTurn(
        echo,
        humanMessage,
        {
          // Send only a RESOLVED choice id — a stale id with a follow-up should
          // degrade to a follow-up-only answer, not assert a choice the card
          // never offered.
          choiceId: chosen ? choiceId : null,
          followUp: trimmedFollowUp,
        },
        settledMessages,
      );
    },
    [clarification, runTurn],
  );

  const continueRun = useCallback(() => {
    const open = continuation;
    if (!open) return;

    // Freeze the COMPLETE settled transcript before appending the visible
    // Continue turn. The new request receives that exact prior history plus the
    // action as its prompt; `runTurn` mints a fresh runId. Passing frozen history
    // also prevents a fast double-render or retry from serializing Continue into
    // history as well as sending it as the prompt.
    const history = toHistory(messagesRef.current);
    void runTurn(open.actionLabel, humanTurn(open.actionLabel), undefined, undefined, history);
  }, [continuation, runTurn]);

  const stageChanges = useCallback(() => {
    const open = proposal;
    if (!open || open.staged || stagingRef.current) return;

    // Apply a StageOutcome: settle the proposal, or surface the error + its
    // optional override action (which re-runs staging the same way).
    function apply(outcome: StageOutcome) {
      if (outcome.ok) {
        setProposal({ ...open!, staged: true });
        setError(null);
        setErrorAction(null);
        return;
      }
      setError(outcome.message);
      setErrorAction(
        outcome.action
          ? { label: outcome.action.label, onAction: () => runStage(outcome.action!.run) }
          : null,
      );
    }

    function runStage(run: () => StageOutcome) {
      if (stagingRef.current) return;
      stagingRef.current = true;
      setError(null);
      setErrorAction(null);
      try {
        apply(run());
      } finally {
        stagingRef.current = false;
      }
    }

    runStage(() => onStage(open.draft));
  }, [proposal, onStage]);

  const discard = useCallback(() => {
    setProposal(null);
    setError(null);
    setErrorAction(null);
  }, []);

  const state = useMemo<AgentChatSessionState<TDraft>>(
    () => ({ messages, isRunning, proposal, clarification, continuation, error, errorAction }),
    [messages, isRunning, proposal, clarification, continuation, error, errorAction],
  );

  const actions = useMemo<AgentChatSessionActions>(
    () => ({ send, stop, stageChanges, discard, answerClarification, continueRun }),
    [send, stop, stageChanges, discard, answerClarification, continueRun],
  );

  return { state, actions };
}
