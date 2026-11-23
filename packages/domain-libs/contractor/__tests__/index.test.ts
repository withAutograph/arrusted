import { describe, expect, it } from "vite-plus/test";

import { enumFieldShapes } from "../../_shared/__tests__/helpers";

import { model_contractor_blocks } from "../index";

describe("@domain-libs/contractor", () => {
  it("exports contractor domain blocks", () => {
    expect(blockNames(model_contractor_blocks)).toEqual(["contractor"]);
  });

  it("pins converted enum field shapes", () => {
    expect(enumFieldShapes(model_contractor_blocks)).toEqual([
      ["contractor.type", ["consultant", "freelancer", "agency", "temp"]],
    ]);
  });
});

function blockNames(blocks: readonly { name: string }[]): string[] {
  return blocks.map((block) => block.name);
}
