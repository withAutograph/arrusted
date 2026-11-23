import { describe, expect, it } from "vite-plus/test";

import { fieldGroupShape } from "./helpers";
import * as sharedVocabulary from "../index";
import {
  defineFieldGroups,
  lookup_core_blocks,
  lookup_geography_blocks,
  lookup_other_blocks,
} from "../index";

describe("@domain-libs/_shared", () => {
  it("exports shared lookup blocks", () => {
    expect(blockNames(lookup_core_blocks)).toEqual(["department", "location", "pnl_category"]);
    expect(blockNames(lookup_other_blocks)).toEqual(["business_unit"]);
    expect(blockNames(lookup_geography_blocks)).toEqual(["geography"]);
  });

  it("does not export catalog compiler behavior", () => {
    expect("collectCatalogBlocks" in sharedVocabulary).toBe(false);
    expect("buildCatalogArtifact" in sharedVocabulary).toBe(false);
  });

  it("rejects duplicate and runtime-reserved authored field-group ids", () => {
    if (false) {
      // @ts-expect-error reserved fallback ids are rejected in authored literal declarations
      defineFieldGroups("example", [{ id: "custom", label: "Custom", fields: ["name"] }]);
    }
    const block = {
      name: "example",
      fields: { name: {} },
      field_groups: [{ id: "Custom", fields: ["name"] }],
    };
    expect(() => fieldGroupShape(block)).toThrow("reserved field group id Custom");
    expect(() =>
      fieldGroupShape({
        ...block,
        field_groups: [
          { id: "summary", fields: ["name"] },
          { id: "summary", fields: [] },
        ],
      }),
    ).toThrow("duplicate field group id summary");
  });
});

function blockNames(blocks: readonly { name: string }[]): string[] {
  return blocks.map((block) => block.name);
}
