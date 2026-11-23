// What the host's server actions, its read route and its browser client
// share. Browser-safe: no server imports.

/**
 * A failure the canvas reads: the kernel's `{ code, message }`, and its
 * details when the kernel names them.
 */
export type CanvasHostFailure = { code: string; message: string; details?: readonly unknown[] };

/**
 * Every server action and every read-route answer is this instead of a
 * throw, so a kernel failure (a revision conflict, a refused draft action)
 * reaches the browser with its code. A thrown action is a transport failure
 * whose outcome is unknown.
 */
export type CanvasActionResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: CanvasHostFailure };

/**
 * The draft-review paths, split by what they do: reads go to the read
 * route, writes to the drafts action. Each surface refuses the other's.
 */
export const draftPaths = {
  read: {
    get: ["/api/drafts", "/api/drafts/rejected"],
    post: ["/api/diff", "/api/activity"],
  },
  write: ["/api/revert", "/api/draft/discard", "/api/draft/approve", "/api/draft/notes"],
} as const;
export type DraftReadPath =
  | (typeof draftPaths.read.get)[number]
  | (typeof draftPaths.read.post)[number];
export type DraftWritePath = (typeof draftPaths.write)[number];

/** Work-session operations that only read; every other one is a mutation. */
export const sessionReadOperations = ["get", "list", "entries"] as const;
/** Draft-thread operations that only read; `reply` and `resolve` are mutations. */
export const threadReadOperations = ["get", "by_session"] as const;
export const threadWriteOperations = ["reply", "resolve"] as const;

/**
 * One read, as the browser sends it to the read route (`POST`, JSON body).
 * Every field is untrusted; the host validates it and resolves app, customer
 * and actor itself. A `list` or `aggregate` query is the data client's
 * (`QueryInput`), so `includePendingDrafts` (the canvas's Show drafts) and
 * `work` reach the kernel read as the data client sends them.
 */
export type CanvasReadRequest =
  | { read: "session"; input: unknown }
  | { read: "list"; model: string; query: unknown }
  | { read: "aggregate"; model: string; query: unknown }
  | { read: "drafts"; path: DraftReadPath; body: unknown }
  | { read: "threads"; operation: (typeof threadReadOperations)[number]; input: unknown }
  | { read: "authors"; actor_ids: readonly string[] };
/** What the read route takes: one read, or several answered in order (each its own result). */
export type CanvasReadBody = CanvasReadRequest | { batch: readonly CanvasReadRequest[] };

/**
 * One canvas API call (`POST <mount>/api/canvas`, JSON, bearer): the canvas
 * in a chat sends what the web canvas sends to its server actions and read
 * route, one schema for both. The host validates every field.
 */
export type CanvasApiRequest =
  | { call: "read"; request: CanvasReadBody }
  | { call: "session"; input: unknown }
  | { call: "drafts"; path: unknown; body: unknown }
  | { call: "threads"; operation: unknown; input: unknown }
  | { call: "create_session"; input: unknown }
  | { call: "viewer" };

/** A session as the session list shows it. */
export type CanvasSessionSummary = {
  id: string;
  title: string;
  asOf: string;
  /** Model ids in the session's scope. */
  models: string[];
  pinned: boolean;
  revision: number;
  updatedAt: string | null;
};

/**
 * The server actions an app re-exports from one `"use server"` module: the
 * canvas's mutations only (reads go through the read route). Every argument
 * is untrusted browser input; the host validates it and resolves app,
 * customer and actor itself on every call.
 */
export type CanvasHostMutations = {
  /** A work-session mutation; a read operation is refused. */
  session(input: unknown): Promise<CanvasActionResult<unknown>>;
  /** A draft-review write (`draftPaths.write`); a read path is refused. */
  drafts(path: unknown, body: unknown): Promise<CanvasActionResult<unknown>>;
  /** Draft-thread `reply` and `resolve`; a read operation is refused. */
  threads(operation: unknown, input: unknown): Promise<CanvasActionResult<unknown>>;
  createSession(input: unknown): Promise<CanvasActionResult<{ sessionId: string }>>;
};
