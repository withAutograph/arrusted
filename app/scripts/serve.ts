import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { loopback } from "./production-gate";
import { SafeError, reportError } from "./safe-output";

const appRoot = path.resolve(import.meta.dirname, "..");

async function run(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(command, args, { cwd: appRoot, env, stdio: "inherit" });
  const stop = (signal: NodeJS.Signals) => child.kill(signal);
  const interrupt = () => stop("SIGINT");
  const terminate = () => stop("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}

/**
 * Verify that the compiled release is active using the runtime-accessible kernel
 * observability entrypoint, without granting direct SELECT on autograph_applied_schema.
 */
export async function activeReleaseMatches(
  databaseUrl: string,
  releaseDirectory = path.join(appRoot, ".generated/release"),
): Promise<boolean> {
  const manifest = JSON.parse(
    readFileSync(path.join(releaseDirectory, "release-manifest.json"), "utf8"),
  ) as { schema_version?: string; hashes?: { schema?: string } };
  const artifact = JSON.parse(
    readFileSync(path.join(releaseDirectory, "app-artifact.json"), "utf8"),
  ) as { schema?: { app_id?: string; customer_id?: string } };
  const expectedRevision = manifest.schema_version;
  const expectedArtifactHash = manifest.hashes?.schema?.replace(/^sha256:/u, "");
  const appId = artifact.schema?.app_id;
  const customerId = artifact.schema?.customer_id;
  if (!expectedRevision || !expectedArtifactHash || !appId || !customerId) return false;

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const exists = (
      await pool.query(
        "select to_regprocedure('public.kernel_read_runtime_release_observability(jsonb)') as fn",
      )
    ).rows[0]?.fn;
    if (!exists) return false;
    const envelope = (
      await pool.query<{
        result?: {
          ok?: boolean;
          data?: {
            active_effective_revision?: string;
            active_effective_artifact_hash?: string;
          };
        };
      }>("select public.kernel_read_runtime_release_observability($1::jsonb) as result", [
        JSON.stringify({ app_id: appId, customer_id: customerId }),
      ])
    ).rows[0]?.result;
    return (
      envelope?.ok === true &&
      envelope.data?.active_effective_revision === expectedRevision &&
      envelope.data?.active_effective_artifact_hash === expectedArtifactHash
    );
  } finally {
    await pool.end();
  }
}

export async function prepareStartup(input: {
  databaseUrl: string;
  matches: () => Promise<boolean>;
  migrate: () => Promise<void>;
}) {
  if (loopback(input.databaseUrl)) await input.migrate();
  else if (!(await input.matches()))
    throw new SafeError(
      "Pending migrations on a non-loopback database. Start refused. Run bun run release from the builder terminal first.",
    );
}

if (import.meta.main) {
  try {
    const target = process.env.MIGRATION_DATABASE_URL ?? process.env.APP_DATABASE_URL;
    if (!target) throw new SafeError("Configure APP_DATABASE_URL before starting.");
    await prepareStartup({
      databaseUrl: target,
      matches: () => activeReleaseMatches(process.env.APP_DATABASE_URL ?? target),
      migrate: async () => {
        if ((await run(process.execPath, ["scripts/migrate.ts", "apply"], process.env)) !== 0)
          throw new SafeError("Local migration failed; server was not started.");
      },
    });
    const runtimeEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => key !== "MIGRATION_DATABASE_URL" && !key.startsWith("NEON_"),
      ),
    );
    process.exitCode = await run(
      "node",
      [path.join(appRoot, "../node_modules/next/dist/bin/next"), "start", ...process.argv.slice(2)],
      runtimeEnvironment,
    );
  } catch (error) {
    reportError(error, "Startup migration check");
    process.exitCode = 1;
  }
}
