import { expect, test } from "vite-plus/test";
import { readAuthCatalogAppIds } from "./auth-app-catalog";

test("provisioning uses the explicit catalog, independent of checkout applications", () => {
  expect(readAuthCatalogAppIds({ AUTH_CATALOG_APP_IDS: '["fixture-b","fixture-a"]' })).toEqual([
    "fixture-a",
    "fixture-b",
  ]);
});

test.each([undefined, "", "not-json", "null", "{}", "[]", '[""]', "[1]", '["app","app"]'])(
  "provisioning rejects an absent or invalid catalog: %s",
  (value) => {
    expect(() => readAuthCatalogAppIds({ AUTH_CATALOG_APP_IDS: value })).toThrow(
      expect.objectContaining({ code: "invalid_catalog_app_ids" }),
    );
  },
);
