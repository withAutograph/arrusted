import { describe, expect, it, vi } from "vite-plus/test";

import type { KernelClient } from "@contracts";

import { createCachedKernelClient } from "../index";

function makeClient(): KernelClient & {
  getJson: ReturnType<typeof vi.fn>;
  postJson: ReturnType<typeof vi.fn>;
} {
  return {
    getJson: vi.fn(async (path: string) => ({ path })),
    postJson: vi.fn(async (_path: string, body: unknown) => ({ body })),
  } as KernelClient & {
    getJson: ReturnType<typeof vi.fn>;
    postJson: ReturnType<typeof vi.fn>;
  };
}

describe("createCachedKernelClient", () => {
  it("deduplicates concurrent reads for the same path", async () => {
    const baseClient = makeClient();
    const client = createCachedKernelClient(baseClient, { readTtlMs: 2_000 });

    const [first, second] = await Promise.all([
      client.getJson("/api/schema"),
      client.getJson("/api/schema"),
    ]);

    expect(first).toEqual({ path: "/api/schema" });
    expect(second).toEqual({ path: "/api/schema" });
    expect(baseClient.getJson).toHaveBeenCalledTimes(1);
  });

  it("briefly reuses fulfilled reads and clears them on writes", async () => {
    const baseClient = makeClient();
    const client = createCachedKernelClient(baseClient, { readTtlMs: 2_000 });

    await client.getJson("/api/records?model_id=position");
    await client.getJson("/api/records?model_id=position");
    expect(baseClient.getJson).toHaveBeenCalledTimes(1);

    await client.postJson("/api/write", {});
    await client.getJson("/api/records?model_id=position");

    expect(baseClient.postJson).toHaveBeenCalledTimes(1);
    expect(baseClient.getJson).toHaveBeenCalledTimes(2);
  });

  it("returns cloned cached payloads so callers cannot mutate shared data", async () => {
    const baseClient = makeClient();
    baseClient.getJson.mockResolvedValueOnce({
      rows: [{ record_id: "position:1", name: "Original" }],
    });
    const client = createCachedKernelClient(baseClient, { readTtlMs: 2_000 });

    const first = await client.getJson<{
      rows: Array<{ record_id: string; name: string }>;
    }>("/api/records?model_id=position");
    const firstRow = first.rows[0];
    if (!firstRow) throw new Error("Expected first cached row");
    firstRow.name = "Mutated";
    const second = await client.getJson<{
      rows: Array<{ record_id: string; name: string }>;
    }>("/api/records?model_id=position");
    const secondRow = second.rows[0];
    if (!secondRow) throw new Error("Expected second cached row");

    expect(secondRow.name).toBe("Original");
    expect(first).not.toBe(second);
    expect(firstRow).not.toBe(secondRow);
    expect(baseClient.getJson).toHaveBeenCalledTimes(1);
  });

  it("evicts fulfilled reads after the ttl even without another read for the same path", async () => {
    vi.useFakeTimers();
    try {
      const baseClient = makeClient();
      const client = createCachedKernelClient(baseClient, { readTtlMs: 2_000 });

      await client.getJson("/api/records?as_of=1");
      await vi.advanceTimersByTimeAsync(2_001);

      await client.getJson("/api/records?as_of=2");
      await client.getJson("/api/records?as_of=1");

      expect(baseClient.getJson).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a stale rejected read evict a newer cached read for the same path", async () => {
    const baseClient = makeClient();
    const firstRead = deferred<unknown>();
    const secondRead = deferred<unknown>();
    const reads = [firstRead, secondRead];
    let readIndex = 0;
    baseClient.getJson.mockImplementation(async () => {
      const read = reads[readIndex];
      readIndex += 1;
      if (!read) throw new Error("Unexpected extra read");
      return await read.promise;
    });
    const client = createCachedKernelClient(baseClient, { readTtlMs: 2_000 });

    const staleRead = client.getJson("/api/schema");
    client.clearCache();
    const currentRead = client.getJson("/api/schema");
    secondRead.resolve({ path: "/api/schema", version: 2 });
    await expect(currentRead).resolves.toEqual({ path: "/api/schema", version: 2 });

    firstRead.reject(new Error("stale failure"));
    await expect(staleRead).rejects.toThrow("stale failure");
    await expect(client.getJson("/api/schema")).resolves.toEqual({
      path: "/api/schema",
      version: 2,
    });

    expect(baseClient.getJson).toHaveBeenCalledTimes(2);
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  reject(error: unknown): void;
  resolve(value: T): void;
} {
  let rejectPromise: (error: unknown) => void = () => {};
  let resolvePromise: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    rejectPromise = reject;
    resolvePromise = resolve;
  });
  return { promise, reject: rejectPromise, resolve: resolvePromise };
}
