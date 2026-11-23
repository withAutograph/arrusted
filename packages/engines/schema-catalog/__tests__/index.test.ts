import { describe, expect, it } from "vite-plus/test";

import { buildCatalogArtifact, collectCatalogBlocks, type ModelBlock } from "../index";

describe("schema catalog engine", () => {
  it("flattens related models in authored order", () => {
    const catalog = collectCatalogBlocks([
      {
        name: "invoice",
        kind: "entity",
        fields: { vendor: { target_model: "vendor" } },
        related: [{ name: "vendor", kind: "entity", fields: {} }],
      },
    ]);

    expect([...catalog.keys()]).toEqual(["invoice", "vendor"]);
  });

  it("rejects duplicate models and unclassified properties", () => {
    const model: ModelBlock = { name: "example", kind: "entity", fields: {} };
    expect(() =>
      buildCatalogArtifact([
        { package: "@domain-libs/one", blocks: [model] },
        { package: "@domain-libs/two", blocks: [model] },
      ]),
    ).toThrow("exported by both");
    expect(() =>
      buildCatalogArtifact([
        {
          package: "@domain-libs/one",
          blocks: [{ ...model, unclassified: true } as ModelBlock],
        },
      ]),
    ).toThrow("unclassified is not a ModelBlock property");
    expect(() =>
      collectCatalogBlocks([
        {
          ...model,
          fields: { name: { type: "text", formula: "raw sql" } as never },
        },
      ]),
    ).toThrow("formula is not a ScalarFieldDefinition property");
  });

  it("validates nested source blocks before flattening provenance", () => {
    expect(() =>
      buildCatalogArtifact([
        {
          package: "@domain-libs/one",
          blocks: [
            {
              name: "parent",
              kind: "entity",
              fields: {},
              related: {} as never,
            },
          ],
        },
      ]),
    ).toThrow("sources.@domain-libs/one.blocks[0].related must be an array");

    expect(() =>
      buildCatalogArtifact([
        {
          package: "@domain-libs/one",
          blocks: [
            {
              name: "parent",
              kind: "entity",
              fields: {},
              related: [{ kind: "entity", fields: {} } as ModelBlock],
            },
          ],
        },
      ]),
    ).toThrow("sources.@domain-libs/one.blocks[0].related[0].name must be a non-empty string");
  });

  it("rejects invalid seed values", () => {
    expect(() =>
      collectCatalogBlocks([
        {
          name: "lookup",
          kind: "lookup",
          fields: { name: { type: "text" } },
          seed_rows: [{ external_key: "bad", values: { missing: "value" } }],
        },
      ]),
    ).toThrow("does not resolve in lookup");
    expect(() =>
      collectCatalogBlocks([
        {
          name: "lookup",
          kind: "lookup",
          fields: { active: { type: "bool" } },
          seed_rows: [{ external_key: "bad", values: { active: "yes" } }],
        },
      ]),
    ).toThrow("does not match its field definition");
  });

  it("rejects invalid inverse relations", () => {
    expect(() =>
      collectCatalogBlocks([
        {
          name: "parent",
          kind: "entity",
          fields: {},
          inverse_relations: [{ id: "children", model: "child", through: "name" }],
        },
        { name: "child", kind: "entity", fields: { name: { type: "text" } } },
      ]),
    ).toThrow("must be a scalar relation back to parent");
  });

  it("rejects relation targets missing from the complete catalog", () => {
    expect(() =>
      collectCatalogBlocks([
        {
          name: "invoice",
          kind: "entity",
          fields: { vendor: { target_model: "missing_vendor" } },
        },
      ]),
    ).toThrow("catalog.invoice.fields.vendor.target_model missing_vendor does not resolve");
  });
});
