import { createHash } from "node:crypto";
import type { DataContext, DataDefinition } from "@autograph/generated-app-runtime/data";
import { buildWorkspaceWrites, type WorkspaceDraft } from "@autograph/csv-workspace/draft";
import { maxImportRows, type MappedImportRow } from "@autograph/csv-workspace/mapping";
import { createLabelIndex, encodeCell } from "./labels";

export type RecordImport = {
  model: string;
  asOf: string;
  requestId: string;
  rows: MappedImportRow[];
};

/** Prepare ordinary kernel writes; neither this helper nor an MCP proposal grants write authority. */
export function prepareRecordImport(definition: DataDefinition, input: RecordImport) {
  if (
    !input ||
    typeof input !== "object" ||
    typeof input.model !== "string" ||
    typeof input.asOf !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(input.asOf) ||
    !Number.isFinite(Date.parse(input.asOf)) ||
    new Date(input.asOf).toISOString().slice(0, 10) !== input.asOf ||
    typeof input.requestId !== "string" ||
    !/^[a-zA-Z0-9-]{16,128}$/.test(input.requestId) ||
    !Array.isArray(input.rows) ||
    !input.rows.length ||
    input.rows.length > maxImportRows
  )
    throw new Error("Invalid record import; choose a valid date and 1–100 rows.");
  if (new TextEncoder().encode(JSON.stringify(input)).length > 768 * 1024)
    throw new Error("Import exceeds 768 KiB.");
  const labels = createLabelIndex(definition);
  const model = labels.model(input.model);
  const externalKeys = new Set<string>();
  const normalizedRows: MappedImportRow[] = [];
  const draft: WorkspaceDraft = {
    revision: 0,
    rows: input.rows.map((row, index) => {
      if (!row || !row.values || typeof row.values !== "object" || Array.isArray(row.values))
        throw new Error(`Row ${index + 1}: expected field values.`);
      if (row.externalKey !== undefined) {
        if (
          typeof row.externalKey !== "string" ||
          !row.externalKey.trim() ||
          externalKeys.has(row.externalKey)
        )
          throw new Error(`Row ${index + 1}: empty or duplicate external key.`);
        externalKeys.add(row.externalKey);
      }
      const values: WorkspaceDraft["rows"][number]["values"] = {};
      const clearFields: string[] = [];
      const touched = new Set<string>();
      const normalized: MappedImportRow = {
        values: {},
        ...(row.externalKey === undefined ? {} : { externalKey: row.externalKey }),
      };
      normalizedRows.push(normalized);
      for (const [name, original] of Object.entries(row.values)) {
        const field = labels.field(model, name);
        if (field.readOnly || field.lifecycle === "retired" || field.storage === "custom")
          throw new Error(`Field ${name} is not available for record entry.`);
        if (touched.has(field.id)) throw new Error(`Field ${name} is mapped more than once.`);
        touched.add(field.id);
        Object.defineProperty(normalized.values, field.id, { value: original, enumerable: true });
        let value = original;
        if (typeof value === "string" && field.type === "bool") {
          if (!/^(true|false)$/i.test(value)) throw new Error(`${name}: use true or false.`);
          value = value.toLowerCase() === "true";
        }
        if (
          typeof value === "string" &&
          ["json", "money_rate", "relation_list", "text_list", "known_aliases"].includes(field.type)
        ) {
          try {
            value = JSON.parse(value);
          } catch {
            throw new Error(`${name}: enter valid JSON.`);
          }
        }
        const encoded = encodeCell(labels, field, value);
        if (encoded === null) clearFields.push(field.id);
        else Object.defineProperty(values, field.id, { value: encoded, enumerable: true });
      }
      if (!touched.size) throw new Error(`Row ${index + 1}: enter at least one field.`);
      // External keys may address an existing record, where omitted fields stay unchanged.
      if (row.externalKey === undefined) {
        for (const field of model.fields) {
          if (
            field.required &&
            !field.readOnly &&
            !field.aliasOf &&
            field.lifecycle !== "retired" &&
            !Object.hasOwn(values, field.id)
          )
            throw new Error(
              `Row ${index + 1}: ${String(field.label ?? field.name)} is required for a new record.`,
            );
        }
      }
      const bytes = createHash("sha256")
        .update(JSON.stringify([input.requestId, model.id, index]))
        .digest();
      bytes[6] = (bytes[6]! & 0x0f) | 0x40;
      bytes[8] = (bytes[8]! & 0x3f) | 0x80;
      const hex = bytes.subarray(0, 16).toString("hex");
      return {
        rowId: String(index),
        modelId: model.id,
        recordId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
        operation: "create",
        effectiveStart: input.asOf,
        values,
        clearFields,
      };
    }),
  };
  const writes = buildWorkspaceWrites(draft).map((write, index) => {
    const externalKey = input.rows[index]!.externalKey;
    if (externalKey === undefined) return write;
    const { new_record_id: _id, ...rest } = write;
    return { ...rest, record_key: { type: "external_key" as const, value: externalKey } };
  });
  return { model, writes, input: { ...input, model: model.id, rows: normalizedRows } };
}

/** Member write composition. The host supplies authority; the kernel enforces the actor boundary. */
export async function applyRecordImport(
  definition: DataDefinition,
  context: DataContext,
  input: RecordImport,
  options: { preview?: boolean; mode?: "mainline" | "draft"; schemaRevisionId?: string } = {},
) {
  const { model, writes } = prepareRecordImport(definition, input);
  await context.authorize(`${model.id}.create`);
  if (input.rows.some((row) => row.externalKey !== undefined))
    await context.authorize(`${model.id}.update`);
  return context.transaction(async (db) => {
    const active = (await db.call("kernel_read_active_schema_revision", {})) as {
      schema_revision_id: string;
    };
    const schemaRevisionId = options.schemaRevisionId ?? String(active.schema_revision_id);
    const request = {
      schema_revision_id: schemaRevisionId,
      actor_id: db.actorId,
      source_kind: db.sourceKind,
      mode: options.mode ?? "mainline",
      idempotency_key: input.requestId,
      writes,
    };
    const result = (await db.call(
      options.preview ? "kernel_validate_change_set_dry_run" : "kernel_apply_change_set",
      request,
    )) as { id: number };
    return { changeSetId: result.id, schemaRevisionId, count: writes.length };
  });
}
