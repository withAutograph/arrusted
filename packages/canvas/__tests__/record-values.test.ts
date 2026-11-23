// Where the quiet draft mark goes: on a value a pending draft changed, and
// once on a record a pending draft creates.
import { describe, expect, it } from "vite-plus/test";

import type { DataModel } from "@autograph/generated-app-runtime/data";

import {
  creationMarkField,
  draftMark,
  draftOrigin,
  gridSchema,
  shownFields,
} from "../record-values";

const field = (id: string, type: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  label: id,
  type,
  required: false,
  readOnly: false,
  ...extra,
});
/** A model with a name column. */
const named = {
  id: "m_named",
  name: "named",
  label: "Named",
  relations: [],
  fields: [field("f_name", "text"), field("f_score", "number")],
} as unknown as DataModel;
/** A model without a text column, so without a name column. */
const unnamed = {
  id: "m_unnamed",
  name: "unnamed",
  label: "Unnamed",
  relations: [],
  fields: [field("f_code", "number", { is_unique: true }), field("f_score", "number")],
} as unknown as DataModel;

describe("draft marks", () => {
  it("marks a creation on the name column, or the first non-key column without one", () => {
    expect(creationMarkField(named)).toBe("f_name");
    expect(creationMarkField(unnamed)).toBe("f_score");
    const origin = draftOrigin(unnamed, {
      id: "r1",
      pendingDraft: { created: 12, fields: { f_score: 12 } },
    });
    const at = creationMarkField(unnamed);
    expect(draftMark(origin, "f_score", at)).toEqual({
      label: "draft",
      title: "New in draft #12. Edit it in Review.",
    });
    expect(draftMark(origin, "f_code", at)).toBeUndefined();
  });

  it("marks a changed value with its draft, and nothing without a pending draft", () => {
    const origin = draftOrigin(named, { id: "r1", pendingDraft: { fields: { f_score: 14 } } });
    const at = creationMarkField(named);
    expect(draftMark(origin, "f_score", at)).toEqual({ label: "draft", title: "In draft #14" });
    expect(draftMark(origin, "f_name", at)).toBeUndefined();
    expect(draftOrigin(named, { id: "r1" })).toBeNull();
  });
});

it("shows a renamed field once, including review grids that request all fields", () => {
  const model = {
    ...named,
    fields: [
      field("title", "text", { name: "heading" }),
      field("title", "text", { name: "title", aliasOf: "heading", readOnly: true }),
    ],
  };
  expect(shownFields(model).map((field) => field.name)).toEqual(["heading"]);
  const definition: Parameters<typeof gridSchema>[0] = {
    formatVersion: 1,
    schemaVersion: "v1",
    models: [model],
  };
  expect(gridSchema(definition).models[0]!.fields).toHaveLength(1);
  expect(gridSchema(definition, (model) => model.fields).models[0]!.fields).toHaveLength(1);
});
