import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { checkedReleaseDirectory } from "../../../../packages/generated-app-runtime/release";

export function runCompiledApp(
  command: string | undefined,
  appId: string | undefined,
  repositoryRoot = process.cwd(),
): void {
  if (
    (command !== "compile" && command !== "check" && command !== "verify") ||
    appId === undefined
  ) {
    throw new Error("usage: compiled-app.ts <compile|check|verify> <app>");
  }
  const root = path.resolve(repositoryRoot);
  const cuePath = path.join(root, "apps", appId, "schema", `${appId}.cue`);
  if (!existsSync(cuePath)) return;
  if (command === "verify") {
    checkedReleaseDirectory(root, appId);
    console.log(`Verified checked release and CUE source for ${appId}`);
    return;
  }
  const result = spawnSync(
    "bun",
    [".config/mise/scripts/repository/schema-release.ts", command, "--app", appId],
    { cwd: root, env: process.env, stdio: "inherit" },
  );
  if (result.error !== undefined) throw new Error(`compiled-app.ts: ${result.error.message}`);
  if (result.status !== 0)
    throw new Error(`compiled-app.ts: compiler exited with ${result.status ?? 1}`);
}

if (import.meta.main) {
  try {
    runCompiledApp(process.argv[2], process.argv[3]);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
