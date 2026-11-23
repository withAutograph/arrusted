import type { ErrorEnvelope, KernelClient } from "@contracts";

export type { ErrorEnvelope, KernelClient } from "@contracts";

export { useActiveSchema, type UseSchemaResult } from "./hooks/useActiveSchema";
export { invalidateSchema } from "./hooks/schema-version";

export function createFetchKernelClient(baseUrl = ""): KernelClient {
  return {
    async getJson<T>(path: string): Promise<T> {
      const response = await fetch(`${baseUrl}${path}`);
      return decodeResponse<T>(response);
    },
    async postJson<T>(path: string, body: unknown, init?: { signal?: AbortSignal }): Promise<T> {
      const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: init?.signal,
      });
      return decodeResponse<T>(response);
    },
  };
}

export type CachedKernelClient = KernelClient & {
  clearCache(): void;
};

export type CachedKernelClientOptions = {
  readTtlMs?: number;
};

type CachedRead = {
  promise: Promise<unknown>;
  settled: boolean;
  expiresAt: number;
  evictionTimer?: ReturnType<typeof setTimeout>;
};

export function createCachedKernelClient(
  client: KernelClient,
  options: CachedKernelClientOptions = {},
): CachedKernelClient {
  const readTtlMs = options.readTtlMs ?? 0;
  const reads = new Map<string, CachedRead>();

  function deleteRead(path: string, entry: CachedRead) {
    if (entry.evictionTimer) clearTimeout(entry.evictionTimer);
    if (reads.get(path) === entry) reads.delete(path);
  }

  function scheduleEviction(path: string, entry: CachedRead) {
    if (readTtlMs <= 0) {
      deleteRead(path, entry);
      return;
    }
    if (reads.get(path) !== entry) return;
    entry.evictionTimer = setTimeout(() => {
      if (reads.get(path) === entry) reads.delete(path);
    }, readTtlMs);
  }

  function clearCache() {
    for (const entry of reads.values()) {
      if (entry.evictionTimer) clearTimeout(entry.evictionTimer);
    }
    reads.clear();
  }

  return {
    clearCache,
    async getJson<T>(path: string): Promise<T> {
      const cached = reads.get(path);
      if (cached && (!cached.settled || cached.expiresAt > Date.now())) {
        return cloneCachedPayload(await cached.promise) as T;
      }
      if (cached) deleteRead(path, cached);

      const entry: CachedRead = {
        promise: Promise.resolve(undefined),
        settled: false,
        expiresAt: Number.POSITIVE_INFINITY,
      };
      entry.promise = client
        .getJson<T>(path)
        .then((value) => {
          entry.settled = true;
          entry.expiresAt = Date.now() + readTtlMs;
          scheduleEviction(path, entry);
          return value;
        })
        .catch((error: unknown) => {
          entry.settled = true;
          deleteRead(path, entry);
          throw error;
        });
      reads.set(path, entry);
      return cloneCachedPayload(await entry.promise) as T;
    },
    async postJson<T>(path: string, body: unknown, init?: { signal?: AbortSignal }): Promise<T> {
      clearCache();
      try {
        return await client.postJson<T>(path, body, init);
      } finally {
        clearCache();
      }
    },
  };
}

function cloneCachedPayload<T>(value: T): T {
  return structuredClone(value);
}

export async function decodeResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw normalizeErrorEnvelope(payload, response.status);
  }
  return payload as T;
}

export function normalizeErrorEnvelope(value: unknown, status = 500): ErrorEnvelope {
  if (value && typeof value === "object" && "code" in value && "message" in value) {
    const candidate = value as Partial<ErrorEnvelope>;
    const details = Array.isArray(candidate.details)
      ? candidate.details.map((detail) => {
          const detailObject = detail && typeof detail === "object" ? detail : {};
          return {
            path:
              "path" in detailObject && typeof detailObject.path === "string"
                ? detailObject.path
                : "",
            code:
              "code" in detailObject && typeof detailObject.code === "string"
                ? detailObject.code
                : "unknown_detail",
            message:
              "message" in detailObject && typeof detailObject.message === "string"
                ? detailObject.message
                : "",
          };
        })
      : [];
    return {
      code: String(candidate.code),
      message: String(candidate.message),
      details,
    };
  }
  if (value && typeof value === "object" && "error" in value) {
    return {
      code: "http_error",
      message: String((value as { error: unknown }).error),
      details: [{ path: "", code: String(status), message: "HTTP request failed" }],
    };
  }
  return {
    code: "http_error",
    message: `Request failed with status ${status}.`,
    details: [],
  };
}
