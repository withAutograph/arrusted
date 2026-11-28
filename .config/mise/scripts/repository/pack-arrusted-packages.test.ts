import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vite-plus/test";
import {
  detectHostCliTarget,
  stageCliPackage,
  stripWorkspaceManifestForPublish,
  verifyBinaryFormat,
} from "./pack-arrusted-packages";

function makeMachoArm64Header(): Buffer {
  const buf = Buffer.alloc(128);
  buf.writeUInt32LE(0xfeedfacf, 0);
  buf.writeUInt32LE(0x0100000c, 4);
  return buf;
}

function makeMachoUniversalHeader(cpuTypes: number[]): Buffer {
  const buf = Buffer.alloc(128);
  buf.writeUInt32BE(0xcafebabe, 0);
  buf.writeUInt32BE(cpuTypes.length, 4);
  cpuTypes.forEach((cpu, idx) => {
    buf.writeUInt32BE(cpu, 8 + idx * 20);
  });
  return buf;
}

function makeElfX64Header(): Buffer {
  const buf = Buffer.alloc(128);
  buf[0] = 0x7f;
  buf[1] = 0x45;
  buf[2] = 0x4c;
  buf[3] = 0x46;
  buf[4] = 2;
  buf[5] = 1;
  buf.writeUInt16LE(0x3e, 18);
  return buf;
}

describe("pack-arrusted-packages", () => {
  test("detectHostCliTarget maps supported platforms and rejects unsupported pairs", () => {
    expect(detectHostCliTarget("darwin", "arm64")).toBe("darwin-arm64");
    expect(detectHostCliTarget("linux", "x64")).toBe("linux-x64");
    expect(detectHostCliTarget("win32", "x64")).toBeUndefined();
    expect(detectHostCliTarget("linux", "arm64")).toBeUndefined();
  });

  test("verifyBinaryFormat enforces target OS and CPU headers", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "arrusted-bin-format-"));
    try {
      const machoThin = path.join(dir, "macho-arm64");
      const machoFat = path.join(dir, "macho-universal");
      const elfX64 = path.join(dir, "elf-x64");
      const shellStub = path.join(dir, "stub.sh");

      writeFileSync(machoThin, makeMachoArm64Header());
      writeFileSync(machoFat, makeMachoUniversalHeader([0x01000007, 0x0100000c]));
      writeFileSync(elfX64, makeElfX64Header());
      writeFileSync(shellStub, "#!/bin/sh\n".padEnd(128, "#"));

      expect(() => verifyBinaryFormat(machoThin, "darwin-arm64")).not.toThrow();
      expect(() => verifyBinaryFormat(machoFat, "darwin-arm64")).not.toThrow();
      expect(() => verifyBinaryFormat(elfX64, "linux-x64")).not.toThrow();

      const hostTarget = detectHostCliTarget();
      if (hostTarget) {
        expect(() => verifyBinaryFormat(process.execPath, hostTarget)).not.toThrow();
      }

      expect(() => verifyBinaryFormat(elfX64, "darwin-arm64")).toThrow(/Mach-O/);
      expect(() => verifyBinaryFormat(machoThin, "linux-x64")).toThrow(/ELF/);
      expect(() => verifyBinaryFormat(shellStub, "darwin-arm64")).toThrow();
      expect(() => verifyBinaryFormat(shellStub, "linux-x64")).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stripWorkspaceManifestForPublish removes source conditions, scripts, and devDependencies while rejecting unresolved workspace or catalog pins", () => {
    const cleaned = stripWorkspaceManifestForPublish({
      name: "@arrusted/core",
      version: "0.1.0-alpha.1",
      private: false,
      license: "MIT",
      repository: {
        type: "git",
        url: "git+https://github.com/withAutograph/arrusted-development.git",
        directory: "packages/arrusted/core",
      },
      scripts: { build: "bun scripts/build.ts" },
      devDependencies: { "@autograph/typescript-config": "workspace:*" },
      dependencies: { pg: "8.23.0" },
      optionalDependencies: {
        "@arrusted/cli-darwin-arm64": "0.1.0-alpha.1",
        "@arrusted/cli-linux-x64": "0.1.0-alpha.1",
      },
      exports: {
        ".": {
          source: "./src/index.ts",
          types: "./dist/index.d.ts",
          import: "./dist/index.js",
          default: "./dist/index.js",
        },
        "./styles.css": {
          source: "./src/styles.css",
          default: "./dist/styles.css",
        },
      },
    });

    expect(cleaned).not.toHaveProperty("scripts");
    expect(cleaned).not.toHaveProperty("devDependencies");
    expect(cleaned.exports).toEqual({
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
        default: "./dist/index.js",
      },
      "./styles.css": {
        default: "./dist/styles.css",
      },
    });

    expect(() =>
      stripWorkspaceManifestForPublish({
        name: "@arrusted/core",
        version: "0.1.0-alpha.1",
        private: false,
        license: "MIT",
        repository: {
          type: "git",
          url: "git+https://github.com/withAutograph/arrusted-development.git",
        },
        optionalDependencies: { "@arrusted/cli-darwin-arm64": "workspace:*" },
      }),
    ).toThrow(/unresolved optionalDependencies/);

    expect(() =>
      stripWorkspaceManifestForPublish({
        name: "@arrusted/core",
        version: "0.1.0-alpha.1",
        private: false,
        license: "MIT",
        repository: {
          type: "git",
          url: "git+https://github.com/withAutograph/arrusted-development.git",
        },
        dependencies: { pg: "catalog:" },
      }),
    ).toThrow(/unresolved dependencies/);

    expect(() =>
      stripWorkspaceManifestForPublish({
        name: "@arrusted/cli-linux-x64",
        version: "0.1.0-alpha.1",
        private: false,
        license: "MIT",
        repository: {
          type: "git",
          url: "git+https://github.com/withAutograph/arrusted-development.git",
        },
      }),
    ).toThrow(/MIT AND Apache-2\.0/);

    expect(() =>
      stripWorkspaceManifestForPublish({
        name: "@arrusted/core",
        version: "0.1.0-alpha.1",
        private: false,
        license: "MIT",
      }),
    ).toThrow(/repository/);
  });

  test("stageCliPackage dereferences symlinked binaries into standalone files", () => {
    const fakeRepo = mkdtempSync(path.join(tmpdir(), "arrusted-stage-symlink-"));
    try {
      const nonHostTarget = detectHostCliTarget() === "linux-x64" ? "darwin-arm64" : "linux-x64";
      const headerBytes =
        nonHostTarget === "darwin-arm64" ? makeMachoArm64Header() : makeElfX64Header();
      mkdirSync(path.join(fakeRepo, `packages/arrusted/cli-${nonHostTarget}`), {
        recursive: true,
      });
      const realCompiler = path.join(fakeRepo, "real-schema-compiler");
      const realCue = path.join(fakeRepo, "real-cue");
      writeFileSync(realCompiler, headerBytes);
      writeFileSync(realCue, headerBytes);

      const symlinkCompiler = path.join(fakeRepo, "link-schema-compiler");
      const symlinkCue = path.join(fakeRepo, "link-cue");
      symlinkSync(realCompiler, symlinkCompiler);
      symlinkSync(realCue, symlinkCue);

      const stagedDir = stageCliPackage({
        repoRoot: fakeRepo,
        target: nonHostTarget,
        compilerBinary: symlinkCompiler,
        cueBinary: symlinkCue,
      });

      expect(lstatSync(path.join(stagedDir, "bin/schema-compiler")).isSymbolicLink()).toBe(false);
      expect(lstatSync(path.join(stagedDir, "bin/cue")).isSymbolicLink()).toBe(false);
    } finally {
      rmSync(fakeRepo, { recursive: true, force: true });
    }
  });
});
