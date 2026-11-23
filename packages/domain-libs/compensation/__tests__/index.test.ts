import { describe, expect, it } from "vite-plus/test";

import { enumFieldShapes } from "../../_shared/__tests__/helpers";

import {
  lookup_compensation_blocks,
  lookup_equity_blocks,
  model_compensation_blocks,
} from "../index";

describe("@domain-libs/compensation", () => {
  it("exports compensation domain blocks", () => {
    expect(blockNames(lookup_compensation_blocks)).toEqual([
      "job_family",
      "level",
      "comp_zone",
      "bonus",
    ]);
    expect(blockNames(lookup_equity_blocks)).toEqual(["equity_grant"]);
    expect(blockNames(model_compensation_blocks)).toEqual([
      "benefits_policy",
      "employer_tax_policy",
    ]);
  });

  it("pins converted enum field shapes", () => {
    expect(enumFieldShapes([...lookup_compensation_blocks, ...lookup_equity_blocks])).toEqual([
      ["bonus.bonus_reason", ["unspecified"]],
      ["equity_grant.equity_grant_reason", ["unspecified"]],
      ["equity_grant.equity_grant_type", ["unspecified"]],
      ["equity_grant.equity_grant_status", ["unspecified"]],
      ["equity_grant.equity_target_price", ["unspecified"]],
    ]);
  });
});

function blockNames(blocks: readonly { name: string }[]): string[] {
  return blocks.map((block) => block.name);
}
