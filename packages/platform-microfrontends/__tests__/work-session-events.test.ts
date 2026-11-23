// @vitest-environment node
import { expect, it } from "vitest";
import type { PostgresDataContext } from "@autograph/generated-app-runtime/postgres";
import {
  workSessionEventsResponse,
  type WorkSessionListener,
} from "../src/policy/verified-data-context";

const sessionId = "00000000-0000-4000-8000-000000000001";
const runtime = {
  databaseUrl:
    "postgresql://app_runtime:private-password@127.0.0.1:5432/app_fixture?sslmode=disable",
  database: "app_fixture",
  hostname: "127.0.0.1",
  port: 5432,
  runtimeRole: "app_runtime",
  environment: "local" as const,
};

/** A listener that records its calls and lets the test deliver notifications. */
function fakeListener(log: string[]) {
  const handlers: Record<string, (value: never) => void> = {};
  const listener: WorkSessionListener = {
    query: async (sql) => {
      log.push(sql);
    },
    on: (event: string, handler: (value: never) => void) => {
      handlers[event] = handler;
    },
    end: async () => {
      log.push("end");
    },
  } as WorkSessionListener;
  return {
    listener,
    notify: (payload: string) =>
      (handlers.notification as (m: { channel: string; payload: string }) => void)({
        channel: "kernel_work_session",
        payload,
      }),
    close: () => (handlers.end as () => void)(),
  };
}

/** A data context whose session read answers `revision`, or refuses. */
function fakeContext(
  log: string[],
  revision: number | Error,
  duringRead: () => void = () => {},
): PostgresDataContext {
  return {
    scope: { appId: "fixture-app", customerId: "tenant" },
    authorize: async (capability: string) => {
      log.push(capability);
    },
    transaction: async (run: (db: unknown) => unknown) =>
      run({
        call: async () => {
          log.push("get");
          duringRead();
          if (revision instanceof Error) throw revision;
          return {
            id: sessionId,
            owner_id: "actor",
            title: "Session",
            as_of: "2026-01-01",
            scope: {},
            layout: {},
            pinned: false,
            status: "active",
            revision,
            rules: {},
            threads: {},
          };
        },
      }),
  } as unknown as PostgresDataContext;
}

async function read(stream: ReadableStream<Uint8Array>, events: number) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (text.split("\n\n").length <= events) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  reader.releaseLock();
  return text;
}

it("listens before reading, then streams only this customer's session revisions", async () => {
  const log: string[] = [];
  const { listener, notify } = fakeListener(log);
  const abort = new AbortController();
  const response = await workSessionEventsResponse({
    context: fakeContext(log, 3),
    schemaVersion: "v1",
    runtime,
    sessionId,
    signal: abort.signal,
    connect: async () => listener,
  });
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  expect(log).toEqual([
    "listen kernel_work_session; listen kernel_canonical",
    "work_session.get_without_overlay",
    "get",
  ]);
  notify(`other-tenant:${sessionId}:9`);
  notify(`tenant:00000000-0000-4000-8000-000000000009:9`);
  notify(`tenant:${sessionId}:4`);
  expect(await read(response.body!, 2)).toBe(
    "event: revision\ndata: 3\n\nevent: revision\ndata: 4\n\n",
  );
  abort.abort();
  expect(log.at(-1)).toBe("end");
});

it("closes the listener and streams nothing when the session cannot be read", async () => {
  const log: string[] = [];
  const { listener } = fakeListener(log);
  await expect(
    workSessionEventsResponse({
      context: fakeContext(log, new Error("authorization_denied: session is unavailable")),
      schemaVersion: "v1",
      runtime,
      sessionId,
      signal: new AbortController().signal,
      connect: async () => listener,
    }),
  ).rejects.toThrow("authorization_denied");
  expect(log.at(-1)).toBe("end");
});

it("keeps a revision committed while the session is being read", async () => {
  const log: string[] = [];
  const { listener, notify } = fakeListener(log);
  const abort = new AbortController();
  const response = await workSessionEventsResponse({
    context: fakeContext(log, 3, () => notify(`tenant:${sessionId}:4`)),
    schemaVersion: "v1",
    runtime,
    sessionId,
    signal: abort.signal,
    connect: async () => listener,
  });
  expect(await read(response.body!, 2)).toBe(
    "event: revision\ndata: 3\n\nevent: revision\ndata: 4\n\n",
  );
  abort.abort();
});

it("matches revisions by the session id the read returns, not the requested spelling", async () => {
  const log: string[] = [];
  const { listener, notify } = fakeListener(log);
  const abort = new AbortController();
  const response = await workSessionEventsResponse({
    context: fakeContext(log, 3),
    schemaVersion: "v1",
    runtime,
    sessionId: sessionId.toUpperCase(),
    signal: abort.signal,
    connect: async () => listener,
  });
  notify(`tenant:${sessionId}:4`);
  expect(await read(response.body!, 2)).toBe(
    "event: revision\ndata: 3\n\nevent: revision\ndata: 4\n\n",
  );
  abort.abort();
});

it("ends once, quietly, when the reader cancels or the connection closes", async () => {
  const log: string[] = [];
  const { listener, notify, close } = fakeListener(log);
  const abort = new AbortController();
  const response = await workSessionEventsResponse({
    context: fakeContext(log, 3),
    schemaVersion: "v1",
    runtime,
    sessionId,
    signal: abort.signal,
    connect: async () => listener,
  });
  await response.body!.cancel();
  // Later events reach a closed stream without throwing.
  notify(`tenant:${sessionId}:4`);
  abort.abort();
  close();
  expect(log.filter((line) => line === "end")).toEqual(["end"]);

  const second = fakeListener(log);
  const closed = await workSessionEventsResponse({
    context: fakeContext(log, 5),
    schemaVersion: "v1",
    runtime,
    sessionId,
    signal: new AbortController().signal,
    connect: async () => second.listener,
  });
  const reader = closed.body!.getReader();
  await reader.read();
  second.close();
  expect((await reader.read()).done).toBe(true);
});

it("ends the listener when the browser disconnects during the session read", async () => {
  const log: string[] = [];
  const { listener } = fakeListener(log);
  const abort = new AbortController();
  const response = await workSessionEventsResponse({
    context: fakeContext(log, 3, () => {
      abort.abort();
      log.push("read returns");
    }),
    schemaVersion: "v1",
    runtime,
    sessionId,
    signal: abort.signal,
    connect: async () => listener,
  });
  expect(log.slice(-3)).toEqual(["get", "end", "read returns"]);
  const reader = response.body!.getReader();
  await reader.read();
  expect((await reader.read()).done).toBe(true);
  expect(log.filter((line) => line === "end")).toEqual(["end"]);

  const before = new AbortController();
  before.abort();
  const second = fakeListener(log);
  await workSessionEventsResponse({
    context: fakeContext(log, 3),
    schemaVersion: "v1",
    runtime,
    sessionId,
    signal: before.signal,
    connect: async () => second.listener,
  });
  expect(log.filter((line) => line === "end")).toEqual(["end", "end"]);
});

it("ends quietly when the browser left before the listener could listen", async () => {
  const log: string[] = [];
  const { listener } = fakeListener(log);
  // An ended client refuses its next query.
  listener.query = (async () => {
    throw new Error("Client was closed and is not queryable");
  }) as WorkSessionListener["query"];
  const before = new AbortController();
  before.abort();
  const response = await workSessionEventsResponse({
    context: fakeContext(log, 3),
    schemaVersion: "v1",
    runtime,
    sessionId,
    signal: before.signal,
    connect: async () => listener,
  });
  expect(response.body).toBeNull();
  expect(log).toEqual(["end"]);
});

it("forwards a data event when published data of its app and customer changes", async () => {
  const log: string[] = [];
  const handlers: Record<string, (value: never) => void> = {};
  const listener = {
    query: async (sql: string) => {
      log.push(sql);
    },
    on: (event: string, handler: (value: never) => void) => {
      handlers[event] = handler;
    },
    end: async () => {},
  } as unknown as WorkSessionListener;
  const publish = (channel: string, payload: string) =>
    (handlers.notification as (m: { channel: string; payload: string }) => void)({
      channel,
      payload,
    });
  const abort = new AbortController();
  const response = await workSessionEventsResponse({
    context: fakeContext(log, 3, () => publish("kernel_canonical", "fixture-app:tenant")),
    schemaVersion: "v1",
    runtime,
    sessionId,
    signal: abort.signal,
    connect: async () => listener,
  });
  publish("kernel_canonical", "other-app:tenant");
  publish("kernel_canonical", "fixture-app:other-tenant");
  publish("kernel_canonical", "fixture-app:tenant");
  expect(await read(response.body!, 3)).toBe(
    "event: revision\ndata: 3\n\nevent: data\ndata: \n\nevent: data\ndata: \n\n",
  );
  abort.abort();
});
