import { expect, test } from "bun:test";

import { authMigrationInputHash, type BunLock } from "./auth-migration-inputs";

const inputs: BunLock = {
  packages: {
    auth: ["auth@1.7.3", "", { dependencies: { "better-auth": "1.7.3" } }],
    "better-auth": ["better-auth@1.7.3", "", { dependencies: { zod: "^4.5.4" } }],
    "@better-auth/infra": ["@better-auth/infra@0.4.7", "", { dependencies: { "better-call": "1.3.7" } }],
    "@better-auth/infra/better-call": ["better-call@1.3.7", "", { dependencies: { rou3: "^0.7.12" } }],
    "@better-auth/infra/better-call/rou3": ["rou3@0.7.12"],
    "better-call": ["better-call@1.4.0"],
    "@better-auth/cimd": ["@better-auth/cimd@1.7.3"],
    "@better-auth/oauth-provider": ["@better-auth/oauth-provider@1.7.3", "", { dependencies: { jose: "^6.2.3" } }],
    jose: ["jose@6.2.3"],
    pg: ["pg@8.23.0", "", { optionalDependencies: { "pg-cloudflare": "^1.4.0" } }],
    "pg-cloudflare": ["pg-cloudflare@1.4.0"],
    "@libpg-query/parser": ["@libpg-query/parser@17.6.10"],
    zod: ["zod@4.5.4"],
    "@vercel/microfrontends": ["@vercel/microfrontends@2.4.0"],
  },
};

test("Auth migration snapshot ignores unrelated lockfile packages", () => {
  const changed = structuredClone(inputs);
  changed.packages!["@vercel/microfrontends"] = ["@vercel/microfrontends@2.5.0"];
  expect(authMigrationInputHash(inputs)).toBe(authMigrationInputHash(changed));
});

test("Auth migration snapshot detects a transitive Auth dependency change", () => {
  const changed = structuredClone(inputs);
  changed.packages.zod = ["zod@4.6.0"];
  expect(authMigrationInputHash(inputs)).not.toBe(authMigrationInputHash(changed));
});

test("Auth migration snapshot follows the nearest qualified dependency", () => {
  const changed = structuredClone(inputs);
  changed.packages!["@better-auth/infra/better-call/rou3"] = ["rou3@0.8.0"];
  expect(authMigrationInputHash(inputs)).not.toBe(authMigrationInputHash(changed));

  const unrelated = structuredClone(inputs);
  unrelated.packages!["better-call"] = ["better-call@1.5.0"];
  expect(authMigrationInputHash(inputs)).toBe(authMigrationInputHash(unrelated));
});

test("Auth migration snapshot follows optional dependencies", () => {
  const changed = structuredClone(inputs);
  changed.packages!["pg-cloudflare"] = ["pg-cloudflare@1.5.0"];
  expect(authMigrationInputHash(inputs)).not.toBe(authMigrationInputHash(changed));
});
