import { describe, expect, it } from "vitest";
import { executeArtifactComputation } from "./index";

describe("isolated artifact computation", () => {
  it("groups and conditionally transforms bulk data repeatably with supplied IDs", async () => {
    const input = {
      ids: { staff: "allocated-staff", contractor: "allocated-contractor" },
      rows: Array.from({ length: 20_000 }, (_, n) => ({
        kind: n % 2 ? "staff" : "contractor",
        amount: 100,
      })),
    };
    const code = `(input) => {
      const totals = {};
      for (const row of input.rows) totals[row.kind] = (totals[row.kind] || 0) + row.amount * (row.kind === "staff" ? 12 : 1);
      return Object.keys(totals).sort().map(kind => ({id: input.ids[kind], total: totals[kind]}));
    }`;
    const first = await executeArtifactComputation({ code, input });
    const second = await executeArtifactComputation({ code, input });
    expect(first.value).toEqual([
      { id: "allocated-contractor", total: 1_000_000 },
      { id: "allocated-staff", total: 12_000_000 },
    ]);
    expect(second.value).toEqual(first.value);
    expect(input.rows[0]?.amount).toBe(100);
    console.info(
      "compute-spike-20000",
      JSON.stringify({ first: first.metrics, repeat: second.metrics }),
    );
  });

  it("has no host capabilities, ambient time or randomness", async () => {
    const result = await executeArtifactComputation({
      code: `() => [typeof process, typeof require, typeof fetch, typeof Bun, typeof Deno, typeof WebAssembly, typeof Date, typeof Math.random, typeof performance, typeof crypto]`,
      input: {},
    });
    expect(result.value).toEqual(Array(10).fill("undefined"));
    await expect(
      executeArtifactComputation({ code: `() => fetch("https://example.com")`, input: {} }),
    ).rejects.toThrow();
    await expect(
      executeArtifactComputation({ code: `() => Function("return process")()`, input: {} }),
    ).rejects.toThrow();
  });

  it("interrupts an infinite loop and leaves the next invocation usable", async () => {
    await expect(
      executeArtifactComputation({
        code: `() => { while (true) {} }`,
        input: {},
        limits: { timeoutMs: 20 },
      }),
    ).rejects.toThrow(/interrupt/i);
    expect(
      (await executeArtifactComputation({ code: `(input) => input`, input: { recovered: true } }))
        .value,
    ).toEqual({ recovered: true });
  });

  it("enforces heap, input, output, and stack bounds", async () => {
    await expect(
      executeArtifactComputation({
        code: `() => Array(200000).fill("large")`,
        input: {},
        limits: { memoryBytes: 512 * 1024 },
      }),
    ).rejects.toThrow();
    await expect(
      executeArtifactComputation({
        code: `(input) => input`,
        input: { value: "123456789" },
        limits: { inputBytes: 5 },
      }),
    ).rejects.toThrow(/input limit/);
    await expect(
      executeArtifactComputation({
        code: `() => "界".repeat(20)`,
        input: {},
        limits: { outputBytes: 30 },
      }),
    ).rejects.toThrow(/output limit/);
    await expect(
      executeArtifactComputation({
        code: `() => { function recur() { return recur(); } return recur(); }`,
        input: {},
      }),
    ).rejects.toThrow();
  });

  it("rejects asynchronous, non-JSON, and caller-raised limits", async () => {
    await expect(executeArtifactComputation({ code: `async () => 1`, input: {} })).rejects.toThrow(
      /Async/,
    );
    await expect(
      executeArtifactComputation({ code: `() => undefined`, input: {} }),
    ).rejects.toThrow(/JSON/);
    await expect(
      executeArtifactComputation({ code: `() => 1`, input: {}, limits: { timeoutMs: 20_000 } }),
    ).rejects.toThrow(/Invalid computation limit/);
  });

  it("does not retain modified globals or input across invocations", async () => {
    await executeArtifactComputation({
      code: `(input) => { globalThis.previous = 42; input.value = 2; return input; }`,
      input: { value: 1 },
    });
    expect(
      (
        await executeArtifactComputation({
          code: `input => ({previous: typeof previous, value: input.value})`,
          input: { value: 1 },
        })
      ).value,
    ).toEqual({ previous: "undefined", value: 1 });
  });
});
