import path from "node:path";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { nextAppConfig, nextConfigDefaults } =
  await vi.importActual<typeof import("./index")>("./index.ts");
import {
  nextAppConfig as runtimeNextAppConfig,
  nextConfigDefaults as runtimeNextConfigDefaults,
} from "./index.js";

describe("nextConfigDefaults", () => {
  it("shares the standard settings across TypeScript and runtime exports", () => {
    const aliasFor = (source: string): string => {
      const relative = path.relative(process.cwd(), path.resolve(import.meta.dirname, source));
      return relative.startsWith(".") ? relative : `./${relative}`;
    };
    const expected = {
      cacheComponents: true,
      partialPrefetching: true,
      poweredByHeader: false,
      reactCompiler: true,
      typedRoutes: true,
      turbopack: {
        resolveAlias: expect.objectContaining({
          "@/*": "./*",
          "@modules/*": aliasFor("../modules/*"),
          "@autograph/icons": aliasFor("../design-systems/core/icons/index.ts"),
        }),
      },
      webpack: expect.any(Function),
    };
    expect(nextConfigDefaults).toEqual(expected);
    expect(runtimeNextConfigDefaults).toEqual(expected);
  });

  it("resolves project-local aliases in both Next.js bundlers", () => {
    const appRoot = "/workspace/apps/example";
    for (const config of [nextConfigDefaults, runtimeNextConfigDefaults]) {
      const webpackConfig = { resolve: { alias: { existing: "/workspace/shared" } } };
      const result = config.webpack(webpackConfig as never, { dir: appRoot } as never);
      expect(result.resolve.alias).toEqual(
        expect.objectContaining({
          existing: "/workspace/shared",
          "@": appRoot,
          "@modules": path.resolve(import.meta.dirname, "../modules"),
          "@autograph/work-session-tools$": path.resolve(
            import.meta.dirname,
            "../work-session-tools/index.ts",
          ),
          "@autograph/work-session-tools": path.resolve(
            import.meta.dirname,
            "../work-session-tools",
          ),
        }),
      );
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("nextAppConfig", () => {
  it("preserves app-specific Next options", () => {
    expect(nextAppConfig({ allowedDevOrigins: ["127.0.0.1"] }).allowedDevOrigins).toEqual([
      "127.0.0.1",
    ]);
  });
});

describe.each([
  ["TypeScript", nextAppConfig],
  ["runtime JavaScript", runtimeNextAppConfig],
] as const)("trusted Server Action public origin (%s)", (_name, configure) => {
  let fixture: string;
  beforeEach(() => {
    fixture = mkdtempSync(path.join(tmpdir(), "next-trusted-origin-"));
    writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ name: "origin-fixture" }));
    vi.spyOn(process, "cwd").mockReturnValue(fixture);
  });
  afterEach(() => {
    rmSync(fixture, { force: true, recursive: true });
  });

  it.each([
    ["https://GATEWAY.EXAMPLE.TEST:443/", "gateway.example.test"],
    ["http://LOCALHOST:80/", "localhost"],
    ["https://gateway.example.test:8443/", "gateway.example.test:8443"],
  ])("normalizes the trusted origin %s into only its exact public host", (origin, host) => {
    expect(configure({}, { trustedPublicOrigin: origin }).experimental?.serverActions).toEqual({
      allowedOrigins: [host],
    });
  });

  it("preserves caller origins, body limit and other options without mutation", () => {
    const supplied = {
      poweredByHeader: false,
      experimental: {
        optimizePackageImports: ["fixture-library"],
        serverActions: { allowedOrigins: ["existing.example.test"], bodySizeLimit: "2mb" as const },
      },
    };
    const before = structuredClone(supplied);
    Object.freeze(supplied.experimental.serverActions.allowedOrigins);
    Object.freeze(supplied.experimental.serverActions);
    Object.freeze(supplied.experimental);
    Object.freeze(supplied);
    const configured = configure(supplied, { trustedPublicOrigin: "https://gateway.example.test" });
    expect(configured.experimental?.serverActions).toEqual({
      bodySizeLimit: "2mb",
      allowedOrigins: ["existing.example.test", "gateway.example.test"],
    });
    expect(configured.experimental?.optimizePackageImports).toEqual(["fixture-library"]);
    expect(configured.poweredByHeader).toBe(false);
    expect(supplied).toEqual(before);
  });

  it("does not duplicate an already configured exact public host", () => {
    const configured = configure(
      { experimental: { serverActions: { allowedOrigins: ["gateway.example.test"] } } },
      { trustedPublicOrigin: "https://GATEWAY.EXAMPLE.TEST:443/" },
    );
    expect(configured.experimental?.serverActions?.allowedOrigins).toEqual([
      "gateway.example.test",
    ]);
  });

  it("does not infer a public host from deployment or environment values", () => {
    vi.stubEnv("PLATFORM_PUBLIC_ORIGIN", "https://gateway.example.test");
    vi.stubEnv("VERCEL_URL", "provider-service-canary.invalid");
    expect(configure().experimental?.serverActions?.allowedOrigins).toBeUndefined();
  });

  it("rejects credentials, wildcards and non-origin inputs without exposing their values", () => {
    for (const origin of [
      "https://user:credential-canary@private-config-canary.invalid",
      "https://*.private-config-canary.invalid",
      "https://private-config-canary.invalid/path",
      "https://private-config-canary.invalid?credential-canary=value",
      "https://private-config-canary.invalid#credential-canary",
      "file:///private-config-canary",
      "javascript:private-config-canary",
      "private-config-canary",
      "",
    ]) {
      let error: unknown;
      try {
        configure({}, { trustedPublicOrigin: origin });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw new Error("Expected the invalid origin to be rejected");
      expect(error.message).not.toContain("private-config-canary");
      expect(error.message).not.toContain("credential-canary");
    }
  });
});

describe("linked dependency filesystem roots", () => {
  it.each([
    ["TypeScript", nextAppConfig],
    ["runtime JavaScript", runtimeNextAppConfig],
  ] as const)(
    "includes the source, dependency view and external scoped cache in %s",
    (_name, configure) => {
      const workspace = mkdtempSync(path.join(tmpdir(), "next-root-workspace-"));
      const cache = mkdtempSync(path.join(tmpdir(), "next-root-cache-"));
      try {
        const app = path.join(workspace, "apps", "fixture");
        const view = path.join(workspace, "dependency-view");
        const next = path.join(workspace, "installed-next");
        const scoped = path.join(cache, "linked-package");
        for (const directory of [app, view, next, scoped, path.join(view, "@fixture")]) {
          mkdirSync(directory, { recursive: true });
        }
        writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "root-fixture" }));
        writeFileSync(path.join(next, "package.json"), JSON.stringify({ name: "next" }));
        symlinkSync(view, path.join(app, "node_modules"));
        symlinkSync(next, path.join(view, "next"));
        symlinkSync(scoped, path.join(view, "@fixture", "linked"));
        vi.spyOn(process, "cwd").mockReturnValue(app);
        const config = configure();
        const root = config.turbopack?.root;
        expect(root).toBeTypeOf("string");
        expect(config.outputFileTracingRoot).toBe(root);
        for (const filename of [
          app,
          view,
          next,
          scoped,
          path.resolve(import.meta.dirname, "../.."),
        ]) {
          if (root === undefined) throw new Error("The default filesystem root was not configured");
          const relative = path.relative(root, realpathSync(filename));
          expect(
            relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
          ).toBe(false);
        }
        expect(config.turbopack?.resolveAlias).toMatchObject({ "@/*": "./*" });
        const alias = config.turbopack?.resolveAlias?.["@autograph/icons"];
        expect(typeof alias).toBe("string");
        if (typeof alias !== "string") throw new Error("The workspace alias was not retained");
        expect(path.resolve(app, alias)).toBe(
          path.resolve(import.meta.dirname, "../design-systems/core/icons/index.ts"),
        );
      } finally {
        rmSync(workspace, { recursive: true, force: true });
        rmSync(cache, { recursive: true, force: true });
      }
    },
  );

  it.each([nextAppConfig, runtimeNextAppConfig])(
    "preserves caller options and aligns a missing paired root",
    (configure) => {
      const root = path.resolve(tmpdir(), "explicit-next-root");
      const turbo = configure({
        turbopack: {
          root,
          resolveAlias: { "fixture-alias": "./fixture.ts" },
          resolveExtensions: [".ts", ".js"],
        },
      });
      expect(turbo.outputFileTracingRoot).toBe(root);
      expect(turbo.turbopack).toMatchObject({
        root,
        resolveAlias: { "@/*": "./*", "fixture-alias": "./fixture.ts" },
        resolveExtensions: [".ts", ".js"],
      });
      const tracing = configure({ outputFileTracingRoot: root });
      expect(tracing.turbopack?.root).toBe(root);
      const other = path.join(root, "other");
      const both = configure({ outputFileTracingRoot: root, turbopack: { root: other } });
      expect(both.outputFileTracingRoot).toBe(root);
      expect(both.turbopack?.root).toBe(other);
    },
  );
});
