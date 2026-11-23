import { describe, expect, it } from "vite-plus/test";

import { fieldGroupShape } from "../../_shared/__tests__/helpers";
import { model_org_assignment_blocks, ORG_ASSIGNMENT_FIELD_GROUPS } from "../index";

describe("@domain-libs/org-assignment", () => {
  it("exports org-assignment domain blocks", () => {
    expect(blockNames(model_org_assignment_blocks)).toEqual(["org_assignment"]);
  });

  it("partitions every org-assignment field exactly once", () => {
    const assignment = model_org_assignment_blocks[0]!;
    const shape = fieldGroupShape(assignment);
    expect(shape.groupIds).toEqual(ORG_ASSIGNMENT_FIELD_GROUPS.map((group) => group.id));
    expect(shape.groupedFieldIds).toEqual(shape.declaredFieldIds);
  });
});

function blockNames(blocks: readonly { name: string }[]): string[] {
  return blocks.map((block) => block.name);
}
