import { describe, expect, it } from "vite-plus/test";

import { enumFieldShapes } from "../../_shared/__tests__/helpers";

import { lookup_revenue_blocks, model_revenue_blocks } from "../index";

describe("@domain-libs/revenue", () => {
  it("exports revenue domain blocks", () => {
    expect(blockNames(lookup_revenue_blocks)).toEqual([]);
    expect(blockNames(model_revenue_blocks)).toEqual([
      "product",
      "price",
      "customer",
      "subscription",
      "subscription_item",
      "subscription_schedule",
    ]);
  });

  it("pins converted enum field shapes", () => {
    expect(enumFieldShapes(model_revenue_blocks)).toEqual([
      [
        "subscription.status",
        [
          "active",
          "past_due",
          "unpaid",
          "canceled",
          "incomplete",
          "incomplete_expired",
          "trialing",
          "paused",
        ],
      ],
    ]);
  });
});

function blockNames(blocks: readonly { name: string }[]): string[] {
  return blocks.map((block) => block.name);
}
