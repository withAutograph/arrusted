import type {
  CatalogArtifact,
  CatalogField,
  CatalogModel,
  CatalogSource,
  FieldDefinition,
  InverseRelationDefinition,
  ModelBlock,
} from "./types";

export type * from "./types";

const MODEL_BLOCK_PROPERTIES = {
  name: true,
  kind: true,
  label: true,
  fields: true,
  field_groups: true,
  inverse_relations: true,
  related: true,
  seed_rows: true,
} satisfies Record<keyof ModelBlock, true>;
const MODEL_BLOCK_KEYS = new Set(Object.keys(MODEL_BLOCK_PROPERTIES));
const INVERSE_RELATION_PROPERTIES = {
  id: true,
  model: true,
  through: true,
  label: true,
  notes: true,
} satisfies Record<keyof InverseRelationDefinition, true>;
const INVERSE_RELATION_KEYS = new Set(Object.keys(INVERSE_RELATION_PROPERTIES));
const SCALAR_FIELD_KEYS = new Set(["type", "label", "notes", "is_unique"]);
const ENUM_FIELD_KEYS = new Set(["type", "label", "notes", "option_set"]);
const RELATION_FIELD_KEYS = new Set([
  "target_model",
  "label",
  "notes",
  "is_unique",
  "is_multi_value",
]);
const ENUM_OPTION_KEYS = new Set(["id", "label", "aliases"]);
const SEED_ROW_KEYS = new Set(["external_key", "values"]);

export function collectCatalogBlocks(blocks: readonly ModelBlock[]): Map<string, ModelBlock> {
  const catalog = new Map<string, ModelBlock>();
  collectCatalogBlockEntries(blocks, catalog, "catalog");
  validateInverseRelations(catalog);
  validateRelationTargets(catalog);
  return catalog;
}

export function buildCatalogArtifact(sources: readonly CatalogSource[]): CatalogArtifact {
  const sourceByModel = new Map<string, string>();
  const roots: ModelBlock[] = [];

  for (const source of sources) {
    if (!source.package.startsWith("@domain-libs/")) {
      throw new Error(`catalog source package ${source.package} must be a @domain-libs package`);
    }
    collectSourceModels(
      source.blocks,
      source.package,
      sourceByModel,
      roots,
      `sources.${source.package}.blocks`,
    );
  }

  const catalog = collectCatalogBlocks(roots);
  const models = Object.fromEntries(
    [...catalog].map(([modelId, block]) => {
      const sourcePackage = sourceByModel.get(modelId);
      if (!sourcePackage) throw new Error(`catalog model ${modelId} has no source package`);
      return [modelId, serializeModel(block, sourcePackage)];
    }),
  );

  return { domain_catalog: { version: 1, model_count: catalog.size, models } };
}

function collectCatalogBlockEntries(
  blocks: readonly ModelBlock[],
  catalog: Map<string, ModelBlock>,
  path: string,
): void {
  assertArray(blocks, path);
  for (const [index, block] of blocks.entries()) {
    const blockPath = `${path}[${index}]`;
    validateModelBlockShape(block, blockPath);
    if (catalog.has(block.name)) {
      throw new Error(`${blockPath}.name duplicates catalog model ${block.name}`);
    }
    catalog.set(block.name, block);
    collectCatalogBlockEntries(block.related ?? [], catalog, `${blockPath}.related`);
  }
}

function collectSourceModels(
  blocks: readonly ModelBlock[],
  sourcePackage: string,
  sourceByModel: Map<string, string>,
  roots: ModelBlock[],
  path: string,
): void {
  assertArray(blocks, path);
  for (const [index, block] of blocks.entries()) {
    const blockPath = `${path}[${index}]`;
    validateModelBlockShape(block, blockPath);
    const existingSource = sourceByModel.get(block.name);
    if (existingSource) {
      throw new Error(
        `catalog model ${block.name} is exported by both ${existingSource} and ${sourcePackage}`,
      );
    }
    sourceByModel.set(block.name, sourcePackage);
    roots.push({ ...block, related: undefined });
    collectSourceModels(
      block.related ?? [],
      sourcePackage,
      sourceByModel,
      roots,
      `${blockPath}.related`,
    );
  }
}

function validateModelBlockShape(block: ModelBlock, path: string): void {
  assertRecord(block, path);
  rejectUnexpectedKeys(block, MODEL_BLOCK_KEYS, path, "ModelBlock");
  assertString(block.name, `${path}.name`);
  if (block.kind !== "entity" && block.kind !== "lookup") {
    throw new Error(`${path}.kind must be entity or lookup`);
  }
  if (block.label !== undefined) assertString(block.label, `${path}.label`);
  assertRecord(block.fields, `${path}.fields`);
  for (const [fieldId, field] of Object.entries(block.fields)) {
    validateFieldDefinition(field, `${path}.fields.${fieldId}`);
  }
  if (block.related !== undefined) assertArray(block.related, `${path}.related`);
  if (block.seed_rows !== undefined) {
    assertArray(block.seed_rows, `${path}.seed_rows`);
    for (const [index, row] of block.seed_rows.entries()) {
      validateSeedRow(row, block, `${path}.seed_rows[${index}]`);
    }
  }
  if (block.inverse_relations === undefined) return;

  assertArray(block.inverse_relations, `${path}.inverse_relations`);
  const inverseIds: string[] = [];
  for (const [index, inverse] of block.inverse_relations.entries()) {
    const inversePath = `${path}.inverse_relations[${index}]`;
    assertRecord(inverse, inversePath);
    rejectUnexpectedKeys(inverse, INVERSE_RELATION_KEYS, inversePath, "InverseRelationDefinition");
    assertString(inverse.id, `${inversePath}.id`);
    assertString(inverse.model, `${inversePath}.model`);
    assertString(inverse.through, `${inversePath}.through`);
    if (inverse.label !== undefined) assertString(inverse.label, `${inversePath}.label`);
    if (inverse.notes !== undefined) assertString(inverse.notes, `${inversePath}.notes`);
    inverseIds.push(inverse.id);
  }
  assertUniqueIds(inverseIds, `${path}.inverse_relations`);
}

function validateRelationTargets(catalog: ReadonlyMap<string, ModelBlock>): void {
  for (const [modelId, model] of catalog) {
    for (const [fieldId, field] of Object.entries(model.fields)) {
      if ("target_model" in field && !catalog.has(field.target_model)) {
        throw new Error(
          `catalog.${modelId}.fields.${fieldId}.target_model ${field.target_model} does not resolve`,
        );
      }
    }
  }
}

function validateInverseRelations(catalog: ReadonlyMap<string, ModelBlock>): void {
  for (const [ownerModel, owner] of catalog) {
    for (const inverse of owner.inverse_relations ?? []) {
      const path = `catalog.${ownerModel}.inverse_relations.${inverse.id}`;
      if (inverse.id in owner.fields) {
        throw new Error(`${path} duplicates persisted field ${ownerModel}.${inverse.id}`);
      }

      const child = catalog.get(inverse.model);
      if (!child) {
        throw new Error(`${path}.model ${inverse.model} does not resolve`);
      }
      const through = child.fields[inverse.through];
      if (!through) {
        throw new Error(`${path}.through ${inverse.model}.${inverse.through} does not resolve`);
      }
      if (!("target_model" in through) || through.is_multi_value === true) {
        throw new Error(
          `${path}.through ${inverse.model}.${inverse.through} must be a scalar relation back to ${ownerModel}`,
        );
      }
      if (through.target_model !== ownerModel) {
        throw new Error(
          `${path}.through ${inverse.model}.${inverse.through} targets ${through.target_model}, not owner ${ownerModel}`,
        );
      }
    }
  }
}

function validateFieldDefinition(value: unknown, path: string): void {
  assertRecord(value, path);
  if ("target_model" in value) {
    rejectUnexpectedKeys(value, RELATION_FIELD_KEYS, path, "RelationFieldDefinition");
    assertString(value.target_model, `${path}.target_model`);
    if (value.is_multi_value !== undefined) {
      assertBoolean(value.is_multi_value, `${path}.is_multi_value`);
    }
  } else if (value.type === "enum") {
    rejectUnexpectedKeys(value, ENUM_FIELD_KEYS, path, "EnumFieldDefinition");
    assertArray(value.option_set, `${path}.option_set`);
    for (const [index, option] of value.option_set.entries()) {
      const optionPath = `${path}.option_set[${index}]`;
      assertRecord(option, optionPath);
      rejectUnexpectedKeys(option, ENUM_OPTION_KEYS, optionPath, "EnumOption");
      assertString(option.id, `${optionPath}.id`);
      assertString(option.label, `${optionPath}.label`);
      assertArray(option.aliases, `${optionPath}.aliases`);
      for (const [aliasIndex, alias] of option.aliases.entries()) {
        assertString(alias, `${optionPath}.aliases[${aliasIndex}]`);
      }
    }
  } else {
    rejectUnexpectedKeys(value, SCALAR_FIELD_KEYS, path, "ScalarFieldDefinition");
    assertString(value.type, `${path}.type`);
  }

  if (value.label !== undefined) assertString(value.label, `${path}.label`);
  if (value.notes !== undefined) assertString(value.notes, `${path}.notes`);
  if (value.is_unique !== undefined) assertBoolean(value.is_unique, `${path}.is_unique`);
}

function validateSeedRow(value: unknown, block: ModelBlock, path: string): void {
  assertRecord(value, path);
  rejectUnexpectedKeys(value, SEED_ROW_KEYS, path, "LookupSeedRow");
  assertString(value.external_key, `${path}.external_key`);
  assertRecord(value.values, `${path}.values`);
  for (const [fieldId, fieldValue] of Object.entries(value.values)) {
    const field = block.fields[fieldId];
    if (!field) {
      throw new Error(`${path}.values.${fieldId} does not resolve in ${block.name}`);
    }
    if (!isSeedValue(fieldValue) || !seedValueMatchesField(fieldValue, field)) {
      throw new Error(`${path}.values.${fieldId} does not match its field definition`);
    }
  }
}

function seedValueMatchesField(value: unknown, field: ModelBlock["fields"][string]): boolean {
  if (value === null) return true;
  if ("target_model" in field) return typeof value === "string";
  if (field.type === "enum") {
    return typeof value === "string" && field.option_set.some((option) => option.id === value);
  }
  switch (field.type) {
    case "number":
      return typeof value === "string";
    case "bool":
      return typeof value === "boolean";
    case "text_list":
      return Array.isArray(value) && value.every((item) => typeof item === "string");
    case "json":
      return true;
    case "money_rate":
      return false;
    default:
      return typeof value === "string";
  }
}

function isSeedValue(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    (Array.isArray(value) &&
      value.every((item) => typeof item === "string" || typeof item === "number"))
  );
}

function serializeModel(block: ModelBlock, sourcePackage: string): CatalogModel {
  return {
    id: block.name,
    source_package: sourcePackage,
    kind: block.kind,
    label: block.label ?? titleCase(block.name),
    field_order: Object.keys(block.fields),
    field_groups: [...(block.field_groups ?? [])],
    fields: Object.fromEntries(
      Object.entries(block.fields).map(([fieldId, field]) => [
        fieldId,
        serializeField(fieldId, field),
      ]),
    ),
    inverse_relations: [...(block.inverse_relations ?? [])],
    seed_rows: [...(block.seed_rows ?? [])],
  };
}

function serializeField(fieldId: string, field: FieldDefinition): CatalogField {
  if (!("target_model" in field)) {
    return {
      type: fieldId === "known_aliases" ? "known_aliases" : field.type,
      label: field.label ?? titleCase(fieldId),
      ...(field.notes === undefined ? {} : { notes: field.notes }),
      ...("is_unique" in field && field.is_unique !== undefined
        ? { is_unique: field.is_unique }
        : {}),
      ...("option_set" in field
        ? {
            option_set: field.option_set.map((option) => ({
              ...option,
              aliases: option.aliases ?? [],
            })),
          }
        : {}),
    };
  }
  return {
    type: "relation",
    label: field.label ?? titleCase(fieldId),
    target_model: field.target_model,
    ...(field.is_multi_value === undefined ? {} : { is_multi_value: field.is_multi_value }),
    ...(field.notes === undefined ? {} : { notes: field.notes }),
    ...(field.is_unique === undefined ? {} : { is_unique: field.is_unique }),
  };
}

function titleCase(value: string): string {
  return value
    .split("_")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function rejectUnexpectedKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  path: string,
  definitionName: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`${path}.${key} is not a ${definitionName} property`);
    }
  }
}

function assertRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
}

function assertArray(value: unknown, path: string): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
}

function assertString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
}

function assertBoolean(value: unknown, path: string): asserts value is boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
}

function assertUniqueIds(values: readonly string[], path: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`${path}.${value} must not be declared more than once`);
    }
    seen.add(value);
  }
}
