import { describe, expect, it } from "vite-plus/test";

import { enumFieldShapes, fieldGroupShape } from "../../_shared/__tests__/helpers";

import {
  lookup_capacity_blocks,
  lookup_employee_profile_blocks,
  lookup_employee_workforce_blocks,
  lookup_performance_blocks,
  EMPLOYEE_FIELD_GROUPS,
  model_employee_blocks,
} from "../index";

describe("@domain-libs/employee", () => {
  it("exports employee domain blocks", () => {
    expect(blockNames(lookup_employee_profile_blocks)).toEqual(["entity"]);
    expect(blockNames(lookup_employee_workforce_blocks)).toEqual([]);
    expect(blockNames(lookup_performance_blocks)).toEqual([]);
    expect(blockNames(lookup_capacity_blocks)).toEqual([
      "cx_capacity_template",
      "quota_capacity_template",
      "initiative",
      "segment",
    ]);
    expect(blockNames(model_employee_blocks)).toEqual(["employee"]);
  });

  it("partitions every employee field exactly once", () => {
    const employee = model_employee_blocks[0]!;
    const shape = fieldGroupShape(employee);
    expect(shape.groupIds).toEqual(EMPLOYEE_FIELD_GROUPS.map((group) => group.id));
    expect(shape.groupedFieldIds).toEqual(shape.declaredFieldIds);
  });

  it("pins converted enum field shapes", () => {
    expect(enumFieldShapes(model_employee_blocks)).toEqual([
      ["employee.employment_status", ["active", "pending", "inactive", "on_leave"]],
      ["employee.gender", ["m", "f", "o", "nb", "nd"]],
      ["employee.cost_center", ["unspecified"]],
      ["employee.wfh_policy", ["full_remote", "hybrid", "office", "flexible"]],
      [
        "employee.ethnicity",
        ["hispanic", "white", "asian", "black", "multiracial", "native", "pacific"],
      ],
      [
        "employee.marital_status",
        ["single", "married", "divorced", "widowed", "separated", "domestic_partnership"],
      ],
      ["employee.termination_reason", ["unspecified"]],
      ["employee.regrettable_classification", ["unspecified"]],
      ["employee.pay_frequency", ["unspecified"]],
      ["employee.team", ["unspecified"]],
      ["employee.employment_type", ["full_time", "part_time", "intern", "temp"]],
      ["employee.flsa_status", ["unspecified"]],
      ["employee.voluntary_classification", ["unspecified"]],
      ["employee.skills", ["unspecified"]],
      [
        "employee.performance_rating_structured",
        ["exceeds", "meets", "needs_improvement", "unsatisfactory"],
      ],
    ]);
  });
});

function blockNames(blocks: readonly { name: string }[]): string[] {
  return blocks.map((block) => block.name);
}
