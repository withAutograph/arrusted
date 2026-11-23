import { describe, expect, it } from "vite-plus/test";

import { enumFieldShapes } from "../../_shared/__tests__/helpers";

import { model_requisition_blocks } from "../index";

describe("@domain-libs/requisition", () => {
  it("exports requisition domain blocks", () => {
    expect(blockNames(model_requisition_blocks)).toEqual(["requisition"]);
  });

  it("pins converted enum field shapes", () => {
    expect(enumFieldShapes(model_requisition_blocks)).toEqual([
      ["requisition.status", ["draft", "approved", "recruiting", "filled"]],
      ["requisition.type", ["new_headcount", "backfill", "conversion", "upgrade"]],
      ["requisition.priority", ["low", "medium", "high", "critical"]],
      ["requisition.position_request_status", ["requested", "rejected"]],
    ]);
  });
});

function blockNames(blocks: readonly { name: string }[]): string[] {
  return blocks.map((block) => block.name);
}
