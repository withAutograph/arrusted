import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const PROVIDER_OWNERSHIP_MARKERS = ["ampersand", "quickbooks", "ramp", "xero"];

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const markerPattern = (markers: readonly string[]): RegExp =>
  new RegExp(`(?:^|[-_:/.])(?:${markers.map(escapeRegExp).join("|")})(?:$|[-_:/.])`, "i");

const appIds = (root: string): string[] => {
  const appsRoot = join(root, "apps");
  if (!existsSync(appsRoot)) return [];
  return readdirSync(appsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(appsRoot, entry.name, "package.json")))
    .map((entry) => entry.name);
};

const rootTaskPaths = (root: string): string[] => {
  const tasksRoot = join(root, ".config/mise/tasks");
  if (!existsSync(tasksRoot)) return [];
  const paths: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else paths.push(relative(tasksRoot, path));
    }
  };
  visit(tasksRoot);
  return paths;
};

const rootTaskNames = (root: string): string[] => {
  const configPath = join(root, ".config/mise/config.toml");
  if (!existsSync(configPath)) return [];
  const source = readFileSync(configPath, "utf8");
  const names: string[] = [];
  const taskHeader = /^\[tasks\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\]/gmu;
  for (const match of source.matchAll(taskHeader)) names.push(match[1] ?? match[2] ?? match[3]);
  return names;
};

export const findTaskOwnershipViolations = (root: string): string[] => {
  const markers = [...appIds(root), ...PROVIDER_OWNERSHIP_MARKERS];
  const forbidden = markerPattern(markers);
  const missingInputs = [
    !existsSync(join(root, ".config/mise/tasks")) ? ".config/mise/tasks (missing)" : null,
    !existsSync(join(root, ".config/mise/config.toml")) ? ".config/mise/config.toml (missing)" : null,
  ].filter((path): path is string => path !== null);
  return [
    ...missingInputs,
    ...rootTaskPaths(root)
      .filter((path) => forbidden.test(path))
      .map((path) => `.config/mise/tasks/${path}`),
    ...rootTaskNames(root)
      .filter((name) => forbidden.test(name))
      .map((name) => `.config/mise/config.toml task alias ${name}`),
  ];
};

if (import.meta.main) {
  const violations = findTaskOwnershipViolations(process.cwd());
  if (violations.length > 0) {
    console.error("Mise task ownership check failed:");
    for (const violation of violations) console.error(`- ${violation}`);
    process.exitCode = 1;
  }
}
