import type { EnumOption, ModelKind } from "@contracts";
import type { FieldGroupDefinition } from "@engines/field-groups";

export type LookupSeedRowValue = string | number | boolean | null | Array<string | number>;

export type LookupSeedRow = {
  external_key: string;
  values: Record<string, LookupSeedRowValue>;
};

export type ScalarFieldType =
  | "text"
  | "number"
  | "bool"
  | "date"
  | "datetime"
  | "text_list"
  | "known_aliases"
  | "json"
  | "iso_country"
  | "iso_currency"
  | "money_rate";

export type ScalarFieldDefinition = {
  type: ScalarFieldType;
  label?: string;
  notes?: string;
  is_unique?: boolean;
};

export type EnumFieldDefinition = {
  type: "enum";
  option_set: readonly EnumOption[];
  label?: string;
  notes?: string;
};

export type RelationFieldDefinition = {
  target_model: string;
  is_multi_value?: boolean;
  label?: string;
  notes?: string;
  is_unique?: boolean;
};

export type FieldDefinition = ScalarFieldDefinition | EnumFieldDefinition | RelationFieldDefinition;

export type FieldGroup = Record<string, FieldDefinition>;

export type InverseRelationDefinition = {
  id: string;
  model: string;
  through: string;
  label?: string;
  notes?: string;
};

export type ModelBlockKind = ModelKind;

export type ModelBlock = {
  name: string;
  kind: ModelBlockKind;
  label?: string;
  fields: FieldGroup;
  field_groups?: readonly FieldGroupDefinition[];
  inverse_relations?: readonly InverseRelationDefinition[];
  related?: ModelBlock[];
  seed_rows?: readonly LookupSeedRow[];
};

export type ModelBlockRegistry = Map<string, ModelBlock>;

/** Domain declaration for deterministic effective-dated relationship reconciliation. */
export type ImportReconciliationPolicy = {
  modelId: string;
  subjectRelationAlternatives: readonly (readonly string[])[];
  exclusiveRelationGroups: readonly (readonly string[])[];
  effectiveStartFieldId: string;
  effectiveEndFieldId: string | null;
};

export type CatalogSource = {
  package: string;
  blocks: readonly ModelBlock[];
};

export type CatalogArtifact = {
  domain_catalog: {
    version: 1;
    model_count: number;
    models: Record<string, CatalogModel>;
  };
};

export type CatalogModel = {
  id: string;
  source_package: string;
  kind: ModelBlock["kind"];
  label: string;
  notes?: string;
  field_order: string[];
  field_groups: readonly FieldGroupDefinition[];
  fields: Record<string, CatalogField>;
  inverse_relations: NonNullable<ModelBlock["inverse_relations"]>;
  seed_rows: NonNullable<ModelBlock["seed_rows"]>;
};

export type CatalogField = {
  type: ScalarFieldType | "enum" | "relation" | "known_aliases";
  label: string;
  target_model?: string;
  is_multi_value?: boolean;
  notes?: string;
  is_unique?: boolean;
  option_set?: readonly { id: string; label: string; aliases: readonly string[] }[];
};
