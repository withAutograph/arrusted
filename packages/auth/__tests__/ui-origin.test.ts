import { describe, expect, it } from "vite-plus/test";
import { authUiOriginForEnvironment } from "../env";

describe("Auth UI configured origin", () => {
  it("uses the existing exact public origin without needing database or sender credentials", () => {
    expect(
      authUiOriginForEnvironment({
        VERCEL_ENV: "production",
        BETTER_AUTH_URL: "https://apps.example.test",
        PLATFORM_PUBLIC_ORIGIN: "https://apps.example.test",
      }),
    ).toBe("https://apps.example.test");
  });

  it("retains the existing Preview deployment-origin resolution", () => {
    expect(
      authUiOriginForEnvironment({
        VERCEL_ENV: "preview",
        BETTER_AUTH_URL: "https://production.example.test",
        VERCEL_URL: "apps-git-auth-fixture-autographing.vercel.app",
      }),
    ).toBe("https://apps-git-auth-fixture-autographing.vercel.app");
  });

  it.each([
    {},
    { BETTER_AUTH_URL: "not an origin" },
    { BETTER_AUTH_URL: "https://user:password@apps.example.test" },
    { BETTER_AUTH_URL: "https://apps.example.test/path" },
    {
      BETTER_AUTH_URL: "https://apps.example.test",
      PLATFORM_PUBLIC_ORIGIN: "https://different.example.test",
    },
    { BETTER_AUTH_URL: "https://apps.example.test", PLATFORM_PUBLIC_ORIGIN: "not an origin" },
  ])(
    "returns no authority for missing, malformed or conflicting origin configuration",
    (environment) => {
      expect(authUiOriginForEnvironment(environment)).toBeUndefined();
    },
  );
});
