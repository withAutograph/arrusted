import { describe, expect, it } from "vitest";

import { findSourceInspectionViolations } from "../check-test-quality-policy";

describe("test quality policy", () => {
  it("rejects ordinary production source inspection, including schema bindings", () => {
    expect(
      findSourceInspectionViolations([
        {
          relative: ".config/mise/scripts/repository/ordinary.test.ts",
          source: `const schema = readFileSync(path.join(root, "packages/auth/schema.json"), "utf8");\nexpect(schema).toContain("secret");`,
        },
      ]),
    ).toEqual([".config/mise/scripts/repository/ordinary.test.ts"]);
  });

  it("requires explicit validator paths for static policy checks", () => {
    expect(
      findSourceInspectionViolations([
        {
          relative: ".config/mise/scripts/repository/check-git-hook-gates.test.ts",
          source: `const source = readFileSync("packages/auth/client.ts", "utf8");\nexpect(source).toContain("dashClient");`,
        },
      ]),
    ).toEqual([]);
  });
});
