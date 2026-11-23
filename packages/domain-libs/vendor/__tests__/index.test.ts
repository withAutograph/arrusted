import { describe, expect, it } from "vite-plus/test";

import { enumFieldShapes } from "../../_shared/__tests__/helpers";

import { model_vendor_blocks } from "../index";

describe("@domain-libs/vendor", () => {
  it("exports vendor domain blocks", () => {
    expect(blockNames(model_vendor_blocks)).toEqual(["vendor"]);
  });

  it("pins converted enum field shapes", () => {
    expect(enumFieldShapes(model_vendor_blocks)).toEqual([
      ["vendor.status", ["active", "inactive"]],
      [
        "vendor.type",
        ["software", "professional_services", "contractor", "supplier", "facilities", "other"],
      ],
    ]);
  });
});

function blockNames(blocks: readonly { name: string }[]): string[] {
  return blocks.map((block) => block.name);
}
