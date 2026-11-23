import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const dependencySections = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

type Manifest = {
  name?: string;
  files?: string[];
} & Partial<Record<(typeof dependencySections)[number], Record<string, string>>>;

/** Pack a workspace package with the root catalog expanded into its tarball manifest. */
export function packWorkspacePackage(packagePath: string, destination: string): string {
  const source = path.resolve(repositoryRoot, packagePath);
  const relative = path.relative(path.join(repositoryRoot, "packages"), source);
  if (relative.startsWith("..") || path.isAbsolute(relative) || relative === "") {
    throw new Error("Pack a package under packages/");
  }
  const manifest = JSON.parse(readFileSync(path.join(source, "package.json"), "utf8")) as Manifest;
  if (!manifest.name || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error(`${packagePath}/package.json needs a package name and files list`);
  }
  const catalog =
    (
      JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8")) as {
        catalog?: Record<string, string>;
      }
    ).catalog ?? {};
  for (const section of dependencySections) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      if (version === "catalog:") {
        const pinned = catalog[name];
        if (!pinned || pinned === "catalog:") {
          throw new Error(`${manifest.name} ${section}.${name} needs a root catalog pin`);
        }
        manifest[section]![name] = pinned;
      } else if (version.startsWith("workspace:")) {
        throw new Error(`${manifest.name} ${section}.${name} needs a portable version`);
      }
    }
  }

  const staging = mkdtempSync(path.join(tmpdir(), "workspace-package-pack-"));
  try {
    for (const member of manifest.files) {
      const input = path.resolve(source, member);
      if (input === source || !input.startsWith(`${source}${path.sep}`)) {
        throw new Error(`${manifest.name} has an unsafe files entry: ${member}`);
      }
      if (!existsSync(input)) throw new Error(`${manifest.name} is missing ${member}; run build`);
      const output = path.join(staging, member);
      mkdirSync(path.dirname(output), { recursive: true });
      cpSync(input, output, { recursive: true });
    }
    writeFileSync(path.join(staging, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    mkdirSync(destination, { recursive: true });
    const archive = execFileSync(
      "npm",
      ["pack", "--ignore-scripts", "--pack-destination", path.resolve(destination), "--silent"],
      {
        cwd: staging,
        encoding: "utf8",
        env: {
          ...process.env,
          npm_config_cache: path.join(staging, ".npm-cache"),
          npm_config_logs_dir: path.join(staging, ".npm-logs"),
        },
      },
    ).trim();
    if (!archive.endsWith(".tgz") || path.basename(archive) !== archive) {
      throw new Error("npm pack did not return one package archive");
    }
    return path.resolve(destination, archive);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [packagePath, flag, destination] = process.argv.slice(2);
  if (!packagePath || flag !== "--destination" || !destination) {
    throw new Error("usage: pack-workspace-package.ts <package-path> --destination <directory>");
  }
  console.log(packWorkspacePackage(packagePath, destination));
}
