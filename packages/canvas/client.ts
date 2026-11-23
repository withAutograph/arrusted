import type {
  AggregateUnit,
  DataDefinition,
  QueryInput,
  WorkSessionClient,
} from "@autograph/generated-app-runtime/data";
import type { KernelClient } from "@contracts";

import type { CanvasThread } from "./threads";

/**
 * A data-client query for one model, by model id. Field names are the
 * model's field `name`s, as the generated data client takes them; `work`
 * reads over the session's staged values.
 */
export type CanvasListInput = QueryInput;
export type CanvasAggregateInput = Omit<QueryInput, "orderBy" | "limit" | "offset" | "select"> & {
  groupBy?: readonly (
    | string
    | { field: string; bins: { edges: readonly string[] }; unit?: AggregateUnit }
  )[];
  metrics: readonly (
    | { fn: "count" }
    | { fn: "count_distinct" | "sum" | "avg" | "min" | "max" | "median"; field: string }
    | { fn: "percentile"; field: string; p: number }
  )[];
};
/** A record as the data client decodes it: values keyed by field name. */
export type CanvasRecord = { id: string; [name: string]: unknown };
/**
 * The data client's aggregate result. A money metric adds one `{ unit }`
 * entry per money field to every group key, so groups never mix currencies
 * or periods.
 */
export type CanvasAggregateResult = {
  as_of: string;
  units: (AggregateUnit | null)[];
  groups: { key: unknown[]; metrics: (string | null)[] }[];
  total: { metrics: (string | null)[] };
  other_units?: string;
};

/** The generated data client's list and aggregate, addressed by model id. */
export type CanvasData = {
  list(modelId: string, input: CanvasListInput): Promise<CanvasRecord[]>;
  aggregate(modelId: string, input: CanvasAggregateInput): Promise<CanvasAggregateResult>;
};

/**
 * What a host passes the canvas. `session.request` rejects kernel failures
 * with an error carrying `envelope: { code, message }` (the `KernelFailure`
 * shape); any other rejection is a transport failure whose outcome is unknown.
 */
export type CanvasClient = {
  session: WorkSessionClient;
  data: CanvasData;
  definition: DataDefinition;
  /**
   * Live changes of one session. The client calls `onRevision` with the
   * current revision on every (re)connect and after every revision bump,
   * `onConnect` on every (re)connect (before that first revision), and
   * `onData` whenever published data changes (a change set becomes mainline)
   * or a draft's threads change, which can make staged values stale or gone
   * without a revision bump. The canvas re-reads through `session` on any of
   * them, so authorization stays on the read path.
   */
  subscribe(sessionId: string, listener: CanvasListener): () => void;
  /**
   * The workspace's saved changes (pending, published and rejected drafts)
   * and their threads. Without it the canvas has no Review mode and no draft
   * threads in the Comments pane.
   */
  drafts?: CanvasDrafts;
  /**
   * The viewer's other sessions, for the sessions menu on the title. Without
   * it the canvas shows no menu. Rename, pin, duplicate and archive go
   * through `session.request` with each session's listed revision.
   */
  sessions?: CanvasSessions;
  /**
   * Per model id, the money field whose currency and period an empty money
   * value of a record takes (`moneyDefaults`); a model without one takes its
   * record's first money value.
   */
  moneyDefaults?: Readonly<Record<string, string>>;
  /** Set by `withPendingDrafts`: list and aggregate reads include pending drafts. */
  readsPendingDrafts?: boolean;
};

/**
 * The client every unit reads through: with `showDrafts`, each list and
 * aggregate also reads every pending draft's changed fields over mainline
 * (`includePendingDrafts`), under the session's staged values. Off, reads
 * are exactly the host's.
 */
export function withPendingDrafts(client: CanvasClient, showDrafts: boolean): CanvasClient {
  if (!showDrafts) return client;
  return {
    ...client,
    readsPendingDrafts: true,
    data: {
      list: (modelId, input) => client.data.list(modelId, { ...input, includePendingDrafts: true }),
      aggregate: (modelId, input) =>
        client.data.aggregate(modelId, { ...input, includePendingDrafts: true }),
    },
  };
}

/** One of the viewer's active sessions, as the sessions menu lists it. */
export type CanvasSessionHeader = {
  id: string;
  title: string;
  asOf: string;
  pinned: boolean;
  revision: number;
  updatedAt: string | null;
};

/** What the host gives the canvas for its sessions menu. */
export type CanvasSessions = {
  /** Active sessions, pinned first, then most recently updated. */
  list(): Promise<CanvasSessionHeader[]>;
  /**
   * A new session with the app's starting scope and layout, dated the
   * browser's today; resolves with its id once created.
   */
  create(title: string): Promise<{ sessionId: string }>;
  /** Opens a session (navigates to its address). */
  open(sessionId: string): void;
  /** Opens the app's home, which opens the latest session or offers a new one. */
  home(): void;
  /** Ends a New session gesture without creating: a later create is a new gesture. */
  cancelCreate(): void;
};

/** A draft's status as its author reads it. */
export type CanvasDraftStatus = "draft" | "mainline" | "discarded";

/** A draft saved from one session, with its threads (any status). */
export type CanvasSessionDraft = {
  change_set_id: number;
  status: CanvasDraftStatus;
  notes: string | null;
  threads: CanvasThread[];
};

/** One draft's threads, and whether this user may resolve them (its author or an approver). */
export type CanvasDraftThreads = {
  threads: CanvasThread[];
  canResolve: boolean;
  /** The rule notes of its entries, keyed `model:record:field` (absent when none). */
  ruleNotes?: Readonly<Record<string, string>>;
};

/**
 * What the host gives the canvas for drafts: the review module's transport,
 * whether this user approves, and the threads a draft carries from Save.
 * Every member reads every saved draft, its threads and its author, and
 * replies on any thread.
 */
export type CanvasDrafts = {
  /**
   * Transport for `@modules/draft-review`: `GET /api/drafts`,
   * `GET /api/drafts/rejected`, `POST /api/diff`, `/api/activity`,
   * `/api/revert`, `/api/draft/discard`, `/api/draft/approve` and
   * `/api/draft/notes` (`{ change_set_id, notes }`).
   */
  kernel: KernelClient;
  /**
   * Whether this user may approve; the host decides. Only then does Review
   * mode show Publish, Discard and Revert.
   */
  canApprove: boolean;
  /** A draft author's display name from their actor id, when the host knows it. */
  authorName?: (actorId: string) => string | undefined;
  threads: {
    /** Threads on one draft (any status), and whether this user may resolve them. */
    list(changeSetId: number): Promise<CanvasDraftThreads>;
    /** Drafts saved from this session, each with its threads (the author's Comments pane). */
    forSession(sessionId: string): Promise<CanvasSessionDraft[]>;
    reply(changeSetId: number, threadId: string, body: string): Promise<void>;
    resolve(changeSetId: number, threadId: string): Promise<void>;
  };
};

/** What `CanvasClient.subscribe` calls. */
export type CanvasListener = {
  onRevision: (revision: number) => void;
  /**
   * The stream (re)connected: anything that changed during a gap was not
   * announced, even when the session's revision did not move.
   */
  onConnect?: () => void;
  onData?: () => void;
};

/** A kernel failure as `session.request` rejects with it. */
export class CanvasKernelError extends Error {
  readonly envelope: { code: string; message: string; details: readonly unknown[] };
  constructor(code: string, message: string, details: readonly unknown[] = []) {
    super(message);
    this.envelope = { code, message, details };
  }
}

/**
 * A failure as people read it: the kernel's message without its `code:`
 * prefix; a plain sentence for a validation or response-decoding problem, or when
 * there is no message. Never a raw code or schema text.
 */
export function failureMessage(
  error: unknown,
  fallback = "Something went wrong. Try again.",
): string {
  const code = kernelErrorCode(error);
  const raw =
    code !== null
      ? (error as { envelope: { message?: unknown } }).envelope.message
      : error instanceof Error && error.name !== "ZodError" && error.name !== "DataResponseError"
        ? error.message
        : null;
  if (typeof raw !== "string") return fallback;
  if (code === "contract_validation_failed" || raw.startsWith("contract_validation_failed"))
    return "That isn't a valid change here.";
  const text = raw.replace(/^[a-z][a-z0-9_]*:\s*/u, "").trim();
  return text === "" ? fallback : `${text[0]!.toUpperCase()}${text.slice(1)}`;
}

/** The kernel failure code of a rejection, or null when the outcome is unknown. */
export function kernelErrorCode(error: unknown): string | null {
  if (error === null || typeof error !== "object" || !("envelope" in error)) return null;
  const code = (error as { envelope?: { code?: unknown } }).envelope?.code;
  return typeof code === "string" ? code : null;
}
