import { validateDataTableSpec } from "./DataTable.validation";
import { optionalString, requireArray, requireObject, requireString } from "./spec";
import type {
  RecordDetailFieldSpec,
  RecordDetailItemSpec,
  RecordDetailMetadataSpec,
  RecordDetailNoteSpec,
  RecordDetailOptionSpec,
  RecordDetailSectionSpec,
  RecordDetailSpec,
  RecordDetailTabSpec,
  RecordDetailValue,
} from "./RecordDetailPanel";
import type { StatusPillTone } from "../components/StatusPill";

export function validateRecordDetailSpec(value: unknown): RecordDetailSpec {
  const object = requireObject(value, "record_detail.config");
  rejectUnknownKeys(
    object,
    new Set([
      "title",
      "subtitle",
      "status",
      "metadata",
      "sections",
      "emptyValueLabel",
      "tabs",
      "activeTabId",
    ]),
    "record_detail.config",
  );
  const metadata =
    object.metadata === undefined
      ? undefined
      : requireArray(object.metadata, "record_detail.metadata", validateMetadata);
  const sections = requireArray(object.sections, "record_detail.sections", validateSection);
  const tabs =
    object.tabs === undefined
      ? undefined
      : requireArray(object.tabs, "record_detail.tabs", validateTab);
  assertUniqueIds(metadata ?? [], "record_detail.metadata");
  assertUniqueIds(sections, "record_detail.sections");
  assertUniqueIds(tabs ?? [], "record_detail.tabs");
  assertUniqueIds(
    sections.flatMap((section) => section.items),
    "record_detail section items",
  );
  return {
    title: requireString(object.title, "record_detail.title"),
    subtitle: optionalString(object.subtitle, "record_detail.subtitle"),
    status: validateStatus(object.status),
    metadata,
    sections,
    emptyValueLabel:
      object.emptyValueLabel === undefined
        ? "Not provided"
        : requireString(object.emptyValueLabel, "record_detail.emptyValueLabel"),
    tabs,
    activeTabId: validateActiveTabId(object.activeTabId, tabs),
  };
}

function validateTab(value: unknown, index: number): RecordDetailTabSpec {
  const object = requireObject(value, `record_detail.tabs[${index}]`);
  rejectUnknownKeys(object, new Set(["id", "label"]), `record_detail.tabs[${index}]`);
  return {
    id: requireString(object.id, `record_detail.tabs[${index}].id`),
    label: requireString(object.label, `record_detail.tabs[${index}].label`),
  };
}

function validateActiveTabId(
  value: unknown,
  tabs: RecordDetailTabSpec[] | undefined,
): string | undefined {
  if (value === undefined) return tabs?.[0]?.id;
  const activeTabId = requireString(value, "record_detail.activeTabId");
  if (!tabs?.some((tab) => tab.id === activeTabId)) {
    throw new Error("record_detail.activeTabId must match a configured tab");
  }
  return activeTabId;
}

function validateStatus(value: unknown): RecordDetailSpec["status"] {
  if (value === undefined) return undefined;
  const object = requireObject(value, "record_detail.status");
  rejectUnknownKeys(object, new Set(["label", "tone", "detail"]), "record_detail.status");
  return {
    label: requireString(object.label, "record_detail.status.label"),
    tone: validateTone(object.tone, "record_detail.status.tone"),
    detail: optionalString(object.detail, "record_detail.status.detail"),
  };
}

function validateMetadata(value: unknown, index: number): RecordDetailMetadataSpec {
  const object = requireObject(value, `record_detail.metadata[${index}]`);
  rejectUnknownKeys(object, new Set(["id", "label", "value"]), `record_detail.metadata[${index}]`);
  return {
    id: requireString(object.id, `record_detail.metadata[${index}].id`),
    label: optionalString(object.label, `record_detail.metadata[${index}].label`),
    value: requireString(object.value, `record_detail.metadata[${index}].value`),
  };
}

function validateSection(value: unknown, index: number): RecordDetailSectionSpec {
  const path = `record_detail.sections[${index}]`;
  const object = requireObject(value, path);
  rejectUnknownKeys(object, new Set(["id", "title", "collapsible", "defaultOpen", "items"]), path);
  return {
    id: requireString(object.id, `${path}.id`),
    title: requireString(object.title, `${path}.title`),
    collapsible: optionalBoolean(object.collapsible, `${path}.collapsible`, true),
    defaultOpen: optionalBoolean(object.defaultOpen, `${path}.defaultOpen`, true),
    items: requireArray(object.items, `${path}.items`, (item, itemIndex) =>
      validateItem(item, index, itemIndex),
    ),
  };
}

function validateItem(
  value: unknown,
  sectionIndex: number,
  itemIndex: number,
): RecordDetailItemSpec {
  const path = `record_detail.sections[${sectionIndex}].items[${itemIndex}]`;
  const object = requireObject(value, path);
  if (object.type === "field") return validateField(object, path);
  if (object.type === "table") {
    rejectUnknownKeys(
      object,
      new Set(["type", "id", "columns", "rows", "ariaLabel", "emptyLabel", "density", "frame"]),
      path,
    );
    const table = validateDataTableSpec(object);
    return {
      ...table,
      type: "table",
      id: requireString(object.id, `${path}.id`),
    };
  }
  if (object.type === "note") return validateNote(object, path);
  throw new Error(`${path}.type must be field, table, or note`);
}

function validateField(object: Record<string, unknown>, path: string): RecordDetailFieldSpec {
  rejectUnknownKeys(
    object,
    new Set([
      "type",
      "id",
      "label",
      "value",
      "helper",
      "emptyLabel",
      "layout",
      "control",
      "placeholder",
      "required",
      "disabled",
      "options",
    ]),
    path,
  );
  const control = validateControl(object.control, `${path}.control`);
  const options = validateOptions(object.options, control, path);
  const value = validateValue(object.value, `${path}.value`);
  const layout = validateLayout(object.layout, `${path}.layout`);
  validateControlValue(value, control, options, `${path}.value`);
  return {
    type: "field",
    id: requireString(object.id, `${path}.id`),
    label: requireString(object.label, `${path}.label`),
    value,
    helper: optionalString(object.helper, `${path}.helper`),
    emptyLabel: optionalString(object.emptyLabel, `${path}.emptyLabel`),
    ...(layout === undefined ? {} : { layout }),
    control,
    placeholder: optionalString(object.placeholder, `${path}.placeholder`),
    required: optionalBoolean(object.required, `${path}.required`, false),
    disabled: optionalBoolean(object.disabled, `${path}.disabled`, false),
    options,
  };
}

function validateLayout(value: unknown, path: string): RecordDetailFieldSpec["layout"] {
  if (value === undefined || value === "inline" || value === "stacked") return value;
  throw new Error(`${path} must be inline or stacked`);
}

function validateControlValue(
  value: RecordDetailValue | undefined,
  control: RecordDetailFieldSpec["control"],
  options: RecordDetailOptionSpec[] | undefined,
  path: string,
) {
  if (value === undefined || value === null || control === undefined) return;
  if (control === "checkbox" && typeof value !== "boolean") {
    throw new Error(`${path} must be a boolean for a checkbox control`);
  }
  if (control === "number" && typeof value !== "number") {
    throw new Error(`${path} must be a number for a number control`);
  }
  if (
    (control === "text" || control === "textarea" || control === "date" || control === "select") &&
    typeof value !== "string"
  ) {
    throw new Error(`${path} must be a string for a ${control} control`);
  }
  if (control === "select" && !options?.some((option) => option.value === value)) {
    throw new Error(`${path} must match an option for a select control`);
  }
}

function validateNote(object: Record<string, unknown>, path: string): RecordDetailNoteSpec {
  rejectUnknownKeys(object, new Set(["type", "id", "title", "body", "tone"]), path);
  const tone = object.tone;
  if (
    tone !== undefined &&
    tone !== "neutral" &&
    tone !== "info" &&
    tone !== "warning" &&
    tone !== "danger"
  ) {
    throw new Error(`${path}.tone must be neutral, info, warning, or danger`);
  }
  return {
    type: "note",
    id: requireString(object.id, `${path}.id`),
    title: optionalString(object.title, `${path}.title`),
    body: requireString(object.body, `${path}.body`),
    tone,
  };
}

function validateControl(value: unknown, path: string): RecordDetailFieldSpec["control"] {
  if (value === undefined) return undefined;
  if (
    value === "text" ||
    value === "textarea" ||
    value === "number" ||
    value === "date" ||
    value === "select" ||
    value === "checkbox"
  ) {
    return value;
  }
  throw new Error(`${path} must be a supported control`);
}

function validateOptions(
  value: unknown,
  control: RecordDetailFieldSpec["control"],
  path: string,
): RecordDetailOptionSpec[] | undefined {
  if (control !== "select") {
    if (value !== undefined) throw new Error(`${path}.options is only valid for select controls`);
    return undefined;
  }
  const options = requireArray(value, `${path}.options`, (item, index) => {
    const object = requireObject(item, `${path}.options[${index}]`);
    rejectUnknownKeys(object, new Set(["value", "label", "disabled"]), `${path}.options[${index}]`);
    return {
      value: requireString(object.value, `${path}.options[${index}].value`),
      label: requireString(object.label, `${path}.options[${index}].label`),
      disabled: optionalBoolean(object.disabled, `${path}.options[${index}].disabled`, false),
    };
  });
  if (options.length === 0) throw new Error(`${path}.options must not be empty`);
  const optionValues = new Set<string>();
  for (const option of options) {
    if (optionValues.has(option.value)) {
      throw new Error(`${path}.options values must be unique: ${option.value}`);
    }
    optionValues.add(option.value);
  }
  return options;
}

function validateValue(value: unknown, path: string): RecordDetailValue | undefined {
  if (
    value === undefined ||
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`${path} must be a finite serializable value`);
}

function validateTone(value: unknown, path: string): StatusPillTone | undefined {
  if (value === undefined) return undefined;
  if (
    value === "neutral" ||
    value === "success" ||
    value === "warning" ||
    value === "danger" ||
    value === "info"
  ) {
    return value;
  }
  throw new Error(`${path} must be a supported status tone`);
}

function optionalBoolean(value: unknown, path: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  throw new Error(`${path} must be a boolean`);
}

function assertUniqueIds(items: Array<{ id: string }>, path: string) {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) throw new Error(`${path} ids must be unique: ${item.id}`);
    ids.add(item.id);
  }
}

function rejectUnknownKeys(object: Record<string, unknown>, allowed: Set<string>, path: string) {
  const unknown = Object.keys(object).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${path}.${unknown} is not supported`);
}
