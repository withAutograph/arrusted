// @vitest-environment node
// Owned-PostgreSQL round trips through the canvas host in both modes of the
// generated data foundation, with test adapters that build the contexts as
// `app/data/context.ts` does:
// - legacy Auth mode: the session's roles from the app assignment and a
//   plain runtime context (no actor binding);
// - protected Gateway mode (`actor_binding_required`): the session from the
//   verified principal, and verified contexts binding the signed role and
//   fence, every mutation bound to its signed request and normalized DTO.
// A member creates a session, stages and Saves it as a draft; every member
// reads the drafts, diffs, activity and authors and replies on its threads,
// only its author resolves and no member acts on it; an approver lists,
// reads, notes, threads and approves it, and reads a discarded one on the
// Rejected tab; the events route streams the session's revision and closes its
// listener on abort. Protected mode also refuses a replayed request with
// another payload and a revoked fence. Both modes serve the MCP tools to an
// agent grant only (protected: the Gateway's signed agent principal; legacy:
// the app's bearer verification) with the agent limits and one turn per call,
// refuse a browser session there, and cut the agent off on a revoked fence
// (protected) or a removed assignment (legacy). Reuses the work-session acceptance fixture's
// private cluster and test-owned app.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, test } from "vitest";
import { createDataClient, type WorkSession } from "@autograph/generated-app-runtime/data";
import {
  createPostgresDataContext,
  type PostgresDataContext,
} from "@autograph/generated-app-runtime/postgres";
import { PRINCIPAL_HEADER } from "@autograph/platform-microfrontends/identity";
import {
  protectedNextActionRequest,
  VERIFIED_BODY_HEADER,
  VERIFIED_METHOD_HEADER,
  VERIFIED_TARGET_HEADER,
} from "@autograph/platform-microfrontends/next-request-ingress";
import {
  createVerifiedGatewayDataContext,
  type WorkSessionListener,
} from "@autograph/platform-microfrontends/verified-data-context";
import { Client } from "pg";
import {
  human,
  install,
  runtimeOf,
  startPostgres,
  stopPostgres,
  type InstalledApp,
} from "../../work-session-tools/__tests__/postgres-fixture";
import {
  createCanvasHost,
  createLegacyAgentSession,
  createLegacyCanvasPerson,
  runtimeFromDatabaseUrl,
  type CanvasActionResult,
  type CanvasDataOptions,
  type CanvasHostData,
  type CanvasPersonData,
  type CanvasViewer,
} from "../server";
import { actionHeaders, pageHeaders, verifier, type Who } from "./principal";

/** Edits are last-write-wins: sent with no revision or request id. */
const isEdit = (request: Record<string, unknown>) =>
  ["update", "stage", "unstage", "discard_source", "discard_turn"].includes(
    String(request.operation),
  );

const editor = [{ role: "editor", fenceGeneration: 1 }];
/** The session's author. */
const author: Who = { actorId: "person", customerId: "tenant", grants: editor };
/** Another member of the same customer. */
const colleague: Who = { actorId: "colleague", customerId: "tenant", grants: editor };
/** An approver of the same customer. */
const boss: Who = {
  actorId: "boss",
  customerId: "tenant",
  grants: [{ role: "approver", fenceGeneration: 1 }],
};
/** A member of another customer, which the runtime does not serve. */
const outsider: Who = { actorId: "outsider", customerId: "elsewhere", grants: editor };

const ok = async <T>(result: Promise<CanvasActionResult<unknown>>): Promise<T> => {
  const settled = await result;
  assert.ok(settled.ok, `action failed: ${JSON.stringify(settled)}`);
  return settled.value as T;
};
const refused = async (result: Promise<CanvasActionResult<unknown>>, code: string) => {
  const settled = await result;
  assert.equal(settled.ok, false, `expected a refusal: ${JSON.stringify(settled)}`);
  if (!settled.ok) assert.equal(settled.error.code, code, JSON.stringify(settled.error));
};

async function bind(app: InstalledApp, request: Record<string, unknown>, operation: string) {
  const result = (
    await app.owner.query(`select ${operation}($1::jsonb) result`, [
      JSON.stringify({ principal_name: app.runtimeRole, app_id: app.app, ...request }),
    ])
  ).rows[0].result;
  assert.equal(result.ok, true, `${operation}: ${JSON.stringify(result)}`);
}

type Mode = "legacy" | "protected";
/** What the test sets for the next request: Gateway headers and, in legacy mode, the signed-in user. */
type RequestState = { headers: Headers; who: Who | null; ended: number };

/** Auth's current app assignments in legacy mode. */
const assignments: Record<string, string[]> = {
  "tenant:person": ["editor"],
  "tenant:colleague": ["editor"],
  "tenant:boss": ["approver"],
  "elsewhere:outsider": ["editor"],
};
/** Legacy mode's issued agent tokens: the grant and the user it acts for. */
const agentTokens: Record<string, { grantId: string; actorId: string; customerId: string }> = {
  "legacy-agent-token": { grantId: "grant-legacy", actorId: "person", customerId: "tenant" },
};
const denied = (code: string, status: number) => Object.assign(new Error(code), { code, status });

/**
 * The legacy Auth foundation, as `createLegacyDataContext` builds it: the
 * session's scope and current roles, and a runtime context with no actor
 * binding that re-checks the session before each transaction.
 */
function legacyData(app: InstalledApp, state: RequestState): CanvasHostData {
  const session = async (options: CanvasDataOptions = {}): Promise<CanvasViewer> => {
    if (state.who === null) throw denied("auth_required", 401);
    const roles = assignments[`${state.who.customerId}:${state.who.actorId}`] ?? [];
    if (roles.length === 0 || (options.requiredRole && !roles.includes(options.requiredRole)))
      throw denied("app_access_required", 403);
    return { scope: { actorId: state.who.actorId, customerId: state.who.customerId }, roles };
  };
  const context = async (options: CanvasDataOptions) => {
    const { scope, roles } = await session(options);
    return createPostgresDataContext({
      pool: app.runtime,
      appId: app.app,
      customerId: scope.customerId,
      actorId: scope.actorId,
      sourceKind: "human",
      authorize: async () => {
        const current = await session(options);
        if (
          current.scope.actorId !== scope.actorId ||
          current.scope.customerId !== scope.customerId ||
          roles.some((role) => !current.roles.includes(role))
        )
          throw new Error("Authenticated scope or app role changed during operation");
      },
      verifyRelease: () => {},
    });
  };
  return {
    session,
    read: async (options, run) => await run({ context: await context(options) }),
    action: async (_payload, options, run) => {
      const ctx = await context(options);
      return await ctx.requestTransaction(() => run({ context: ctx }));
    },
    events: () => ({ runtime: runtimeFromDatabaseUrl(runtimeOf(app).databaseUrl) }),
    // The app's own bearer verification (the real one is Auth's
    // requireAgentGrantContext): a known grant whose user still holds an
    // assignment opens a legacy agent session, re-checked per transaction.
    agent: () => ({
      kind: "legacy",
      open: async (request) => {
        const grant = agentTokens[(request.headers.get("authorization") ?? "").slice(7)];
        const challenge =
          'Bearer resource_metadata="https://zone.test/.well-known/oauth-protected-resource/x/api/mcp", scope="work_session"';
        if (grant === undefined)
          return new Response(null, { status: 401, headers: { "www-authenticate": challenge } });
        const held = () => (assignments[`${grant.customerId}:${grant.actorId}`] ?? []).length > 0;
        if (!held()) return new Response(null, { status: 403 });
        return createLegacyAgentSession({
          pool: app.runtime,
          appId: app.app,
          definition: app.definition,
          grant: {
            grantId: grant.grantId,
            actorId: grant.actorId,
            organizationId: grant.customerId,
          },
          recheck: async () => {
            if (!held()) throw new Error("authorization_denied: the agent grant was revoked");
          },
          verifyRelease: () => {},
        });
      },
    }),
    actorNames:
      () =>
      async ({ organizationId, actorIds }): Promise<Record<string, string>> =>
        organizationId === "tenant" && actorIds.includes("person") ? { person: "Pat Person" } : {},
  };
}

/**
 * The protected Gateway foundation, as `createProtectedDataContext` builds
 * it: the session from the verified principal's grants, and verified
 * contexts for the request the app's proxy verified (`next/headers` here is
 * the test's headers). No shared Auth database: no author names.
 */
function protectedData(app: InstalledApp, state: RequestState): CanvasHostData {
  const session = async (options: CanvasDataOptions = {}): Promise<CanvasViewer> => {
    const method = state.headers.get(VERIFIED_METHOD_HEADER);
    const target = state.headers.get(VERIFIED_TARGET_HEADER);
    const token = state.headers.get(PRINCIPAL_HEADER);
    if (!method || !target || !token)
      throw new Error("Verified Next request ingress is unavailable");
    // As `getAppSession` maps it: an unverifiable principal (an agent
    // principal included) is a sign-in, never a session.
    let principal: ReturnType<typeof verifier.verify>;
    try {
      principal = verifier.verify(token, { audience: app.app, method, path: target });
    } catch {
      throw denied("auth_required", 401);
    }
    const roles = (principal.appActorGrants ?? [])
      .filter((grant) => grant.fenceGeneration > 0)
      .map((grant) => grant.role);
    if (
      !principal.organizationId ||
      roles.length === 0 ||
      (options.requiredRole !== undefined && !roles.includes(options.requiredRole))
    )
      throw new Error("Protected app role is required");
    return { scope: { actorId: principal.sub, customerId: principal.organizationId }, roles };
  };
  const open = async (
    options: CanvasDataOptions,
    payload?: Parameters<CanvasHostData["action"]>[0],
  ): Promise<{ context: PostgresDataContext; close: () => Promise<void> }> => {
    const viewer = await session(options);
    const role = options.requiredRole ?? viewer.roles[0]!;
    const headers = new Headers(state.headers);
    const method = headers.get(VERIFIED_METHOD_HEADER)!;
    const target = headers.get(VERIFIED_TARGET_HEADER)!;
    return await createVerifiedGatewayDataContext({
      request:
        payload === undefined
          ? { kind: "next-read", headers, method, target }
          : { kind: "next-action", ...protectedNextActionRequest(headers) },
      verification: { kind: "public-key", verifier },
      scope: {
        appId: app.app,
        actorId: viewer.scope.actorId,
        organizationId: viewer.scope.customerId,
      },
      role,
      runtime: runtimeOf(app),
      sourceKind: "human",
      authorize: async () => {
        const current = await session({ requiredRole: role });
        if (
          current.scope.actorId !== viewer.scope.actorId ||
          current.scope.customerId !== viewer.scope.customerId
        )
          throw new Error("Protected app scope changed during operation");
      },
      verifyRelease: () => {},
      ...(payload === undefined ? {} : { normalizedPayload: payload }),
    });
  };
  return {
    session,
    read: async (options, run) => {
      const handle = await open(options);
      try {
        return await run(handle);
      } finally {
        await handle.close();
      }
    },
    action: async (payload, options, run) => {
      const handle = await open(options, payload);
      try {
        return await handle.context.requestTransaction(() => run(handle));
      } finally {
        await handle.close();
      }
    },
    events: () => ({ runtime: runtimeOf(app) }),
    agent: () => ({
      kind: "protected",
      verification: { kind: "public-key", verifier },
      runtime: runtimeOf(app),
      verifyRelease: () => {},
    }),
  };
}

async function roundTrip(app: InstalledApp, mode: Mode) {
  const state: RequestState = { headers: new Headers(), who: null, ended: 0 };
  const foundation = mode === "legacy" ? legacyData(app, state) : protectedData(app, state);
  const host = createCanvasHost({
    appId: app.app,
    definition: app.definition,
    roles: { member: "editor", approver: "approver" },
    data: {
      ...foundation,
      // The real listener, observed: the route must end it when the browser leaves.
      events: () => ({
        runtime: foundation.events().runtime,
        connect: async (runtime) => {
          const client = new Client({ connectionString: runtime.databaseUrl });
          await client.connect();
          const end = client.end.bind(client);
          return Object.assign(client as unknown as WorkSessionListener, {
            end: async () => {
              state.ended += 1;
              await end();
            },
          });
        },
      }),
    },
  });
  const target = `/${app.app}/session`;
  /** The next server action, as `who`. */
  const as = (who: Who) => {
    state.who = who;
    state.headers = actionHeaders(who, target);
  };
  const page = (who: Who) => {
    state.who = who;
    state.headers = pageHeaders(who, target);
  };
  /**
   * One read through the read route, as the last `as` user: the Gateway
   * signs the POST and its body, and the app's proxy verifies both.
   */
  const readPath = `/${app.app}/api/read`;
  const readRoute = async (body: unknown): Promise<CanvasActionResult<unknown>> => {
    const text = JSON.stringify(body);
    if (state.who !== null) state.headers = actionHeaders(state.who, readPath, text);
    const headers = new Headers(state.headers);
    headers.set("content-type", "application/json");
    const response = await host.routes.read(
      new Request(`https://zone.test${readPath}`, { method: "POST", headers, body: text }),
    );
    return (await response.json()) as CanvasActionResult<unknown>;
  };
  const reads = {
    session: (input: unknown) => readRoute({ read: "session", input }),
    list: (model: string, query: unknown) => readRoute({ read: "list", model, query }),
    drafts: (path: string, body: unknown = null) => readRoute({ read: "drafts", path, body }),
    threads: (operation: string, input: unknown) =>
      readRoute({ read: "threads", operation, input }),
    authors: (actorIds: string[]) => readRoute({ read: "authors", actor_ids: actorIds }),
  };
  /** A thread operation on its surface: `get` and `by_session` read, the rest are actions. */
  const threadCall = (operation: string, input: unknown) =>
    operation === "get" || operation === "by_session"
      ? reads.threads(operation, input)
      : host.mutations.threads(operation, input);

  // Published data the session works over, written before the installation
  // is protected; then the other actors' bindings and protection.
  const data = createDataClient(app.definition, human(app)) as unknown as Record<
    string,
    { create(values: unknown, options: unknown): Promise<unknown> }
  >;
  for (const [index, score] of ["10", "20"].entries())
    await data.item!.create(
      { owner: "person", score, phase: "draft" },
      { effectiveStart: "2026-01-01", idempotencyKey: `host-seed-${index}` },
    );
  for (const [actor, role] of [
    ["colleague", "editor"],
    ["boss", "approver"],
  ])
    await bind(
      app,
      { customer_id: "tenant", actor_id: actor, role, actor_kind: "human", fence_generation: 1 },
      "kernel_bind_actor_membership",
    );
  // Protected mode: the runtime scope requires every context's actor binding.
  if (mode === "protected")
    await bind(
      app,
      { capability: "runtime", customer_id: "tenant", actor_binding_required: true },
      "kernel_bind_principal_scope",
    );

  // New session: the browser names the session, the gesture and its as-of
  // date once and keeps all three across a retry, so a retry whose first
  // answer was lost replays (protected: the same signed request, or a new
  // one) and never creates a second session, even after midnight; other
  // content under the same ids is refused. The gesture here began
  // yesterday (UTC): the retries run "after midnight" with its date.
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const creation = {
    title: "Comp plan",
    models: ["item"],
    session_id: randomUUID(),
    request_id: randomUUID(),
    as_of: yesterday,
  };
  as(author);
  const createHeaders = state.headers;
  const { sessionId } = await ok<{ sessionId: string }>(host.mutations.createSession(creation));
  assert.equal(sessionId, creation.session_id);
  if (mode === "protected") {
    state.headers = createHeaders;
    assert.deepEqual(await ok(host.mutations.createSession(creation)), { sessionId });
    state.headers = createHeaders;
    await refused(
      host.mutations.createSession({ ...creation, title: "Other plan" }),
      "authorization_denied",
    );
  }
  as(author);
  assert.deepEqual(await ok(host.mutations.createSession(creation)), { sessionId });
  as(author);
  await refused(
    host.mutations.createSession({ ...creation, title: "Other plan" }),
    "idempotency_conflict",
  );
  page(author);
  const listed = await host.sessions.list();
  assert.deepEqual(
    listed.map((s) => [s.id, s.title, s.models]),
    [[sessionId, "Comp plan", ["item"]]],
  );
  assert.equal(listed[0]!.asOf, yesterday);
  page(colleague);
  assert.equal(await host.sessions.get(sessionId), null);

  as(author);
  const rows = await ok<{ id: string; score: string }[]>(
    reads.list("item", {
      asOf: listed[0]!.asOf,
      orderBy: [{ field: "score", direction: "asc" }],
      select: ["id", "score"],
    }),
  );
  assert.deepEqual(
    rows.map((row) => row.score),
    ["10", "20"],
  );
  const header = async () => {
    as(author);
    return await ok<WorkSession>(
      reads.session({ operation: "get", session_id: sessionId, overlay: false }),
    );
  };
  const guard = async () => ({
    session_id: sessionId,
    expected_revision: (await header()).revision,
    request_id: randomUUID(),
  });
  const session = async (request: Record<string, unknown>) => {
    const body = isEdit(request)
      ? { session_id: sessionId, ...request }
      : { ...(await guard()), ...request };
    as(author);
    return await host.mutations.session(body);
  };
  const stageRequest = async (recordId: string, score: string) => ({
    operation: "stage",
    session_id: sessionId,
    changes: [
      {
        model_id: "item",
        record_id: recordId,
        field_id: "score",
        value: { type: "number", value: score },
      },
    ],
  });

  // A replayed server action answers from its receipt with no second effect
  // (protected: the same signed request and body; legacy: the same request
  // id). Protected mode refuses the same signed request with another payload.
  as(author);
  const staged = { operation: "pin", ...(await guard()), pinned: true };
  as(author);
  const replayHeaders = state.headers;
  const first = await ok<{ revision: number }>(host.mutations.session(staged));
  state.headers = replayHeaders;
  const again = await ok<{ revision: number }>(host.mutations.session(staged));
  assert.equal(again.revision, first.revision);
  assert.equal((await header()).revision, first.revision);
  if (mode === "protected") {
    state.who = author;
    state.headers = replayHeaders;
    await refused(
      host.mutations.session({ ...staged, request_id: randomUUID() }),
      "authorization_denied",
    );
    assert.equal((await header()).revision, first.revision);
  }
  // Staging is last-write-wins: no revision or request id; a repeat applies again.
  as(author);
  const stagedOnce = await ok<{ revision: number }>(
    host.mutations.session(await stageRequest(rows[0]!.id, "15")),
  );
  as(author);
  const stagedTwice = await ok<{ revision: number }>(
    host.mutations.session(await stageRequest(rows[0]!.id, "15")),
  );
  assert.equal(stagedTwice.revision, stagedOnce.revision + 1);

  // Each surface refuses the other's: a mutation sent to the read route and
  // a read sent to an action, with no effect.
  as(author);
  await refused(
    readRoute({ read: "session", input: await stageRequest(rows[0]!.id, "99") }),
    "contract_validation_failed",
  );
  as(author);
  await refused(
    host.mutations.session({ operation: "get", session_id: sessionId, overlay: false }),
    "contract_validation_failed",
  );
  assert.equal((await header()).revision, stagedTwice.revision);

  // Open a thread and Save as a draft (mainline is refused).
  const threadId = randomUUID();
  await ok(
    session({
      operation: "thread_open",
      thread_id: threadId,
      anchor: { model_id: "item", record_id: rows[0]!.id, field_id: "score" },
    }),
  );
  await ok(session({ operation: "thread_reply", thread_id: threadId, message: "Raise to 15?" }));
  // Save always writes a draft.
  const saved = await ok<{ change_set: { id: number } }>(session({ operation: "save" }));
  assert.equal("mode" in saved, false);
  const draftId = Number(saved.change_set.id);

  // The read route passes Show drafts through: every member reads the pending
  // draft's value over mainline when asked; published data stays as it was.
  for (const who of [author, colleague]) {
    as(who);
    for (const [includePendingDrafts, scores] of [
      [true, ["15", "20"]],
      [false, ["10", "20"]],
      [undefined, ["10", "20"]],
    ] as const) {
      const shown = await ok<{ score: string }[]>(
        reads.list("item", {
          asOf: listed[0]!.asOf,
          orderBy: [{ field: "score", direction: "asc" }],
          select: ["id", "score"],
          ...(includePendingDrafts === undefined ? {} : { includePendingDrafts }),
        }),
      );
      assert.deepEqual(
        shown.map((row) => row.score),
        scores,
      );
    }
  }

  // Every member reads the workspace's drafts, diffs, activity and authors.
  for (const who of [author, colleague]) {
    as(who);
    const listed = await ok<{ id: number; actor_id: string }[]>(reads.drafts("/api/drafts"));
    assert.deepEqual(
      listed.map((draft) => [Number(draft.id), draft.actor_id]),
      [[draftId, "person"]],
    );
    as(who);
    assert.equal(
      (await ok<{ records: unknown[] }>(reads.drafts("/api/diff", { change_set_id: draftId })))
        .records.length,
      1,
    );
    as(who);
    await ok(reads.drafts("/api/activity", { limit: 25 }));
    as(who);
    assert.deepEqual(await ok(reads.drafts("/api/drafts/rejected")), []);
    as(who);
    // Names come from the shared Auth database, which protected mode never opens.
    assert.deepEqual(
      await ok(reads.authors(["person"])),
      mode === "legacy" ? { person: "Pat Person" } : {},
    );
  }
  page(colleague);
  assert.deepEqual(await host.viewer(), {
    canApprove: false,
    authors: mode === "legacy",
  });
  // The author lists the drafts their session saved; nobody else does.
  as(author);
  const fromSession = await ok<{ id: number; threads: Record<string, unknown> }[]>(
    reads.threads("by_session", { session_id: sessionId }),
  );
  assert.deepEqual(
    fromSession.map((draft) => [Number(draft.id), Object.keys(draft.threads)]),
    [[draftId, [threadId]]],
  );
  as(colleague);
  await refused(reads.threads("by_session", { session_id: sessionId }), "authorization_denied");
  // Any member reads a draft's threads and whether they may resolve them,
  // never which session it came from.
  for (const [who, canResolve] of [
    [author, true],
    [colleague, false],
  ] as const) {
    as(who);
    const draft = await ok<Record<string, unknown>>(
      reads.threads("get", { change_set_id: draftId }),
    );
    assert.equal(draft.can_resolve, canResolve);
    assert.equal("source_ref" in draft, false);
    // Nor do the drafts list and the activity feed name the session.
    as(who);
    for (const row of await ok<Record<string, unknown>[]>(reads.drafts("/api/drafts")))
      assert.equal("source_ref" in row, false);
    as(who);
    for (const row of await ok<Record<string, unknown>[]>(
      reads.drafts("/api/activity", { limit: 25 }),
    ))
      if (row.source_kind === "work_session") assert.equal("source_ref" in row, false);
  }
  // The author and a colleague both reply.
  for (const [who, message] of [
    [author, "Market rate"],
    [colleague, "Agreed"],
  ] as const) {
    as(who);
    await ok(
      host.mutations.threads("reply", {
        change_set_id: draftId,
        thread_id: threadId,
        message,
        request_id: randomUUID(),
      }),
    );
  }
  // A colleague may not resolve another's thread, nor act on the draft.
  as(colleague);
  await refused(
    host.mutations.threads("resolve", {
      change_set_id: draftId,
      thread_id: threadId,
      request_id: randomUUID(),
    }),
    "authorization_denied",
  );
  for (const [path, body] of [
    ["/api/draft/approve", { change_set_id: draftId }],
    ["/api/draft/discard", { change_set_id: draftId, notes: "No." }],
    ["/api/draft/notes", { change_set_id: draftId, notes: "Mine now" }],
    ["/api/revert", { change_set_id: draftId }],
  ] as const) {
    as(colleague);
    await refused(host.mutations.drafts(path, body), "authorization_denied");
  }
  // A member of another customer uses none of the four thread operations.
  for (const [operation, input] of [
    ["by_session", { session_id: sessionId }],
    ["get", { change_set_id: draftId }],
    [
      "reply",
      { change_set_id: draftId, thread_id: threadId, message: "Hi", request_id: randomUUID() },
    ],
    ["resolve", { change_set_id: draftId, thread_id: threadId, request_id: randomUUID() }],
  ] as const) {
    as(outsider);
    await refused(threadCall(operation, input), "authorization_denied");
  }
  // Drafts are no secret within the app: a missing one is missing to anyone.
  const missingId = draftId + 10_000;
  const missing = [
    ["get", { change_set_id: missingId }],
    [
      "reply",
      { change_set_id: missingId, thread_id: threadId, message: "Hi", request_id: randomUUID() },
    ],
    ["resolve", { change_set_id: missingId, thread_id: threadId, request_id: randomUUID() }],
  ] as const;
  for (const [operation, input] of missing)
    for (const who of [colleague, boss]) {
      as(who);
      await refused(threadCall(operation, input), "record_target_missing");
    }

  // The approver reviews: list, authors, diff, note, reply, resolve, approve.
  page(boss);
  // Protected mode has no author-name source, so the browser never asks.
  assert.deepEqual(await host.viewer(), {
    canApprove: true,
    authors: mode === "legacy",
  });
  as(boss);
  const drafts = await ok<{ id: number; source_kind: string; actor_id: string }[]>(
    reads.drafts("/api/drafts"),
  );
  assert.deepEqual(
    drafts.map((draft) => [Number(draft.id), draft.source_kind, draft.actor_id]),
    [[draftId, "work_session", "person"]],
  );
  as(boss);
  // Names come from the shared Auth database, which protected mode never opens.
  assert.deepEqual(
    await ok(reads.authors(["person", "stranger"])),
    mode === "legacy" ? { person: "Pat Person" } : {},
  );
  as(boss);
  const diff = await ok<{ records: unknown[] }>(
    reads.drafts("/api/diff", {
      // The review module repeats a scope the host ignores.
      app_id: "canvas",
      customer_id: "canvas",
      change_set_id: draftId,
    }),
  );
  assert.equal(diff.records.length, 1);
  as(boss);
  await ok(
    host.mutations.drafts("/api/draft/notes", {
      app_id: "other-app",
      customer_id: "other-customer",
      change_set_id: draftId,
      notes: "Looks right",
    }),
  );
  as(boss);
  assert.equal(
    (await ok<{ notes: string }[]>(reads.drafts("/api/drafts")))[0]!.notes,
    "Looks right",
  );
  // The session is the author's alone, even to an approver.
  as(boss);
  await refused(reads.threads("by_session", { session_id: sessionId }), "authorization_denied");
  // Two clients: the author's canvas stays open (its events stream, which
  // feeds the Comments pane) while the approver replies; the author hears it.
  const authorEvents = new AbortController();
  const authorEventsPath = `/${app.app}/api/events/${sessionId}`;
  state.who = author;
  state.headers = pageHeaders(author, authorEventsPath);
  const authorStream = await host.routes.events(
    new Request(`https://zone.test${authorEventsPath}`, {
      headers: state.headers,
      signal: authorEvents.signal,
    }),
    sessionId,
  );
  assert.equal(authorStream.status, 200);
  const authorReader = authorStream.body!.getReader();
  assert.match(new TextDecoder().decode((await authorReader.read()).value), /^event: revision/u);
  // A repeated gesture (same request id, a new signed request) adds one message.
  const gesture = {
    change_set_id: draftId,
    thread_id: threadId,
    message: "Yes",
    request_id: randomUUID(),
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    as(boss);
    const reply = await ok<{ message: { message: string } }>(
      host.mutations.threads("reply", gesture),
    );
    assert.equal(reply.message.message, "Yes");
    if (attempt === 0) {
      // The reply reaches the author's open canvas as a data event, no data in it.
      const heard = await Promise.race([
        authorReader.read().then(({ value }) => new TextDecoder().decode(value)),
        new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 5_000)),
      ]);
      assert.equal(heard, "event: data\ndata: \n\n");
      as(author);
      type AuthorDraft = { threads: Record<string, { messages: { message: string }[] }> };
      const authorDrafts: AuthorDraft[] = await ok<AuthorDraft[]>(
        reads.threads("by_session", { session_id: sessionId }),
      );
      assert.equal(authorDrafts[0]!.threads[threadId]!.messages.at(-1)!.message, "Yes");
    }
  }
  authorEvents.abort();
  await authorReader.closed;
  const endedBefore = state.ended;
  // The draft's author resolves the thread; an approver may too.
  for (const who of [author, boss]) {
    as(who);
    await ok(
      host.mutations.threads("resolve", {
        change_set_id: draftId,
        thread_id: threadId,
        request_id: randomUUID(),
      }),
    );
  }
  as(boss);
  const threaded = await ok<{
    threads: Record<string, { resolved: boolean; messages: unknown[] }>;
  }>(reads.threads("get", { change_set_id: draftId }));
  assert.equal(threaded.threads[threadId]!.resolved, true);
  // The author's question, the author's and a colleague's replies, and one approver reply.
  assert.equal(threaded.threads[threadId]!.messages.length, 4);
  as(boss);
  await ok(host.mutations.drafts("/api/draft/approve", { change_set_id: draftId }));
  as(author);
  const published = await ok<{ score: string }[]>(
    reads.list("item", {
      asOf: listed[0]!.asOf,
      orderBy: [{ field: "score", direction: "asc" }],
      select: ["score"],
    }),
  );
  assert.deepEqual(
    published.map((row) => row.score),
    ["15", "20"],
  );

  // A second draft is discarded, listed as rejected, and its rows stay readable.
  const second = await ok<{ change_set: { id: number } }>(
    (async () => {
      const request = await stageRequest(rows[1]!.id, "30");
      as(author);
      await ok(host.mutations.session(request));
      return await session({ operation: "save" });
    })(),
  );
  // A rejection's note lands only with its discard: rejecting the draft that
  // was already published is refused and leaves its note as it was.
  as(boss);
  await refused(
    host.mutations.drafts("/api/draft/discard", { change_set_id: draftId, notes: "Too late." }),
    "draft_status_conflict",
  );
  as(boss);
  const stillPublished = await ok<{ status: string; notes: string | null }>(
    reads.threads("get", { change_set_id: draftId }),
  );
  assert.equal(stillPublished.status, "mainline");
  assert.equal(stillPublished.notes, "Looks right");
  as(boss);
  await ok(
    host.mutations.drafts("/api/draft/discard", {
      change_set_id: second.change_set.id,
      notes: "Not this quarter.",
    }),
  );
  as(boss);
  const rejected = await ok<{ id: number; notes: string | null }[]>(
    reads.drafts("/api/drafts/rejected"),
  );
  assert.deepEqual(
    rejected.map((draft) => Number(draft.id)),
    [Number(second.change_set.id)],
  );
  assert.equal(rejected[0]!.notes, "Not this quarter.");
  as(boss);
  const rejectedDiff = await ok<{ records: unknown[] }>(
    reads.drafts("/api/diff", { change_set_id: second.change_set.id }),
  );
  assert.equal(rejectedDiff.records.length, 1);

  // The events route streams the session's current revision first, and ends
  // its listener when the browser leaves.
  const eventsPath = `/${app.app}/api/events/${sessionId}`;
  const abort = new AbortController();
  const expectedRevision = (await header()).revision;
  state.who = author;
  state.headers = pageHeaders(author, eventsPath);
  const response = await host.routes.events(
    new Request(`https://zone.test${eventsPath}`, {
      headers: state.headers,
      signal: abort.signal,
    }),
    sessionId,
  );
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const opening = new TextDecoder().decode((await reader.read()).value);
  assert.equal(opening, `event: revision\ndata: ${expectedRevision}\n\n`);
  assert.equal(state.ended, endedBefore);
  abort.abort();
  await reader.closed;
  assert.equal(state.ended, endedBefore + 1);

  // The MCP route uses a signed agent principal in protected mode and the
  // app's own bearer verification in legacy mode. A browser session is refused.
  const mcpPath = `/${app.app}/api/mcp`;
  const agentAuthor: Who = { ...author, agentGrant: { id: "grant-protected", clientId: "client" } };
  let mcpSession: string | null = null;
  type RpcBody = {
    result?: { content: { text: string }[]; isError?: boolean; tools?: { name: string }[] };
    error?: unknown;
  } | null;
  /** One JSON-RPC call through the MCP route, as the agent: its status and answer. */
  const rpcStatus = async (
    id: number | null,
    method: string,
    params: unknown,
    who: Who | "human" = agentAuthor,
  ): Promise<{ status: number; body: RpcBody; headers: Headers }> => {
    const body = JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params });
    let headers: Headers;
    if (mode === "protected") {
      headers = actionHeaders(who === "human" ? author : who, mcpPath, body);
    } else {
      headers = new Headers(who === "human" ? {} : { authorization: "Bearer legacy-agent-token" });
      state.who = who === "human" ? author : null;
    }
    headers.set("content-type", "application/json");
    headers.set("accept", "application/json, text/event-stream");
    headers.set("mcp-protocol-version", "2025-06-18");
    if (mcpSession !== null) headers.set("mcp-session-id", mcpSession);
    const response = await host.routes.mcp(
      new Request(`https://zone.test${mcpPath}`, { method: "POST", headers, body }),
    );
    mcpSession = response.headers.get("mcp-session-id") ?? mcpSession;
    const text = await response.text();
    if (id === null || text === "")
      return { status: response.status, body: null, headers: response.headers };
    if (response.status >= 300 && !text.includes("jsonrpc"))
      return {
        status: response.status,
        body: JSON.parse(text) as RpcBody,
        headers: response.headers,
      };
    // A JSON body, or one Server-Sent Event carrying the JSON-RPC response.
    const json = text.trimStart().startsWith("{")
      ? text
      : text
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5))
          .join("");
    return {
      status: response.status,
      body: JSON.parse(json) as RpcBody,
      headers: response.headers,
    };
  };
  const rpc = async (id: number | null, method: string, params: unknown) => {
    const { status, body } = await rpcStatus(id, method, params);
    assert.ok(status < 300, `${method}: ${status} ${JSON.stringify(body)}`);
    return body;
  };
  let rpcId = 10;
  /** One tool call; its decoded result (failing the test on a tool error). */
  const tool = async (name: string, args: Record<string, unknown>) => {
    const called = await rpc(rpcId++, "tools/call", { name, arguments: args });
    assert.ok(called?.result && !called.result.isError, `${name}: ${JSON.stringify(called)}`);
    return JSON.parse(called.result.content[0]!.text) as Record<string, unknown>;
  };
  // A browser session (a human principal, or a cookie-only request) is refused.
  const browser = await rpcStatus(1, "initialize", {}, "human");
  if (mode === "protected") {
    assert.equal(browser.status, 403, JSON.stringify(browser.body));
    const cookieOnly = await host.routes.mcp(
      new Request(`https://zone.test${mcpPath}`, {
        method: "POST",
        headers: {
          cookie: "better-auth.session_token=x",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      }),
    );
    assert.equal(cookieOnly.status, 401);
  } else {
    assert.equal(browser.status, 401, JSON.stringify(browser.body));
    assert.match(browser.headers.get("www-authenticate") ?? "", /resource_metadata/u);
  }
  await rpc(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "canvas-host-test", version: "1.0.0" },
  });
  await rpc(null, "notifications/initialized", {});
  const tools = (await rpc(2, "tools/list", {}))?.result?.tools?.map((t) => t.name) ?? [];
  assert.ok(tools.includes("stage_changes"), JSON.stringify(tools));
  // No tool saves, publishes, approves, reverts a draft, changes a setting or
  // writes canonically; `request_save` only asks the person to Save.
  for (const name of tools.filter((tool) => tool !== "request_save"))
    assert.doesNotMatch(
      name,
      /save|publish|approve|discard_draft|setting|create_record|update_record/u,
    );
  const agentListed = await tool("list_sessions", {});
  assert.ok(JSON.stringify(agentListed).includes(sessionId), JSON.stringify(agentListed));

  // The agent works in a fresh session the author created.
  as(author);
  const { sessionId: work } = await ok<{ sessionId: string }>(
    host.mutations.createSession({
      title: `Agent ${mode}`,
      models: ["item"],
      session_id: randomUUID(),
      request_id: randomUUID(),
      as_of: yesterday,
    }),
  );
  const described = await tool("describe_workspace", { session_id: work });
  let revision = (described.session as { revision: number }).revision;
  const found = await tool("find_records", { session_id: work, model: "Item", columns: ["Score"] });
  const [agentFirst, agentSecond] = (found.records as { record_id: string }[]).map(
    (r) => r.record_id,
  );
  assert.ok(agentFirst && agentSecond, JSON.stringify(found));
  const agentStaged = await tool("stage_changes", {
    session_id: work,
    changes: [{ model: "Item", record_id: agentFirst, column: "Score", value: "17" }],
  });
  revision = agentStaged.revision as number;
  const agentAgain = await tool("stage_changes", {
    session_id: work,
    changes: [{ model: "Item", record_id: agentSecond, column: "Score", value: "27" }],
  });
  revision = agentAgain.revision as number;
  // One turn per tool call: the two stagings carry different turns.
  const entries = await tool("read_entries", { session_id: work });
  const turns = new Set((entries.entries as { turn_id: string }[]).map((e) => e.turn_id));
  assert.equal(turns.size, 2, JSON.stringify(entries));
  revision = (
    await tool("unstage", {
      session_id: work,
      model: "Item",
      record_id: agentSecond,
      column: "Score",
    })
  ).revision as number;
  const opened = await tool("open_thread", {
    session_id: work,
    expected_revision: revision,
    anchor: { model: "Item", record_id: agentFirst },
  });
  revision = opened.revision as number;
  revision = (
    await tool("reply", {
      session_id: work,
      expected_revision: revision,
      thread_id: opened.thread_id,
      message: "Raising the lower score",
    })
  ).revision as number;
  revision = (
    await tool("propose_changes", {
      session_id: work,
      expected_revision: revision,
      thread_id: opened.thread_id,
      changes: [{ model: "Item", record_id: agentSecond, column: "Phase", value: "Done" }],
    })
  ).revision as number;
  revision = (
    await tool("create_rule", {
      session_id: work,
      expected_revision: revision,
      model: "Item",
      column: "Score",
      value: {
        type: "multiply",
        left: { type: "field", field: "Score" },
        right: { type: "parameter", parameter: "factor" },
      },
      parameters: { factor: { type: "number", value: "2" } },
    })
  ).revision as number;
  const added = await tool("add_unit", {
    session_id: work,
    kind: "chart",
    model: "Item",
    group_by: "Phase",
  });
  assert.ok(typeof added.unit_id === "string", JSON.stringify(added));
  if (mode === "protected") {
    // An agent principal reaches no human route: the read route, the events
    // route and a Server Action all refuse it.
    const agentRead = JSON.stringify({
      read: "session",
      input: { operation: "get", session_id: work, overlay: false },
    });
    const agentReadHeaders = actionHeaders(agentAuthor, readPath, agentRead);
    agentReadHeaders.set("content-type", "application/json");
    state.who = agentAuthor;
    state.headers = agentReadHeaders;
    const readAnswer = (await (
      await host.routes.read(
        new Request(`https://zone.test${readPath}`, {
          method: "POST",
          headers: agentReadHeaders,
          body: agentRead,
        }),
      )
    ).json()) as CanvasActionResult<unknown>;
    assert.equal(readAnswer.ok, false, JSON.stringify(readAnswer));
    if (!readAnswer.ok) assert.equal(readAnswer.error.code, "auth_required");
    const agentEventsPath = `/${app.app}/api/events/${work}`;
    state.headers = pageHeaders(agentAuthor, agentEventsPath);
    const agentEvents = await host.routes.events(
      new Request(`https://zone.test${agentEventsPath}`, { headers: state.headers }),
      work,
    );
    assert.ok(agentEvents.status >= 400, String(agentEvents.status));
    await agentEvents.body?.cancel();
    as(agentAuthor);
    const agentAction = await host.mutations.createSession({
      title: "Agent as human",
      models: ["item"],
      session_id: randomUUID(),
      request_id: randomUUID(),
      as_of: yesterday,
    });
    assert.equal(agentAction.ok, false, JSON.stringify(agentAction));
    if (!agentAction.ok) assert.equal(agentAction.error.code, "auth_required");
  }

  // The author sees the agent's staged work; the agent cannot Save it.
  as(author);
  const agentHeader = await ok<{ revision: number }>(
    reads.session({ operation: "get", session_id: work, overlay: false }),
  );
  assert.ok(agentHeader.revision > revision - 1, JSON.stringify(agentHeader));

  // An approver's Save and approve: the canvas Saves the approver's session
  // (a draft, like every Save), then approves that draft through the
  // ordinary approval, which a member is refused.
  const bossCreation = {
    title: "Boss plan",
    models: ["item"],
    session_id: randomUUID(),
    request_id: randomUUID(),
    as_of: "2026-01-01",
  };
  as(boss);
  await ok(host.mutations.createSession(bossCreation));
  const bossRevision = async () => {
    as(boss);
    return (
      await ok<WorkSession>(
        reads.session({ operation: "get", session_id: bossCreation.session_id, overlay: false }),
      )
    ).revision;
  };
  const bossCall = async (request: Record<string, unknown>) => {
    const body = isEdit(request)
      ? { session_id: bossCreation.session_id, ...request }
      : {
          session_id: bossCreation.session_id,
          expected_revision: await bossRevision(),
          request_id: randomUUID(),
          ...request,
        };
    as(boss);
    return await ok<{ change_set: { id: number } | null }>(host.mutations.session(body));
  };
  await bossCall({
    operation: "stage",
    changes: [
      {
        model_id: "item",
        record_id: rows[1]!.id,
        field_id: "score",
        value: { type: "number", value: "25" },
      },
    ],
  });
  const bossSaved = await bossCall({ operation: "save" });
  const bossDraft = Number(bossSaved.change_set!.id);
  as(colleague);
  await refused(
    host.mutations.drafts("/api/draft/approve", { change_set_id: bossDraft }),
    "authorization_denied",
  );
  as(boss);
  await ok(host.mutations.drafts("/api/draft/approve", { change_set_id: bossDraft }));
  as(colleague);
  const approved = await ok<{ id: string; score: string }[]>(
    reads.list("item", { asOf: "2026-01-01", select: ["id", "score"] }),
  );
  assert.equal(approved.find((row) => row.id === rows[1]!.id)?.score, "25");

  if (mode === "legacy") {
    // The legacy agent context refuses Save and canonical writes before any
    // kernel call, whatever the tool surface.
    const session = createLegacyAgentSession({
      pool: app.runtime,
      appId: app.app,
      definition: app.definition,
      grant: { grantId: "grant-legacy", actorId: "person", organizationId: "tenant" },
      recheck: async () => {},
      verifyRelease: () => {},
    });
    const context = session.contextForTurn(randomUUID());
    for (const capability of [
      "work_session.save",
      "item.create",
      "item.update",
      "drafts.kernel_approve_draft_change_set",
    ])
      await assert.rejects(context.authorize(capability), /authorization_denied/u, capability);
    // Removing the assignment cuts the agent off on its next call.
    delete assignments["tenant:person"];
    const removed = await rpcStatus(rpcId++, "tools/call", {
      name: "list_sessions",
      arguments: {},
    });
    assert.equal(removed.status, 403);
    assignments["tenant:person"] = ["editor"];
    return;
  }

  // A revoked fence: the app database closes the author's binding, and the
  // signed grant the Gateway still carries is refused for reads and writes.
  await app.owner.query(
    "update kernel_actor_membership set active = false, fence_generation = 2 where actor_id = 'person' and role = 'editor'",
  );
  as(author);
  await refused(
    reads.session({ operation: "get", session_id: sessionId, overlay: false }),
    "authorization_denied",
  );
  as(author);
  await refused(
    host.mutations.createSession({
      title: "After revoke",
      models: ["item"],
      session_id: randomUUID(),
      request_id: randomUUID(),
      as_of: yesterday,
    }),
    "authorization_denied",
  );
  // The agent route too: the fence closed the author's binding, so the
  // signed grant no longer reaches the tools.
  const revokedCall = await rpcStatus(3, "tools/call", { name: "list_sessions", arguments: {} });
  // The tool answers the kernel's own coded refusal: the closed binding no
  // longer reaches the tenant.
  assert.equal(revokedCall.status, 200, JSON.stringify(revokedCall));
  assert.equal(revokedCall.body?.result?.isError, true, JSON.stringify(revokedCall));
  const revoked = JSON.parse(revokedCall.body!.result!.content[0]!.text) as {
    code: string;
    details?: { code: string }[];
  };
  assert.equal(revoked.code, "authorization_denied");
  assert.deepEqual(
    revoked.details?.map((detail) => detail.code),
    ["tenant_scope_not_bound"],
  );
  assert.ok(!JSON.stringify(revokedCall.body ?? {}).includes(sessionId));
}

/** Legacy mode's issued canvas tokens: the person each acts as (the real verifier is Auth's). */
const canvasTokens: Record<string, { actorId: string; customerId: string }> = {
  "canvas-person": { actorId: "person", customerId: "tenant" },
  "canvas-boss": { actorId: "boss", customerId: "tenant" },
  "canvas-colleague": { actorId: "colleague", customerId: "tenant" },
};

/**
 * The canvas API in legacy mode (the canvas in a chat): the person comes
 * from the canvas bearer only, through `createLegacyCanvasPerson`, and every
 * operation goes through the web canvas's own calls and checks.
 */
async function canvasApi(app: InstalledApp) {
  const state: RequestState = { headers: new Headers(), who: null, ended: 0 };
  const foundation = legacyData(app, state);
  const host = createCanvasHost({
    appId: app.app,
    definition: app.definition,
    roles: { member: "editor", approver: "approver" },
    data: {
      ...foundation,
      person: async (request) => {
        const token = /^Bearer (.+)$/u.exec(request.headers.get("authorization") ?? "")?.[1];
        const grant = token === undefined ? undefined : canvasTokens[token];
        if (grant === undefined)
          return Response.json(
            { ok: false, error: { code: "auth_required", message: "Sign in." } },
            { status: 401 },
          );
        const roles = () => assignments[`${grant.customerId}:${grant.actorId}`] ?? [];
        return createLegacyCanvasPerson({
          pool: app.runtime,
          appId: app.app,
          grant: { actorId: grant.actorId, organizationId: grant.customerId },
          recheck: async () => roles(),
          verifyRelease: () => {},
        });
      },
    },
  });
  const seed = createDataClient(app.definition, human(app)) as unknown as Record<
    string,
    { create(values: unknown, options: unknown): Promise<unknown> }
  >;
  await seed.item!.create(
    { owner: "person", score: "10", phase: "draft" },
    { effectiveStart: "2026-01-01", idempotencyKey: "chat-seed" },
  );
  for (const [actor, role] of [
    ["colleague", "editor"],
    ["boss", "approver"],
  ])
    await bind(
      app,
      { customer_id: "tenant", actor_id: actor, role, actor_kind: "human", fence_generation: 1 },
      "kernel_bind_actor_membership",
    );
  const call = async (token: string | null, body: unknown, cookieUser: Who | null = null) => {
    // A signed-in browser session alongside never stands in for the bearer.
    state.who = cookieUser;
    const headers = new Headers({ "content-type": "application/json" });
    if (token !== null) headers.set("authorization", `Bearer ${token}`);
    const response = await host.routes.canvas(
      new Request(`https://zone.test/${app.app}/api/canvas`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
    );
    return {
      status: response.status,
      result: (await response.json()) as CanvasActionResult<unknown>,
    };
  };
  const value = async <T>(token: string, body: unknown): Promise<T> => {
    const { result } = await call(token, body);
    assert.ok(result.ok, JSON.stringify(result));
    return result.value as T;
  };

  // No bearer, an unknown one, or only a browser session: nothing.
  assert.equal((await call(null, { call: "viewer" }, author)).status, 401);
  assert.equal((await call("agent-token", { call: "viewer" })).status, 401);
  assert.deepEqual(await value("canvas-person", { call: "viewer" }), {
    canApprove: false,
    authors: true,
  });
  assert.equal(
    (await value<{ canApprove: boolean }>("canvas-boss", { call: "viewer" })).canApprove,
    true,
  );

  // The person creates a session, stages a value and Saves it, as themselves.
  const sessionId = randomUUID();
  await value("canvas-person", {
    call: "create_session",
    input: {
      title: "Chat plan",
      models: ["item"],
      session_id: sessionId,
      request_id: randomUUID(),
      as_of: "2026-06-01",
    },
  });
  const rows = await value<{ id: string }[]>("canvas-person", {
    call: "read",
    request: { read: "list", model: "item", query: { asOf: "2026-06-01", select: ["id"] } },
  });
  const header = () =>
    value<WorkSession>("canvas-person", {
      call: "read",
      request: {
        read: "session",
        input: { operation: "get", session_id: sessionId, overlay: false },
      },
    });
  const guard = async () => ({
    session_id: sessionId,
    expected_revision: (await header()).revision,
    request_id: randomUUID(),
  });
  await value("canvas-person", {
    call: "session",
    input: {
      operation: "stage",
      session_id: sessionId,
      changes: [
        {
          model_id: "item",
          record_id: rows[0]!.id,
          field_id: "score",
          value: { type: "number", value: "42" },
        },
      ],
    },
  });
  const entries = await value<WorkSession>("canvas-person", {
    call: "read",
    request: { read: "session", input: { operation: "get", session_id: sessionId } },
  });
  assert.deepEqual(
    entries.overlay.map((entry) => [entry.field_id, entry.author_kind]),
    [["score", "human"]],
  );
  // The person's selection, as presence: no revision, and the agent reads it.
  const unchanged = (await header()).revision;
  await value("canvas-person", {
    call: "session",
    input: {
      operation: "presence",
      session_id: sessionId,
      selection: [{ model_id: "item", record_id: rows[0]!.id, field_id: "score" }],
    },
  });
  assert.equal((await header()).revision, unchanged);
  assert.deepEqual((await header()).presence?.selection, [
    { model_id: "item", record_id: rows[0]!.id, field_id: "score" },
  ]);
  // A colleague's canvas never reads the person's session.
  const peek = await call("canvas-colleague", {
    call: "read",
    request: { read: "session", input: { operation: "get", session_id: sessionId } },
  });
  assert.equal(peek.result.ok, false);
  // Save always writes a draft.
  const saved = await value<{ change_set: { id: number } }>("canvas-person", {
    call: "session",
    input: { operation: "save", ...(await guard()) },
  });
  const draftId = Number(saved.change_set.id);

  // Review: every member reads the drafts; only an approver approves.
  const drafts = await value<{ id: number }[]>("canvas-colleague", {
    call: "read",
    request: { read: "drafts", path: "/api/drafts", body: null },
  });
  assert.deepEqual(
    drafts.map((draft) => Number(draft.id)),
    [draftId],
  );
  const notApprover = await call("canvas-person", {
    call: "drafts",
    path: "/api/draft/approve",
    body: { change_set_id: draftId },
  });
  assert.equal(notApprover.status, 403);
  // A read sent as a write, or a write as a read, is refused.
  assert.equal(
    (
      await call("canvas-boss", {
        call: "read",
        request: { read: "drafts", path: "/api/draft/approve", body: { change_set_id: draftId } },
      })
    ).result.ok,
    false,
  );
  await value("canvas-boss", {
    call: "drafts",
    path: "/api/draft/approve",
    body: { change_set_id: draftId },
  });

  // The stream accepts the bearer, and only the bearer.
  const eventsUrl = `https://zone.test/${app.app}/api/canvas/events?session_id=${sessionId}`;
  const refusedStream = await host.routes.canvasEvents(new Request(eventsUrl));
  assert.equal(refusedStream.status, 401);
  const abort = new AbortController();
  const stream = await host.routes.canvasEvents(
    new Request(eventsUrl, {
      headers: { authorization: "Bearer canvas-person" },
      signal: abort.signal,
    }),
  );
  assert.equal(stream.status, 200);
  const reader = stream.body!.getReader();
  const opening = new TextDecoder().decode((await reader.read()).value);
  assert.equal(opening, `event: revision\ndata: ${(await header()).revision}\n\n`);
  abort.abort();
  await reader.closed.catch(() => {});

  // A removed assignment stops the canvas on its next call.
  const held = assignments["tenant:person"];
  assignments["tenant:person"] = [];
  try {
    assert.equal((await call("canvas-person", { call: "viewer" })).status, 403);
  } finally {
    assignments["tenant:person"] = held!;
  }
}

/**
 * Protected mode's canvas API person for one request, using the signed canvas principal on
 * the headers the mandatory proxy forwarded, and verified contexts that
 * consume only a canvas principal.
 */
function protectedPerson(app: InstalledApp, request: Request): CanvasPersonData {
  const headers = new Headers(request.headers);
  const method = headers.get(VERIFIED_METHOD_HEADER) ?? "";
  const target = headers.get(VERIFIED_TARGET_HEADER) ?? "";
  const session = async (options: CanvasDataOptions = {}): Promise<CanvasViewer> => {
    let principal: ReturnType<typeof verifier.verify>;
    try {
      principal = verifier.verify(headers.get(PRINCIPAL_HEADER) ?? "", {
        audience: app.app,
        method,
        path: target,
        canvas: true,
      });
    } catch {
      throw denied("auth_required", 401);
    }
    const roles = (principal.appActorGrants ?? [])
      .filter((grant) => grant.fenceGeneration > 0)
      .map((grant) => grant.role);
    if (roles.length === 0 || (options.requiredRole && !roles.includes(options.requiredRole)))
      throw denied("app_access_required", 403);
    return { scope: { actorId: principal.sub, customerId: principal.organizationId }, roles };
  };
  const open = async (
    options: CanvasDataOptions,
    payload?: Parameters<CanvasHostData["action"]>[0],
  ) => {
    const viewer = await session(options);
    const role = options.requiredRole ?? viewer.roles[0]!;
    return await createVerifiedGatewayDataContext({
      request:
        payload === undefined
          ? { kind: "next-read", headers, method, target }
          : { kind: "next-action", ...protectedNextActionRequest(headers) },
      verification: { kind: "public-key", verifier },
      scope: {
        appId: app.app,
        actorId: viewer.scope.actorId,
        organizationId: viewer.scope.customerId,
      },
      role,
      runtime: runtimeOf(app),
      sourceKind: "human",
      canvas: true,
      authorize: async () => {},
      verifyRelease: () => {},
      ...(payload === undefined ? {} : { normalizedPayload: payload }),
    });
  };
  return {
    session,
    read: async (options, run) => {
      const handle = await open(options);
      try {
        return await run(handle);
      } finally {
        await handle.close();
      }
    },
    action: async (payload, options, run) => {
      const handle = await open(options, payload);
      try {
        return await handle.context.requestTransaction(() => run(handle));
      } finally {
        await handle.close();
      }
    },
  };
}

/** Signed Canvas ingress against an actor_binding_required installation. */
async function protectedCanvasApi(app: InstalledApp) {
  const host = createCanvasHost({
    appId: app.app,
    definition: app.definition,
    roles: { member: "editor", approver: "approver" },
    data: {
      ...protectedData(app, { headers: new Headers(), who: null, ended: 0 }),
      person: async (request) => protectedPerson(app, request),
    },
  });
  const seed = createDataClient(app.definition, human(app)) as unknown as Record<
    string,
    { create(values: unknown, options: unknown): Promise<unknown> }
  >;
  await seed.item!.create(
    { owner: "person", score: "10", phase: "draft" },
    { effectiveStart: "2026-01-01", idempotencyKey: "protected-chat-seed" },
  );
  await bind(
    app,
    {
      customer_id: "tenant",
      actor_id: "boss",
      role: "approver",
      actor_kind: "human",
      fence_generation: 1,
    },
    "kernel_bind_actor_membership",
  );
  await bind(
    app,
    { capability: "runtime", customer_id: "tenant", actor_binding_required: true },
    "kernel_bind_principal_scope",
  );
  const people: Record<string, Who> = {
    "canvas.person.token": { ...author, audience: app.app, canvasGrant: { id: "canvas-person" } },
    "canvas.boss.token": { ...boss, audience: app.app, canvasGrant: { id: "canvas-boss" } },
    "agent.mcp.token": {
      ...author,
      audience: app.app,
      agentGrant: { id: "agent", clientId: "client" },
    },
  };
  const canvasPath = `/${app.app}/api/canvas`;
  const call = async (token: string | null, body: unknown, extra: Record<string, string> = {}) => {
    const bytes = JSON.stringify(body);
    const who = token === null ? undefined : people[token];
    const headers = who ? actionHeaders(who, canvasPath, bytes) : new Headers();
    headers.set("content-type", "application/json");
    for (const [key, value] of Object.entries(extra)) headers.set(key, value);
    const response = await host.routes.canvas(
      new Request(`https://zone.test${canvasPath}`, {
        method: "POST",
        headers,
        body: bytes,
      }),
    );
    return {
      status: response.status,
      result: (await response.json().catch(() => null)) as CanvasActionResult<unknown> | null,
    };
  };
  const value = async <T>(token: string, body: unknown): Promise<T> => {
    const answer = await call(token, body);
    assert.ok(answer.result?.ok, JSON.stringify(answer));
    return (answer.result as { value: T }).value;
  };

  // A cookie, an MCP agent principal, and forged signatures cannot become a Canvas person.
  const none = await call(null, { call: "viewer" }, { cookie: "better-auth.session_token=x" });
  assert.equal(none.status, 401);
  assert.equal((await call("agent.mcp.token", { call: "viewer" })).status, 401);
  assert.equal(
    (await call(null, { call: "viewer" }, { [PRINCIPAL_HEADER]: "forged" })).status,
    401,
  );
  // The person works through signed ingress: create, stage, Save.
  assert.deepEqual(await value("canvas.person.token", { call: "viewer" }), {
    canApprove: false,
    authors: false,
  });
  const sessionId = randomUUID();
  await value("canvas.person.token", {
    call: "create_session",
    input: {
      title: "Protected chat",
      models: ["item"],
      session_id: sessionId,
      request_id: randomUUID(),
      as_of: "2026-06-01",
    },
  });
  const rows = await value<{ id: string }[]>("canvas.person.token", {
    call: "read",
    request: { read: "list", model: "item", query: { asOf: "2026-06-01", select: ["id"] } },
  });
  const revision = async () =>
    (
      await value<WorkSession>("canvas.person.token", {
        call: "read",
        request: {
          read: "session",
          input: { operation: "get", session_id: sessionId, overlay: false },
        },
      })
    ).revision;
  await value("canvas.person.token", {
    call: "session",
    input: {
      operation: "stage",
      session_id: sessionId,
      changes: [
        {
          model_id: "item",
          record_id: rows[0]!.id,
          field_id: "score",
          value: { type: "number", value: "42" },
        },
      ],
    },
  });
  const session = async () =>
    await value<WorkSession & { presence?: { selection: unknown[] } | null }>(
      "canvas.person.token",
      {
        call: "read",
        request: {
          read: "session",
          input: { operation: "get", session_id: sessionId, overlay: false },
        },
      },
    );
  // The person's selection, as presence through signed ingress: no revision.
  const beforePresence = await revision();
  await value("canvas.person.token", {
    call: "session",
    input: {
      operation: "presence",
      session_id: sessionId,
      selection: [{ model_id: "item", record_id: rows[0]!.id, field_id: "score" }],
    },
  });
  assert.deepEqual((await session()).presence?.selection, [
    { model_id: "item", record_id: rows[0]!.id, field_id: "score" },
  ]);
  assert.equal(await revision(), beforePresence);

  // The agent asks to Save over MCP; the person's Save through the canvas resolves it.
  let mcpSession: string | null = null;
  const rpc = async (id: number | null, method: string, params: unknown) => {
    const body = JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params });
    const mcpPath = `/${app.app}/api/mcp`;
    const headers = actionHeaders(
      { ...author, audience: app.app, agentGrant: { id: "grant-chat-agent", clientId: "client" } },
      mcpPath,
      body,
    );
    headers.set("content-type", "application/json");
    headers.set("accept", "application/json, text/event-stream");
    headers.set("mcp-protocol-version", "2025-06-18");
    if (mcpSession !== null) headers.set("mcp-session-id", mcpSession);
    const response = await host.routes.mcp(
      new Request(`https://zone.test${mcpPath}`, {
        method: "POST",
        headers,
        body,
      }),
    );
    mcpSession = response.headers.get("mcp-session-id") ?? mcpSession;
    const text = await response.text();
    assert.ok(response.status < 300, `${method}: ${response.status} ${text}`);
    if (id === null || text === "") return null;
    const json = text.trimStart().startsWith("{")
      ? text
      : text
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5))
          .join("");
    return JSON.parse(json) as { result?: { isError?: boolean; content: { text: string }[] } };
  };
  await rpc(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "canvas-host-test", version: "1.0.0" },
  });
  await rpc(null, "notifications/initialized", {});
  const asked = await rpc(2, "tools/call", {
    name: "request_save",
    arguments: {
      session_id: sessionId,
      expected_revision: await revision(),
      reason: "The score is staged and ready",
    },
  });
  assert.ok(asked?.result && !asked.result.isError, JSON.stringify(asked));
  /** The open request to Save, from the session's threads. */
  const openRequest = async () =>
    Object.values((await session()).threads as Record<string, Record<string, unknown>>).find(
      (thread) => thread.kind === "save_request" && thread.resolved !== true,
    ) ?? null;
  assert.equal((await openRequest())?.reason, "The score is staged and ready");
  const saved = await value<{ change_set: { id: number } | null }>("canvas.person.token", {
    call: "session",
    input: {
      operation: "save",
      session_id: sessionId,
      expected_revision: await revision(),
      request_id: randomUUID(),
    },
  });
  assert.ok(saved.change_set);
  assert.equal(await openRequest(), null);
  // The approver's canvas approves through the same lane.
  const [draft] = await value<{ id: number }[]>("canvas.boss.token", {
    call: "read",
    request: { read: "drafts", path: "/api/drafts", body: null },
  });
  assert.ok(draft);
  const notApprover = await call("canvas.person.token", {
    call: "drafts",
    path: "/api/draft/approve",
    body: { change_set_id: Number(draft!.id) },
  });
  assert.equal(notApprover.status, 403);
  await value("canvas.boss.token", {
    call: "drafts",
    path: "/api/draft/approve",
    body: { change_set_id: Number(draft!.id) },
  });

  // The signed Canvas person can stream session revisions.
  const abort = new AbortController();
  const eventsPath = `${canvasPath}/events?session_id=${sessionId}`;
  const stream = await host.routes.canvasEvents(
    new Request(`https://zone.test${eventsPath}`, {
      headers: pageHeaders(people["canvas.person.token"]!, eventsPath),
      signal: abort.signal,
    }),
  );
  assert.equal(stream.status, 200);
  const reader = stream.body!.getReader();
  const opening = new TextDecoder().decode((await reader.read()).value);
  assert.match(opening, /^event: revision\ndata: \d+\n\n$/u);
  abort.abort();
  await reader.cancel().catch(() => {});
}

// Needs PostgreSQL binaries and the schema compiler; the package test script sets the flag.
describe.skipIf(process.env.CANVAS_HOST_POSTGRES !== "1")("canvas host over PostgreSQL", () => {
  beforeAll(startPostgres, 120_000);
  afterAll(async () => {
    await stopPostgres();
  }, 120_000);
  test("legacy Auth mode: session, draft Save, threads, review, approve, reject, replay, revoke, events; no MCP", async () => {
    await roundTrip(await install("canvas-host-legacy", false), "legacy");
  }, 600_000);
  test("protected Gateway mode: the same, with signed replay, payload mismatch, revoked fence and MCP", async () => {
    await roundTrip(await install("canvas-host", false), "protected");
  }, 600_000);
  test("protected canvas API with signed Canvas principals and actor bindings", async () => {
    await protectedCanvasApi(await install("canvas-host-chat-protected", false));
  }, 600_000);
  test("legacy canvas API: the bearer's person, the web canvas's checks, Save names its mode, the stream", async () => {
    await canvasApi(await install("canvas-host-chat", false));
  }, 600_000);
});
