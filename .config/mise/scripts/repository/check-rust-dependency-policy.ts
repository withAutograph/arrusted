import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  type BoundaryContext,
  domainWords,
  filesUnder,
  maskRustCommentsAndLiterals,
  rel,
  sourceFiles,
  stripComments,
  stripRustCfgTestModules,
  createContext,
} from "./source-analysis";

declare const Bun: { TOML: { parse(source: string): any } };

type Dependency = { alias: string; spec: any; section: string };
const parseToml = (context: BoundaryContext, path: string): any | undefined => {
  try {
    return Bun.TOML.parse(readFileSync(path, "utf8"));
  } catch (error) {
    context.violations.push(`${rel(context, path)}: invalid Cargo TOML: ${error}`);
    return undefined;
  }
};
const dependencies = (payload: any): Dependency[] => {
  const result: Dependency[] = [];
  const add = (table: any, section: string): void => {
    if (table && typeof table === "object")
      for (const [alias, spec] of Object.entries(table)) result.push({ alias, spec, section });
  };
  for (const section of ["dependencies", "dev-dependencies", "build-dependencies"])
    add(payload?.[section], section);
  if (payload?.target && typeof payload.target === "object")
    for (const [target, config] of Object.entries(payload.target))
      for (const section of ["dependencies", "dev-dependencies", "build-dependencies"])
        add((config as any)?.[section], `target.${target}.${section}`);
  return result;
};
const packageName = (dependency: Dependency): string =>
  typeof dependency.spec === "object" && dependency.spec
    ? (dependency.spec.package ?? dependency.alias)
    : dependency.alias;
const pathValue = (dependency: Dependency): string | undefined =>
  typeof dependency.spec === "object" && dependency.spec ? dependency.spec.path : undefined;
const workspaceEnabled = (dependency: Dependency): boolean =>
  typeof dependency.spec === "object" && dependency.spec?.workspace === true;
const features = (dependency: Dependency): string[] =>
  typeof dependency.spec === "object" && Array.isArray(dependency.spec?.features)
    ? dependency.spec.features
    : [];
const PROVIDER_PACKAGES =
  /^(?:ampersand|quickbooks|ramp|ramp_demo|netsuite|xero|sage[-_]intacct|svix)$/i;
const KERNEL_PROVIDER_PACKAGES =
  /^(?:ampersand|quickbooks|ramp|ramp_demo|netsuite|xero|sage[-_]intacct|svix|vendor)$/i;
const APP_PACKAGES = /^(?:hc|vendor|vercel[-_]functions)$/i;
const SHARED_PROVIDER_SOURCE_PATTERNS: [string, RegExp][] = [
  ["Ampersand", /\bampersand\b|Ampersand/i],
  [
    "QuickBooks",
    /\b(?:quickbooks|QuickBooks(?:Vendor|Provider|Client|Api|API|Service|Connector|Compiler|Helper)|VendorQuickBooks(?:Vendor|Provider|Client|Api|API|Service|Connector|Compiler|Helper)|quickbooks[_-](?:vendor|provider|client|api|service|connector|compiler|helper)|vendor[_-]?quickbooks[_-](?:vendor|provider|client|api|service|connector|compiler|helper))\b|(?<![A-Za-z0-9])(?:vendor[_-]?quickbooks[_-](?:vendor|provider|client|api|service|connector|compiler|helper)|quickbooks[_-](?:vendor|provider|client|api|service|connector|compiler|helper)|(?:compile|load)[_-]quickbooks[_-](?:vendor|provider|client|api|service|connector|compiler|helper))(?![A-Za-z0-9])/i,
  ],
  [
    "Ramp",
    /\b(?:ramp|rampDemo|ramp_demo|ramp-demo|vendor[_-]ramp(?:[_-]demo)?|VendorRamp(?:Demo)?|VendorRamp(?:Demo)?(?:Vendor|Provider|Client|Api|API|Service|Connector|Compiler|Helper)|RampVendor|Ramp(?:Demo)?(?:Provider|Client|Api|API|Service|Connector|Compiler|Helper))\b|(?<![A-Za-z0-9])(?:vendor[_-]?ramp(?:[_-]?demo)?[_-](?:vendor|provider|client|api|service|connector|compiler|helper)|ramp(?:[_-]demo)?[_-](?:vendor|provider|client|api|service|connector|compiler|helper)|(?:compile|load)[_-]ramp(?:[_-]demo)?[_-](?:vendor|provider|client|api|service|connector|compiler|helper))(?![A-Za-z0-9])/i,
  ],
  ["NetSuite", /\bnetsuite(?![A-Za-z0-9])|\bNetSuite[A-Za-z0-9_]*/i],
  ["Xero", /\bxero(?![A-Za-z0-9])|\bXero[A-Za-z0-9_]*/i],
  ["Sage Intacct", /\bsage[_-]?intacct(?![A-Za-z0-9])|\bSageIntacct[A-Za-z0-9_]*/i],
  [
    "provider webhook ingress",
    /\b(?:[A-Za-z_]*[sS]vix[A-Za-z_]*|mappedFields|mapped_fields|groupRef|installationId|installation_id|resultInfo|result_info|verifyWebhook|verify_webhook|webhook_ingress)\b/,
  ],
];

const workspaceAliases = (context: BoundaryContext): Map<string, Dependency> => {
  const manifest = join(context.root, "Cargo.toml");
  if (!existsSync(manifest)) return new Map();
  const workspace = parseToml(context, manifest)?.workspace?.dependencies;
  const result = new Map<string, Dependency>();
  if (workspace && typeof workspace === "object")
    for (const [alias, spec] of Object.entries(workspace))
      result.set(alias, { alias, spec, section: "workspace.dependencies" });
  return result;
};

const addAppViolation = (context: BoundaryContext, path: string, surface: string): void => {
  context.violations.push(
    `${rel(context, path)}: app Rust must not own ${surface}; provider ingress belongs at the app integration boundary`,
  );
};

const scanAppRust = (context: BoundaryContext, aliases: Map<string, Dependency>): void => {
  const root = join(context.root, "apps");
  if (!existsSync(root)) return;
  for (const path of sourceFiles(root).filter((path) => path.endsWith(".rs"))) {
    const relativePath = rel(context, path),
      text = stripComments(readFileSync(path, "utf8"));
    if (
      /(?:^|\/)(?:ampersand|quickbooks|ramp(?:demo|[-_]demo)?)(?:\/|_)[^/]*compiler|(?:^|\/)[^/]*compiler[^/]*(?:ampersand|quickbooks|ramp(?:demo|[-_]demo)?)/i.test(
        relativePath,
      )
    )
      addAppViolation(context, path, "provider-to-app compilers");
    const webhook =
      /\b(?:[A-Za-z_]*[sS]vix[A-Za-z_]*|mappedFields|mapped_fields|installationId|installation_id|resultInfo|result_info|verifyWebhook|verify_webhook|webhook_ingress)\b/.test(
        text,
      );
    if (
      webhook ||
      (/\b(?:groupRef|group_ref)\b/.test(text) && /(?:^|\/)webhooks?(?:\.rs|\/)/.test(relativePath))
    )
      addAppViolation(context, path, "provider webhook ingress");
    if (
      /\b(?:use\s+(?:ampersand|quickbooks|ramp|ramp_demo)::|(?:ampersand|quickbooks|ramp|ramp_demo)::|Ampersand(?:Provider|Client|Api|API|Service|Connector)|(?:QuickBooks|Ramp|RampDemo|VendorRamp|VendorRampDemo)(?:Provider|Client|Api|API|Service|Connector)|(?:quickbooks|ramp|ramp_demo|vendor_ramp|vendor_ramp_demo)_(?:provider|client|api|service|connector)|AmpersandPlatform(?:Api|API)?Client|Platform(?:Api|API)?Client|platform_(?:api_)?client)\b/.test(
        text,
      )
    )
      addAppViolation(context, path, "direct provider clients");
    if (
      /\b(?:providerToApp|provider_to_app|compileProvider|providerCompiler|ProviderCompiler|providerToAppCompiler|ampersand_map_to_name|provider_object|source_reference|mapped_field|provider_field|compile_(?:ampersand|quickbooks|ramp|ramp_demo|vendor_ramp(?:_demo)?)_[A-Za-z0-9_]+|(?:ampersand|quickbooks|ramp|ramp_demo|vendor_ramp(?:_demo)?)_[A-Za-z0-9_]*compiler|Ampersand[A-Za-z0-9]*Compiler|(?:QuickBooks|Ramp|RampDemo|VendorRamp|VendorRampDemo)[A-Za-z0-9]*Compiler)\b/.test(
        text,
      )
    )
      addAppViolation(context, path, "provider-to-app compilers");
    if (
      /\b(?:AppIntegrationRecipe|IntegrationObjectRecipe|IntegrationTargetField|IntegrationRecipeFieldMapping|IntegrationRecipeSourceReference|ClearedFieldPolicy|DeterministicMatchingPolicy|EffectiveDatePolicy|MissingOperationTimePolicy|parse_app_integration_recipe_json)\b/.test(
        text,
      )
    )
      addAppViolation(context, path, "integration recipe contracts");
  }
  for (const manifest of filesUnder(root).filter((path) => path.endsWith("Cargo.toml"))) {
    const payload = parseToml(context, manifest);
    if (!payload) continue;
    for (const dependency of dependencies(payload)) {
      const direct = PROVIDER_PACKAGES.test(packageName(dependency));
      const inherited =
        workspaceEnabled(dependency) &&
        aliases.has(dependency.alias) &&
        PROVIDER_PACKAGES.test(packageName(aliases.get(dependency.alias)!));
      if (direct)
        context.violations.push(
          `${rel(context, manifest)}: app Rust must not depend on provider integration crates; provider ingress belongs at the app integration boundary`,
        );
      else if (inherited)
        context.violations.push(
          `${rel(context, manifest)}: app Rust must not depend on provider integration crates through workspace dependency \`${dependency.alias}\`; provider ingress belongs at the app integration boundary`,
        );
    }
  }
};

const scanKernel = (context: BoundaryContext, aliases: Map<string, Dependency>): void => {
  const root = join(context.root, "kernel");
  if (!existsSync(root)) return;
  for (const path of sourceFiles(root).filter((path) => path.endsWith(".rs"))) {
    const relativePath = rel(context, path),
      kernelPath = relative(root, path).replaceAll("\\", "/"),
      text = stripComments(readFileSync(path, "utf8"));
    if (kernelPath === "src/integrations.rs" || kernelPath.startsWith("src/integrations/"))
      context.violations.push(
        `${relativePath}: core kernel must not contain integration modules; app-owned integration code owns provider ingress, recipes, and compilation`,
      );
    if (kernelPath === "src/app_auth.rs" || kernelPath.startsWith("src/app_auth/"))
      context.violations.push(
        `${relativePath}: core kernel must not contain trusted app-auth guard logic; shared app API auth belongs in packages/rust-auth`,
      );
    for (const [label, pattern] of [
      ...SHARED_PROVIDER_SOURCE_PATTERNS,
      [
        "integration recipe contracts",
        /\b(?:AppIntegrationRecipe|IntegrationObjectRecipe|IntegrationTargetField|IntegrationRecipeFieldMapping|IntegrationRecipeSourceReference|ClearedFieldPolicy|DeterministicMatchingPolicy|EffectiveDatePolicy|MissingOperationTimePolicy|parse_app_integration_recipe_json|ampersand_map_to_name|provider_object|source_reference|mapped_field|provider_field)\b/,
      ],
    ] as [string, RegExp][])
      if (pattern.test(text))
        context.violations.push(
          `${relativePath}: core kernel must not reference ${label}; app-owned integration code owns provider ingress, recipes, and compilation`,
        );
    if (
      /\b(?:TrustedAppAuth[A-Za-z0-9_]*|TRUSTED_APP_AUTH[A-Z0-9_]*|[A-Za-z_]*trusted_app_auth[A-Za-z0-9_]*|rust_auth|PLATFORM_TRUSTED_AUTH_CONTEXT_SECRET|x-platform-auth-context-signature)\b/i.test(
        text,
      )
    )
      context.violations.push(
        `${relativePath}: core kernel must not contain trusted app-auth guard logic; shared app API auth belongs in packages/rust-auth`,
      );
  }
  const manifest = join(root, "Cargo.toml");
  if (!existsSync(manifest)) return;
  const payload = parseToml(context, manifest);
  if (!payload) return;
  for (const dependency of dependencies(payload)) {
    const inherited = workspaceEnabled(dependency) ? aliases.get(dependency.alias) : undefined;
    if (KERNEL_PROVIDER_PACKAGES.test(packageName(dependency)))
      context.violations.push(
        "packages/kernel/Cargo.toml: core kernel must not depend on provider integration crates; app-owned integration code owns provider ingress",
      );
    else if (inherited && KERNEL_PROVIDER_PACKAGES.test(packageName(inherited)))
      context.violations.push(
        `packages/kernel/Cargo.toml: core kernel must not depend on provider integration crates through workspace dependency \`${dependency.alias}\`; app-owned integration code owns provider ingress`,
      );
    const rustAuth =
      /rust[-_]auth/i.test(packageName(dependency)) ||
      /packages\/rust-auth/.test(pathValue(dependency) ?? "");
    const inheritedAuth =
      inherited &&
      (/rust[-_]auth/i.test(packageName(inherited)) ||
        /packages\/rust-auth/.test(pathValue(inherited) ?? ""));
    if (rustAuth)
      context.violations.push(
        "packages/kernel/Cargo.toml: core kernel must not depend on rust-auth; shared app API auth belongs outside kernel",
      );
    else if (inheritedAuth)
      context.violations.push(
        `packages/kernel/Cargo.toml: core kernel must not depend on rust-auth through workspace dependency \`${dependency.alias}\`; shared app API auth belongs outside kernel`,
      );
  }
};

const normalizedRustName = (value: string): string => value.replace(/^r#/, "");
type RustUseLeaf = { path: string[]; alias?: string };

const splitRustUseItems = (body: string): string[] => {
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === "{") depth += 1;
    else if (body[index] === "}") depth -= 1;
    else if (body[index] === "," && depth === 0) {
      items.push(body.slice(start, index));
      start = index + 1;
    }
  }
  items.push(body.slice(start));
  return items.filter((item) => item.trim().length > 0);
};

const matchingRustBrace = (text: string, open: number): number => {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}" && --depth === 0) return index;
  }
  return -1;
};

const rustPathSegments = (path: string): string[] =>
  path
    .replace(/^\s*::\s*/, "")
    .split(/\s*::\s*/)
    .map((segment) => normalizedRustName(segment.trim()))
    .filter((segment) => segment.length > 0 && segment !== "self");

const parseRustUseTree = (tree: string, prefix: string[] = []): RustUseLeaf[] => {
  let value = tree.trim().replace(/^::\s*/, "");
  if (!value) return [];
  if (value[0] === "{") {
    const close = matchingRustBrace(value, 0);
    if (close === value.length - 1)
      return splitRustUseItems(value.slice(1, -1)).flatMap((item) =>
        parseRustUseTree(item, prefix),
      );
  }
  const open = value.indexOf("{");
  if (open >= 0) {
    const close = matchingRustBrace(value, open);
    if (close >= 0) {
      const head = value.slice(0, open).replace(/::\s*$/, "");
      const nextPrefix = [...prefix, ...rustPathSegments(head)];
      return splitRustUseItems(value.slice(open + 1, close)).flatMap((item) =>
        parseRustUseTree(item, nextPrefix),
      );
    }
  }
  const match = value.match(/^(.*?)(?:\s+as\s+((?:r#)?[\p{L}_][\p{L}\p{N}_]*))?$/u);
  if (!match) return [];
  return [
    {
      path: [...prefix, ...rustPathSegments(match[1]!)],
      ...(match[2] ? { alias: normalizedRustName(match[2]) } : {}),
    },
  ];
};

const rustUseLeaves = (text: string): RustUseLeaf[] => {
  const leaves: RustUseLeaf[] = [];
  const usePattern = /\buse\b/gu;
  let _useMatch: RegExpExecArray | null;
  while ((_useMatch = usePattern.exec(text))) {
    const start = usePattern.lastIndex;
    let depth = 0;
    let end = start;
    for (; end < text.length; end += 1) {
      if (text[end] === "{") depth += 1;
      else if (text[end] === "}") depth -= 1;
      else if (text[end] === ";" && depth === 0) break;
    }
    if (end >= text.length) continue;
    leaves.push(...parseRustUseTree(text.slice(start, end)));
    usePattern.lastIndex = end + 1;
  }
  return leaves;
};

const kernelAliases = (text: string, leaves: RustUseLeaf[]): Set<string> => {
  const kernelIsShadowed = leaves.some((leaf) => leaf.alias === "kernel" && leaf.path.length > 1);
  const aliases = new Set(kernelIsShadowed ? [] : ["kernel"]);
  for (const match of text.matchAll(
    /\bextern\s+crate\s+(?:r#)?kernel\s+as\s+((?:r#)?[\p{L}_][\p{L}\p{N}_]*)\s*;/gu,
  ))
    aliases.add(normalizedRustName(match[1]!));
  let changed = true;
  while (changed) {
    changed = false;
    for (const leaf of leaves) {
      if (leaf.path.length !== 1 || !leaf.alias || !aliases.has(leaf.path[0]!)) continue;
      if (!aliases.has(leaf.alias)) {
        aliases.add(leaf.alias);
        changed = true;
      }
    }
  }
  return aliases;
};

const kernelUseReferences = (source: string): RustUseLeaf[] => {
  const text = maskRustCommentsAndLiterals(source);
  const leaves = rustUseLeaves(text);
  const aliases = kernelAliases(text, leaves);
  return leaves.filter((leaf) => leaf.path.length > 1 && aliases.has(leaf.path[0]!));
};

const rustAuthReferencesTesting = (source: string): boolean => {
  const text = maskRustCommentsAndLiterals(source);
  const leaves = rustUseLeaves(text);
  const aliases = kernelAliases(text, leaves);
  if (leaves.some((leaf) => leaf.path[1] === "testing" && aliases.has(leaf.path[0]!))) return true;
  for (const alias of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}\\s*::\\s*(?:r#)?testing\\b`, "u").test(text))
      return true;
  }
  return false;
};

const targetsKernel = (dependency: Dependency): boolean =>
  /^kernel$/i.test(packageName(dependency)) ||
  /(?:^|\/)kernel(?:\/|$)/.test(pathValue(dependency) ?? "");
const scanRustAuth = (context: BoundaryContext, aliases: Map<string, Dependency>): void => {
  const root = join(context.packages, "rust-auth");
  if (!existsSync(root)) return;
  const words = domainWords(context);
  for (const path of sourceFiles(root).filter((path) => path.endsWith(".rs"))) {
    const relativePath = rel(context, path),
      raw = readFileSync(path, "utf8"),
      text = stripComments(raw);
    for (const [label, pattern] of [
      ...SHARED_PROVIDER_SOURCE_PATTERNS,
      [
        "direct provider clients",
        /\b(?:use\s+(?:ampersand|quickbooks|ramp|ramp_demo)::|(?:ampersand|quickbooks|ramp|ramp_demo)::|Ampersand(?:Provider|Client|Api|API|Service|Connector)|(?:QuickBooks|Ramp|RampDemo|VendorRamp|VendorRampDemo)(?:Provider|Client|Api|API|Service|Connector))\b/,
      ],
      [
        "provider-to-app compilers",
        /\b(?:providerToApp|provider_to_app|compileProvider|providerCompiler|ProviderCompiler|providerToAppCompiler|ampersand_map_to_name|provider_object|source_reference|mapped_field|provider_field)\b/,
      ],
      [
        "integration recipe contracts",
        /\b(?:AppIntegrationRecipe|IntegrationObjectRecipe|IntegrationTargetField|IntegrationRecipeFieldMapping|IntegrationRecipeSourceReference|ClearedFieldPolicy|DeterministicMatchingPolicy|EffectiveDatePolicy|MissingOperationTimePolicy|parse_app_integration_recipe_json)\b/,
      ],
    ] as [string, RegExp][])
      if (pattern.test(text))
        context.violations.push(
          `${relativePath}: rust-auth package must not reference ${label}; shared app auth must stay provider-agnostic`,
        );
    if (rustAuthReferencesTesting(raw))
      context.violations.push(
        `${relativePath}: rust-auth package must not reference kernel testing escape hatch; shared app auth must stay provider-agnostic`,
      );
    for (const match of raw.matchAll(
      /\b(?:integration_connections?|integration_app_bindings?|integration_activation_grants?|vendor_integration_imports?|vendor_integration_record_links?|vendor_integration_mappings?)\b/gi,
    ))
      context.violations.push(
        `${relativePath}: rust-auth package must not reference connection/app-binding metadata (\`${match[0]}\`); shared app auth must stay app-agnostic`,
      );
    for (const word of words)
      if (
        new RegExp(
          `(?<![A-Za-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`,
          "i",
        ).test(text)
      )
        context.violations.push(
          `${relativePath}: rust-auth package must not reference domain-specific word \`${word}\`; shared app auth must stay app-agnostic`,
        );
  }
  const manifest = join(root, "Cargo.toml");
  if (!existsSync(manifest)) return;
  const payload = parseToml(context, manifest);
  if (!payload) return;
  const rustDependencies = dependencies(payload);
  for (const dependency of rustDependencies) {
    const inherited = workspaceEnabled(dependency) ? aliases.get(dependency.alias) : undefined;
    if (KERNEL_PROVIDER_PACKAGES.test(packageName(dependency)))
      context.violations.push(
        `${rel(context, manifest)}: rust-auth package must not depend on provider integration crates; shared app auth must stay provider-agnostic`,
      );
    else if (inherited && KERNEL_PROVIDER_PACKAGES.test(packageName(inherited)))
      context.violations.push(
        `${rel(context, manifest)}: rust-auth package must not depend on provider integration crates through workspace dependency \`${dependency.alias}\`; shared app auth must stay provider-agnostic`,
      );
    if (APP_PACKAGES.test(packageName(dependency)) || /apps\//.test(pathValue(dependency) ?? ""))
      context.violations.push(
        `${rel(context, manifest)}: rust-auth package must not depend on app Rust crates; shared app auth must stay app-agnostic`,
      );
    else if (
      inherited &&
      (APP_PACKAGES.test(packageName(inherited)) || /apps\//.test(pathValue(inherited) ?? ""))
    )
      context.violations.push(
        `${rel(context, manifest)}: rust-auth package must not depend on app Rust crates through workspace dependency \`${dependency.alias}\`; shared app auth must stay app-agnostic`,
      );
    if (
      (targetsKernel(dependency) || (inherited && targetsKernel(inherited))) &&
      features(dependency).includes("testing")
    )
      context.violations.push(
        `${rel(context, manifest)}: rust-auth package must not enable kernel testing feature; shared app auth must stay on the public kernel facade`,
      );
    if (inherited && targetsKernel(inherited) && features(inherited).includes("testing"))
      context.violations.push(
        `${rel(context, manifest)}: rust-auth package must not enable kernel testing feature through workspace dependency \`${dependency.alias}\`; shared app auth must stay on the public kernel facade`,
      );
  }
  const kernelAliases = new Set(
    rustDependencies
      .filter(
        (dependency) =>
          targetsKernel(dependency) ||
          (workspaceEnabled(dependency) &&
            aliases.has(dependency.alias) &&
            targetsKernel(aliases.get(dependency.alias)!)),
      )
      .map((dependency) => dependency.alias),
  );
  for (const values of Object.values(payload.features ?? {}))
    if (Array.isArray(values))
      for (const value of values)
        if (
          typeof value === "string" &&
          [...kernelAliases].some((alias) =>
            new RegExp(`^${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\??/testing$`).test(value),
          )
        )
          context.violations.push(
            `${rel(context, manifest)}: rust-auth package must not enable kernel testing feature; shared app auth must stay on the public kernel facade`,
          );
};

const scanPublicKernelImports = (context: BoundaryContext): void => {
  const apps = join(context.root, "apps"),
    forbidden = new Set(["contracts", "db", "error", "identifiers", "testing", "validation"]);
  if (!existsSync(apps)) return;
  for (const path of filesUnder(apps).filter((path) => path.endsWith(".rs"))) {
    for (const reference of kernelUseReferences(readFileSync(path, "utf8"))) {
      const module = reference.path[1]!;
      if (forbidden.has(module))
        context.violations.push(
          `${rel(context, path)}: forbidden internal kernel import \`kernel::${module}\``,
        );
    }
  }
};

const scanKernelTestingExport = (context: BoundaryContext): void => {
  const path = join(context.root, "packages/kernel/src/lib.rs");
  if (!existsSync(path)) return;
  const clean = stripComments(readFileSync(path, "utf8"));
  const valid = /#\s*\[\s*cfg\s*\(\s*feature\s*=\s*"testing"\s*\)\s*\]\s*pub\s+mod\s+testing\b/g;
  const validCount = [...clean.matchAll(valid)].length;
  const withoutValid = clean.replace(valid, "");
  if (validCount === 0 || /\bpub\s+mod\s+testing\b/.test(withoutValid))
    context.violations.push(
      "kernel::testing must stay gated behind the explicit `testing` feature",
    );
};

export const checkRustDependencyPolicy = (context: BoundaryContext): void => {
  const aliases = workspaceAliases(context);
  scanAppRust(context, aliases);
  scanKernel(context, aliases);
  scanRustAuth(context, aliases);
  scanPublicKernelImports(context);
  scanKernelTestingExport(context);
};

if (import.meta.main) {
  const root = process.argv[2] ?? process.cwd();
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    console.error(`Invalid repository root: ${root}`);
    process.exit(2);
  }
  const context = createContext(root);
  checkRustDependencyPolicy(context);
  if (context.violations.length > 0) {
    console.error(context.violations.join("\n"));
    process.exit(1);
  }
}
