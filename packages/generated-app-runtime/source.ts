import { decodeAppliedChangeSet } from "./response-decoder";
import type { AppliedChangeSet, RowVersionWrite } from "../contracts";
import { createDataClient, type DataContext, type DataDefinition, type DataWrite } from "./data";

/** Only normalized, bounded app writes enter this server-side bridge. */
export type SourceWriteProvenance = {
  source_record_ref: string;
  source_input_hash?: string;
  payload_hash: string;
  mapped_field_ids: readonly string[];
  match_policy: "create_only" | "source_reference";
  clear_policy: "reject" | "preserve" | "clear";
  recipe_id?: string;
  recipe_version?: string;
  relation_source_record_refs?: Readonly<
    Record<string, { model_id: string; source_record_ref: string }>
  >;
};

/**
 * Reuse generated field/relation validation and capability authorization, then
 * enter the compiler-owned source-matching primitive on that same transaction.
 * Apps never submit their own canonical subjects or SQL for source writes.
 */
export async function applySourceWrites<D extends DataDefinition>(
  definition: D,
  context: DataContext,
  input: {
    effectiveStart: string;
    idempotencyKey: string;
    sourceRef: string;
    writes: readonly DataWrite[];
    provenance: readonly SourceWriteProvenance[];
    effectiveStarts?: readonly string[];
  },
): Promise<AppliedChangeSet> {
  if (input.writes.length !== input.provenance.length) throw new Error("Invalid source provenance");
  if (
    input.effectiveStarts &&
    (input.effectiveStarts.length !== input.writes.length ||
      input.effectiveStarts.some((value) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return true;
        const timestamp = Date.parse(`${value}T00:00:00.000Z`);
        return (
          !Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value
        );
      }))
  )
    throw new Error("Invalid source effective dates");
  const generated = createDataClient(definition, {
    ...context,
    transaction: (run) =>
      context.transaction(async (session) => {
        return run({
          ...session,
          call: async (operation, payload) => {
            if (operation !== "kernel_apply_change_set") return session.call(operation, payload);
            const writes = payload.writes as RowVersionWrite[];
            if (
              writes.some(
                (write) =>
                  write.record_key !== undefined || write.expected_version_id !== undefined,
              )
            )
              throw new Error("Source subjects must be resolved by the trusted apply path");
            const request = {
              ...payload,
              source_ref: input.sourceRef,
              writes: writes.map((write, index) => ({
                ...write,
                ...(input.effectiveStarts ? { effective_start: input.effectiveStarts[index] } : {}),
                provenance: input.provenance[index],
              })),
            };
            // The PostgreSQL context adds trusted scope before SQL evaluates its
            // JSONB-text bound. Include that scope and JSONB formatting overhead;
            // compact JSON bytes alone undercount the final ingestion envelope.
            if (
              sourceEnvelopeBytes({
                ...request,
                app_id: context.scope.appId,
                customer_id: context.scope.customerId,
                actor_id: session.actorId,
              }) > 1048576
            )
              throw new Error("Source payload exceeds 1 MiB after provenance and scope");
            const resolved = await session.call("kernel_resolve_source_identities", request);
            return session.call("kernel_apply_change_set", resolved as Record<string, unknown>);
          },
        });
      }),
  });
  return generated.apply({
    effectiveStart: input.effectiveStart,
    idempotencyKey: input.idempotencyKey,
    writes: input.writes,
  });
}

/** Conservative JSONB display-size estimate; SQL remains the authoritative bound. */
function sourceEnvelopeBytes(request: object): number {
  const serialized = JSON.stringify(request);
  let bytes = new TextEncoder().encode(serialized).length;
  const pending: unknown[] = [JSON.parse(serialized)];
  while (pending.length) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      bytes += Math.max(0, value.length - 1); // JSONB adds a space after each comma.
      for (const member of value) pending.push(member);
    } else if (value && typeof value === "object") {
      const members = Object.values(value);
      bytes += members.length + Math.max(0, members.length - 1); // Colons and commas.
      for (const member of members) pending.push(member);
    } else if (typeof value === "number") {
      // JSONB expands exponent notation. Reserve its decimal display width too.
      const token = JSON.stringify(value);
      const exponent = /^(?<sign>-?)(?<whole>\d+)(?:\.(?<fraction>\d+))?e(?<power>[+-]?\d+)$/u.exec(
        token,
      )?.groups;
      if (exponent) {
        const whole = exponent.whole!;
        const fraction = exponent.fraction ?? "";
        const digits = whole.length + fraction.length;
        const point = whole.length + Number(exponent.power);
        const expanded =
          exponent.sign!.length +
          (point <= 0 ? 2 - point + digits : point >= digits ? point : digits + 1);
        bytes += Math.max(0, expanded - token.length);
      }
    }
  }
  return bytes;
}

/** Resolve an exact authenticated source retry before retrieving transient data. */
export async function replaySourceWrites(
  definition: DataDefinition,
  context: DataContext,
  input: { sourceRef: string; idempotencyKey: string; inputHash: string },
): Promise<AppliedChangeSet | null> {
  return context.transaction(async (session) => {
    const resolved = (await session.call("kernel_resolve_source_identities", {
      actor_id: session.actorId,
      source_kind: session.sourceKind,
      mode: "mainline",
      source_ref: input.sourceRef,
      idempotency_key: input.idempotencyKey,
      source_input_hash: input.inputHash,
      replay_only: true,
    })) as Record<string, unknown> | null;
    if (resolved === null) return null;
    const writes = resolved.writes as RowVersionWrite[];
    const models = new Map(definition.models.map((model) => [model.id, model]));
    for (const write of writes) {
      const model = models.get(write.model_id);
      if (!model) throw new Error("Source replay model is unavailable");
      await context.authorize(
        `${model.name}.${write.tombstones_record ? "delete" : write.record_key ? "update" : "create"}`,
      );
    }
    return decodeAppliedChangeSet(await session.call("kernel_apply_change_set", resolved));
  });
}
