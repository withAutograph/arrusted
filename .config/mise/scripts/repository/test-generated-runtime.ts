/// <reference types="node" />
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const suite = process.argv[2];
if (suite !== undefined && suite !== "currency-rates")
  throw new Error("Unknown runtime test suite");
const testArguments =
  suite === "currency-rates"
    ? ["--config", "packages/currency-rates/vite.config.ts"]
    : ["packages/generated-app-runtime/__tests__"];

// This suite owns its cluster and never uses a configured application database.
const scratch = await mkdtemp(path.join(tmpdir(), "generated-runtime-tests-"));
const data = path.join(scratch, "postgres");
const port = await new Promise<number>((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture_port_unavailable");
    server.close((error) => (error ? reject(error) : resolve(address.port)));
  });
});
const command = (name: string, args: string[]) => {
  const result = spawnSync(name, args, {
    env: { NODE_ENV: "test", PATH: process.env.PATH, LANG: "C", LC_ALL: "C" },
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`Owned runtime fixture ${name} failed`);
};
let started = false;
try {
  command("initdb", [
    "-D",
    data,
    "--auth=trust",
    "--username=postgres",
    "--no-locale",
    "--encoding=UTF8",
  ]);
  command("pg_ctl", [
    "-D",
    data,
    "-l",
    path.join(scratch, "postgres.log"),
    "-o",
    `-h 127.0.0.1 -p ${port} -k ${scratch}`,
    "-w",
    "start",
  ]);
  started = true;
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    GENERATED_APP_POSTGRES_PORT: String(port),
  };
  for (const name of Object.keys(environment)) {
    if (name.endsWith("DATABASE_URL")) delete environment[name];
  }
  const child = spawn(
    "bun",
    ["x", "vitest", "run", ...testArguments, "--testTimeout", "120000", "--hookTimeout", "120000"],
    { env: environment, stdio: "inherit" },
  );
  let terminationTimer: ReturnType<typeof setTimeout> | undefined;
  const terminate = () => {
    child.kill("SIGTERM");
    terminationTimer ??= setTimeout(() => child.kill("SIGKILL"), 5_000);
  };
  process.once("SIGINT", terminate);
  process.once("SIGTERM", terminate);
  try {
    process.exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });
  } finally {
    if (terminationTimer !== undefined) clearTimeout(terminationTimer);
    process.removeListener("SIGINT", terminate);
    process.removeListener("SIGTERM", terminate);
  }
} finally {
  if (started) command("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"]);
  await rm(scratch, { recursive: true, force: true });
}
