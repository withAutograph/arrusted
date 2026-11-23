import { describe, expect, it } from "vite-plus/test";

import { appAccessMissing, appDisplayName } from "../agent-grant-policy";

describe("appDisplayName", () => {
  it("names an app as people read it", () => {
    expect(appDisplayName("comp-canvas")).toBe("Comp canvas");
    expect(appDisplayName("hc")).toBe("HC");
    expect(appDisplayName("vendor")).toBe("Vendor");
  });

  it("uses an app's own name where it differs from the derived one", () => {
    expect(appDisplayName("spend-review")).toBe("Spend Review");
  });

  it("never reads an inherited property as a name", () => {
    expect(appDisplayName("constructor")).toBe("Constructor");
  });

  it("tells a person without access what to do next", () => {
    expect(appAccessMissing("spend-review")).toBe(
      "None of your organizations gives you access to Spend Review. Ask your Autograph admin to give you access.",
    );
  });
});
