import type { NextConfig } from "next";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const workspacePathsFile = path.resolve(
  import.meta.dirname,
  "../../.config/typescript/workspace-paths.json",
);
const workspacePaths = JSON.parse(readFileSync(workspacePathsFile, "utf8")) as {
  compilerOptions: { paths: Record<string, string[]> };
};
const workspaceSourceAliases: Record<string, string> = {};
for (const [alias, [source]] of Object.entries(workspacePaths.compilerOptions.paths)) {
  if (alias === "@/*") continue;
  if (source === undefined) throw new Error(`Missing TypeScript path for ${alias}`);
  workspaceSourceAliases[alias] = path.resolve(path.dirname(workspacePathsFile), source);
}

function turbopackAliases(dir: string): Record<string, string> {
  return {
    "@/*": "./*",
    ...Object.fromEntries(
      Object.entries(workspaceSourceAliases).map(([alias, source]) => {
        const relative = path.relative(dir, source);
        return [alias, relative.startsWith(".") ? relative : `./${relative}`];
      }),
    ),
  };
}

/** Keep source and linked package caches inside Next's supported filesystem boundary. */
function linkedFilesystemRoot(dir: string): string {
  const roots = [path.resolve(dir), path.resolve(import.meta.dirname, "../..")];
  const includeRealPath = (filename: string) => {
    try {
      roots.push(realpathSync(filename));
    } catch {
      // Missing optional dependency directories leave normal Next resolution authoritative.
    }
  };
  includeRealPath(dir);
  includeRealPath(path.resolve(import.meta.dirname, "../.."));
  let directory = path.resolve(dir);
  for (;;) {
    const dependencies = path.join(directory, "node_modules");
    includeRealPath(dependencies);
    try {
      for (const entry of readdirSync(dependencies, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const filename = path.join(dependencies, entry.name);
        if (entry.isSymbolicLink()) includeRealPath(filename);
        if (entry.name.startsWith("@")) {
          try {
            for (const scoped of readdirSync(filename, { withFileTypes: true })) {
              if (scoped.isSymbolicLink()) includeRealPath(path.join(filename, scoped.name));
            }
          } catch {
            // Unavailable scopes do not introduce a separate dependency admission check.
          }
        }
      }
    } catch {
      // Next reports actual missing or unreadable dependencies when the build uses them.
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  try {
    includeRealPath(createRequire(path.join(dir, "package.json")).resolve("next/package.json"));
  } catch {
    // Keep configuration usable before dependencies are installed.
  }
  let root = path.resolve(dir);
  while (
    roots.some((filename) => {
      const relative = path.relative(root, filename);
      return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
    })
  ) {
    const parent = path.dirname(root);
    if (parent === root) break;
    root = parent;
  }
  return root;
}

/** Shared Next.js settings used by route-owned applications. */
export const nextConfigDefaults = {
  cacheComponents: true,
  partialPrefetching: true,
  poweredByHeader: false,
  reactCompiler: true,
  typedRoutes: true,
  turbopack: { resolveAlias: turbopackAliases(process.cwd()) },
  webpack(config, { dir }) {
    config.resolve ??= {};
    config.resolve.alias = {
      ...config.resolve.alias,
      ...Object.fromEntries(
        Object.entries(workspaceSourceAliases).map(([alias, source]) =>
          alias.endsWith("/*") && source.endsWith("/*")
            ? [alias.slice(0, -2), source.slice(0, -2)]
            : [alias.includes("*") ? alias : `${alias}$`, source],
        ),
      ),
      "@": dir,
    };
    return config;
  },
} satisfies Pick<
  NextConfig,
  | "cacheComponents"
  | "partialPrefetching"
  | "poweredByHeader"
  | "reactCompiler"
  | "typedRoutes"
  | "turbopack"
  | "webpack"
>;

export interface NextAppConfigOptions {
  /** Trusted server configuration, never a browser Origin or an internal transport host. */
  trustedPublicOrigin?: string | undefined;
}

function trustedPublicHost(origin: unknown): string {
  try {
    if (typeof origin === "string") {
      const parsed = new URL(origin);
      if (
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        !parsed.username &&
        !parsed.password &&
        !parsed.hostname.includes("*") &&
        parsed.pathname === "/" &&
        !parsed.search &&
        !parsed.hash
      ) {
        return parsed.host;
      }
    }
  } catch {
    // Invalid URL details may contain credentials; return only the fixed configuration error.
  }
  throw new Error(
    "Trusted public origin must be an HTTP(S) origin without credentials, wildcards, path, query or fragment.",
  );
}

/** Next loads an application config with its workspace as the working directory. */
export function nextAppConfig(
  config: NextConfig = {},
  options: NextAppConfigOptions = {},
): NextConfig {
  let resolved = config;
  if (options.trustedPublicOrigin !== undefined) {
    const host = trustedPublicHost(options.trustedPublicOrigin);
    const origins = config.experimental?.serverActions?.allowedOrigins ?? [];
    resolved = {
      ...config,
      experimental: {
        ...config.experimental,
        serverActions: {
          ...config.experimental?.serverActions,
          allowedOrigins: origins.includes(host) ? [...origins] : [...origins, host],
        },
      },
    };
  }
  const filesystemRoot =
    config.outputFileTracingRoot ?? config.turbopack?.root ?? linkedFilesystemRoot(process.cwd());
  return {
    ...nextConfigDefaults,
    ...resolved,
    outputFileTracingRoot: config.outputFileTracingRoot ?? filesystemRoot,
    turbopack: {
      root: filesystemRoot,
      ...config.turbopack,
      resolveAlias: {
        ...turbopackAliases(process.cwd()),
        ...config.turbopack?.resolveAlias,
      },
    },
  };
}
