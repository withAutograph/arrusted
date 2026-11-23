import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { verifyCheckedRelease } from "./release-verification";

export { verifyCheckedRelease } from "./release-verification";

function sha256(value: Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function checkedReleaseDirectory(root: string, appId: string): string {
  const parent = path.join(root, "apps", appId, "schema", "release");
  const sourceName = `apps/${appId}/schema/${appId}.cue`;
  const sourceCue = path.join(root, sourceName);
  const sourceHash = sha256(readFileSync(sourceCue));
  const versions = existsSync(parent)
    ? readdirSync(parent)
        .filter((name) => existsSync(path.join(parent, name, "release-manifest.json")))
        .filter((name) => {
          const sourceMap = JSON.parse(
            readFileSync(path.join(parent, name, "cue-to-sql-source-map.json"), "utf8"),
          ) as { sources?: Record<string, string> };
          return sourceMap.sources?.[sourceName] === sourceHash;
        })
    : [];
  if (versions.length !== 1)
    throw new Error(`${appId} must have exactly one checked release matching its CUE source`);
  const directory = path.join(parent, versions[0]!);
  if (verifyCheckedRelease(directory, sourceCue).app !== appId)
    throw new Error("Generated release belongs to another application");
  return directory;
}

/** Project-root file globs needed by a CUE-backed app at runtime, for one checked release only. */
export function generatedAppRuntimeFiles(root: string, appId: string): string[] {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(appId)) {
    throw new Error("Generated runtime app id must be one lowercase kebab-case segment");
  }
  const appRoot = path.join(root, "apps", appId);
  const release = checkedReleaseDirectory(root, appId);
  const relativeRelease = path.relative(appRoot, release).split(path.sep).join("/");
  return [`./schema/${appId}.cue`, `./${relativeRelease}/**/*`];
}

/** Remove historical assets that Next may infer from dynamic verifier filesystem reads. */
export function generatedAppRuntimeExcludes(root: string, appId: string): string[] {
  // Resolve and verify the same selection before excluding any other directory.
  generatedAppRuntimeFiles(root, appId);
  const selected = checkedReleaseDirectory(root, appId);
  return readdirSync(path.dirname(selected), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== path.basename(selected))
    .map((entry) => `./schema/release/${entry.name.replace(/([*?[\]{}()!\\])/gu, "\\$1")}/**/*`)
    .toSorted();
}

/** Trace one checked release at the app mount and preserve protected ingress paths. */
export function generatedAppNextConfig(
  repositoryRoot: string,
  appId: string,
  protectedIngress = false,
) {
  const mount = `/${appId}`;
  const descendants = `${mount}/**`;
  const runtimeFiles = generatedAppRuntimeFiles(repositoryRoot, appId);
  const historicalFiles = generatedAppRuntimeExcludes(repositoryRoot, appId);
  return {
    skipProxyUrlNormalize: protectedIngress,
    outputFileTracingIncludes: { [mount]: runtimeFiles, [descendants]: runtimeFiles },
    outputFileTracingExcludes: { [mount]: historicalFiles, [descendants]: historicalFiles },
  };
}
