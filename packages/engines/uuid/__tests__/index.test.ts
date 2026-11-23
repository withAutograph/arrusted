import { safeUuid } from "../index";

import nodeAssert from "node:assert/strict";
import { describe, it } from "vite-plus/test";

function assert(condition: unknown, message: string): asserts condition {
  nodeAssert(condition, message);
}

// `safeUuid()` is backed by `crypto.randomUUID()`. Shape check: output must match the v4 UUID layout so
// callers (`stageNewRecord`, `useApplyChangeSet` idempotency key, HC
// bulk-group id) get a stable key shape.
function testSafeUuid() {
  const re = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  for (let i = 0; i < 8; i++) {
    const id = safeUuid();
    assert(re.test(id), `safeUuid: must be v4-shaped — got "${id}"`);
  }
  // Uniqueness sanity (not a cryptographic guarantee; just catches the
  // "returns the same string" regression).
  const a = safeUuid();
  const b = safeUuid();
  assert(a !== b, "safeUuid: consecutive calls must differ");
}

describe("uuid engine", () => {
  it("generates safe UUID values", () => {
    testSafeUuid();
  });
});
