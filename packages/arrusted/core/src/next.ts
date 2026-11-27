import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { NextConfig } from "next";

export type NextAppConfigOptions = {
  /** Exact HTTP(S) public origin added to experimental.serverActions.allowedOrigins. */
  trustedPublicOrigin?: string;
};

function trustedPublicHost(origin: string): string {
  try {
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
  } catch {
    // Omit raw URL details so credentials are never echoed.
  }
  throw new Error(
    "Trusted public origin must be an HTTP(S) origin without credentials, wildcards, path, query or fragment.",
  );
}

function detectTracingRoot(dir: string): string {
  const roots = [path.resolve(dir)];
  const includeRealPath = (candidate: string) => {
    try {
      roots.push(realpathSync(candidate));
    } catch {
      // Ignore unresolvable optional paths.
    }
  };
  includeRealPath(dir);
  try {
    const req = createRequire(path.join(dir, "package.json"));
    includeRealPath(path.dirname(req.resolve("next/package.json")));
  } catch {
    // Allow evaluating next.config before install completes.
  }
  let root = path.resolve(dir);
  while (
    roots.some((candidate) => {
      const rel = path.relative(root, candidate);
      return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
    })
  ) {
    const parent = path.dirname(root);
    if (parent === root) break;
    root = parent;
  }
  return root;
}

/** Standalone Next.js 16 configuration helper for @arrusted/core consumer applications. */
export function nextAppConfig(
  config: NextConfig = {},
  options: NextAppConfigOptions = {},
): NextConfig {
  const appDir = process.cwd();
  const tracingRoot =
    config.outputFileTracingRoot ?? config.turbopack?.root ?? detectTracingRoot(appDir);
  const existingExternal = config.serverExternalPackages ?? [];
  const serverExternalPackages = [...new Set([...existingExternal, "pg", "@libpg-query/parser"])];

  let experimental = config.experimental;
  if (options.trustedPublicOrigin !== undefined) {
    const host = trustedPublicHost(options.trustedPublicOrigin);
    const origins = config.experimental?.serverActions?.allowedOrigins ?? [];
    experimental = {
      ...config.experimental,
      serverActions: {
        ...config.experimental?.serverActions,
        allowedOrigins: origins.includes(host) ? [...origins] : [...origins, host],
      },
    };
  }

  return {
    poweredByHeader: false,
    ...config,
    ...(experimental ? { experimental } : {}),
    serverExternalPackages,
    outputFileTracingRoot: tracingRoot,
    outputFileTracingIncludes: {
      ...config.outputFileTracingIncludes,
      "/*": [
        ...new Set([
          "./.generated/release/**/*",
          ...(config.outputFileTracingIncludes?.["/*"] ?? []),
        ]),
      ],
    },
    turbopack: {
      root: tracingRoot,
      ...config.turbopack,
    },
  };
}
