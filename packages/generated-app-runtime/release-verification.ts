import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

type ReleaseManifest = {
  app: string;
  schema_version: string;
  sources: Record<string, string>;
  hashes: Record<string, string>;
};

const releaseMembers = [
  "app-artifact.json",
  "sql-manifest.json",
  "sql-bundle.sql",
  "transition-plan.json",
  "transition-contract.json",
  "runtime-coverage.json",
  "cue-to-sql-source-map.json",
  "release-manifest.json",
  "operation-manifest.json",
  "data-operations.ts",
  "data-operations.md",
  "data-server.ts",
] as const;
const releaseHashMembers = {
  server_bindings: "data-server.ts",
  operations: "operation-manifest.json",
  bindings: "data-operations.ts",
  operation_docs: "data-operations.md",
  schema: "app-artifact.json",
  plan: "transition-plan.json",
  transition_contract: "transition-contract.json",
  bundle: "sql-bundle.sql",
  coverage: "runtime-coverage.json",
  sql_manifest: "sql-manifest.json",
  source_map: "cue-to-sql-source-map.json",
} as const;
const releaseHashKeys = ["source", ...Object.keys(releaseHashMembers), "client"] as const;

function sha256(value: Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

/**
 * Reject incomplete, altered, or stale checked releases before application code uses one.
 * Next's app config includes the CUE source and selected immutable release and
 * excludes historical releases inferred from these dynamic filesystem reads.
 */
export function verifyCheckedRelease(
  releaseDirectory: string,
  sourceCue?: string,
): ReleaseManifest {
  const names = readdirSync(releaseDirectory).sort();
  if (names.join("\n") !== releaseMembers.toSorted().join("\n"))
    throw new Error(`Generated release ${releaseDirectory} has unexpected or missing members`);
  const members = new Map(
    releaseMembers.map((name) => [
      name,
      // Callers package the selected release explicitly; tracing this dynamic
      // path would pull the whole project into every server function.
      readFileSync(
        /* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ releaseDirectory, name),
      ),
    ]),
  );
  return verifyCheckedReleaseMembers(members, sourceCue);
}

/** Verify an already captured release snapshot without rereading mutable paths. */
export function verifyCheckedReleaseMembers(
  members: ReadonlyMap<string, Buffer>,
  sourceCue?: string,
): ReleaseManifest {
  if (members.size !== releaseMembers.length || releaseMembers.some((name) => !members.has(name)))
    throw new Error("Generated release snapshot has unexpected or missing members");
  const member = (name: (typeof releaseMembers)[number]) => {
    const value = members.get(name);
    if (!value) throw new Error(`Generated release snapshot is missing ${name}`);
    return value;
  };
  const manifest = JSON.parse(member("release-manifest.json").toString("utf8")) as ReleaseManifest;
  const hashKeys = Object.keys(manifest.hashes ?? {}).sort();
  if (hashKeys.join("\n") !== releaseHashKeys.toSorted().join("\n"))
    throw new Error("Generated release manifest has missing or unknown hash entries");
  for (const [name, member] of Object.entries(releaseHashMembers)) {
    if (sha256(members.get(member)!) !== manifest.hashes[name])
      throw new Error(`Generated release member ${member} checksum does not match its manifest`);
  }
  const artifact = JSON.parse(member("app-artifact.json").toString("utf8")) as {
    client?: unknown;
    schema?: { version?: string; app_id?: string };
  };
  if (
    artifact.schema?.version !== manifest.schema_version ||
    artifact.schema?.app_id !== manifest.app
  )
    throw new Error("Generated release identity disagrees with its artifact");
  const sourceMap = JSON.parse(member("cue-to-sql-source-map.json").toString("utf8")) as {
    sources: Record<string, string>;
  };
  if (JSON.stringify(sourceMap.sources) !== JSON.stringify(manifest.sources))
    throw new Error("Generated release source map disagrees with its manifest");
  if (sha256(Buffer.from(JSON.stringify(sourceMap.sources))) !== manifest.hashes.source)
    throw new Error("Generated release source checksum does not match its manifest");
  if (sha256(Buffer.from(JSON.stringify(artifact.client ?? null))) !== manifest.hashes.client)
    throw new Error("Generated release client checksum does not match its manifest");
  if (sourceCue) {
    const normalizedSourceCue = path.resolve(sourceCue).split(path.sep).join("/");
    const source = Object.entries(sourceMap.sources).find(
      ([name]) => normalizedSourceCue === name || normalizedSourceCue.endsWith(`/${name}`),
    );
    if (!source || sha256(readFileSync(sourceCue)) !== source[1])
      throw new Error("Generated release is stale for its app-owned CUE source");
  }
  return manifest;
}
