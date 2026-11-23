#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const LOCK_PATH = "bun.lock";
const SNAPSHOT_PATH = "packages/auth/migration-inputs.json";
const ROOT_PACKAGES = [
  "auth",
  "better-auth",
  "@better-auth/cimd",
  "@better-auth/infra",
  "@better-auth/oauth-provider",
  "pg",
  "@libpg-query/parser",
];

export type LockPackage = readonly [
  string,
  string?,
  { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }?,
  string?,
];
export type BunLock = { packages?: Record<string, LockPackage> };

export function authMigrationInputHash(lock: BunLock): string {
  if (!lock.packages || typeof lock.packages !== "object") {
    throw new Error("Bun lockfile has no package inventory");
  }
  const packages = lock.packages;
  const pending = [...ROOT_PACKAGES];
  const selected = new Map<string, LockPackage>();
  for (const root of ROOT_PACKAGES) {
    if (!Array.isArray(packages[root])) throw new Error(`Bun lockfile is missing Auth input ${root}`);
  }
  while (pending.length > 0) {
    const key = pending.pop()!;
    if (selected.has(key)) continue;
    const entry = packages[key];
    if (!Array.isArray(entry)) continue;
    selected.set(key, entry);
    for (const name of [
      ...Object.keys(entry[2]?.dependencies ?? {}),
      ...Object.keys(entry[2]?.optionalDependencies ?? {}),
    ]) {
      const resolved = resolveDependencyKey(packages, key, name);
      if (resolved) pending.push(resolved);
    }
  }
  const canonical = [...selected.entries()]
    .sort(([a], [b]) => {
      if (a === b) return 0;
      return a < b ? -1 : 1;
    })
    .map(([name, entry]) => [name, entry]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function resolveDependencyKey(
  packages: Record<string, LockPackage>,
  parentKey: string,
  dependencyName: string,
): string | undefined {
  const parts = parentKey.split("/");
  const rootParts = parentKey.startsWith("@") ? 2 : 1;
  while (parts.length >= rootParts) {
    const candidate = `${parts.join("/")}/${dependencyName}`;
    if (Array.isArray(packages[candidate])) return candidate;
    parts.pop();
  }
  return Array.isArray(packages[dependencyName]) ? dependencyName : undefined;
}

async function main(): Promise<void> {
  const source = await readFile(LOCK_PATH, "utf8");
  const lock = Bun.JSONC.parse(source) as BunLock;
  const expected = `${JSON.stringify({ version: 1, sha256: authMigrationInputHash(lock) }, null, 2)}\n`;
  if (process.argv.includes("--check")) {
    const actual = await readFile(SNAPSHOT_PATH, "utf8").catch(() => "");
    if (actual !== expected) {
      throw new Error(`Auth migration inputs changed; run bun .config/mise/scripts/repository/auth-migration-inputs.ts and commit ${SNAPSHOT_PATH}`);
    }
    return;
  }
  if (process.argv.length > 2) throw new Error("Unknown Auth migration input argument");
  await writeFile(SNAPSHOT_PATH, expected);
}

if (import.meta.main) await main();
