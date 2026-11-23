import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

export type BoundaryContext = {
  root: string;
  packages: string;
  domainLibs: string;
  violations: string[];
};

export const createContext = (root = process.cwd()): BoundaryContext => {
  const resolved = resolve(root);
  return {
    root: resolved,
    packages: join(resolved, "packages"),
    domainLibs: join(resolved, "packages", "domain-libs"),
    violations: [],
  };
};

export const SOURCE_EXTENSIONS = new Set([
  ".rs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".css",
]);
export const SOURCE_EXCLUDED_PARTS = new Set([
  "~",
  ".scratch",
  ".next",
  ".turbo",
  "dist",
  "node_modules",
  "storybook-static",
  "target",
]);
export const SOURCE_EXCLUDED_FILENAMES = new Set(["next-env.d.ts"]);

export const toPosix = (value: string): string => value.split(sep).join("/");
export const rel = (context: BoundaryContext, path: string): string =>
  toPosix(relative(context.root, path));

export const isUnder = (path: string | undefined, root: string): boolean => {
  if (!path) return false;
  const delta = relative(root, path);
  return delta === "" || (!delta.startsWith(`..${sep}`) && delta !== ".." && !isAbsolute(delta));
};

export const isExcludedSourcePath = (root: string, path: string): boolean => {
  if (SOURCE_EXCLUDED_FILENAMES.has(path.split(sep).at(-1) ?? "")) return true;
  return toPosix(relative(root, path))
    .split("/")
    .some((part) => SOURCE_EXCLUDED_PARTS.has(part));
};

const walk = (root: string, output: string[]): void => {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (SOURCE_EXCLUDED_PARTS.has(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) walk(path, output);
    else if (entry.isFile()) output.push(path);
  }
};

export const filesUnder = (root: string): string[] => {
  const files: string[] = [];
  walk(root, files);
  return files.sort();
};

const isolatedGitCommand = [
  "-u",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "-u",
  "GIT_COMMON_DIR",
  "-u",
  "GIT_CONFIG",
  "-u",
  "GIT_CONFIG_COUNT",
  "-u",
  "GIT_CONFIG_PARAMETERS",
  "-u",
  "GIT_DIR",
  "-u",
  "GIT_GRAFT_FILE",
  "-u",
  "GIT_IMPLICIT_WORK_TREE",
  "-u",
  "GIT_INDEX_FILE",
  "-u",
  "GIT_INTERNAL_SUPER_PREFIX",
  "-u",
  "GIT_NO_REPLACE_OBJECTS",
  "-u",
  "GIT_OBJECT_DIRECTORY",
  "-u",
  "GIT_PREFIX",
  "-u",
  "GIT_REPLACE_REF_BASE",
  "-u",
  "GIT_SHALLOW_FILE",
  "-u",
  "GIT_WORK_TREE",
  "git",
] as const;

export const repositoryFiles = (root: string): string[] => {
  const resolved = resolve(root);
  const gitMarker = join(resolved, ".git");
  if (!existsSync(gitMarker)) return filesUnder(resolved);

  const output = execFileSync(
    "env",
    [
      ...isolatedGitCommand,
      "-C",
      resolved,
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return [...new Set(output.split("\0").filter(Boolean))]
    .map((path) => join(resolved, path))
    .filter((path) => {
      let metadata;
      try {
        metadata = lstatSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
      if (metadata.isSymbolicLink()) {
        throw new Error(
          `repository file enumeration does not permit symlinks: ${relative(resolved, path)}`,
        );
      }
      return metadata.isFile();
    })
    .sort();
};

export const sourceFiles = (root: string): string[] =>
  filesUnder(root).filter(
    (path) => SOURCE_EXTENSIONS.has(extname(path)) && !isExcludedSourcePath(root, path),
  );

export const readText = (path: string): string => readFileSync(path, "utf8");
export const readJson = (path: string): unknown => JSON.parse(readText(path));

export const stripComments = (text: string): string => {
  let output = "";
  let index = 0;
  while (index < text.length) {
    const quote = text[index];
    if (quote === "'" || quote === '"' || quote === "`") {
      const start = index++;
      let escaped = false;
      while (index < text.length) {
        const current = text[index++];
        if (escaped) escaped = false;
        else if (current === "\\") escaped = true;
        else if (current === quote) break;
      }
      output += text.slice(start, index);
      continue;
    }
    if (text.startsWith("//", index)) {
      const end = text.indexOf("\n", index);
      if (end === -1) return output + text.slice(index).replace(/[^\n]/g, " ");
      output += text.slice(index, end).replace(/[^\n]/g, " ");
      index = end;
      continue;
    }
    if (text.startsWith("/*", index)) {
      const closing = text.indexOf("*/", index + 2);
      const end = closing === -1 ? text.length : closing + 2;
      output += text.slice(index, end).replace(/[^\n]/g, " ");
      index = end;
      continue;
    }
    output += text[index++];
  }
  return output;
};

export const maskQuotedLiterals = (text: string, includeTemplates = true): string => {
  let output = "";
  let index = 0;
  while (index < text.length) {
    const quote = text[index];
    if (quote !== "'" && quote !== '"' && (!includeTemplates || quote !== "`")) {
      output += quote;
      index += 1;
      continue;
    }
    let escaped = false;
    const start = index;
    index += 1;
    while (index < text.length) {
      const current = text[index++];
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === quote) break;
    }
    output += text.slice(start, index).replace(/[^\n]/g, " ");
  }
  return output;
};

// Historical name retained for parity with the compatibility scanner: this
// masks comments while preserving string literals for semantic tripwires.
export const stripCommentsAndStrings = (text: string): string => stripComments(text);
export const stripTemplateLiterals = (text: string): string => {
  let output = "";
  let index = 0;
  while (index < text.length) {
    if (text[index] === "'" || text[index] === '"') {
      const quote = text[index];
      const start = index++;
      let escaped = false;
      while (index < text.length) {
        const current = text[index++];
        if (escaped) escaped = false;
        else if (current === "\\") escaped = true;
        else if (current === quote) break;
      }
      output += text.slice(start, index);
      continue;
    }
    if (text[index] !== "`") {
      output += text[index++];
      continue;
    }
    const start = index++;
    let escaped = false;
    while (index < text.length) {
      const current = text[index++];
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === "`") break;
    }
    output += "\n".repeat(text.slice(start, index).split("\n").length - 1);
  }
  return output;
};

const DOMAIN_WORD_ALLOWLIST = new Set([
  "demo",
  "id",
  "key",
  "level",
  "manager",
  "name",
  "notes",
  "person",
  "position",
  "known_aliases",
  "ref",
  "status",
  "title",
]);

export const domainWords = (context: BoundaryContext): string[] => {
  const words = new Set<string>();
  for (const path of sourceFiles(join(context.root, "apps"))) {
    const relativePath = rel(context, path);
    if (
      !/\.(?:rs|tsx?)$/.test(path) ||
      !/(?:^|\/)(?:schema|schemas)(?:\/|\.)|\/(?:lib|schema)\.rs$/.test(relativePath)
    )
      continue;
    const text = readFileSync(path, "utf8");
    for (const pattern of [
      /\b(?:AppId|CustomerId|ModelId|FieldId|ChangeTypeId)::from\("([^"]+)"\)/g,
      /\bpub\s+const\s+(?:APP_ID|CUSTOMER_ID)\s*:\s*&str\s*=\s*"([^"]+)"/g,
    ])
      for (const match of text.matchAll(pattern)) {
        const value = match[1]!.trim().toLowerCase();
        if (value && !DOMAIN_WORD_ALLOWLIST.has(value)) words.add(value);
      }
  }
  return [...words].sort();
};

export const normalizeMemberAccess = (text: string): string =>
  text.replace(/\?\s*\./g, ".").replace(/\s*\.\s*/g, ".");

const blank = (source: string): string => source.replace(/[^\n]/g, " ");
export const maskRustCommentsAndLiterals = (source: string, preserveCfgTesting = false): string => {
  let output = "";
  let index = 0;
  while (index < source.length) {
    if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index);
      if (end < 0) return output + blank(source.slice(index));
      output += blank(source.slice(index, end)) + "\n";
      index = end + 1;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const start = index;
      index += 2;
      let depth = 1;
      while (index < source.length && depth > 0) {
        if (source.startsWith("/*", index)) {
          depth += 1;
          index += 2;
        } else if (source.startsWith("*/", index)) {
          depth -= 1;
          index += 2;
        } else index += 1;
      }
      output += blank(source.slice(start, index));
      continue;
    }
    const raw = source.slice(index).match(/^(?:b|c)?r(#+)?"/);
    if (raw) {
      const start = index;
      const hashes = raw[1] ?? "";
      index += raw[0].length;
      const end = source.indexOf(`"${hashes}`, index);
      index = end < 0 ? source.length : end + 1 + hashes.length;
      output += blank(source.slice(start, index));
      continue;
    }
    const bytePrefix =
      (source[index] === "b" || source[index] === "c") && source[index + 1] === '"' ? 1 : 0;
    if (source[index] === '"' || bytePrefix) {
      const start = index;
      index += bytePrefix + 1;
      let escaped = false;
      while (index < source.length) {
        const character = source[index++];
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') break;
      }
      const literal = source.slice(start, index);
      output +=
        preserveCfgTesting &&
        literal === '"testing"' &&
        /#\s*\[\s*cfg\s*\(\s*feature\s*=\s*$/.test(output)
          ? literal
          : blank(literal);
      continue;
    }
    const charStart = source[index] === "b" && source[index + 1] === "'" ? index + 1 : index;
    if (source[charStart] === "'") {
      let cursor = charStart + 1;
      let escaped = false;
      let closing = -1;
      while (cursor < Math.min(source.length, charStart + 12)) {
        const character = source[cursor++];
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === "'") {
          closing = cursor;
          break;
        } else if (character === "\n") break;
      }
      if (closing >= 0) {
        output += blank(source.slice(index, closing));
        index = closing;
        continue;
      }
    }
    output += source[index++];
  }
  return output;
};

export const stripRustCfgTestModules = (source: string): string => {
  const masked = maskRustCommentsAndLiterals(source);
  const pattern = /#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]\s*mod\s+[A-Za-z_][A-Za-z0-9_]*\s*\{/gm;
  let output = "";
  let cursor = 0;
  for (const match of masked.matchAll(pattern)) {
    if (match.index === undefined || match.index < cursor) continue;
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let end = open;
    for (; end < masked.length; end += 1) {
      if (masked[end] === "{") depth += 1;
      else if (masked[end] === "}" && --depth === 0) {
        end += 1;
        break;
      }
    }
    output += source.slice(cursor, match.index) + blank(source.slice(match.index, end));
    cursor = end;
  }
  return output + source.slice(cursor);
};

export type ImportReference = { statement: string; specifier: string };
const IMPORT_PATTERNS = [
  /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?["'](?<import>[^"']+)["']/gm,
  /(?<![A-Za-z0-9_$.])\bimport\s*\(\s*["'](?<import>[^"']+)["']\s*\)/gm,
  /(?<![A-Za-z0-9_$.])\brequire\s*\(\s*["'](?<import>[^"']+)["']\s*\)/gm,
];
const STATIC_TEMPLATE_IMPORT =
  /(?<![A-Za-z0-9_$.])\bimport\s*\(\s*`(?<import>(?:(?!\$\{)[^`\r\n])+)`\s*\)/gm;

export const importReferences = (text: string): ImportReference[] => {
  const withoutComments = stripComments(text);
  const clean = stripTemplateLiterals(withoutComments);
  const templateImportSource = maskQuotedLiterals(withoutComments, false);
  const imports: ImportReference[] = [];
  for (const [pattern, source] of [
    ...IMPORT_PATTERNS.map((pattern) => [pattern, clean] as const),
    [STATIC_TEMPLATE_IMPORT, templateImportSource] as const,
  ]) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const specifier = match.groups?.import;
      if (specifier) imports.push({ statement: match[0], specifier });
    }
  }
  return imports;
};

export const hasUseClientDirective = (path: string): boolean =>
  /^\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*(["'])use client\1\s*;?/.test(readText(path));

export const isTestSource = (context: BoundaryContext, path: string): boolean => {
  const normalized = rel(context, path);
  return normalized.includes("/__tests__/") || /\.test\.tsx?$/.test(normalized);
};

export const resolveSourcePath = (target: string): string | undefined => {
  const candidates = [
    target,
    `${target}.ts`,
    `${target}.tsx`,
    `${target}.rs`,
    `${target}.css`,
    join(target, "index.ts"),
    join(target, "index.tsx"),
    join(target, "mod.rs"),
  ];
  if (target.endsWith(".js")) {
    const stem = target.slice(0, -3);
    candidates.push(`${stem}.ts`, `${stem}.tsx`);
  }
  if (target.endsWith(".mjs")) candidates.push(`${target.slice(0, -4)}.mts`);
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
};

export const resolveLocalImport = (sourcePath: string, specifier: string): string | undefined => {
  if (!specifier.startsWith(".")) return undefined;
  return resolveSourcePath(normalize(resolve(dirname(sourcePath), specifier)));
};
