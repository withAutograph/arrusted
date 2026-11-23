// @vitest-environment node
import { expect, it } from "vitest";
import { protectedDataPayloadSha256 } from "../src/policy/verified-data-context";

it("hashes validated DTOs with stable field order while retaining ordered operations", () => {
  expect(protectedDataPayloadSha256({ amount: 20, notes: null })).toBe(
    protectedDataPayloadSha256({ notes: null, amount: 20 }),
  );
  expect(protectedDataPayloadSha256(["first", "second"])).not.toBe(
    protectedDataPayloadSha256(["second", "first"]),
  );
  expect(protectedDataPayloadSha256({ amount: 20 })).not.toBe(
    protectedDataPayloadSha256({ amount: "20" }),
  );
});
it("rejects lossy and cyclic payload representations", () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const sparse: unknown[] = [];
  sparse.length = 2;
  for (const value of [NaN, Infinity, new Date(), { missing: undefined }, sparse, cycle])
    expect(() => protectedDataPayloadSha256(value as never)).toThrow(
      "Protected Gateway data context is unavailable",
    );
});
