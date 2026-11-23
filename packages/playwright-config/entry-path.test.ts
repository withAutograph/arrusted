import { expect, it } from "vitest";
import { createPlaywrightConfig } from "./config.js";
import { appTestPath, resolveAppBrowserEntryPath } from "./entry-path.js";

it("enters the selected app path while preserving the configured origin", () => {
  const app = { name: "example", default: false, routing: ["/workspace", "/workspace/:path*"] };
  const environment = {
    APP_TEST_BASE_URL: "https://owned.example",
    APP_TEST_ENTRY_PATH: resolveAppBrowserEntryPath(app.routing),
  };
  const origin = createPlaywrightConfig(environment).use?.baseURL;
  expect(new URL(appTestPath("/", environment), origin).pathname).toBe("/workspace");
  expect(origin).toBe("https://owned.example");
  expect(appTestPath("/details?tab=data", environment)).toBe("/workspace/details?tab=data");
});
it("leaves ambiguity and invalid explicit selections unresolved without guessing app ids or insertion order", () => {
  const routes = ["/review", "/requests", "/review/:path*"];
  expect(resolveAppBrowserEntryPath(routes)).toBeUndefined();
  expect(resolveAppBrowserEntryPath(routes, "/requests")).toBe("/requests");
  expect(resolveAppBrowserEntryPath([...routes].reverse(), "/requests")).toBe("/requests");
  expect(resolveAppBrowserEntryPath(["/review"], "/foreign")).toBeUndefined();
  expect(resolveAppBrowserEntryPath(routes, "/review/123", (p) => p === "/review/123")).toBe(
    "/review/123",
  );
  for (const path of [
    "https://other.example",
    "//other.example",
    "/review?x=1",
    "/../other",
    "/%2e/other",
    "/review\\other",
  ])
    expect(resolveAppBrowserEntryPath(routes, path, () => true)).toBeUndefined();
});
it("preserves standalone and already authored navigation without rewriting tests", () => {
  expect(appTestPath("/details", { APP_TEST_ENTRY_PATH: "/workspace/" })).toBe(
    "/workspace/details",
  );
  expect(appTestPath("/", {})).toBe("/");
  expect(appTestPath("/custom", {})).toBe("/custom");
  expect(appTestPath("/", { APP_TEST_ENTRY_PATH: "/" })).toBe("/");
  expect(appTestPath("/details?tab=data", { APP_TEST_ENTRY_PATH: "/" })).toBe("/details?tab=data");
  expect(() => appTestPath("/", { APP_TEST_ENTRY_PATH: "https://other.example" })).toThrow();
  expect(() => appTestPath("/../other", { APP_TEST_ENTRY_PATH: "/review" })).toThrow();
});
