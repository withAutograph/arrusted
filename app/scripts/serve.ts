import { spawn } from "node:child_process";
import path from "node:path";

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

// The migration lock and restore point complete before this process opens a listener.
const migrationStatus = await run(process.execPath, ["scripts/migrate.ts", "apply"], process.env);
if (migrationStatus !== 0) process.exit(migrationStatus);
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
