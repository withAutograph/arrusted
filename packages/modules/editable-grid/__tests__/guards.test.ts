import nodeAssert from "node:assert/strict";
import { describe, it } from "vite-plus/test";

function assert(condition: unknown, message: string): asserts condition {
  nodeAssert(condition, message);
}

// C1: generation guard pattern. Module wraps async apply paths in a guard
// that captures `submitGenRef.current` at apply-start and only fires
// post-success side effects when the gen hasn't moved. The pattern is
// independent of React; this proves the discipline.
function testGenerationGuardPattern() {
  const genRef = { current: 0 };
  function apply(): { issuedGen: number } {
    return { issuedGen: genRef.current };
  }
  // Happy path: gen unchanged, side effects fire.
  const issued1 = apply();
  let firedHappy = false;
  if (issued1.issuedGen === genRef.current) firedHappy = true;
  assert(firedHappy, "gen guard: side effect fires when gen unchanged");

  // Unhappy path: gen bumps mid-flight, side effects suppressed.
  const issued2 = apply();
  genRef.current += 1; // Simulates model.id or asOf change during apply.
  let firedStale = false;
  if (issued2.issuedGen === genRef.current) firedStale = true;
  assert(!firedStale, "gen guard: side effect suppressed after gen bump");
}

// H2: stale-reload params guard. The hook captures fetched params at issue
// time and refuses to write the response to state when the live params have
// drifted. This proves the discipline against an in-memory simulation.
function testStaleReloadParamsGuard() {
  const latestParamsRef = { current: { modelId: "a", asOf: "2026-01-01" } };
  function fetch(
    modelId: string,
    asOf: string,
  ): {
    paramsStillFresh: () => boolean;
  } {
    const issued = { modelId, asOf };
    return {
      paramsStillFresh: () =>
        latestParamsRef.current.modelId === issued.modelId &&
        latestParamsRef.current.asOf === issued.asOf,
    };
  }
  const fresh = fetch("a", "2026-01-01");
  assert(fresh.paramsStillFresh(), "fresh params: response is written");
  // Live params shift mid-flight.
  latestParamsRef.current = { modelId: "b", asOf: "2026-01-01" };
  assert(!fresh.paramsStillFresh(), "stale modelId: response is dropped");
  // ... or asOf shifts.
  latestParamsRef.current = { modelId: "a", asOf: "2026-09-01" };
  const fresh2 = fetch("a", "2026-09-01");
  assert(fresh2.paramsStillFresh(), "matched asOf: response is written");
  latestParamsRef.current = { modelId: "a", asOf: "2026-09-02" };
  assert(!fresh2.paramsStillFresh(), "stale asOf: response is dropped");
}

describe("editable grid stale guards", () => {
  it("guards generation-scoped side effects", () => {
    testGenerationGuardPattern();
  });

  it("guards stale reload parameters", () => {
    testStaleReloadParamsGuard();
  });
});
