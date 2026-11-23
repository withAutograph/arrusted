// The browser side of the canvas host: a CanvasClient over the app's server
// actions (mutations), its read route and its events route, or (the canvas in
// a chat) over the app's canvas API with the person's bearer token. Both share
// one request schema. Browser-safe: types cross from the runtime and the
// canvas, plus the canvas's React-free thread parser.
import type {
  DataDefinition,
  WorkSessionClient,
  WorkSessionRequest,
  WorkSessionResult,
} from "@autograph/generated-app-runtime/data";
import type {
  CanvasAggregateResult,
  CanvasClient,
  CanvasListener,
  CanvasRecord,
} from "@autograph/canvas";
import { parseThreads, type CanvasThread } from "@autograph/canvas/threads";
import type { KernelClient } from "@contracts";

type CanvasDrafts = NonNullable<CanvasClient["drafts"]>;
type CanvasSessions = NonNullable<CanvasClient["sessions"]>;

import {
  draftPaths,
  sessionReadOperations,
  type CanvasActionResult,
  type CanvasApiRequest,
  type CanvasHostMutations,
  type CanvasReadBody,
  type CanvasReadRequest,
  type DraftReadPath,
} from "./protocol";

export type * from "./protocol";

/** A kernel or host failure as the canvas reads it (`envelope: { code, message }`). */
export class CanvasHostError extends Error {
  readonly envelope: { code: string; message: string; details: readonly unknown[] };
  constructor(code: string, message: string, details: readonly unknown[] = []) {
    super(message);
    this.name = "CanvasHostError";
    this.envelope = { code, message, details };
  }
}

/** The action's value, or its failure thrown with the kernel's code and details. */
async function unwrap<T>(result: Promise<CanvasActionResult<unknown>>): Promise<T> {
  const settled = await result;
  if (!settled.ok)
    throw new CanvasHostError(settled.error.code, settled.error.message, settled.error.details);
  return settled.value as T;
}

type ThreadedDraft = {
  id: number;
  status: "draft" | "mainline" | "discarded";
  notes: string | null;
  threads: Record<string, unknown> | null;
  /** On `get` only: whether this viewer may resolve the draft's threads. */
  can_resolve?: boolean;
  /** Rule notes of the draft's entries, keyed `model:record:field`. */
  entry_notes?: Record<string, string> | null;
};

/**
 * The kernel keeps a draft's threads keyed by id; the canvas reads them as a
 * list, each parsed with the canvas's one thread schema.
 */
const threadList = (threads: Record<string, unknown> | null | undefined): CanvasThread[] =>
  parseThreads(threads ?? {});

/** Minimal surface of the browser's EventSource that the client uses. */
export type EventSourceLike = {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
  onerror: ((event: Event) => void) | null;
  onopen: ((event: Event) => void) | null;
};

const newRequestId = () => globalThis.crypto.randomUUID();

export type CanvasClientOptions = {
  /**
   * Where a session lives (`/<app>/<id>`) and how to go there; with it the
   * canvas shows its sessions menu.
   */
  sessions?: { href(sessionId: string): string; home: string; navigate(href: string): void };
  /**
   * Whether this viewer approves (publishes, discards, reverts); the server
   * decided it while rendering the page. Every member reads the drafts.
   */
  canApprove: boolean;
  /**
   * Whether the host has a source of author names in this mode (the server
   * decided it with `canApprove`); without one the client never asks.
   * Defaults to true.
   */
  authors?: boolean;
  /**
   * Per model id, the money field whose currency and period an empty money
   * value takes (e.g. `{ employee: "target_pay" }`); see `moneyDefaults`.
   */
  moneyDefaults?: Readonly<Record<string, string>>;
  /** Tests substitute the read route's fetch, the EventSource and the reconnect timer. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  eventSource?: (url: string) => EventSourceLike;
  setTimeout?: (run: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  /**
   * How tabs of one browser share a session's stream (see `shareAcrossTabs`).
   * Defaults to the browser's BroadcastChannel and Web Locks when the client
   * opens its own EventSource; null keeps one stream per tab.
   */
  tabs?: TabSharing | null;
};

/** The minimal BroadcastChannel the tab sharing uses. */
export type TabChannel = {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
};
/** A channel per name and an exclusive lock per name (the Web Locks API). */
export type TabSharing = {
  channel(name: string): TabChannel;
  lock(name: string, signal: AbortSignal, held: () => Promise<void>): Promise<unknown>;
};

function browserTabSharing(): TabSharing | null {
  const locks = (globalThis.navigator as { locks?: LockManager } | undefined)?.locks;
  if (typeof BroadcastChannel === "undefined" || locks === undefined) return null;
  return {
    channel: (name) => new BroadcastChannel(name) as unknown as TabChannel,
    lock: (name, signal, held) => locks.request(name, { signal }, held),
  };
}

/**
 * How a client shares its streams across tabs: the browser's sharing, and
 * whose streams they are. Tabs share a stream only within one scope (one
 * signed-in identity); a null scope (not signed in yet) shares nothing.
 */
type TabShare = { tabs: TabSharing; scope: () => string | null };

/**
 * The browser's tab sharing for a client that opens its own streams; a
 * caller that supplies its own `eventSource` keeps one stream per tab unless
 * it also passes `tabs`.
 */
const tabSharingFor = (options: CanvasClientOptions, ownStreams: boolean): TabSharing | null =>
  options.tabs !== undefined ? options.tabs : ownStreams ? browserTabSharing() : null;

type TabMessage =
  | { kind: "revision"; revision: number; connect: boolean; to?: string }
  | { kind: "data" }
  | { kind: "hello"; from: string };

/**
 * One session's stream shared by every tab of this browser on the origin.
 * Browsers allow six HTTP/1.1 connections per host, and each stream holds
 * one for as long as the tab is open: with one stream per tab, a sixth tab
 * of the canvas could never read. The tab holding the session's lock (the
 * leader) opens the stream and passes its events to the others over a
 * BroadcastChannel; when the leader closes, the next tab in line takes the
 * lock and opens its own stream, which every tab hears as a reconnect (and
 * re-reads). A tab that joins asks for the last revision, which it hears as
 * its connect; no other tab hears that answer.
 */
function shareAcrossTabs(
  name: string,
  tabs: TabSharing,
  listener: CanvasListener,
  open: (listener: CanvasListener) => () => void,
): () => void {
  const self = newRequestId();
  const channel = tabs.channel(name);
  const abort = new AbortController();
  let stopped = false;
  let leading = false;
  let last: number | null = null;
  let release = () => {};
  channel.onmessage = ({ data }) => {
    const message = data as TabMessage;
    if (message.kind === "hello") {
      if (leading && last !== null)
        channel.postMessage({ kind: "revision", revision: last, connect: true, to: message.from });
      return;
    }
    if (leading) return;
    if (message.kind === "data") listener.onData?.();
    else if (message.to === undefined || message.to === self) {
      if (message.connect) listener.onConnect?.();
      listener.onRevision(message.revision);
    }
  };
  channel.postMessage({ kind: "hello", from: self });
  tabs
    .lock(name, abort.signal, async () => {
      if (stopped) return;
      leading = true;
      let connected = false;
      const close = open({
        onConnect: () => {
          connected = true;
          listener.onConnect?.();
        },
        onRevision: (revision) => {
          last = revision;
          listener.onRevision(revision);
          channel.postMessage({ kind: "revision", revision, connect: connected });
          connected = false;
        },
        onData: () => {
          listener.onData?.();
          channel.postMessage({ kind: "data" });
        },
      });
      // Held until this tab stops listening; then the next tab leads.
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      close();
    })
    // An abandoned wait for the lock is not a failure.
    .catch(() => {});
  return () => {
    stopped = true;
    abort.abort();
    release();
    channel.close();
  };
}

const CLOSED = 2;
const maxBackoffMs = 30_000;

/**
 * Live changes of one session over `<eventsUrl>/<sessionId>`. EventSource
 * retries dropped connections itself; when the server refuses or closes the
 * stream for good, this reconnects with backoff. Every (re)connect starts
 * with the current revision, so the canvas re-reads after any gap. Every
 * subscriber of the session shares one stream (browsers allow few per
 * origin); a late subscriber hears the last revision the stream sent.
 */
function createEventHub(
  eventsUrl: (sessionId: string) => string,
  options: CanvasClientOptions,
  share: TabShare | null,
) {
  const streams = new Map<
    string,
    { listeners: Set<CanvasListener>; stop: () => void; revision: number | null }
  >();
  return (sessionId: string, listener: CanvasListener): (() => void) => {
    let stream = streams.get(sessionId);
    if (stream === undefined) {
      const listeners = new Set<CanvasListener>();
      const created: { listeners: Set<CanvasListener>; stop: () => void; revision: number | null } =
        { listeners, stop: () => {}, revision: null };
      // Shared across this browser's tabs only within one identity's scope.
      const scope = share?.scope() ?? null;
      const openStream = (each: CanvasListener) =>
        subscribeEvents(eventsUrl, sessionId, each, options);
      const hub: CanvasListener = {
        onRevision: (revision) => {
          created.revision = revision;
          for (const each of [...listeners]) each.onRevision(revision);
        },
        onConnect: () => {
          for (const each of [...listeners]) each.onConnect?.();
        },
        onData: () => {
          for (const each of [...listeners]) each.onData?.();
        },
      };
      created.stop =
        share === null || scope === null
          ? openStream(hub)
          : shareAcrossTabs(
              `canvas-events:${encodeURIComponent(scope)}:${eventsUrl(sessionId)}`,
              share.tabs,
              hub,
              openStream,
            );
      streams.set(sessionId, created);
      stream = created;
    } else if (stream.revision !== null) {
      const { revision } = stream;
      queueMicrotask(() => {
        if (stream?.listeners.has(listener)) listener.onRevision(revision);
      });
    }
    const joined = stream;
    joined.listeners.add(listener);
    return () => {
      if (!joined.listeners.delete(listener) || joined.listeners.size > 0) return;
      joined.stop();
      if (streams.get(sessionId) === joined) streams.delete(sessionId);
    };
  };
}

function subscribeEvents(
  eventsUrl: (sessionId: string) => string,
  sessionId: string,
  listener: CanvasListener,
  options: CanvasClientOptions,
): () => void {
  const open =
    options.eventSource ?? ((url: string) => new EventSource(url) as unknown as EventSourceLike);
  const later = options.setTimeout ?? ((run, ms) => globalThis.setTimeout(run, ms));
  const cancel =
    options.clearTimeout ??
    ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  const url = eventsUrl(sessionId);
  let stopped = false;
  let source: EventSourceLike | undefined;
  let timer: unknown;
  let backoff = 1_000;
  const connect = () => {
    if (stopped) return;
    const current = open(url);
    source = current;
    // Each connection, the browser's own retries included, starts with the
    // current revision: its first one marks a (re)connect.
    let connected = false;
    current.onopen = () => {
      backoff = 1_000;
      connected = false;
    };
    current.addEventListener("revision", (event) => {
      const revision = Number(event.data);
      if (!Number.isSafeInteger(revision) || revision < 0) return;
      if (!connected) {
        connected = true;
        listener.onConnect?.();
      }
      listener.onRevision(revision);
    });
    current.addEventListener("data", () => listener.onData?.());
    current.onerror = () => {
      // A CONNECTING source retries itself; a CLOSED one is ours to reopen.
      if (stopped || current.readyState !== CLOSED) return;
      current.close();
      timer = later(connect, backoff);
      backoff = Math.min(backoff * 2, maxBackoffMs);
    };
  };
  connect();
  return () => {
    stopped = true;
    if (timer !== undefined) cancel(timer);
    source?.close();
  };
}

/** Where the canvas sends its mutations, reads and live subscriptions. */
export type CanvasTransport = {
  /** The app's `"use server"` exports of the host's mutations. */
  mutations: CanvasHostMutations;
  /** The app's read route (`POST`, JSON). */
  readUrl: string;
  /** The app's events route; a session id is appended. */
  eventsUrl: string;
};

const sessionReads = new Set<unknown>(sessionReadOperations);
const draftReadPosts = new Set<string>(draftPaths.read.post);

/**
 * A host answer as a result: a coded refusal is a result; anything else (no
 * answer, a body that is not one) is a transport failure.
 */
async function hostResult(response: Response): Promise<CanvasActionResult<unknown>> {
  const body = (await response.json().catch(() => null)) as {
    ok?: unknown;
    value?: unknown;
    error?: { code?: unknown; message?: unknown; details?: unknown };
  } | null;
  if (body?.ok === true) return { ok: true, value: body.value };
  if (body?.ok === false && typeof body.error?.code === "string")
    return {
      ok: false,
      error: {
        code: body.error.code,
        message: typeof body.error.message === "string" ? body.error.message : body.error.code,
        ...(Array.isArray(body.error.details) ? { details: body.error.details } : {}),
      },
    };
  throw new Error(`The canvas request failed (${response.status}).`);
}

/** How one client reaches its host: mutations, reads and the session stream's address. */
type CanvasChannel = {
  mutations: CanvasHostMutations;
  read(request: CanvasReadBody): Promise<CanvasActionResult<unknown>>;
  eventsUrl(sessionId: string): string;
};

/**
 * The canvas's client: mutations through the host's server actions, every
 * read through the read route, live changes through the events route, and
 * the definition from the server render.
 */
export function createCanvasClient(
  transport: CanvasTransport,
  definition: DataDefinition,
  options: CanvasClientOptions,
): CanvasClient {
  const send = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  return canvasClientOver(
    {
      mutations: transport.mutations,
      read: async (request) =>
        await hostResult(
          await send(transport.readUrl, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify(request),
            credentials: "same-origin",
            cache: "no-store",
          }),
        ),
      eventsUrl: (sessionId) =>
        `${transport.eventsUrl.replace(/\/+$/u, "")}/${encodeURIComponent(sessionId)}`,
    },
    definition,
    options,
    sharedIn(tabSharingFor(options, options.eventSource === undefined), () => "cookie"),
  );
}

/** The person's canvas token, as the frame holds it. */
export type CanvasBearer = {
  /**
   * A current access token (refreshed when needed), or null when signed out;
   * rejects when the token endpoint cannot be reached (the sign-in stands).
   */
  token(): Promise<string | null>;
  /**
   * The host refused `token`: the frame clears it and shows sign-in, unless
   * it already holds another (a late refusal changes nothing).
   */
  refused(token?: string): void;
};

/** A session stream's data as `fetch` reads it, line by line (Server-Sent Events). */
async function readEventStream(
  body: ReadableStream<Uint8Array>,
  emit: (type: string, data: string) => void,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let type = "message";
  let data: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffer.search(/\r\n|\r|\n/u)) >= 0) {
      // A CR ending this chunk may begin a CRLF: wait for the next one.
      if (buffer[newline] === "\r" && newline === buffer.length - 1) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + (buffer.startsWith("\r\n", newline) ? 2 : 1));
      if (line === "") {
        if (data.length > 0) emit(type, data.join("\n"));
        type = "message";
        data = [];
      } else if (!line.startsWith(":")) {
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const raw = colon < 0 ? "" : line.slice(colon + 1);
        const content = raw.startsWith(" ") ? raw.slice(1) : raw;
        if (field === "event") type = content;
        else if (field === "data") data.push(content);
      }
    }
  }
}

/**
 * An `EventSourceLike` over `fetch` with the bearer: a browser `EventSource`
 * cannot send `Authorization`. It never retries itself; a refused or closed
 * stream reports CLOSED, and the event hub reopens it with backoff.
 */
export function bearerEventSource(
  url: string,
  bearer: CanvasBearer,
  send: (url: string, init: RequestInit) => Promise<Response> = (target, init) =>
    globalThis.fetch(target, init),
): EventSourceLike {
  const controller = new AbortController();
  const listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();
  const source: EventSourceLike & { readyState: number } = {
    readyState: 0,
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    close() {
      source.readyState = CLOSED;
      controller.abort();
    },
    onerror: null,
    onopen: null,
  };
  const fail = () => {
    if (source.readyState === CLOSED && controller.signal.aborted) return;
    source.readyState = CLOSED;
    source.onerror?.(new Event("error"));
  };
  void (async () => {
    const token = await bearer.token();
    if (token === null) return fail();
    const response = await send(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal,
    });
    if (response.status === 401) bearer.refused(token);
    if (!response.ok || response.body === null) return fail();
    source.readyState = 1;
    source.onopen?.(new Event("open"));
    await readEventStream(response.body, (type, data) => {
      for (const listener of listeners.get(type) ?? []) listener(new MessageEvent(type, { data }));
    });
    fail();
  })().catch(fail);
  return source;
}

/**
 * The canvas in a chat: the same CanvasClient over the app's canvas API
 * (`POST <url>`, `GET <url>/events?session_id=…`) with the person's bearer
 * token, never a cookie. A 401 hands the token back (`bearer.refused`).
 */
export function createCanvasHttpClient(
  input: {
    url: string;
    bearer: CanvasBearer;
    /**
     * Who the bearer signs in as (e.g. `person:organization`), or null when
     * no one is signed in: tabs share a stream only within one identity.
     * Without it, nothing is shared.
     */
    identity?: () => string | null;
  },
  definition: DataDefinition,
  options: CanvasClientOptions,
): CanvasClient {
  const send = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const url = input.url.replace(/\/+$/u, "");
  const call = async (request: CanvasApiRequest): Promise<CanvasActionResult<unknown>> => {
    const token = await input.bearer.token();
    if (token === null)
      return {
        ok: false,
        error: { code: "auth_required", message: "Sign in to work in this canvas." },
      };
    const response = await send(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(request),
      credentials: "omit",
      cache: "no-store",
    });
    if (response.status === 401) input.bearer.refused(token);
    return await hostResult(response);
  };
  const mutations: CanvasHostMutations = {
    session: (value) => call({ call: "session", input: value }),
    drafts: (path, body) => call({ call: "drafts", path, body }),
    threads: (operation, value) => call({ call: "threads", operation, input: value }),
    createSession: (value) =>
      call({ call: "create_session", input: value }) as Promise<
        CanvasActionResult<{ sessionId: string }>
      >,
  };
  return canvasClientOver(
    {
      mutations,
      read: (request) => call({ call: "read", request }),
      eventsUrl: (sessionId) => `${url}/events?${new URLSearchParams({ session_id: sessionId })}`,
    },
    definition,
    {
      ...options,
      eventSource:
        options.eventSource ?? ((target) => bearerEventSource(target, input.bearer, send)),
    },
    // The bearer stream this client opens itself is shared across the
    // browser's tabs signed in as the same identity; a caller's own
    // `eventSource` is not, unless it passes `tabs`.
    sharedIn(
      tabSharingFor(options, options.eventSource === undefined),
      () => input.identity?.() ?? null,
    ),
  );
}

/** The most reads one read request carries. */
export const readBatchLimit = 40;

/**
 * Reads asked for in the same tick go to the host as one request
 * (`{ batch }`), answered in order; a lone read goes as itself. A canvas
 * opening asks for dozens of reads at once (every unit, its names and
 * options), and a browser sends only a few requests to one origin at a time.
 */
export function batchReads(
  send: (request: CanvasReadBody) => Promise<CanvasActionResult<unknown>>,
): (request: CanvasReadRequest) => Promise<CanvasActionResult<unknown>> {
  let queue: {
    request: CanvasReadRequest;
    resolve: (result: CanvasActionResult<unknown>) => void;
    reject: (error: unknown) => void;
  }[] = [];
  const flush = () => {
    const due = queue;
    queue = [];
    for (let start = 0; start < due.length; start += readBatchLimit) {
      const chunk = due.slice(start, start + readBatchLimit);
      if (chunk.length === 1) {
        const [only] = chunk;
        send(only!.request).then(only!.resolve, only!.reject);
        continue;
      }
      send({ batch: chunk.map((item) => item.request) }).then(
        (answer) => {
          const results = answer.ok && Array.isArray(answer.value) ? answer.value : null;
          chunk.forEach((item, index) => {
            const result = results?.[index] as CanvasActionResult<unknown> | undefined;
            item.resolve(
              result ??
                (answer.ok
                  ? {
                      ok: false,
                      error: { code: "outcome_unknown", message: "The read was not answered." },
                    }
                  : answer),
            );
          });
        },
        (error) => {
          for (const item of chunk) item.reject(error);
        },
      );
    }
  };
  return (request) =>
    new Promise((resolve, reject) => {
      if (queue.length === 0) setTimeout(flush, 0);
      queue.push({ request, resolve, reject });
    });
}

const sharedIn = (tabs: TabSharing | null, scope: () => string | null): TabShare | null =>
  tabs === null ? null : { tabs, scope };

function canvasClientOver(
  channel: CanvasChannel,
  definition: DataDefinition,
  options: CanvasClientOptions,
  share: TabShare | null,
): CanvasClient {
  const { mutations, eventsUrl } = channel;
  const readResult = batchReads(channel.read);
  const read = <T>(request: CanvasReadRequest) => unwrap<T>(readResult(request));
  const session: WorkSessionClient = {
    request: <const R extends WorkSessionRequest>(input: R) =>
      unwrap<WorkSessionResult<R>>(
        sessionReads.has(input.operation)
          ? readResult({ read: "session", input })
          : mutations.session(input),
      ),
  };
  // Draft authors' names, learned with each drafts list before it renders.
  // An id is asked for once per page, named or not; a host with no name
  // source in this mode is never asked.
  const authorNames = new Map<string, string>();
  const asked = new Set<string>();
  const learnAuthors = async (rows: unknown) => {
    if (options.authors === false || !Array.isArray(rows)) return;
    const unknown = [
      ...new Set(
        rows
          .map((row) => (row as { actor_id?: unknown } | null)?.actor_id)
          .filter((id): id is string => typeof id === "string" && !asked.has(id)),
      ),
    ];
    if (unknown.length === 0) return;
    const named = await readResult({ read: "authors", actor_ids: unknown }).catch(() => null);
    // A failed lookup is asked again with the next list.
    if (!named?.ok) return;
    for (const id of unknown) asked.add(id);
    // A card without a name shows no author; never the raw id.
    const names = named.value;
    if (names === null || typeof names !== "object") return;
    for (const [id, name] of Object.entries(names))
      if (typeof name === "string") authorNames.set(id, name);
  };
  const kernel: KernelClient = {
    getJson: async <T>(path: string) => {
      const rows = await read<T>({ read: "drafts", path: path as DraftReadPath, body: null });
      await learnAuthors(rows);
      return rows;
    },
    // Diff and activity read; the review writes are actions.
    postJson: async <T>(path: string, body: unknown) => {
      if (!draftReadPosts.has(path)) return await unwrap<T>(mutations.drafts(path, body));
      const rows = await read<T>({ read: "drafts", path: path as DraftReadPath, body });
      // Published activity names its authors too, not only the draft lists.
      if (path === "/api/activity") await learnAuthors(rows);
      return rows;
    },
  };
  const drafts: CanvasDrafts = {
    kernel,
    canApprove: options.canApprove,
    authorName: (actorId) => authorNames.get(actorId),
    threads: {
      list: async (changeSetId) => {
        const draft = await read<ThreadedDraft>({
          read: "threads",
          operation: "get",
          input: { change_set_id: changeSetId },
        });
        return {
          threads: threadList(draft.threads),
          canResolve: draft.can_resolve === true,
          ruleNotes: draft.entry_notes ?? {},
        };
      },
      forSession: async (sessionId) =>
        (
          await read<ThreadedDraft[]>({
            read: "threads",
            operation: "by_session",
            input: { session_id: sessionId },
          })
        ).map((draft) => ({
          change_set_id: draft.id,
          status: draft.status,
          notes: draft.notes,
          threads: threadList(draft.threads),
        })),
      // One request id per gesture: a retried action replays, never repeats.
      reply: async (changeSetId, threadId, body) => {
        await unwrap(
          mutations.threads("reply", {
            change_set_id: changeSetId,
            thread_id: threadId,
            message: body,
            request_id: newRequestId(),
          }),
        );
      },
      resolve: async (changeSetId, threadId) => {
        await unwrap(
          mutations.threads("resolve", {
            change_set_id: changeSetId,
            thread_id: threadId,
            request_id: newRequestId(),
          }),
        );
      },
    },
  };
  /** The browser's own calendar date, `YYYY-MM-DD`: a new session's as-of. */
  const localToday = () => {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  };
  // A create retried with the same title replays the same session and gesture.
  let pendingCreate: {
    title: string;
    session_id: string;
    request_id: string;
    as_of: string;
  } | null = null;
  const navigation = options.sessions;
  const sessions: CanvasSessions | undefined =
    navigation === undefined
      ? undefined
      : {
          list: async () =>
            (await session.request({ operation: "list" })).map((header) => ({
              id: header.id,
              title: header.title,
              asOf: String(header.as_of).slice(0, 10),
              pinned: header.pinned,
              revision: header.revision,
              updatedAt:
                typeof (header as { updated_at?: unknown }).updated_at === "string"
                  ? ((header as { updated_at?: string }).updated_at ?? null)
                  : null,
            })),
          create: async (title) => {
            const ids =
              pendingCreate?.title === title
                ? pendingCreate
                : {
                    title,
                    session_id: newRequestId(),
                    request_id: newRequestId(),
                    as_of: localToday(),
                  };
            pendingCreate = ids;
            const { title: _title, ...gesture } = ids;
            const result = await mutations.createSession({ title, ...gesture });
            // A definite answer ends the gesture; an unknown outcome keeps it for a retry.
            if (result.ok || result.error.code === "contract_validation_failed")
              pendingCreate = null;
            return await unwrap<{ sessionId: string }>(Promise.resolve(result));
          },
          open: (sessionId) => navigation.navigate(navigation.href(sessionId)),
          home: () => navigation.navigate(navigation.home),
          cancelCreate: () => {
            pendingCreate = null;
          },
        };
  return {
    session,
    ...(sessions === undefined ? {} : { sessions }),
    data: {
      list: (model, query) => read<CanvasRecord[]>({ read: "list", model, query }),
      aggregate: (model, query) => read<CanvasAggregateResult>({ read: "aggregate", model, query }),
    },
    definition,
    drafts,
    ...(options.moneyDefaults === undefined ? {} : { moneyDefaults: options.moneyDefaults }),
    subscribe: createEventHub(eventsUrl, options, share),
  };
}
