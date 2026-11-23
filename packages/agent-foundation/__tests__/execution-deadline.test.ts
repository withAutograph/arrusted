import { describe, expect, it, vi } from "vite-plus/test";

import { createAgentExecutionDeadline } from "../index";

describe("AgentExecutionDeadline", () => {
  it("rejects deadlines that the runtime timer cannot represent", () => {
    expect(() => createAgentExecutionDeadline({ maxWallTimeMs: 2_147_483_648 })).toThrow(
      /maxWallTimeMs/,
    );
    expect(() => createAgentExecutionDeadline({ maxWallTimeMs: 1.5 })).toThrow(/maxWallTimeMs/);
    expect(() => createAgentExecutionDeadline({ maxWallTimeMs: -1 })).toThrow(/maxWallTimeMs/);
  });

  it("terminates immediately for a zero deadline", () => {
    const deadline = createAgentExecutionDeadline({ maxWallTimeMs: 0 });
    expect(deadline.termination()).toEqual({ cause: "deadline" });
    expect(deadline.abortSignal.aborted).toBe(true);
    deadline.dispose();
  });

  it("uses absolute wall time when the timer callback is delayed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const deadline = createAgentExecutionDeadline({ maxWallTimeMs: 10 });
      vi.setSystemTime(11);

      expect(deadline.termination()).toEqual({ cause: "deadline" });
      expect(deadline.abortSignal.aborted).toBe(true);
      deadline.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves the first deadline or caller-cancellation cause", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const callerFirst = new AbortController();
      const cancelled = createAgentExecutionDeadline({
        maxWallTimeMs: 10,
        callerAbortSignal: callerFirst.signal,
      });
      callerFirst.abort();
      vi.advanceTimersByTime(10);
      expect(cancelled.termination()).toEqual({ cause: "caller_abort" });
      cancelled.dispose();

      const deadlineFirst = new AbortController();
      const timedOut = createAgentExecutionDeadline({
        maxWallTimeMs: 10,
        callerAbortSignal: deadlineFirst.signal,
      });
      vi.advanceTimersByTime(10);
      deadlineFirst.abort();
      expect(timedOut.termination()).toEqual({ cause: "deadline" });
      timedOut.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
