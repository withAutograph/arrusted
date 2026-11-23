import { createHash } from "node:crypto";
import {
  createDataClient,
  type CreateValues,
  type DataContext,
  type DataDefinition,
  type DataModel,
  type DataWrite,
} from "../generated-app-runtime/data";
import {
  applySourceWrites,
  replaySourceWrites,
  type SourceWriteProvenance,
} from "../generated-app-runtime/source";
type IntegrationWriteProvenance = SourceWriteProvenance & {
  binding_id: string;
  binding_revision: number;
  connection_id: string;
};
import type { AppliedChangeSet } from "../contracts";

/** Bounded ingress failures; transport/provider/database failures retain retry semantics. */
export class IntegrationIngressError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 403 | 409,
  ) {
    super(code);
    this.name = "IntegrationIngressError";
  }
}
export type IntegrationNoop = Readonly<{ kind: "noop"; reason: "no_eligible_records" }>;
export type IntegrationIngestionResult = AppliedChangeSet | IntegrationNoop;

/** Verified by the host against its exact current app binding, never by a recipe. */
export type IntegrationIdentity = Readonly<{
  appId: string;
  customerId: string;
  bindingId: string;
  connectionId: string;
  routingId: string;
  /** A message/chunk/event identity, not a shared operation ID for split deliveries. */
  deliveryId: string;
}>;
export type ActiveIntegrationBinding = Readonly<
  Omit<IntegrationIdentity, "deliveryId"> & {
    lifecycle: "active";
    bindingRevision: number;
    actorId: string;
  }
>;
export type IntegrationEnvelope = Readonly<{
  identity: IntegrationIdentity;
  object: string;
}>;
export type IntegrationSourceReference<I extends string = string> = Readonly<{
  kind: "integration_source";
  model: I;
  sourceRef: string;
}>;
/** App-owned source identity; this is resolved only by the fixed SQL primitive. */
export function integrationSource<I extends string>(
  model: I,
  sourceRef: string,
): IntegrationSourceReference<I> {
  nonempty(model);
  nonempty(sourceRef);
  return Object.freeze({ kind: "integration_source", model, sourceRef });
}
type Model<D extends DataDefinition, I extends string> = Extract<D["models"][number], { id: I }>;
type Writable<M extends DataModel> = Exclude<
  M["fields"][number],
  { readOnly: true } | { lifecycle: "retired" }
>;
type Values<D extends DataDefinition, M extends DataModel> = {
  [F in Writable<M> as F["name"]]?: F["type"] extends "relation"
    ? IntegrationSourceReference<Extract<F["target_model"], string>>
    : F["name"] extends keyof CreateValues<D, M>
      ? CreateValues<D, M>[F["name"]]
      : never;
};
export type IntegrationProjection<D extends DataDefinition, I extends string, R, E> = {
  object: string | readonly string[];
  fields: readonly Writable<Model<D, I>>["name"][];
  matching: "create_only" | "source_reference";
  clearing: "reject" | "preserve" | "clear";
  filterRecord?(record: R, envelope: E): boolean;
  effectiveStart?(record: R, envelope: E): string;
  sourceReference(record: R, envelope: E): string;
  normalize(
    record: R,
    envelope: E,
    binding: ActiveIntegrationBinding,
    delivery: { payloadHash: string; deliveryRef: string },
  ): Values<D, Model<D, I>>;
};
export type IntegrationRecipe<D extends DataDefinition, R, E extends IntegrationEnvelope> = {
  id: string;
  version: string;
  /** App-owned provider/installation namespacing can retain existing provenance at cutover. */
  sourceIdentity?: "scoped" | "app_owned";
  effectiveStart(envelope: E): string;
  projections: { [I in D["models"][number]["id"]]?: IntegrationProjection<D, I, R, E> };
};
export function defineIntegrationRecipe<D extends DataDefinition, R, E extends IntegrationEnvelope>(
  definition: D,
  recipe: IntegrationRecipe<D, R, E>,
): Readonly<{ definition: D; recipe: IntegrationRecipe<D, R, E> }> {
  const modelsById = new Map(definition.models.map((model) => [model.id, model]));
  nonempty(recipe.id);
  nonempty(recipe.version);
  if (
    recipe.sourceIdentity !== undefined &&
    !["scoped", "app_owned"].includes(recipe.sourceIdentity)
  )
    fail("invalid_source_identity");
  for (const [modelId, projection] of Object.entries(recipe.projections)) {
    if (!projection) continue;
    const model = modelsById.get(modelId);
    if (!model || model.kind === "lookup") fail("unsupported_model");
    const candidate = projection as IntegrationProjection<DataDefinition, string, R, E>;
    const selectedFields = new Set(candidate.fields);
    const fieldsByName = new Map(model.fields.map((field) => [field.name, field]));
    for (const object of typeof candidate.object === "string"
      ? [candidate.object]
      : candidate.object)
      nonempty(object);
    if (
      !["create_only", "source_reference"].includes(candidate.matching) ||
      !["reject", "preserve", "clear"].includes(candidate.clearing)
    )
      fail("invalid_policy");
    if (candidate.fields.length === 0 || new Set(candidate.fields).size !== candidate.fields.length)
      fail("invalid_fields");
    if (
      model.fields.some(
        (field) =>
          field.required &&
          !field.readOnly &&
          field.lifecycle !== "retired" &&
          !selectedFields.has(field.name),
      )
    )
      fail("required_field_mapping_missing");
    for (const name of candidate.fields) {
      const field = fieldsByName.get(name);
      if (!field || field.readOnly || field.lifecycle === "retired") fail("invalid_fields");
      // Custom relations and relation lists need a separately designed source
      // resolution projection. Reject them instead of fabricating UUID subjects.
      if (field.type === "relation_list" || field.storage === "custom")
        fail("unsupported_relation");
    }
  }
  return Object.freeze({ definition, recipe });
}

export type IntegrationIngress<
  D extends DataDefinition,
  R,
  E extends IntegrationEnvelope,
  RequestContext,
> = {
  projection: ReturnType<typeof defineIntegrationRecipe<D, R, E>>;
  /** Must authenticate these exact bytes before any parsing or provider access. */
  verifySignature(rawBody: Uint8Array, request: RequestContext): Promise<void>;
  parseEnvelope(rawBody: Uint8Array): E;
  /** Provider readback and current app/tenant/service authority, before the draining write lease. */
  verifyBinding(identity: IntegrationIdentity, envelope: E): Promise<ActiveIntegrationBinding>;
  /** Optional provider-specific URL payload retrieval, after authority verification. */
  readPayload?(envelope: E, binding: ActiveIntegrationBinding): Promise<Uint8Array>;
  parseRecords(payload: Uint8Array, envelope: E): readonly R[];
  /** Central shared connection/binding locks must remain held until run commits. No provider calls occur inside this lease. */
  withBindingLease<T>(
    identity: IntegrationIdentity,
    run: (binding: ActiveIntegrationBinding) => Promise<T>,
  ): Promise<T>;
  createDataContext(binding: ActiveIntegrationBinding): DataContext;
};

/** Server-only ingress. It retains neither envelopes, raw bytes nor provider secrets. */
export function createIntegrationIngress<
  D extends DataDefinition,
  R,
  E extends IntegrationEnvelope,
  RequestContext,
>(
  host: IntegrationIngress<D, R, E, RequestContext>,
): (rawBody: Uint8Array, request: RequestContext) => Promise<IntegrationIngestionResult> {
  const { definition, recipe } = host.projection;
  const modelsById = new Map(definition.models.map((model) => [model.id, model]));
  return async (rawBody, request) => {
    // Own the bytes so an asynchronously mutating caller cannot change what was verified.
    const raw = Uint8Array.from(rawBody);
    if (raw.byteLength === 0 || raw.byteLength > 1048576) fail("invalid_envelope");
    await host.verifySignature(raw, request);
    const envelope = parseInput(() => host.parseEnvelope(raw), "invalid_envelope");
    assertIdentity(envelope.identity);
    const identity = Object.freeze({ ...envelope.identity });
    const binding = Object.freeze({ ...(await host.verifyBinding(identity, envelope)) });
    assertBinding(identity, binding);
    const suppliedContext = host.createDataContext(binding);
    const context: DataContext = {
      ...suppliedContext,
      transaction: (run) =>
        suppliedContext.transaction(async (session) => {
          if (session.actorId !== binding.actorId || session.sourceKind !== "integration")
            fail("context_actor_mismatch");
          return run(session);
        }),
    };
    if (context.scope.appId !== binding.appId || context.scope.customerId !== binding.customerId)
      fail("context_scope_mismatch");
    const deliveryKey = hash([
      binding.appId,
      binding.customerId,
      binding.bindingId,
      binding.connectionId,
      recipe.id,
      identity.deliveryId,
    ]);
    const sourceRef = `integration:${deliveryKey}`;
    const inputHash = hashBytes(raw);
    const replay = await host.withBindingLease(identity, async (leasedBinding) => {
      assertSameBinding(binding, leasedBinding);
      return replaySourceWrites(definition, context, {
        sourceRef,
        idempotencyKey: sourceRef,
        inputHash,
      });
    });
    if (replay !== null) return replay;
    const payload = host.readPayload
      ? Uint8Array.from(await host.readPayload(envelope, binding))
      : raw;
    if (payload.byteLength === 0 || payload.byteLength > 1048576) fail("invalid_payload");
    const records = parseInput(() => host.parseRecords(payload, envelope), "invalid_records");
    if (!Array.isArray(records) || records.length > 100) fail("invalid_records");
    const effectiveStart = parseInput(
      () => recipe.effectiveStart(envelope),
      "invalid_effective_date",
    );
    const client = createDataClient(definition, context);
    const writes: DataWrite[] = [];
    const effectiveStarts: string[] = [];
    let selectedObject = false;
    const provenance: IntegrationWriteProvenance[] = [];
    const payloadHash = hashBytes(payload);
    for (const [modelId, entry] of Object.entries(recipe.projections)) {
      const projection = entry as IntegrationProjection<DataDefinition, string, R, E> | undefined;
      if (
        !projection ||
        !(typeof projection.object === "string" ? [projection.object] : projection.object).includes(
          envelope.object,
        )
      )
        continue;
      selectedObject = true;
      const model = modelsById.get(modelId);
      if (!model) fail("unsupported_model");
      const fieldsByName = new Map(model.fields.map((field) => [field.name, field]));
      const selectedFields = new Set(projection.fields);
      const builder = (
        client as unknown as Record<
          string,
          {
            writes: { create(values: Record<string, unknown>, options: { id: string }): DataWrite };
          }
        >
      )[model.name]!;
      const mapped = projection.fields.map((name) => {
        const field = fieldsByName.get(name);
        if (!field) fail("invalid_fields");
        return field.id;
      });
      for (const record of records) {
        if (
          projection.filterRecord &&
          !parseInput(() => projection.filterRecord!(record, envelope), "invalid_record_filter")
        )
          continue;
        effectiveStarts.push(
          parseInput(
            () => projection.effectiveStart?.(record, envelope) ?? effectiveStart,
            "invalid_effective_date",
          ),
        );
        const recordRef = scopedSource(
          binding,
          recipe.id,
          modelId,
          parseInput(
            () => projection.sourceReference(record, envelope),
            "invalid_source_reference",
          ),
          recipe.sourceIdentity,
        );
        const values = parseInput(
          () =>
            projection.normalize(record, envelope, binding, {
              payloadHash,
              deliveryRef: sourceRef,
            }),
          "invalid_normalization",
        );
        if (!values || typeof values !== "object" || Array.isArray(values)) fail("invalid_values");
        const normalized: Record<string, unknown> = {};
        const relations: Record<string, { model_id: string; source_record_ref: string }> = {};
        for (const [name, value] of Object.entries(values)) {
          if (!selectedFields.has(name) || value === undefined) fail("unmapped_field");
          const field = fieldsByName.get(name);
          if (!field) fail("invalid_fields");
          if (field.type === "relation") {
            const ref = value as unknown as IntegrationSourceReference;
            if (!ref || ref.kind !== "integration_source" || ref.model !== field.target_model)
              fail("invalid_relation");
            relations[field.id] = {
              model_id: ref.model,
              source_record_ref: scopedSource(
                binding,
                recipe.id,
                ref.model,
                ref.sourceRef,
                recipe.sourceIdentity,
              ),
            };
            normalized[name] = {
              type: "record_id",
              value: stableUuid([recordRef, field.id, "unresolved"]),
            };
          } else normalized[name] = value;
        }
        writes.push(
          builder.writes.create(normalized, { id: stableUuid([sourceRef, modelId, recordRef]) }),
        );
        provenance.push({
          source_record_ref: recordRef,
          source_input_hash: inputHash,
          payload_hash: payloadHash,
          mapped_field_ids: mapped,
          match_policy: projection.matching,
          clear_policy: projection.clearing,
          recipe_id: recipe.id,
          recipe_version: recipe.version,
          binding_id: binding.bindingId,
          binding_revision: binding.bindingRevision,
          connection_id: binding.connectionId,
          ...(Object.keys(relations).length ? { relation_source_record_refs: relations } : {}),
        });
      }
    }
    if (!selectedObject || writes.length > 100) fail("unsupported_object");
    // Provider readback may perform HTTP. Finish it before acquiring the draining
    // write lease; that lease must freshly authorize the local binding and actor.
    assertSameBinding(binding, await host.verifyBinding(identity, envelope));
    if (writes.length === 0) {
      // No receipt is invented. Authentication and the current binding still
      // hold when an app-owned eligibility filter accepts no provider rows.
      return host.withBindingLease(identity, async (leasedBinding) => {
        assertSameBinding(binding, leasedBinding);
        return { kind: "noop", reason: "no_eligible_records" };
      });
    }
    return host.withBindingLease(identity, async (leasedBinding) => {
      assertSameBinding(binding, leasedBinding);
      return applySourceWrites(
        definition,
        {
          ...context,
          transaction: (run) =>
            context.transaction(async (session) => {
              if (session.actorId !== binding.actorId || session.sourceKind !== "integration")
                fail("context_actor_mismatch");
              return run(session);
            }),
        },
        {
          effectiveStart,
          idempotencyKey: sourceRef,
          sourceRef,
          writes,
          effectiveStarts,
          provenance,
        },
      );
    });
  };
}

function assertIdentity(identity: IntegrationIdentity): void {
  if (!identity || typeof identity !== "object") fail("invalid_identity");
  for (const name of [
    "appId",
    "customerId",
    "bindingId",
    "connectionId",
    "routingId",
    "deliveryId",
  ] as const)
    nonempty(identity[name]);
}
function assertBinding(identity: IntegrationIdentity, binding: ActiveIntegrationBinding): void {
  if (
    binding.lifecycle !== "active" ||
    !Number.isSafeInteger(binding.bindingRevision) ||
    binding.bindingRevision < 1
  )
    fail("inactive_binding");
  for (const name of ["appId", "customerId", "bindingId", "connectionId", "routingId"] as const)
    if (identity[name] !== binding[name]) fail("binding_scope_mismatch");
  nonempty(binding.actorId);
}
function assertSameBinding(
  expected: ActiveIntegrationBinding,
  actual: ActiveIntegrationBinding,
): void {
  assertBinding({ ...expected, deliveryId: "lease" }, actual);
  if (actual.bindingRevision !== expected.bindingRevision || actual.actorId !== expected.actorId)
    fail("binding_revision_changed");
}
function scopedSource(
  binding: ActiveIntegrationBinding,
  recipeId: string,
  model: string,
  source: string,
  policy: "scoped" | "app_owned" = "scoped",
): string {
  nonempty(source);
  if (policy === "app_owned") {
    if (source.length > 256) fail("source_reference_too_long");
    return source;
  }
  return `integration:${hash([binding.appId, binding.customerId, binding.connectionId, recipeId, model, source])}`;
}
function stableUuid(parts: unknown): string {
  const hex = hash(parts);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function hash(value: unknown): string {
  return hashBytes(Buffer.from(JSON.stringify(value)));
}
function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
function nonempty(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 1024) fail("invalid_identity");
}
function parseInput<T>(parse: () => T, code: string): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof IntegrationIngressError) throw error;
    fail(code);
  }
}
function fail(code: string): never {
  const status =
    code === "binding_revision_changed"
      ? 409
      : [
            "inactive_binding",
            "binding_scope_mismatch",
            "context_scope_mismatch",
            "context_actor_mismatch",
          ].includes(code)
        ? 403
        : 400;
  throw new IntegrationIngressError(`integration_${code}`, status);
}
