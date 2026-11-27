import {
  createWorkSessionClient,
  type WorkSessionClient,
  type WorkReference,
} from "./work-sessions";
export type * from "./work-sessions";
export {
  createWorkSessionClient,
  decodeWorkResult,
  isWorkEdit,
  workEditOperations,
} from "./work-sessions";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createResponseDecoder, responseFailure } from "./response-decoder";
import { KernelFailure } from "../kernel-client/postgres";
import type { FormError } from "./errors";
import type {
  AppliedChangeSet,
  FieldHistoryEntry,
  FieldValue,
  MoneyRatePeriod,
  MoneyRateValue,
  RecordKey,
  RowVersionWrite,
  VisibleRecord,
} from "../contracts";

/** The generated manifest is a projection of the normalized compiler contract. */
export type DataField = {
  id: string;
  name: string;
  type: string;
  is_unique?: boolean;
  storage?: string;
  required: boolean;
  readOnly: boolean;
  lifecycle?: "active" | "retired";
  option_set?: readonly { id: string; [key: string]: unknown }[];
  target_model?: string | null;
  [key: string]: unknown;
};
export type DataModel = {
  id: string;
  name: string;
  aliases?: readonly string[];
  /** The title column a lookup's records are named by; null for other models. */
  display_field_id?: string | null;
  fields: readonly DataField[];
  relations: readonly {
    id?: string;
    name: string;
    model: string;
    through: string;
  }[];
  [key: string]: unknown;
};
export type DataConstraint = {
  id: string;
  model: string;
  authority: "authoritative" | "advisory";
  referencedFieldIds?: readonly string[];
  [key: string]: unknown;
};
/** Machine-readable authorization behavior emitted only for policy-enabled definitions. */
export type DataAuthorization = {
  version: 1;
  membership: {
    required: true;
    identity: "exact_principal_app_customer_actor_role";
    roles: "current_active_memberships";
  };
  grants: {
    fieldEvaluation: "per_matching_record_predicate";
    recordPredicates: readonly ("all" | "actor_equals_field")[];
    history: "current_policy_all_or_error_temporal_images";
  };
  supported: readonly (
    | "create"
    | "get"
    | "list"
    | "update"
    | "delete"
    | "count"
    | "countBy"
    | "aggregate"
    | "history"
    | "relation_list"
    | "work_sessions"
  )[];
  unsupported: readonly (
    | "legacy_raw_sql"
    | "legacy_prepared_query"
    | "legacy_external_key_write_subjects"
    | "native_request_endpoints"
    | "draft_lifecycle"
    | "revert_lifecycle"
    | "lookup_lifecycle"
    | "lookup_hydration"
    | "lookup_reference_count"
    | "agent_run_endpoints"
  )[];
};
type OptionalTextPredecessorCompatibility = {
  kind: "optional-text-addition-v1";
  predecessors: readonly {
    schema: unknown;
    artifactSha256: string;
    field: { modelId: string; fieldId: string };
  }[];
};

export type DataDefinition = {
  formatVersion: 1;
  schemaVersion: string;
  models: readonly DataModel[];
  predecessorCompatibility?: OptionalTextPredecessorCompatibility;
  constraints?: readonly DataConstraint[];
  capabilities?: { versionPreconditions?: true; authorization?: true; workSessions?: true };
  authorization?: DataAuthorization;
  [key: string]: unknown;
};
declare const recordBrand: unique symbol;
declare const writeBrand: unique symbol;
type RecordIdentity<D extends DataDefinition, I extends string> = {
  readonly [recordBrand]: readonly [D, I];
};
type Model<D extends DataDefinition, I extends string> = Extract<D["models"][number], { id: I }>;
export type CanonicalRecordKey = Extract<RecordKey, { type: "record_id" | "external_key" }>;
type Value<F extends DataField> = F["type"] extends "bool"
  ? boolean
  : F["type"] extends "json"
    ? unknown
    : F["type"] extends "money_rate"
      ? MoneyRateValue
      : F["type"] extends "relation"
        ? CanonicalRecordKey
        : F["type"] extends "relation_list"
          ? CanonicalRecordKey[]
          : F["type"] extends "text_list" | "known_aliases"
            ? string[]
            : F["type"] extends "enum"
              ? F extends { option_set: readonly { id: infer E }[] }
                ? E
                : string
              : string;
type ReadValue<F extends DataField> =
  | Value<F>
  | (F extends { lifecycle: "retired" } ? null : F["required"] extends true ? never : null);
type Values<M extends DataModel> = {
  [F in M["fields"][number] as F["name"]]: ReadValue<F>;
};
type Versioned<D extends DataDefinition> = D extends {
  capabilities: { versionPreconditions: true };
}
  ? { readonly $version: string }
  : {};
/**
 * What of a record a read with `includePendingDrafts` shows from pending
 * drafts: the draft (change set id) that creates it, and per field name the
 * draft whose value shows. Absent when nothing came from a pending draft.
 */
export type PendingDraft = { created?: number; fields: Record<string, number> };
export type ModelRecord<D extends DataDefinition, I extends string> = Values<Model<D, I>> &
  Versioned<D> &
  RecordIdentity<D, I> & {
    id: string;
    externalKey: string | null;
    effectiveStart: string;
    effectiveEnd: string | null;
    customFields: VisibleRecord["custom_fields"];
    metadata: Exclude<VisibleRecord["metadata"], undefined>;
    manyRelations: Exclude<VisibleRecord["many_relations"], undefined>;
    pendingDraft?: PendingDraft;
  };
type Writable<M extends DataModel> = Exclude<
  M["fields"][number],
  { readOnly: true } | { lifecycle: "retired" }
>;
/** Schema-derived writable field vocabulary for one model's create inputs. */
export type ModelCreateField<D extends DataDefinition, I extends string> = Writable<
  Model<D, I>
>["name"];
/** Schema-derived writable field vocabulary for one model's update inputs. */
export type ModelUpdateField<D extends DataDefinition, I extends string> = Writable<
  Model<D, I>
>["name"];
type RelationInput<D extends DataDefinition, I extends string> =
  | CanonicalRecordKey
  | RecordIdentity<D, I>
  | CreateWrite<D, I>;
type WriteValue<D extends DataDefinition, F extends DataField> = F["type"] extends "relation"
  ? RelationInput<D, Extract<F["target_model"], string>>
  : F["type"] extends "relation_list"
    ? readonly RelationInput<D, Extract<F["target_model"], string>>[]
    : Value<F>;
export type CreateValues<D extends DataDefinition, M extends DataModel> = {
  [F in Writable<M> as F["required"] extends true ? F["name"] : never]: WriteValue<D, F>;
} & {
  [F in Writable<M> as F["required"] extends true ? never : F["name"]]?: WriteValue<D, F>;
};
export type UpdateValues<D extends DataDefinition, M extends DataModel> = {
  [F in Writable<M> as F["name"]]?: WriteValue<D, F>;
};
type Clearable<M extends DataModel> = Exclude<Writable<M>, { required: true }>["name"];
type FormFieldName<M extends DataModel> = Writable<M>["name"];
type FormField<M extends DataModel, Name extends string> = Extract<Writable<M>, { name: Name }>;
type FormValue<M extends DataModel, Name extends string> = Value<FormField<M, Name>>;
type FormCreateValues<M extends DataModel, Names extends string> = {
  [Name in Extract<Names, Extract<Writable<M>, { required: true }>["name"]>]: FormValue<M, Name>;
} & {
  [Name in Exclude<Names, Extract<Writable<M>, { required: true }>["name"]>]?: FormValue<M, Name>;
};
type FormUpdateValues<M extends DataModel, Names extends string> = {
  [Name in Names]?: FormValue<M, Name>;
};
type FormSelectedValues<
  M extends DataModel,
  F extends readonly FormFieldName<M>[],
  Mode extends "create" | "update",
> = Mode extends "create"
  ? FormCreateValues<M, Extract<F[number], string>>
  : FormUpdateValues<M, Extract<F[number], string>>;
type FormResult<
  M extends DataModel,
  F extends readonly FormFieldName<M>[],
  Mode extends "create" | "update",
> = number extends F["length"]
  ? Partial<FormSelectedValues<M, F, Mode>>
  : F extends readonly FormFieldName<M>[]
    ? HasUnionElement<F> extends true
      ? Partial<FormSelectedValues<M, F, Mode>>
      : FormSelectedValues<M, F, Mode>
    : never;
type FormInput<F extends readonly unknown[], Mode extends "create" | "update"> = {
  fields: F;
  mode: Mode;
} & (F extends readonly [] ? { fields: never } : unknown);
type ParsedForm<
  M extends DataModel,
  F extends readonly FormFieldName<M>[],
  Mode extends "create" | "update",
> = Mode extends "create"
  ? { values: FormResult<M, F, Mode>; clear: readonly [] }
  : {
      values: FormResult<M, F, Mode>;
      clear: readonly Extract<F[number], Clearable<M>>[];
    };
export type QueryInput<F extends string = string> = {
  work?: WorkReference;
  asOf: string;
  /**
   * Read as if every pending draft were approved, in save order (the latest
   * wins per field, and decides whether a record it creates or deletes
   * shows), under `work`'s staged values; each record says what came from a
   * pending draft (`pendingDraft`). Off by default.
   */
  includePendingDrafts?: boolean;
  search?: { query: string; fields: readonly F[] };
  where?: readonly {
    field: F | "id" | "externalKey";
    op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "contains" | "isNull";
    value?: string | boolean;
  }[];
  orderBy?: readonly {
    field: F | "id" | "externalKey";
    direction: "asc" | "desc";
  }[];
  limit?: number;
  offset?: number;
  select?: readonly F[];
};
type Filterable =
  | "text"
  | "number"
  | "bool"
  | "date"
  | "datetime"
  | "enum"
  | "iso_country"
  | "iso_currency"
  | "relation";
type Orderable = Exclude<Filterable, "relation">;
type Groupable = "text" | "enum" | "bool" | "date" | "iso_country" | "iso_currency";
type FieldNames<M extends DataModel, T extends string> = Extract<
  M["fields"][number],
  { type: T }
>["name"];
type GroupField<M extends DataModel> = Extract<M["fields"][number], { type: Groupable }>;
type GroupFieldName<M extends DataModel> = GroupField<M>["name"];
/** Distribute a selected group-field union before reading its schema value type. */
type GroupValue<M extends DataModel, G extends GroupFieldName<M>> =
  G extends GroupFieldName<M> ? ReadValue<Extract<GroupField<M>, { name: G }>> : never;
export type AggregateUnit = { currency: string; period: MoneyRatePeriod };
export type AggregateBinKey = { from: string; to: string } | "below" | "above";
type AggregateFieldName<M extends DataModel, T extends DataField["type"]> = Extract<
  M["fields"][number],
  { type: T }
>["name"];
type NumericName<M extends DataModel> = AggregateFieldName<M, "number" | "money_rate">;
type AggregateGroup<M extends DataModel> =
  | AggregateFieldName<M, Groupable | "relation" | "number">
  | { field: AggregateFieldName<M, "number">; bins: { edges: readonly string[] } }
  | {
      field: AggregateFieldName<M, "money_rate">;
      bins: { edges: readonly string[] };
      unit: AggregateUnit;
    };
type AggregateMetric<M extends DataModel> =
  | { fn: "count" }
  | { fn: "count_distinct" | "sum" | "avg" | "min" | "max" | "median"; field: NumericName<M> }
  | { fn: "percentile"; field: NumericName<M>; p: number };
type AggregateKey<M extends DataModel, G> = G extends { bins: unknown }
  ? AggregateBinKey | null
  : G extends string
    ? ReadValue<Extract<M["fields"][number], { name: G }>>
    : never;
type AggregateUnits<
  M extends DataModel,
  T extends readonly unknown[],
  Seen = never,
> = T extends readonly [infer H, ...infer R]
  ? H extends { field: infer F }
    ? F extends FieldNames<M, "money_rate">
      ? F extends Seen
        ? AggregateUnits<M, R, Seen>
        : [{ unit: AggregateUnit | null }, ...AggregateUnits<M, R, Seen | F>]
      : AggregateUnits<M, R, Seen>
    : AggregateUnits<M, R, Seen>
  : number extends T["length"]
    ? { unit: AggregateUnit | null }[]
    : [];
type AggregateInput<M extends DataModel> = Omit<
  ModelQueryInput<M>,
  "orderBy" | "limit" | "offset"
> & {
  groupBy?: readonly AggregateGroup<M>[] | undefined;
  metrics: readonly AggregateMetric<M>[];
};
/** Distributes over an optional `groupBy`, so an omitted grouping keeps its unit-only key layout. */
type AggregateGroupKey<
  M extends DataModel,
  G extends readonly unknown[] | undefined,
  T extends readonly unknown[],
> = G extends readonly unknown[]
  ? [...{ [I in keyof G]: AggregateKey<M, G[I]> }, ...AggregateUnits<M, T>]
  : AggregateUnits<M, T>;
type AggregateResult<
  M extends DataModel,
  G extends readonly unknown[] | undefined,
  T extends readonly unknown[],
> = {
  as_of: string;
  units: { [I in keyof T]: AggregateUnit | null };
  groups: {
    key: AggregateGroupKey<M, G, T>;
    metrics: { [I in keyof T]: string | null };
  }[];
  total: { metrics: { [I in keyof T]: string | null } };
  other_units?: string;
};
type FieldFilter<F extends DataField> = F extends { type: Filterable }
  ?
      | { field: F["name"]; op: "isNull" }
      | {
          field: F["name"];
          op:
            | "eq"
            | "ne"
            | (F["type"] extends "bool" ? never : "lt" | "lte" | "gt" | "gte")
            | (F["type"] extends "text" ? "contains" : never);
          value: F["type"] extends "relation" ? string : Extract<Value<F>, string | boolean>;
        }
  : never;
type ModelQueryInput<M extends DataModel> = Omit<
  QueryInput,
  "where" | "orderBy" | "select" | "search"
> & {
  search?: {
    query: string;
    /** Stored fields only; `kernel_data_query` does not search custom-field storage. */
    fields: readonly Extract<
      Exclude<M["fields"][number], { storage: "custom" }>,
      { type: "text" | "text_list" | "known_aliases" }
    >["name"][];
  };
  where?: readonly (
    | FieldFilter<M["fields"][number]>
    | FieldFilter<{
        id: "identity";
        name: "id" | "externalKey";
        type: "text";
        required: true;
        readOnly: false;
      }>
  )[];
  orderBy?: readonly {
    field: FieldNames<M, Orderable> | "id" | "externalKey";
    direction: "asc" | "desc";
  }[];
};
type SelectableName<D extends DataDefinition, M extends DataModel> =
  | M["fields"][number]["name"]
  | "id"
  | "externalKey"
  | (D extends { capabilities: { versionPreconditions: true } } ? "$version" : never);
type SelectedRecord<
  D extends DataDefinition,
  M extends DataModel,
  S extends readonly SelectableName<D, M>[],
> = Pick<ModelRecord<D, M["id"]>, Extract<S[number], keyof ModelRecord<D, M["id"]>>> & {
  /** As on a full record: what came from a pending draft, for the selected fields. */
  pendingDraft?: PendingDraft;
};
type IsUnion<Value, Whole = Value> = Value extends Whole
  ? [Whole] extends [Value]
    ? false
    : true
  : never;
type HasUnionElement<Values extends readonly unknown[]> = Values extends readonly [
  infer Head,
  ...infer Tail,
]
  ? IsUnion<Head> extends true
    ? true
    : HasUnionElement<Tail>
  : false;
type SelectionInput<S extends readonly unknown[] | undefined> = {
  select?: S;
} & (S extends readonly [] ? { select: never } : unknown) &
  (undefined extends S ? unknown : { select: S });
type ReadInput<
  D extends DataDefinition,
  M extends DataModel,
  S extends readonly SelectableName<D, M>[] | undefined,
> = ModelQueryInput<M> & SelectionInput<S>;
type ReadResult<
  D extends DataDefinition,
  M extends DataModel,
  S extends readonly SelectableName<D, M>[] | undefined,
> = S extends readonly SelectableName<D, M>[]
  ? number extends S["length"]
    ? Partial<SelectedRecord<D, M, S>>
    : HasUnionElement<S> extends true
      ? Partial<SelectedRecord<D, M, S>>
      : SelectedRecord<D, M, S>
  : ModelRecord<D, M["id"]>;
export type WriteOptions = {
  effectiveStart: string;
  idempotencyKey: string;
  notes?: string;
};
type MetadataOptions = {
  metadataPatch?: Exclude<RowVersionWrite["metadata_patch"], undefined>;
};
type CreateOptions = MetadataOptions & { ifVersion?: never };
type VersionOption<D extends DataDefinition> = D extends {
  capabilities: { versionPreconditions: true };
}
  ? { ifVersion?: string }
  : { ifVersion?: never };
type UpdateOptions<D extends DataDefinition, M extends DataModel> = MetadataOptions &
  VersionOption<D> & { clear?: readonly Clearable<M>[] };
type ExistingTarget<D extends DataDefinition, M extends DataModel> =
  | string
  | RecordIdentity<D, M["id"]>;
type Provenance = {
  definition: DataDefinition;
  appId: string;
  customerId: string;
  model: string;
  recordId: string;
  kind: "record" | "create";
};
type RelationSource = {
  model_id: string;
  relation_id: string;
  record_id: string;
};
const references = new WeakMap<object, Provenance>();
const preparedWrites = new WeakMap<
  object,
  {
    definition: DataDefinition;
    appId: string;
    customerId: string;
    dependencies: readonly object[];
    model: string;
    kind: "create" | "update" | "delete";
    input: Record<string, unknown>;
  }
>();
/** Opaque, validated write intent. Only the generated builders can create one. */
export type DataWrite = {
  readonly recordId: string;
  readonly [writeBrand]: "write";
};
export type CreateWrite<D extends DataDefinition, I extends string> = DataWrite & {
  readonly [recordBrand]: readonly [D, I, "create"];
};
export type DataContext = {
  scope: Readonly<{ appId: string; customerId: string }>;
  /** Trusted request-scoped UUID source, stable across exact protected HTTP retries. */
  createRecordId?: () => string;
  /** Supplied by the host after authentication; never copied from action input. */
  authorize(capability: string): Promise<void>;
  transaction<T>(run: (session: DataSession) => Promise<T>): Promise<T>;
};
export type DataSession = {
  call(operation: string, input: Record<string, unknown>): Promise<unknown>;
  /** Serializes an exact predecessor observation and operation with app schema activation. */
  lockSchemaActivation?(): Promise<void>;
  actorId: string;
  sourceKind: string;
};
type ModelOperations<D extends DataDefinition, M extends DataModel> = {
  /** Read whether this generated field is active for use in an authorized form. */
  fieldActivation(input: {
    field: Writable<M>["name"];
    operation: "create" | "update";
  }): Promise<"active" | "pending">;
  /** Parse explicitly allowlisted browser controls into generated write values; persistence remains separate. */
  parseForm<const F extends readonly FormFieldName<M>[], const Mode extends "create" | "update">(
    form: FormData,
    input: FormInput<F, Mode>,
  ): ParsedForm<M, F, Mode>;
  toFormError<const F extends readonly FormFieldName<M>[]>(
    error: unknown,
    input: { fields: F },
  ): FormError<F[number]> | undefined;
  /** Read a record by its canonical UUID or explicit external key. */
  get<const S extends readonly SelectableName<D, M>[] | undefined = undefined>(
    input: { key: CanonicalRecordKey; asOf: string } & SelectionInput<S>,
  ): Promise<ReadResult<D, M, S> | null>;
  /** Filter and sort in PostgreSQL; deterministic offset pages have at most 100 rows. */
  list<const S extends readonly SelectableName<D, M>[] | undefined = undefined>(
    input: ReadInput<D, M, S>,
  ): Promise<ReadResult<D, M, S>[]>;
  /** The whole input is inferred so an optional `groupBy` keeps `undefined` in its type. */
  aggregate<const I extends AggregateInput<M>>(
    input: I,
  ): Promise<
    AggregateResult<M, "groupBy" extends keyof I ? I["groupBy"] : undefined, I["metrics"]>
  >;
  /** Count the full filtered collection, independently of list pagination. Decimal integer string. */
  count(input: ModelQueryInput<M>): Promise<string>;
  /** Grouped counts are bounded to 100 groups; values retain the selected field's read type. */
  countBy<const G extends GroupFieldName<M>>(
    input: ModelQueryInput<M> & { groupBy: G },
  ): Promise<{ value: GroupValue<M, G>; count: string }[]>;
  create(
    values: CreateValues<D, M>,
    options: CreateOptions & WriteOptions,
  ): Promise<AppliedChangeSet>;
  update(
    target: ExistingTarget<D, M>,
    changes: UpdateValues<D, M>,
    options: UpdateOptions<D, M> & WriteOptions,
  ): Promise<AppliedChangeSet>;
  /** Hide a record through an audited tombstone; retain its history. */
  delete(
    target: ExistingTarget<D, M>,
    options: WriteOptions & VersionOption<D>,
  ): Promise<AppliedChangeSet>;
  history(input: { id: string; asOf?: string; limit?: number }): Promise<FieldHistoryEntry[]>;
  writes: {
    create(
      values: CreateValues<D, M>,
      options?: CreateOptions & { id?: string },
    ): CreateWrite<D, M["id"]>;
    update(
      target: ExistingTarget<D, M>,
      changes: UpdateValues<D, M>,
      options?: UpdateOptions<D, M>,
    ): DataWrite;
    delete(target: ExistingTarget<D, M>, options?: VersionOption<D>): DataWrite;
  };
  relations: {
    [R in M["relations"][number] as R["name"]]: {
      list<
        const S extends readonly SelectableName<D, Model<D, R["model"]>>[] | undefined = undefined,
      >(
        input: ReadInput<D, Model<D, R["model"]>, S> & { id: string },
      ): Promise<ReadResult<D, Model<D, R["model"]>, S>[]>;
    };
  };
};
export type DataClient<D extends DataDefinition> = {
  [
    M in D["models"][number] as
      | M["name"]
      | (M extends { aliases: readonly string[] } ? M["aliases"][number] : never)
  ]: ModelOperations<D, M>;
} & {
  apply(input: WriteOptions & { writes: readonly DataWrite[] }): Promise<AppliedChangeSet>;
  workSessions: WorkSessionClient;
};

function invalid(message: string): never {
  throw new Error(`contract_validation_failed: ${message}`);
}

/** An optional field is deploying. The requested operation has made no changes. */
export class DataFieldActivationPendingError extends Error {
  override readonly name = "DataFieldActivationPendingError";
  constructor(
    readonly modelId: string,
    readonly fieldId: string,
  ) {
    super("This field is still being set up. Try again shortly.");
  }
}

class FormValidationError extends Error {
  constructor(
    readonly modelId: string,
    readonly fieldName: string,
  ) {
    super("form validation failed");
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("expected object");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) if (!allowedSet.has(key)) invalid(`unknown input ${key}`);
}
function date(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    invalid("expected calendar date");
}
function id(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  )
    invalid("expected record UUID");
}
function moneyRatePeriod(value: unknown, fieldName: string): MoneyRatePeriod {
  if (
    value !== "annual" &&
    value !== "monthly" &&
    value !== "weekly" &&
    value !== "daily" &&
    value !== "hourly"
  )
    invalid(fieldName);
  return value;
}

function encode(field: DataField, value: unknown): FieldValue {
  let type = field.type;
  if (["iso_country", "iso_currency"].includes(type)) type = "text";
  if (type === "known_aliases") type = "text_list";
  if (type === "bool") {
    if (typeof value !== "boolean") invalid(field.name);
    return { type: "bool", value };
  } else if (type === "json") {
    if (value === undefined) invalid(field.name);
    return { type: "json", value };
  } else if (type === "text_list") {
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) invalid(field.name);
    return { type: "text_list", value };
  } else if (type === "relation_list") {
    if (!Array.isArray(value)) invalid(field.name);
    const keys: RecordKey[] = [];
    for (const key of value) {
      const encoded = encode({ ...field, type: "relation" }, key);
      if (encoded.type !== "relation") invalid(field.name);
      keys.push(encoded.value);
    }
    return { type: "relation_list", value: keys };
  } else if (type === "relation") {
    const key = object(value);
    keys(key, ["type", "value"]);
    if (key.type === "record_id") {
      id(key.value);
      return { type: "relation", value: { type: "record_id", value: key.value } };
    }
    if (key.type !== "external_key" || typeof key.value !== "string" || !key.value.trim())
      invalid(field.name);
    return { type: "relation", value: { type: "external_key", value: key.value } };
  } else if (type === "money_rate") {
    const money = object(value);
    keys(money, ["amount", "currency", "period"]);
    const period = moneyRatePeriod(money.period, field.name);
    if (
      typeof money.amount !== "string" ||
      !/^-?\d+(\.\d+)?$/.test(money.amount) ||
      typeof money.currency !== "string"
    )
      invalid(field.name);
    return {
      type: "money_rate",
      value: {
        amount: money.amount,
        currency: money.currency,
        period,
      },
    };
  } else {
    if (typeof value !== "string") invalid(field.name);
    if (type === "text") return { type: "text", value };
    if (type === "number") {
      if (!/^-?\d+(\.\d+)?$/.test(value)) invalid("numbers must be decimal strings");
      return { type: "number", value };
    }
    if (type === "date") {
      date(value);
      return { type: "date", value };
    }
    if (type === "datetime") {
      if (
        !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
        !Number.isFinite(Date.parse(value))
      )
        invalid(field.name);
      date(value.slice(0, 10));
      return { type: "datetime", value };
    }
    if (type === "enum") {
      if (!field.option_set?.some((option) => option.id === value)) invalid(field.name);
      return { type: "enum", value };
    }
    if (type === "schema_lifecycle") {
      if (value !== "active" && value !== "retired") invalid(field.name);
      return { type: "schema_lifecycle", value };
    }
    invalid(`unsupported field type ${type}`);
  }
}

function writable(field: DataField): boolean {
  return !field.readOnly && field.lifecycle !== "retired";
}

export function createDataClient<const D extends DataDefinition>(
  definition: D,
  context: DataContext,
): DataClient<D> {
  const supportsVersionPreconditions = definition.capabilities?.versionPreconditions === true;
  const models = new Map<string, DataModel>(definition.models.map((model) => [model.id, model]));
  const fieldsByModel = new Map(
    definition.models.map((model) => [
      model.id,
      new Map(model.fields.map((field) => [field.id, field])),
    ]),
  );
  const fieldsByNameByModel = new Map(
    definition.models.map((model) => [
      model.id,
      new Map(model.fields.map((field) => [field.name, field])),
    ]),
  );
  const result: Record<string, unknown> = {
    workSessions: createWorkSessionClient(context, definition.schemaVersion),
  };
  const scope = Object.freeze({ ...context.scope });
  const provenance = (model: string, recordId: string, kind: Provenance["kind"]): Provenance => ({
    definition,
    ...scope,
    model,
    recordId,
    kind,
  });
  const reference = (value: object, model: string, existing = false) => {
    const ref = references.get(value);
    if (
      !ref ||
      ref.definition !== definition ||
      ref.appId !== scope.appId ||
      ref.customerId !== scope.customerId ||
      ref.model !== model ||
      (existing && ref.kind !== "record")
    )
      invalid("reference must come from the matching app, tenant, schema and model");
    return ref;
  };
  const targetId = (value: unknown, model: string): string => {
    if (typeof value === "string") {
      id(value);
      return value;
    }
    return reference(object(value), model, true).recordId;
  };
  const fieldId = (model: DataModel, name: string) => {
    if (name === "id") return "$id";
    if (name === "externalKey") return "$externalKey";
    const field = fieldsByNameByModel.get(model.id)?.get(name);
    if (!field) invalid(`unknown field ${name}`);
    return field.id;
  };
  const decoder = createResponseDecoder({
    fieldsByModel,
    supportsVersionPreconditions,
    onFullRecord: (record, modelId, recordId) =>
      references.set(record, provenance(modelId, recordId, "record")),
  });
  const { decodeRecord, decodeAggregate, decodeActiveRevision, decodeReceipt, decodeHistory } =
    decoder;
  const compatibility = definition.predecessorCompatibility;
  const isAdditiveActiveSchema = (activeSchema: Record<string, unknown>): boolean => {
    if (
      activeSchema.app_id !== scope.appId ||
      activeSchema.customer_id !== scope.customerId ||
      !Array.isArray(activeSchema.models)
    )
      return false;
    const activeModels = new Map<string, Record<string, unknown>>();
    for (const candidate of activeSchema.models) {
      if (
        candidate &&
        typeof candidate === "object" &&
        typeof (candidate as { id?: unknown }).id === "string"
      ) {
        activeModels.set((candidate as { id: string }).id, candidate as Record<string, unknown>);
      }
    }
    const activeCustomByModel = new Map<string, Map<string, string>>();
    if (Array.isArray(activeSchema.custom_fields)) {
      for (const cf of activeSchema.custom_fields) {
        if (cf && typeof cf === "object") {
          const rec = cf as Record<string, unknown>;
          if (rec.lifecycle === "retired" || rec.archived_at != null) continue;
          const modelId = rec.model_id;
          const fId = rec.field_id;
          const fType = rec.type;
          if (typeof modelId === "string" && typeof fId === "string" && typeof fType === "string") {
            let map = activeCustomByModel.get(modelId);
            if (!map) {
              map = new Map();
              activeCustomByModel.set(modelId, map);
            }
            map.set(fId, fType);
          }
        }
      }
    }
    for (const model of definition.models) {
      const activeModel = activeModels.get(model.id);
      if (!activeModel || activeModel.lifecycle === "retired" || activeModel.archived_at != null)
        return false;
      const activeFields = new Map<string, Record<string, unknown>>();
      if (Array.isArray(activeModel.fields)) {
        for (const f of activeModel.fields) {
          if (f && typeof f === "object" && typeof (f as { id?: unknown }).id === "string") {
            activeFields.set((f as { id: string }).id, f as Record<string, unknown>);
          }
        }
      }
      const activeMany = new Set<string>();
      if (Array.isArray(activeModel.many_relations)) {
        for (const rel of activeModel.many_relations) {
          if (rel && typeof rel === "object") {
            const relObj = rel as Record<string, unknown>;
            if (
              typeof relObj.id === "string" &&
              relObj.lifecycle !== "retired" &&
              relObj.archived_at == null
            ) {
              activeMany.add(relObj.id);
            }
          }
        }
      }
      for (const field of model.fields) {
        if (field.lifecycle === "retired") continue;
        if (field.storage === "many") {
          const af = activeFields.get(field.id);
          const validField =
            af !== undefined && af.lifecycle !== "retired" && af.archived_at == null;
          if (!activeMany.has(field.id) && !validField) return false;
          continue;
        }
        if (field.storage === "custom") {
          if (activeCustomByModel.get(model.id)?.get(field.id) !== field.type) return false;
          continue;
        }
        const activeField = activeFields.get(field.id);
        if (
          !activeField ||
          activeField.type !== field.type ||
          activeField.lifecycle === "retired" ||
          activeField.archived_at != null ||
          (activeField.required === true && !field.required)
        )
          return false;
      }
      const knownFieldIds = new Set(model.fields.map((f) => f.id));
      for (const [fId, activeField] of activeFields) {
        if (
          !knownFieldIds.has(fId) &&
          activeField.required === true &&
          activeField.lifecycle !== "retired" &&
          activeField.archived_at == null
        ) {
          return false;
        }
      }
    }
    return true;
  };
  const isVerifiedAdditiveSuccessor = async (
    db: DataSession,
    active: { schema_revision_id: string; schemaVersion: string; schema: Record<string, unknown> },
  ): Promise<boolean> => {
    if (
      active.schemaVersion === definition.schemaVersion ||
      !isAdditiveActiveSchema(active.schema)
    ) {
      return false;
    }
    try {
      const obs = await db.call("kernel_read_runtime_release_observability", {});
      if (
        !obs ||
        typeof obs !== "object" ||
        !Array.isArray((obs as { releases?: unknown }).releases)
      ) {
        return false;
      }
      const activeId = BigInt(active.schema_revision_id);
      return (obs as { releases: unknown[] }).releases.some((entry) => {
        if (!entry || typeof entry !== "object") return false;
        const row = entry as Record<string, unknown>;
        const revIdRaw = row.schema_revision_id;
        if (typeof revIdRaw !== "number" && typeof revIdRaw !== "string") return false;
        let revId: bigint;
        try {
          revId = BigInt(revIdRaw);
        } catch {
          return false;
        }
        if (revId >= activeId) return false;
        const timestamps =
          row.timestamps && typeof row.timestamps === "object"
            ? (row.timestamps as Record<string, unknown>)
            : undefined;
        if (timestamps?.ready_at == null) return false;
        return (
          row.effective_revision === definition.schemaVersion ||
          row.base_revision === definition.schemaVersion ||
          row.release_id === definition.schemaVersion
        );
      });
    } catch {
      return false;
    }
  };
  const activeSchemaForOperation = async (db: DataSession) => {
    const canUsePredecessor =
      compatibility?.kind === "optional-text-addition-v1" && db.lockSchemaActivation !== undefined;
    if (canUsePredecessor) await db.lockSchemaActivation?.();
    const active = decodeActiveRevision(await db.call("kernel_read_active_schema_revision", {}));
    if (active.schemaVersion === definition.schemaVersion) {
      return { active, canUsePredecessor, addedField: undefined };
    }
    if (canUsePredecessor) {
      const predecessor = compatibility.predecessors.find(({ schema, artifactSha256 }) => {
        if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return false;
        return (
          active.effectiveHash === artifactSha256 &&
          /^[0-9a-f]{64}$/u.test(artifactSha256) &&
          active.schema.app_id === scope.appId &&
          active.schema.customer_id === scope.customerId &&
          isDeepStrictEqual(active.schema, { ...schema, customer_id: scope.customerId })
        );
      });
      if (predecessor !== undefined) {
        const { modelId, fieldId } = predecessor.field;
        const field = fieldsByModel.get(modelId)?.get(fieldId);
        if (
          field?.type === "text" &&
          !field.required &&
          writable(field) &&
          !["custom", "many"].includes(field.storage ?? "")
        ) {
          return { active, canUsePredecessor, addedField: predecessor.field };
        }
      }
    }
    if (await isVerifiedAdditiveSuccessor(db, active)) {
      return { active, canUsePredecessor: false, addedField: undefined };
    }
    invalid("generated schema version does not match active artifact");
  };
  const query = async (
    model: DataModel,
    input: QueryInput & {
      groupBy?:
        | string
        | readonly (
            | string
            | { field: string; bins: { edges: readonly string[] }; unit?: AggregateUnit }
          )[];
      metrics?: readonly { fn: string; field?: string; p?: number }[];
    },
    kind: "list" | "count" | "aggregate",
    session?: DataSession,
    relationSource?: RelationSource,
  ): Promise<unknown> => {
    keys(object(input), [
      "asOf",
      "where",
      "orderBy",
      "limit",
      "offset",
      "groupBy",
      "select",
      "metrics",
      "search",
      "work",
      "includePendingDrafts",
    ]);
    if (input.includePendingDrafts !== undefined && typeof input.includePendingDrafts !== "boolean")
      invalid("includePendingDrafts must be a boolean");
    if (input.work !== undefined) {
      keys(object(input.work), ["sessionId"]);
      id(input.work.sessionId);
    }
    date(input.asOf);
    if ((input.where?.length ?? 0) > 20 || (input.orderBy?.length ?? 0) > 5) invalid("query limit");
    const hasSelect = Object.hasOwn(input, "select");
    if (kind !== "list" && hasSelect) invalid("select is not supported for count");
    const select =
      input.select === undefined
        ? undefined
        : (() => {
            if (!Array.isArray(input.select) || input.select.length === 0)
              invalid("select must be a non-empty array");
            const fields = input.select.map((name) => {
              if (typeof name !== "string") invalid("select field");
              const id =
                name === "$version" && supportsVersionPreconditions
                  ? "$version"
                  : fieldId(model, name);
              return { name, id };
            });
            if (new Set(fields.map((field) => field.name)).size !== fields.length)
              invalid("duplicate select field");
            return fields;
          })();
    const groups = typeof input.groupBy === "string" ? [input.groupBy] : (input.groupBy ?? []);
    const metrics = kind === "count" ? [{ fn: "count" }] : input.metrics;
    if (kind !== "list") {
      if (
        !Array.isArray(groups) ||
        groups.length > 2 ||
        !Array.isArray(metrics) ||
        metrics.length < 1 ||
        metrics.length > 8
      )
        invalid("aggregate bounds");
      if (
        kind === "aggregate" &&
        (input.orderBy !== undefined || input.limit !== undefined || input.offset !== undefined)
      )
        invalid("aggregate pagination");
      for (const group of groups) {
        const name = typeof group === "string" ? group : object(group).field;
        if (typeof name !== "string") invalid("group field name");
        const field = fieldsByNameByModel.get(model.id)?.get(name);
        if (!field) invalid("unsupported group field");
        if (kind === "count" && field.type === "number") invalid("group field type");
        if (typeof group === "string") {
          if (
            ![
              "text",
              "enum",
              "bool",
              "date",
              "iso_country",
              "iso_currency",
              "relation",
              "number",
            ].includes(field.type)
          )
            invalid("group field type");
        } else {
          keys(object(group), ["field", "bins", "unit"]);
          keys(object(group.bins), ["edges"]);
          if (!["number", "money_rate"].includes(field.type)) invalid("bin field type");
          const edges = group.bins.edges;
          if (
            !Array.isArray(edges) ||
            edges.length < 2 ||
            edges.length > 51 ||
            edges.some((edge) => typeof edge !== "string" || !/^-?\d+(?:\.\d+)?$/.test(edge))
          )
            invalid("bin edges");
          const compare = (a: string, b: string) => {
            const scale = Math.max(a.split(".")[1]?.length ?? 0, b.split(".")[1]?.length ?? 0);
            const integer = (v: string) =>
              BigInt(v.replace(".", "") + "0".repeat(scale - (v.split(".")[1]?.length ?? 0)));
            return integer(a) < integer(b);
          };
          if (edges.some((edge, i) => i > 0 && !compare(edges[i - 1]!, edge)))
            invalid("bin edges must ascend");
          if (field.type === "money_rate") encode(field, { amount: "0", ...object(group.unit) });
          else if (group.unit !== undefined) invalid("unit requires money-rate");
        }
      }
      for (const metric of metrics) {
        keys(object(metric), ["fn", "field", "p"]);
        if (metric.fn === "count") {
          if (metric.field !== undefined || metric.p !== undefined) invalid("count operands");
          continue;
        }
        if (
          !["count_distinct", "sum", "avg", "min", "max", "median", "percentile"].includes(
            metric.fn,
          )
        )
          invalid("metric function");
        const field = fieldsByNameByModel.get(model.id)?.get(metric.field ?? "");
        if (!field || !["number", "money_rate"].includes(field.type)) invalid("metric field");
        if (metric.fn === "percentile") {
          if (
            typeof metric.p !== "number" ||
            !Number.isFinite(metric.p) ||
            metric.p < 0 ||
            metric.p > 1
          )
            invalid("percentile p");
        } else if (metric.p !== undefined) invalid("unexpected percentile p");
      }
    }
    if (input.search !== undefined) {
      keys(object(input.search), ["query", "fields"]);
      if (
        typeof input.search.query !== "string" ||
        !input.search.query.trim() ||
        input.search.query.length > 200 ||
        !Array.isArray(input.search.fields) ||
        input.search.fields.length < 1 ||
        input.search.fields.length > 10
      )
        invalid("search");
      for (const name of input.search.fields) {
        const field = fieldsByNameByModel.get(model.id)?.get(name);
        if (
          !field ||
          field.storage === "custom" ||
          !["text", "text_list", "known_aliases"].includes(field.type)
        )
          invalid("search field");
      }
    }
    const request = {
      model_id: model.id,
      schema_version: definition.schemaVersion,
      as_of: input.asOf,
      ...(input.work === undefined ? {} : { work: { session_id: input.work.sessionId } }),
      ...(input.includePendingDrafts === undefined
        ? {}
        : { include_pending_drafts: input.includePendingDrafts }),
      ...(input.search === undefined
        ? {}
        : {
            search: {
              query: input.search.query,
              fields: input.search.fields.map((name) => fieldId(model, name)),
            },
          }),
      kind: kind === "list" ? "list" : "aggregate",
      ...(input.where === undefined
        ? {}
        : {
            where: input.where.map((filter) => {
              keys(object(filter), ["field", "op", "value"]);
              return { ...filter, field: fieldId(model, filter.field) };
            }),
          }),
      ...(kind !== "list" || input.orderBy === undefined
        ? {}
        : {
            order_by: input.orderBy.map((order) => {
              keys(object(order), ["field", "direction"]);
              return { ...order, field: fieldId(model, order.field) };
            }),
          }),
      ...(kind !== "list" || input.limit === undefined ? {} : { limit: input.limit }),
      ...(kind !== "list" || input.offset === undefined ? {} : { offset: input.offset }),
      ...(select ? { select: [...new Set(select.map((field) => field.id))] } : {}),
      ...(kind === "list"
        ? {}
        : {
            group_by: groups.map((group) =>
              typeof group === "string"
                ? fieldId(model, group)
                : { ...group, field: fieldId(model, group.field) },
            ),
            metrics: metrics!.map((metric) => ({
              ...metric,
              ...(metric.field === undefined ? {} : { field: fieldId(model, metric.field) }),
            })),
          }),
      ...(relationSource ? { relation_source: relationSource } : {}),
    };
    if (new TextEncoder().encode(JSON.stringify(request)).length > 1048576)
      invalid("query payload exceeds 1 MiB");
    const run = async (db: DataSession) => {
      let queryRequest = request;
      if (compatibility !== undefined && db.lockSchemaActivation !== undefined) {
        const { active, addedField } = await activeSchemaForOperation(db);
        if (addedField !== undefined) {
          queryRequest = { ...request, schema_version: active.schemaVersion };
          if (addedField.modelId === model.id) {
            const { fieldId: pendingField } = addedField;
            const usesPendingField = [
              ...(request.where ?? []).map(({ field }) => field),
              ...(request.order_by ?? []).map(({ field }) => field),
              ...(request.search?.fields ?? []),
              ...(request.group_by ?? []).map((group) =>
                typeof group === "string" ? group : group.field,
              ),
              ...(request.metrics ?? []).map(({ field }) => field),
            ].includes(pendingField);
            if (usesPendingField) throw new DataFieldActivationPendingError(model.id, pendingField);
            if (request.select?.includes(pendingField)) {
              const predecessorSelect = request.select.filter((id) => id !== pendingField);
              queryRequest.select = predecessorSelect.length > 0 ? predecessorSelect : ["$id"];
            }
          }
        }
      }
      let response: unknown;
      let usedAdditiveFullProjection = false;
      try {
        response = await db.call("kernel_data_query", queryRequest);
      } catch (error) {
        if (
          error instanceof KernelFailure &&
          error.envelope.code === "schema_drift" &&
          queryRequest.schema_version === definition.schemaVersion
        ) {
          const active = decodeActiveRevision(
            await db.call("kernel_read_active_schema_revision", {}),
          );
          if (await isVerifiedAdditiveSuccessor(db, active)) {
            const additiveFullSelect =
              kind === "list" && queryRequest.select === undefined
                ? [
                    ...new Set([
                      "$id",
                      "$externalKey",
                      "$version",
                      "$effectiveStart",
                      "$effectiveEnd",
                      "$metadata",
                      ...model.fields.map((field) => field.id),
                    ]),
                  ]
                : undefined;
            usedAdditiveFullProjection = additiveFullSelect !== undefined;
            response = await db.call("kernel_data_query", {
              ...queryRequest,
              schema_version: active.schemaVersion,
              ...(additiveFullSelect === undefined ? {} : { select: additiveFullSelect }),
            });
          } else {
            throw error;
          }
        } else {
          throw error;
        }
      }
      if (kind === "list") {
        if (!Array.isArray(response))
          responseFailure("kernel_data_query", "response", "record array");
        return response.map((record) =>
          decodeRecord(
            model,
            usedAdditiveFullProjection &&
              record !== null &&
              typeof record === "object" &&
              !Array.isArray(record)
              ? { values: {}, custom_fields: [], many_relations: {}, ...record }
              : record,
            select?.map((field) => field.name),
          ),
        );
      }
      const decoded = decodeAggregate(
        groups.map((group) => ({
          field: fieldsByNameByModel
            .get(model.id)!
            .get(typeof group === "string" ? group : group.field)!,
          ...(typeof group === "string" ? {} : { bins: group.bins }),
        })),
        metrics!.map((metric) => ({
          ...metric,
          money: fieldsByNameByModel.get(model.id)?.get(metric.field ?? "")?.type === "money_rate",
        })),
        response,
      );
      if (kind === "aggregate") return decoded;
      return typeof input.groupBy === "string"
        ? decoded.groups.map((group) => ({ value: group.key[0], count: group.metrics[0]! }))
        : decoded.total.metrics[0];
    };
    if (session) return run(session);
    await context.authorize(`${model.id}.${kind}`);
    return context.transaction(run);
  };
  const apply = async (
    input: WriteOptions & { writes: readonly DataWrite[] },
  ): Promise<AppliedChangeSet> => {
    keys(object(input), ["effectiveStart", "idempotencyKey", "notes", "writes"]);
    date(input.effectiveStart);
    if (
      typeof input.idempotencyKey !== "string" ||
      !input.idempotencyKey.trim() ||
      !Array.isArray(input.writes) ||
      input.writes.length < 1 ||
      input.writes.length > 100
    )
      invalid("write envelope");
    const intents = input.writes.map((write) => {
      const intent = preparedWrites.get(write);
      if (
        !intent ||
        intent.definition !== definition ||
        intent.appId !== scope.appId ||
        intent.customerId !== scope.customerId ||
        !models.has(intent.model)
      )
        invalid("write must come from this schema's generated builder");
      return intent;
    });
    const writeSet = new Set(input.writes);
    for (const intent of intents)
      for (const dependency of intent.dependencies)
        if (!writeSet.has(dependency as DataWrite))
          invalid("pending create reference must be included in the same atomic batch");
    const capabilities = new Set(intents.map((intent) => `${intent.model}.${intent.kind}`));
    await Promise.all([...capabilities].map((capability) => context.authorize(capability)));
    return context.transaction(async (db) => {
      const { active, canUsePredecessor, addedField } = await activeSchemaForOperation(db);
      const writes: RowVersionWrite[] = [];
      for (const intent of intents) {
        const model = models.get(intent.model)!;
        const source = intent.input;
        if (addedField?.modelId === model.id && intent.kind !== "delete") {
          const field = fieldsByModel.get(model.id)?.get(addedField.fieldId);
          const clear = (source.clear ?? []) as string[];
          if (
            field &&
            (Object.hasOwn(object(source.values), field.name) || clear.includes(field.name))
          )
            throw new DataFieldActivationPendingError(model.id, addedField.fieldId);
        }
        if (
          source.metadataPatch !== undefined &&
          !(model.extensions as { record_metadata?: unknown } | undefined)?.record_metadata
        )
          invalid("record metadata is not enabled for this model");
        const values: Record<string, FieldValue> = {};
        const customFields: NonNullable<RowVersionWrite["custom_fields"]> = [];
        if (intent.kind !== "delete")
          for (const [name, value] of Object.entries(object(source.values))) {
            const field = model.fields.find((f) => f.name === name);
            if (!field || !writable(field)) invalid(`field is not writable: ${name}`);
            const encoded = encode(field, value);
            if (field.storage === "custom") {
              if (
                encoded.type === "relation_list" ||
                encoded.type === "schema_lifecycle" ||
                encoded.type === "json"
              )
                invalid("unsupported custom field type");
              customFields.push({ field_id: field.id, ...encoded });
            } else values[field.id] = encoded;
          }
        const clear = (source.clear ?? []) as string[];
        const clearFields: string[] = [];
        const clearCustomFields: string[] = [];
        for (const name of clear) {
          const field = model.fields.find((f) => f.name === name);
          if (
            !field ||
            !writable(field) ||
            field.required ||
            field.id in values ||
            customFields.some((entry) => entry.field_id === field.id)
          )
            invalid(`field cannot be cleared: ${name}`);
          (field.storage === "custom" ? clearCustomFields : clearFields).push(field.id);
        }
        if (intent.kind === "create")
          for (const field of model.fields)
            if (
              field.required &&
              writable(field) &&
              !(field.id in values || customFields.some((entry) => entry.field_id === field.id))
            )
              invalid(`required field ${field.name}`);
        const expectedVersion = source.ifVersion;
        if (expectedVersion !== undefined) id(expectedVersion);
        // The canonical apply owns atomicity/replay. Existing UUID addressing is
        // update-only; unlike external-key writes it cannot reserve new subjects.
        writes.push({
          model_id: model.id,
          effective_start: input.effectiveStart,
          ...(expectedVersion !== undefined ? { expected_version_id: expectedVersion } : {}),
          ...(intent.kind === "create"
            ? { new_record_id: source.id as string }
            : {
                record_key: {
                  type: "record_id" as const,
                  value: source.id as string,
                },
              }),
          ...(intent.kind === "delete"
            ? { tombstones_record: true }
            : {
                values,
                custom_fields: customFields,
                ...(source.metadataPatch === undefined
                  ? {}
                  : {
                      metadata_patch: source.metadataPatch as Exclude<
                        RowVersionWrite["metadata_patch"],
                        undefined
                      >,
                    }),
                clear_fields: clearFields,
                clear_custom_fields: clearCustomFields,
              }),
        });
      }
      const request = {
        // The locked kernel operation binds the actual active revision. Keep the request
        // stable across the additive cutover so exact replays can return their old receipt.
        ...(canUsePredecessor ? {} : { schema_revision_id: active.schema_revision_id }),
        actor_id: db.actorId,
        source_kind: db.sourceKind,
        idempotency_key: input.idempotencyKey,
        mode: "mainline",
        ...(input.notes === undefined ? {} : { notes: input.notes }),
        writes,
      };
      if (new TextEncoder().encode(JSON.stringify(request)).length > 1048576)
        invalid("payload exceeds 1 MiB");
      return decodeReceipt(await db.call("kernel_apply_change_set", request));
    });
  };
  result.apply = apply;
  for (const model of definition.models) {
    const prepare = (
      kind: "create" | "update" | "delete",
      input: Record<string, unknown>,
    ): DataWrite => {
      keys(
        object(input),
        kind === "create"
          ? ["id", "values", "metadataPatch"]
          : kind === "update"
            ? ["id", "values", "clear", "metadataPatch", "ifVersion"]
            : ["id", "ifVersion"],
      );
      if (input.ifVersion !== undefined) {
        if (
          kind === "create" ||
          !supportsVersionPreconditions ||
          typeof input.ifVersion !== "string"
        )
          invalid("ifVersion");
        id(input.ifVersion);
      }
      const recordId =
        kind === "create" ? (input.id ?? context.createRecordId?.() ?? randomUUID()) : input.id;
      id(recordId);
      const dependencies: object[] = [];
      const normalized: Record<string, unknown> = { ...input, id: recordId };
      if (kind !== "delete") {
        normalized.values = Object.fromEntries(
          Object.entries(object(input.values)).map(([name, value]) => {
            const field = model.fields.find((f) => f.name === name);
            if (!field || !writable(field)) invalid(`field is not writable: ${name}`);
            const normalizeReference = (item: unknown) => {
              const candidate = object(item);
              if (references.has(candidate)) {
                const ref = reference(candidate, field.target_model!);
                if (ref.kind === "create") dependencies.push(candidate);
                return { type: "record_id", value: ref.recordId };
              }
              encode({ ...field, type: "relation" }, item);
              return item;
            };
            if (field.type === "relation") value = normalizeReference(value);
            if (field.type === "relation_list") {
              if (!Array.isArray(value)) invalid(field.name);
              value = value.map(normalizeReference);
            }
            return [name, value];
          }),
        );
      }
      const write = Object.freeze({ recordId }) as DataWrite;
      if (kind === "create") references.set(write, provenance(model.id, recordId, "create"));
      preparedWrites.set(write, {
        definition,
        ...scope,
        dependencies,
        model: model.id,
        kind,
        input: structuredClone(normalized),
      });
      return write;
    };
    const mutation = (kind: "create" | "update" | "delete", input: Record<string, unknown>) => {
      const { effectiveStart, idempotencyKey, notes, ...payload } = input;
      if (kind === "create") {
        const hex = createHash("sha256")
          .update(
            JSON.stringify([
              scope.appId,
              scope.customerId,
              definition.schemaVersion,
              model.id,
              idempotencyKey,
            ]),
          )
          .digest("hex");
        payload.id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
      }
      return apply({
        effectiveStart: effectiveStart as string,
        idempotencyKey: idempotencyKey as string,
        ...(notes === undefined ? {} : { notes: notes as string }),
        writes: [prepare(kind, payload)],
      });
    };
    const parseForm = (
      form: FormData,
      input: { fields: readonly string[]; mode: "create" | "update" },
    ) => {
      if (!Array.isArray(input.fields) || input.fields.length === 0) invalid("form fields");
      if (input.mode !== "create" && input.mode !== "update") invalid("form mode");
      const selected = new Map<string, DataField>();
      for (const name of input.fields) {
        if (typeof name !== "string" || selected.has(name)) invalid("duplicate form field");
        const field = fieldsByNameByModel.get(model.id)?.get(name);
        if (!field || !writable(field)) invalid(`unsupported form field ${name}`);
        selected.set(name, field);
      }
      const values: Record<string, unknown> = {};
      const clear: string[] = [];
      for (const [name, field] of selected) {
        const controls = form.getAll(name);
        const clearControls = form.getAll(`clear:${name}`);
        if (controls.length > 1 || clearControls.length > 1)
          throw new FormValidationError(model.id, name);
        if (clearControls.length === 1) {
          if (
            input.mode !== "update" ||
            field.required ||
            clearControls[0] !== "true" ||
            controls.length
          )
            throw new FormValidationError(model.id, name);
          clear.push(name);
          continue;
        }
        if (controls.length === 0) {
          if (input.mode === "create" && field.required)
            throw new FormValidationError(model.id, name);
          continue;
        }
        const control = controls[0];
        if (typeof control !== "string") throw new FormValidationError(model.id, name);
        let value: unknown = control;
        if (field.type === "bool") {
          if (control !== "true" && control !== "false")
            throw new FormValidationError(model.id, name);
          value = control === "true";
        } else if (
          [
            "json",
            "money_rate",
            "text_list",
            "known_aliases",
            "relation",
            "relation_list",
          ].includes(field.type)
        ) {
          try {
            value = JSON.parse(control);
          } catch {
            throw new FormValidationError(model.id, name);
          }
        }
        try {
          encode(field, value);
        } catch {
          throw new FormValidationError(model.id, name);
        }
        values[name] = value;
      }
      return { values, clear };
    };
    const toFormError = (error: unknown, input: { fields: readonly string[] }) => {
      if (!Array.isArray(input.fields) || input.fields.length === 0) return undefined;
      const accepted = new Set<string>();
      for (const name of input.fields) {
        const field = fieldsByNameByModel.get(model.id)?.get(name);
        if (!field || !writable(field) || accepted.has(name)) return undefined;
        accepted.add(name);
      }
      const formError = (
        code: "invalid_input" | "conflict" | "constraint_violation",
        message: string,
        ids: readonly string[],
      ) => {
        const fieldErrors: FormError<string>["fieldErrors"] = {};
        let fieldErrorCount = 0;
        for (const fieldId of ids) {
          const field = model.fields.find((candidate) => candidate.id === fieldId);
          if (field && accepted.has(field.name) && fieldErrors[field.name] === undefined) {
            fieldErrors[field.name] = { code, message };
            fieldErrorCount += 1;
          }
        }
        return fieldErrorCount > 0 ? { ok: false as const, code, message, fieldErrors } : undefined;
      };
      if (error instanceof FormValidationError)
        return error.modelId === model.id
          ? formError("invalid_input", "Enter a valid value", [
              fieldsByNameByModel.get(model.id)?.get(error.fieldName)?.id ?? "",
            ])
          : undefined;
      if (error instanceof DataFieldActivationPendingError) {
        return error.modelId === model.id
          ? formError("conflict", error.message, [error.fieldId])
          : undefined;
      }
      if (!(error instanceof KernelFailure)) return undefined;
      const envelope = error.envelope;
      if (
        !envelope ||
        typeof envelope !== "object" ||
        Array.isArray(envelope) ||
        typeof envelope.code !== "string" ||
        typeof envelope.message !== "string"
      )
        return undefined;
      const details = envelope.details === undefined ? [] : envelope.details;
      if (
        !Array.isArray(details) ||
        !details.every(
          (item) =>
            item &&
            typeof item.path === "string" &&
            typeof item.code === "string" &&
            typeof item.message === "string",
        )
      )
        return undefined;
      if (envelope.code === "version_conflict")
        return supportsVersionPreconditions && details.length === 0
          ? {
              ok: false as const,
              code: "conflict" as const,
              message: "This record has changed. Reload and try again.",
              fieldErrors: {},
            }
          : undefined;
      if (envelope.code === "authorization_denied" || envelope.code === "forbidden")
        return {
          ok: false as const,
          code: "forbidden" as const,
          message: "You do not have permission to do that",
          fieldErrors: {},
        };
      const models = details.filter((item) => item.path === "model");
      const fields = details.filter((item) => item.path === "field");
      if (
        models.length !== 1 ||
        models[0]?.message !== model.id ||
        models[0]?.code !== envelope.code ||
        fields.length === 0 ||
        !fields.every((item) => item.code === envelope.code)
      )
        return undefined;
      const ids = fields.map((item) => item.message);
      const fieldIds = new Set(ids);
      if (fieldIds.size !== ids.length) return undefined;
      if (envelope.code === "unique_field_conflict" && fields.length === 1) {
        const field = model.fields.find((candidate) => candidate.id === ids[0]);
        return field?.is_unique === true
          ? formError("conflict", "This value is already in use", ids)
          : undefined;
      }
      if (envelope.code !== "constraint_violation") return undefined;
      const constraintDetails = details.filter((item) => item.path === "constraint");
      if (
        constraintDetails.length !== 1 ||
        constraintDetails[0]?.code !== envelope.code ||
        !constraintDetails[0]?.message
      )
        return undefined;
      const declared = (definition.constraints ?? []).filter(
        (constraint) =>
          constraint.id === constraintDetails[0]?.message &&
          constraint.model === model.id &&
          constraint.authority === "authoritative",
      );
      if (declared.length !== 1) return undefined;
      const declaredIds = declared[0]?.referencedFieldIds;
      if (
        !declaredIds ||
        declaredIds.length === 0 ||
        new Set(declaredIds).size !== declaredIds.length ||
        declaredIds.length !== ids.length ||
        !declaredIds.every((fieldId) => fieldIds.has(fieldId))
      )
        return undefined;
      return formError(
        "constraint_violation",
        "This value does not satisfy the required rules",
        declaredIds,
      );
    };
    result[model.name] = {
      fieldActivation: async (input: { field: string; operation: "create" | "update" }) => {
        keys(object(input), ["field", "operation"]);
        const field = fieldsByNameByModel.get(model.id)?.get(input.field);
        if (!field || !writable(field)) invalid("field activation requires a writable field");
        if (input.operation !== "create" && input.operation !== "update")
          invalid("field activation requires create or update");
        await context.authorize(`${model.id}.${input.operation}`);
        return context.transaction(async (db) => {
          const { addedField } = await activeSchemaForOperation(db);
          return addedField?.modelId === model.id && addedField.fieldId === field.id
            ? "pending"
            : "active";
        });
      },
      parseForm,
      toFormError,
      list: (input: QueryInput) => query(model, input, "list"),
      aggregate: (input: Parameters<typeof query>[1]) => query(model, input, "aggregate"),
      count: (input: QueryInput) => query(model, input, "count"),
      countBy: (input: QueryInput & { groupBy: string }) => query(model, input, "count"),
      get: async (input: { key: CanonicalRecordKey; asOf: string; select?: readonly string[] }) => {
        keys(object(input), ["key", "asOf", "select"]);
        const { type: keyType, value: keyValue } = input.key;
        if (keyType !== "record_id" && keyType !== "external_key")
          invalid("unsupported record key");
        await context.authorize(`${model.id}.get`);
        const rows = (await context.transaction((db) =>
          query(
            model,
            {
              asOf: input.asOf,
              where: [
                {
                  field: keyType === "record_id" ? "id" : "externalKey",
                  op: "eq",
                  value: keyValue,
                },
              ],
              limit: 1,
              ...(input.select === undefined ? {} : { select: input.select }),
            },
            "list",
            db,
          ),
        )) as unknown[];
        return rows[0] ?? null;
      },
      create: async (values: unknown, options: Record<string, unknown>) => {
        keys(object(options), ["effectiveStart", "idempotencyKey", "notes", "metadataPatch"]);
        return mutation("create", { ...options, values });
      },
      update: async (target: unknown, values: unknown, options: Record<string, unknown>) => {
        keys(object(options), [
          "effectiveStart",
          "idempotencyKey",
          "notes",
          "metadataPatch",
          "clear",
          "ifVersion",
        ]);
        return mutation("update", {
          ...options,
          id: targetId(target, model.id),
          values,
        });
      },
      delete: async (target: unknown, options: Record<string, unknown>) => {
        keys(object(options), ["effectiveStart", "idempotencyKey", "notes", "ifVersion"]);
        return mutation("delete", {
          ...options,
          id: targetId(target, model.id),
        });
      },
      writes: {
        create: (values: unknown, options: Record<string, unknown> = {}) => {
          keys(object(options), ["id", "metadataPatch"]);
          return prepare("create", { ...options, values });
        },
        update: (target: unknown, values: unknown, options: Record<string, unknown> = {}) => {
          keys(object(options), ["metadataPatch", "clear", "ifVersion"]);
          return prepare("update", {
            ...options,
            id: targetId(target, model.id),
            values,
          });
        },
        delete: (target: unknown, options: Record<string, unknown> = {}) => {
          keys(object(options), ["ifVersion"]);
          return prepare("delete", {
            ...options,
            id: targetId(target, model.id),
          });
        },
      },
      history: async (input: { id: string; asOf?: string; limit?: number }) => {
        keys(object(input), ["id", "asOf", "limit"]);
        id(input.id);
        if (input.asOf) date(input.asOf);
        if (
          input.limit !== undefined &&
          (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
        )
          invalid("history limit");
        await context.authorize(`${model.id}.history`);
        return context.transaction(async (db) =>
          decodeHistory(
            await db.call("kernel_field_history", {
              model_id: model.id,
              record_id: input.id,
              as_of: input.asOf,
              limit: input.limit ?? 50,
            }),
          ),
        );
      },
      relations: Object.fromEntries(
        model.relations.map((relation) => [
          relation.name,
          {
            list: async (input: QueryInput & { id: string }) => {
              const { id: recordId, ...rest } = input;
              id(recordId);
              const target = models.get(relation.model)!;
              if (definition.capabilities?.authorization === true) {
                if (!relation.id) invalid("relation authorization metadata is unavailable");
                await context.authorize(`${model.id}.relations.${relation.id}.list`);
                return query(target, rest, "list", undefined, {
                  model_id: model.id,
                  relation_id: relation.id,
                  record_id: recordId,
                });
              }
              const through = fieldsByModel.get(relation.model)!.get(relation.through)!;
              return query(
                target,
                {
                  ...rest,
                  where: [
                    ...(rest.where ?? []),
                    { field: through.name, op: "eq", value: recordId },
                  ],
                },
                "list",
              );
            },
          },
        ]),
      ),
    };
    for (const alias of model.aliases ?? []) result[alias] = result[model.name]!;
  }
  return result as DataClient<D>;
}
