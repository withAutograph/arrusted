const requiredPreCommitMappings = [
  "format",
  "lint",
  "fastCheck",
  "types",
] as const;

const requiredExhaustiveMappings = [
  ...requiredPreCommitMappings,
  "rustCheck",
  "affectedRustCheck",
  "affectedKonsistent",
  "exhaustiveCheck",
] as const;

const requiredPrePushMappings = ["format", "lint", "fastCheck", "affectedKonsistent", "types"] as const;

function hookBody(config: string, hook: string): string {
  const marker = `["${hook}"] {`;
  const start = config.indexOf(marker);
  if (start === -1) throw new Error(`missing ${hook} hook`);
  const nextHook = config.indexOf('\n  ["', start + marker.length);
  return config.slice(start, nextHook === -1 ? config.length : nextHook);
}

function mappingBody(config: string, mapping: string): string {
  const marker = `local ${mapping} =`;
  const start = config.indexOf(marker);
  if (start === -1) throw new Error(`missing ${mapping} mapping`);
  const nextMapping = config.indexOf("\n\nlocal ", start + marker.length);
  return config.slice(start, nextMapping === -1 ? config.length : nextMapping);
}

function stepBody(mapping: string, step: string): string {
  const marker = `["${step}"] = new Step {`;
  const start = mapping.indexOf(marker);
  if (start === -1) throw new Error(`missing ${step} step`);
  const nextStep = mapping.indexOf('\n  ["', start + marker.length);
  return mapping.slice(start, nextStep === -1 ? mapping.length : nextStep);
}

function hasGlobEntry(declaration: string, entry: string): boolean {
  const glob = declaration.match(/=\s*"([^"]*)"/u)?.[1] ?? "";
  const escaped = entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:\\{|,)${escaped}(?:,|\\})`).test(glob);
}

function withoutCommentsAndStrings(source: string): string {
  let result = "";
  let index = 0;
  while (index < source.length) {
    if (source.startsWith("//", index)) {
      const newline = source.indexOf("\n", index + 2);
      if (newline === -1) return result;
      result += "\n";
      index = newline + 1;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      const comment = source.slice(index, end === -1 ? source.length : end + 2);
      result += comment.replace(/[^\n]/g, " ");
      index += comment.length;
      continue;
    }
    if (source[index] === '"') {
      result += " ";
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") {
          result += "  ";
          index += 2;
          continue;
        }
        if (source[index] === '"') {
          result += " ";
          index += 1;
          break;
        }
        result += source[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      continue;
    }
    result += source[index];
    index += 1;
  }
  return result;
}

function hasMappingSpread(body: string, mapping: string): boolean {
  return new RegExp(`^\\s*\\.\\.\\.${mapping}\\s*$`, "m").test(withoutCommentsAndStrings(body));
}

function withoutMultilineStringsAndComments(source: string): string {
  let result = "";
  let index = 0;
  while (index < source.length) {
    if (source.startsWith('"""', index)) {
      const end = source.indexOf('"""', index + 3);
      const value = source.slice(index, end === -1 ? source.length : end + 3);
      result += value.replace(/[^\n]/g, " ");
      index += value.length;
      continue;
    }
    if (source.startsWith("//", index)) {
      const newline = source.indexOf("\n", index + 2);
      if (newline === -1) return result;
      result += "\n";
      index = newline + 1;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      const comment = source.slice(index, end === -1 ? source.length : end + 2);
      result += comment.replace(/[^\n]/g, " ");
      index += comment.length;
      continue;
    }
    if (source[index] === '"') {
      const start = index;
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === '"') {
          index += 1;
          break;
        }
        index += 1;
      }
      result += source.slice(start, index);
      continue;
    }
    result += source[index];
    index += 1;
  }
  return result;
}

function requireMappings(body: string, hook: string, mappings: readonly string[]): void {
  for (const mapping of mappings) {
    if (!hasMappingSpread(body, mapping)) {
      throw new Error(`${hook} must include ${mapping}`);
    }
  }
}

export function validateGitHookGates(config: string): void {
  const preCommit = hookBody(config, "pre-commit");
  const check = hookBody(config, "check");
  const prePush = hookBody(config, "pre-push");

  requireMappings(preCommit, "pre-commit", requiredPreCommitMappings);
  requireMappings(check, "check", requiredExhaustiveMappings);
  requireMappings(prePush, "pre-push", requiredPrePushMappings);

  for (const mapping of ["rustCheck", "exhaustiveCheck", "tests"]) {
    if (hasMappingSpread(preCommit, mapping)) {
      throw new Error(`pre-commit must not include ${mapping}`);
    }
  }
  for (const mapping of ["rustCheck", "affectedRustCheck", "exhaustiveCheck", "tests"]) {
    if (hasMappingSpread(prePush, mapping)) {
      throw new Error(`pre-push must not include transport-blocking ${mapping}`);
    }
  }
  if (!config.includes(".config/mise/scripts/repository/run-affected-rust-validation.sh")) {
    throw new Error("the affected Rust wrapper must trigger Rust validation");
  }
  const gitHookGate = stepBody(mappingBody(config, "fastCheck"), "check:git-hook-gates");
  if (
    !/^\s*glob\s*=\s*"[^"]*scripts\/repository\/run-affected-rust-validation\.sh[^"]*"\s*$/mu.test(
      gitHookGate,
    )
  ) {
    throw new Error("git hook gate tests must trigger when the affected Rust wrapper changes");
  }
  const githubActionsGate = stepBody(mappingBody(config, "fastCheck"), "check:github-actions");
  const githubActionsFiles = mappingBody(config, "githubActionsFilesGlob");
  for (const requiredInput of [
    ".github/actions/**/*.{yml,yaml}",
    ".github/workflows/**/*.{yml,yaml}",
    ".config/hk.pkl",
    ".config/mise/{config.toml,mise.lock}",
    ".config/mise/scripts/repository/check-git-hook-gates.{ts,test.ts}",
  ]) {
    if (!hasGlobEntry(githubActionsFiles, requiredInput)) {
      throw new Error(
        "the GitHub Actions gate must cover workflows, local actions, and its owning contracts",
      );
    }
  }
  if (!/^\s*glob\s*=\s*githubActionsFilesGlob\s*$/mu.test(githubActionsGate)) {
    throw new Error(
      "the GitHub Actions gate must cover workflows, local actions, and its owning contracts",
    );
  }
  if (!/^\s*check\s*=\s*"mise exec -- actionlint"\s*$/mu.test(githubActionsGate)) {
    throw new Error("the GitHub Actions gate must run pinned actionlint through mise");
  }
  if (
    !config.includes(
      'local konsistentAffectedFilesGlob = "packages/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts,css}"',
    )
  ) {
    throw new Error("affected Konsistent checks must cover every supported module extension");
  }
  const konsistentSourceGate = stepBody(mappingBody(config, "fastCheck"), "check:konsistent-source");
  if (
    !konsistentSourceGate.includes("packages/**/*.{js,jsx,ts,tsx,mjs,mts,cjs,cts}") ||
    !/^\s*check\s*=\s*"bash \.config\/mise\/scripts\/repository\/check-konsistent-affected\.sh \{\{ files \}\}"\s*$/mu.test(
      konsistentSourceGate,
    )
  ) {
    throw new Error("Konsistent gate must cover all governed application and package sources");
  }
}

if (import.meta.main) {
  validateGitHookGates(
    await Bun.file(new URL("../../../../.config/hk.pkl", import.meta.url)).text(),
  );
  console.log("git hook gate topology is valid");
}
