import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Pool } from "pg";
import { ResilientPool } from "./pool";
import { kernelCall, KernelFailure } from "../kernel-client/postgres";
import { setTimeout as delay } from "node:timers/promises";
import type { DataContext, DataSession } from "./data";

const digest = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/u)
  .refine((value) => Buffer.from(value, "base64url").toString("base64url") === value);
const principalRequestTarget = z
  .string()
  .min(1)
  .refine((value) => {
    if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return false;
    const url = new URL(value, "https://platform.invalid");
    const pathname = url.pathname === "/" ? "/" : url.pathname.replace(/\/+$/u, "");
    return (
      url.origin === "https://platform.invalid" &&
      url.hash === "" &&
      value === `${pathname}${url.search}`
    );
  });
const protectedHttpRequestSchema = z
  .strictObject({
    audience: z.string().min(1),
    bodySha256: digest.optional(),
    expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    issuer: z.string().min(1),
    jti: z
      .string()
      .min(1)
      .refine((value) => value.trim().length > 0),
    method: z.string().regex(/^[A-Z]+$/u),
    payloadSha256: digest.optional(),
    target: principalRequestTarget,
  })
  .readonly();
export type ProtectedHttpRequest = z.infer<typeof protectedHttpRequestSchema>;
export type PostgresDataContext = DataContext & {
  /** One verified Server Action may perform multiple generated operations in this DB transaction. */
  requestTransaction<T>(run: () => Promise<T>): Promise<T>;
};
export type PostgresDataContextInput = {
  /** null binds explicit app admission, never a synthetic business role. */
  actorBinding?: { role: string | null; fenceGeneration: number };
  actorId: string;
  /**
   * The platform agent context: every transaction is marked as agent work for
   * one turn (`kernel.actor_kind`, `kernel.turn_id`). The kernel then treats the
   * caller as an agent and refuses canonical writes; work-session calls rely on
   * session revisions and request IDs, so no protected request is passed.
   */
  agent?: { turnId: string };
  appId: string;
  authorize: DataContext["authorize"];
  customerId: string;
  pool: Pool;
  protectedHttpRequest?: ProtectedHttpRequest;
  /** Closed read entrypoint surface; preserves the kernel actor-binding SHARE locks. */
  readOnly?: boolean;
  sourceKind: string;
  verifyRelease: () => void;
};
const httpMutations = new Set([
  "kernel_apply_change_set",
  "kernel_apply_change_set_in_transaction",
  "kernel_update_draft_notes",
  "kernel_discard_draft_change_set",
  "kernel_approve_draft_change_set",
  "kernel_revert_change_set",
  "kernel_lookup_set_availability",
  "kernel_lookup_transfer_alias",
  "kernel_record_agent_run",
  "kernel_update_agent_run_status",
]);

const readOperations = new Set([
  "kernel_list_draft_change_sets",
  "kernel_read_draft_change_set",
  "kernel_read_active_schema_revision",
  "kernel_read_runtime_release_observability",
  "kernel_read_actor_binding",
  "kernel_read_actor_access",
  "kernel_read_visible_records",
  "kernel_read_visible_record",
  "kernel_read_visible_records_by_text_fields",
  "kernel_read_visible_records_by_model",
  "kernel_data_query",
  "kernel_query_visible_sql",
  "kernel_prepare_visible_query",
  "kernel_change_set_diff",
  "kernel_field_history",
  "kernel_recent_activity",
  "kernel_lookup_list",
  "kernel_lookup_resolve_batch",
  "kernel_lookup_hydrate",
  "kernel_lookup_reference_count",
  "kernel_schema_revision_is_active_with_materialized_tables",
]);

/** Verified host context is bound on one connection for the entire operation. */
export function createPostgresDataContext(input: PostgresDataContextInput): PostgresDataContext {
  const { pool, appId, customerId, actorId, sourceKind, authorize, verifyRelease } = input;
  const readOnly = input.readOnly === true;
  const actorBinding =
    input.actorBinding === undefined
      ? undefined
      : Object.freeze({
          fenceGeneration: input.actorBinding.fenceGeneration,
          role: input.actorBinding.role,
        });
  const protectedHttpRequest =
    input.protectedHttpRequest === undefined
      ? undefined
      : protectedHttpRequestSchema.parse(input.protectedHttpRequest);
  const agentTurn = input.agent?.turnId;
  if (input.agent !== undefined) {
    if (protectedHttpRequest !== undefined)
      throw new Error("The agent context never carries a protected request");
    if (
      typeof agentTurn !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(agentTurn)
    )
      throw new Error("The agent turn must be a lowercase UUID");
  }
  if (protectedHttpRequest !== undefined && protectedHttpRequest.audience !== appId) {
    throw new Error("Protected request audience does not match the app scope");
  }
  const activeTransaction = new AsyncLocalStorage<DataSession>();
  let recordSequence = 0;
  const admission = async (operation: string, payload: Record<string, unknown>) => {
    // Admission survives business rollback; use a separate runtime-only connection,
    // including when the host's business pool has only one connection.
    const admissionPool = new ResilientPool({ ...pool.options, max: 1 });
    try {
      await kernelCall(admissionPool, operation, {
        ...payload,
        app_id: appId,
        customer_id: customerId,
        actor_id: actorId,
        role: actorBinding?.role,
        fence_generation: actorBinding?.fenceGeneration,
        http_request: protectedHttpRequest,
      });
    } finally {
      await admissionPool.end();
    }
  };
  const context: PostgresDataContext = {
    scope: Object.freeze({ appId, customerId }),
    authorize,
    createRecordId: () => {
      if (protectedHttpRequest?.payloadSha256 === undefined) return randomUUID();
      const bytes = createHash("sha256")
        .update(
          JSON.stringify([
            appId,
            customerId,
            actorId,
            actorBinding,
            protectedHttpRequest,
            recordSequence++,
          ]),
        )
        .digest();
      bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
      bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
      const hex = bytes.subarray(0, 16).toString("hex");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    },
    requestTransaction: (run) => context.transaction(async () => await run()),
    async transaction(run) {
      const existingSession = activeTransaction.getStore();
      if (existingSession !== undefined) return await run(existingSession);
      if (protectedHttpRequest?.payloadSha256 !== undefined)
        await admission("kernel_admit_http_request", {});
      // Only an aborted PostgreSQL serialization transaction is replayed. The
      // callback performs kernel database operations; outward effects belong
      // after this transaction. Keep the same request/idempotency key on retry.
      const startingRecordSequence = recordSequence;
      const execute = async (attempt: number): Promise<Awaited<ReturnType<typeof run>>> => {
        recordSequence = startingRecordSequence;
        verifyRelease();
        const connection = await pool.connect();
        let released = false;
        try {
          await connection.query("begin");
          await connection.query(
            "select set_config('kernel.app_id',$1,true),set_config('kernel.customer_id',$2,true),set_config('kernel.actor_id',$3,true),set_config('kernel.actor_role','',true),set_config('kernel.actor_fence_generation','',true),set_config('statement_timeout','10000',true),set_config('lock_timeout','5000',true)",
            [appId, customerId, actorId],
          );
          if (actorBinding) {
            if (
              (actorBinding.role !== null && !actorBinding.role) ||
              !Number.isSafeInteger(actorBinding.fenceGeneration) ||
              actorBinding.fenceGeneration <= 0
            )
              throw new Error("A current protected actor binding is required");
            await connection.query(
              "select set_config('kernel.actor_role',$1,true),set_config('kernel.actor_fence_generation',$2,true)",
              [actorBinding.role ?? "", String(actorBinding.fenceGeneration)],
            );
          }
          await connection.query(
            "select set_config('kernel.http_jti',$1,true),set_config('kernel.http_descriptor',$2,true),set_config('kernel.http_sequence','0',true),set_config('platform.caller_owned_transaction','true',true),set_config('kernel.actor_kind',$3,true),set_config('kernel.turn_id',$4,true)",
            [
              protectedHttpRequest?.jti ?? "",
              protectedHttpRequest === undefined ? "" : JSON.stringify(protectedHttpRequest),
              agentTurn === undefined ? "" : "agent",
              agentTurn ?? "",
            ],
          );
          let operationCount = 0;
          let mutationQueue: Promise<unknown> = Promise.resolve();
          let schemaActivationLock: Promise<void> | undefined;
          const session: DataSession = {
            actorId,
            sourceKind,
            lockSchemaActivation: () => {
              schemaActivationLock ??= connection
                .query(
                  "select pg_advisory_xact_lock_shared(hashtext('postgres-schema:' || current_schema() || ':materialize-tenant:' || $1 || ':' || $2 || ':schema-activation')::bigint)",
                  [appId, customerId],
                )
                .then(() => {});
              return schemaActivationLock;
            },
            call: async (operation, payload) => {
              // Work sessions and draft threads are one entrypoint each; reads
              // and mutations are told apart by `operation`.
              const workRead =
                (operation === "kernel_work_session" &&
                  ["get", "list", "entries"].includes(String(payload.operation))) ||
                (operation === "kernel_draft_threads" &&
                  ["get", "by_session"].includes(String(payload.operation)));
              const workMutation =
                (operation === "kernel_work_session" || operation === "kernel_draft_threads") &&
                !workRead;
              if (readOnly && !readOperations.has(operation) && !workRead)
                throw new Error("Read-only data context rejects this operation");
              if (payload.actor_id !== undefined && payload.actor_id !== actorId)
                throw new Error("Actor provenance does not match trusted context");
              if (payload.source_kind !== undefined && payload.source_kind !== sourceKind)
                throw new Error("Source provenance does not match trusted context");
              const request = {
                ...payload,
                app_id: appId,
                customer_id: customerId,
                ...(operation === "kernel_read_runtime_release_observability"
                  ? {}
                  : { actor_id: actorId }),
                ...(payload.source_kind !== undefined ? { source_kind: sourceKind } : {}),
              };
              if (
                (httpMutations.has(operation) || workMutation) &&
                protectedHttpRequest !== undefined
              ) {
                const sequence = ++operationCount;
                const mutation = mutationQueue.then(async () => {
                  await admission("kernel_admit_http_operation", {
                    operation,
                    payload: request,
                    sequence,
                  });
                  await connection.query("select set_config('kernel.http_sequence',$1,true)", [
                    String(sequence),
                  ]);
                  return await kernelCall(connection, operation, request);
                });
                mutationQueue = mutation;
                return await mutation;
              }
              return await kernelCall(connection, operation, request);
            },
          };
          const result = await activeTransaction.run(session, async () => await run(session));
          await mutationQueue;
          if (protectedHttpRequest !== undefined && operationCount > 0)
            await kernelCall(connection, "kernel_finish_http_request", {
              app_id: appId,
              customer_id: customerId,
              operation_count: operationCount,
            });
          await connection.query("commit");
          return result;
        } catch (error) {
          try {
            await connection.query("rollback");
          } catch {
            // Preserve the operation failure; discard a connection that could not roll back.
            connection.release(true);
            released = true;
          }
          if (!released && error instanceof Error && "code" in error && error.code === "40001") {
            connection.release();
            released = true;
            if (attempt < 3) {
              await delay(10 * (attempt + 1));
              return execute(attempt + 1);
            }
            throw new KernelFailure({
              code: "serialization_retry_required",
              message: "Concurrent changes require retrying the same request.",
            });
          }
          throw error;
        } finally {
          if (!released) connection.release();
        }
      };
      return execute(0);
    },
  };
  return context;
}

export async function withPostgresDataContext<T>(
  input: PostgresDataContextInput,
  run: (context: PostgresDataContext) => Promise<T>,
): Promise<T> {
  const context = createPostgresDataContext(input);
  return await context.requestTransaction(async () => await run(context));
}
