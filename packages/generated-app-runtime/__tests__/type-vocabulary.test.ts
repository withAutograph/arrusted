import { expect, test } from "vite-plus/test";
import type { FormActionResult } from "@autograph/generated-app-runtime/errors";
import type {
  DataClient,
  DataDefinition,
  ModelCreateField,
  ModelRecord,
  ModelUpdateField,
} from "@autograph/generated-app-runtime/data";

import type {
  AssetCreateField,
  AssetUpdateField,
  CategoryCreateField,
  CategoryUpdateField,
  createOperations,
} from "./asset-operations.generated";

type Operations = ReturnType<typeof createOperations>;
type AssetDefinition = typeof import("./asset-operations.generated").definition;
type FullAssetRecord = ModelRecord<AssetDefinition, "asset">;
type AssetCreateInput = Parameters<Operations["asset"]["create"]>[0];
type AssetUpdateInput = Parameters<Operations["asset"]["update"]>[1];
type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;

const assetCreateField: AssetCreateField = "customSerial";
const assetUpdateField: AssetUpdateField = "customCustodian";
const manyRelationCreateField: CategoryCreateField = "relatedAssets";
const manyRelationUpdateField: CategoryUpdateField = "relatedAssets";
const aliasesMatchWrites: [
  Equal<AssetCreateField, keyof AssetCreateInput>,
  Equal<AssetUpdateField, keyof AssetUpdateInput>,
] = [true, true];

// @ts-expect-error Generated field aliases exclude record identity controls.
const recordIdentity: AssetCreateField = "id";
// @ts-expect-error Generated field aliases exclude optimistic-version controls.
const versionControl: AssetUpdateField = "$version";
// @ts-expect-error Generated field aliases exclude parser clear controls.
const clearControl: AssetUpdateField = "clear:cost";
// @ts-expect-error Retired fields are readable only and cannot be written or parsed.
const retiredField: AssetCreateField = "legacyNote";

declare const assetClient: DataClient<AssetDefinition>;
function proveFullRecordContainers(record: FullAssetRecord) {
  const metadataEntries = Object.entries(record.metadata);
  const relationIds = Object.values(record.manyRelations).flat();
  // @ts-expect-error A decoded full record always contains the metadata object.
  const missingMetadata: FullAssetRecord["metadata"] = undefined;
  // @ts-expect-error A decoded full record always contains the many-relations object.
  const missingManyRelations: FullAssetRecord["manyRelations"] = undefined;
  return [metadataEntries, relationIds, missingMetadata, missingManyRelations];
}
void proveFullRecordContainers;

async function proveSelectedRecordsStayNarrow() {
  const [selected] = await assetClient.asset.list({
    asOf: "2026-09-16",
    select: ["id", "title"] as const,
  });
  if (selected) {
    // @ts-expect-error Selected records omit the full-record metadata container.
    const metadata = selected.metadata;
    // @ts-expect-error Selected records omit the full-record many-relations container.
    const manyRelations = selected.manyRelations;
    return [metadata, manyRelations];
  }
  return undefined;
}
void proveSelectedRecordsStayNarrow;

function proveFormAndWriteVocabulary() {
  const parsed = assetClient.asset.parseForm(new FormData(), {
    fields: ["cost"] as const,
    mode: "update",
  });
  const parsedCost: string | undefined = parsed.values.cost;
  const fieldError = assetClient.asset.toFormError(new Error("fixture"), {
    fields: ["cost"] as const,
  })?.fieldErrors.cost;
  assetClient.asset.writes.update(
    "00000000-0000-0000-0000-000000000001",
    { title: "Cleared field proof" },
    { clear: ["cost"] },
  );
  // @ts-expect-error Retired fields cannot be accepted parser controls.
  assetClient.asset.parseForm(new FormData(), { fields: ["legacyNote"] as const, mode: "update" });
  // @ts-expect-error Required fields cannot be cleared.
  assetClient.asset.writes.update("00000000-0000-0000-0000-000000000001", {}, { clear: ["title"] });
  return [parsedCost, fieldError];
}
void proveFormAndWriteVocabulary;

async function proveModelSpecificRelationVocabulary() {
  const assets = await assetClient.employee.relations.assets.list({
    id: "00000000-0000-0000-0000-000000000001",
    asOf: "2026-09-16",
    select: ["id", "title"] as const,
  });
  const title: string | undefined = assets[0]?.title;
  await assetClient.employee.relations.assets.list({
    id: "00000000-0000-0000-0000-000000000001",
    asOf: "2026-09-16",
    // @ts-expect-error A relation list selects fields from its target model, not its source model.
    select: ["name"] as const,
  });
  return title;
}
void proveModelSpecificRelationVocabulary;

const derivedDefinition = {
  formatVersion: 1,
  schemaVersion: "derived-proof",
  models: [
    {
      id: "projection",
      name: "projection",
      relations: [],
      fields: [
        { id: "editable", name: "editable", type: "text", required: false, readOnly: false },
        { id: "computed", name: "computed", type: "text", required: false, readOnly: true },
      ],
    },
  ],
} as const satisfies DataDefinition;
const editableCreateField: ModelCreateField<typeof derivedDefinition, "projection"> = "editable";
const editableUpdateField: ModelUpdateField<typeof derivedDefinition, "projection"> = "editable";
// @ts-expect-error Derived fields are excluded by the shared Writable predicate.
const derivedCreateField: ModelCreateField<typeof derivedDefinition, "projection"> = "computed";
// @ts-expect-error Derived fields are excluded by the shared Writable predicate.
const derivedUpdateField: ModelUpdateField<typeof derivedDefinition, "projection"> = "computed";

const groupDefinition = {
  formatVersion: 1,
  schemaVersion: "group-value-proof",
  models: [
    {
      id: "groupable",
      name: "groupable",
      relations: [],
      fields: [
        {
          id: "required_text",
          name: "requiredText",
          type: "text",
          required: true,
          readOnly: false,
        },
        {
          id: "optional_text",
          name: "optionalText",
          type: "text",
          required: false,
          readOnly: false,
        },
        {
          id: "retired_text",
          name: "retiredText",
          type: "text",
          required: true,
          readOnly: false,
          lifecycle: "retired",
        },
        { id: "enabled", name: "enabled", type: "bool", required: true, readOnly: false },
        {
          id: "state",
          name: "state",
          type: "enum",
          required: true,
          readOnly: false,
          option_set: [{ id: "ready" }, { id: "blocked" }],
        },
        {
          id: "custom_text",
          name: "customText",
          type: "text",
          required: false,
          readOnly: false,
          storage: "custom",
        },
        { id: "amount", name: "amount", type: "number", required: false, readOnly: false },
        { id: "changed_at", name: "changedAt", type: "datetime", required: false, readOnly: false },
        { id: "attributes", name: "attributes", type: "json", required: false, readOnly: false },
        {
          id: "owner",
          name: "owner",
          type: "relation",
          required: false,
          readOnly: false,
          target_model: "groupable",
        },
        { id: "tags", name: "tags", type: "text_list", required: false, readOnly: false },
        { id: "rate", name: "rate", type: "money_rate", required: false, readOnly: false },
      ],
    },
  ],
} as const satisfies DataDefinition;

declare const groupOperations: DataClient<typeof groupDefinition>;
async function proveGroupValueInference() {
  const enumGroups = await groupOperations.groupable.countBy({
    asOf: "2026-09-16",
    groupBy: "state",
  });
  const boolGroups = await groupOperations.groupable.countBy({
    asOf: "2026-09-16",
    groupBy: "enabled",
  });
  const requiredTextGroups = await groupOperations.groupable.countBy({
    asOf: "2026-09-16",
    groupBy: "requiredText",
  });
  const optionalTextGroups = await groupOperations.groupable.countBy({
    asOf: "2026-09-16",
    groupBy: "optionalText",
  });
  const retiredTextGroups = await groupOperations.groupable.countBy({
    asOf: "2026-09-16",
    groupBy: "retiredText",
  });
  const customTextGroups = await groupOperations.groupable.countBy({
    asOf: "2026-09-16",
    groupBy: "customText",
  });
  const groupByEnumOrBool: "state" | "enabled" = Math.random() > 0.5 ? "state" : "enabled";
  const enumOrBoolGroups = await groupOperations.groupable.countBy({
    asOf: "2026-09-16",
    groupBy: groupByEnumOrBool,
  });
  const groupByOptional: "enabled" | "optionalText" =
    Math.random() > 0.5 ? "enabled" : "optionalText";
  const optionalUnionGroups = await groupOperations.groupable.countBy({
    asOf: "2026-09-16",
    groupBy: groupByOptional,
  });

  const inferredValues: [
    Equal<(typeof enumGroups)[number]["value"], "ready" | "blocked">,
    Equal<(typeof boolGroups)[number]["value"], boolean>,
    Equal<(typeof requiredTextGroups)[number]["value"], string>,
    Equal<(typeof optionalTextGroups)[number]["value"], string | null>,
    Equal<(typeof retiredTextGroups)[number]["value"], string | null>,
    Equal<(typeof customTextGroups)[number]["value"], string | null>,
    Equal<(typeof enumOrBoolGroups)[number]["value"], "ready" | "blocked" | boolean>,
    Equal<(typeof optionalUnionGroups)[number]["value"], boolean | string | null>,
    Equal<(typeof enumGroups)[number]["count"], string>,
  ] = [true, true, true, true, true, true, true, true, true];

  // @ts-expect-error Numeric fields are not valid SQL group fields.
  await groupOperations.groupable.countBy({ asOf: "2026-09-16", groupBy: "amount" });
  // @ts-expect-error Datetime fields are not valid SQL group fields.
  await groupOperations.groupable.countBy({ asOf: "2026-09-16", groupBy: "changedAt" });
  // @ts-expect-error JSON fields are not valid SQL group fields.
  await groupOperations.groupable.countBy({ asOf: "2026-09-16", groupBy: "attributes" });
  // @ts-expect-error Relation fields are not valid SQL group fields.
  await groupOperations.groupable.countBy({ asOf: "2026-09-16", groupBy: "owner" });
  // @ts-expect-error List fields are not valid SQL group fields.
  await groupOperations.groupable.countBy({ asOf: "2026-09-16", groupBy: "tags" });
  // @ts-expect-error Money-rate fields are not valid SQL group fields.
  await groupOperations.groupable.countBy({ asOf: "2026-09-16", groupBy: "rate" });
  // @ts-expect-error Unknown fields are not valid SQL group fields.
  await groupOperations.groupable.countBy({ asOf: "2026-09-16", groupBy: "missing" });
  await groupOperations.groupable.countBy({
    asOf: "2026-09-16",
    groupBy: "state",
    // @ts-expect-error Count operations never accept selection controls.
    select: ["state"] as const,
  });

  return inferredValues;
}
void proveGroupValueInference;

type AssetAction = FormActionResult<AssetCreateField>;
const successfulAction: AssetAction = { ok: true };
const featureState: AssetAction | null = null;
// @ts-expect-error FormActionResult itself has no null/default state.
const missingAction: AssetAction = null;

test("generated aliases are the same writable vocabulary used by create and update", () => {
  expect(assetCreateField).toBe("customSerial");
  expect(assetUpdateField).toBe("customCustodian");
  expect(manyRelationCreateField).toBe("relatedAssets");
  expect(manyRelationUpdateField).toBe("relatedAssets");
  expect(aliasesMatchWrites).toEqual([true, true]);
  expect(editableCreateField).toBe("editable");
  expect(editableUpdateField).toBe("editable");
  expect(successfulAction.ok).toBe(true);
  expect(featureState).toBeNull();
  void recordIdentity;
  void versionControl;
  void clearControl;
  void retiredField;
  void derivedCreateField;
  void derivedUpdateField;
  void missingAction;
});
