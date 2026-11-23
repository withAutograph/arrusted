import { describe, expect, it } from "vite-plus/test";

import { enumFieldShapes, fieldGroupShape } from "../../_shared/__tests__/helpers";

import {
  MONEY_RANGE_RULES,
  model_position_blocks,
  POSITION_FIELD_GROUPS,
  POSITION_FIELD_VALIDATION_RULES,
} from "../index";

describe("@domain-libs/position", () => {
  it("exports position domain blocks and policy", () => {
    expect(blockNames(model_position_blocks)).toEqual(["position"]);
    expect(POSITION_FIELD_VALIDATION_RULES).toHaveProperty("base_salary");
    expect(MONEY_RANGE_RULES[0]?.kind).toBe("range");
  });

  it("partitions every position field exactly once", () => {
    const position = model_position_blocks[0]!;
    const shape = fieldGroupShape(position);
    expect(shape.groupIds).toEqual(POSITION_FIELD_GROUPS.map((group) => group.id));
    expect(shape.groupedFieldIds).toEqual(shape.declaredFieldIds);
  });

  it("pins converted enum field shapes", () => {
    expect(enumFieldShapes(model_position_blocks)).toEqual([
      ["position.position_status", ["pending", "open", "filled", "paused", "closed"]],
    ]);
  });
});

function blockNames(blocks: readonly { name: string }[]): string[] {
  return blocks.map((block) => block.name);
}
