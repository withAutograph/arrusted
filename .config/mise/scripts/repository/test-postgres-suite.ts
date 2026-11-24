/// <reference types="node" />
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../..", import.meta.url));
const scratch = await mkdtemp(path.join(tmpdir(), "source-identities-tests-"));
const data = path.join(scratch, "postgres");
const postgresEnvironment = {
  NODE_ENV: "test",
  PATH: process.env.PATH,
  LANG: "C",
  LC_ALL: "C",
};
const command = (name: string, args: string[]) => {
  const result = spawnSync(name, args, {
    cwd: root,
    env: postgresEnvironment,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0)
    throw new Error(`Owned integration fixture ${name} failed`, { cause: result.error });
};
let startupAttempted = false;
try {
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("fixture_port_unavailable")));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
  const password = randomBytes(24).toString("hex");
  const passwordFile = path.join(scratch, "owner-password");
  await writeFile(passwordFile, `${password}\n`, { mode: 0o600, flag: "wx" });
  command("initdb", [
    "-D",
    data,
    "--auth-local=trust",
    "--auth-host=scram-sha-256",
    "--pwfile",
    passwordFile,
    "--username=postgres",
    "--no-locale",
    "--encoding=UTF8",
  ]);
  startupAttempted = true;
  command("pg_ctl", [
    "-D",
    data,
    "-l",
    path.join(scratch, "postgres.log"),
    "-o",
    `-h 127.0.0.1 -p ${port} -c unix_socket_directories=`,
    "-t",
    "30",
    "-w",
    "start",
  ]);

  // Never reuse a configured app/test database, including values inherited from CI.
  const environment: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "test" };
  for (const name of Object.keys(environment)) {
    if (
      /DATABASE_URL$/iu.test(name) ||
      /^PG(?:HOST|HOSTADDR|PORT|USER|PASSWORD|DATABASE|SERVICE|SERVICEFILE|PASSFILE|OPTIONS)$/u.test(
        name,
      )
    )
      delete environment[name];
  }
  const fixtureUrl = new URL(`postgresql://postgres@127.0.0.1:${port}/postgres`);
  fixtureUrl.password = password;
  environment.KERNEL_TEST_DATABASE_URL = fixtureUrl.toString();
  environment.SQL_PARITY_ONLY_TARGETS = "sql_runtime_integrations";
  const child = spawn("mise", ["run", "--no-deps", "schema:test-parity"], {
    cwd: root,
    env: environment,
    stdio: "inherit",
    detached: process.platform !== "win32",
  });
  let terminationTimer: ReturnType<typeof setTimeout> | undefined;
  const signalChild = (signal: NodeJS.Signals) => {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  const terminate = () => {
    signalChild("SIGTERM");
    terminationTimer ??= setTimeout(() => signalChild("SIGKILL"), 5000);
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
  if (startupAttempted) {
    const status = spawnSync("pg_ctl", ["-D", data, "status"], {
      cwd: root,
      env: postgresEnvironment,
      encoding: "utf8",
    });
    if (status.status === 0)
      command("pg_ctl", ["-D", data, "-m", "fast", "-t", "30", "-w", "stop"]);
    else if (status.error || status.status !== 3)
      throw new Error(
        "Owned integration fixture status is uncertain; retained its data directory",
        { cause: status.error },
      );
  }
  await rm(scratch, { recursive: true, force: true });
}
