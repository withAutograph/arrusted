import { createHash } from "node:crypto";
import { Client, Pool } from "pg";
import { createPostgresDataContext } from "@autograph/generated-app-runtime/postgres";
import type { PostgresDataContext } from "@autograph/generated-app-runtime/postgres";
import type { DataContext, DataDefinition } from "@autograph/generated-app-runtime/data";
import { createWorkSessionClient } from "@autograph/generated-app-runtime/data";
import {
  PRINCIPAL_HEADER,
  requireVerifiedAppActorGrant,
  requireVerifiedAppAccess,
} from "./identity";
import type { PrincipalVerifier } from "./identity";
import { verifyZoneRequestPrincipal } from "./zone-ingress";
import {
  protectedNextActionRequest,
  VERIFIED_BODY_HEADER,
  VERIFIED_METHOD_HEADER,
  VERIFIED_TARGET_HEADER,
} from "./next-request-ingress";

export type VerifiedDataRequest = {
  headers: Headers;
  method: string;
  target: string;
} & (
  | { kind: "server-request" }
  | { kind: "delegated-api"; body: Uint8Array }
  | { kind: "next-action"; bodySha256: string }
  | { kind: "next-read" }
);
export type VerifiedDataScope = { appId: string; actorId: string; organizationId: string };
export type ProtectedDataPayload =
  | null
  | boolean
  | number
  | string
  | readonly ProtectedDataPayload[]
  | { readonly [key: string]: ProtectedDataPayload };
export type VerifiedDataRuntime = {
  databaseUrl: string;
  database: string;
  hostname: string;
  port: number;
  runtimeRole: string;
  environment: "local" | "hosted";
};
export type VerifiedDataVerification =
  | { kind: "public-key"; verifier: PrincipalVerifier }
  | {
      kind: "public-jwks";
      options: Pick<
        Parameters<typeof verifyZoneRequestPrincipal>[0],
        "publicOrigin" | "jwksUrl" | "loadJwks" | "loadJwksHeaders" | "jwksTimeoutMs"
      >;
    };

const reject = () => new Error("Protected Gateway data context is unavailable");
const assertRuntime = (runtime: VerifiedDataRuntime) => {
  const url = new URL(runtime.databaseUrl);
  const checks = [
    ["postgres:", "postgresql:"].includes(url.protocol),
    url.hostname === runtime.hostname,
    Number(url.port || 5432) === runtime.port,
    decodeURIComponent(url.pathname.slice(1)) === runtime.database,
    decodeURIComponent(url.username) === runtime.runtimeRole,
    url.password.length > 0,
    url.hash.length === 0,
    url.searchParams.getAll("sslmode").length === 1,
    url.searchParams.get("sslmode") ===
      (runtime.environment === "local" ? "disable" : "verify-full"),
    runtime.environment !== "local" || runtime.hostname === "127.0.0.1",
    [...url.searchParams.keys()].every((key) => ["sslmode", "channel_binding"].includes(key)),
    url.searchParams.getAll("channel_binding").length <= 1,
    !url.searchParams.has("channel_binding") ||
      url.searchParams.get("channel_binding") === "require",
  ];
  if (!checks.every(Boolean)) throw reject();
};

type VerifiedPrincipalInput = {
  request: VerifiedDataRequest;
  verification: VerifiedDataVerification;
  scope: VerifiedDataScope;
  /** The role to bind, or (agent) roles in preference order: the first the principal grants. */
  role: string | readonly string[] | null;
  /** An agent context requires the principal's `agentGrant`; every other context refuses it. */
  agent?: boolean;
  /** A canvas API context requires the principal's `canvasGrant`; every other context refuses it. */
  canvas?: boolean;
};

/** Verifies the signed principal for this exact request and returns its current app grant. */
async function verifyRequestPrincipal(
  input: Omit<VerifiedPrincipalInput, "scope"> & {
    /** An agent context takes its actor and organization from the verified principal. */
    scope: VerifiedDataScope | { appId: string };
  },
) {
  if (typeof window !== "undefined") throw reject();
  const requested = input.scope;
  const token = input.request.headers.get(PRINCIPAL_HEADER);
  if (!token) throw reject();
  const principal =
    input.verification.kind === "public-key"
      ? input.verification.verifier.verify(token, {
          audience: requested.appId,
          method: input.request.method,
          path: input.request.target,
          ...(input.agent === true ? { agent: true } : {}),
          ...(input.canvas === true ? { canvas: true } : {}),
        })
      : await verifyZoneRequestPrincipal({
          ...input.verification.options,
          audience: requested.appId,
          headers: input.request.headers,
          method: input.request.method,
          path: input.request.target,
          ...(input.agent === true ? { agent: true } : {}),
          ...(input.canvas === true ? { canvas: true } : {}),
        });
  if (input.request.kind === "delegated-api") {
    if (
      principal.bodySha256 !== createHash("sha256").update(input.request.body).digest("base64url")
    )
      throw reject();
  } else if (input.request.kind === "next-action") {
    const ingress = protectedNextActionRequest(input.request.headers);
    if (
      ingress.method !== input.request.method ||
      ingress.target !== input.request.target ||
      ingress.bodySha256 !== input.request.bodySha256 ||
      principal.bodySha256 !== ingress.bodySha256
    )
      throw reject();
  } else if (input.request.kind === "next-read") {
    if (
      input.request.headers.get(VERIFIED_METHOD_HEADER) !== input.request.method ||
      input.request.headers.get(VERIFIED_TARGET_HEADER) !== input.request.target
    )
      throw reject();
    if (!["GET", "HEAD", "OPTIONS"].includes(principal.method)) {
      const digest = input.request.headers.get(VERIFIED_BODY_HEADER);
      if (!digest || principal.bodySha256 !== digest) throw reject();
    } else if (principal.bodySha256 !== undefined) throw reject();
  } else if (principal.bodySha256 !== undefined) throw reject();
  if (!("actorId" in requested) && input.agent !== true) throw reject();
  const scope = Object.freeze(
    "actorId" in requested
      ? { ...requested }
      : {
          appId: requested.appId,
          actorId: principal.sub,
          organizationId: principal.organizationId,
        },
  );
  if (input.role === null) {
    if (input.agent === true) throw reject();
    const admission = requireVerifiedAppAccess(principal, scope);
    return { scope, principal, grant: { role: null, fenceGeneration: admission.fenceGeneration } };
  }
  const role =
    typeof input.role === "string"
      ? input.role
      : input.role.find((candidate) =>
          principal.appActorGrants?.some(
            (granted) => granted.role === candidate && granted.fenceGeneration > 0,
          ),
        );
  if (role === undefined) throw reject();
  const grant = requireVerifiedAppActorGrant(principal, { ...scope, role });
  if (grant.fenceGeneration <= 0) throw reject();
  return { scope, principal, grant };
}

function openPool(runtime: VerifiedDataRuntime) {
  assertRuntime(runtime);
  const pool = new Pool({ connectionString: runtime.databaseUrl, max: 4 });
  pool.on("error", () => {
    /* A request establishes its own outcome; idle errors contain private connection data. */
  });
  return pool;
}

/** Server-only bridge; current binding and SHARE locks are enforced by the kernel inside each real DataContext transaction. */
export async function createVerifiedGatewayDataContext(
  input: Omit<VerifiedPrincipalInput, "agent" | "role"> & {
    /** null selects explicit app admission; it never satisfies a business role. */
    role: string | null;
    runtime: VerifiedDataRuntime;
    sourceKind: string;
    authorize: DataContext["authorize"];
    verifyRelease: () => void;
    /** Validated, server-normalized DTO; raw signed HTTP bytes remain a separate identity. */
    normalizedPayload?: ProtectedDataPayload;
  },
): Promise<{ context: PostgresDataContext; close: () => Promise<void> }> {
  try {
    const { scope, principal, grant } = await verifyRequestPrincipal({ ...input, agent: false });
    const readOnly = input.request.kind === "next-read";
    const mutation = !readOnly && !["GET", "HEAD", "OPTIONS"].includes(principal.method);
    if (mutation && (input.normalizedPayload === undefined || principal.bodySha256 === undefined))
      throw reject();
    const payloadSha256 =
      input.normalizedPayload === undefined
        ? undefined
        : protectedDataPayloadSha256(input.normalizedPayload);
    const pool = openPool(input.runtime);
    const context = createPostgresDataContext({
      pool,
      readOnly,
      appId: scope.appId,
      customerId: scope.organizationId,
      actorId: scope.actorId,
      actorBinding: Object.freeze({ role: grant.role, fenceGeneration: grant.fenceGeneration }),
      sourceKind: input.sourceKind,
      authorize: input.authorize,
      verifyRelease: input.verifyRelease,
      ...(!mutation
        ? {}
        : {
            protectedHttpRequest: {
              audience: principal.aud,
              expiresAt: principal.exp,
              issuer: principal.iss,
              jti: principal.jti,
              method: principal.method,
              target: principal.path,
              ...(principal.bodySha256 === undefined ? {} : { bodySha256: principal.bodySha256 }),
              ...(payloadSha256 === undefined ? {} : { payloadSha256 }),
            },
          }),
    });
    return {
      context,
      close: async () => {
        await pool.end();
      },
    };
  } catch {
    // Private URLs, provider failures and principal payloads never become app-facing diagnostics.
    throw reject();
  }
}

const agentWorkOperations = new Set([
  "list",
  // A new session for the person the agent acts for (theirs, like `git checkout -b`).
  "create",
  "get_without_overlay",
  "entries",
  "stage",
  "unstage",
  "discard_source",
  "discard_turn",
  "thread_open",
  // The agent asks the person to Save; the person answers in the canvas.
  "save_request",
  "thread_reply",
  "thread_resolve",
  "propose",
  "dismiss",
  "rule_create",
  "rule_parameters",
  "rule_remove",
  // Layout and as-of only: the kernel refuses any other session patch from an agent.
  "update",
]);
const agentModelReads = new Set(["get", "list", "count", "aggregate", "history"]);

/**
 * The agent context's capability list: the generated data clients' reads and
 * the agent work-session operations, including starting a session and a
 * layout update. Never get with the overlay, writes, or human-only session
 * operations.
 */
export function agentCapabilityAllowed(
  definition: Pick<DataDefinition, "models">,
  capability: string,
): boolean {
  if (capability.startsWith("work_session."))
    return agentWorkOperations.has(capability.slice("work_session.".length));
  return definition.models.some((model) => {
    if (!capability.startsWith(`${model.id}.`)) return false;
    const rest = capability.slice(model.id.length + 1);
    if (agentModelReads.has(rest)) return true;
    return model.relations.some(
      (relation) => relation.id !== undefined && rest === `relations.${relation.id}.list`,
    );
  });
}

/**
 * The platform agent context: the authenticated user's normal runtime context
 * (same pool, membership, role and fence) with every transaction marked as
 * agent work for one turn. It never carries a protected request; the kernel
 * refuses the marked caller's canonical writes and human-only operations.
 */
export async function createVerifiedAgentDataContext(
  input: Omit<VerifiedPrincipalInput, "agent" | "canvas" | "scope" | "role"> & {
    role: string | readonly string[];
    /** The app; the actor and organization come from the verified agent principal. */
    scope: { appId: string } | VerifiedDataScope;
    runtime: VerifiedDataRuntime;
    definition: Pick<DataDefinition, "models">;
    authorize: DataContext["authorize"];
    verifyRelease: () => void;
  },
): Promise<{
  /** The context for one turn: one per user message in chat, one per tool call in MCP. */
  contextForTurn: (turnId: string) => PostgresDataContext;
  /** The verified agent grant: its id is the conversation identity. */
  agentGrant: { id: string; clientId: string };
  /** The role the context binds. */
  role: string;
  /** The verified scope: the grant's user and organization. */
  scope: VerifiedDataScope;
  close: () => Promise<void>;
}> {
  let verified: Awaited<ReturnType<typeof verifyRequestPrincipal>>;
  let pool: Pool;
  try {
    verified = await verifyRequestPrincipal({ ...input, agent: true });
    if (verified.principal.agentGrant === undefined) throw reject();
    pool = openPool(input.runtime);
  } catch {
    throw reject();
  }
  const { scope, grant, principal } = verified;
  if (grant.role === null) throw reject();
  const agentGrant = principal.agentGrant!;
  const authorize: DataContext["authorize"] = async (capability) => {
    if (!agentCapabilityAllowed(input.definition, capability))
      throw new Error(`authorization_denied: the agent context does not allow ${capability}`);
    await input.authorize(capability);
  };
  return {
    contextForTurn: (turnId) =>
      createPostgresDataContext({
        pool,
        appId: scope.appId,
        customerId: scope.organizationId,
        actorId: scope.actorId,
        actorBinding: Object.freeze({ role: grant.role, fenceGeneration: grant.fenceGeneration }),
        sourceKind: "agent",
        agent: { turnId },
        authorize,
        verifyRelease: input.verifyRelease,
      }),
    agentGrant: { id: agentGrant.id, clientId: agentGrant.clientId },
    role: grant.role,
    scope,
    close: async () => {
      await pool.end();
    },
  };
}

/** The connection a work-session event stream listens on. */
export type WorkSessionListener = {
  query(sql: string): Promise<unknown>;
  on(
    event: "notification",
    listener: (message: { channel: string; payload?: string }) => void,
  ): unknown;
  on(event: "error" | "end", listener: () => void): unknown;
  end(): Promise<void>;
};

async function connectListener(runtime: VerifiedDataRuntime): Promise<WorkSessionListener> {
  assertRuntime(runtime);
  // Its own direct connection: LISTEN outlives any data-context transaction.
  const client = new Client({ connectionString: runtime.databaseUrl });
  client.on("error", () => {
    /* The stream ends through its own error listener; errors carry private connection data. */
  });
  await client.connect();
  return client;
}

/**
 * Server-Sent Events carrying one work session's revisions, for a verified
 * human data context. The session is read (without its overlay) as that
 * human, so a session they cannot read never streams. `revision` events carry
 * only the revision, and a `data` event says published data of this app and
 * customer changed; the browser re-reads through its own authorized reads. The context
 * is used only before the response returns; the stream ends when `signal`
 * aborts, the reader cancels or the connection fails or closes, and the
 * browser reconnects.
 */
export async function workSessionEventsResponse(input: {
  context: PostgresDataContext;
  schemaVersion: string;
  runtime: VerifiedDataRuntime;
  sessionId: string;
  signal: AbortSignal;
  /** Tests substitute the listening connection. */
  connect?: (runtime: VerifiedDataRuntime) => Promise<WorkSessionListener>;
}): Promise<Response> {
  // Set from the session the read returns: notifications carry its canonical id.
  let prefix: string | undefined;
  const heard: string[] = [];
  const encoder = new TextEncoder();
  // Revisions heard before the stream starts wait here, so none committed
  // between LISTEN and the stream's start is lost.
  const pending: string[] = [];
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let open = true;
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  const send = (text: string) => {
    if (!open) return;
    if (controller === undefined) pending.push(text);
    else controller.enqueue(encoder.encode(text));
  };
  const listener = await (input.connect ?? connectListener)(input.runtime);
  // One idempotent teardown for abort, cancel, connection error and close.
  const finish = () => {
    if (!open) return;
    open = false;
    clearInterval(keepAlive);
    input.signal.removeEventListener("abort", finish);
    void listener.end().catch(() => {});
    try {
      controller?.close();
    } catch {
      /* The reader already cancelled the stream. */
    }
  };
  // A disconnect while the session is read ends the listener then, not after.
  if (input.signal.aborted) finish();
  else input.signal.addEventListener("abort", finish, { once: true });
  const hear = (payload: string) => {
    if (prefix !== undefined && payload.startsWith(prefix))
      send(`event: revision\ndata: ${payload.slice(prefix.length)}\n\n`);
  };
  // Published data of this app and customer changed: the browser re-reads.
  const scope = `${input.context.scope.appId}:${input.context.scope.customerId}`;
  let dataHeard = false;
  listener.on("notification", ({ channel, payload }) => {
    if (payload === undefined) return;
    if (channel === "kernel_canonical" && payload === scope) {
      if (prefix === undefined) dataHeard = true;
      else send("event: data\ndata: \n\n");
      return;
    }
    if (channel !== "kernel_work_session") return;
    if (prefix === undefined) heard.push(payload);
    else hear(payload);
  });
  listener.on("error", finish);
  listener.on("end", finish);
  let revision: number;
  try {
    // Listen before reading, so no revision committed after the read is missed.
    await listener.query("listen kernel_work_session; listen kernel_canonical");
    const session = await createWorkSessionClient(input.context, input.schemaVersion).request({
      operation: "get",
      session_id: input.sessionId,
      overlay: false,
    });
    revision = session.revision;
    prefix = `${input.context.scope.customerId}:${session.id}:`;
    for (const payload of heard.splice(0)) hear(payload);
    if (dataHeard) send("event: data\ndata: \n\n");
  } catch (error) {
    // The browser left first: its stream simply ends.
    if (!open) return new Response(null, { status: 204 });
    finish();
    throw error;
  }
  const stream = new ReadableStream<Uint8Array>({
    start(started) {
      started.enqueue(encoder.encode(`event: revision\ndata: ${revision}\n\n`));
      controller = started;
      for (const text of pending.splice(0)) send(text);
      if (!open) {
        started.close();
        return;
      }
      // Proxies close idle streams; a comment line keeps this one open.
      keepAlive = setInterval(() => send(": keep-alive\n\n"), 25_000);
    },
    cancel() {
      controller = undefined;
      finish();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform" },
  });
}

/** Server Actions use request headers actually forwarded by the mandatory body-verifying proxy. */
export async function createVerifiedNextActionDataContext(
  input: Omit<
    Parameters<typeof createVerifiedGatewayDataContext>[0],
    "request" | "normalizedPayload"
  > & { normalizedPayload: ProtectedDataPayload },
) {
  const { headers } = await import("next/headers");
  const ingress = protectedNextActionRequest(new Headers(await headers()));
  return await createVerifiedGatewayDataContext({
    ...input,
    request: { kind: "next-action", ...ingress },
  });
}

/** Verified Server Component reads remain read-only when an action refresh retains POST headers. */
export async function createVerifiedNextReadDataContext(
  input: Omit<
    Parameters<typeof createVerifiedGatewayDataContext>[0],
    "request" | "normalizedPayload"
  >,
) {
  const { headers: readHeaders } = await import("next/headers");
  const headers = new Headers(await readHeaders());
  const method = headers.get(VERIFIED_METHOD_HEADER);
  const target = headers.get(VERIFIED_TARGET_HEADER);
  if (!method || !target) throw reject();
  return await createVerifiedGatewayDataContext({
    ...input,
    request: { kind: "next-read", headers, method, target },
  });
}

/** Canonical validated JSON DTO identity; rejects lossy or prototype-defined serialization. */
export function protectedDataPayloadSha256(payload: ProtectedDataPayload): string {
  const ancestors = new Set<object>();
  const canonical = (value: ProtectedDataPayload): string => {
    if (value === null || typeof value === "boolean" || typeof value === "string")
      return JSON.stringify(value);
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw reject();
      return JSON.stringify(value);
    }
    if (typeof value !== "object" || ancestors.has(value)) throw reject();
    const prototype: unknown = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
      throw reject();
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1)
          if (!Object.hasOwn(value, index)) throw reject();
        return `[${value.map((item) => canonical(item)).join(",")}]`;
      }
      return `{${Object.keys(value)
        .toSorted()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${canonical((value as Readonly<Record<string, ProtectedDataPayload>>)[key]!)}`,
        )
        .join(",")}}`;
    } finally {
      ancestors.delete(value);
    }
  };
  return createHash("sha256").update(canonical(payload)).digest("base64url");
}
