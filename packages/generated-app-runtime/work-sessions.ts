import { z } from "zod";
import { responseFieldValue, responseAppliedChangeSet, responseUuid } from "./response-decoder";
import type { AppliedChangeSet, DerivedExpr, FieldValue } from "../contracts";
import type { DataContext } from "./data";

/** Working state is platform storage; field IDs and tagged values use the kernel vocabulary. */
export type WorkReference = { sessionId: string };
export type WorkJson =
  | null
  | boolean
  | number
  | string
  | readonly WorkJson[]
  | { readonly [key: string]: WorkJson };
export type WorkTarget = { model_id: string; record_id: string; field_id: string };
/** One staged entry per target field, with its provenance. */
export type WorkChange = WorkTarget & {
  value: FieldValue | null;
  baseline: FieldValue | null;
  base_version: string;
  source: "user" | "agent";
  actor_id: string;
  author_principal: string;
  author_kind: "human" | "agent";
  rule_id?: string;
  thread_id?: string;
  /** The agent turn that staged the entry; human edits have none. */
  turn_id?: string;
  /** The human's staged value this agent entry overwrote, kept for Restore. */
  replaced?: {
    value: FieldValue | null;
    author_kind: "human" | "agent";
    actor_id: string;
    author_principal?: string;
  };
  /** The rule note an agent staged the value with. */
  note?: string;
  created_at: string;
  updated_at: string;
  stale?: boolean;
  gone?: "record_gone" | "field_archived" | null;
  current_version?: string | null;
  current_value?: FieldValue | null;
};
/** Rule parameters are typed values, referenced by `{ type: "parameter" }` nodes. */
export type WorkRuleParameter = Extract<
  FieldValue,
  { type: "text" | "number" | "bool" | "date" | "datetime" | "money_rate" }
>;
/**
 * A rule stages `value` on `field_id` for every record of `model_id` whose
 * optional boolean `condition` holds. Both are derived expressions evaluated
 * with derived-field semantics; PostgreSQL checks names, types and read authorization.
 */
export type WorkRule = {
  id?: string;
  description?: string;
  model_id: string;
  field_id: string;
  condition?: DerivedExpr;
  value: DerivedExpr;
  parameters?: { readonly [name: string]: WorkRuleParameter };
};
export type WorkSession = {
  id: string;
  owner_id: string;
  title: string;
  as_of: string;
  scope: WorkJson;
  layout: WorkJson;
  pinned: boolean;
  status: string;
  revision: number;
  overlay: WorkChange[];
  rules: Record<string, WorkRule & { author_principal: string; author_kind: "human" | "agent" }>;
  threads: Record<string, WorkJson>;
  /** On `get`: the owner's selection in the canvas (presence), or null before any. */
  presence?: { selection: WorkSelectionTarget[]; updated_at: string } | null;
};
/** One selected record, or one cell of it. */
export type WorkSelectionTarget = { model_id: string; record_id: string; field_id?: string };
type Guard = { session_id: string; expected_revision: number; request_id: string };
/**
 * Edits (stage, unstage, discard_source, discard_turn, update) are
 * last-write-wins: they name the session and carry no revision or request id.
 */
type Edit = { session_id: string };
/** Operations that are last-write-wins edits. */
export const workEditOperations = [
  "update",
  "stage",
  "unstage",
  "discard_source",
  "discard_turn",
] as const;
export type WorkEditOperation = (typeof workEditOperations)[number];
export type WorkSessionRequest =
  | {
      operation: "create";
      expected_revision: 0;
      request_id: string;
      session_id: string;
      title: string;
      as_of: string;
      scope?: WorkJson;
      layout?: WorkJson;
    }
  | {
      /** Copies the source's metadata, rules and staged entries into `session_id`. */
      operation: "duplicate";
      expected_revision: 0;
      request_id: string;
      session_id: string;
      source_session_id: string;
      title: string;
    }
  /** `overlay: false` returns the header, rules and threads; page entries with `entries`. */
  | { operation: "get"; session_id: string; overlay?: boolean }
  | { operation: "list"; status?: "active" | "archived" }
  /** Key-ordered pages of staged entries; unreadable entries are omitted. */
  | {
      operation: "entries";
      session_id: string;
      model_id?: string;
      source?: "user" | "agent";
      turn_id?: string;
      after?: WorkTarget;
      /** 1 to 1,000; default 200. */
      limit?: number;
    }
  | (Edit & {
      operation: "update";
      /** `as_of` re-reads the session at that date; rules re-run, entries stay. */
      patch: { title?: string; scope?: WorkJson; layout?: WorkJson; as_of?: string };
    })
  | (Guard & { operation: "pin"; pinned: boolean })
  | (Guard & { operation: "archive" | "unarchive" })
  | (Edit & {
      operation: "stage";
      changes: readonly (WorkTarget & { value: FieldValue | null; thread_id?: string })[];
      /** Plain text, at most 200 characters: the rule behind the values. */
      note?: string;
    })
  | (Edit & { operation: "unstage" } & WorkTarget)
  | (Edit & { operation: "discard_source"; source: "user" | "agent" })
  /** Removes one agent turn's entries; an agent removes only its own. */
  | (Edit & { operation: "discard_turn"; turn_id: string })
  | (Guard & { operation: "rule_create"; rule_id: string; rule: WorkRule })
  | (Guard & {
      operation: "rule_parameters";
      rule_id: string;
      parameters: NonNullable<WorkRule["parameters"]>;
    })
  | (Guard & { operation: "rule_remove"; rule_id: string })
  | (Guard & { operation: "thread_open"; thread_id: string; anchor: WorkJson })
  /**
   * The agent asks the person to Save (a `save_request` thread, at most 200
   * characters of reason), resolving any open one. Agents only.
   */
  | (Guard & { operation: "save_request"; thread_id: string; reason: string })
  /**
   * The person's selection (at most 200 targets): presence state, with no
   * revision or request id; it bumps and notifies nothing. Humans only.
   */
  | { operation: "presence"; session_id: string; selection: readonly WorkSelectionTarget[] }
  | (Guard & { operation: "thread_reply"; thread_id: string; message: string })
  | (Guard & { operation: "thread_resolve"; thread_id: string })
  | (Guard & {
      operation: "propose";
      thread_id: string;
      changes: readonly (WorkTarget & { value: FieldValue | null })[];
    })
  /** `expected_revision` identifies the proposal the caller saw. */
  | (Guard & { operation: "pull" | "dismiss"; thread_id: string })
  | (Guard & {
      /** `expected_revision` identifies the overlay the caller saw; Save always writes one draft. */
      operation: "save";
      confirmed_stale?: readonly (WorkTarget & {
        current_version: string;
        gone?: "record_gone" | "field_archived";
      })[];
    });
/**
 * Mutations answer with the new revision and only what they touched; only get
 * returns the session. `entries` are touched entries as they now stand,
 * `removed` the touched targets that no longer hold an entry.
 */
export type WorkTouched = { revision: number; entries: WorkChange[]; removed: WorkTarget[] };
export type WorkRuleOverlap = { rule_id: string; records: number };
/** One page of entries; `next` is the key to continue after, when `has_more`. */
export type WorkEntriesPage = {
  revision: number;
  entries: WorkChange[];
  has_more: boolean;
  next: WorkTarget | null;
};
export type WorkSessionResult<R extends WorkSessionRequest> = R extends { operation: "list" }
  ? Omit<WorkSession, "overlay" | "rules" | "threads">[]
  : R extends { operation: "get" }
    ? WorkGetResult<R>
    : R extends { operation: "entries" }
      ? WorkEntriesPage
      : WorkMutationResult<R>;
/**
 * `overlay: false` omits the overlay; a request whose `overlay` may be false
 * (a non-literal boolean) gets either shape.
 */
type WorkGetResult<R> = R extends { overlay: false }
  ? Omit<WorkSession, "overlay">
  : "overlay" extends keyof R
    ? false extends R["overlay" & keyof R]
      ? WorkSession | Omit<WorkSession, "overlay">
      : WorkSession
    : WorkSession;
type WorkMutationResult<R extends WorkSessionRequest> = R extends {
  operation: "create" | "duplicate";
}
  ? { revision: number; session_id: string }
  : R extends {
        operation: "stage" | "unstage" | "pull" | "discard_source" | "discard_turn" | "rule_remove";
      }
    ? WorkTouched
    : R extends { operation: "rule_create" | "rule_parameters" }
      ? WorkTouched & {
          /** The rule as stored now; null when a replay follows its removal. */
          rule: (WorkRule & { author_principal: string; author_kind: "human" | "agent" }) | null;
          /** Records whose target field another rule already holds; that rule keeps them. */
          overlaps: WorkRuleOverlap[];
        }
      : R extends { operation: "thread_open" | "save_request" }
        ? { revision: number; thread: WorkJson }
        : R extends { operation: "presence" }
          ? { targets: number }
          : R extends { operation: "thread_reply" }
            ? { revision: number; message: WorkJson }
            : R extends { operation: "propose" }
              ? { revision: number; proposal: WorkJson }
              : R extends { operation: "save" }
                ? {
                    revision: number;
                    change_set: AppliedChangeSet | null;
                    cleared: true;
                  }
                : { revision: number };
export interface WorkSessionClient {
  request<const R extends WorkSessionRequest>(input: R): Promise<WorkSessionResult<R>>;
}

const workUuidSchema = z
  .unknown()
  .transform((value) => responseUuid("kernel_work_session", "response.id", value));
const workValueSchema = z
  .unknown()
  .transform((value) =>
    value === null ? null : responseFieldValue("kernel_work_session", "overlay.value", value),
  );
const changeSchema = z
  .object({
    model_id: z.string().min(1),
    record_id: workUuidSchema,
    field_id: z.string().min(1),
    value: workValueSchema,
    baseline: workValueSchema,
    base_version: workUuidSchema,
    source: z.enum(["user", "agent"]),
    actor_id: z.string().min(1),
    author_principal: z.string().min(1),
    author_kind: z.enum(["human", "agent"]),
    created_at: z.string(),
    updated_at: z.string(),
    current_value: workValueSchema.optional(),
    current_version: workUuidSchema.nullable().optional(),
    turn_id: workUuidSchema.optional(),
    replaced: z
      .object({
        value: workValueSchema,
        author_kind: z.enum(["human", "agent"]),
        actor_id: z.string(),
        author_principal: z.string().optional(),
      })
      .optional(),
    note: z.string().optional(),
    stale: z.boolean().optional(),
    gone: z.enum(["record_gone", "field_archived"]).nullable().optional(),
  })
  .passthrough();
const targetSchema = z
  .object({ model_id: z.string().min(1), record_id: workUuidSchema, field_id: z.string().min(1) })
  .passthrough();
const revisionSchema = z.number().int().nonnegative();
const touchedSchema = z
  .object({
    revision: revisionSchema,
    entries: z.array(changeSchema),
    removed: z.array(targetSchema),
  })
  .passthrough();
const sessionSchema = z
  .object({
    id: workUuidSchema,
    owner_id: z.string(),
    title: z.string(),
    as_of: z.string(),
    scope: z.unknown(),
    layout: z.unknown(),
    pinned: z.boolean(),
    status: z.string(),
    revision: z.number().int().nonnegative(),
    overlay: z.array(changeSchema),
    rules: z.record(z.string(), z.unknown()),
    threads: z.record(z.string(), z.unknown()),
  })
  .passthrough();

/** Whether a request is a last-write-wins edit (no revision, no request id). */
export function isWorkEdit(
  input: WorkSessionRequest,
): input is Extract<WorkSessionRequest, { operation: WorkEditOperation }> {
  return (workEditOperations as readonly string[]).includes(input.operation);
}

/** Capability the host authorizes for one request; get without the overlay is its own read. */
export function workSessionCapability(input: WorkSessionRequest): string {
  return input.operation === "get" && input.overlay === false
    ? "work_session.get_without_overlay"
    : `work_session.${input.operation}`;
}

/** Context binds tenant and actor. Request JSON cannot replace either authority. */
export function createWorkSessionClient(
  context: DataContext,
  schemaVersion: string,
): WorkSessionClient {
  return {
    async request<const R extends WorkSessionRequest>(input: R): Promise<WorkSessionResult<R>> {
      if (
        Object.hasOwn(input, "actor_id") ||
        Object.hasOwn(input, "app_id") ||
        Object.hasOwn(input, "customer_id") ||
        Object.hasOwn(input, "schema_version")
      )
        throw new Error("contract_validation_failed: work session scope is context-owned");
      if (isWorkEdit(input)) {
        if (Object.hasOwn(input, "expected_revision") || Object.hasOwn(input, "request_id"))
          throw new Error(
            "contract_validation_failed: edits are last-write-wins and take no revision or request id",
          );
      } else if (
        input.operation !== "get" &&
        input.operation !== "list" &&
        input.operation !== "entries" &&
        input.operation !== "presence" &&
        (!Number.isSafeInteger(input.expected_revision) ||
          input.expected_revision < 0 ||
          !input.request_id?.trim())
      )
        throw new Error(
          "contract_validation_failed: work session revision and request identity required",
        );
      await context.authorize(workSessionCapability(input));
      return context.transaction(async (db) => {
        const result = await db.call("kernel_work_session", {
          ...input,
          schema_version: schemaVersion,
        });
        // Callers receive the decoded response, never the raw kernel JSON.
        return decodeWorkResult(input, result) as WorkSessionResult<R>;
      });
    },
  };
}

/** A kernel work-session response decoded as callers receive it. */
export function decodeWorkResult(input: WorkSessionRequest, result: unknown): unknown {
  const operation = input.operation;
  if (operation === "list")
    return z.array(sessionSchema.omit({ overlay: true, rules: true, threads: true })).parse(result);
  if (operation === "get")
    return input.overlay === false
      ? sessionSchema.omit({ overlay: true }).parse(result)
      : sessionSchema.parse(result);
  if (operation === "entries")
    return z
      .object({
        revision: revisionSchema,
        entries: z.array(changeSchema),
        has_more: z.boolean(),
        next: targetSchema.nullable(),
      })
      .parse(result);
  if (operation === "save")
    return z
      .object({
        revision: revisionSchema,
        cleared: z.literal(true),
        change_set: z
          .unknown()
          .transform((value) =>
            value === null ? null : responseAppliedChangeSet(value, "kernel_work_session"),
          ),
      })
      .parse(result);
  if (operation === "create" || operation === "duplicate")
    return z.object({ revision: revisionSchema, session_id: workUuidSchema }).parse(result);
  if (operation === "rule_create" || operation === "rule_parameters")
    return touchedSchema
      .extend({
        rule: z.record(z.string(), z.unknown()).nullable(),
        overlaps: z.array(z.object({ rule_id: z.string(), records: z.number().int().positive() })),
      })
      .parse(result);
  if (
    operation === "stage" ||
    operation === "unstage" ||
    operation === "pull" ||
    operation === "discard_source" ||
    operation === "discard_turn" ||
    operation === "rule_remove"
  )
    return touchedSchema.parse(result);
  if (operation === "presence")
    return z.object({ targets: z.number().int().nonnegative() }).parse(result);
  if (operation === "thread_open" || operation === "save_request")
    return z
      .object({ revision: revisionSchema, thread: z.record(z.string(), z.unknown()).nullable() })
      .parse(result);
  if (operation === "thread_reply")
    return z
      .object({ revision: revisionSchema, message: z.record(z.string(), z.unknown()).nullable() })
      .parse(result);
  if (operation === "propose")
    return z
      .object({ revision: revisionSchema, proposal: z.record(z.string(), z.unknown()).nullable() })
      .parse(result);
  return z.object({ revision: revisionSchema }).passthrough().parse(result);
}
