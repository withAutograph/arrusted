// The canvas host over fake data adapters: refusals before any data call
// (no session, no app role, a member's draft actions, browser-supplied scope),
// re-authorization before each transaction, the draft
// review access matrix (every member reads and replies; the author or an
// approver resolves; an approver acts), request ids passed through in the
// action payload, and the events and MCP routes in each mode.
import { describe, expect, test, vi } from "vitest";
import type { DataDefinition } from "@autograph/generated-app-runtime/data";
import type { PostgresDataContext } from "@autograph/generated-app-runtime/postgres";
import type { WorkSessionListener } from "@autograph/platform-microfrontends/verified-data-context";
import {
  createCanvasHost,
  runtimeFromDatabaseUrl,
  type CanvasAgentBinding,
  type CanvasDataOptions,
  type CanvasViewer,
} from "../server";
import {
  VERIFIED_METHOD_HEADER,
  VERIFIED_TARGET_HEADER,
} from "@autograph/platform-microfrontends/next-request-ingress";
import type { CanvasChat } from "../mcp-app/resource";
import { gatewayHeaders, verifier } from "./principal";

const definition = {
  formatVersion: 1,
  schemaVersion: "canvas-host-v1",
  models: [{ id: "item", name: "item", fields: [], relations: [] }],
} as unknown as DataDefinition;

const sessionId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const runtime = runtimeFromDatabaseUrl(
  "postgresql://runtime:secret@127.0.0.1:1/canvas_host?sslmode=disable",
);

/** An Auth boundary refusal, as the foundation's legacy session throws it. */
const boundary = (code: string, status: number) => Object.assign(new Error(code), { code, status });

/** A work session header as the kernel answers `get` without the overlay. */
const header = (owner: string) => ({
  id: sessionId,
  owner_id: owner,
  title: "Plan",
  as_of: "2026-10-01",
  scope: { models: ["item"] },
  layout: { units: [] },
  pinned: false,
  status: "active",
  revision: 3,
  rules: {},
  threads: {},
});

type Call = { kind: "read" | "action"; options: CanvasDataOptions; payload?: unknown };

/** A host over fake adapters whose viewer, roles and kernel answers the test sets. */
function harness(options: { agent?: CanvasAgentBinding; chat?: CanvasChat } = {}) {
  const state = {
    actorId: "person" as string | null,
    roles: new Map<string, string[]>([
      ["person", ["member"]],
      ["colleague", ["member"]],
      ["boss", ["approver"]],
    ]),
    /** Session reads that answer before the approver role is revoked. */
    revokeApproverAfter: Number.POSITIVE_INFINITY,
    sessionReads: 0,
    calls: [] as Call[],
    kernel: [] as { operation: string; input: Record<string, unknown> }[],
    /** The draft the kernel returns for `kernel_draft_threads get`; null when there is none. */
    draft: { source_kind: "work_session", source_ref: sessionId, threads: {} } as Record<
      string,
      unknown
    > | null,
    sessionOwner: "person",
    listenersEnded: 0,
  };
  const session = async (options: CanvasDataOptions = {}): Promise<CanvasViewer> => {
    state.sessionReads += 1;
    if (state.actorId === null) throw boundary("auth_required", 401);
    let roles = state.roles.get(state.actorId) ?? [];
    if (state.sessionReads > state.revokeApproverAfter)
      roles = roles.filter((role) => role !== "approver");
    if (roles.length === 0) throw boundary("app_access_required", 403);
    if (options.requiredRole !== undefined && !roles.includes(options.requiredRole))
      throw boundary("app_access_required", 403);
    return { scope: { actorId: state.actorId, customerId: "tenant" }, roles };
  };
  const context = (options: CanvasDataOptions): PostgresDataContext => {
    const actorId = state.actorId ?? "nobody";
    return {
      scope: { appId: "canvas-host", customerId: "tenant" },
      // As the foundation does: the bound role is re-checked before each data call.
      authorize: async () => {
        await session(options);
      },
      transaction: async (run) =>
        await run({
          actorId,
          sourceKind: "human",
          call: async (operation, input) => {
            state.kernel.push({ operation, input });
            if (operation === "kernel_draft_threads" && input.operation !== "by_session") {
              if (state.draft === null)
                throw Object.assign(new Error("change_set `5` did not resolve"), {
                  envelope: { code: "record_target_missing", message: "did not resolve" },
                });
              if (input.operation === "get") return state.draft;
            }
            // As the kernel: a session's drafts list for its owner only.
            if (operation === "kernel_draft_threads" && input.operation === "by_session") {
              if (actorId !== state.sessionOwner)
                throw new Error("authorization_denied: session is unavailable");
              return [];
            }
            if (operation === "kernel_work_session" && input.operation === "get") {
              if (actorId !== state.sessionOwner)
                throw new Error("authorization_denied: the session is its owner's");
              return header(actorId);
            }
            if (operation === "kernel_work_session" && input.operation === "list") return [];
            if (operation === "kernel_work_session" && input.operation === "create")
              return { revision: 1, session_id: input.session_id };
            if (operation === "kernel_work_session" && input.operation === "save")
              return { revision: 2, change_set: null, cleared: true };
            if (operation === "kernel_work_session" && input.operation === "update")
              return { revision: 3 };
            return { ok: true };
          },
        }),
      requestTransaction: async (run) => await run(),
    };
  };
  const host = createCanvasHost({
    appId: "canvas-host",
    definition,
    roles: { member: "member", approver: "approver" },
    data: {
      session,
      read: async (options, run) => {
        state.calls.push({ kind: "read", options });
        return await run({ context: context(options) });
      },
      action: async (payload, options, run) => {
        state.calls.push({ kind: "action", options, payload });
        return await run({ context: context(options) });
      },
      events: () => ({
        runtime,
        connect: async () =>
          ({
            query: async () => undefined,
            on: () => undefined,
            end: async () => {
              state.listenersEnded += 1;
            },
          }) as WorkSessionListener,
      }),
      agent: () => options.agent,
      ...(options.chat === undefined ? {} : { chat: async () => options.chat }),
      actorNames:
        () =>
        async ({ actorIds }) =>
          Object.fromEntries(actorIds.filter((id) => id === "person").map((id) => [id, "Pat"])),
    },
  });
  return { host, state };
}

const refusal = (code: string) => ({ ok: false, error: expect.objectContaining({ code }) });

type Host = ReturnType<typeof harness>["host"];
/** One read through the read route, as the browser client sends it. */
const readRoute = async (host: Host, body: unknown): Promise<Response> =>
  await host.routes.read(
    new Request("https://zone.test/canvas-host/api/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
/** The read route's answer, as the client reads it. */
const readOf = async (host: Host, body: unknown): Promise<unknown> =>
  await (await readRoute(host, body)).json();
/** The canvas's reads, each through the read route. */
const reads = (host: Host) => ({
  session: (input: unknown) => readOf(host, { read: "session", input }),
  list: (model: unknown, query: unknown) => readOf(host, { read: "list", model, query }),
  drafts: (path: string, body: unknown = null) => readOf(host, { read: "drafts", path, body }),
  threads: (operation: string, input: unknown) =>
    readOf(host, { read: "threads", operation, input }),
  authors: (actorIds: unknown) => readOf(host, { read: "authors", actor_ids: actorIds }),
});
/** A thread operation on its surface: `get` reads, `reply` and `resolve` are actions. */
const threadCall = (host: Host, operation: string, input: unknown) =>
  operation === "get" || operation === "by_session"
    ? reads(host).threads(operation, input)
    : host.mutations.threads(operation, input);
/** A New session submit: the browser names the session and the gesture. */
const newSession = () => ({
  title: "Plan",
  models: ["item"],
  session_id: sessionId,
  request_id: requestId,
  as_of: "2026-10-30",
});

describe("refusals", () => {
  test("refuse a request without a session, before any data call", async () => {
    const { host, state } = harness();
    state.actorId = null;
    await expect(reads(host).session({ operation: "list" })).resolves.toEqual(
      refusal("auth_required"),
    );
    await expect(host.viewer()).rejects.toMatchObject({ code: "auth_required" });
    expect(state.calls).toEqual([]);
  });

  test("coded session failures: 401 needs sign-in, 403 is access, 503 is unavailable; uncoded stays thrown", async () => {
    const failing = (failure: unknown) =>
      createCanvasHost({
        appId: "canvas-host",
        definition,
        roles: { member: "member", approver: "approver" },
        data: {
          session: async () => {
            throw failure;
          },
          read: async () => {
            throw new Error("unreachable");
          },
          action: async () => {
            throw new Error("unreachable");
          },
          events: () => ({ runtime }),
          agent: () => undefined,
        },
      });
    const cases: [failure: unknown, code: string, status: number][] = [
      // No verified request or principal.
      [boundary("auth_required", 401), "auth_required", 401],
      // Signed in, but without the member or approver grant.
      [boundary("app_access_required", 403), "app_access_required", 403],
      // The verifier, its JWKS or its configuration failed.
      [boundary("auth_unavailable", 503), "unavailable", 503],
      [boundary("auth_not_configured", 500), "unavailable", 503],
    ];
    for (const [failure, code, status] of cases) {
      const host = failing(failure);
      await expect(reads(host).session({ operation: "list" })).resolves.toEqual(refusal(code));
      const response = await host.routes.events(
        new Request(`https://zone.test/canvas-host/api/events/${sessionId}`),
        sessionId,
      );
      expect(response.status, code).toBe(status);
      expect(await response.json()).toMatchObject({ error: { code } });
    }
    // An uncoded failure is unexpected: never a sign-in prompt. An action
    // throws it (its outcome is unknown); the read route answers 500.
    const uncoded = failing(new Error("Protected app session is unavailable"));
    await expect(
      uncoded.mutations.session({ operation: "archive", session_id: sessionId }),
    ).rejects.toThrow("Protected app session is unavailable");
    const response = await readRoute(uncoded, { read: "session", input: { operation: "list" } });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual(refusal("unavailable"));
  });

  test("refuse a user with neither the member nor the approver role", async () => {
    const { host, state } = harness();
    state.roles.set("viewer", ["viewer"]);
    state.actorId = "viewer";
    for (const result of [
      reads(host).session({ operation: "list" }),
      reads(host).list("item", { asOf: "2026-01-01" }),
      host.mutations.createSession(newSession()),
      reads(host).threads("get", { change_set_id: 1 }),
    ])
      await expect(result).resolves.toEqual(refusal("app_access_required"));
    // An organization without the app at all.
    state.actorId = "stranger";
    await expect(reads(host).session({ operation: "list" })).resolves.toEqual(
      refusal("app_access_required"),
    );
    expect(state.calls).toEqual([]);
  });

  test("a member reads every draft, diff, activity and author, but may not act on drafts", async () => {
    const { host, state } = harness();
    for (const path of ["/api/drafts", "/api/drafts/rejected"])
      await expect(reads(host).drafts(path), path).resolves.toMatchObject({ ok: true });
    for (const [path, body] of [
      ["/api/diff", { change_set_id: 1 }],
      ["/api/activity", {}],
    ] as const)
      await expect(reads(host).drafts(path, body), path).resolves.toMatchObject({ ok: true });
    await expect(reads(host).authors(["person", "colleague"])).resolves.toEqual({
      ok: true,
      value: { person: "Pat" },
    });
    // Each read binds the member role; none opens an action.
    expect(state.calls.every((call) => call.kind === "read")).toBe(true);
    expect(new Set(state.calls.map((call) => call.options.requiredRole))).toEqual(
      new Set(["member"]),
    );
    await expect(host.viewer()).resolves.toEqual({ canApprove: false, authors: true });
    state.calls = [];
    for (const [path, body] of [
      ["/api/draft/approve", { change_set_id: 1 }],
      ["/api/draft/discard", { change_set_id: 1 }],
      ["/api/draft/notes", { change_set_id: 1, notes: "no" }],
      ["/api/revert", { change_set_id: 1 }],
    ] as const)
      await expect(host.mutations.drafts(path, body), path).resolves.toEqual(
        refusal("authorization_denied"),
      );
    expect(state.calls).toEqual([]);
  });

  test("browser input never carries scope; a Save's own mode is ignored", async () => {
    const { host, state } = harness();
    for (const input of [
      { operation: "list", app_id: "other" },
      { operation: "list", customer_id: "other" },
      { operation: "list", actor_id: "someone" },
      { operation: "list", schema_version: "other" },
      { operation: "get", session_id: "s", owner_id: "someone" },
      { operation: "create", session_id: "s", expected_revision: 0, request_id: "r" },
      {
        operation: "update",
        session_id: "s",
        patch: { scope: {} },
      },
      {
        operation: "update",
        session_id: "s",
        patch: { as_of: "2026-02-30" },
      },
      "list",
    ]) {
      await expect(reads(host).session(input)).resolves.toEqual(
        refusal("contract_validation_failed"),
      );
      await expect(host.mutations.session(input)).resolves.toEqual(
        refusal("contract_validation_failed"),
      );
    }
    await expect(reads(host).list("other_model", { asOf: "2026-01-01" })).resolves.toEqual(
      refusal("contract_validation_failed"),
    );
    await expect(
      host.mutations.createSession({ ...newSession(), owner_id: "someone" }),
    ).resolves.toEqual(refusal("contract_validation_failed"));
    await expect(
      reads(host).threads("get", { change_set_id: 1, customer_id: "other" }),
    ).resolves.toEqual(refusal("contract_validation_failed"));
    expect(state.calls).toEqual([]);
  });
});

describe("reads and mutations keep to their own surfaces", () => {
  const stage = {
    operation: "stage",
    session_id: sessionId,
    changes: [],
  };

  test("the read route refuses every mutation before any data call", async () => {
    const { host, state } = harness();
    state.actorId = "boss";
    for (const body of [
      { read: "session", input: stage },
      { read: "session", input: { operation: "save", session_id: sessionId } },
      { read: "drafts", path: "/api/draft/approve", body: { change_set_id: 1 } },
      { read: "drafts", path: "/api/draft/discard", body: { change_set_id: 1 } },
      { read: "drafts", path: "/api/draft/notes", body: { change_set_id: 1, notes: null } },
      { read: "drafts", path: "/api/revert", body: { change_set_id: 1 } },
      {
        read: "threads",
        operation: "reply",
        input: { change_set_id: 1, thread_id: "t", message: "Hi", request_id: requestId },
      },
      {
        read: "threads",
        operation: "resolve",
        input: { change_set_id: 1, thread_id: "t", request_id: requestId },
      },
      { read: "createSession", input: newSession() },
      { read: "list", model: "item", query: {}, app_id: "other" },
      "list",
    ]) {
      const response = await readRoute(host, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toEqual(refusal("contract_validation_failed"));
    }
    expect(state.calls).toEqual([]);
    expect(state.kernel).toEqual([]);
  });

  test("the read route takes JSON by POST and answers uncached", async () => {
    const { host, state } = harness();
    const get = await host.routes.read(new Request("https://zone.test/canvas-host/api/read"));
    expect(get.status).toBe(400);
    const form = await host.routes.read(
      new Request("https://zone.test/canvas-host/api/read", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "read=session",
      }),
    );
    expect(form.status).toBe(400);
    const broken = await host.routes.read(
      new Request("https://zone.test/canvas-host/api/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
    );
    expect(broken.status).toBe(400);
    expect(state.calls).toEqual([]);
    const answered = await readRoute(host, { read: "session", input: { operation: "list" } });
    expect(answered.status).toBe(200);
    expect(answered.headers.get("cache-control")).toBe("no-store");
    expect(await answered.json()).toEqual({ ok: true, value: [] });
    // Refusals carry their status: sign-in, access, a kernel code.
    state.actorId = null;
    expect((await readRoute(host, { read: "session", input: { operation: "list" } })).status).toBe(
      401,
    );
    state.actorId = "boss";
    state.draft = null;
    const missing = await readRoute(host, {
      read: "threads",
      operation: "get",
      input: { change_set_id: 5 },
    });
    expect(missing.status).toBe(422);
    expect(await missing.json()).toEqual(refusal("record_target_missing"));
  });

  test("every read the route serves opens the read context, never an action", async () => {
    const { host, state } = harness();
    state.actorId = "boss";
    state.sessionOwner = "boss";
    for (const body of [
      { read: "session", input: { operation: "list" } },
      { read: "session", input: { operation: "get", session_id: sessionId, overlay: false } },
      { read: "list", model: "item", query: { asOf: "2026-01-01" } },
      { read: "aggregate", model: "item", query: { asOf: "2026-01-01" } },
      { read: "drafts", path: "/api/drafts", body: null },
      { read: "drafts", path: "/api/drafts/rejected", body: null },
      { read: "drafts", path: "/api/diff", body: { change_set_id: 1 } },
      { read: "drafts", path: "/api/activity", body: { limit: 5 } },
      { read: "threads", operation: "get", input: { change_set_id: 5 } },
    ])
      // (The fake context cannot run a model query; the context it opened is what counts.)
      await readRoute(host, body);
    expect(state.calls.length).toBe(9);
    expect(state.calls.every((call) => call.kind === "read")).toBe(true);
    await expect(reads(host).authors(["person"])).resolves.toEqual({
      ok: true,
      value: { person: "Pat" },
    });
  });

  test("an action refuses every read before any data call", async () => {
    const { host, state } = harness();
    state.actorId = "boss";
    for (const operation of ["get", "list", "entries"])
      await expect(host.mutations.session({ operation, session_id: sessionId })).resolves.toEqual(
        refusal("contract_validation_failed"),
      );
    for (const [path, body] of [
      ["/api/drafts", null],
      ["/api/drafts/rejected", null],
      ["/api/diff", { change_set_id: 1 }],
      ["/api/activity", {}],
    ] as const)
      await expect(host.mutations.drafts(path, body)).resolves.toEqual(
        refusal("contract_validation_failed"),
      );
    for (const [operation, input] of [
      ["get", { change_set_id: 1 }],
      ["by_session", { session_id: sessionId }],
    ] as const)
      await expect(host.mutations.threads(operation, input)).resolves.toEqual(
        refusal("contract_validation_failed"),
      );
    expect(state.calls).toEqual([]);
    expect(state.kernel).toEqual([]);
    // The mutations module has no reads to offer.
    expect(Object.keys(host.mutations).sort()).toEqual([
      "createSession",
      "drafts",
      "session",
      "threads",
    ]);
  });
});

describe("roles and binding", () => {
  test("a member reads and writes as member; an approver binds approver", async () => {
    const { host, state } = harness();
    await expect(reads(host).session({ operation: "list" })).resolves.toMatchObject({ ok: true });
    state.actorId = "boss";
    await expect(reads(host).drafts("/api/drafts")).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      host.mutations.drafts("/api/draft/approve", {
        app_id: "ignored",
        change_set_id: 7,
      }),
    ).resolves.toEqual({ ok: true, value: { ok: true, change_set: { ok: true } } });
    await expect(host.viewer()).resolves.toEqual({ canApprove: true, authors: true });
    expect(state.calls).toEqual([
      { kind: "read", options: { requiredRole: "member" } },
      { kind: "read", options: { requiredRole: "approver" } },
      // The mutation's DTO: the validated request, without the ignored scope.
      {
        kind: "action",
        options: { requiredRole: "approver" },
        payload: { operation: "kernel_approve_draft_change_set", change_set_id: 7 },
      },
    ]);
    await expect(reads(host).authors(["person", "boss"])).resolves.toEqual({
      ok: true,
      value: { person: "Pat" },
    });
  });

  test("re-authorize before the data call: an approver revoked mid-action is refused", async () => {
    const { host, state } = harness();
    state.actorId = "boss";
    // The action's own check passes; the transaction's re-check finds the role gone.
    state.revokeApproverAfter = 1;
    await expect(reads(host).drafts("/api/drafts")).resolves.toEqual(
      refusal("app_access_required"),
    );
    expect(state.kernel).toEqual([]);
    // Then the next action is refused at its own check.
    await expect(reads(host).drafts("/api/drafts")).resolves.toEqual(
      refusal("app_access_required"),
    );
  });
});

describe("draft threads", () => {
  const reply = () => ({
    change_set_id: 5,
    thread_id: "t",
    message: "Hi",
    request_id: requestId,
  });

  test("access: every member reads and replies; the author or an approver resolves", async () => {
    const resolve = { change_set_id: 5, thread_id: "t", request_id: requestId };
    // [actor, the draft's source, whether they may resolve]
    const cases: [actor: string, source: Record<string, unknown>, resolves: boolean][] = [
      ["boss", { source_kind: "work_session", source_ref: sessionId }, true],
      ["boss", { source_kind: "user", source_ref: null }, true],
      ["person", { source_kind: "work_session", source_ref: sessionId }, true],
      ["colleague", { source_kind: "work_session", source_ref: sessionId }, false],
      ["person", { source_kind: "user", source_ref: null }, false],
      ["person", { source_kind: "work_session", source_ref: "not-a-uuid" }, false],
    ];
    for (const [actor, source, resolves] of cases) {
      const { host, state } = harness();
      state.actorId = actor;
      state.draft = { id: 5, status: "draft", ...source, threads: {} };
      // `get` says whether this viewer may resolve, never where the draft came from.
      await expect(threadCall(host, "get", { change_set_id: 5 }), actor).resolves.toEqual({
        ok: true,
        value: { id: 5, status: "draft", threads: {}, can_resolve: resolves },
      });
      await expect(threadCall(host, "reply", reply()), actor).resolves.toMatchObject({ ok: true });
      const result = await threadCall(host, "resolve", resolve);
      if (resolves) expect(result, actor).toMatchObject({ ok: true });
      else expect(result, actor).toEqual(refusal("authorization_denied"));
      // A refused resolve never reaches the thread write.
      const writes = state.kernel
        .filter((call) => call.operation === "kernel_draft_threads")
        .map((call) => call.input.operation)
        .filter((operation) => operation !== "get");
      expect(writes, actor).toEqual(resolves ? ["reply", "resolve"] : ["reply"]);
    }
  });

  test("by_session passes the session through; the kernel lists it for its owner only", async () => {
    for (const [actor, allowed] of [
      ["person", true],
      ["colleague", false],
      // An approver reviews drafts, but a session is still its owner's.
      ["boss", false],
    ] as const) {
      const { host, state } = harness();
      state.actorId = actor;
      const result = await reads(host).threads("by_session", { session_id: sessionId });
      if (allowed) expect(result, actor).toEqual({ ok: true, value: [] });
      else expect(result, actor).toEqual(refusal("authorization_denied"));
      expect(state.kernel, actor).toEqual([
        {
          operation: "kernel_draft_threads",
          input: { operation: "by_session", session_id: sessionId },
        },
      ]);
      expect(state.calls, actor).toEqual([
        { kind: "read", options: { requiredRole: actor === "boss" ? "approver" : "member" } },
      ]);
    }
  });

  test("a missing draft is missing to every member: drafts are no secret within the app", async () => {
    for (const actor of ["colleague", "boss"])
      for (const operation of ["get", "reply", "resolve"] as const) {
        const input =
          operation === "get"
            ? { change_set_id: 5 }
            : operation === "reply"
              ? reply()
              : { change_set_id: 5, thread_id: "t", request_id: requestId };
        const { host, state } = harness();
        state.actorId = actor;
        state.draft = null;
        expect(await threadCall(host, operation, input), `${actor} ${operation}`).toEqual(
          refusal("record_target_missing"),
        );
      }
  });

  test("a gesture names itself with a UUID request id, passed through in its payload", async () => {
    const { host, state } = harness();
    for (const input of [
      { change_set_id: 1, thread_id: "t", message: "Hi" },
      { change_set_id: 1, thread_id: "t", message: "Hi", request_id: "not-a-uuid" },
    ])
      await expect(host.mutations.threads("reply", input)).resolves.toEqual(
        refusal("contract_validation_failed"),
      );
    await expect(
      host.mutations.threads("resolve", { change_set_id: 1, thread_id: "t" }),
    ).resolves.toEqual(refusal("contract_validation_failed"));
    expect(state.calls).toEqual([]);
    await expect(host.mutations.threads("reply", reply())).resolves.toMatchObject({ ok: true });
    expect(state.calls.at(-1)).toEqual({
      kind: "action",
      options: { requiredRole: "member" },
      payload: { operation: "reply", ...reply() },
    });
    expect(state.kernel.at(-1)).toEqual({
      operation: "kernel_draft_threads",
      input: { operation: "reply", ...reply() },
    });
  });

  test("session mutations and a new session carry their request ids to the kernel", async () => {
    const { host, state } = harness();
    const pin = {
      operation: "pin",
      session_id: sessionId,
      expected_revision: 3,
      request_id: requestId,
      pinned: true,
    };
    await host.mutations.session(pin);
    expect(state.calls.at(-1)).toEqual({
      kind: "action",
      options: { requiredRole: "member" },
      payload: pin,
    });
    expect(state.kernel.at(-1)?.input).toMatchObject({ request_id: requestId });
    // An edit is last-write-wins: no revision or request id reaches the kernel,
    // and one that names them is refused before it.
    const stage = { operation: "stage", session_id: sessionId, changes: [] };
    await host.mutations.session(stage);
    expect(state.kernel.at(-1)?.input).not.toHaveProperty("request_id");
    expect(state.kernel.at(-1)?.input).not.toHaveProperty("expected_revision");
    const kernelCalls = state.kernel.length;
    expect(
      await host.mutations.session({ ...stage, expected_revision: 3, request_id: requestId }),
    ).toMatchObject({ ok: false, error: { code: "contract_validation_failed" } });
    expect(state.kernel).toHaveLength(kernelCalls);
    const created = await host.mutations.createSession({
      ...newSession(),
      title: " Plan ",
      models: ["item", "item"],
    });
    expect(created).toEqual({ ok: true, value: { sessionId } });
    const payload = state.calls.at(-1)!.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      operation: "create",
      session_id: sessionId,
      request_id: requestId,
      expected_revision: 0,
      title: "Plan",
      scope: { models: ["item"] },
    });
    // The kernel receives exactly the payload the action was bound to.
    const { schema_version: _, ...sent } = state.kernel.at(-1)!.input;
    expect(sent).toEqual(payload);
  });

  test("a new session's ids come from the browser, so a retried submit sends the same request", async () => {
    const { host, state } = harness();
    for (const input of [
      { title: "Plan", models: ["item"] },
      { title: "Plan", models: ["item"], session_id: sessionId },
      { ...newSession(), request_id: "not-a-uuid" },
    ])
      await expect(host.mutations.createSession(input)).resolves.toEqual(
        refusal("contract_validation_failed"),
      );
    expect(state.calls).toEqual([]);
    await host.mutations.createSession(newSession());
    await host.mutations.createSession(newSession());
    const [first, retry] = state.calls.map((call) => call.payload);
    // Identical, layout unit ids included: the kernel replays the second.
    expect(retry).toEqual(first);
    expect((first as { layout: { units: { id: string }[] } }).layout.units[0]!.id).toBe("unit-1");
  });

  test("a new session's as-of date comes from the gesture: any calendar date, kept across a retry past midnight", async () => {
    const { host, state } = harness();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-30T23:59:30Z"));
      // Not a calendar date is refused.
      for (const as_of of ["2026-10-3", "2026-02-30", "today", undefined])
        await expect(host.mutations.createSession({ ...newSession(), as_of })).resolves.toEqual(
          refusal("contract_validation_failed"),
        );
      expect(state.calls).toEqual([]);
      // A future date, such as next 1 January, is accepted.
      await expect(
        host.mutations.createSession({ ...newSession(), as_of: "2027-01-01" }),
      ).resolves.toMatchObject({ ok: true });
      await host.mutations.createSession(newSession());
      vi.setSystemTime(new Date("2026-10-31T00:00:30Z"));
      await host.mutations.createSession(newSession());
    } finally {
      vi.useRealTimers();
    }
    const [future, first, retry] = state.calls.map((call) => call.payload);
    expect(future).toMatchObject({ as_of: "2027-01-01" });
    expect(first).toMatchObject({ as_of: "2026-10-30" });
    expect(retry).toEqual(first);
  });
});

describe("routes", () => {
  const events = (signal?: AbortSignal) =>
    new Request(`https://zone.test/canvas-host/api/events/${sessionId}`, {
      ...(signal ? { signal } : {}),
    });

  test("the events route refuses without a session or access, and streams in either mode", async () => {
    const { host, state } = harness();
    state.actorId = null;
    expect((await host.routes.events(events(), sessionId)).status).toBe(401);
    state.actorId = "stranger";
    expect((await host.routes.events(events(), sessionId)).status).toBe(403);
    state.actorId = "person";
    expect((await host.routes.events(events(), "not-a-uuid")).status).toBe(400);
    const abort = new AbortController();
    const response = await host.routes.events(events(abort.signal), sessionId);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(
      "event: revision\ndata: 3\n\n",
    );
    expect(state.calls).toEqual([{ kind: "read", options: { requiredRole: "member" } }]);
    abort.abort();
    await reader.closed;
    expect(state.listenersEnded).toBe(1);
  });

  const mcp = (host: ReturnType<typeof harness>["host"], headers = new Headers()) =>
    host.routes.mcp(
      new Request("https://zone.test/canvas-host/api/mcp", {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );

  test("the MCP route is unavailable when the mode serves no agents", async () => {
    const { host } = harness();
    const response = await mcp(host);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "unavailable" } });
  });

  test("in protected mode the MCP route refuses unverified requests and human principals", async () => {
    const { host, state } = harness({
      agent: {
        kind: "protected",
        verification: { kind: "public-key", verifier },
        runtime,
        verifyRelease: () => {},
      },
    });
    // No request facts verified by the app's proxy: never authenticated.
    expect((await mcp(host)).status).toBe(401);
    // A browser user's signed principal is not an agent grant, whatever its roles.
    state.actorId = "person";
    const target = "/canvas-host/api/mcp";
    const headers = gatewayHeaders(
      { actorId: "person", customerId: "tenant", grants: [{ role: "member", fenceGeneration: 1 }] },
      "POST",
      target,
    );
    headers.set(VERIFIED_METHOD_HEADER, "POST");
    headers.set(VERIFIED_TARGET_HEADER, target);
    expect((await mcp(host, headers)).status).toBe(403);
  });

  test("in legacy mode the app's bearer verification answers refusals and opens the grant", async () => {
    const opened: string[] = [];
    let refusal: Response | null = new Response(null, {
      status: 401,
      headers: { "www-authenticate": 'Bearer resource_metadata="x", scope="work_session"' },
    });
    const { host } = harness({
      agent: {
        kind: "legacy",
        open: async (request) => {
          opened.push(request.headers.get("authorization") ?? "");
          if (refusal) return refusal;
          return {
            grantId: "grant-1",
            contextForTurn: () => {
              throw new Error("tools/list opens no context");
            },
            close: async () => {
              opened.push("closed");
            },
          };
        },
      },
    });
    const refused = await mcp(host, new Headers({ authorization: "Bearer a.b.c" }));
    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toContain("resource_metadata");
    refusal = null;
    const listed = await mcp(
      host,
      new Headers({
        authorization: "Bearer a.b.c",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      }),
    );
    expect(listed.status).toBe(200);
    expect(await listed.text()).toContain("stage_changes");
    expect(opened).toEqual(["Bearer a.b.c", "Bearer a.b.c", "closed"]);
  });
});

describe("the canvas view in the MCP route", () => {
  const chat = (html: string | null): CanvasChat => ({
    publicOrigin: "https://apps.test",
    title: "Canvas host",
    claudeDomain: "x.claudemcpcontent.com",
    html: async () => html,
    agGridLicenseKey: null,
    agChartsLicenseKey: null,
  });
  const agent: CanvasAgentBinding = {
    kind: "legacy",
    open: async () => ({
      grantId: "grant-1",
      contextForTurn: () => {
        throw new Error("initialize opens no context");
      },
      close: async () => {},
    }),
  };
  const rpc = async (host: Host, method: string) => {
    const response = await host.routes.mcp(
      new Request("https://zone.test/canvas-host/api/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer a.b.c",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params:
            method === "initialize"
              ? {
                  protocolVersion: "2025-06-18",
                  capabilities: {},
                  clientInfo: { name: "host-test", version: "1.0.0" },
                }
              : {},
        }),
      }),
    );
    const text = await response.text();
    const json = text.trimStart().startsWith("{")
      ? text
      : text
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5))
          .join("");
    return JSON.parse(json) as {
      result: {
        capabilities?: { resources?: unknown };
        tools?: { name: string; _meta?: unknown }[];
      };
    };
  };

  test("with the built document: the resource and open_canvas's view", async () => {
    const { host } = harness({ agent, chat: chat("<html><head></head><body></body></html>") });
    expect((await rpc(host, "initialize")).result.capabilities?.resources).toBeDefined();
    const open = (await rpc(host, "tools/list")).result.tools?.find(
      (tool) => tool.name === "open_canvas",
    );
    expect(open?._meta).toMatchObject({ ui: { resourceUri: "ui://autograph/canvas" } });
  });

  test("without it: text only, no resources capability and no resourceUri", async () => {
    const { host } = harness({ agent, chat: chat(null) });
    expect((await rpc(host, "initialize")).result.capabilities?.resources).toBeUndefined();
    const open = (await rpc(host, "tools/list")).result.tools?.find(
      (tool) => tool.name === "open_canvas",
    );
    expect(open).toBeDefined();
    expect(open?._meta).toBeUndefined();
  });
});

describe("Save and as-of are the kernel's", () => {
  test("Save names no mode (it always drafts) and an update may move the as-of date", async () => {
    const { host, state } = harness();
    const save = {
      operation: "save",
      session_id: sessionId,
      expected_revision: 1,
      request_id: requestId,
    };
    await expect(host.mutations.session(save)).resolves.toMatchObject({ ok: true });
    const update = {
      operation: "update",
      session_id: sessionId,
      patch: { as_of: "2026-01-15" },
    };
    await expect(host.mutations.session(update)).resolves.toMatchObject({ ok: true });
    const sent = state.kernel.filter((call) => call.operation === "kernel_work_session");
    expect(sent.map(({ input: { schema_version: _version, ...input } }) => input)).toEqual([
      { operation: "save", session_id: sessionId, expected_revision: 1, request_id: requestId },
      update,
    ]);
  });
});

describe("batched reads", () => {
  test("a batch answers each read in order with its own result; one failure fails no other", async () => {
    const { host } = harness();
    const answer = (await readOf(host, {
      batch: [
        { read: "authors", actor_ids: ["person"] },
        { read: "list", model: "other_model", query: { asOf: "2026-01-01" } },
        { read: "authors", actor_ids: [] },
      ],
    })) as { ok: boolean; value: unknown[] };
    expect(answer.ok).toBe(true);
    expect(answer.value).toEqual([
      { ok: true, value: { person: "Pat" } },
      refusal("contract_validation_failed"),
      { ok: true, value: {} },
    ]);
    // More than one request's worth is refused whole.
    expect(
      await readOf(host, {
        batch: Array.from({ length: 41 }, () => ({ read: "authors", actor_ids: [] })),
      }),
    ).toEqual(refusal("contract_validation_failed"));
  });
});
