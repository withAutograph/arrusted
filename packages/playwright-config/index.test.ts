import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import playwrightConfig, { createPlaywrightConfig, playwrightWebServerPort } from "./index";
import {
  default as runtimePlaywrightConfig,
  playwrightWebServerPort as runtimePlaywrightWebServerPort,
} from "./index.js";

describe("Playwright config", () => {
  it("shares E2E discovery and URL defaults across TypeScript and runtime exports", () => {
    const expectedPort = process.env.PLAYWRIGHT_WEB_SERVER_PORT ?? "4100";
    const expectedUrl = `http://127.0.0.1:${expectedPort}`;
    const expectedConfig = {
      testDir: "./tests/e2e",
      use: { baseURL: expectedUrl },
      webServer: {
        command: `bun run start --port ${expectedPort}`,
        url: expectedUrl,
        env: { FORCE_COLOR: "0" },
      },
    };
    expect(playwrightConfig).toMatchObject(expectedConfig);
    expect(playwrightWebServerPort).toBe(expectedPort);
    expect(runtimePlaywrightWebServerPort).toBe(expectedPort);
    expect(runtimePlaywrightConfig).toMatchObject(expectedConfig);
  });
});

describe("prepared browser origin", () => {
  it("uses the actual supplied origin without starting a local server", () => {
    for (const origin of ["https://approved.example", "http://127.0.0.1:4100"]) {
      const config = createPlaywrightConfig({ APP_TEST_BASE_URL: origin });
      expect(config.use?.baseURL).toBe(origin);
      expect(config).not.toHaveProperty("webServer");
    }
  });

  it("preserves the existing local server and port when no origin is supplied", () => {
    const config = createPlaywrightConfig({ PLAYWRIGHT_WEB_SERVER_PORT: "4200" });
    expect(config).toMatchObject({
      use: { baseURL: "http://127.0.0.1:4200" },
      webServer: {
        command: "bun run start --port 4200",
        url: "http://127.0.0.1:4200",
        env: { FORCE_COLOR: "0" },
      },
    });
  });

  it.each([
    "",
    "https://approved.example/path",
    "https://approved.example?query=1",
    "https://approved.example/#fragment",
    "https://user:pass@approved.example",
    "file:///tmp/state",
    "invalid",
  ])("rejects a supplied non-origin without silently launching localhost", (origin) => {
    expect(() => createPlaywrightConfig({ APP_TEST_BASE_URL: origin })).toThrow(
      "APP_TEST_BASE_URL must be an exact HTTP(S) origin",
    );
  });
});

describe("real Playwright configuration loader", () => {
  it.each(["ts", "mts"])("executes the shared module graph from a %s consumer", (extension) => {
    const directory = mkdtempSync(path.join(tmpdir(), "playwright-config-loader-"));
    try {
      const tests = path.join(directory, "tests", "e2e");
      mkdirSync(tests, { recursive: true });
      const config = path.join(directory, `playwright.config.${extension}`);
      writeFileSync(
        config,
        `import {createPlaywrightConfig} from ${JSON.stringify(fileURLToPath(new URL("./config.js", import.meta.url)))};
export default createPlaywrightConfig();`,
      );
      writeFileSync(
        path.join(tests, `load.spec.${extension}`),
        `import {test,expect} from ${JSON.stringify(fileURLToPath(new URL("./normal-actors.js", import.meta.url)))};
import defaultConfig from ${JSON.stringify(fileURLToPath(new URL("./index.js", import.meta.url)))};
import {appTestPath} from ${JSON.stringify(fileURLToPath(new URL("./entry-path.js", import.meta.url)))};
import {assertPrivatePreviewTracePolicy,bootstrapPrivatePreviewContext} from ${JSON.stringify(fileURLToPath(new URL("./private-preview-access.js", import.meta.url)))};
import {withNormalActorUiLogin,signInNormalActorInContext} from ${JSON.stringify(fileURLToPath(new URL("./normal-actor-login.js", import.meta.url)))};
import {withNormalActorReadback} from ${JSON.stringify(fileURLToPath(new URL("./normal-actor-readback.js", import.meta.url)))};
test("shared graph and private guards execute",async({request,baseURL},testInfo)=>{
 expect(typeof withNormalActorUiLogin).toBe("function");
 expect(typeof signInNormalActorInContext).toBe("function");
 await expect(signInNormalActorInContext({appId:"fixture",context:{} as never,baseURL:baseURL!})).rejects.toMatchObject({code:"normal-actor-ui-login-unavailable"});
 expect(typeof withNormalActorReadback).toBe("function");
 const options={reporter:testInfo.config.reporter,trace:testInfo.project.use.trace};
 assertPrivatePreviewTracePolicy(options);
 expect(defaultConfig.use.trace).toBe("off");
 expect(appTestPath("/")).toBe("/");
 expect(()=>assertPrivatePreviewTracePolicy({...options,trace:"on"})).toThrow("Private preview browser access needs");
 expect(()=>assertPrivatePreviewTracePolicy({...options,reporter:[["json"]]})).toThrow("Private preview browser access needs");
 await expect(bootstrapPrivatePreviewContext({request},baseURL,options)).rejects.toMatchObject({code:"private-preview-refresh-required"});
});`,
      );
      const cli = fileURLToPath(
        new URL("./cli.js", import.meta.resolve("playwright/package.json")),
      );
      const output = execFileSync(process.execPath, [cli, "test", "--config", config], {
        cwd: directory,
        env: {
          ...process.env,
          APP_TEST_BASE_URL: "https://fixture.example",
          APP_TEST_PREVIEW_AUTHORITY_FILE: path.join(directory, "private-authority.json"),
          APP_TEST_ENTRY_PATH: "/",
        },
        encoding: "utf8",
        stdio: "pipe",
      });
      expect(output).toContain("[private browser] passed:");
      expect(output).toContain(`load.spec.${extension}`);
      expect(output).toContain("shared graph and private guards execute");
      expect(output).toContain("run passed");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

it("retains a redacted failure marker for unclassified global browser errors", () => {
  const reporter = fileURLToPath(new URL("./private-preview-reporter.js", import.meta.url));
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import Reporter from ${JSON.stringify(reporter)};
const reporter = new Reporter();
reporter.onError(new Error("PRIVATE_GLOBAL_ERROR_SENTINEL https://private.example/?token=SECRET"));
reporter.onEnd({status:"failed"});`,
    ],
    { encoding: "utf8" },
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(
    "[private browser] failed: [application-test-failure; raw diagnostics withheld]",
  );
  expect(result.stdout).toContain("[private browser] run failed");
  expect(result.stdout + result.stderr).not.toMatch(/SENTINEL|SECRET|private\.example/u);
});

it("reports only closed diagnostic stages from real Playwright failures", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "playwright-private-stages-"));
  try {
    const tests = path.join(directory, "tests", "e2e");
    mkdirSync(tests, { recursive: true });
    const config = path.join(directory, "playwright.config.ts");
    const moduleFile = (file: string) =>
      JSON.stringify(fileURLToPath(new URL(file, import.meta.url)));
    writeFileSync(
      config,
      `import {createPlaywrightConfig} from ${moduleFile("./config.js")};
export default createPlaywrightConfig();`,
    );
    writeFileSync(
      path.join(tests, "diagnostics.spec.ts"),
      `import {test, expect} from ${moduleFile("./normal-actors.js")};
import {NormalActorUiLoginError, signInNormalActorInContext} from ${moduleFile("./normal-actor-login.js")};
import {NormalActorReadbackError} from ${moduleFile("./normal-actor-readback.js")};
import {bootstrapPrivatePreviewContext} from ${moduleFile("./private-preview-access.js")};
test("actual login preflight", async ({baseURL}) => {
  await signInNormalActorInContext({appId:"fixture",context:{} as never,baseURL:baseURL!});
});
test("closed readback stage", () => { throw new NormalActorReadbackError("actor_not_authorized"); });
test("actual preview preflight", async ({request,baseURL}, testInfo) => {
  await bootstrapPrivatePreviewContext({request}, baseURL, {reporter:testInfo.config.reporter});
});
test("untrusted exception text", () => {
  console.log("PRIVATE_WORKER_OUTPUT_SENTINEL");
  throw new Error("Private preview browser access needs PRIVATE_EXCEPTION_SENTINEL");
});
test("invalid public stage", () => {
  throw new NormalActorUiLoginError("PRIVATE_STAGE_SENTINEL");
});
test("real assertion failure", () => { expect("PRIVATE_EXPECTED_SENTINEL").toBe("PRIVATE_RECEIVED_SENTINEL"); });
test("serialized navigation failure", () => {
  throw new Error("page.goto: net::ERR_CONNECTION_REFUSED at https://private.example/?token=PRIVATE_URL_SENTINEL");
});
test("serialized browser launch failure", () => {
  throw new Error("browserType.launch: PRIVATE_LAUNCH_SENTINEL");
});
test("serialized action timeout before test deadline", () => {
  throw new Error("locator.waitFor: Timeout 25ms exceeded.\\nCall log: PRIVATE_LOCATOR_SENTINEL");
});
test("test deadline", async () => {
  test.setTimeout(25);
  await new Promise(() => {});
});`,
    );
    const cli = fileURLToPath(new URL("./cli.js", import.meta.resolve("playwright/package.json")));
    const result = spawnSync(process.execPath, [cli, "test", "--config", config, "--workers=1"], {
      cwd: directory,
      env: {
        ...process.env,
        APP_TEST_BASE_URL: "https://fixture.example",
        APP_TEST_PREVIEW_AUTHORITY_FILE: path.join(directory, "private-authority.json"),
      },
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.status).toBe(1);
    const stdout = result.stdout;
    expect(stdout).toContain("[private browser failure] tests/e2e/diagnostics.spec.ts:14");
    expect(stdout).toContain("[private browser stage] recording-policy");
    expect(stdout).toContain("[private browser stage] readback-actor-not-authorized");
    expect(stdout).toContain("[private browser stage] protected-operation");
    expect(stdout.match(/private-preview-refresh-required/gu)).toHaveLength(1);
    expect(stdout.match(/\[private browser\] failed:/gu)).toHaveLength(9);
    expect(stdout.match(/\[private browser category\] timeout/gu)).toHaveLength(2);
    expect(stdout).toMatch(/\[private browser\] timedOut:.*test deadline/u);
    for (const category of ["assertion", "navigation", "browser-launch", "timeout"]) {
      expect(stdout).toContain(`[private browser category] ${category}`);
    }
    expect(stdout).toContain("[private browser] run failed");
    expect(stdout + result.stderr).not.toContain("SENTINEL");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 40_000);
