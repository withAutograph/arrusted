// The browser client: kernel failures keep their code, every read goes to the
// read route and every mutation to its action, and events reconnect.
import { describe, expect, test } from "vitest";
import type { DataDefinition } from "@autograph/generated-app-runtime/data";
import {
  createCanvasClient,
  createCanvasHttpClient,
  type EventSourceLike,
  type TabChannel,
  type TabSharing,
} from "../client";
import type { CanvasHostMutations, CanvasReadRequest } from "../protocol";

const definition = {
  formatVersion: 1,
  schemaVersion: "v1",
  models: [],
} as unknown as DataDefinition;

type Reply = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } };

/**
 * A recorded transport: the mutations (server actions) and the read route's
 * fetch. Each read answers from `readAnswers[read]`, else a default.
 */
function transport(
  overrides: {
    mutations?: Partial<CanvasHostMutations>;
    reads?: Partial<Record<CanvasReadRequest["read"], (body: CanvasReadRequest) => Reply>>;
    status?: number;
  } = {},
) {
  const calls: unknown[][] = [];
  const record =
    <T>(name: string, value: T) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return { ok: true as const, value };
    };
  const mutations: CanvasHostMutations = {
    session: record("session", { revision: 1 }),
    drafts: record("drafts", { ok: true }),
    threads: record("threads", { ok: true }),
    createSession: record("createSession", { sessionId: "s" }),
    ...overrides.mutations,
  };
  const defaults: Record<CanvasReadRequest["read"], Reply> = {
    session: { ok: true, value: [] },
    list: { ok: true, value: [] },
    aggregate: { ok: true, value: {} },
    drafts: { ok: true, value: [] },
    threads: {
      ok: true,
      value: { id: 3, status: "draft", notes: null, threads: { t1: thread }, can_resolve: true },
    },
    authors: { ok: true, value: {} },
  };
  const fetch = async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as CanvasReadRequest;
    calls.push(["read", url, init.method, body]);
    const answer =
      overrides.reads?.[body.read]?.(body) ??
      (body.read === "threads" && body.operation === "by_session"
        ? { ok: true, value: [] }
        : defaults[body.read]);
    return Response.json(answer, { status: overrides.status ?? (answer.ok ? 200 : 422) });
  };
  const options = { fetch };
  const urls = { readUrl: "/app/api/read", eventsUrl: "/app/api/events" };
  return { transport: { mutations, ...urls }, calls, fetch, options };
}

/** A kernel thread as `kernel_draft_threads` returns it. */
const thread = {
  id: "t1",
  anchor: { model_id: "employee", record_id: "e1", field_id: "salary" },
  resolved: false,
  messages: [
    {
      id: "m1",
      actor_id: "user:1",
      author_kind: "human",
      message: "Why?",
      created_at: "2026-10-30T00:00:00Z",
    },
  ],
};

/**
 * One browser's tab sharing in memory: BroadcastChannels by name (a post
 * reaches every other channel of the name) and exclusive locks granted in
 * request order.
 */
function memoryBrowser(): TabSharing {
  const channels = new Map<string, Set<TabChannel>>();
  const queues = new Map<string, { run: () => Promise<void>; signal: AbortSignal }[]>();
  const grant = (name: string) => {
    const queue = queues.get(name) ?? [];
    while (queue[0]?.signal.aborted) queue.shift();
    const next = queue[0];
    if (next === undefined) return;
    void next.run().then(() => {
      queue.shift();
      grant(name);
    });
  };
  const tabs: TabSharing = {
    channel(name) {
      const peers = channels.get(name) ?? new Set<TabChannel>();
      channels.set(name, peers);
      const channel: TabChannel = {
        onmessage: null,
        postMessage: (message) => {
          for (const peer of peers)
            if (peer !== channel) queueMicrotask(() => peer.onmessage?.({ data: message }));
        },
        close: () => peers.delete(channel),
      };
      peers.add(channel);
      return channel;
    },
    lock(name, signal, held) {
      const queue = queues.get(name) ?? [];
      queues.set(name, queue);
      return new Promise((resolve) => {
        queue.push({ signal, run: () => held().then(resolve) });
        if (queue.length === 1) grant(name);
      });
    },
  };
  return tabs;
}

describe("createCanvasClient", () => {
  test("a refused call rejects with the kernel's code; values pass through", async () => {
    const { transport: t, options } = transport({
      mutations: {
        session: async () => ({
          ok: false,
          error: { code: "revision_conflict", message: "stale" },
        }),
      },
      reads: {
        session: () => ({ ok: false, error: { code: "authorization_denied", message: "no" } }),
      },
    });
    const client = createCanvasClient(t, definition, { canApprove: true, ...options });
    await expect(
      client.session.request({
        operation: "stage",
        session_id: "s",
        changes: [],
      }),
    ).rejects.toMatchObject({ envelope: { code: "revision_conflict", message: "stale" } });
    await expect(client.session.request({ operation: "list" })).rejects.toMatchObject({
      envelope: { code: "authorization_denied", message: "no" },
    });
  });

  test("reads go to the read route, mutations to their actions", async () => {
    const { transport: t, calls, options } = transport();
    const client = createCanvasClient(t, definition, { canApprove: true, ...options });
    await client.session.request({ operation: "list" });
    await client.session.request({ operation: "get", session_id: "s", overlay: false });
    await client.session.request({
      operation: "stage",
      session_id: "s",
      changes: [],
    });
    await client.data.list("item", { asOf: "2026-01-01" });
    await client.data.aggregate("item", { asOf: "2026-01-01", metrics: [{ fn: "count" }] });
    await client.drafts!.kernel.postJson("/api/draft/approve", { change_set_id: 3 });
    await client.drafts!.kernel.postJson("/api/diff", { change_set_id: 3 });
    await client.drafts!.kernel.getJson("/api/drafts");
    expect(await client.drafts!.threads.list(3)).toEqual({
      threads: [thread],
      canResolve: true,
      ruleNotes: {},
    });
    await client.drafts!.threads.forSession("s");
    await client.drafts!.threads.reply(3, "t1", "Yes");
    await client.drafts!.threads.reply(3, "t1", "Yes");
    await client.drafts!.threads.resolve(3, "t1");
    const uuid = expect.stringMatching(/^[0-9a-f-]{36}$/u);
    const read = (body: unknown) => ["read", "/app/api/read", "POST", body];
    expect(calls).toEqual([
      read({ read: "session", input: { operation: "list" } }),
      read({ read: "session", input: { operation: "get", session_id: "s", overlay: false } }),
      ["session", { operation: "stage", session_id: "s", changes: [] }],
      read({ read: "list", model: "item", query: { asOf: "2026-01-01" } }),
      read({
        read: "aggregate",
        model: "item",
        query: { asOf: "2026-01-01", metrics: [{ fn: "count" }] },
      }),
      ["drafts", "/api/draft/approve", { change_set_id: 3 }],
      read({ read: "drafts", path: "/api/diff", body: { change_set_id: 3 } }),
      read({ read: "drafts", path: "/api/drafts", body: null }),
      read({ read: "threads", operation: "get", input: { change_set_id: 3 } }),
      read({ read: "threads", operation: "by_session", input: { session_id: "s" } }),
      ["threads", "reply", { change_set_id: 3, thread_id: "t1", message: "Yes", request_id: uuid }],
      ["threads", "reply", { change_set_id: 3, thread_id: "t1", message: "Yes", request_id: uuid }],
      ["threads", "resolve", { change_set_id: 3, thread_id: "t1", request_id: uuid }],
    ]);
    // Each gesture has its own request id; a retried action would reuse it.
    const ids = calls.slice(10).map((call) => (call[2] as { request_id: string }).request_id);
    expect(new Set(ids).size).toBe(3);
    expect(client.drafts!.canApprove).toBe(true);
  });

  test("a read without a coded answer is a transport failure", async () => {
    const { transport: t } = transport();
    const client = createCanvasClient(t, definition, {
      canApprove: false,
      fetch: async () => new Response("Protected request denied", { status: 403 }),
    });
    await expect(client.session.request({ operation: "list" })).rejects.toThrow(
      "The canvas request failed (403).",
    );
  });

  test("draft authors are named from the host, never shown as raw ids", async () => {
    const {
      transport: t,
      calls,
      options,
    } = transport({
      reads: {
        drafts: () => ({
          ok: true,
          value: [
            { id: 1, actor_id: "u1" },
            { id: 2, actor_id: "u2" },
            { id: 3, actor_id: "u1" },
          ],
        }),
        authors: () => ({ ok: true, value: { u1: "Pat Lee" } }),
      },
    });
    const client = createCanvasClient(t, definition, { canApprove: true, ...options });
    expect(client.drafts!.authorName?.("u1")).toBeUndefined();
    await client.drafts!.kernel.getJson("/api/drafts");
    const authorReads = () =>
      calls.filter((call) => (call[3] as CanvasReadRequest).read === "authors");
    expect(authorReads().map((call) => call[3])).toEqual([
      { read: "authors", actor_ids: ["u1", "u2"] },
    ]);
    expect(client.drafts!.authorName?.("u1")).toBe("Pat Lee");
    expect(client.drafts!.authorName?.("u2")).toBeUndefined();
    // An id is asked for once, named or not.
    await client.drafts!.kernel.getJson("/api/drafts");
    expect(authorReads()).toHaveLength(1);
  });

  test("published activity names its authors too", async () => {
    const { transport: t, options } = transport({
      reads: {
        drafts: (body) => ({
          ok: true,
          value:
            body.read === "drafts" && body.path === "/api/activity"
              ? [{ change_set_id: 9, actor_id: "u3" }]
              : [],
        }),
        authors: () => ({ ok: true, value: { u3: "Sam Ortiz" } }),
      },
    });
    const client = createCanvasClient(t, definition, { canApprove: true, ...options });
    await client.drafts!.kernel.postJson("/api/activity", { limit: 25 });
    expect(client.drafts!.authorName?.("u3")).toBe("Sam Ortiz");
  });

  test("a host with no name source in this mode is never asked", async () => {
    const {
      transport: t,
      calls,
      options,
    } = transport({
      reads: { drafts: () => ({ ok: true, value: [{ id: 1, actor_id: "u1" }] }) },
    });
    const client = createCanvasClient(t, definition, {
      canApprove: true,
      authors: false,
      ...options,
    });
    await client.drafts!.kernel.getJson("/api/drafts");
    await client.drafts!.kernel.getJson("/api/drafts");
    expect(calls.some((call) => (call[3] as CanvasReadRequest).read === "authors")).toBe(false);
    expect(client.drafts!.authorName?.("u1")).toBeUndefined();
  });

  test("a draft's threads parse with the canvas's thread schema", async () => {
    const { transport: t, options } = transport({
      reads: {
        threads: () => ({
          ok: true,
          value: { id: 3, status: "draft", notes: null, threads: { t1: { id: "t1" } } },
        }),
      },
    });
    const client = createCanvasClient(t, definition, { canApprove: false, ...options });
    await expect(client.drafts!.threads.list(3)).rejects.toThrow();
  });

  test("a member reads drafts and their threads; Resolve is the host's word", async () => {
    const { transport: t, options } = transport({
      reads: {
        threads: () => ({
          ok: true,
          value: {
            id: 3,
            status: "draft",
            notes: null,
            threads: { t1: thread },
            can_resolve: false,
          },
        }),
        authors: () => ({ ok: true, value: { u1: "Pat Lee" } }),
        drafts: () => ({ ok: true, value: [{ id: 3, actor_id: "u1" }] }),
      },
    });
    const client = createCanvasClient(t, definition, { canApprove: false, ...options });
    expect(client.drafts!.canApprove).toBe(false);
    await client.drafts!.kernel.getJson("/api/drafts");
    expect(client.drafts!.authorName?.("u1")).toBe("Pat Lee");
    expect(await client.drafts!.threads.list(3)).toEqual({
      threads: [thread],
      canResolve: false,
      ruleNotes: {},
    });
  });

  test("subscribe hears revisions and data, and reopens a closed stream", () => {
    const opened: (EventSourceLike & {
      url: string;
      readyState: number;
      closed: boolean;
      emit(type: string, data: string): void;
    })[] = [];
    const timers: (() => void)[] = [];
    const client = createCanvasClient(
      { ...transport().transport, eventsUrl: "/app/api/events/" },
      definition,
      {
        canApprove: false,
        eventSource: (url) => {
          const listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();
          const source = {
            url,
            readyState: 1,
            closed: false,
            onerror: null as ((event: Event) => void) | null,
            onopen: null as ((event: Event) => void) | null,
            addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
              listeners.set(type, [...(listeners.get(type) ?? []), listener]);
            },
            close() {
              source.closed = true;
            },
            emit(type: string, data: string) {
              for (const listener of listeners.get(type) ?? [])
                listener({ data } as MessageEvent<string>);
            },
          };
          opened.push(source);
          return source;
        },
        setTimeout: (run) => timers.push(run),
        clearTimeout: () => {},
      },
    );
    const revisions: number[] = [];
    let data = 0;
    let connects = 0;
    const stop = client.subscribe("s 1", {
      onRevision: (revision) => revisions.push(revision),
      onConnect: () => (connects += 1),
      onData: () => (data += 1),
    });
    expect(opened[0]!.url).toBe("/app/api/events/s%201");
    opened[0]!.onopen?.(new Event("open"));
    opened[0]!.emit("revision", "4");
    opened[0]!.emit("data", "");
    opened[0]!.emit("revision", "nope");
    opened[0]!.emit("revision", "5");
    expect(connects).toBe(1);
    // A CONNECTING source retries on its own: its reopen is a reconnect, even
    // at the same revision.
    opened[0]!.readyState = 0;
    opened[0]!.onerror?.(new Event("error"));
    expect(timers).toHaveLength(0);
    opened[0]!.readyState = 1;
    opened[0]!.onopen?.(new Event("open"));
    opened[0]!.emit("revision", "5");
    expect(connects).toBe(2);
    // A CLOSED one is reopened later, and is a reconnect too.
    opened[0]!.readyState = 2;
    opened[0]!.onerror?.(new Event("error"));
    expect(opened[0]!.closed).toBe(true);
    timers.shift()!();
    opened[1]!.emit("revision", "5");
    expect(connects).toBe(3);
    expect(revisions).toEqual([4, 5, 5, 5]);
    expect(data).toBe(1);
    stop();
    expect(opened[1]!.closed).toBe(true);
  });

  test("subscribers of one session share one stream; a late one hears the last revision", async () => {
    const opened: { url: string; closed: boolean; emit(type: string, data: string): void }[] = [];
    const client = createCanvasClient(transport().transport, definition, {
      canApprove: false,
      eventSource: (url) => {
        const listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();
        const source = {
          url,
          readyState: 1,
          closed: false,
          onerror: null,
          onopen: null,
          addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
            listeners.set(type, [...(listeners.get(type) ?? []), listener]);
          },
          close() {
            source.closed = true;
          },
          emit(type: string, data: string) {
            for (const listener of listeners.get(type) ?? [])
              listener({ data } as MessageEvent<string>);
          },
        };
        opened.push(source);
        return source;
      },
    });
    const heard: string[] = [];
    const stopA = client.subscribe("s", {
      onRevision: (revision) => heard.push(`a${revision}`),
      onData: () => heard.push("a-data"),
    });
    opened[0]!.emit("revision", "3");
    const stopB = client.subscribe("s", {
      onRevision: (revision) => heard.push(`b${revision}`),
      onData: () => heard.push("b-data"),
    });
    await Promise.resolve();
    opened[0]!.emit("data", "");
    expect(opened).toHaveLength(1);
    expect(heard).toEqual(["a3", "b3", "a-data", "b-data"]);
    stopA();
    expect(opened[0]!.closed).toBe(false);
    stopB();
    expect(opened[0]!.closed).toBe(true);
    // Another session has its own stream.
    client.subscribe("t", { onRevision: () => {} });
    expect(opened.map((source) => source.url)).toEqual(["/app/api/events/s", "/app/api/events/t"]);
  });

  test("tabs of one browser share one stream: the lock holder streams, the others hear it", async () => {
    const tabs = memoryBrowser();
    const opened: { closed: boolean; emit(type: string, data: string): void }[] = [];
    const tab = () =>
      createCanvasClient(transport().transport, definition, {
        canApprove: false,
        tabs,
        eventSource: () => {
          const listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();
          const source = {
            readyState: 1,
            closed: false,
            onerror: null,
            onopen: null,
            addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
              listeners.set(type, [...(listeners.get(type) ?? []), listener]);
            },
            close() {
              source.closed = true;
            },
            emit(type: string, data: string) {
              for (const listener of listeners.get(type) ?? [])
                listener({ data } as MessageEvent<string>);
            },
          };
          opened.push(source);
          return source;
        },
      });
    const settle = async () => {
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    };
    const heard: string[] = [];
    const listen = (name: string) => ({
      onRevision: (revision: number) => heard.push(`${name}${revision}`),
      onConnect: () => heard.push(`${name}-connect`),
      onData: () => heard.push(`${name}-data`),
    });
    const stopA = tab().subscribe("s", listen("a"));
    await settle();
    expect(opened).toHaveLength(1);
    opened[0]!.emit("revision", "3");
    // Six more tabs of the canvas: still one stream. Each that joins hears
    // the last revision as its connect; no other tab hears that answer.
    const others = ["b", "c", "d", "e", "f", "g"].map((name) => tab().subscribe("s", listen(name)));
    await settle();
    expect(opened).toHaveLength(1);
    expect(heard.filter((line) => line.endsWith("-connect"))).toEqual(
      ["a", "b", "c", "d", "e", "f", "g"].map((name) => `${name}-connect`),
    );
    heard.length = 0;
    opened[0]!.emit("revision", "4");
    opened[0]!.emit("data", "");
    await settle();
    expect(heard.toSorted()).toEqual(
      ["a", "b", "c", "d", "e", "f", "g"]
        .flatMap((name) => [`${name}-data`, `${name}4`])
        .toSorted(),
    );
    // The streaming tab closes: the next one in line opens its own stream,
    // and every tab hears it as a reconnect.
    heard.length = 0;
    stopA();
    await settle();
    expect(opened[0]!.closed).toBe(true);
    expect(opened).toHaveLength(2);
    opened[1]!.emit("revision", "4");
    await settle();
    expect(heard.toSorted()).toEqual(
      ["b", "c", "d", "e", "f", "g"].flatMap((name) => [`${name}-connect`, `${name}4`]).toSorted(),
    );
    for (const stop of others) stop();
    await settle();
    expect(opened.every((source) => source.closed)).toBe(true);
  });
});

describe("the canvas in a chat: the HTTP client with the person's bearer", () => {
  const bearer = (token: string | null = "tok") => {
    const state = { refused: 0 };
    return {
      state,
      bearer: {
        token: async () => token,
        refused: () => {
          state.refused += 1;
        },
      },
    };
  };

  test("every call goes to the canvas API with the bearer and no cookies, in one schema", async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const fetch = async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return Response.json({ ok: true, value: [] });
    };
    const { bearer: auth } = bearer();
    const client = createCanvasHttpClient(
      { url: "https://apps.test/app/api/canvas/", bearer: auth },
      definition,
      { canApprove: false, fetch },
    );
    await client.session.request({ operation: "list" });
    await client.session.request({
      operation: "unstage",
      session_id: "s",
      targets: [],
    } as never);
    await client.drafts!.kernel.postJson("/api/draft/approve", { change_set_id: 1 });
    expect(sent.map((call) => call.url)).toEqual([
      "https://apps.test/app/api/canvas",
      "https://apps.test/app/api/canvas",
      "https://apps.test/app/api/canvas",
    ]);
    for (const call of sent) {
      expect(new Headers(call.init.headers).get("authorization")).toBe("Bearer tok");
      expect(call.init.credentials).toBe("omit");
    }
    expect(sent.map((call) => JSON.parse(String(call.init.body)))).toEqual([
      { call: "read", request: { read: "session", input: { operation: "list" } } },
      expect.objectContaining({
        call: "session",
        input: expect.objectContaining({ operation: "unstage" }),
      }),
      { call: "drafts", path: "/api/draft/approve", body: { change_set_id: 1 } },
    ]);
  });

  test("a refused token is handed back; no token sends nothing", async () => {
    const { bearer: auth, state } = bearer();
    const client = createCanvasHttpClient(
      { url: "https://apps.test/app/api/canvas", bearer: auth },
      definition,
      {
        canApprove: false,
        fetch: async () =>
          Response.json(
            { ok: false, error: { code: "auth_required", message: "x" } },
            { status: 401 },
          ),
      },
    );
    await expect(client.session.request({ operation: "list" })).rejects.toMatchObject({
      envelope: { code: "auth_required" },
    });
    expect(state.refused).toBe(1);
    let calls = 0;
    const signedOut = createCanvasHttpClient(
      { url: "https://apps.test/app/api/canvas", bearer: bearer(null).bearer },
      definition,
      {
        canApprove: false,
        fetch: async () => {
          calls += 1;
          return Response.json({ ok: true, value: [] });
        },
      },
    );
    await expect(signedOut.session.request({ operation: "list" })).rejects.toMatchObject({
      envelope: { code: "auth_required" },
    });
    expect(calls).toBe(0);
  });

  test("its own bearer stream is shared by the tabs of one identity, never across identities", async () => {
    const tabs = memoryBrowser();
    const streams: string[] = [];
    const encoder = new TextEncoder();
    const fetch = async (url: string, init: RequestInit) => {
      streams.push(String((init.headers as Record<string, string>).authorization));
      // One revision, then the stream stays open.
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => controller.enqueue(encoder.encode("event: revision\ndata: 3\n\n")),
      });
      void url;
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    };
    const tab = (token: string, identity: string | null) =>
      createCanvasHttpClient(
        {
          url: "https://apps.test/app/api/canvas",
          bearer: bearer(token).bearer,
          identity: () => identity,
        },
        definition,
        { canApprove: false, fetch, tabs },
      );
    const settle = async () => {
      for (let turn = 0; turn < 20; turn += 1)
        await new Promise((resolve) => setTimeout(resolve, 0));
    };
    const heard: string[] = [];
    const stops = [
      tab("pat-1", "pat:org").subscribe("s", { onRevision: (r) => heard.push(`pat-a${r}`) }),
      tab("pat-2", "pat:org").subscribe("s", { onRevision: (r) => heard.push(`pat-b${r}`) }),
      tab("lee-1", "lee:org").subscribe("s", { onRevision: (r) => heard.push(`lee${r}`) }),
      // Not signed in yet: nothing shared.
      tab("anon", null).subscribe("s", { onRevision: () => {} }),
    ];
    await settle();
    // Pat's two tabs share Pat's stream; Lee and the signed-out frame open their own.
    expect(streams.toSorted()).toEqual(["Bearer anon", "Bearer lee-1", "Bearer pat-1"]);
    expect(heard.toSorted()).toEqual(["lee3", "pat-a3", "pat-b3"]);
    for (const stop of stops) stop();
  });

  test("the session stream reads Server-Sent Events over fetch with the bearer", async () => {
    const encoder = new TextEncoder();
    let requested: { url: string; init: RequestInit } | undefined;
    const fetch = async (url: string, init: RequestInit) => {
      requested = { url, init };
      // Events split across chunks, CRLF line ends, a comment.
      const chunks = [": hi\r\nevent: revision\r", "\ndata: 7\r\n\r\nevent: da", "ta\ndata: \n\n"];
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    const { bearer: auth } = bearer();
    const client = createCanvasHttpClient(
      { url: "https://apps.test/app/api/canvas", bearer: auth },
      definition,
      { canApprove: false, fetch },
    );
    const heard: string[] = [];
    const stop = client.subscribe("s-1", {
      onRevision: (revision) => heard.push(`revision ${revision}`),
      onConnect: () => heard.push("connect"),
      onData: () => heard.push("data"),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop();
    expect(requested?.url).toBe("https://apps.test/app/api/canvas/events?session_id=s-1");
    expect(new Headers(requested?.init.headers).get("authorization")).toBe("Bearer tok");
    expect(heard).toEqual(["connect", "revision 7", "data"]);
  });
});

describe("batched reads", () => {
  test("reads asked for in one tick go as one request, answered in order; a lone read goes alone", async () => {
    const sent: unknown[] = [];
    const fetch = async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as
        | CanvasReadRequest
        | { batch: CanvasReadRequest[] };
      sent.push(body);
      if ("batch" in body)
        return Response.json({
          ok: true,
          value: body.batch.map((item) =>
            item.read === "list"
              ? { ok: true, value: [{ model: item.model }] }
              : { ok: false, error: { code: "authorization_denied", message: "no" } },
          ),
        });
      return Response.json({ ok: true, value: [{ model: (body as { model?: string }).model }] });
    };
    const client = createCanvasClient(transport().transport, definition, {
      canApprove: false,
      fetch,
    });
    const [first, second, refused] = await Promise.allSettled([
      client.data.list("a", { asOf: "2026-01-01" }),
      client.data.list("b", { asOf: "2026-01-01" }),
      client.data.aggregate("c", { asOf: "2026-01-01", metrics: [{ fn: "count" }] }),
    ]);
    expect(sent).toHaveLength(1);
    expect((sent[0] as { batch: unknown[] }).batch).toHaveLength(3);
    expect(first).toMatchObject({ status: "fulfilled", value: [{ model: "a" }] });
    expect(second).toMatchObject({ status: "fulfilled", value: [{ model: "b" }] });
    // Each read keeps its own failure.
    expect(refused).toMatchObject({
      status: "rejected",
      reason: { envelope: { code: "authorization_denied" } },
    });
    expect(await client.data.list("d", { asOf: "2026-01-01" })).toEqual([{ model: "d" }]);
    expect(sent[1]).toMatchObject({ read: "list", model: "d" });
  });
});
