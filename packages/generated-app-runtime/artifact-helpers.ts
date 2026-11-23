import type { WorkSessionRequest } from "./work-sessions";
export type { WorkSessionRequest, WorkSessionResult } from "./work-sessions";
/** Transport-neutral helpers for a checked, immutable application artifact. */
import type {
  FieldValue,
  MoneyRatePeriod,
  MoneyRateValue,
  RuntimeFieldId,
  RuntimeModelId,
} from "../contracts";
declare const recordIdBrand: unique symbol;
declare const revisionIdBrand: unique symbol;

export type RuntimeRecordId = string & { readonly [recordIdBrand]: true };
export type RuntimeSchemaRevisionId = string & { readonly [revisionIdBrand]: true };
export type { RuntimeFieldId, RuntimeModelId };
export type KernelError = {
  code: string;
  message: string;
  details: readonly { path: string; code: string; message: string }[];
};
export type KernelResult<T> = { ok: true; data: T } | { ok: false; error: KernelError };

type ArtifactIds = {
  models: readonly string[];
  fields: Record<string, readonly string[]>;
  enumOptions: Record<string, readonly string[]>;
  changeTypes: readonly string[];
  constraints: readonly string[];
};
type Artifact = {
  appId: string;
  schemaVersion: string;
  staticIds: ArtifactIds;
  models: readonly { id: string; fields: readonly { id: string; type: string }[] }[];
};
type ModelId<D extends Artifact> = D["staticIds"]["models"][number];
type FieldId<D extends Artifact, M extends ModelId<D>> = D["staticIds"]["fields"][M][number];

/** A request is data only. Database role checks and validation remain authoritative. */
type BoundedMetrics<T> =
  | readonly [T]
  | readonly [T, T]
  | readonly [T, T, T]
  | readonly [T, T, T, T]
  | readonly [T, T, T, T, T]
  | readonly [T, T, T, T, T, T]
  | readonly [T, T, T, T, T, T, T]
  | readonly [T, T, T, T, T, T, T, T];
type QueryMetric<F extends string> =
  | { fn: "count" }
  | { fn: "count_distinct" | "sum" | "avg" | "min" | "max" | "median"; field: F }
  | { fn: "percentile"; field: F; p: number };
type QueryGroup<F extends string, N extends string, Money extends string> =
  | F
  | { field: N; bins: { edges: readonly string[] }; unit?: never }
  | {
      field: Money;
      bins: { edges: readonly string[] };
      unit: { currency: string; period: MoneyRatePeriod };
    };
type TypedFieldId<D extends Artifact, M extends ModelId<D>, T extends string> = Extract<
  Extract<D["models"][number], { id: M }>["fields"][number],
  { type: T }
>["id"];
export type DataQueryRequest<M extends string, F extends string, N extends F, Money extends F> = {
  model_id: M;
  customer_id: string;
  as_of: string;
  work?: { session_id: string };
  /** Overlay every pending draft's field changes on mainline, under `work`. */
  include_pending_drafts?: boolean;
} & (
  | {
      kind: "list";
      select?: readonly (F | "id" | "external_key" | "$version")[];
      limit?: number;
      offset?: number;
      group_by?: never;
      metrics?: never;
    }
  | {
      kind: "aggregate";
      select?: never;
      limit?: never;
      offset?: never;
      group_by?:
        | readonly []
        | readonly [QueryGroup<F, N, Money>]
        | readonly [QueryGroup<F, N, Money>, QueryGroup<F, N, Money>];
      metrics: BoundedMetrics<QueryMetric<F>>;
    }
);
export type TenantSchemaRequest = {
  customer_id: string;
  actor_id: string;
  reason: string;
  idempotency_key: string;
  expected_revision_id: RuntimeSchemaRevisionId;
  expected_effective_hash: string;
  operations: readonly Record<string, unknown>[];
};

export function createArtifactHelpers<const D extends Artifact>(definition: D) {
  return {
    ids: definition.staticIds,
    recordId(value: string): RuntimeRecordId {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
        throw new TypeError("record ID must be a UUID");
      return value as RuntimeRecordId;
    },
    runtimeModelId(value: string): RuntimeModelId {
      if (!value.trim()) throw new TypeError("runtime model ID must be nonempty");
      return value as RuntimeModelId;
    },
    runtimeFieldId(value: string): RuntimeFieldId {
      if (!value.trim()) throw new TypeError("runtime field ID must be nonempty");
      return value as RuntimeFieldId;
    },
    schemaRevisionId(value: string): RuntimeSchemaRevisionId {
      if (!/^[1-9][0-9]*$/.test(value))
        throw new TypeError("schema revision ID must be a positive decimal integer");
      return value as RuntimeSchemaRevisionId;
    },
    value: {
      text: (value: string) => ({ type: "text" as const, value }),
      number: (value: string) => ({ type: "number" as const, value }),
      boolean: (value: boolean) => ({ type: "bool" as const, value }),
      date: (value: string) => ({ type: "date" as const, value }),
      datetime: (value: string) => ({ type: "datetime" as const, value }),
      isoCountry: (value: string) => ({ type: "iso_country" as const, value }),
      isoCurrency: (value: string) => ({ type: "iso_currency" as const, value }),
      textList: (value: string[]) => ({ type: "text_list" as const, value }),
      json: (value: unknown) => ({ type: "json" as const, value }),
      moneyRate: (value: MoneyRateValue) => ({ type: "money_rate" as const, value }),
      record: (value: RuntimeRecordId) => ({ type: "record_id" as const, value }),
      relation: (value: RuntimeRecordId) => ({
        type: "relation" as const,
        value: { type: "record_id" as const, value },
      }),
      relationList: (value: RuntimeRecordId[]) => ({
        type: "relation_list" as const,
        value: value.map((id) => ({ type: "record_id" as const, value: id })),
      }),
      enum<const M extends ModelId<D>, const F extends FieldId<D, M>>(
        model: M,
        field: F,
        value: string,
      ) {
        const options = definition.staticIds.enumOptions[`${model}.${field}`];
        if (!options || !options.includes(value))
          throw new TypeError(`unknown enum option: ${model}.${field}.${value}`);
        return { type: "enum" as const, value };
      },
    },
    runtimeValue(model_id: RuntimeModelId, field_id: RuntimeFieldId, value: FieldValue) {
      return { model_id, field_id, value };
    },
    dataQuery<const M extends ModelId<D>>(
      request: DataQueryRequest<
        M,
        FieldId<D, M>,
        TypedFieldId<D, M, "number"> & FieldId<D, M>,
        TypedFieldId<D, M, "money_rate"> & FieldId<D, M>
      >,
    ) {
      return { ...request, app_id: definition.appId, schema_version: definition.schemaVersion };
    },
    workSession<R extends WorkSessionRequest>(request: R & { customer_id: string }) {
      return {
        function: "kernel_work_session" as const,
        request: { ...request, app_id: definition.appId, schema_version: definition.schemaVersion },
      };
    },
    schemaAdmin: {
      dryRunTenantSchemaRevision(request: TenantSchemaRequest) {
        return {
          function: "kernel_dry_run_tenant_schema_revision" as const,
          request: { ...request, app_id: definition.appId },
        };
      },
      commitTenantSchemaRevision(request: TenantSchemaRequest) {
        return {
          function: "kernel_commit_tenant_schema_revision" as const,
          request: { ...request, app_id: definition.appId },
        };
      },
    },
  };
}
