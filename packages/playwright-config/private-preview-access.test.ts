import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:https";
import { mkdtemp, readFile, writeFile, readdir, stat, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { request } from "playwright/test";
import { describe, expect, it } from "vitest";
import {
  assertPrivatePreviewTracePolicy,
  bootstrapPrivatePreviewContext,
} from "./private-preview-access.js";
import { createPlaywrightConfig } from "./config.js";

describe("private preview capability exchange", () => {
  it("disables trace only for private authority while preserving public configuration", () => {
    expect(
      createPlaywrightConfig({
        APP_TEST_BASE_URL: "https://example.test",
        APP_TEST_PREVIEW_AUTHORITY_FILE: "/private/authority",
      }).use?.trace,
    ).toBe("off");
    expect(
      createPlaywrightConfig({ APP_TEST_BASE_URL: "https://example.test" }).use,
    ).not.toHaveProperty("trace");
  });
  it("prevents recordings before exchanging protected browser authority", () => {
    const config = createPlaywrightConfig({
      APP_TEST_BASE_URL: "https://example.test",
      APP_TEST_IDENTITIES_FILE: "/private/identities",
    });
    const reporter = config.reporter;
    if (!Array.isArray(reporter)) throw new Error("Expected the configured private reporter");
    const policy = { authorityFile: "/private/authority", reporter };
    expect(config.use).toMatchObject({ trace: "off", video: "off", screenshot: "off" });
    expect(() => assertPrivatePreviewTracePolicy(policy)).not.toThrow();
    expect(() => assertPrivatePreviewTracePolicy({ ...policy, video: "on" })).toThrow();
    expect(() =>
      assertPrivatePreviewTracePolicy({ ...policy, screenshot: "only-on-failure" }),
    ).toThrow();
  });
  it("performs a real TLS exchange into each actual jar and rejects stale, foreign and traced access before requests", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "private-preview-exchange-"));
    const key = path.join(directory, "key.pem");
    const cert = path.join(directory, "cert.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-subj",
        "/CN=localhost",
        "-days",
        "1",
      ],
      { stdio: "ignore" },
    );
    let exchanges = 0;
    const server = createServer(
      { key: await readFile(key), cert: await readFile(cert) },
      (req, res) => {
        if (req.url === "/__autograph_preview_launch?token=fixture-owner-authority") {
          exchanges++;
          res.writeHead(303, {
            location: "/supplier-spend",
            "set-cookie":
              "__Host-autograph-preview=real-exchange-cookie; Path=/; HttpOnly; Secure; SameSite=Lax",
          });
          res.end();
        } else {
          res.writeHead(
            req.headers.cookie?.includes("__Host-autograph-preview=real-exchange-cookie")
              ? 200
              : 403,
          );
          res.end(
            req.headers.cookie?.includes("better-auth.session_token=real-session")
              ? "assigned-session"
              : "anonymous",
          );
        }
      },
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture listener missing");
    const origin = `https://127.0.0.1:${address.port}`;
    const authorityFile = path.join(directory, "authority.json");
    const authority = {
      version: 1,
      kind: "private-preview-browser-access",
      appId: "example",
      origin,
      launchUrl: `${origin}/__autograph_preview_launch?token=fixture-owner-authority`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const reporter: [[string]] = [
      [fileURLToPath(new URL("./private-preview-reporter.js", import.meta.url))],
    ];
    const save = () => writeFile(authorityFile, JSON.stringify(authority), { mode: 0o600 });
    await save();
    const assigned = await request.newContext({
      ignoreHTTPSErrors: true,
      storageState: {
        cookies: [
          {
            name: "better-auth.session_token",
            value: "real-session",
            domain: "127.0.0.1",
            path: "/",
            secure: true,
            httpOnly: true,
            sameSite: "Lax",
            expires: -1,
          },
        ],
        origins: [],
      },
    });
    const anonymous = await request.newContext({ ignoreHTTPSErrors: true });
    const context = (jar: typeof assigned) => ({
      request: jar,
      cookies: async () => (await jar.storageState()).cookies,
    });
    try {
      expect((await anonymous.get(origin)).status()).toBe(403);
      await expect(
        bootstrapPrivatePreviewContext(context(assigned), origin, { authorityFile, trace: "on" }),
      ).rejects.toMatchObject({ code: "private-preview-refresh-required" });
      expect(exchanges).toBe(0);
      await expect(
        bootstrapPrivatePreviewContext(context(assigned), "https://foreign.test", {
          authorityFile,
          reporter,
        }),
      ).rejects.toMatchObject({ code: "private-preview-refresh-required" });
      expect(exchanges).toBe(0);
      await expect(
        bootstrapPrivatePreviewContext(context(assigned), origin, {
          authorityFile,
          reporter: [["json"]],
        }),
      ).rejects.toMatchObject({ code: "private-preview-refresh-required" });
      expect(exchanges).toBe(0);
      await bootstrapPrivatePreviewContext(context(assigned), origin, {
        authorityFile,
        reporter,
        trace: "off",
      });
      expect(await (await assigned.get(origin)).text()).toBe("assigned-session");
      await bootstrapPrivatePreviewContext(context(anonymous), origin, {
        authorityFile,
        reporter,
        trace: "off",
      });
      expect(await (await anonymous.get(origin)).text()).toBe("anonymous");
      expect(exchanges).toBe(2);
      const spec = path.join(directory, "proof.spec.mjs");
      const config = path.join(directory, "playwright.config.mjs");
      const output = path.join(directory, "results");
      await writeFile(
        config,
        `export default ${JSON.stringify({ testDir: directory, testMatch: "proof.spec.mjs", outputDir: output, use: { baseURL: origin, trace: "off", ignoreHTTPSErrors: true }, reporter })}`,
      );
      const helper = fileURLToPath(new URL("./private-preview-access.js", import.meta.url));
      await writeFile(
        spec,
        `import {test,expect} from ${JSON.stringify(import.meta.resolve("playwright/test"))};
import {bootstrapPrivatePreviewContext} from ${JSON.stringify(helper)};
test("real private transport proof",async({request,baseURL},testInfo)=>{
 await bootstrapPrivatePreviewContext({request,cookies:async()=> (await request.storageState()).cookies},baseURL,{reporter:testInfo.config.reporter,trace:testInfo.project.use.trace});
 expect((await request.get(baseURL)).status()).toBe(200);
 expect(process.env.APP_TEST_RETENTION_PROBE).toBeTruthy();
 console.log(process.env.APP_TEST_RETENTION_PROBE);
});`,
      );
      const cli = fileURLToPath(
        new URL("./cli.js", import.meta.resolve("playwright/package.json")),
      );
      const proof = await promisify(execFile)(process.execPath, [cli, "test", "--config", config], {
        env: {
          ...process.env,
          APP_TEST_PREVIEW_AUTHORITY_FILE: authorityFile,
          APP_TEST_RETENTION_PROBE: "cookie: raw-session-fixture-payload",
        },
      });
      expect(proof.stdout).toContain("real private transport proof");
      expect(proof.stdout).toContain("run passed");
      for (const value of [
        "fixture-owner-authority",
        "real-exchange-cookie",
        "raw-session-fixture-payload",
        "__Host-autograph-preview",
      ]) {
        expect(proof.stdout + proof.stderr).not.toContain(value);
        for (const file of await readdir(output, { recursive: true })) {
          const target = path.join(output, file);
          const entry = await stat(target);
          if (entry.isFile()) expect(await readFile(target, "utf8")).not.toContain(value);
        }
      }
      for (const extra of [["--reporter=json"], ["--trace=on"]]) {
        const before = exchanges;
        const denied = await new Promise<{ code: number; stdout: string; stderr: string }>(
          (resolve) => {
            execFile(
              process.execPath,
              [cli, "test", "--config", config, ...extra],
              { env: { ...process.env, APP_TEST_PREVIEW_AUTHORITY_FILE: authorityFile } },
              (error, stdout, stderr) => resolve({ code: error ? 1 : 0, stdout, stderr }),
            );
          },
        );
        expect(denied.code).toBe(1);
        expect(exchanges).toBe(before);
        for (const value of [
          "fixture-owner-authority",
          "real-exchange-cookie",
          "raw-session-fixture-payload",
        ])
          expect(denied.stdout + denied.stderr).not.toContain(value);
      }
      const beforeStale = exchanges;
      authority.expiresAt = new Date(Date.now() - 1).toISOString();
      await save();
      await expect(
        bootstrapPrivatePreviewContext(context(assigned), origin, { authorityFile, reporter }),
      ).rejects.toMatchObject({ code: "private-preview-refresh-required" });
      expect(exchanges).toBe(beforeStale);
    } finally {
      await assigned.dispose();
      await anonymous.dispose();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    }
  });
});
