import { describe, expect, it } from "vitest";

import { assertFieldGroupPartition, resolveFieldGroups } from "../index";

const GROUPS = [
  { id: "summary", label: "Summary", fields: ["name", "status"] },
  { id: "dates", label: "Dates", fields: ["start_date"] },
] as const;

describe("field groups", () => {
  it("accepts a mutually exclusive, collectively exhaustive partition", () => {
    expect(() =>
      assertFieldGroupPartition("position", ["name", "status", "start_date"], GROUPS),
    ).not.toThrow();
  });

  it("rejects duplicate, unknown, and ungrouped field membership", () => {
    expect(() =>
      assertFieldGroupPartition(
        "position",
        ["name"],
        [
          { id: "one", label: "One", fields: ["name"] },
          { id: "two", label: "Two", fields: ["name"] },
        ],
      ),
    ).toThrow("belongs to more than one field group");
    expect(() =>
      assertFieldGroupPartition(
        "position",
        ["name"],
        [{ id: "one", label: "One", fields: ["missing"] }],
      ),
    ).toThrow("unknown field missing");
    expect(() => assertFieldGroupPartition("position", ["name"], [])).toThrow(
      "ungrouped fields name",
    );
  });

  it("reserves runtime fallback group ids", () => {
    expect(() =>
      assertFieldGroupPartition(
        "position",
        ["name"],
        [{ id: "custom", label: "Custom", fields: ["name"] }],
      ),
    ).toThrow("field group id custom is reserved for runtime fallback");
    expect(() =>
      resolveFieldGroups({
        fields: [{ id: "name" }],
        definitions: [{ id: "other", label: "Other", fields: ["name"] }],
      }),
    ).toThrow("field group id other is reserved for runtime fallback");
  });

  it("resolves domain order and keeps runtime-only fields visible", () => {
    expect(
      resolveFieldGroups({
        fields: [
          { id: "custom_score" },
          { id: "status" },
          { id: "name" },
          { id: "runtime_note" },
          { id: "start_date" },
        ],
        definitions: GROUPS,
        customFieldIds: new Set(["custom_score"]),
      }).map((group) => ({
        id: group.id,
        fields: group.fields.map((field) => field.id),
      })),
    ).toEqual([
      { id: "summary", fields: ["name", "status"] },
      { id: "dates", fields: ["start_date"] },
      { id: "other", fields: ["runtime_note"] },
      { id: "custom", fields: ["custom_score"] },
    ]);
  });

  it("uses one details group when the domain has no richer partition", () => {
    expect(
      resolveFieldGroups({ fields: [{ id: "name" }, { id: "code" }] }).map((group) => ({
        id: group.id,
        fields: group.fields.map((field) => field.id),
      })),
    ).toEqual([{ id: "details", fields: ["name", "code"] }]);
  });

  it("keeps custom fields explicit when the domain has no richer partition", () => {
    expect(
      resolveFieldGroups({
        fields: [{ id: "name" }, { id: "custom_note" }],
        customFieldIds: new Set(["custom_note"]),
      }).map((group) => ({
        id: group.id,
        fields: group.fields.map((field) => field.id),
      })),
    ).toEqual([
      { id: "details", fields: ["name"] },
      { id: "custom", fields: ["custom_note"] },
    ]);
  });
});
