import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PlopTypes } from "@turbo/gen";


type WorkspaceAnswers = PlopTypes.Answers & {
  name?: string;
  packagePath?: string;
  targetPath?: string;
  packageName?: string;
  pascalName?: string;
  camelName?: string;
  titleName?: string;
  rootExtends?: string;
  packageKind?: string;
  isBuiltPackage?: boolean;
};

const workspacePackagePrefix = ["@", "autograph", "/"].join("");

const segmentPattern = /^[a-z][a-z0-9-]*$/;

function toKebabSegment(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function toPathSegments(value: string, prefixes: readonly string[]): string[] {
  let normalized = value.trim().replace(/\\/g, "/");
  for (const prefix of prefixes) {
    if (normalized.startsWith(prefix)) {
      normalized = normalized.slice(prefix.length);
    }
  }
  return normalized.split("/").filter(Boolean).map(toKebabSegment).filter(Boolean);
}

function toPascalName(value: string): string {
  return value
    .split("-")
    .filter(Boolean)
    .map((segment) => segment[0]?.toUpperCase() + segment.slice(1))
    .join("");
}

function toCamelName(value: string): string {
  const pascal = toPascalName(value);
  return pascal[0]?.toLowerCase() + pascal.slice(1);
}

function validateSegments(segments: readonly string[]): true | string {
  if (segments.length === 0) return "Provide a non-empty name.";
  const invalidSegment = segments.find((segment) => !segmentPattern.test(segment));
  if (invalidSegment) {
    return `Invalid segment "${invalidSegment}". Use lowercase letters, numbers, and hyphens; start with a letter.`;
  }
  return true;
}

function validateAvailablePath(targetPath: string): true | string {
  return existsSync(path.join(process.cwd(), targetPath)) ? `${targetPath} already exists.` : true;
}

function workspacePackageNames(): Set<string> {
  const workspaceRoots = ["packages"];
  const names = new Set<string>();

  for (const workspaceRoot of workspaceRoots) {
    const rootPath = path.join(process.cwd(), workspaceRoot);
    if (!existsSync(rootPath)) continue;
    for (const packageJsonPath of packageJsonFiles(rootPath)) {
      const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: unknown };
      if (typeof manifest.name === "string" && manifest.name.length > 0) {
        names.add(manifest.name);
      }
    }
  }

  return names;
}

function packageJsonFiles(rootPath: string): string[] {
  return readdirSync(rootPath, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isFile() && entry.name === "package.json") return [entryPath];
    if (!entry.isDirectory() || entry.name === "node_modules") return [];
    return packageJsonFiles(entryPath);
  });
}

function validateAvailablePackageName(packageName: string): true | string {
  return workspacePackageNames().has(packageName) ? `${packageName} already exists.` : true;
}

function assertValid(result: true | string): void {
  if (result !== true) {
    throw new Error(result);
  }
}

function sanitizePackageAnswers(answers: WorkspaceAnswers): string {
  const segments = toPathSegments(String(answers.packagePath ?? ""), [
    workspacePackagePrefix,
    "packages/",
  ]);
  const validation = validateSegments(segments);
  assertValid(validation);
  if (segments.length > 2) {
    throw new Error("Packages must live at packages/<name> or packages/<group>/<name>.");
  }

  const targetPath = segments.join("/");
  assertValid(validateAvailablePath(`packages/${targetPath}`));
  const packageSlug = segments.join("-");
  assertValid(validateAvailablePackageName(`${workspacePackagePrefix}${packageSlug}`));
  answers.targetPath = targetPath;
  answers.packagePath = targetPath;
  answers.packageName = `${workspacePackagePrefix}${packageSlug}`;
  answers.pascalName = toPascalName(packageSlug);
  answers.camelName = toCamelName(packageSlug);
  answers.titleName = packageSlug.split("-").map((segment) => segment[0]?.toUpperCase() + segment.slice(1)).join(" ");
  answers.rootExtends = `${"../".repeat(segments.length + 1)}tsconfig.json`;
  const packageKind = answers.packageKind ?? "source";
  if (packageKind !== "source" && packageKind !== "built") {
    throw new Error(`Unsupported package kind: ${packageKind}`);
  }
  answers.packageKind = packageKind;
  answers.isBuiltPackage = packageKind === "built";

  return "Configured package workspace";
}

export default function generator(plop: PlopTypes.NodePlopAPI): void {
  plop.setGenerator("package", {
    description: "Generate an Autograph JavaScript package workspace",
    prompts: [
      {
        type: "input",
        name: "packagePath",
        message: "Package path under packages/ (for example, engines/rules)",
        validate: (value: string) => {
          const segments = toPathSegments(value, ["@autograph/", "packages/"]);
          const validation = validateSegments(segments);
          if (validation !== true) return validation;
          if (segments.length > 2) {
            return "Packages must live at packages/<name> or packages/<group>/<name>.";
          }
          const pathValidation = validateAvailablePath(`packages/${segments.join("/")}`);
          if (pathValidation !== true) return pathValidation;
          return validateAvailablePackageName(`@autograph/${segments.join("-")}`);
        },
      },
      {
        type: "list",
        name: "packageKind",
        message: "Package shape",
        choices: [
          { name: "Workspace source package", value: "source" },
          { name: "Built package for installation outside the workspace", value: "built" },
        ],
        default: "source",
      },
    ],
    actions: [
      sanitizePackageAnswers,
      {
        type: "addMany",
        destination: path.join(process.cwd(), "packages/{{ targetPath }}"),
        base: path.join(process.cwd(), ".config/turbo/generators/templates/package"),
        templateFiles: [
          path.join(process.cwd(), ".config/turbo/generators/templates/package/package.json.hbs"),
          path.join(process.cwd(), ".config/turbo/generators/templates/package/tsconfig.json.hbs"),
          path.join(process.cwd(), ".config/turbo/generators/templates/package/vite.config.ts.hbs"),
          path.join(process.cwd(), ".config/turbo/generators/templates/package/index.ts.hbs"),
          path.join(
            process.cwd(),
            ".config/turbo/generators/templates/package/__tests__/index.test.ts.hbs",
          ),
        ],
        stripExtensions: ["hbs"],
        globOptions: { dot: true },
      },
      {
        type: "add",
        path: path.join(process.cwd(), "packages/{{ targetPath }}/tsconfig.build.json"),
        templateFile: path.join(
          process.cwd(),
          ".config/turbo/generators/templates/package/tsconfig.build.json.hbs",
        ),
        skip: (answers: WorkspaceAnswers) =>
          answers.packageKind === "built" ? false : "Source packages do not need a build config.",
      },
    ],
  });
}
