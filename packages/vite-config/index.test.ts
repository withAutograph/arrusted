import { describe, expect, it } from "vite-plus/test";
import { configDefaults } from "vitest/config";
import { jsdomTestDefaults, nextAppVitestConfig, serverOnlyTestAlias } from "./index";

describe("shared app config fragments", () => {
  it("only adds jsdom and explicit app test options", () => {
    expect(
      jsdomTestDefaults({
        include: ["app/**/__tests__/**/*.test.tsx"],
        setupFiles: ["./vitest.setup.ts"],
      }),
    ).toEqual({
      environment: "jsdom",
      restoreMocks: true,
      include: ["app/**/__tests__/**/*.test.tsx"],
      exclude: configDefaults.exclude,
      setupFiles: ["./vitest.setup.ts"],
    });
  });

  it("leaves standard Vitest discovery and execution settings unset", () => {
    const config = jsdomTestDefaults();
    expect(config).toEqual({ environment: "jsdom", restoreMocks: true });
    expect(config).not.toHaveProperty("include");
    expect(config).not.toHaveProperty("exclude");
    expect(config).not.toHaveProperty("globals");
    expect(config.restoreMocks).toBe(true);
    expect(config).not.toHaveProperty("testTimeout");
  });

  it("resolves the server-only test stub from this package", () => {
    expect(serverOnlyTestAlias()["server-only"]).toContain(
      "/packages/vite-config/server-only-test-stub.js",
    );
  });

  it("provides standard Next.js settings with app overrides", () => {
    const config = nextAppVitestConfig();
    expect(config.plugins).toHaveLength(1);
    expect(config.resolve.alias).toEqual(serverOnlyTestAlias());
    expect(config.test).toMatchObject({
      environment: "jsdom",
      exclude: [...configDefaults.exclude, "**/tests/e2e/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    });
    expect(config.test).not.toHaveProperty("include");
    expect(config.test).not.toHaveProperty("globals");
    expect(config.test.restoreMocks).toBe(true);
    expect(config.test).not.toHaveProperty("testTimeout");
  });
});
