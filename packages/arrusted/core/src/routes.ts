import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  createDataClient,
  type DataDefinition,
  type DataField,
  type DataModel,
} from "../../../generated-app-runtime/data";
import { KernelFailure } from "../../../generated-app-runtime/postgres";
import type { GeneratedAppRuntime } from "../../../generated-app-runtime/server";
import type {
  AppliedChangeSet,
  ErrorEnvelope,
  Field,
  FieldType,
  FieldValue,
  RowVersionWrite,
  Schema,
  VisibleRecord,
} from "../../../contracts/index";
import {
  createLabelIndex,
  encodeCell,
  fieldHeader,
  modelLabel,
} from "../../../work-session-tools/labels";

const SHOWN_FIELD_TYPES = new Set<string>([
  "text",
  "number",
  "bool",
  "date",
  "datetime",
  "relation",
  "text_list",
  "known_aliases",
  "json",
  "enum",
  "iso_country",
  "iso_currency",
  "money_rate",
]);

export type SchemaAuthorizationGrant = {
  role: string;
  model: string;
  operations: readonly string[];
  record?: { kind: string; field?: string };
  read_fields?: readonly string[];
  write_fields?: readonly string[];
};

type ArtifactMetadata = {
  changeTypes: Schema["change_types"];
  grants: readonly SchemaAuthorizationGrant[] | undefined;
};

function loadArtifactMetadata(releaseDirectory?: string): ArtifactMetadata | undefined {
  const dir = releaseDirectory ?? path.resolve(process.cwd(), ".generated/release");
  const artifactPath = path.join(dir, "app-artifact.json");
  if (!existsSync(artifactPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(artifactPath, "utf8")) as {
      schema?: {
        change_types?: Schema["change_types"];
        authorization?: { grants?: SchemaAuthorizationGrant[] };
      };
      extras?: {
        authorization_policy?: { grants?: SchemaAuthorizationGrant[] };
      };
    };
    const rawGrants =
      parsed.extras?.authorization_policy?.grants ?? parsed.schema?.authorization?.grants;
    return {
      changeTypes: Array.isArray(parsed.schema?.change_types) ? parsed.schema.change_types : [],
      grants: Array.isArray(rawGrants) ? rawGrants : undefined,
    };
  } catch {
    return undefined;
  }
}

function shownModelFields(model: DataModel): DataField[] {
  return model.fields.filter(
    (field) =>
      SHOWN_FIELD_TYPES.has(field.type) &&
      field.storage !== "custom" &&
      field.lifecycle !== "retired" &&
      !field.aliasOf,
  );
}

function readableFieldIdsForRole(
  grants: readonly SchemaAuthorizationGrant[],
  role: string,
  modelId: string,
): Set<string> | null {
  const matching = grants.filter(
    (grant) => grant.role === role && grant.model === modelId && grant.operations.includes("read"),
  );
  if (matching.length === 0) return null;
  const unconditional = matching.filter((grant) => !grant.record || grant.record.kind === "all");
  const effective = unconditional.length > 0 ? unconditional : matching;
  if (
    unconditional.length === 0 &&
    new Set(effective.map((grant) => `${grant.record?.kind ?? "all"}:${grant.record?.field ?? ""}`))
      .size > 1
  ) {
    return null;
  }
  const ids = new Set<string>();
  for (const grant of effective) {
    for (const fieldId of grant.read_fields ?? []) ids.add(fieldId);
  }
  return ids;
}

export function gridSchema(
  definition: DataDefinition,
  options?: {
    appId?: string;
    customerId?: string;
    role?: string;
    grants?: readonly SchemaAuthorizationGrant[];
    changeTypes?: Schema["change_types"];
  },
): Schema {
  const policyEnabled = definition.capabilities?.authorization === true;
  const role = options?.role?.trim() || undefined;
  if (policyEnabled && (!role || options?.grants === undefined)) {
    throw new KernelFailure({
      code: "authorization_denied",
      message: "Policy-enabled schemas require role and resolved authorization grants.",
      details: [],
    });
  }
  const grants = options?.grants ?? [];
  const filterByRole = policyEnabled || Boolean(role && options?.grants !== undefined);
  const models: Schema["models"] = [];

  for (const model of definition.models) {
    const readableIds =
      filterByRole && role ? readableFieldIdsForRole(grants, role, model.id) : undefined;
    if (readableIds === null || (readableIds && !readableIds.has("$id"))) continue;
    const fields = shownModelFields(model)
      .filter((field) => (readableIds ? readableIds.has(field.id) : true))
      .map((field): Field => ({
        id: field.id,
        label: fieldHeader(field),
        type: field.type as FieldType,
        required: field.required,
        ...(typeof field.target_model === "string" ? { target_model: field.target_model } : {}),
        ...(Array.isArray(field.option_set)
          ? {
              option_set: field.option_set.map((option) => ({
                id: option.id,
                label: typeof option.label === "string" ? option.label : option.id,
                ...(option.lifecycle === "active" || option.lifecycle === "retired"
                  ? { lifecycle: option.lifecycle }
                  : {}),
              })),
            }
          : {}),
      }));
    models.push({
      id: model.id,
      kind: model.kind === "lookup" ? "lookup" : "entity",
      label: modelLabel(model),
      fields,
    });
  }

  return {
    app_id: options?.appId ?? "app",
    customer_id: options?.customerId ?? "default",
    version: definition.schemaVersion,
    change_types: options?.changeTypes ?? [],
    models,
  };
}

export function toVisibleRecord(
  definition: DataDefinition,
  model: DataModel,
  record: Record<string, unknown>,
  asOf: string,
): VisibleRecord {
  if (typeof record.id !== "string" || record.id.length === 0) {
    throw new KernelFailure({
      code: "authorization_denied",
      message: `Visible record for model '${model.id}' requires readable '$id'.`,
      details: [],
    });
  }
  const labels = createLabelIndex(definition);
  const values: Record<string, FieldValue> = {};
  for (const field of shownModelFields(model)) {
    const raw = record[field.name];
    if (raw === null || raw === undefined) continue;
    const encoded = encodeCell(labels, field, raw);
    if (encoded !== null) values[field.id] = encoded;
  }
  const effectiveStart =
    typeof record.effectiveStart === "string" && record.effectiveStart.length > 0
      ? record.effectiveStart
      : asOf;
  return {
    record_id: record.id,
    ...(typeof record.$version === "string" ? { version_id: record.$version } : {}),
    effective_start: effectiveStart,
    values,
    custom_fields: [],
  };
}

function deterministicCreateUuid(
  appId: string,
  customerId: string,
  idempotencyKey: string,
  writeIndex: number,
): string {
  const hex = createHash("sha256")
    .update(JSON.stringify([appId, customerId, idempotencyKey, writeIndex]))
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function errorResponse(error: unknown): Response {
  if (error instanceof KernelFailure) {
    const code = error.envelope.code;
    const status =
      code === "authorization_denied" || code === "forbidden"
        ? 403
        : code === "record_target_missing"
          ? 404
          : code === "version_conflict" || code === "unique_field_conflict"
            ? 409
            : 400;
    return Response.json(error.envelope, { status });
  }
  if (error && typeof error === "object" && "status" in error) {
    const errRecord = error as Record<string, unknown>;
    const status = typeof errRecord.status === "number" ? errRecord.status : 401;
    const code =
      typeof errRecord.code === "string"
        ? errRecord.code
        : status === 403
          ? "forbidden"
          : "auth_required";
    const message = error instanceof Error ? error.message : "Authentication required";
    const envelope: ErrorEnvelope = { code, message, details: [] };
    return Response.json(envelope, { status });
  }
  if (error instanceof SyntaxError) {
    const envelope: ErrorEnvelope = {
      code: "bad_request",
      message: "Invalid JSON request body.",
      details: [],
    };
    return Response.json(envelope, { status: 400 });
  }
  const envelope: ErrorEnvelope = {
    code: "internal_error",
    message: "Request failed",
    details: [],
  };
  return Response.json(envelope, { status: 500 });
}

export type AppRoutesConfig = {
  runtime: GeneratedAppRuntime;
  definition: DataDefinition;
  session: (headers: Headers) => Promise<{ actorId: string; customerId: string }>;
  releaseDirectory?: string;
  role?: string;
  grants?: readonly SchemaAuthorizationGrant[];
};

export function createAppRoutes(config: AppRoutesConfig) {
  const policyEnabled = config.definition.capabilities?.authorization === true;
  const role = config.role?.trim() || process.env.APP_KERNEL_ROLE?.trim() || undefined;
  const artifactMeta = loadArtifactMetadata(config.releaseDirectory);
  const resolvedGrants = config.grants ?? artifactMeta?.grants;
  const staticChangeTypeIds =
    (config.definition as { staticIds?: { changeTypes?: readonly string[] } }).staticIds
      ?.changeTypes ?? [];
  const declaredChangeTypeIds = new Set([
    ...(artifactMeta?.changeTypes ?? []).map((changeType) => changeType.id),
    ...staticChangeTypeIds,
  ]);

  const selectForModel = (model: DataModel): string[] | undefined => {
    if (policyEnabled && (!role || resolvedGrants === undefined)) {
      throw new KernelFailure({
        code: "authorization_denied",
        message: "Policy-enabled schemas require role and resolved authorization grants.",
        details: [],
      });
    }
    if (!role || resolvedGrants === undefined) return undefined;
    const readableIds = readableFieldIdsForRole(resolvedGrants, role, model.id);
    if (readableIds === null || !readableIds.has("$id")) {
      throw new KernelFailure({
        code: "authorization_denied",
        message: "Read is not authorized by the current grants",
        details: [
          {
            path: "grants",
            code: "grant_not_authorized",
            message:
              readableIds === null
                ? `no applicable authorization grant permits role '${role}' to read model '${model.id}'`
                : `read grant for role '${role}' on model '${model.id}' must include '$id'`,
          },
        ],
      });
    }
    const select: string[] = ["id"];
    if (
      readableIds.has("$version") &&
      config.definition.capabilities?.versionPreconditions === true
    ) {
      select.push("$version");
    }
    if (readableIds.has("$externalKey")) select.push("externalKey");
    for (const field of shownModelFields(model)) {
      if (readableIds.has(field.id)) select.push(field.name);
    }
    return select;
  };

  return {
    async schemaActiveGET(request: Request): Promise<Response> {
      try {
        const { customerId } = await config.session(request.headers);
        if (customerId !== config.runtime.customerId) {
          return Response.json(
            { code: "forbidden", message: "Organization scope mismatch.", details: [] },
            { status: 403 },
          );
        }
        const schema = gridSchema(config.definition, {
          appId: config.runtime.appId,
          customerId: config.runtime.customerId,
          ...(role ? { role } : {}),
          ...(resolvedGrants !== undefined ? { grants: resolvedGrants } : {}),
          ...(artifactMeta?.changeTypes ? { changeTypes: artifactMeta.changeTypes } : {}),
        });
        return Response.json({ schema });
      } catch (error) {
        return errorResponse(error);
      }
    },

    async recordsGET(request: Request): Promise<Response> {
      try {
        const { actorId, customerId } = await config.session(request.headers);
        if (customerId !== config.runtime.customerId) {
          return Response.json(
            { code: "forbidden", message: "Organization scope mismatch.", details: [] },
            { status: 403 },
          );
        }
        const url = new URL(request.url);
        const modelId = url.searchParams.get("model_id")?.trim() ?? "";
        const asOf = url.searchParams.get("as_of")?.trim() ?? "";
        if (!modelId || !/^\d{4}-\d{2}-\d{2}$/u.test(asOf)) {
          return Response.json(
            {
              code: "contract_validation_failed",
              message: "Query parameters model_id and as_of (YYYY-MM-DD) are required.",
              details: [],
            },
            { status: 400 },
          );
        }
        const model = config.definition.models.find((candidate) => candidate.id === modelId);
        if (!model) {
          return Response.json(
            {
              code: "record_target_missing",
              message: `Model '${modelId}' is not declared in active schema.`,
              details: [],
            },
            { status: 404 },
          );
        }
        const select = selectForModel(model);
        const context = config.runtime.dataContext({
          actorId,
          sourceKind: "human",
          authorize: async () => {},
        });
        const client = createDataClient(config.definition, context) as Record<
          string,
          {
            list: (input: {
              asOf: string;
              select?: readonly string[];
              where?: readonly { field: string; op: "gt"; value: string }[];
              limit?: number;
            }) => Promise<unknown[]>;
          }
        >;
        const rows = await context.requestTransaction(async () => {
          const collected: Record<string, unknown>[] = [];
          let afterId: string | undefined;
          const pageSize = 100;
          while (true) {
            const page = (await client[model.name]!.list({
              asOf,
              ...(select ? { select } : {}),
              ...(afterId ? { where: [{ field: "id", op: "gt", value: afterId }] } : {}),
              limit: pageSize,
            })) as Record<string, unknown>[];
            collected.push(...page);
            if (page.length < pageSize) break;
            const tailId = page[page.length - 1]?.id;
            if (typeof tailId !== "string" || !tailId) break;
            afterId = tailId;
          }
          return collected;
        });
        const visible = rows.map((row) => toVisibleRecord(config.definition, model, row, asOf));
        return Response.json(visible);
      } catch (error) {
        return errorResponse(error);
      }
    },

    async applyPOST(request: Request): Promise<Response> {
      try {
        const { actorId, customerId } = await config.session(request.headers);
        if (customerId !== config.runtime.customerId) {
          return Response.json(
            { code: "forbidden", message: "Organization scope mismatch.", details: [] },
            { status: 403 },
          );
        }
        const body = (await request.json()) as {
          idempotency_key?: unknown;
          schema_revision_id?: unknown;
          change_type_id?: unknown;
          notes?: unknown;
          writes?: unknown;
        };
        if (
          !body ||
          typeof body !== "object" ||
          typeof body.idempotency_key !== "string" ||
          !body.idempotency_key.trim() ||
          !Array.isArray(body.writes) ||
          body.writes.length === 0
        ) {
          return Response.json(
            {
              code: "contract_validation_failed",
              message: "Apply payload requires a non-empty idempotency_key and writes array.",
              details: [],
            },
            { status: 400 },
          );
        }
        const idempotencyKey = body.idempotency_key.trim();
        const schemaRevisionId =
          typeof body.schema_revision_id === "string" && body.schema_revision_id.trim().length > 0
            ? body.schema_revision_id.trim()
            : undefined;
        const writes = (body.writes as RowVersionWrite[]).map((write, index) => {
          if (!write.record_key && !write.new_record_id) {
            return {
              ...write,
              new_record_id: deterministicCreateUuid(
                config.runtime.appId,
                config.runtime.customerId,
                idempotencyKey,
                index,
              ),
            };
          }
          return write;
        });
        const changeTypeId =
          typeof body.change_type_id === "string" && declaredChangeTypeIds.has(body.change_type_id)
            ? body.change_type_id
            : undefined;
        const notes =
          typeof body.notes === "string" && body.notes.trim().length > 0 ? body.notes : undefined;

        const context = config.runtime.dataContext({
          actorId,
          sourceKind: "human",
          authorize: async () => {},
        });
        const applied = await context.transaction(async (db) => {
          await db.lockSchemaActivation?.();
          return (await db.call("kernel_apply_change_set", {
            actor_id: actorId,
            source_kind: "human",
            idempotency_key: idempotencyKey,
            mode: "mainline",
            ...(schemaRevisionId ? { schema_revision_id: schemaRevisionId } : {}),
            ...(changeTypeId ? { change_type_id: changeTypeId } : {}),
            ...(notes ? { notes } : {}),
            writes,
          })) as AppliedChangeSet;
        });
        return Response.json(applied);
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}
