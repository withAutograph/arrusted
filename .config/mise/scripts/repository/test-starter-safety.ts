/// <reference types="node" />
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

// This suite owns its PostgreSQL cluster and never uses a configured application database.
const scratch = await mkdtemp(path.join(tmpdir(), "starter-safety-tests-"));
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
  if (result.status !== 0)
    throw new Error(`Owned starter-safety fixture ${name} failed: ${result.stderr}`);
};

const runStep = (cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: "inherit" });
    let terminationTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = () => {
      child.kill("SIGTERM");
      terminationTimer ??= setTimeout(() => child.kill("SIGKILL"), 5_000);
    };
    process.once("SIGINT", terminate);
    process.once("SIGTERM", terminate);
    child.once("error", (error) => {
      if (terminationTimer !== undefined) clearTimeout(terminationTimer);
      process.removeListener("SIGINT", terminate);
      process.removeListener("SIGTERM", terminate);
      reject(error);
    });
    child.once("close", (code) => {
      if (terminationTimer !== undefined) clearTimeout(terminationTimer);
      process.removeListener("SIGINT", terminate);
      process.removeListener("SIGTERM", terminate);
      resolve(code ?? 1);
    });
  });

let started = false;
try {
  const password = randomBytes(16).toString("hex");
  const pwfile = path.join(scratch, "pwfile");
  await writeFile(pwfile, `${password}\n`, { mode: 0o600 });
  command("initdb", [
    "-D",
    data,
    "--auth=scram-sha-256",
    `--pwfile=${pwfile}`,
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
  const dbUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/postgres`;
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    SINGLE_ORG_TEST_DATABASE_URL: dbUrl,
    SAFETY_TEST_DATABASE_URL: dbUrl,
  };
  for (const name of Object.keys(environment)) {
    if (
      name.endsWith("DATABASE_URL") &&
      name !== "SINGLE_ORG_TEST_DATABASE_URL" &&
      name !== "SAFETY_TEST_DATABASE_URL"
    )
      delete environment[name];
  }

  const steps: [string, string[]][] = [
    [
      "bun",
      [
        "x",
        "vp",
        "test",
        "--config",
        "packages/auth/vite.config.ts",
        "--run",
        "packages/auth/__tests__/single-organization.test.ts",
        "packages/auth/__tests__/single-organization-admission.test.ts",
      ],
    ],
    ["bun", ["test", "app/scripts/safety.test.ts"]],
    ["bun", ["x", "vp", "test", "--config", "app/vite.ui.config.ts", "--run"]],
  ];

  for (const [cmd, args] of steps) {
    const code = await runStep(cmd, args, environment);
    if (code !== 0) {
      process.exitCode = code;
      break;
    }
  }
} finally {
  if (started) command("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"]);
  await rm(scratch, { recursive: true, force: true });
}
