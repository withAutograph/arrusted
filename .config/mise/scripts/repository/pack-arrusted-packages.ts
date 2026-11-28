import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type SupportedCliTarget = "darwin-arm64" | "linux-x64";

export type ArrustedPackageId = "core" | "auth" | "ui" | "cli-darwin-arm64" | "cli-linux-x64";

const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const CPU_TYPE_ARM64 = 0x0100000c;
const ELF_MACHINE_X86_64 = 0x3e;

export function detectHostCliTarget(
  platform = process.platform,
  arch = process.arch,
): SupportedCliTarget | undefined {
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  return undefined;
}

export function verifyBinaryFormat(filePath: string, target: SupportedCliTarget): void {
  const resolved = path.resolve(filePath);
  if (!existsSync(resolved)) {
    throw new Error(`Binary does not exist: ${resolved}`);
  }
  const stat = statSync(resolved);
  if (!stat.isFile() || stat.size < 64) {
    throw new Error(`Binary is missing or truncated (${stat.size} bytes): ${resolved}`);
  }

  const header = Buffer.alloc(512);
  const fd = openSync(resolved, "r");
  let bytesRead = 0;
  try {
    bytesRead = readSync(fd, header, 0, header.length, 0);
  } finally {
    closeSync(fd);
  }

  if (target === "darwin-arm64") {
    const magicLe = header.readUInt32LE(0);
    if (magicLe === MH_MAGIC_64) {
      const cpuType = header.readUInt32LE(4);
      if (cpuType === CPU_TYPE_ARM64) return;
      throw new Error(
        `Mach-O binary '${resolved}' has cpuType 0x${cpuType.toString(16)}, expected arm64 (0x100000c).`,
      );
    }
    const magicBe = header.readUInt32BE(0);
    if (magicBe === FAT_MAGIC || magicBe === FAT_MAGIC_64) {
      const stride = magicBe === FAT_MAGIC_64 ? 32 : 20;
      const nfat = header.readUInt32BE(4);
      if (nfat >= 1 && nfat <= 15 && bytesRead >= 8 + nfat * stride) {
        for (let i = 0; i < nfat; i += 1) {
          if (header.readUInt32BE(8 + i * stride) === CPU_TYPE_ARM64) return;
        }
      }
      throw new Error(`Universal Mach-O binary '${resolved}' does not contain an arm64 slice.`);
    }
    throw new Error(`Binary '${resolved}' is not a darwin-arm64 Mach-O executable.`);
  }

  const isElf64Le =
    header[0] === 0x7f &&
    header[1] === 0x45 &&
    header[2] === 0x4c &&
    header[3] === 0x46 &&
    header[4] === 2 &&
    header[5] === 1;
  if (!isElf64Le) {
    throw new Error(`Binary '${resolved}' is not a 64-bit little-endian ELF executable.`);
  }
  const machine = header.readUInt16LE(18);
  if (machine !== ELF_MACHINE_X86_64) {
    throw new Error(
      `ELF binary '${resolved}' has e_machine 0x${machine.toString(16)}, expected x86_64 (0x3e).`,
    );
  }
}

function stripExportSourceConditions(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const cleaned: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "source") continue;
    cleaned[key] = stripExportSourceConditions(entry);
  }
  return cleaned;
}

export function stripWorkspaceManifestForPublish(
  manifest: Record<string, unknown>,
): Record<string, unknown> {
  if (manifest.private !== false) {
    throw new Error(`Refusing to pack private or unmarked manifest '${String(manifest.name)}'.`);
  }
  const expectedLicense = String(manifest.name).startsWith("@arrusted/cli-")
    ? "MIT AND Apache-2.0"
    : "MIT";
  if (manifest.license !== expectedLicense) {
    throw new Error(
      `Manifest '${String(manifest.name)}' must declare '${expectedLicense}' license (got '${String(manifest.license)}').`,
    );
  }
  if (typeof manifest.version !== "string" || manifest.version.trim().length === 0) {
    throw new Error(`Manifest '${String(manifest.name)}' is missing a version.`);
  }
  const repo = manifest.repository as { type?: unknown; url?: unknown } | undefined;
  if (
    !repo ||
    typeof repo !== "object" ||
    repo.type !== "git" ||
    typeof repo.url !== "string" ||
    !repo.url.trim()
  ) {
    throw new Error(
      `Manifest '${String(manifest.name)}' must declare repository.type='git' and repository.url for npm provenance.`,
    );
  }

  const cleaned: Record<string, unknown> = { ...manifest };
  delete cleaned.devDependencies;
  delete cleaned.scripts;
  if (cleaned.exports !== undefined) {
    cleaned.exports = stripExportSourceConditions(cleaned.exports);
  }

  for (const section of ["dependencies", "peerDependencies", "optionalDependencies"] as const) {
    const deps = cleaned[section];
    if (!deps || typeof deps !== "object") continue;
    for (const [depName, spec] of Object.entries(deps as Record<string, unknown>)) {
      if (
        typeof spec !== "string" ||
        spec.startsWith("workspace:") ||
        spec.startsWith("catalog:")
      ) {
        throw new Error(
          `Manifest '${String(manifest.name)}' leaked unresolved ${section}.${depName} = '${String(spec)}'.`,
        );
      }
    }
  }
  return cleaned;
}

export function resolveRepoSchemaCompiler(repoRoot = defaultRepoRoot): string {
  const candidates = [
    process.env.CARGO_TARGET_DIR
      ? path.join(process.env.CARGO_TARGET_DIR, "release/schema-compiler")
      : undefined,
    process.env.CARGO_TARGET_DIR
      ? path.join(process.env.CARGO_TARGET_DIR, "debug/schema-compiler")
      : undefined,
    path.join(repoRoot, "target/release/schema-compiler"),
    path.join(repoRoot, "target/debug/schema-compiler"),
  ].filter((item): item is string => Boolean(item));

  const existing = candidates.find((candidate) => existsSync(candidate));
  if (existing) return existing;

  execFileSync("cargo", ["build", "-p", "schema-compiler"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  const built = candidates.find((candidate) => existsSync(candidate));
  if (!built) {
    throw new Error("Unable to locate built schema-compiler binary after cargo build.");
  }
  return built;
}

export function stageCliPackage(options: {
  repoRoot?: string;
  target: SupportedCliTarget;
  compilerBinary: string;
  cueBinary: string;
}): string {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const realCompiler = realpathSync(path.resolve(options.compilerBinary));
  const realCue = realpathSync(path.resolve(options.cueBinary));
  verifyBinaryFormat(realCompiler, options.target);
  verifyBinaryFormat(realCue, options.target);

  const pkgDir = path.join(repoRoot, "packages/arrusted", `cli-${options.target}`);
  const binDir = path.join(pkgDir, "bin");
  rmSync(binDir, { recursive: true, force: true });
  mkdirSync(binDir, { recursive: true });

  const stagedCompiler = path.join(binDir, "schema-compiler");
  const stagedCue = path.join(binDir, "cue");
  copyFileSync(realCompiler, stagedCompiler);
  copyFileSync(realCue, stagedCue);
  chmodSync(stagedCompiler, 0o755);
  chmodSync(stagedCue, 0o755);

  if (detectHostCliTarget() === options.target) {
    execFileSync(stagedCue, ["version"], { stdio: "pipe" });
    const compilerProbe = spawnSync(stagedCompiler, [], { encoding: "utf8" });
    if (compilerProbe.error || !compilerProbe.stderr?.includes("Usage: schema-compiler")) {
      throw new Error(
        `Staged schema-compiler failed native smoke check: ${compilerProbe.error?.message ?? compilerProbe.stderr ?? "no output"}`,
      );
    }
  }
  return pkgDir;
}

export function packArrustedPackage(options: {
  repoRoot?: string;
  packageName: ArrustedPackageId;
  outDir: string;
  build?: boolean;
}): { name: string; version: string; tarballPath: string } {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const packageDir = path.join(repoRoot, "packages/arrusted", options.packageName);
  const outDir = path.resolve(options.outDir);

  if (options.packageName.startsWith("cli-")) {
    const target = options.packageName.slice("cli-".length) as SupportedCliTarget;
    for (const exe of ["schema-compiler", "cue"] as const) {
      const binPath = path.join(packageDir, "bin", exe);
      if (!existsSync(binPath) || lstatSync(binPath).isSymbolicLink()) {
        throw new Error(
          `CLI binary '${binPath}' must exist as a standalone regular file (not a symlink).`,
        );
      }
      verifyBinaryFormat(binPath, target);
    }
  } else if (options.build !== false) {
    execFileSync("bun", ["run", "build"], { cwd: packageDir, stdio: "inherit" });
  }

  const scratch = mkdtempSync(path.join(tmpdir(), `arrusted-pack-${options.packageName}-`));
  try {
    const rawDir = path.join(scratch, "raw");
    const unpackDir = path.join(scratch, "unpack");
    mkdirSync(rawDir, { recursive: true });
    mkdirSync(unpackDir, { recursive: true });

    execFileSync("bun", ["pm", "pack", "--destination", rawDir], {
      cwd: packageDir,
      stdio: "inherit",
    });
    const rawTarballs = readdirSync(rawDir).filter((file) => file.endsWith(".tgz"));
    if (rawTarballs.length !== 1) {
      throw new Error(
        `Expected exactly 1 tarball from bun pm pack for ${options.packageName}, got ${rawTarballs.length}.`,
      );
    }
    const rawTarballName = rawTarballs[0]!;
    execFileSync("tar", ["-xzf", path.join(rawDir, rawTarballName), "-C", unpackDir]);

    const unpackedPkgDir = path.join(unpackDir, "package");
    const unpackedManifestPath = path.join(unpackedPkgDir, "package.json");
    const rawManifest = JSON.parse(readFileSync(unpackedManifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    const cleanedManifest = stripWorkspaceManifestForPublish(rawManifest);
    writeFileSync(unpackedManifestPath, `${JSON.stringify(cleanedManifest, null, 2)}\n`, "utf8");
    copyFileSync(path.join(repoRoot, "LICENSE"), path.join(unpackedPkgDir, "LICENSE"));

    mkdirSync(outDir, { recursive: true });
    const tarballPath = path.join(outDir, rawTarballName);
    rmSync(tarballPath, { force: true });
    execFileSync("tar", ["-czf", tarballPath, "package"], {
      cwd: unpackDir,
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });

    return {
      name: String(cleanedManifest.name),
      version: String(cleanedManifest.version),
      tarballPath,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function parseCliFlag(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const next = args[index + 1];
  if (!next || next.startsWith("--")) {
    throw new Error(`Flag ${flag} requires a value.`);
  }
  return next;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const outDir = parseCliFlag(args, "--out-dir");
  if (!outDir) {
    throw new Error(
      "Usage: bun pack-arrusted-packages.ts --out-dir <dir> [--packages core,auth,ui] [--stage-host-cli] [--stage-cli <darwin-arm64|linux-x64> --compiler-bin <path> --cue-bin <path>]",
    );
  }

  const stageTarget = parseCliFlag(args, "--stage-cli") as SupportedCliTarget | undefined;
  if (stageTarget) {
    if (stageTarget !== "darwin-arm64" && stageTarget !== "linux-x64") {
      throw new Error(`Unsupported --stage-cli target: ${stageTarget}`);
    }
    const compilerBinary = parseCliFlag(args, "--compiler-bin");
    const cueBinary = parseCliFlag(args, "--cue-bin");
    if (!compilerBinary || !cueBinary) {
      throw new Error("--stage-cli requires both --compiler-bin and --cue-bin.");
    }
    stageCliPackage({ target: stageTarget, compilerBinary, cueBinary });
  } else if (args.includes("--stage-host-cli")) {
    const hostTarget = detectHostCliTarget();
    if (!hostTarget) {
      throw new Error(
        `Unsupported host platform for --stage-host-cli: ${process.platform}-${process.arch}`,
      );
    }
    const cueBinary = execFileSync("which", ["cue"], { encoding: "utf8" }).trim();
    const compilerBinary = resolveRepoSchemaCompiler(defaultRepoRoot);
    stageCliPackage({ target: hostTarget, compilerBinary, cueBinary });
  }

  const rawPackages = parseCliFlag(args, "--packages");
  const defaultPackages: ArrustedPackageId[] = ["core", "auth", "ui"];
  if (args.includes("--stage-host-cli")) {
    const hostTarget = detectHostCliTarget();
    if (hostTarget) defaultPackages.unshift(`cli-${hostTarget}`);
  } else if (stageTarget) {
    defaultPackages.unshift(`cli-${stageTarget}`);
  }

  const selected = rawPackages
    ? (rawPackages.split(",").map((entry) => entry.trim()) as ArrustedPackageId[])
    : defaultPackages;

  for (const packageName of selected) {
    const packed = packArrustedPackage({ packageName, outDir });
    console.log(`Packed ${packed.name}@${packed.version} -> ${packed.tarballPath}`);
  }
}
