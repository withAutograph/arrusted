// Session-hook regression tests for the generic agent-chat module.
//
// Exercises the boring conversation state machine the "green" build never
// touched (spec §8): a turn appends a human + agent message, a proposal turn
// surfaces a stageable proposal, `stageChanges` routes the opaque draft to
// `onStage`, and — the rework fix — an EMPTY clarification answer (no choice +
// no follow-up) is dropped rather than posting a blank turn.

import { describe, expect, it, vi } from "vite-plus/test";
import { act, renderHook, waitFor } from "@testing-library/react";

import { useAgentChatSession, type RunAgent, type StageOutcome } from "../useAgentChatSession";
import type { AgentTurnResult } from "../types";

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

describe("useAgentChatSession", () => {
  it("appends a human turn then the agent turn on send", async () => {
    const runAgent = vi.fn<RunAgent<Draft>>(async () => ({
      ok: true,
      result: { text: "Here is what I found.", toolCalls: [] } satisfies AgentTurnResult<Draft>,
    }));
    const config = makeConfig(runAgent);
    const { result } = renderHook(() => useAgentChatSession(config));

    act(() => result.current.actions.send("How many roles?"));

    await waitFor(() => expect(result.current.state.isRunning).toBe(false));
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(result.current.state.messages).toHaveLength(2);
    expect(result.current.state.messages[0]?.role).toBe("human");
    expect(result.current.state.messages[1]?.role).toBe("agent");
    expect(result.current.state.continuation).toBeNull();
  });

  it("continues in fresh runs with frozen full history and no duplicated turns", async () => {
    const runAgent = vi
      .fn<RunAgent<Draft>>()
      .mockResolvedValueOnce({
        ok: true,
        result: {
          text: "I checked the selected roles.",
          toolCalls: [],
          continuation: {
            message: "This run reached its limit.",
            actionLabel: "Continue",
          },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        result: {
          text: "I compared their pay ranges.",
          toolCalls: [],
          continuation: {
            message: "This run reached its limit again.",
            actionLabel: "Continue",
          },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        result: { text: "The review is complete.", toolCalls: [] },
      });
    const config = makeConfig(runAgent);
    const { result } = renderHook(() => useAgentChatSession(config));

    act(() => result.current.actions.send("Review selected-role pay"));
    await waitFor(() => expect(result.current.state.continuation).not.toBeNull());

    act(() => result.current.actions.continueRun());
    await waitFor(() => {
      expect(runAgent).toHaveBeenCalledTimes(2);
      expect(result.current.state.messages).toHaveLength(4);
      expect(result.current.state.isRunning).toBe(false);
    });

    expect(runAgent.mock.calls[0]?.[0]).toMatchObject({
      runId: "run-1",
      prompt: "Review selected-role pay",
      history: [],
    });
    expect(runAgent.mock.calls[1]?.[0]).toMatchObject({
      runId: "run-2",
      prompt: "Continue",
      history: [
        { role: "user", content: "Review selected-role pay" },
        { role: "assistant", content: "I checked the selected roles." },
      ],
    });

    act(() => result.current.actions.continueRun());
    await waitFor(() => {
      expect(runAgent).toHaveBeenCalledTimes(3);
      expect(result.current.state.messages).toHaveLength(6);
      expect(result.current.state.isRunning).toBe(false);
    });

    expect(runAgent.mock.calls[2]?.[0]).toMatchObject({
      runId: "run-3",
      prompt: "Continue",
      history: [
        { role: "user", content: "Review selected-role pay" },
        { role: "assistant", content: "I checked the selected roles." },
        { role: "user", content: "Continue" },
        { role: "assistant", content: "I compared their pay ranges." },
      ],
    });
    expect(result.current.state.continuation).toBeNull();

    const transcript = result.current.state.messages.map((message) => ({
      role: message.role,
      text: message.parts
        .filter((part) => part.kind === "text")
        .map((part) => part.text)
        .join("\n"),
    }));
    expect(transcript).toEqual([
      { role: "human", text: "Review selected-role pay" },
      { role: "agent", text: "I checked the selected roles." },
      { role: "human", text: "Continue" },
      { role: "agent", text: "I compared their pay ranges." },
      { role: "human", text: "Continue" },
      { role: "agent", text: "The review is complete." },
    ]);
  });

  it("deduplicates same-tick Continue clicks while the fresh run is pending", async () => {
    type RunOutcome = Awaited<ReturnType<RunAgent<Draft>>>;
    let resolveContinuation!: (outcome: RunOutcome) => void;
    const pendingContinuation = new Promise<RunOutcome>((resolve) => {
      resolveContinuation = resolve;
    });
    const runAgent = vi
      .fn<RunAgent<Draft>>()
      .mockResolvedValueOnce({
        ok: true,
        result: {
          text: "I checked the selected roles.",
          toolCalls: [],
          continuation: {
            message: "This run reached its limit.",
            actionLabel: "Continue",
          },
        },
      })
      .mockImplementationOnce(() => pendingContinuation);
    const config = makeConfig(runAgent);
    const { result } = renderHook(() => useAgentChatSession(config));

    act(() => result.current.actions.send("Review selected-role pay"));
    await waitFor(() => expect(result.current.state.continuation).not.toBeNull());

    const frozenPriorHistory = [
      { role: "user" as const, content: "Review selected-role pay" },
      { role: "assistant" as const, content: "I checked the selected roles." },
    ];
    act(() => {
      result.current.actions.continueRun();
      result.current.actions.continueRun();
    });

    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(runAgent.mock.calls[1]?.[0]).toMatchObject({
      runId: "run-2",
      prompt: "Continue",
      history: frozenPriorHistory,
    });
    await waitFor(() => {
      const continueTurns = result.current.state.messages.filter(
        (message) =>
          message.role === "human" &&
          message.parts.some((part) => part.kind === "text" && part.text === "Continue"),
      );
      expect(continueTurns).toHaveLength(1);
      expect(result.current.state.isRunning).toBe(true);
    });

    act(() => {
      resolveContinuation({
        ok: true,
        result: { text: "The review is complete.", toolCalls: [] },
      });
    });
    await waitFor(() => expect(result.current.state.isRunning).toBe(false));
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(result.current.state.messages).toHaveLength(4);
    expect(result.current.state.messages[3]).toMatchObject({
      role: "agent",
      parts: [{ kind: "text", text: "The review is complete." }],
    });
  });

  it("surfaces a proposal and stages the opaque draft on stageChanges", async () => {
    const draft: Draft = { marker: "d1" };
    const runAgent = vi.fn<RunAgent<Draft>>(async () => ({
      ok: true,
      result: {
        text: "Drafted.",
        toolCalls: [],
        proposal: {
          preview: { headline: "Base salary update", changeCount: 3, targets: ["A", "B"] },
          draft,
        },
      },
    }));
    const onStage = vi.fn(() => ({ ok: true }) as const);
    const { result } = renderHook(() => useAgentChatSession(makeConfig(runAgent, onStage)));

    act(() => result.current.actions.send("bump base salary"));
    await waitFor(() => expect(result.current.state.proposal).not.toBeNull());
    expect(result.current.state.proposal?.staged).toBe(false);

    act(() => result.current.actions.stageChanges());
    // The opaque draft is passed through verbatim.
    expect(onStage).toHaveBeenCalledWith(draft);
    await waitFor(() => expect(result.current.state.proposal?.staged).toBe(true));
  });

  it("surfaces a stage failure message and leaves the proposal unstaged", async () => {
    const runAgent = vi.fn<RunAgent<Draft>>(async () => ({
      ok: true,
      result: {
        text: "Drafted.",
        toolCalls: [],
        proposal: {
          preview: { headline: "x", changeCount: 1, targets: [] },
          draft: { marker: "d" },
        },
      },
    }));
    const onStage = vi.fn(() => ({ ok: false, message: "buffer conflict" }) as const);
    const { result } = renderHook(() => useAgentChatSession(makeConfig(runAgent, onStage)));

    act(() => result.current.actions.send("x"));
    await waitFor(() => expect(result.current.state.proposal).not.toBeNull());
    act(() => result.current.actions.stageChanges());

    await waitFor(() => expect(result.current.state.error).toBe("buffer conflict"));
    expect(result.current.state.proposal?.staged).toBe(false);
  });

  it("surfaces a stage error's override action and re-stages when it runs", async () => {
    const runAgent = vi.fn<RunAgent<Draft>>(async () => ({
      ok: true,
      result: {
        text: "Drafted.",
        toolCalls: [],
        proposal: {
          preview: { headline: "x", changeCount: 1, targets: [] },
          draft: { marker: "d" },
        },
      },
    }));
    // First stage blocks with an override action; the override succeeds.
    let attempts = 0;
    const onStage = vi.fn((): StageOutcome => {
      attempts += 1;
      if (attempts === 1) {
        return {
          ok: false,
          message: "conflict",
          action: { label: "Replace earlier suggestion", run: () => ({ ok: true }) },
        };
      }
      return { ok: true };
    });
    const { result } = renderHook(() => useAgentChatSession(makeConfig(runAgent, onStage)));

    act(() => result.current.actions.send("x"));
    await waitFor(() => expect(result.current.state.proposal).not.toBeNull());

    act(() => result.current.actions.stageChanges());
    await waitFor(() => expect(result.current.state.error).toBe("conflict"));
    expect(result.current.state.errorAction?.label).toBe("Replace earlier suggestion");
    expect(result.current.state.proposal?.staged).toBe(false);

    // Running the override clears the error + action and settles the proposal.
    act(() => result.current.state.errorAction?.onAction());
    await waitFor(() => expect(result.current.state.proposal?.staged).toBe(true));
    expect(result.current.state.error).toBeNull();
    expect(result.current.state.errorAction).toBeNull();
  });

  it("persists an answered clarification into the transcript (the question survives)", async () => {
    const runAgent = vi
      .fn<RunAgent<Draft>>()
      .mockResolvedValueOnce({
        ok: true,
        result: {
          text: "",
          toolCalls: [],
          clarification: {
            headline: "Which roles?",
            choices: [{ id: "fte", label: "Full-time only", intent: "primary" }],
            canAskFollowUp: false,
          },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        result: { text: "Done.", toolCalls: [] },
      });
    const { result } = renderHook(() => useAgentChatSession(makeConfig(runAgent)));

    act(() => result.current.actions.send("bump"));
    await waitFor(() => expect(result.current.state.clarification).not.toBeNull());

    act(() => result.current.actions.answerClarification("fte"));
    await waitFor(() => expect(runAgent).toHaveBeenCalledTimes(2));

    // The card is gone, but the asking agent turn now carries the Q&A as text.
    expect(result.current.state.clarification).toBeNull();
    const allText = result.current.state.messages
      .flatMap((m) => m.parts)
      .filter((p): p is { kind: "text"; text: string } => p.kind === "text")
      .map((p) => p.text)
      .join(" | ");
    expect(allText).toContain("Which roles?");
    expect(allText).toContain("Full-time only");
  });

  it("resumes with a summarized 'Asked … user answered …' assistant line; answer at most once per role", async () => {
    // Loop fix (supersedes the old display-only exclusion of the answer): the
    // model needs to see it ALREADY asked AND what the user answered, or it
    // re-asks the same question and loops. The settled asking turn now serializes
    // to a compact assistant marker ("Asked: <q> — user answered: <a>"). No
    // triple-representation: the answer appears AT MOST ONCE per role — assistant
    // role via the summarized line, user role via the resumed prompt.
    const runAgent = vi
      .fn<RunAgent<Draft>>()
      .mockResolvedValueOnce({
        ok: true,
        result: {
          text: "",
          toolCalls: [],
          clarification: {
            headline: "Which roles?",
            choices: [{ id: "fte", label: "Full-time only", intent: "primary" }],
            canAskFollowUp: false,
          },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        result: { text: "Done.", toolCalls: [] },
      });
    const { result } = renderHook(() => useAgentChatSession(makeConfig(runAgent)));

    act(() => result.current.actions.send("bump"));
    await waitFor(() => expect(result.current.state.clarification).not.toBeNull());

    act(() => result.current.actions.answerClarification("fte"));
    await waitFor(() => expect(runAgent).toHaveBeenCalledTimes(2));

    const secondRequest = runAgent.mock.calls[1]?.[0];
    const history = secondRequest?.history ?? [];

    // The assistant history carries ONE compact summarized line: the question
    // AND the answer, so the model sees it already asked and won't re-ask.
    const assistantTurns = history.filter((turn) => turn.role === "assistant");
    const assistantText = assistantTurns.map((turn) => turn.content).join(" | ");
    expect(assistantText).toContain("Asked: Which roles?");
    expect(assistantText).toContain("user answered: Full-time only");

    // At most once per role: the answer text appears at most once in assistant
    // role (the summarized line) and at most once in user role (the prompt).
    const answerCountInRole = (role: "user" | "assistant") =>
      history
        .filter((turn) => turn.role === role)
        .filter((turn) => turn.content.includes("Full-time only")).length;
    expect(answerCountInRole("assistant")).toBeLessThanOrEqual(1);
    expect(answerCountInRole("user")).toBeLessThanOrEqual(1);

    // The ANSWER also reaches the backend once in user role via the resumed
    // prompt + the structured clarificationAnswer.
    expect(secondRequest?.prompt).toBe("Full-time only");
    expect(secondRequest?.clarificationAnswer).toEqual({ choiceId: "fte", followUp: null });
  });

  it("caps the ANSWER portion of the history summary; the resumed prompt stays full", async () => {
    // qodo fix: historyText is durable context replayed on every later turn, so
    // a huge pasted answer must not balloon the assistant history line. The full
    // text still reaches the model ONCE, in user role, via the resumed prompt.
    const longAnswer = "x".repeat(2_000);
    const runAgent = vi
      .fn<RunAgent<Draft>>()
      .mockResolvedValueOnce({
        ok: true,
        result: {
          text: "",
          toolCalls: [],
          clarification: {
            headline: "Paste the rows?",
            choices: [],
            canAskFollowUp: true,
          },
        },
      })
      .mockResolvedValueOnce({ ok: true, result: { text: "Done.", toolCalls: [] } })
      .mockResolvedValueOnce({ ok: true, result: { text: "Again.", toolCalls: [] } });
    const { result } = renderHook(() => useAgentChatSession(makeConfig(runAgent)));

    act(() => result.current.actions.send("cuts"));
    await waitFor(() => expect(result.current.state.clarification).not.toBeNull());

    act(() => result.current.actions.answerClarification(null, longAnswer));
    await waitFor(() => expect(runAgent).toHaveBeenCalledTimes(2));
    // The resumed prompt carries the FULL answer (once, user role).
    expect(runAgent.mock.calls[1]?.[0]?.prompt).toBe(longAnswer);

    // A LATER turn's history carries the capped summary, not the full paste.
    act(() => result.current.actions.send("next question"));
    await waitFor(() => expect(runAgent).toHaveBeenCalledTimes(3));
    const laterHistory = runAgent.mock.calls[2]?.[0]?.history ?? [];
    const summarized = laterHistory.find(
      (turn) => turn.role === "assistant" && turn.content.includes("user answered:"),
    );
    expect(summarized).toBeDefined();
    // Capped at 500 chars of answer + ellipsis — far below the 2,000-char paste.
    expect(summarized!.content).toContain("…");
    expect(summarized!.content.length).toBeLessThan(700);
    expect(summarized!.content).not.toContain("x".repeat(600));
  });

  it("drops an EMPTY clarification answer (no choice, no follow-up)", async () => {
    const runAgent = vi.fn<RunAgent<Draft>>(async () => ({
      ok: true,
      result: {
        text: "One check first.",
        toolCalls: [],
        clarification: { headline: "Which roles?", choices: [], canAskFollowUp: true },
      },
    }));
    const { result } = renderHook(() => useAgentChatSession(makeConfig(runAgent)));

    act(() => result.current.actions.send("bump them"));
    await waitFor(() => expect(result.current.state.clarification).not.toBeNull());
    expect(runAgent).toHaveBeenCalledTimes(1);

    // Empty answer: null choice + empty/whitespace follow-up → no run.
    act(() => result.current.actions.answerClarification(null, "   "));
    act(() => result.current.actions.answerClarification(null));
    expect(runAgent).toHaveBeenCalledTimes(1);

    // A real follow-up DOES resume the run.
    act(() => result.current.actions.answerClarification(null, "full-time only"));
    await waitFor(() => expect(runAgent).toHaveBeenCalledTimes(2));
  });

  it("passes a clarification choice + follow-up into the resumed run", async () => {
    const runAgent = vi.fn<RunAgent<Draft>>(async () => ({
      ok: true,
      result: {
        text: "Which?",
        toolCalls: [],
        clarification: {
          headline: "Which roles?",
          choices: [{ id: "fte", label: "Full-time only", intent: "primary" }],
          canAskFollowUp: true,
        },
      },
    }));
    const { result } = renderHook(() => useAgentChatSession(makeConfig(runAgent)));

    act(() => result.current.actions.send("bump"));
    await waitFor(() => expect(result.current.state.clarification).not.toBeNull());

    act(() => result.current.actions.answerClarification("fte", "and only senior"));
    await waitFor(() => expect(runAgent).toHaveBeenCalledTimes(2));

    const secondCall = runAgent.mock.calls[1]?.[0];
    expect(secondCall?.clarificationAnswer).toEqual({
      choiceId: "fte",
      followUp: "and only senior",
    });
  });

  it("surfaces a backend error without appending an agent turn", async () => {
    const runAgent = vi.fn<RunAgent<Draft>>(async () => ({
      ok: false,
      error: { message: "backend down" },
    }));
    const { result } = renderHook(() => useAgentChatSession(makeConfig(runAgent)));

    act(() => result.current.actions.send("hi"));
    await waitFor(() => expect(result.current.state.error).toBe("backend down"));
    // Only the human turn landed; no agent bubble on error.
    expect(result.current.state.messages).toHaveLength(1);
    expect(result.current.state.messages[0]?.role).toBe("human");
  });
});
