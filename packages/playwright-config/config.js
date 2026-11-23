import privatePreviewReporterPath from "./private-preview-reporter-path.cjs";

/** Build the same configuration for the TypeScript and runtime package exports. */
export function createPlaywrightConfig(environment = process.env) {
  const port = environment.PLAYWRIGHT_WEB_SERVER_PORT ?? "4100";
  const suppliedOrigin = environment.APP_TEST_BASE_URL;
  if (suppliedOrigin !== undefined) {
    let origin;
    try {
      origin = new URL(suppliedOrigin);
    } catch {
      throw new Error("APP_TEST_BASE_URL must be an exact HTTP(S) origin");
    }
    if (
      !["http:", "https:"].includes(origin.protocol) ||
      origin.origin !== suppliedOrigin ||
      origin.username ||
      origin.password
    ) {
      throw new Error("APP_TEST_BASE_URL must be an exact HTTP(S) origin");
    }
    const protectedBrowser =
      environment.APP_TEST_PREVIEW_AUTHORITY_FILE || environment.APP_TEST_IDENTITIES_FILE;
    return {
      ...(protectedBrowser ? { reporter: [[privatePreviewReporterPath]] } : {}),
      testDir: "./tests/e2e",
      use: {
        baseURL: suppliedOrigin,
        ...(protectedBrowser ? { trace: "off", video: "off", screenshot: "off" } : {}),
      },
    };
  }
  const localUrl = `http://127.0.0.1:${port}`;
  return {
    testDir: "./tests/e2e",
    use: { baseURL: localUrl },
    webServer: {
      command: `bun run start --port ${port}`,
      url: localUrl,
      env: { FORCE_COLOR: "0" },
    },
  };
}
