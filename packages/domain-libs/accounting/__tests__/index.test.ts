import { describe, expect, it } from "vite-plus/test";

import { model_accounting_blocks } from "../index";

describe("@domain-libs/accounting", () => {
  it("exports source-populated chart account vocabulary without seed policy", () => {
    expect(model_accounting_blocks).toMatchObject([
      expect.objectContaining({
        name: "chart_account",
        kind: "entity",
      }),
    ]);
    expect(model_accounting_blocks[0]).not.toHaveProperty("seed_rows");
    expect(model_accounting_blocks[0]?.fields.parent).toMatchObject({
      target_model: "chart_account",
    });
  });
});
