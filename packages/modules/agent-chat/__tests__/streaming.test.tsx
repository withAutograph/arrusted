// Streaming-session tests for the agent-chat module (transport slice §3–§5).
//
// Drives `useAgentChatSession` through an INJECTED streaming `runAgent` (the app
// boundary), exercising: progressive text state, ticker accumulation, the
// terminal → identical-settled-state parity with JSON mode, stream-death →
// error + Retry, and cancel → quiet "Stopped." abandon. No real SSE — the
// module is transport-agnostic; the app maps wire → these generic events.

import { describe, expect, it, vi } from "vite-plus/test";
import { act, renderHook, waitFor } from "@testing-library/react";

import { useAgentChatSession, type RunAgent, type StageOutcome } from "../useAgentChatSession";
import type { AgentTurnResult, ChatMessageView } from "../types";

type Draft = { marker: string };

function makeConfig(
  runAgent: RunAgent<Draft>,
  onStage: (draft: Draft) => StageOutcome = () => ({ ok: true }),
) {
  return {
    runAgent,
    onStage,
    generateRunId: (() => {
      let n = 0;
      return () => `run-${(n += 1)}`;
    })(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function lastAgent(messages: readonly ChatMessageView[]): ChatMessageView | undefined {
  return [...messages].reverse().find((m) => m.role === "agent");
}

function agentText(message: ChatMessageView | undefined): string {
  return (message?.parts ?? [])
    .filter((p): p is { kind: "text"; text: string } => p.kind === "text")
    .map((p) => p.text)
    .join("");
}

describe("useAgentChatSession (streaming)", () => {
  it("feeds text_delta into the assistant message progressively", async () => {
    const gate = deferred<void>();
    const runAgent = vi.fn<RunAgent<Draft>>(async (_req, stream) => {
      stream.onEvent({ kind: "text", delta: "Bump " });
      stream.onEvent({ kind: "text", delta: "applied." });
      await gate.promise;
      return { ok: true, result: { text: "Bump applied.", toolCalls: [] } };
    });
    const { result } = renderHook(() => useAgentChatSession(makeConfig(runAgent)));

    act(() => result.current.actions.send("bump"));

    // Mid-flight: the prose has streamed in and the turn is still running.
    await waitFor(() =>
      expect(agentText(lastAgent(result.current.state.messages))).toBe("Bump applied."),
    );
    expect(result.current.state.isRunning).toBe(true);
    expect(lastAgent(result.current.state.messages)?.ticker?.running).toBe(true);

    await act(async () => {
      gate.resolve();
    });
    await waitFor(() => expect(result.current.state.isRunning).toBe(false));
    // A prose-only turn folds nothing in — the transient running ticker retires
    // and the settled turn carries no ticker.
    expect(lastAgent(result.current.state.messages)?.ticker).toBeUndefined();
    expect(agentText(lastAgent(result.current.state.messages))).toBe("Bump applied.");
  });

  it("accumulates ticker steps from phase / tool_start / tool_end", async () => {
    const runAgent = vi.fn<RunAgent<Draft>>(async (_req, stream) => {
      stream.onEvent({ kind: "phase", label: "Searching positions…" });
      stream.onEvent({
        kind: "tool_start",
        callId: "c1",
        tool: { id: "c1", title: "Searching positions", status: "running" },
      });
      stream.onEvent({
        kind: "tool_end",
        callId: "c1",
        tool: { id: "c1", title: "Searched positions", outcome: "3 found", status: "done" },
      });
      return { ok: true, result: { text: "Found 3.", toolCalls: [] } };
    });
    const { result } = renderHook(() => useAgentChatSession(makeConfig(runAgent)));

    act(() => result.current.actions.send("search"));
    await waitFor(() => expect(result.current.state.isRunning).toBe(false));

    const ticker = lastAgent(result.current.state.messages)?.ticker;
    expect(ticker?.running).toBe(false);
    expect(ticker?.steps).toHaveLength(2); // one phase + one settled tool
    const toolStep = ticker?.steps.find((s) => s.kind === "tool");
    expect(toolStep?.kind === "tool" && toolStep.tool.status).toBe("done");
    expect(toolStep?.kind === "tool" && toolStep.tool.outcome).toBe("3 found");
    expect(typeof ticker?.elapsedMs).toBe("number");
  });

  it("terminal settles to the SAME state as JSON mode (parity)", async () => {
    const result_: AgentTurnResult<Draft> = {
      text: "Drafted.",
      toolCalls: [{ id: "t1", title: "Drafted changes", status: "done", outcome: "3 changes" }],
      proposal: {
        preview: { headline: "base pay +4%", changeCount: 3, targets: ["A", "B"] },
        draft: { marker: "d1" },
      },
    };

    // JSON fallback: runAgent ignores the stream handle and just resolves.
    const jsonAgent = vi.fn<RunAgent<Draft>>(async () => ({ ok: true, result: result_ }));
    const json = renderHook(() => useAgentChatSession(makeConfig(jsonAgent)));
    act(() => json.result.current.actions.send("bump"));
    await waitFor(() => expect(json.result.current.state.proposal).not.toBeNull());

    // Streaming: emit events, then resolve with the identical terminal result.
    const streamAgent = vi.fn<RunAgent<Draft>>(async (_req, stream) => {
      stream.onEvent({ kind: "phase", label: "Drafting changes…" });
      stream.onEvent({ kind: "text", delta: "Drafted." });
      return { ok: true, result: result_ };
    });
    const streamed = renderHook(() => useAgentChatSession(makeConfig(streamAgent)));
    act(() => streamed.result.current.actions.send("bump"));
    await waitFor(() => expect(streamed.result.current.state.proposal).not.toBeNull());

    // The settled RESPONSE-derived state is identical: proposal + prose + draft.
    expect(streamed.result.current.state.proposal?.preview).toEqual(
      json.result.current.state.proposal?.preview,
    );
    expect(streamed.result.current.state.proposal?.draft).toEqual(
      json.result.current.state.proposal?.draft,
    );
    expect(agentText(lastAgent(streamed.result.current.state.messages))).toBe(
      agentText(lastAgent(json.result.current.state.messages)),
    );
    expect(streamed.result.current.state.isRunning).toBe(false);
  });

  it("stream death (retryable error) → error state with a Retry that re-runs", async () => {
    let attempt = 0;
    const runAgent = vi.fn<RunAgent<Draft>>(async (_req, stream) => {
      attempt += 1;
      if (attempt === 1) {
        stream.onEvent({ kind: "phase", label: "Searching positions…" });
        return { ok: false, error: { message: "dropped", retryable: true } };
      }
      return { ok: true, result: { text: "Recovered.", toolCalls: [] } };
    });
    const { result } = renderHook(() => useAgentChatSession(makeConfig(runAgent)));

    act(() => result.current.actions.send("go"));
    await waitFor(() => expect(result.current.state.error).not.toBeNull());
    // Distinct stream-death copy (NOT "Stopped.") + a Retry affordance.
    expect(result.current.state.error).not.toBe("Stopped.");
    expect(result.current.state.errorAction?.label).toBe("Try again");
    // The partial live turn was dropped: only the human message remains.
    expect(result.current.state.messages).toHaveLength(1);
    expect(result.current.state.messages[0]?.role).toBe("human");

    // Retry = a fresh run of the same prompt.
    act(() => result.current.state.errorAction?.onAction());
    await waitFor(() => expect(runAgent).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.state.error).toBeNull());
    expect(agentText(lastAgent(result.current.state.messages))).toBe("Recovered.");
  });

  it("cancel abandons: quiet 'Stopped.' notice, no proposal, distinct from stream death", async () => {
    const gate = deferred<void>();
    const runAgent = vi.fn<RunAgent<Draft>>(async (_req, stream) => {
      stream.onEvent({ kind: "phase", label: "Drafting changes…" });
      await gate.promise;
      // Even if a result arrives after abort, cancel wins (abandon).
      return {
        ok: true,
        result: {
          text: "Drafted.",
          toolCalls: [],
          proposal: {
            preview: { headline: "x", changeCount: 1, targets: [] },
            draft: { marker: "d" },
          },
        },
      };
    });
    const { result } = renderHook(() => useAgentChatSession(makeConfig(runAgent)));

    act(() => result.current.actions.send("bump"));
    await waitFor(() => expect(result.current.state.isRunning).toBe(true));

    act(() => result.current.actions.stop());
    await act(async () => {
      gate.resolve();
    });
    await waitFor(() => expect(result.current.state.isRunning).toBe(false));

    // No proposal surfaced; a quiet notice line reads "Stopped."; not an error.
    expect(result.current.state.proposal).toBeNull();
    expect(result.current.state.error).toBeNull();
    const notice = result.current.state.messages.find((m) => m.variant === "notice");
    expect(notice).toBeDefined();
    expect(agentText(notice)).toBe("Stopped.");
  });

  it("a cancelled turn's 'Stopped.' notice never enters the next request's history (§3)", async () => {
    const gate = deferred<void>();
    const runAgent = vi.fn<RunAgent<Draft>>(async () => {
      if (runAgent.mock.calls.length === 1) {
        await gate.promise;
        return { ok: true, result: { text: "late", toolCalls: [] } };
      }
      return { ok: true, result: { text: "second answer", toolCalls: [] } };
    });
    const { result } = renderHook(() => useAgentChatSession(makeConfig(runAgent)));

    act(() => result.current.actions.send("first prompt"));
    await waitFor(() => expect(result.current.state.isRunning).toBe(true));
    act(() => result.current.actions.stop());
    await act(async () => {
      gate.resolve();
    });
    await waitFor(() => expect(result.current.state.isRunning).toBe(false));
    expect(result.current.state.messages.some((m) => m.variant === "notice")).toBe(true);

    // The next turn's request history carries the user's prompt but NOT the
    // "Stopped." notice — it's a display-only line, excluded from toHistory.
    act(() => result.current.actions.send("second prompt"));
    await waitFor(() => expect(runAgent).toHaveBeenCalledTimes(2));
    const history = runAgent.mock.calls[1]?.[0]?.history ?? [];
    expect(history.every((turn) => !turn.content.includes("Stopped."))).toBe(true);
    expect(history.some((turn) => turn.content.includes("first prompt"))).toBe(true);
    // M1: the "Stopped."-only notice must not inject an EMPTY turn either —
    // toHistory drops turns that serialize to nothing after the displayOnly
    // filter, so no {role:"assistant",content:""} reaches the model.
    expect(history.every((turn) => turn.content.length > 0)).toBe(true);
    // Exactly the one real user turn survives (human "first prompt").
    expect(history).toHaveLength(1);
  });

  it("retry replays the ORIGINAL frozen history — no doubled human turn (§5)", async () => {
    let attempt = 0;
    const runAgent = vi.fn<RunAgent<Draft>>(async () => {
      attempt += 1;
      if (attempt === 1) return { ok: true, result: { text: "hi there", toolCalls: [] } };
      if (attempt === 2) return { ok: false, error: { message: "dropped", retryable: true } };
      return { ok: true, result: { text: "recovered", toolCalls: [] } };
    });
    const { result } = renderHook(() => useAgentChatSession(makeConfig(runAgent)));

    // A first successful turn gives the retry a non-trivial history to preserve.
    act(() => result.current.actions.send("hello"));
    await waitFor(() => expect(runAgent).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.state.isRunning).toBe(false));

    // A second turn stream-dies; its request history is [hello, hi there].
    act(() => result.current.actions.send("world"));
    await waitFor(() => expect(result.current.state.error).not.toBeNull());
    const deathHistory = runAgent.mock.calls[1]?.[0]?.history ?? [];

    // Retry replays the identical frozen history — "world" (already appended to
    // the transcript) must NOT double into the sent history.
    act(() => result.current.state.errorAction?.onAction());
    await waitFor(() => expect(runAgent).toHaveBeenCalledTimes(3));
    const retryHistory = runAgent.mock.calls[2]?.[0]?.history ?? [];

    expect(retryHistory).toEqual(deathHistory);
    expect(retryHistory.some((turn) => turn.content.includes("world"))).toBe(false);
  });
});
