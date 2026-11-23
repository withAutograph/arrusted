// The browser-safe decoder: `/data` pulls node:crypto for server writes.
import { decodeWorkResult } from "@autograph/generated-app-runtime/work-sessions";
import type {
  AggregateUnit,
  DataDefinition,
  DataField,
  DataModel,
  WorkChange,
  WorkJson,
  WorkRule,
  WorkSessionClient,
  WorkSessionRequest,
  WorkTarget,
} from "@autograph/generated-app-runtime/data";
import type { ChangeSetDiff, DraftSummary, KernelClient, RecentActivityEntry } from "@contracts";

import {
  CanvasKernelError,
  type CanvasDrafts,
  type CanvasDraftStatus,
  type CanvasAggregateInput,
  type CanvasAggregateResult,
  type CanvasClient,
  type CanvasListener,
  type CanvasListInput,
  type CanvasRecord,
  type CanvasSessions,
} from "./client";
import { parseThreads } from "./threads";

type FieldValue = NonNullable<WorkChange["value"]>;
/** One canonical record: tagged values keyed by field id. */
export type MemoryRow = {
  id: string;
  values: Record<string, FieldValue | null>;
  externalKey?: string;
};
/** A Save the memory client applied, for stories and tests to inspect. */
export type MemorySave = {
  session_id: string;
  revision: number;
  entries: WorkChange[];
};
type Entry = Omit<WorkChange, "stale" | "gone" | "current_version" | "current_value">;
type Canonical = {
  version: string;
  values: Record<string, FieldValue | null>;
  externalKey?: string;
  gone?: true;
};
type Stored = {
  id: string;
  owner_id: string;
  title: string;
  as_of: string;
  scope: WorkJson;
  layout: WorkJson;
  pinned: boolean;
  status: string;
  revision: number;
  updated_at: string;
  rules: Record<string, Record<string, unknown>>;
  threads: Record<string, Record<string, unknown>>;
  receipts: Map<string, { fingerprint: string; change_set?: unknown }>;
  entries: Map<string, Entry>;
  /** The owner's selection (presence): no revision, no notification. */
  presence?: { selection: unknown[]; updated_at: string };
};
type Identity = { kind: "human" | "agent"; principal: string; turnId?: string };
/** A change set Save (or `seedDraft`) recorded: its values before and after, and its threads. */
type ChangeSet = {
  id: number;
  actor_id: string;
  source_kind: string;
  source_ref: string | null;
  status: CanvasDraftStatus;
  notes: string | null;
  created_at: string;
  applied_at: string | null;
  as_of: string;
  changes: (WorkTarget & { before: FieldValue | null; after: FieldValue | null })[];
  /**
   * Records the draft creates (`seedDraft`), with their values by field id;
   * `existed` once publishing found the record already there (its values
   * were then a change, so a revert keeps the record and restores `prior`,
   * the values they overwrote).
   */
  creates?: {
    model_id: string;
    record_id: string;
    values: Record<string, FieldValue | null>;
    existed?: true;
    prior?: Record<string, FieldValue | null>;
  }[];
  /** Records the draft deletes (`seedDraft`). */
  deletes?: { model_id: string; record_id: string }[];
  /** Records a revert of a deletion brings back. */
  restores?: { model_id: string; record_id: string }[];
  threads: Record<string, Record<string, unknown>>;
  /** Rule notes of the saved entries, keyed `model:record:field`. */
  entry_notes?: Record<string, string>;
};
/** A draft another user saved, for stories and tests (`seedDraft`). */
export type MemoryDraft = {
  actorId: string;
  changes: readonly (WorkTarget & { value: FieldValue | null })[];
  /** Records it creates, with their values by field id. */
  creates?: readonly {
    model_id: string;
    record_id: string;
    values: Record<string, FieldValue | null>;
  }[];
  /** Records it deletes. */
  deletes?: readonly { model_id: string; record_id: string }[];
  notes?: string;
  /** The session it was saved from; defaults to none. */
  sessionId?: string;
  as_of?: string;
  threads?: readonly {
    id: string;
    anchor: WorkJson;
    resolved?: boolean;
    messages: readonly { actor_id: string; author_kind?: "human" | "agent"; message: string }[];
  }[];
};
type Request = WorkSessionRequest & Record<string, unknown>;

const humanOnly = new Set(["create", "duplicate", "save", "archive", "unarchive", "pin", "pull"]);
/** What an agent's `update` may patch: the canvas's arrangement and its as-of date. */
const agentPatch = new Set(["layout", "as_of"]);
/** As the kernel: last-write-wins edits, with no request id, revision or receipt. */
const editOperations = new Set(["update", "stage", "unstage", "discard_source", "discard_turn"]);
/** Whether a request is a last-write-wins edit (sent with no revision or request id). */
export const isEdit = (request: { operation: string }) => editOperations.has(request.operation);
const fail = (code: string, message: string, details: readonly unknown[] = []): never => {
  throw new CanvasKernelError(code, message, details);
};
/** At most this many selected targets are kept as presence, as the kernel bounds it. */
const PRESENCE_LIMIT = 200;
const keyOf = (t: WorkTarget) => JSON.stringify([t.model_id, t.record_id, t.field_id]);
const target = (t: WorkTarget): WorkTarget => ({
  model_id: t.model_id,
  record_id: t.record_id,
  field_id: t.field_id,
});
const compareTargets = (a: WorkTarget, b: WorkTarget) =>
  a.model_id.localeCompare(b.model_id) ||
  a.record_id.localeCompare(b.record_id) ||
  a.field_id.localeCompare(b.field_id);
function canonicalJson(value: unknown): string {
  const sort = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(sort)
      : item !== null && typeof item === "object"
        ? Object.fromEntries(
            Object.keys(item)
              .toSorted()
              .map((key) => [key, sort((item as Record<string, unknown>)[key])]),
          )
        : item;
  return JSON.stringify(sort(value));
}
/** The kernel's value equality: numbers and money amounts compare numerically. */
function sameValue(a: FieldValue | null, b: FieldValue | null): boolean {
  if (canonicalJson(a) === canonicalJson(b)) return true;
  if (a === null || b === null || a.type !== b.type) return false;
  if (a.type === "number" && b.type === "number") return compareDecimals(a.value, b.value) === 0;
  if (a.type === "money_rate" && b.type === "money_rate")
    return (
      a.value.currency === b.value.currency &&
      a.value.period === b.value.period &&
      compareDecimals(a.value.amount, b.value.amount) === 0
    );
  return false;
}
const wireType = (field: DataField) =>
  field.type === "iso_country" || field.type === "iso_currency"
    ? "text"
    : field.type === "known_aliases"
      ? "text_list"
      : field.type;

/** Decimal strings added exactly. */
function sumDecimals(values: readonly string[]): string {
  const scale = Math.max(0, ...values.map((v) => v.split(".")[1]?.length ?? 0));
  const scaled = (v: string) => {
    const [whole, fraction = ""] = v.replace("-", "").split(".");
    return BigInt(whole + fraction.padEnd(scale, "0")) * (v.startsWith("-") ? -1n : 1n);
  };
  const total = values.reduce((sum, v) => sum + scaled(v), 0n);
  const digits = (total < 0n ? -total : total).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, "");
  return `${total < 0n ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}
/** A decimal string divided by a count, to 28 places with trailing zeros dropped. */
function divideDecimal(value: string, count: number): string {
  const places = 28;
  const [whole, fraction = ""] = value.replace("-", "").split(".");
  const scaled = BigInt(whole + fraction.padEnd(places, "0").slice(0, places));
  const quotient = scaled / BigInt(count);
  const digits = quotient.toString().padStart(places + 1, "0");
  const integer = digits.slice(0, digits.length - places);
  const rest = digits.slice(digits.length - places).replace(/0+$/, "");
  const sign = value.startsWith("-") && quotient !== 0n ? "-" : "";
  return `${sign}${integer}${rest ? `.${rest}` : ""}`;
}
/** Decimal strings compared exactly: negative, zero or positive. */
function compareDecimals(a: string, b: string): number {
  const difference = sumDecimals([a, b.startsWith("-") ? b.slice(1) : `-${b}`]);
  return difference === "0" ? 0 : difference.startsWith("-") ? -1 : 1;
}

/**
 * An in-memory CanvasClient for Storybook and tests, following the kernel's
 * work-session semantics closely enough that canvas bugs show: revisions,
 * last-write-wins edits (stage, unstage, discard, update), request-id
 * receipts where the kernel keeps them (create, duplicate, Save, rules,
 * threads, pull, dismiss), first-baseline staging, provenance, threads,
 * proposals and Save. Not modelled: authorization grants, value validation beyond the
 * column's wire type, and rule evaluation — rules are stored and returned,
 * but their expressions stage nothing.
 */
export function createMemoryCanvasClient(options: {
  definition: DataDefinition;
  rows: Record<string, readonly MemoryRow[]>;
  actorId?: string;
  /** A session to start with, at revision 1. */
  session?: { id: string; title: string; as_of: string; scope?: WorkJson; layout?: WorkJson };
  /**
   * Gives the client `drafts`: every Save records a draft change set with
   * the session's open threads, and the review routes read and act on them.
   * `authors` names actor ids.
   */
  drafts?: { canApprove?: boolean; authors?: Readonly<Record<string, string>> };
  /**
   * Gives the client `sessions` (the sessions menu): new sessions start with
   * `layout`; `open` calls `onOpen` (a story switches the canvas to it).
   */
  sessions?: { layout?: WorkJson; onOpen?: (sessionId: string) => void };
}) {
  const { definition } = options;
  const actor = options.actorId ?? "user-1";
  const human: Identity = { kind: "human", principal: `human:${actor}` };
  let rows = new Map<string, Map<string, Canonical>>(
    definition.models.map((model) => [
      model.id,
      new Map(
        (options.rows[model.id] ?? []).map((row) => [
          row.id,
          {
            version: crypto.randomUUID(),
            values: { ...row.values },
            ...(row.externalKey === undefined ? {} : { externalKey: row.externalKey }),
          },
        ]),
      ),
    ]),
  );
  let sessions = new Map<string, Stored>();
  const saves: MemorySave[] = [];
  let changeSets = new Map<number, ChangeSet>();
  let changeSetSeq = 0;
  const listeners = new Map<string, Set<CanvasListener>>();
  let clock = 0;
  const now = () => {
    clock = Math.max(Date.now(), clock + 1);
    return new Date(clock).toISOString();
  };
  const model = (id: string): DataModel =>
    definition.models.find((item) => item.id === id) ??
    fail("contract_validation_failed", `unknown model ${id}`);
  const fieldOf = (owner: DataModel, id: string) => owner.fields.find((item) => item.id === id);
  /** Sessions whose stream is down (`disconnect`): they hear nothing until `reconnect`. */
  const disconnected = new Set<string>();
  const notify = (session: Stored) => {
    if (disconnected.has(session.id)) return;
    for (const listener of listeners.get(session.id) ?? [])
      queueMicrotask(() => listener.onRevision(session.revision));
  };
  /** Published data changed: every subscriber hears it, whatever its session. */
  const notifyData = () => {
    for (const [sessionId, set] of listeners)
      if (!disconnected.has(sessionId))
        for (const listener of set) queueMicrotask(() => listener.onData?.());
  };

  /** An entry annotated against canonical truth, as get and entries return it. */
  const annotate = (entry: Entry): WorkChange => {
    const record = rows.get(entry.model_id)?.get(entry.record_id);
    if (record === undefined || record.gone)
      return {
        ...structuredClone(entry),
        stale: true,
        current_version: record?.version ?? null,
        current_value: null,
        gone: "record_gone",
      };
    return {
      ...structuredClone(entry),
      stale: record.version !== entry.base_version,
      current_version: record.version,
      current_value: structuredClone(record.values[entry.field_id] ?? null),
    };
  };
  const goneOf = (value: unknown) => {
    const t = value as Partial<WorkTarget> | null;
    if (t === null || typeof t !== "object" || typeof t.model_id !== "string") return undefined;
    if (typeof t.record_id !== "string") return undefined;
    const record = rows.get(t.model_id)?.get(t.record_id);
    return record === undefined || record.gone ? "record_gone" : undefined;
  };
  const sorted = (session: Stored) =>
    [...session.entries.values()].toSorted(compareTargets).map(annotate);

  /** A human's staged value and trusted principal, as `replaced` keeps them. */
  const humanValue = (entry: Entry) => ({
    value: structuredClone(entry.value),
    author_kind: "human" as const,
    actor_id: entry.actor_id,
    author_principal: entry.author_principal,
  });
  /** Validates changes as staging does; with `apply`, writes them under `provenance`. */
  const stage = (
    session: Stored,
    changes: unknown,
    provenance: Pick<Entry, "source" | "actor_id" | "author_principal" | "author_kind"> & {
      turn_id?: string;
      thread_id?: string;
      note?: string;
    },
    apply: boolean,
  ) => {
    if (!Array.isArray(changes)) fail("contract_validation_failed", "changes must be an array");
    const latest = new Map<string, WorkTarget & { value: FieldValue | null; thread_id?: string }>();
    for (const change of changes as Record<string, unknown>[]) {
      if (
        change === null ||
        typeof change !== "object" ||
        !["model_id", "record_id", "field_id", "value"].every((key) => Object.hasOwn(change, key))
      )
        fail("contract_validation_failed", "invalid staged change");
      const typed = change as WorkTarget & { value: FieldValue | null; thread_id?: string };
      latest.set(keyOf(typed), typed);
    }
    for (const change of latest.values()) {
      const field = fieldOf(model(change.model_id), change.field_id);
      if (field === undefined || field.readOnly || "expression" in field)
        fail("contract_validation_failed", "unsupported staged field");
      if (change.value !== null && change.value.type !== wireType(field!))
        fail("contract_validation_failed", "Invalid staged value");
      const record = rows.get(change.model_id)?.get(change.record_id);
      if (record === undefined || record.gone)
        fail("record_target_missing", "staged target is gone");
    }
    if (!apply) return;
    for (const change of latest.values()) {
      const record = rows.get(change.model_id)!.get(change.record_id)!;
      const canonical = record.values[change.field_id] ?? null;
      const key = keyOf(change);
      const existing = session.entries.get(key);
      // A change to the current canonical value removes the entry, whoever
      // staged it, except an agent's over a person's entry (or over its own
      // entry holding a person's replaced value): that stays staged with the
      // person's value as `replaced`, so Restore brings it back.
      const keepsPerson =
        provenance.author_kind === "agent" &&
        (existing?.author_kind === "human" || existing?.replaced?.author_kind === "human");
      if (sameValue(canonical, change.value) && !keepsPerson) {
        session.entries.delete(key);
        continue;
      }
      const time = now();
      const thread = change.thread_id ?? provenance.thread_id;
      // As the kernel: a human's write clears `replaced`; an agent's write over
      // a human's entry keeps that human's value for Restore; later agent
      // writes keep it; agent over agent never creates one.
      const replaced =
        provenance.author_kind === "human"
          ? undefined
          : existing?.author_kind === "human"
            ? humanValue(existing)
            : existing?.replaced;
      // An entry keeps its first baseline, base version and creation time.
      session.entries.set(key, {
        ...target(change),
        value: structuredClone(change.value),
        baseline: existing?.baseline ?? structuredClone(canonical),
        base_version: existing?.base_version ?? record.version,
        source: provenance.source,
        actor_id: provenance.actor_id,
        author_principal: provenance.author_principal,
        author_kind: provenance.author_kind,
        ...(thread === undefined ? {} : { thread_id: thread }),
        ...(provenance.turn_id === undefined ? {} : { turn_id: provenance.turn_id }),
        ...(replaced === undefined ? {} : { replaced }),
        ...(provenance.note === undefined ? {} : { note: provenance.note }),
        created_at: existing?.created_at ?? time,
        updated_at: time,
      });
    }
  };
  /**
   * As the kernel's discard: an agent entry that holds a human's overwritten
   * value goes back to that value as the human's entry; returns their targets.
   */
  const restoreHuman = (session: Stored, match: (entry: Entry) => boolean) => {
    const restored: WorkTarget[] = [];
    for (const [key, entry] of session.entries)
      if (
        match(entry) &&
        entry.author_kind === "agent" &&
        entry.replaced?.author_kind === "human"
      ) {
        const {
          rule_id: _rule,
          thread_id: _thread,
          turn_id: _turn,
          note: _note,
          replaced: held,
          ...rest
        } = entry as Entry & { rule_id?: string };
        const replaced = held!;
        session.entries.set(key, {
          ...rest,
          value: structuredClone(replaced.value),
          source: "user",
          actor_id: replaced.actor_id,
          author_principal:
            (replaced as { author_principal?: string }).author_principal ?? entry.author_principal,
          author_kind: "human",
          updated_at: now(),
        });
        restored.push(target(entry));
      }
    return restored;
  };
  /** Deletes the entries `match` selects; returns their targets. */
  const remove = (session: Stored, match: (entry: Entry) => boolean) => {
    const removed: WorkTarget[] = [];
    for (const [key, entry] of session.entries)
      if (match(entry)) {
        session.entries.delete(key);
        removed.push(target(entry));
      }
    return removed;
  };
  const ownedBy =
    (identity: Identity) => (entry: { author_kind?: unknown; author_principal?: unknown }) =>
      entry.author_kind === "agent" && entry.author_principal === identity.principal;

  const header = (session: Stored) => ({
    id: session.id,
    owner_id: session.owner_id,
    title: session.title,
    as_of: session.as_of,
    scope: structuredClone(session.scope),
    layout: structuredClone(session.layout),
    pinned: session.pinned,
    status: session.status,
    revision: session.revision,
  });
  const read = (input: Request) => {
    const session = sessions.get(String(input.session_id));
    if (session === undefined) return fail("authorization_denied", "session is unavailable");
    if (input.overlay !== undefined && typeof input.overlay !== "boolean")
      fail("contract_validation_failed", "overlay must be boolean");
    const threads = structuredClone(session.threads);
    for (const thread of Object.values(threads)) {
      const proposal = thread.proposal as { changes: Record<string, unknown>[] } | undefined;
      if (proposal)
        proposal.changes = proposal.changes.map((change) => {
          const gone = goneOf(change);
          return gone === undefined ? change : { ...change, gone };
        });
      const gone = goneOf(thread.anchor);
      if (gone !== undefined) thread.anchor = { ...(thread.anchor as object), gone };
    }
    return {
      ...header(session),
      rules: structuredClone(session.rules),
      threads,
      presence: structuredClone(session.presence ?? null),
      ...(input.overlay === false ? {} : { overlay: sorted(session) }),
    };
  };
  const page = (input: Request) => {
    const session = sessions.get(String(input.session_id));
    if (session === undefined) return fail("authorization_denied", "session is unavailable");
    const limit = input.limit === undefined ? 200 : input.limit;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 1000)
      fail("contract_validation_failed", "limit must be an integer from 1 to 1000");
    const after = input.after as WorkTarget | undefined;
    const matching = sorted(session).filter(
      (entry) =>
        (input.model_id === undefined || entry.model_id === input.model_id) &&
        (input.source === undefined || entry.source === input.source) &&
        (input.turn_id === undefined || entry.turn_id === input.turn_id) &&
        (after === undefined || compareTargets(entry, after) > 0),
    );
    const entries = matching.slice(0, limit as number);
    const has_more = matching.length > entries.length;
    return {
      revision: session.revision,
      entries,
      has_more,
      next: has_more ? target(entries.at(-1)!) : null,
    };
  };

  const mutate = (identity: Identity, input: Request): Record<string, unknown> => {
    const op = input.operation;
    const agent = identity.kind === "agent";
    // An agent may arrange the canvas (a layout-only update), never retitle or rescope it.
    const patch = input.patch;
    const agentMay =
      patch !== null &&
      typeof patch === "object" &&
      !Array.isArray(patch) &&
      Object.keys(patch).length > 0 &&
      Object.entries(patch).every(([key, value]) => agentPatch.has(key) && value !== undefined);
    if (agent && (humanOnly.has(op) || (op === "update" && !agentMay)))
      fail("authorization_denied", "operation requires a human");
    // As the kernel: edits are last-write-wins, with no request id, revision
    // or receipt; every other mutation names both.
    const lww = editOperations.has(op);
    const requestId = typeof input.request_id === "string" ? input.request_id.trim() : "";
    const expected = input.expected_revision;
    if (lww && (Object.hasOwn(input, "request_id") || Object.hasOwn(input, "expected_revision")))
      fail(
        "contract_validation_failed",
        "edits are last-write-wins and take no request_id or expected_revision",
      );
    if (
      !lww &&
      (!requestId ||
        typeof expected !== "number" ||
        !Number.isSafeInteger(expected) ||
        expected < 0)
    )
      fail("contract_validation_failed", "mutation requires request_id and expected_revision");
    const sessionId = String(input.session_id);
    const fingerprint = canonicalJson({
      input,
      principal: identity.principal,
      turn: identity.turnId ?? null,
    });
    let session = sessions.get(sessionId);
    let replay = false;
    if (session !== undefined) {
      const receipt = lww ? undefined : session.receipts.get(requestId);
      if (receipt !== undefined) {
        // A replay repeats no effect: it answers from the current state.
        if (receipt.fingerprint !== fingerprint)
          fail("idempotency_conflict", "request id was reused");
        replay = true;
      } else {
        if (op === "create" || op === "duplicate")
          fail("revision_conflict", "session already exists");
        if (!lww && session.revision !== expected) fail("revision_conflict", "session changed");
        if (session.status !== "active" && op !== "unarchive")
          fail("revision_conflict", "session is archived");
      }
    } else if (op !== "create" && op !== "duplicate")
      fail("authorization_denied", "session is unavailable");

    if (op === "duplicate") {
      if (!replay) {
        if (expected !== 0) fail("revision_conflict", "session already exists");
        const source = sessions.get(String(input.source_session_id));
        if (source === undefined || source.status !== "active")
          fail("authorization_denied", "session is unavailable");
        if (typeof input.title !== "string" || !input.title.trim())
          fail("contract_validation_failed", "title required");
        session = {
          ...structuredClone(source!),
          id: sessionId,
          title: input.title as string,
          pinned: false,
          revision: 1,
          updated_at: now(),
          threads: {},
          receipts: new Map([[requestId, { fingerprint }]]),
        };
        // As the kernel: copied entries belong to no thread and no agent turn.
        for (const entry of session.entries.values()) {
          delete entry.thread_id;
          delete entry.turn_id;
        }
        sessions.set(sessionId, session);
        notify(session);
      }
      return { revision: session!.revision, session_id: sessionId };
    }
    if (op === "create") {
      if (!replay) {
        if (expected !== 0) fail("revision_conflict", "session already exists");
        if (
          typeof input.title !== "string" ||
          !input.title.trim() ||
          typeof input.as_of !== "string"
        )
          fail("contract_validation_failed", "title and as_of required");
        session = {
          id: sessionId,
          owner_id: actor,
          title: input.title as string,
          as_of: input.as_of as string,
          scope: (input.scope as WorkJson) ?? {},
          layout: (input.layout as WorkJson) ?? {},
          pinned: false,
          status: "active",
          revision: 1,
          updated_at: now(),
          rules: {},
          threads: {},
          receipts: new Map([[requestId, { fingerprint }]]),
          entries: new Map(),
        };
        sessions.set(sessionId, session);
        notify(session);
      }
      return { revision: session!.revision, session_id: sessionId };
    }
    const s = session!;
    let touched: WorkTarget[] | undefined;
    let removed: WorkTarget[] = [];
    let restored: WorkTarget[] = [];
    let extra: Record<string, unknown> = {};
    const threadId = String(input.thread_id ?? "");
    const ruleId = String(input.rule_id ?? "");
    const provenance = {
      source: agent ? ("agent" as const) : ("user" as const),
      actor_id: actor,
      author_principal: identity.principal,
      author_kind: agent ? ("agent" as const) : ("human" as const),
      ...(agent && identity.turnId !== undefined ? { turn_id: identity.turnId } : {}),
    };
    if (op === "stage")
      touched = Array.isArray(input.changes) ? (input.changes as WorkTarget[]).map(target) : [];
    if (op === "unstage") touched = [target(input as unknown as WorkTarget)];

    if (!replay) {
      switch (op) {
        case "update": {
          const patch = input.patch as Record<string, unknown> | undefined;
          if (
            patch === null ||
            typeof patch !== "object" ||
            Object.keys(patch).some(
              (key) => !["title", "scope", "layout", "as_of"].includes(key),
            ) ||
            patch.scope === null ||
            patch.layout === null
          )
            fail("contract_validation_failed", "invalid session patch");
          if ("title" in patch! && (typeof patch!.title !== "string" || !patch!.title.trim()))
            fail("contract_validation_failed", "title must be nonempty text");
          if (
            "as_of" in patch! &&
            (typeof patch!.as_of !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(patch!.as_of))
          )
            fail("contract_validation_failed", "as_of must be a date");
          // A new as-of re-reads every view; staged entries stay (rules are not evaluated here).
          Object.assign(s, structuredClone(patch));
          break;
        }
        case "pin":
          s.pinned = input.pinned === true;
          break;
        case "archive":
        case "unarchive":
          s.status = op === "archive" ? "archived" : "active";
          break;
        case "stage":
        case "unstage": {
          // Anyone stages over any staged value; the value replaced is kept for Restore.
          const note = input.note;
          if (note !== undefined && (typeof note !== "string" || note.length > 200))
            fail("contract_validation_failed", "note must be text of at most 200 characters");
          // A human unstages any entry. An agent never removes a person's
          // edit: it may not unstage a person's entry, and unstaging its own
          // entry that overwrote a person's puts the person's value back.
          if (op === "unstage") {
            const key = keyOf(touched![0]!);
            const existing = s.entries.get(key);
            if (agent && existing?.author_kind === "human")
              fail("authorization_denied", "agents may not unstage a person's change");
            const kept = agent ? restoreHuman(s, (entry) => entry === existing) : [];
            if (kept.length === 0) s.entries.delete(key);
          } else
            stage(
              s,
              input.changes,
              { ...provenance, ...(typeof note === "string" && note.trim() ? { note } : {}) },
              true,
            );
          break;
        }
        case "discard_source":
          if (input.source !== "user" && input.source !== "agent")
            fail("contract_validation_failed", "invalid source");
          if (agent && input.source !== "agent")
            fail("authorization_denied", "agents may discard only their own changes");
          {
            const match = (e: Entry) =>
              e.source === input.source && (!agent || ownedBy(identity)(e));
            restored = restoreHuman(s, match);
            removed = remove(s, match);
          }
          break;
        case "save_request": {
          // As the kernel: only an agent asks; a new request replaces the open one.
          if (!agent) fail("authorization_denied", "only an agent asks to Save");
          if (!threadId || s.threads[threadId] !== undefined)
            fail("revision_conflict", "thread exists or id missing");
          const reason = typeof input.reason === "string" ? input.reason.trim() : "";
          if (!reason || (input.reason as string).length > 200)
            fail("contract_validation_failed", "reason must be text of at most 200 characters");
          resolveSaveRequests(s);
          s.threads[threadId] = {
            id: threadId,
            kind: "save_request",
            reason,
            resolved: false,
            messages: [],
            actor_id: actor,
            author_kind: "agent",
            revision: s.revision + 1,
            created_at: now(),
          };
          break;
        }
        case "discard_turn":
          if (typeof input.turn_id !== "string" || !input.turn_id)
            fail("contract_validation_failed", "turn_id must be a lowercase UUID");
          {
            const match = (e: Entry) =>
              e.turn_id === input.turn_id && (!agent || ownedBy(identity)(e));
            restored = restoreHuman(s, match);
            removed = remove(s, match);
          }
          break;
        case "rule_create":
        case "rule_parameters":
        case "rule_remove": {
          if (!ruleId) fail("contract_validation_failed", "rule_id required");
          let rule = s.rules[ruleId];
          if (op === "rule_create") {
            if (rule !== undefined) fail("revision_conflict", "rule already exists");
            if (input.rule === null || typeof input.rule !== "object")
              fail("contract_validation_failed", "invalid work rule");
            rule = {
              ...structuredClone(input.rule as WorkRule),
              id: ruleId,
              author_principal: identity.principal,
              author_kind: provenance.author_kind,
            };
          } else if (rule === undefined) fail("record_target_missing", "rule is unavailable");
          // An agent sets any rule's parameters; removing another's rule stays human.
          if (agent && op === "rule_remove" && !ownedBy(identity)(rule!))
            fail("authorization_denied", "agents may remove only their own rules");
          if (op === "rule_remove") {
            delete s.rules[ruleId];
            removed = remove(s, (e) => e.rule_id === ruleId);
          } else {
            // Rule expressions are not evaluated here: a rule stages nothing.
            if (op === "rule_parameters")
              rule = { ...rule!, parameters: structuredClone(input.parameters) };
            s.rules[ruleId] = rule!;
          }
          break;
        }
        case "thread_open": {
          if (!threadId || s.threads[threadId] !== undefined)
            fail("revision_conflict", "thread exists or id missing");
          if (goneOf(input.anchor) !== undefined) fail("record_target_missing", "anchor is gone");
          s.threads[threadId] = {
            id: threadId,
            anchor: structuredClone(input.anchor),
            resolved: false,
            messages: [],
          };
          break;
        }
        case "thread_reply":
        case "thread_resolve":
        case "propose":
        case "pull":
        case "dismiss": {
          const thread = s.threads[threadId];
          if (thread === undefined) return fail("record_target_missing", "thread unavailable");
          const proposal = thread.proposal as Record<string, unknown> | undefined;
          if (op === "thread_reply") {
            if (typeof input.message !== "string" || !input.message.trim())
              fail("contract_validation_failed", "message required");
            (thread.messages as unknown[]).push({
              id: requestId,
              actor_id: actor,
              author_kind: provenance.author_kind,
              message: input.message,
              created_at: now(),
            });
          } else if (op === "thread_resolve") thread.resolved = true;
          else if (op === "propose") {
            if (agent && proposal !== undefined && !ownedBy(identity)(proposal))
              fail("authorization_denied", "agents may change only their own proposals");
            // Proposals are validated as staging would, but stay outside the overlay.
            stage(s, input.changes, provenance, false);
            thread.proposal = {
              id: requestId,
              changes: structuredClone(input.changes),
              actor_id: actor,
              author_principal: identity.principal,
              author_kind: provenance.author_kind,
              created_at: now(),
            };
          } else {
            // The expected revision identifies the proposal the caller saw.
            if (proposal === undefined) fail("proposal_conflict", "no proposal to resolve");
            if (op === "pull") {
              touched = (proposal!.changes as WorkTarget[]).map(target);
              // Pulled changes keep the proposal's provenance.
              stage(
                s,
                proposal!.changes,
                {
                  source: proposal!.author_kind === "agent" ? "agent" : "user",
                  actor_id: String(proposal!.actor_id),
                  author_principal: String(proposal!.author_principal),
                  author_kind: proposal!.author_kind === "agent" ? "agent" : "human",
                  thread_id: threadId,
                },
                true,
              );
            } else if (agent && !ownedBy(identity)(proposal!))
              fail("authorization_denied", "agents may dismiss only their own proposals");
            delete thread.proposal;
          }
          break;
        }
        case "save": {
          // As the kernel: Save always writes one draft; approval publishes it.
          if (s.entries.size === 0) fail("contract_validation_failed", "nothing to Save");
          const confirmed = (input.confirmed_stale ?? []) as (WorkTarget & {
            current_version: string;
            gone?: string;
          })[];
          const live: Entry[] = [];
          for (const entry of s.entries.values()) {
            const record = rows.get(entry.model_id)?.get(entry.record_id);
            const confirmation = confirmed.find((c) => keyOf(c) === keyOf(entry));
            if (record === undefined || record.gone) {
              if (
                confirmation?.gone !== "record_gone" ||
                confirmation.current_version !== (record?.version ?? null)
              )
                fail("stale_base", "confirm gone target before Save");
              continue;
            }
            if (confirmation?.gone !== undefined)
              fail("stale_base", "gone target changed before Save");
            if (
              record.version !== entry.base_version &&
              confirmation?.current_version !== record.version
            )
              fail("stale_base", "confirm current canonical version before Save");
            live.push(entry);
          }
          saves.push({
            session_id: s.id,
            revision: expected as number,
            entries: sorted(s),
          });
          if (live.length > 0) {
            changeSetSeq += 1;
            changeSets.set(changeSetSeq, {
              id: changeSetSeq,
              actor_id: actor,
              source_kind: "work_session",
              source_ref: s.id,
              status: "draft",
              notes: null,
              entry_notes: Object.fromEntries(
                live.flatMap((entry) =>
                  entry.note === undefined
                    ? []
                    : [[`${entry.model_id}:${entry.record_id}:${entry.field_id}`, entry.note]],
                ),
              ),
              created_at: now(),
              applied_at: null,
              as_of: s.as_of,
              changes: live.map((entry) => ({
                ...target(entry),
                before: structuredClone(
                  rows.get(entry.model_id)!.get(entry.record_id)!.values[entry.field_id] ?? null,
                ),
                after: structuredClone(entry.value),
              })),
              // A draft carries the session's open threads to review.
              threads: structuredClone(
                Object.fromEntries(
                  Object.entries(s.threads).filter(
                    ([, thread]) => thread.resolved !== true && thread.kind !== "save_request",
                  ),
                ),
              ),
            });
          }
          // A draft is recorded for review; approval writes canonical rows.
          s.entries.clear();
          // Save answers the agent's request to Save.
          resolveSaveRequests(s);
          extra = {
            change_set: live.length > 0 ? { id: changeSetSeq, schema_revision_id: "1" } : null,
          };
          // As the kernel: a new draft reaches open canvases.
          if (live.length > 0) notifyData();
          break;
        }
        default:
          fail("contract_validation_failed", `unknown work operation ${op}`);
      }
      s.revision += 1;
      s.updated_at = now();
      if (!lww) s.receipts.set(requestId, { fingerprint, change_set: extra.change_set });
      notify(s);
    } else if (op === "pull") {
      touched = [...s.entries.values()].filter((e) => e.thread_id === threadId).map(target);
    }

    // A mutation answers with the revision and only what it touched.
    const result: Record<string, unknown> = { revision: s.revision };
    const thread = s.threads[threadId];
    if (op === "rule_create" || op === "rule_parameters") {
      Object.assign(result, {
        entries: sorted(s).filter((e) => e.rule_id === ruleId),
        removed: [],
        rule: structuredClone(s.rules[ruleId] ?? null),
        overlaps: [],
      });
    } else if (touched !== undefined) {
      const distinct = [...new Map(touched.map((t) => [keyOf(t), t])).values()];
      Object.assign(result, {
        entries: distinct.flatMap((t) => {
          const entry = s.entries.get(keyOf(t));
          return entry === undefined ? [] : [annotate(entry)];
        }),
        removed: distinct.filter((t) => !s.entries.has(keyOf(t))),
      });
    } else if (["discard_source", "discard_turn"].includes(op))
      // The entries a discard put back to the human's value, as they now stand.
      Object.assign(result, {
        entries: restored.flatMap((t) => {
          const entry = s.entries.get(keyOf(t));
          return entry === undefined ? [] : [annotate(entry)];
        }),
        removed: replay ? [] : removed,
      });
    else if (op === "rule_remove")
      Object.assign(result, { entries: [], removed: replay ? [] : removed });
    if (op === "thread_open" || op === "save_request")
      result.thread = structuredClone(thread ?? null);
    if (op === "thread_reply")
      result.message = structuredClone(
        (thread?.messages as { id: string }[] | undefined)?.find((m) => m.id === requestId) ?? null,
      );
    if (op === "propose") {
      const proposal = thread?.proposal as { id?: string } | undefined;
      result.proposal = proposal?.id === requestId ? structuredClone(proposal) : null;
    }
    if (op === "save")
      Object.assign(result, {
        change_set: replay ? (s.receipts.get(requestId)?.change_set ?? null) : extra.change_set,
        cleared: true,
      });
    return result;
  };

  /** As the kernel: the person's selection, human-only and bounded; no revision, no notification. */
  const presence = (identity: Identity, input: Request) => {
    if (identity.kind === "agent") fail("authorization_denied", "operation requires a human");
    const session = sessions.get(String(input.session_id));
    if (session === undefined) return fail("authorization_denied", "session is unavailable");
    const selection = input.selection;
    if (!Array.isArray(selection) || selection.length > PRESENCE_LIMIT)
      fail("contract_validation_failed", "selection must be at most 200 targets");
    session.presence = { selection: structuredClone(selection as unknown[]), updated_at: now() };
    return { targets: (selection as unknown[]).length };
  };
  /** Every open save request of the session, resolved. */
  const resolveSaveRequests = (session: Stored) => {
    for (const thread of Object.values(session.threads))
      if (thread.kind === "save_request") thread.resolved = true;
  };

  const requestAs = (identity: Identity): WorkSessionClient => ({
    async request(input) {
      const request = input as Request;
      if (request.operation === "get") return decodeWorkResult(request, read(request)) as never;
      if (request.operation === "entries") return decodeWorkResult(request, page(request)) as never;
      if (request.operation === "presence")
        return decodeWorkResult(request, presence(identity, request)) as never;
      if (request.operation === "list")
        return decodeWorkResult(
          request,
          [...sessions.values()]
            .filter((s) => s.status === (request.status ?? "active"))
            .map(header),
        ) as never;
      // A failed mutation leaves no effect, as the kernel's transaction does.
      const before = {
        rows: structuredClone(rows),
        sessions: structuredClone(sessions),
        changeSets: structuredClone(changeSets),
        changeSetSeq,
      };
      try {
        // Answers pass the real response decoder, as the kernel's do.
        return decodeWorkResult(request, mutate(identity, request)) as never;
      } catch (error) {
        rows = before.rows;
        sessions = before.sessions;
        changeSets = before.changeSets;
        changeSetSeq = before.changeSetSeq;
        throw error;
      }
    },
  });

  /**
   * Canonical rows of a model; with `includePendingDrafts`, every pending
   * draft dated on or before `asOf` applies as if approved, in save order:
   * the latest wins per field, and the latest to touch a record decides
   * whether it shows (a deletion hides it; a creation or change shows it).
   * Each row keeps what came from a draft (`pending`). Then the session's
   * staged values when `work` is given, which a draft no longer names. As
   * the kernel.
   */
  const view = (
    modelId: string,
    input: Pick<CanvasListInput, "work" | "includePendingDrafts" | "asOf">,
  ) => {
    const { work } = input;
    if (input.includePendingDrafts !== undefined && typeof input.includePendingDrafts !== "boolean")
      fail("contract_validation_failed", "includePendingDrafts must be a boolean");
    const pendingDrafts =
      input.includePendingDrafts === true
        ? [...changeSets.values()]
            .filter((set) => set.status === "draft" && set.as_of <= input.asOf)
            .toSorted((a, b) => a.id - b.id)
        : [];
    const owner = model(modelId);
    const staged =
      work === undefined ? [] : [...(sessions.get(work.sessionId)?.entries.values() ?? [])];
    if (work !== undefined && !sessions.has(work.sessionId))
      fail("authorization_denied", "session is unavailable");
    const canonical = [...(rows.get(modelId) ?? new Map<string, Canonical>()).entries()]
      .filter(([, record]) => !record.gone)
      .map(([id, record]) => ({ id, record: record as Canonical | null }));
    const createdIds = new Set(
      pendingDrafts.flatMap((set) =>
        (set.creates ?? []).filter((c) => c.model_id === modelId).map((c) => c.record_id),
      ),
    );
    for (const id of createdIds)
      if (!canonical.some((row) => row.id === id)) canonical.push({ id, record: null });
    return {
      owner,
      rows: canonical.flatMap(({ id, record }) => {
        const values = structuredClone(record?.values ?? {});
        const fields = new Map<string, number>();
        let shown = record !== null;
        let created: number | null = null;
        for (const set of pendingDrafts) {
          const made = (set.creates ?? []).find(
            (c) => c.model_id === modelId && c.record_id === id,
          );
          // Only a record with no published version is created; over one that
          // exists, the draft's values overlay it like any change.
          if (made !== undefined) {
            shown = true;
            if (record === null) created ??= set.id;
            for (const [fieldId, value] of Object.entries(made.values)) {
              values[fieldId] = structuredClone(value);
              fields.set(fieldId, set.id);
            }
          }
          for (const change of set.changes)
            if (change.model_id === modelId && change.record_id === id) {
              values[change.field_id] = structuredClone(change.after);
              fields.set(change.field_id, set.id);
              shown = true;
            }
          if ((set.deletes ?? []).some((d) => d.model_id === modelId && d.record_id === id))
            shown = false;
        }
        if (!shown) return [];
        for (const entry of staged)
          if (entry.model_id === modelId && entry.record_id === id) {
            values[entry.field_id] = structuredClone(entry.value);
            fields.delete(entry.field_id);
          }
        const pending =
          created === null && fields.size === 0
            ? null
            : { ...(created === null ? {} : { created }), fields };
        return [
          {
            id,
            version: record?.version ?? `draft-${created}`,
            values,
            externalKey: record?.externalKey ?? null,
            pending,
          },
        ];
      }),
    };
  };
  const byName = (owner: DataModel, name: string) =>
    owner.fields.find((field) => field.name === name) ??
    fail("contract_validation_failed", `unknown field ${name}`);
  const plain = (value: FieldValue | null | undefined): unknown =>
    value === null || value === undefined ? null : value.value;
  const scalar = (value: FieldValue | null | undefined): string | boolean | null => {
    const inner = plain(value);
    if (inner !== null && typeof inner === "object" && "value" in inner)
      return String((inner as { value: unknown }).value);
    return inner === null || typeof inner === "boolean" ? inner : String(inner);
  };
  const filtered = (
    owner: DataModel,
    list: ReturnType<typeof view>["rows"],
    input: Pick<CanvasListInput, "where" | "search">,
  ) => {
    // As the runtime: a search names a non-blank query.
    if (input.search !== undefined && input.search.query.trim() === "")
      throw new Error("contract_validation_failed: search");
    return list.filter((row) => {
      for (const filter of input.where ?? []) {
        const field =
          filter.field === "id" || filter.field === "externalKey"
            ? undefined
            : byName(owner, filter.field);
        const left =
          filter.field === "externalKey"
            ? row.externalKey
            : field === undefined
              ? row.id
              : scalar(row.values[field.id]);
        const numeric = field?.type === "number";
        const compare = (a: string | boolean, b: string | boolean) =>
          numeric ? compareDecimals(String(a), String(b)) : String(a).localeCompare(String(b));
        if (filter.op === "isNull") {
          if (left !== null) return false;
          continue;
        }
        if (left === null || filter.value === undefined) return false;
        const order = compare(left, filter.value);
        const pass =
          filter.op === "eq"
            ? order === 0
            : filter.op === "ne"
              ? order !== 0
              : filter.op === "lt"
                ? order < 0
                : filter.op === "lte"
                  ? order <= 0
                  : filter.op === "gt"
                    ? order > 0
                    : filter.op === "gte"
                      ? order >= 0
                      : String(left).toLowerCase().includes(String(filter.value).toLowerCase());
        if (!pass) return false;
      }
      if (input.search === undefined) return true;
      const query = input.search.query.toLowerCase();
      return input.search.fields.some((name) =>
        JSON.stringify(plain(row.values[byName(owner, name).id]) ?? "")
          .toLowerCase()
          .includes(query),
      );
    });
  };

  const data = {
    async list(modelId: string, input: CanvasListInput): Promise<CanvasRecord[]> {
      // The generated data client takes pages of 1 to 100 records, as the kernel does.
      if (
        input.limit !== undefined &&
        (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
      )
        throw new Error("contract_validation_failed: limit must be 1 to 100");
      const { owner, rows: list } = view(modelId, input);
      let result = filtered(owner, list, input);
      for (const order of [...(input.orderBy ?? [])].reverse()) {
        const field = order.field === "id" ? undefined : byName(owner, order.field);
        const sign = order.direction === "asc" ? 1 : -1;
        result = result.toSorted((a, b) => {
          const left = field === undefined ? a.id : scalar(a.values[field.id]);
          const right = field === undefined ? b.id : scalar(b.values[field.id]);
          if (left === right) return 0;
          if (left === null) return 1;
          if (right === null) return -1;
          return (
            sign *
            (field?.type === "number"
              ? compareDecimals(String(left), String(right))
              : String(left).localeCompare(String(right)))
          );
        });
      }
      const offset = input.offset ?? 0;
      return result.slice(offset, offset + (input.limit ?? 100)).map((row) => ({
        id: row.id,
        externalKey: row.externalKey,
        $version: row.version,
        effectiveStart: input.asOf,
        ...Object.fromEntries(
          owner.fields.map((field) => [field.name, plain(row.values[field.id])]),
        ),
        // As the generated client decodes the kernel's `pending_draft`: by field name.
        ...(row.pending === null
          ? {}
          : {
              pendingDraft: {
                ...("created" in row.pending ? { created: row.pending.created } : {}),
                fields: Object.fromEntries(
                  owner.fields.flatMap((field) => {
                    const draft = row.pending?.fields.get(field.id);
                    return draft === undefined ? [] : [[field.name, draft]];
                  }),
                ),
              },
            }),
      }));
    },
    /** Supports `count`, and `sum`, `avg`, `min`, `max` and `median` over number and money-rate fields, grouped by fields (no bins). */
    async aggregate(modelId: string, input: CanvasAggregateInput): Promise<CanvasAggregateResult> {
      const { owner, rows: list } = view(modelId, input);
      const matched = filtered(owner, list, input);
      const groups = (input.groupBy ?? []).map((group) =>
        typeof group === "string"
          ? byName(owner, group)
          : fail("contract_validation_failed", "the memory client does not bin"),
      );
      const metrics = input.metrics.map((metric) => {
        if (metric.fn === "count") return { fn: "count" as const };
        if (!["sum", "avg", "min", "max", "median"].includes(metric.fn))
          return fail("contract_validation_failed", `unsupported metric ${metric.fn}`);
        const field = byName(owner, metric.field);
        if (field.type !== "number" && field.type !== "money_rate")
          fail("contract_validation_failed", "metric field");
        return { fn: metric.fn as "sum" | "avg" | "min" | "max" | "median", field };
      });
      const money = [
        ...new Map(
          metrics.flatMap((m) =>
            m.fn !== "count" && m.field.type === "money_rate" ? [[m.field.id, m.field]] : [],
          ),
        ).values(),
      ];
      const unitOf = (value: FieldValue | null | undefined): AggregateUnit | null =>
        value?.type === "money_rate"
          ? { currency: value.value.currency, period: value.value.period }
          : null;
      const amount = (value: FieldValue | null | undefined) =>
        value?.type === "money_rate"
          ? value.value.amount
          : value?.type === "number"
            ? value.value
            : null;
      const measure = (subset: typeof matched, total: boolean) =>
        metrics.map((metric) => {
          if (metric.fn === "count") return String(subset.length);
          const values = subset.map((row) => row.values[metric.field.id]).filter((v) => v != null);
          const units = new Set(values.map((v) => JSON.stringify(unitOf(v))));
          // Money totals across several units have no single sum.
          if (values.length === 0 || (total && units.size > 1)) return null;
          const amounts = values.map((v) => amount(v)!);
          const sum = sumDecimals(amounts);
          if (metric.fn === "sum") return sum;
          if (metric.fn === "avg") return divideDecimal(sum, values.length);
          const ordered = amounts.toSorted(compareDecimals);
          if (metric.fn === "min") return ordered[0]!;
          if (metric.fn === "max") return ordered.at(-1)!;
          const middle = Math.floor(ordered.length / 2);
          return ordered.length % 2 === 1
            ? ordered[middle]!
            : divideDecimal(sumDecimals([ordered[middle - 1]!, ordered[middle]!]), 2);
        });
      // Groups in the kernel's order: enums by option order, numbers numerically, nulls last.
      const compareKeys = (a: unknown[], b: unknown[]) => {
        for (const [index, left] of a.entries()) {
          const right = b[index];
          if (JSON.stringify(left) === JSON.stringify(right)) continue;
          if (left === null) return 1;
          if (right === null) return -1;
          const field = groups[index];
          if (field?.type === "enum") {
            const order = (value: unknown) =>
              (field.option_set ?? []).findIndex((o) => o.id === value);
            return order(left) - order(right);
          }
          if (field?.type === "number") return compareDecimals(String(left), String(right));
          const text = (value: unknown) =>
            typeof value === "object" ? JSON.stringify(value) : String(value);
          return text(left).localeCompare(text(right));
        }
        return 0;
      };
      const buckets = new Map<string, { key: unknown[]; rows: typeof matched }>();
      for (const row of matched) {
        const key = [
          ...groups.map((field) => {
            const value = row.values[field.id];
            if (value?.type === "relation") return { type: "record_id", value: scalar(value) };
            return plain(value);
          }),
          ...money.map((field) => ({ unit: unitOf(row.values[field.id]) })),
        ];
        const id = JSON.stringify(key);
        const bucket = buckets.get(id) ?? { key, rows: [] };
        bucket.rows.push(row);
        buckets.set(id, bucket);
      }
      return {
        as_of: input.asOf,
        units: metrics.map((metric) => {
          if (metric.fn === "count" || metric.field.type !== "money_rate") return null;
          const units = new Set(
            matched
              .map((row) => unitOf(row.values[metric.field.id]))
              .filter((u) => u !== null)
              .map((u) => JSON.stringify(u)),
          );
          return units.size === 1 ? (JSON.parse([...units][0]!) as AggregateUnit) : null;
        }),
        groups: [...buckets.values()]
          .toSorted((a, b) => compareKeys(a.key, b.key))
          .map((bucket) => ({ key: bucket.key, metrics: measure(bucket.rows, false) })),
        total: { metrics: measure(matched, true) },
      };
    },
  };

  const client: CanvasClient = {
    session: requestAs(human),
    data,
    definition,
    subscribe(sessionId, listener) {
      // Each subscription is its own entry, even for a listener passed twice.
      const entry = { ...listener };
      const set = listeners.get(sessionId) ?? new Set();
      set.add(entry);
      listeners.set(sessionId, set);
      // A (re)connect sends the current revision first.
      const current = sessions.get(sessionId);
      if (current !== undefined)
        queueMicrotask(() => {
          entry.onConnect?.();
          entry.onRevision(current.revision);
        });
      return () => set.delete(entry);
    },
  };
  /** Writes a change set's values to canonical rows (its after, or its before to revert). */
  const apply = (set: ChangeSet, side: "before" | "after") => {
    // Approval publishes the records a draft creates or deletes (a revert undoes it).
    for (const made of set.creates ?? []) {
      const model = rows.get(made.model_id) ?? new Map<string, Canonical>();
      rows.set(made.model_id, model);
      const existing = model.get(made.record_id);
      if (side === "after" && existing !== undefined && !existing.gone) {
        // Over a published record its values are a change, not a creation;
        // the values it overwrites are kept for a revert.
        made.prior = Object.fromEntries(
          Object.keys(made.values).map((field) => [
            field,
            structuredClone(existing.values[field] ?? null),
          ]),
        );
        Object.assign(existing.values, structuredClone(made.values));
        existing.version = crypto.randomUUID();
        made.existed = true;
      } else if (side === "after")
        model.set(made.record_id, {
          version: crypto.randomUUID(),
          values: structuredClone(made.values),
        });
      else {
        const record = model.get(made.record_id);
        if (record !== undefined) record.gone = true;
      }
    }
    for (const deleted of set.deletes ?? []) {
      const record = rows.get(deleted.model_id)?.get(deleted.record_id);
      if (record === undefined) continue;
      if (side === "after") record.gone = true;
      else delete record.gone;
      record.version = crypto.randomUUID();
    }
    for (const restored of set.restores ?? []) {
      const record = rows.get(restored.model_id)?.get(restored.record_id);
      if (record === undefined) continue;
      if (side === "after") delete record.gone;
      else record.gone = true;
      record.version = crypto.randomUUID();
    }
    for (const change of set.changes) {
      const record = rows.get(change.model_id)?.get(change.record_id);
      if (record === undefined || record.gone) continue;
      record.values[change.field_id] = structuredClone(change[side]);
    }
    for (const key of new Set(set.changes.map((c) => `${c.model_id}\u0000${c.record_id}`))) {
      const [modelId, recordId] = key.split("\u0000") as [string, string];
      const record = rows.get(modelId)?.get(recordId);
      if (record !== undefined) record.version = crypto.randomUUID();
    }
  };
  const changeSet = (body: unknown): ChangeSet => {
    const id = (body as { change_set_id?: unknown } | null)?.change_set_id;
    return (
      (typeof id === "number" ? changeSets.get(id) : undefined) ??
      fail("record_target_missing", "change set not found")
    );
  };
  /** Approves a draft: its changes reach canonical rows. */
  const publish = (set: ChangeSet) => {
    apply(set, "after");
    set.status = "mainline";
    set.applied_at = now();
    notifyData();
  };
  const pending = (set: ChangeSet) =>
    set.status === "draft" ? set : fail("contract_validation_failed", "change set is not a draft");
  const summary = (set: ChangeSet): DraftSummary => ({
    id: set.id,
    schema_revision_id: "1",
    actor_id: set.actor_id,
    source_kind: set.source_kind,
    source_ref: set.source_ref,
    change_type_id: null,
    notes: set.notes,
    created_at: set.created_at,
  });
  /** Each record a change set touches: its field changes, creation and deletion. */
  const touched = (set: ChangeSet) => {
    type Touched = {
      model_id: string;
      record_id: string;
      fields: { field_id: string; before: FieldValue | null; after: FieldValue | null }[];
      deleted: boolean;
      restored: boolean;
    };
    const byRecord = new Map<string, Touched>();
    const at = (model_id: string, record_id: string) => {
      const key = `${model_id}\u0000${record_id}`;
      const entry = byRecord.get(key) ?? {
        model_id,
        record_id,
        fields: [],
        deleted: false,
        restored: false,
      };
      byRecord.set(key, entry);
      return entry;
    };
    for (const made of set.creates ?? []) {
      const entry = at(made.model_id, made.record_id);
      for (const [field_id, value] of Object.entries(made.values))
        entry.fields.push({ field_id, before: null, after: structuredClone(value) });
    }
    for (const change of set.changes)
      at(change.model_id, change.record_id).fields.push({
        field_id: change.field_id,
        before: structuredClone(change.before),
        after: structuredClone(change.after),
      });
    for (const deleted of set.deletes ?? []) at(deleted.model_id, deleted.record_id).deleted = true;
    for (const restored of set.restores ?? [])
      at(restored.model_id, restored.record_id).restored = true;
    return [...byRecord.values()];
  };
  const diff = (set: ChangeSet): ChangeSetDiff => ({
    change_set_id: set.id,
    source_change_set_id: set.id,
    records: touched(set).map((entry) => ({
      model_id: entry.model_id,
      record_id: entry.record_id,
      external_key: rows.get(entry.model_id)?.get(entry.record_id)?.externalKey ?? null,
      version_id: crypto.randomUUID(),
      change_set_id: set.id,
      stage: set.status,
      effective_start: set.as_of,
      effective_end: null,
      before_tombstones_record: entry.restored,
      after_tombstones_record: entry.deleted,
      before_untombstones_record: false,
      after_untombstones_record: false,
      fields: entry.fields.map((field) => ({
        field_id: field.field_id,
        before: field.before as never,
        after: field.after as never,
      })),
      custom_fields: [],
    })),
  });
  const newest = (a: ChangeSet, b: ChangeSet) => b.id - a.id;
  const kernel: KernelClient = {
    async getJson<T>(path: string): Promise<T> {
      await Promise.resolve();
      const status =
        path === "/api/drafts" ? "draft" : path === "/api/drafts/rejected" ? "discarded" : null;
      if (status === null) return fail("contract_validation_failed", `unknown route ${path}`);
      return [...changeSets.values()]
        .filter((set) => set.status === status)
        .toSorted(newest)
        .map(summary) as T;
    },
    async postJson<T>(path: string, body: unknown): Promise<T> {
      await Promise.resolve();
      const input = (body ?? {}) as Record<string, unknown>;
      switch (path) {
        case "/api/diff":
          return diff(changeSet(body)) as T;
        case "/api/activity": {
          const statuses = (input.statuses as string[] | undefined) ?? ["mainline"];
          const kinds = input.source_kinds as string[] | undefined;
          return [...changeSets.values()]
            .filter(
              (set) =>
                statuses.includes(set.status) &&
                (kinds === undefined || kinds.includes(set.source_kind)),
            )
            .toSorted(newest)
            .slice(0, typeof input.limit === "number" ? input.limit : undefined)
            .map((set): RecentActivityEntry => ({
              change_set_id: set.id,
              status: set.status,
              actor_id: set.actor_id,
              source_kind: set.source_kind,
              source_ref: set.source_ref,
              change_type_id: null,
              notes: set.notes,
              created_at: set.created_at,
              applied_at: set.applied_at,
              touched_record_count: touched(set).length,
            })) as T;
        }
        case "/api/draft/approve": {
          // As the host: only an approver publishes.
          if (!(options.drafts?.canApprove ?? true))
            fail("authorization_denied", "Only an approver may publish, discard or revert drafts.");
          publish(pending(changeSet(body)));
          return { ok: true } as T;
        }
        case "/api/draft/discard": {
          const set = pending(changeSet(body));
          // A rejection's note is saved with the discard, or not at all.
          if (typeof input.notes === "string" && input.notes.trim() !== "") set.notes = input.notes;
          set.status = "discarded";
          // As the kernel: open review surfaces hear the scope's drafts changed.
          notifyData();
          return { ok: true } as T;
        }
        case "/api/draft/notes": {
          const notes = input.notes;
          changeSet(body).notes = typeof notes === "string" && notes.trim() !== "" ? notes : null;
          return { ok: true } as T;
        }
        case "/api/revert": {
          const set = changeSet(body);
          if (set.status !== "mainline") fail("contract_validation_failed", "not published");
          changeSetSeq += 1;
          const revert: ChangeSet = {
            ...structuredClone(set),
            id: changeSetSeq,
            source_kind: "revert",
            source_ref: String(set.id),
            notes: null,
            created_at: now(),
            applied_at: now(),
            changes: [
              ...set.changes.map((change) => ({
                ...change,
                before: structuredClone(change.after),
                after: structuredClone(change.before),
              })),
              // A "creation" that overlaid a published record restores what it overwrote.
              ...(set.creates ?? []).flatMap((made) =>
                made.existed === true
                  ? Object.entries(made.prior ?? {}).map(([field_id, prior]) => ({
                      model_id: made.model_id,
                      record_id: made.record_id,
                      field_id,
                      before: structuredClone(made.values[field_id] ?? null),
                      after: structuredClone(prior),
                    }))
                  : [],
              ),
            ],
            // A revert deletes what the draft created and brings back what it deleted.
            creates: [],
            deletes: (set.creates ?? [])
              .filter((made) => made.existed !== true)
              .map(({ model_id, record_id }) => ({ model_id, record_id })),
            restores: structuredClone(set.deletes ?? []),
            threads: {},
          };
          changeSets.set(revert.id, revert);
          apply(revert, "after");
          notifyData();
          return { ok: true } as T;
        }
        default:
          return fail("contract_validation_failed", `unknown route ${path}`);
      }
    },
  };
  const threadOf = (changeSetId: number, threadId: string) =>
    changeSet({ change_set_id: changeSetId }).threads[threadId] ??
    fail("record_target_missing", "thread unavailable");
  /** A reply on a draft's thread by `actorId`; every subscriber hears it, as from the kernel. */
  const replyOnDraft = (changeSetId: number, threadId: string, actorId: string, body: string) => {
    (threadOf(changeSetId, threadId).messages as unknown[]).push({
      id: crypto.randomUUID(),
      actor_id: actorId,
      author_kind: "human",
      message: body,
      created_at: now(),
    });
    notifyData();
  };
  /** The draft's author or an approver. */
  const mayResolve = (set: ChangeSet) =>
    (options.drafts?.canApprove ?? true) || set.actor_id === actor;
  const drafts: CanvasDrafts | undefined =
    options.drafts === undefined
      ? undefined
      : {
          kernel,
          canApprove: options.drafts.canApprove ?? true,
          authorName: (actorId) => options.drafts?.authors?.[actorId],
          threads: {
            async list(changeSetId) {
              await Promise.resolve();
              const set = changeSet({ change_set_id: changeSetId });
              return {
                threads: parseThreads(structuredClone(set.threads)),
                canResolve: mayResolve(set),
                ruleNotes: { ...set.entry_notes },
              };
            },
            async forSession(sessionId) {
              await Promise.resolve();
              return [...changeSets.values()]
                .filter((set) => set.source_kind === "work_session" && set.source_ref === sessionId)
                .toSorted(newest)
                .map((set) => ({
                  change_set_id: set.id,
                  status: set.status,
                  notes: set.notes,
                  threads: parseThreads(structuredClone(set.threads)),
                }));
            },
            async reply(changeSetId, threadId, body) {
              await Promise.resolve();
              replyOnDraft(changeSetId, threadId, actor, body);
            },
            async resolve(changeSetId, threadId) {
              await Promise.resolve();
              // As the host: only the draft's author or an approver resolves.
              if (!mayResolve(changeSet({ change_set_id: changeSetId })))
                fail(
                  "authorization_denied",
                  "Only the draft's author or an approver may resolve its threads.",
                );
              threadOf(changeSetId, threadId).resolved = true;
              // As the kernel: open cards and Comments panes re-read.
              notifyData();
            },
          },
        };
  if (drafts !== undefined) client.drafts = drafts;
  const today = () => new Date().toISOString().slice(0, 10);
  const opened: string[] = [];
  if (options.sessions !== undefined) {
    const setup = options.sessions;
    const menu: CanvasSessions = {
      async list() {
        await Promise.resolve();
        return [...sessions.values()]
          .filter((item) => item.status === "active")
          .toSorted(
            (a, b) =>
              Number(b.pinned) - Number(a.pinned) || b.updated_at.localeCompare(a.updated_at),
          )
          .map((item) => ({
            id: item.id,
            title: item.title,
            asOf: item.as_of,
            pinned: item.pinned,
            revision: item.revision,
            updatedAt: item.updated_at,
          }));
      },
      async create(title) {
        const sessionId = crypto.randomUUID();
        await client.session.request({
          operation: "create",
          expected_revision: 0,
          request_id: crypto.randomUUID(),
          session_id: sessionId,
          title,
          as_of: today(),
          ...(setup.layout === undefined ? {} : { layout: setup.layout }),
        });
        return { sessionId };
      },
      open(sessionId) {
        opened.push(sessionId);
        setup.onOpen?.(sessionId);
      },
      home() {
        opened.push("home");
        setup.onOpen?.("home");
      },
      cancelCreate() {},
    };
    client.sessions = menu;
  }

  if (options.session !== undefined)
    void mutate(human, {
      operation: "create",
      expected_revision: 0,
      request_id: `seed-${options.session.id}`,
      session_id: options.session.id,
      title: options.session.title,
      as_of: options.session.as_of,
      ...(options.session.scope === undefined ? {} : { scope: options.session.scope }),
      ...(options.session.layout === undefined ? {} : { layout: options.session.layout }),
    } as Request);

  return {
    client,
    /** The session client as an agent acting in one turn; its entries carry `turnId`. */
    asAgent: (turnId: string, principal = "agent:assistant") =>
      requestAs({ kind: "agent", principal, turnId }),
    /**
     * A canonical write outside the session: staged entries on the record go
     * stale, and subscribers hear that published data changed.
     */
    writeCanonical(modelId: string, recordId: string, values: Record<string, FieldValue | null>) {
      const record = rows.get(modelId)?.get(recordId) ?? fail("record_target_missing", "no record");
      Object.assign(record.values, structuredClone(values));
      record.version = crypto.randomUUID();
      notifyData();
    },
    /** Removes a canonical record: staged entries on it become gone, and subscribers hear it. */
    removeRecord(modelId: string, recordId: string) {
      const record = rows.get(modelId)?.get(recordId) ?? fail("record_target_missing", "no record");
      record.gone = true;
      record.version = crypto.randomUUID();
      notifyData();
    },
    /** Simulates a dropped stream: the session's subscribers hear nothing until `reconnect`. */
    disconnect(sessionId: string) {
      disconnected.add(sessionId);
    },
    /** Simulates a stream reconnect: subscribers hear it, then the current revision again. */
    reconnect(sessionId: string) {
      disconnected.delete(sessionId);
      const current = sessions.get(sessionId);
      if (current === undefined) return;
      for (const listener of listeners.get(sessionId) ?? [])
        queueMicrotask(() => {
          listener.onConnect?.();
          listener.onRevision(current.revision);
        });
    },
    saves: saves as readonly MemorySave[],
    /** Sessions the sessions menu opened, in order. */
    opened: opened as readonly string[],
    /**
     * Records a pending draft by another user, as if saved from a session,
     * with its threads; subscribers hear that data changed. Returns its id.
     */
    /** Publishes a seeded draft, as an approver elsewhere would. */
    seedApproval(changeSetId: number) {
      publish(pending(changeSet({ change_set_id: changeSetId })));
    },
    seedDraft(draft: MemoryDraft): number {
      changeSetSeq += 1;
      changeSets.set(changeSetSeq, {
        id: changeSetSeq,
        actor_id: draft.actorId,
        source_kind: "work_session",
        source_ref: draft.sessionId ?? null,
        status: "draft",
        notes: draft.notes ?? null,
        created_at: now(),
        applied_at: null,
        as_of: draft.as_of ?? options.session?.as_of ?? new Date().toISOString().slice(0, 10),
        changes: draft.changes.map((change) => ({
          ...target(change),
          before: structuredClone(
            rows.get(change.model_id)?.get(change.record_id)?.values[change.field_id] ?? null,
          ),
          after: structuredClone(change.value),
        })),
        ...(draft.creates === undefined ? {} : { creates: structuredClone([...draft.creates]) }),
        ...(draft.deletes === undefined ? {} : { deletes: structuredClone([...draft.deletes]) }),
        threads: Object.fromEntries(
          (draft.threads ?? []).map((thread) => [
            thread.id,
            {
              id: thread.id,
              anchor: structuredClone(thread.anchor),
              resolved: thread.resolved ?? false,
              messages: thread.messages.map((message) => ({
                id: crypto.randomUUID(),
                actor_id: message.actor_id,
                author_kind: message.author_kind ?? "human",
                message: message.message,
                created_at: now(),
              })),
            },
          ]),
        ),
      });
      notifyData();
      return changeSetSeq;
    },
    /** Another person's reply on a draft's thread, from their own client. */
    replyOnDraft(changeSetId: number, threadId: string, actorId: string, message: string) {
      replyOnDraft(changeSetId, threadId, actorId, message);
    },
    /** A change set's status, for tests. */
    changeSetStatus: (id: number) => changeSets.get(id)?.status,
    /** A change set's notes, for tests. */
    changeSetNotes: (id: number) => changeSets.get(id)?.notes ?? null,
  };
}
export type MemoryCanvas = ReturnType<typeof createMemoryCanvasClient>;
