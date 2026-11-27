import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  createDataClient,
  type DataContext,
  type DataDefinition,
  type WorkSessionRequest,
} from "@autograph/generated-app-runtime/data";
import {
  createPostgresDataContext,
  type PostgresDataContext,
} from "@autograph/generated-app-runtime/postgres";
import {
  VERIFIED_BODY_HEADER,
  VERIFIED_METHOD_HEADER,
  VERIFIED_TARGET_HEADER,
} from "@autograph/platform-microfrontends/next-request-ingress";
import {
  agentCapabilityAllowed,
  createVerifiedAgentDataContext,
  workSessionEventsResponse,
  type ProtectedDataPayload,
  type VerifiedDataRuntime,
  type VerifiedDataVerification,
  type WorkSessionListener,
} from "@autograph/platform-microfrontends/verified-data-context";
import { mainModelOrder } from "@autograph/work-session-tools/labels";
import { newSessionLayout } from "@autograph/work-session-tools/layout";
import { createWorkSessionMcpHandler } from "@autograph/work-session-tools/mcp";

import { canvasResourceContents, type CanvasChat } from "./mcp-app/resource";
import {
  draftPaths,
  sessionReadOperations,
  threadReadOperations,
  threadWriteOperations,
  type CanvasActionResult,
  type CanvasHostFailure,
  type CanvasHostMutations,
  type CanvasSessionSummary,
} from "./protocol";

export type * from "./protocol";
export type { CanvasChat } from "./mcp-app/resource";

/** The app's two roles: who works in sessions, and who also approves drafts. */
export type CanvasRoles = { member: string; approver: string };

/** The current viewer, as the app's data foundation authenticated them. */
export type CanvasViewer = {
  scope: { actorId: string; customerId: string };
  /** The viewer's current app roles. */
  roles: readonly string[];
};
/** The role a data context binds (and re-checks before each transaction). */
export type CanvasDataOptions = { requiredRole?: string };
/** One request's data context from the app's foundation. */
export type CanvasData = { context: PostgresDataContext };

/**
 * Who a canvas request acts as and how its data contexts open: the app's
 * foundation for the web canvas, or one canvas API request's person.
 */
export type CanvasPersonData = Pick<CanvasHostData, "session" | "read" | "action">;

/**
 * The app's data foundation, as the canvas host uses it. The app passes thin
 * adapters over its generated `getAppSession`, `withAppDataContext` and
 * `withAppActionDataContext`, which own authentication, credentials, pools,
 * the checked release and (in protected Gateway mode) the signed request.
 */
export type CanvasHostData = {
  /** The authenticated viewer; throws (status 401/403) when there is none. */
  session(options?: CanvasDataOptions): Promise<CanvasViewer>;
  /** A read-only request context, closed after `run`. */
  read<T>(options: CanvasDataOptions, run: (data: CanvasData) => Promise<T>): Promise<T>;
  /**
   * A mutation's request context bound to `payload`, the validated and
   * normalized JSON DTO (protected mode binds it to the signed request). All
   * of `run`'s writes share one request transaction; closed after `run`.
   */
  action<T>(
    payload: ProtectedDataPayload,
    options: CanvasDataOptions,
    run: (data: CanvasData) => Promise<T>,
  ): Promise<T>;
  /** Where the events stream listens: the app's runtime database, and its own connection when the platform's checked one does not apply. */
  events(): {
    runtime: VerifiedDataRuntime;
    connect?: (runtime: VerifiedDataRuntime) => Promise<WorkSessionListener>;
  };
  /**
   * How the MCP route authenticates an agent: the protected Gateway's signed
   * agent principal, or (legacy mode) the app's own bearer verification.
   * Undefined when this mode serves no agents.
   */
  agent(): CanvasAgentBinding | undefined;
  /**
   * The source of draft authors' display names in the current mode, or
   * undefined when this mode has none (the browser then never asks).
   */
  actorNames?(): CanvasActorNames | undefined;
  /**
   * The canvas in a chat (MCP Apps): what serving its resource needs, or
   * undefined when this deployment does not offer it.
   */
  chat?(): Promise<CanvasChat | undefined>;
  /**
   * The canvas API's person (the canvas in a chat): resolved once from the
   * request's canvas bearer token (legacy mode verifies it in the app,
   * protected mode takes the Gateway's canvas principal), never from a
   * cookie. Answers the refusal as a Response; undefined when this mode
   * serves no canvas API.
   */
  person?(request: Request): Promise<CanvasPersonData | Response>;
};

/** Display names of actor ids in the organization; ids it omits show no author. */
export type CanvasActorNames = (input: {
  organizationId: string;
  actorIds: readonly string[];
}) => Promise<Readonly<Record<string, string>>>;

/** One authenticated agent request in legacy mode: its grant and per-turn contexts. */
export type CanvasAgentSession = {
  /** The OAuth grant (consent) id: the conversation identity. */
  grantId: string;
  contextForTurn: (turnId: string) => DataContext;
  close: () => Promise<void>;
};

export type CanvasAgentBinding =
  | {
      /** Protected Gateway facts for the agent context (public verifier, runtime credential). */
      kind: "protected";
      verification: VerifiedDataVerification;
      runtime: VerifiedDataRuntime;
      verifyRelease: () => void;
    }
  | {
      /**
       * Legacy mode: the app verifies the bearer itself. Answers the agent's
       * session, or the refusal (401 with the challenge, or 403) as a Response.
       */
      kind: "legacy";
      open(request: Request): Promise<CanvasAgentSession | Response>;
    };

/**
 * A legacy-mode agent session over the app's own pool, for a grant the app
 * just verified: the same agent capability list as the protected agent
 * context, every transaction marked as agent work for one turn, and the
 * grant, membership and assignment re-read (`recheck`) before each one.
 * Legacy has no fence; the per-call read covers a removed assignment.
 */
export function createLegacyAgentSession(input: {
  pool: Parameters<typeof createPostgresDataContext>[0]["pool"];
  appId: string;
  definition: Pick<DataDefinition, "models">;
  grant: { grantId: string; actorId: string; organizationId: string };
  recheck: () => Promise<void>;
  verifyRelease: () => void;
}): CanvasAgentSession {
  const authorize: DataContext["authorize"] = async (capability) => {
    if (!agentCapabilityAllowed(input.definition, capability))
      throw new Error(`authorization_denied: the agent context does not allow ${capability}`);
    await input.recheck();
  };
  return {
    grantId: input.grant.grantId,
    contextForTurn: (turnId) =>
      createPostgresDataContext({
        pool: input.pool,
        appId: input.appId,
        customerId: input.grant.organizationId,
        actorId: input.grant.actorId,
        sourceKind: "agent",
        agent: { turnId },
        authorize,
        verifyRelease: input.verifyRelease,
      }),
    close: async () => {},
  };
}

/**
 * The canvas API's person in legacy mode, for a canvas grant the app just
 * verified: a human context (`sourceKind` human) on the app's own pool,
 * modeled on the legacy agent session. `recheck` re-reads the grant,
 * membership and assignment and answers the person's current app roles; it
 * runs for the viewer read and before every transaction, so a revoked grant
 * or a removed role stops the canvas on its next call.
 */
export function createLegacyCanvasPerson(input: {
  pool: Parameters<typeof createPostgresDataContext>[0]["pool"];
  appId: string;
  grant: { actorId: string; organizationId: string };
  recheck: () => Promise<readonly string[]>;
  verifyRelease: () => void;
}): CanvasPersonData {
  const rolesNow = async (requiredRole: string | undefined) => {
    const roles = await input.recheck();
    if (roles.length === 0 || (requiredRole !== undefined && !roles.includes(requiredRole)))
      throw Object.assign(new Error("Access to this app is required."), {
        code: "app_access_required",
        status: 403,
      });
    return roles;
  };
  const contextFor = (options: CanvasDataOptions) =>
    createPostgresDataContext({
      pool: input.pool,
      appId: input.appId,
      customerId: input.grant.organizationId,
      actorId: input.grant.actorId,
      sourceKind: "human",
      authorize: async () => {
        try {
          await rolesNow(options.requiredRole);
        } catch {
          throw new Error("authorization_denied: the canvas grant or app role changed");
        }
      },
      verifyRelease: input.verifyRelease,
    });
  return {
    session: async (options) => ({
      scope: { actorId: input.grant.actorId, customerId: input.grant.organizationId },
      roles: await rolesNow(options?.requiredRole),
    }),
    read: async (options, run) => await run({ context: contextFor(options) }),
    action: async (_payload, options, run) => {
      const context = contextFor(options);
      return await context.requestTransaction(() => run({ context }));
    },
  };
}

export type CanvasHostConfig = {
  appId: string;
  definition: DataDefinition;
  roles: CanvasRoles;
  data: CanvasHostData;
};

/** A refused request: authentication, app access or a role the actor lacks. */
export class CanvasHostDenied extends Error {
  constructor(
    readonly code:
      | "auth_required"
      | "app_access_required"
      | "tenant_required"
      | "authorization_denied",
    message: string,
    readonly status: 401 | 403,
  ) {
    super(message);
    this.name = "CanvasHostDenied";
  }
}

/** Browser input that is not a valid request. */
class CanvasHostInvalid extends Error {
  readonly code = "contract_validation_failed";
  constructor(message: string) {
    super(message);
    this.name = "CanvasHostInvalid";
  }
}

/** A route this mode does not serve. */
class CanvasHostUnavailable extends Error {
  readonly code = "unavailable";
  constructor(message: string) {
    super(message);
    this.name = "CanvasHostUnavailable";
  }
}

/** A coded refusal one read passes on to the read route's answer. */
class CanvasHostRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CanvasHostRefused";
  }
}

const authRequired = () =>
  new CanvasHostDenied("auth_required", "Authentication is required.", 401);
const accessRequired = () =>
  new CanvasHostDenied("app_access_required", "Access to this app is required.", 403);
const approverRequired = () =>
  new CanvasHostDenied(
    "authorization_denied",
    "Only an approver may publish, discard or revert drafts.",
    403,
  );
const resolveRefused = () =>
  new CanvasHostDenied(
    "authorization_denied",
    "Only the draft's author or an approver may resolve its threads.",
    403,
  );
const invalid = (message: string) => new CanvasHostInvalid(message);

const statusOf = (error: unknown): unknown =>
  error !== null && typeof error === "object" && "status" in error
    ? (error as { status?: unknown }).status
    : undefined;

/**
 * The foundation's coded session refusal as the host's: 401 needs sign-in,
 * 403 is access, 5xx is the platform's (`unavailable`). An uncoded failure is
 * unexpected and stays itself.
 */
function sessionDenial(error: unknown): unknown {
  if (error instanceof CanvasHostDenied) return error;
  const status = statusOf(error);
  if (status === 401) return authRequired();
  // Several organizations open the app and none is active: the person chooses one.
  if (status === 403 && (error as { code?: unknown }).code === "tenant_required")
    return new CanvasHostDenied("tenant_required", "Choose an organization first.", 403);
  if (status === 403) return accessRequired();
  if (typeof status === "number" && status >= 500)
    return new CanvasHostUnavailable("Sign-in verification is unavailable; try again shortly.");
  return error;
}

/** An Auth boundary refusal (`{ code, status }`) the browser may read. */
const authBoundaryCodes = new Set(["auth_required", "app_access_required", "tenant_required"]);
const isAuthBoundary = (
  error: unknown,
): error is { code: string; message: string; status: number } =>
  error instanceof Error &&
  "code" in error &&
  typeof error.code === "string" &&
  authBoundaryCodes.has(error.code) &&
  "status" in error &&
  (error.status === 401 || error.status === 403);

/** Work-session operations a person may send through the session action. */
const humanOperations = new Set([
  "get",
  "list",
  "entries",
  "duplicate",
  "update",
  "pin",
  "archive",
  "unarchive",
  "stage",
  "unstage",
  "discard_source",
  "discard_turn",
  "rule_create",
  "rule_parameters",
  "rule_remove",
  "thread_open",
  // The person's selection (presence): no revision, no notification.
  "presence",
  "thread_reply",
  "thread_resolve",
  "propose",
  "pull",
  "dismiss",
  "save",
]);
/** The canvas API's body: one call, each field checked again by the operation it names. */
const canvasApiRequest = z.discriminatedUnion("call", [
  z.strictObject({ call: z.literal("read"), request: z.unknown() }),
  z.strictObject({ call: z.literal("session"), input: z.unknown() }),
  z.strictObject({ call: z.literal("drafts"), path: z.unknown(), body: z.unknown() }),
  z.strictObject({ call: z.literal("threads"), operation: z.unknown(), input: z.unknown() }),
  z.strictObject({ call: z.literal("create_session"), input: z.unknown() }),
  z.strictObject({ call: z.literal("viewer") }),
]);

/** Request keys only the server sets. */
const scopeKeys = ["app_id", "customer_id", "actor_id", "owner_id", "schema_version"];

const uuid = z.uuid();
const changeSetId = z.number().int().positive();
/** The review module repeats a scope in its bodies; the host ignores it. */
const ignoredScope = { app_id: z.unknown().optional(), customer_id: z.unknown().optional() };
const draftAction = z.strictObject({ ...ignoredScope, change_set_id: changeSetId });
const draftBodies = {
  "/api/diff": z.strictObject({
    ...ignoredScope,
    change_set_id: changeSetId,
    project: z.array(z.string().min(1)).optional(),
  }),
  "/api/activity": z.strictObject({
    ...ignoredScope,
    limit: z.number().int().positive().max(500).nullable().optional(),
    statuses: z.array(z.enum(["draft", "mainline", "discarded", "reverted"])).optional(),
    source_kinds: z.array(z.string().min(1)).optional(),
  }),
  "/api/revert": draftAction,
  // A rejection may carry its note, saved in the same transaction as the discard.
  "/api/draft/discard": z.strictObject({
    ...ignoredScope,
    change_set_id: changeSetId,
    notes: z.string().max(4000).optional(),
  }),
  "/api/draft/approve": draftAction,
  "/api/draft/notes": z.strictObject({
    ...ignoredScope,
    change_set_id: changeSetId,
    notes: z.string().max(4000).nullable(),
  }),
} as const;
const threadId = z.string().min(1).max(200);
const threadInputs = {
  get: z.strictObject({ change_set_id: changeSetId }),
  by_session: z.strictObject({ session_id: uuid }),
  // The browser names each gesture once, so a retried action replays it.
  reply: z.strictObject({
    change_set_id: changeSetId,
    thread_id: threadId,
    message: z.string().trim().min(1).max(10_000),
    request_id: uuid,
  }),
  resolve: z.strictObject({ change_set_id: changeSetId, thread_id: threadId, request_id: uuid }),
} as const;
const actorIds = z.array(z.string().min(1).max(200)).max(500);
/** Session operations that only read; every other one is a protected mutation. */
const sessionReads = new Set<string>(sessionReadOperations);
const threadReads = new Set<string>(threadReadOperations);
const threadWrites = new Set<string>(threadWriteOperations);
const draftReadGets = new Set<unknown>(draftPaths.read.get);

/**
 * The read route's body. Each field is checked again by the read it names;
 * a mutation named here is refused before any data call.
 */
/** A batch of reads: each item is one read request (never another batch). */
const readBatch = z.array(z.unknown()).min(1).max(40);
/** How many of a batch's reads run at once. */
const batchConcurrency = 4;
const readRequest = z.discriminatedUnion("read", [
  z.strictObject({ read: z.literal("session"), input: z.unknown() }),
  z.strictObject({ read: z.literal("list"), model: z.unknown(), query: z.unknown() }),
  z.strictObject({ read: z.literal("aggregate"), model: z.unknown(), query: z.unknown() }),
  z.strictObject({ read: z.literal("drafts"), path: z.unknown(), body: z.unknown().optional() }),
  z.strictObject({ read: z.literal("threads"), operation: z.unknown(), input: z.unknown() }),
  z.strictObject({ read: z.literal("authors"), actor_ids: z.unknown() }),
]);

/** The validated request as plain JSON: the DTO a protected mutation is bound to. */
const normalized = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const dto = (value: unknown) => value as ProtectedDataPayload;
/**
 * A session's as-of date: any valid calendar date. The browser picks it and
 * keeps it across a retry of the same gesture, so a retry replays.
 */
const asOfDate = z.iso.date();
// The browser names the new session, the gesture and its as-of date once, and
// keeps all three across a retry of the same submit: every creation input is
// stable, so a retry replays and never creates twice.
const newSession = z.strictObject({
  title: z.string().trim().min(1).max(200),
  /** Omitted: every model of the app. */
  models: z.array(z.string().min(1)).min(1).max(50).optional(),
  session_id: uuid,
  request_id: uuid,
  as_of: asOfDate,
});

function plainObject(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw invalid(`${what} must be an object`);
  return value as Record<string, unknown>;
}

/** The failure a browser may read, or null when the outcome is unknown. */
function readableFailure(error: unknown): CanvasHostFailure | null {
  if (
    error instanceof CanvasHostDenied ||
    error instanceof CanvasHostInvalid ||
    error instanceof CanvasHostUnavailable ||
    error instanceof CanvasHostRefused ||
    isAuthBoundary(error)
  )
    return { code: error.code, message: error.message };
  if (error instanceof z.ZodError)
    return { code: "contract_validation_failed", message: "The request is not valid." };
  if (error !== null && typeof error === "object" && "envelope" in error) {
    const envelope = (
      error as { envelope?: { code?: unknown; message?: unknown; details?: unknown } }
    ).envelope;
    if (typeof envelope?.code === "string")
      return {
        code: envelope.code,
        message: typeof envelope.message === "string" ? envelope.message : envelope.code,
      };
  }
  if (error instanceof Error) {
    // Runtime contract and authorization refusals carry their code as a prefix.
    const match =
      /^(contract_validation_failed|authorization_denied|revision_conflict):\s*(.*)$/su.exec(
        error.message,
      );
    if (match) return { code: match[1]!, message: error.message };
  }
  return null;
}

/** A read's value, or its coded refusal thrown for the enclosing answer. */
async function settled<T>(result: Promise<CanvasActionResult<T>>): Promise<T> {
  const done = await result;
  if (!done.ok) throw new CanvasHostRefused(done.error.code, done.error.message);
  return done.value;
}

async function answer<T>(run: () => Promise<T>): Promise<CanvasActionResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    const failure = readableFailure(error);
    // An unknown outcome stays a thrown (transport) failure.
    if (failure === null) throw error;
    return { ok: false, error: failure };
  }
}

/** The coded failure's HTTP status: sign-in, access, invalid input, unavailable, or a kernel refusal. */
function failureStatus(failure: CanvasHostFailure): number {
  switch (failure.code) {
    case "auth_required":
      return 401;
    case "app_access_required":
    case "tenant_required":
    case "authorization_denied":
      return 403;
    case "contract_validation_failed":
      return 400;
    case "unavailable":
      return 503;
    default:
      // A refusal the kernel coded: the outcome is known, the request was not served.
      return 422;
  }
}

const noStore = { "cache-control": "no-store" };

function failureResponse(error: unknown): Response {
  const failure = readableFailure(error);
  if (failure === null)
    return Response.json(
      { ok: false, error: { code: "unavailable", message: "The request could not be completed." } },
      { status: 500, headers: noStore },
    );
  const status =
    error instanceof CanvasHostDenied || isAuthBoundary(error)
      ? error.status
      : failureStatus(failure);
  return Response.json({ ok: false, error: failure }, { status, headers: noStore });
}

/** Close `close` once the response body is fully read or cancelled. */
function closeAfter(response: Response, close: () => Promise<void>): Response {
  if (response.body === null) {
    void close().catch(() => {});
    return response;
  }
  let closed = false;
  const done = () => {
    if (closed) return;
    closed = true;
    void close().catch(() => {});
  };
  const reader = response.body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done: finished, value } = await reader.read();
        if (finished) {
          done();
          controller.close();
        } else controller.enqueue(value);
      } catch (error) {
        done();
        controller.error(error);
      }
    },
    cancel(reason) {
      done();
      return reader.cancel(reason);
    },
  });
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** The verified data runtime facts of a PostgreSQL URL. */
export function runtimeFromDatabaseUrl(databaseUrl: string): VerifiedDataRuntime {
  const url = new URL(databaseUrl);
  return {
    databaseUrl,
    database: decodeURIComponent(url.pathname.slice(1)),
    hostname: url.hostname,
    port: Number(url.port || 5432),
    runtimeRole: decodeURIComponent(url.username),
    environment: url.searchParams.get("sslmode") === "disable" ? "local" : "hosted",
  };
}

export type CanvasHost = ReturnType<typeof createCanvasHost>;

/**
 * The canvas host for one app. The app's data foundation authenticates each
 * page read, action and route and supplies its data context (legacy Auth or
 * protected Gateway mode); the host validates browser input, keeps scope
 * server-owned, checks the member and approver roles and who may resolve a
 * draft's threads, and maps each call to the kernel. App, customer and actor
 * come only from the foundation. Every member reads the workspace's drafts,
 * their diffs, threads and authors, and replies on any thread; only an
 * approver publishes, discards, reverts or edits notes.
 */
export function createCanvasHost(config: CanvasHostConfig) {
  // Server entry: credentials and verified scope never reach a browser bundle.
  if (typeof window !== "undefined") throw new Error("The canvas host runs on the server only");
  const { appId, definition, roles, data } = config;
  const modelIds = new Set(definition.models.map((model) => model.id));
  const modelNames = new Map(definition.models.map((model) => [model.id, model.name]));

  /**
   * The canvas operations for one identity binding: the app's foundation (the
   * web canvas: its cookie session, or the Gateway's human principal), or one
   * canvas API request's person resolved from its bearer. The binding is
   * carried explicitly through access, read and write: no fallback to another
   * identity and no shared mutable state.
   */
  const bind = (binding: CanvasPersonData) => {
    /** The viewer now, with the role their data context binds. */
    type Access = { viewer: CanvasViewer; approver: boolean; role: string };

    const viewerNow = async (options?: CanvasDataOptions): Promise<CanvasViewer> => {
      try {
        return await binding.session(options);
      } catch (error) {
        throw sessionDenial(error);
      }
    };

    /**
     * The viewer's access: approver while they hold it now, else member, else
     * refused. The bound role is re-checked before every transaction.
     */
    const access = async (needsApprover = false): Promise<Access> => {
      const viewer = await viewerNow();
      const approver = viewer.roles.includes(roles.approver);
      if (!approver && !viewer.roles.includes(roles.member)) throw accessRequired();
      if (needsApprover && !approver) throw approverRequired();
      return { viewer, approver, role: approver ? roles.approver : roles.member };
    };

    /** A read as `role`; the foundation's denials become the host's. */
    const read = <T>(now: Access, run: (context: PostgresDataContext) => Promise<T>) =>
      binding.read({ requiredRole: now.role }, ({ context }) => run(context));
    /** A mutation bound to its normalized DTO, as `role`. */
    const write = <T>(
      now: Access,
      payload: ProtectedDataPayload,
      run: (context: PostgresDataContext) => Promise<T>,
    ) => binding.action(payload, { requiredRole: now.role }, ({ context }) => run(context));

    const sessionClient = (context: PostgresDataContext) =>
      createDataClient(definition, context).workSessions;

    const dataClient = (context: PostgresDataContext, modelId: string) => {
      const client = createDataClient(definition, context) as unknown as Record<
        string,
        {
          list(input: unknown): Promise<unknown>;
          aggregate(input: unknown): Promise<unknown>;
        }
      >;
      return client[modelNames.get(modelId)!]!;
    };
    const knownModel = (modelId: unknown): string => {
      if (typeof modelId !== "string" || !modelIds.has(modelId)) throw invalid("unknown model");
      return modelId;
    };

    /** A browser work-session request, checked before it reaches the kernel. */
    const sessionRequest = (input: unknown): WorkSessionRequest => {
      const request = plainObject(input, "request");
      if (scopeKeys.some((key) => Object.hasOwn(request, key)))
        throw invalid("work session scope is server-owned");
      const operation = request.operation;
      if (typeof operation !== "string" || !humanOperations.has(operation))
        throw invalid("unsupported work session operation");
      if (operation === "update") {
        const patch = plainObject(request.patch, "patch");
        if (Object.keys(patch).some((key) => !["layout", "title", "as_of"].includes(key)))
          throw invalid("a session's scope is fixed at creation");
        if (Object.hasOwn(patch, "as_of")) asOfDate.parse(patch.as_of);
      }
      return request as WorkSessionRequest;
    };

    const sessionSummary = (header: Record<string, unknown>): CanvasSessionSummary => {
      const scope = header.scope as { models?: unknown } | null;
      return {
        id: String(header.id),
        title: String(header.title),
        asOf: String(header.as_of).slice(0, 10),
        models: Array.isArray(scope?.models)
          ? scope.models.filter((model): model is string => typeof model === "string")
          : [],
        pinned: header.pinned === true,
        revision: typeof header.revision === "number" ? header.revision : 0,
        updatedAt: typeof header.updated_at === "string" ? header.updated_at : null,
      };
    };

    /**
     * A listed change set or activity entry without the work session it was
     * saved from: the session is its owner's, even once its changes are sent.
     * Other provenance (a revert's published entry) is kept.
     */
    const withoutSessionRef = (row: unknown): unknown => {
      if (row === null || typeof row !== "object") return row;
      const entry = row as Record<string, unknown>;
      if (entry.source_kind !== "work_session") return row;
      const { source_ref: _sessionId, ...rest } = entry;
      return rest;
    };

    /** The validated drafts call: its kernel function, request and whether it writes. */
    const draftRequest = (
      method: unknown,
      path: unknown,
      body: unknown,
    ): {
      operation: string;
      payload: Record<string, unknown>;
      /** Kernel calls made first, in the same transaction (a rejection's note). */
      before?: { operation: string; payload: Record<string, unknown> }[];
      write: boolean;
      wrap: boolean;
    } => {
      if (method === "GET") {
        if (path === "/api/drafts")
          return {
            operation: "kernel_list_draft_change_sets",
            payload: {},
            write: false,
            wrap: false,
          };
        if (path === "/api/drafts/rejected")
          return {
            operation: "kernel_list_draft_change_sets",
            payload: { status: "discarded" },
            write: false,
            wrap: false,
          };
        throw invalid("unknown drafts path");
      }
      if (method !== "POST") throw invalid("unknown drafts method");
      switch (path) {
        case "/api/diff": {
          const { change_set_id, project } = draftBodies[path].parse(body);
          return {
            operation: "kernel_change_set_diff",
            payload: { change_set_id, ...(project === undefined ? {} : { project }) },
            write: false,
            wrap: false,
          };
        }
        case "/api/activity": {
          const { limit, statuses, source_kinds } = draftBodies[path].parse(body);
          return {
            operation: "kernel_recent_activity",
            payload: {
              ...(limit === undefined ? {} : { limit }),
              ...(statuses === undefined ? {} : { statuses }),
              ...(source_kinds === undefined ? {} : { source_kinds }),
            },
            write: false,
            wrap: false,
          };
        }
        case "/api/draft/discard": {
          const { change_set_id, notes } = draftBodies[path].parse(body);
          const note = notes?.trim() ?? "";
          return {
            operation: "kernel_discard_draft_change_set",
            payload: { change_set_id },
            before:
              note === ""
                ? undefined
                : [
                    {
                      operation: "kernel_update_draft_notes",
                      payload: { change_set_id, notes: note },
                    },
                  ],
            write: true,
            wrap: true,
          };
        }
        case "/api/revert":
        case "/api/draft/approve": {
          const { change_set_id } = draftBodies[path].parse(body);
          const operation = {
            "/api/revert": "kernel_revert_change_set",
            "/api/draft/approve": "kernel_approve_draft_change_set",
          }[path];
          return { operation, payload: { change_set_id }, write: true, wrap: true };
        }
        case "/api/draft/notes": {
          const { change_set_id, notes } = draftBodies[path].parse(body);
          return {
            operation: "kernel_update_draft_notes",
            payload: { change_set_id, notes },
            write: true,
            wrap: false,
          };
        }
        default:
          throw invalid("unknown drafts path");
      }
    };

    /**
     * Whether the viewer saved `draft`: they own the session it was saved from
     * (read as that owner, as `by_session` does). Runs inside the call's
     * transaction.
     */
    const ownsDraft = async (
      context: PostgresDataContext,
      draft: { source_kind?: unknown; source_ref?: unknown },
    ): Promise<boolean> => {
      if (
        draft.source_kind !== "work_session" ||
        typeof draft.source_ref !== "string" ||
        !uuid.safeParse(draft.source_ref).success
      )
        return false;
      try {
        await sessionClient(context).request({
          operation: "get",
          session_id: draft.source_ref,
          overlay: false,
        });
        return true;
      } catch (error) {
        if (readableFailure(error)?.code === "authorization_denied") return false;
        throw error;
      }
    };

    /** A browser work-session request that is (or, for a mutation, is not) a read. */
    const sessionCall = (input: unknown, reads: boolean) =>
      answer(async () => {
        const request = normalized(sessionRequest(input));
        if (sessionReads.has(String(request.operation)) !== reads)
          throw invalid(
            reads
              ? "this work session operation is a mutation; use its action"
              : "this work session operation is a read; use the read route",
          );
        const now = await access();
        const client = (context: PostgresDataContext) => sessionClient(context).request(request);
        return reads ? await read(now, client) : await write(now, dto(request), client);
      });

    /** A drafts call the surface serves: reads on the read route, writes as actions. */
    const draftsCall = (method: unknown, path: unknown, body: unknown, reads: boolean) =>
      answer(async () => {
        const {
          operation,
          payload,
          before = [],
          write: writes,
          wrap,
        } = draftRequest(method, path, body);
        if (writes === reads)
          throw invalid(
            reads
              ? "this drafts path writes; use its action"
              : "this drafts path reads; use the read route",
          );
        // Every member reads the workspace's drafts; only an approver acts on them.
        const now = await access(writes);
        const run = async (context: PostgresDataContext) => {
          for (const call of [...before, { operation, payload }])
            await context.authorize(`drafts.${call.operation}`);
          // One transaction: a rejection's note lands only if the discard does.
          const result = await context.transaction(async (db) => {
            for (const call of before) await db.call(call.operation, call.payload);
            return await db.call(operation, payload);
          });
          if (operation === "kernel_update_draft_notes") return { ok: true };
          if (wrap) return { ok: true, change_set: result };
          return Array.isArray(result) ? result.map(withoutSessionRef) : result;
        };
        return writes
          ? await write(
              now,
              dto(normalized({ operation, ...payload, ...(before.length > 0 ? { before } : {}) })),
              run,
            )
          : await read(now, run);
      });

    /** A draft-thread call the surface serves: `get`/`by_session` read, `reply`/`resolve` write. */
    const threadsCall = (operation: unknown, input: unknown, reads: boolean) =>
      answer(async () => {
        if (typeof operation !== "string" || !Object.hasOwn(threadInputs, operation))
          throw invalid("unknown thread operation");
        if (!(reads ? threadReads : threadWrites).has(operation))
          throw invalid(
            reads
              ? "this thread operation is a mutation; use its action"
              : "this thread operation is a read; use the read route",
          );
        const op = operation as keyof typeof threadInputs;
        const parsed: Record<string, unknown> = normalized({
          operation: op,
          ...(threadInputs[op].parse(input) as Record<string, unknown>),
        });
        const now = await access();
        const run = async (context: PostgresDataContext) => {
          await context.authorize(`drafts.threads.${op}`);
          // The kernel lists a session's drafts for its owner only.
          if (op === "by_session")
            return await context.transaction((db) => db.call("kernel_draft_threads", parsed));
          // Every member reads and replies on any draft's threads.
          if (op === "reply")
            return await context.transaction((db) => db.call("kernel_draft_threads", parsed));
          // Only its author or an approver resolves, checked and used in one
          // transaction; `get` says which, without where the draft came from.
          return await context.transaction(async (db) => {
            const draft = (await db.call("kernel_draft_threads", {
              operation: "get",
              change_set_id: parsed.change_set_id,
            })) as Record<string, unknown>;
            const canResolve = now.approver || (await ownsDraft(context, draft));
            if (op === "get") {
              // Where a draft came from (a private session) stays server-side.
              const shown = Object.entries(draft).filter(
                ([key]) => key !== "source_kind" && key !== "source_ref",
              );
              return { ...Object.fromEntries(shown), can_resolve: canResolve };
            }
            if (!canResolve) throw resolveRefused();
            return await db.call("kernel_draft_threads", parsed);
          });
        };
        return reads ? await read(now, run) : await write(now, dto(parsed), run);
      });

    /**
     * One read-route request, dispatched to its read; nothing here writes. A
     * `{ batch }` of reads answers each in order, each with its own result.
     */
    const readCall = (input: unknown): Promise<CanvasActionResult<unknown>> =>
      typeof input === "object" && input !== null && "batch" in input
        ? answer(async () => {
            const batch = readBatch.parse((input as { batch: unknown }).batch);
            // A few reads at a time (each opens a data context), each settled
            // on its own: one failure never fails the others.
            const results: CanvasActionResult<unknown>[] = Array.from({ length: batch.length });
            let next = 0;
            const worker = async () => {
              while (next < batch.length) {
                const index = next++;
                results[index] = await readOne(batch[index]).catch(
                  (): CanvasActionResult<unknown> => ({
                    ok: false,
                    error: { code: "read_failed", message: "This read could not be answered." },
                  }),
                );
              }
            };
            await Promise.all(
              Array.from({ length: Math.min(batchConcurrency, batch.length) }, worker),
            );
            return results;
          })
        : readOne(input);
    const readOne = (input: unknown): Promise<CanvasActionResult<unknown>> =>
      answer(async () => {
        const request = readRequest.parse(input);
        switch (request.read) {
          case "session":
            return await settled(sessionCall(request.input, true));
          case "list":
          case "aggregate": {
            const query = plainObject(request.query, "query");
            const model = knownModel(request.model);
            const now = await access();
            return await read(now, (context) =>
              request.read === "list"
                ? dataClient(context, model).list(query)
                : dataClient(context, model).aggregate(query),
            );
          }
          case "drafts":
            return await settled(
              draftsCall(
                draftReadGets.has(request.path) ? "GET" : "POST",
                request.path,
                request.body ?? null,
                true,
              ),
            );
          case "threads":
            return await settled(threadsCall(request.operation, request.input, true));
          case "authors": {
            const ids = [...new Set(actorIds.parse(request.actor_ids))];
            // Authors show on review cards, which every member sees.
            const now = await access();
            const source = data.actorNames?.();
            if (source === undefined || ids.length === 0) return {};
            const names = await source({
              organizationId: now.viewer.scope.customerId,
              actorIds: ids,
            });
            return Object.fromEntries(ids.flatMap((id) => (names[id] ? [[id, names[id]]] : [])));
          }
        }
      });

    const mutations: CanvasHostMutations = {
      session: (input) => sessionCall(input, false),
      drafts: (path, body) => draftsCall("POST", path, body, false),
      threads: (operation, input) => threadsCall(operation, input, false),
      createSession: (input) =>
        answer(async () => {
          const { title, models, session_id, request_id, as_of } = newSession.parse(input);
          // One grid per model (named, or every model of the app), main model first, arranged.
          const { models: scoped, layout } = newSessionLayout(
            mainModelOrder(definition).map((model) => model.id),
            models,
          );
          // The effective scope is this app's models.
          if (scoped.some((model) => !modelIds.has(model))) throw invalid("unknown model");
          const request = normalized({
            operation: "create" as const,
            session_id,
            expected_revision: 0 as const,
            request_id,
            title,
            // Fixed by the browser's gesture, so a retry after midnight sends
            // the same date; the session's as-of may change later.
            as_of,
            scope: { models: scoped },
            layout,
          });
          const now = await access();
          await write(now, dto(request), (context) => sessionClient(context).request(request));
          return { sessionId: request.session_id };
        }),
    };

    return {
      access,
      read,
      write,
      sessionClient,
      sessionSummary,
      sessionCall,
      draftsCall,
      threadsCall,
      readCall,
      mutations,
    };
  };
  /** One session's live revisions, as the binding's viewer. */
  const sessionEvents = async (
    ops: ReturnType<typeof bind>,
    request: Request,
    sessionId: string,
  ): Promise<Response> => {
    if (request.method !== "GET") throw invalid("events are read with GET");
    if (!uuid.safeParse(sessionId).success) throw invalid("unknown session");
    const now = await ops.access();
    const { runtime, connect } = data.events();
    // The context only reads the session before the stream starts; the
    // stream's own listener ends when the request aborts.
    return await ops.read(now, (context) =>
      workSessionEventsResponse({
        context,
        schemaVersion: definition.schemaVersion,
        workSessions: ops.sessionClient(context),
        runtime,
        sessionId,
        signal: request.signal,
        ...(connect === undefined ? {} : { connect }),
      }),
    );
  };

  /** The canvas API request's person, or the refusal; this mode may serve none. */
  const personOf = async (request: Request): Promise<CanvasPersonData | Response> => {
    if (data.person === undefined)
      throw new CanvasHostUnavailable("This app serves no canvas API in this mode.");
    return await data.person(request);
  };

  /** The web canvas: the app's own foundation. */
  const web = bind(data);
  const { access, read, sessionClient, sessionSummary, readCall, mutations } = web;

  return {
    appId,
    definition,
    /**
     * Page read: whether the viewer may approve (and so also sees Save and
     * approve) and whether draft authors can be named in this mode (for every
     * member). Refuses a viewer without access.
     */
    async viewer(): Promise<{ canApprove: boolean; authors: boolean }> {
      const now = await access();
      return { canApprove: now.approver, authors: data.actorNames?.() !== undefined };
    },
    sessions: {
      /** Page read: the viewer's active sessions, most recently updated first. */
      async list(): Promise<CanvasSessionSummary[]> {
        const headers = await read(await access(), (context) =>
          sessionClient(context).request({ operation: "list" }),
        );
        return headers.map((header) => sessionSummary(header as Record<string, unknown>));
      },
      /** Page read: one of the viewer's sessions, or null when it is not theirs or not there. */
      async get(sessionId: string): Promise<CanvasSessionSummary | null> {
        if (!uuid.safeParse(sessionId).success) return null;
        const now = await access();
        try {
          const header = await read(now, (context) =>
            sessionClient(context).request({
              operation: "get",
              session_id: sessionId,
              overlay: false,
            }),
          );
          return sessionSummary(header as unknown as Record<string, unknown>);
        } catch (error) {
          if (readableFailure(error)?.code === "authorization_denied") return null;
          throw error;
        }
      },
    },
    /** The browser's mutations, for the app's `"use server"` module to re-export. */
    mutations,
    routes: {
      /**
       * `POST <mount>/api/read`: one canvas read (`CanvasReadRequest`, JSON),
       * answered as a `CanvasActionResult`. It opens only the foundation's
       * read context (protected mode verifies the signed request as a read
       * and opens a read-only connection) and refuses any mutation.
       */
      async read(request: Request): Promise<Response> {
        try {
          if (request.method !== "POST") throw invalid("canvas reads are sent with POST");
          if (!/^application\/json\b/iu.test(request.headers.get("content-type") ?? ""))
            throw invalid("canvas reads are JSON");
          let body: unknown;
          try {
            body = await request.json();
          } catch {
            throw invalid("the read request is not JSON");
          }
          const result = await readCall(body);
          return Response.json(result, {
            status: result.ok ? 200 : failureStatus(result.error),
            headers: noStore,
          });
        } catch (error) {
          return failureResponse(error);
        }
      },
      /** `GET <mount>/api/events/[sessionId]`: one session's live revisions, in either mode. */
      async events(request: Request, sessionId: string): Promise<Response> {
        try {
          return await sessionEvents(web, request, sessionId);
        } catch (error) {
          return failureResponse(error);
        }
      },
      /**
       * `POST <mount>/api/canvas`: the canvas in a chat, as the person its
       * bearer names (`CanvasApiRequest`, JSON). Every operation the web
       * canvas performs through its server actions and read route, through
       * the same calls and their member and approver checks. Bearer only: no
       * cookie identity, and an agent's token is refused.
       */
      async canvas(request: Request): Promise<Response> {
        try {
          if (request.method !== "POST") throw invalid("canvas calls are sent with POST");
          if (!/^application\/json\b/iu.test(request.headers.get("content-type") ?? ""))
            throw invalid("canvas calls are JSON");
          const person = await personOf(request);
          if (person instanceof Response) return person;
          let body: unknown;
          try {
            body = await request.json();
          } catch {
            throw invalid("the canvas call is not JSON");
          }
          const call = canvasApiRequest.parse(body);
          const ops = bind(person);
          const result = await (async (): Promise<CanvasActionResult<unknown>> => {
            switch (call.call) {
              case "read":
                return await ops.readCall(call.request);
              case "session": {
                const input = plainObject(call.input, "request");
                return await ops.sessionCall(input, sessionReads.has(String(input.operation)));
              }
              case "drafts":
                return await ops.draftsCall("POST", call.path, call.body, false);
              case "threads":
                return await ops.threadsCall(call.operation, call.input, false);
              case "create_session":
                return await ops.mutations.createSession(call.input);
              case "viewer":
                return await answer(async () => {
                  const now = await ops.access();
                  return { canApprove: now.approver, authors: data.actorNames?.() !== undefined };
                });
            }
          })();
          return Response.json(result, {
            status: result.ok ? 200 : failureStatus(result.error),
            headers: noStore,
          });
        } catch (error) {
          return failureResponse(error);
        }
      },
      /**
       * `GET <mount>/api/canvas/events?session_id=…`: one session's live
       * revisions for the canvas in a chat, as the person its bearer names.
       */
      async canvasEvents(request: Request): Promise<Response> {
        try {
          if (request.method !== "GET") throw invalid("events are read with GET");
          const person = await personOf(request);
          if (person instanceof Response) return person;
          const sessionId = new URL(request.url).searchParams.get("session_id") ?? "";
          return await sessionEvents(bind(person), request, sessionId);
        } catch (error) {
          return failureResponse(error);
        }
      },
      /**
       * `<mount>/api/mcp`: the work-session tools for an MCP agent holding an
       * OAuth grant for this app (bearer only: a browser session reaches
       * nothing here). Protected mode takes the Gateway's signed agent
       * principal; legacy mode verifies the bearer in the app. The agent
       * context allows reads, staging, layout, threads, proposals and rules;
       * the kernel refuses Save and every canonical write. One conversation
       * per grant and MCP session; one turn per tool call.
       */
      async mcp(request: Request): Promise<Response> {
        try {
          const binding = data.agent();
          if (binding === undefined)
            throw new CanvasHostUnavailable("This app serves no MCP agents in this mode.");
          let session: CanvasAgentSession;
          let forwarded: Request = request;
          if (binding.kind === "legacy") {
            const opened = await binding.open(request);
            if (opened instanceof Response) return opened;
            session = opened;
          } else {
            // The facts the app's mandatory proxy verified for this request.
            const method = request.headers.get(VERIFIED_METHOD_HEADER);
            const target = request.headers.get(VERIFIED_TARGET_HEADER);
            if (method === null || target === null || method !== request.method.toUpperCase())
              throw authRequired();
            // A verified body digest binds the bytes the Gateway signed.
            const body = request.headers.has(VERIFIED_BODY_HEADER)
              ? new Uint8Array(await request.arrayBuffer())
              : undefined;
            const agent = await createVerifiedAgentDataContext({
              request: {
                headers: new Headers(request.headers),
                method,
                target,
                ...(body === undefined
                  ? { kind: "server-request" as const }
                  : { kind: "delegated-api" as const, body }),
              },
              verification: binding.verification,
              // The grant's user and organization come from the signed principal.
              scope: { appId },
              // The role the grant's user holds now: approver, else member.
              role: [roles.approver, roles.member],
              runtime: binding.runtime,
              definition,
              // The kernel re-checks the bound role and fence in each transaction.
              authorize: async () => {},
              verifyRelease: binding.verifyRelease,
            }).catch(() => {
              // Not an agent principal, or no current grant for this app.
              throw accessRequired();
            });
            session = {
              grantId: agent.agentGrant.id,
              contextForTurn: agent.contextForTurn,
              close: agent.close,
            };
            if (body !== undefined)
              forwarded = new Request(request.url, {
                method: request.method,
                headers: request.headers,
                body: body as BodyInit,
                signal: request.signal,
              });
          }
          try {
            const chat = await data.chat?.();
            // Without the built document the route offers no view: text only.
            const document = chat === undefined ? null : await chat.html();
            const handler = createWorkSessionMcpHandler({
              definition,
              ...(chat === undefined
                ? {}
                : {
                    canvas: {
                      ...(document === null
                        ? {}
                        : {
                            read: async () =>
                              canvasResourceContents(chat, { appId, definition }, document),
                          }),
                      webLink: (sessionId: string) =>
                        `${new URL(chat.publicOrigin).origin}/${appId}/${encodeURIComponent(sessionId)}`,
                    },
                  }),
              // One conversation per grant and MCP session; a request without
              // an MCP session is its own.
              conversationId: JSON.stringify([
                session.grantId,
                request.headers.get("mcp-session-id") ?? randomUUID(),
              ]),
              contextForTurn: session.contextForTurn,
            });
            return closeAfter(await handler.fetch(forwarded), session.close);
          } catch (error) {
            await session.close();
            throw error;
          }
        } catch (error) {
          return failureResponse(error);
        }
      },
    },
  };
}
