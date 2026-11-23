import { runRules, type Rule, type RuleEvent } from "../index";

import nodeAssert from "node:assert/strict";
import { describe, it } from "vite-plus/test";

function assert(condition: unknown, message: string): asserts condition {
  nodeAssert(condition, message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  nodeAssert.equal(actual, expected, message);
}

async function testRulesEngine() {
  type Event = RuleEvent<"start" | "follow_up" | "ignored", { id: string }>;
  const seen: string[] = [];
  const rules: Array<Rule<Event, { enabled: boolean }>> = [
    {
      id: "start-rule",
      eventTypes: ["start"],
      when: ({ context }) => context.enabled,
      run: ({ event, emit }) => {
        seen.push(`start:${event.payload.id}`);
        emit({ type: "follow_up", payload: { id: "next" } });
      },
    },
    {
      id: "follow-rule",
      eventTypes: ["follow_up"],
      run: ({ event }) => {
        seen.push(`follow:${event.payload.id}`);
      },
    },
    {
      id: "never-rule",
      eventTypes: ["ignored"],
      run: () => {
        throw new Error("should not run");
      },
    },
  ];

  const result = await runRules<Event, { enabled: boolean }>({
    event: { type: "start", payload: { id: "root" } },
    context: { enabled: true },
    rules,
  });

  assertEqual(seen.join(","), "start:root,follow:next", "rules run emitted events in order");
  assertEqual(result.failures.length, 0, "rules run without failures");
  assert(result.ran.includes("start-rule"), "start rule ran");
  assert(result.ran.includes("follow-rule"), "follow-up rule ran");
  assert(result.skipped.includes("never-rule"), "unmatched rule was skipped");

  const capped = await runRules<Event, { enabled: boolean }>({
    event: { type: "start", payload: { id: "root" } },
    context: { enabled: true },
    maxEmittedEvents: 0,
    rules,
  });
  assertEqual(capped.failures.length, 1, "best-effort mode records emission cap failure");
  assertEqual(capped.emitted.length, 0, "failed rule emissions are not flushed");
  assert(!capped.ran.includes("start-rule"), "failed rule is not marked as ran");

  const throwingError = new Error("stop here");
  const throwingRule: Rule<Event, { enabled: boolean }> = {
    id: "throwing-rule",
    eventTypes: ["start"],
    run: () => {
      throw throwingError;
    },
  };
  try {
    await runRules<Event, { enabled: boolean }>({
      event: { type: "start", payload: { id: "root" } },
      context: { enabled: true },
      failureMode: "throw",
      rules: [throwingRule],
    });
    throw new Error("throw failureMode did not throw");
  } catch (error) {
    assert(error === throwingError, "throw failureMode preserves the original error");
  }
}

describe("rules engine", () => {
  it("runs matching rules", async () => {
    await testRulesEngine();
  });
});
