import type { StatusPillTone } from "../components/StatusPill";
import { optionalString, requireArray, requireObject, requireString } from "./spec";
import type {
  ActivityFeedFieldChangeSpec,
  ActivityFeedLabels,
  ActivityFeedSpec,
  ActivityFeedItemSpec,
  ActivityFeedValue,
} from "./ActivityFeed";

export function validateActivityFeedSpec(value: unknown): ActivityFeedSpec {
  const object = requireObject(value, "activity_feed.config");
  return {
    items: requireArray(object.items, "activity_feed.items", validateActivityFeedItem),
    labels: validateActivityFeedLabels(object.labels),
  };
}

function validateActivityFeedItem(item: unknown, index: number): ActivityFeedItemSpec {
  const object = requireObject(item, `activity_feed.items[${index}]`);
  return {
    id: requireString(object.id, `activity_feed.items[${index}].id`),
    occurredAt: requireString(object.occurredAt, `activity_feed.items[${index}].occurredAt`),
    occurredAtLabel: optionalString(
      object.occurredAtLabel,
      `activity_feed.items[${index}].occurredAtLabel`,
    ),
    title: requireString(object.title, `activity_feed.items[${index}].title`),
    detail: optionalString(object.detail, `activity_feed.items[${index}].detail`),
    actorLabel: optionalString(object.actorLabel, `activity_feed.items[${index}].actorLabel`),
    modelLabel: optionalString(object.modelLabel, `activity_feed.items[${index}].modelLabel`),
    recordLabel: optionalString(object.recordLabel, `activity_feed.items[${index}].recordLabel`),
    statusLabel: optionalString(object.statusLabel, `activity_feed.items[${index}].statusLabel`),
    statusTone: validateStatusTone(object.statusTone, `activity_feed.items[${index}].statusTone`),
    changes:
      object.changes === undefined
        ? undefined
        : requireArray(
            object.changes,
            `activity_feed.items[${index}].changes`,
            validateActivityFeedChange,
          ),
  };
}

function validateActivityFeedChange(change: unknown, index: number): ActivityFeedFieldChangeSpec {
  const object = requireObject(change, `activity_feed.changes[${index}]`);
  return {
    fieldId: requireString(object.fieldId, `activity_feed.changes[${index}].fieldId`),
    label: requireString(object.label, `activity_feed.changes[${index}].label`),
    before: optionalActivityFeedValue(object.before, `activity_feed.changes[${index}].before`),
    after: optionalActivityFeedValue(object.after, `activity_feed.changes[${index}].after`),
  };
}

function validateActivityFeedLabels(value: unknown): Partial<ActivityFeedLabels> | undefined {
  if (value === undefined) {
    return undefined;
  }
  const object = requireObject(value, "activity_feed.labels");
  const labels: Partial<ActivityFeedLabels> = {};
  addOptionalLabel(labels, "empty", object.empty, "activity_feed.labels.empty");
  addOptionalLabel(
    labels,
    "inspectChanges",
    object.inspectChanges,
    "activity_feed.labels.inspectChanges",
  );
  addOptionalLabel(labels, "before", object.before, "activity_feed.labels.before");
  addOptionalLabel(labels, "after", object.after, "activity_feed.labels.after");
  addOptionalLabel(labels, "emptyValue", object.emptyValue, "activity_feed.labels.emptyValue");
  addOptionalLabel(labels, "trueValue", object.trueValue, "activity_feed.labels.trueValue");
  addOptionalLabel(labels, "falseValue", object.falseValue, "activity_feed.labels.falseValue");
  return labels;
}

function addOptionalLabel<K extends keyof ActivityFeedLabels>(
  labels: Partial<ActivityFeedLabels>,
  key: K,
  value: unknown,
  name: string,
) {
  const label = optionalString(value, name);
  if (label !== undefined) {
    labels[key] = label;
  }
}

function validateStatusTone(value: unknown, name: string): StatusPillTone | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    value === "neutral" ||
    value === "success" ||
    value === "warning" ||
    value === "danger" ||
    value === "info"
  ) {
    return value;
  }
  throw new Error(`${name} must be a supported status tone`);
}

function optionalActivityFeedValue(value: unknown, name: string): ActivityFeedValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`${name} must be a finite number`);
    }
    return value;
  }
  throw new Error(`${name} must be a string, number, boolean, or null`);
}
