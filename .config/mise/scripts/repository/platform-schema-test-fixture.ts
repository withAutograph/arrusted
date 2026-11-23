import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { buildGeneratedRelease, generatedSchemaIndexText } from "./schema-release";

/** Compiler-owned bytes from a test-owned schema, independent of generated application policy. */
export function createPlatformSchemaTestFixture(
  repositoryRoot: string,
  appId: string,
  version = "platform-fixture-v1",
) {
  const root = mkdtempSync(path.join(tmpdir(), "platform-schema-fixture-"));
  if (appId === "runtime-trace-fixture") {
    console.error(
      JSON.stringify({
        event: "platform_schema_fixture_environment",
        tmpdir: tmpdir(),
        schemaCompilerDiagnostics: process.env.SCHEMA_COMPILER_DIAGNOSTICS === "1",
      }),
    );
  }
  const sourceRelativePath = `apps/${appId}/schema/${appId}.cue`;
  try {
    for (const name of [
      "Cargo.toml",
      "Cargo.lock",
      "rust-toolchain.toml",
      ".cargo",
      ".config",
      "packages",
      "node_modules",
    ]) {
      const source = path.join(repositoryRoot, name);
      if (existsSync(source)) symlinkSync(source, path.join(root, name));
    }
    const apps = path.join(root, "apps");
    const appRoot = path.join(apps, appId);
    mkdirSync(path.join(appRoot, "schema"), { recursive: true });
    writeFileSync(
      path.join(appRoot, "package.json"),
      JSON.stringify({ name: `@fixture/${appId}`, dependencies: { next: "16.0.0" } }) + "\n",
    );
    writeFileSync(
      path.join(root, sourceRelativePath),
      `package schema
manifest: #AppManifest & {
 app_id: "${appId}", customer_id: "platform-fixture", version: "${version}"
 models: [{id:"item",label:"Item",kind:"entity",fields:[{id:"title",label:"Title",type:"text",required:true}]}]
 authorization: {roles:[{id:"member",label:"Member"}],grants:[{role:"member",model:"item",operations:["read","create"],read_fields:["$id","$version","title"],write_fields:["title"],record:{kind:"all"}}]}
}
`,
    );
    const inputs = [
      "packages/schema-compiler/cue/app-manifest.cue",
      "packages/schema-compiler/cue/app-selection.cue",
      sourceRelativePath,
      "packages/domain-libs/catalog.json",
    ].filter((name) => existsSync(path.join(root, name)));
    const selectedTarget = process.env.CARGO_TARGET_DIR ?? process.env.CARGO_BUILD_TARGET_DIR;
    const defaultTarget = path.join(
      process.env.XDG_CACHE_HOME ?? path.join(homedir(), ".cache"),
      "schema-compiler",
      "target",
    );
    // Keep the caller's shared compiler closure outside disposable fixture roots.
    // Source paths and the compiler cwd still belong to this controlled fixture.
    const compilerEnvironment = {
      ...process.env,
      CARGO_TARGET_DIR: path.resolve(repositoryRoot, selectedTarget ?? defaultTarget),
    };
    const release = buildGeneratedRelease(
      appId,
      path.join(root, "compiled"),
      inputs,
      root,
      compilerEnvironment,
    );
    const directory = path.join(appRoot, "schema/release", release.version);
    mkdirSync(path.dirname(directory), { recursive: true });
    cpSync(release.directory, directory, { recursive: true });
    writeFileSync(path.join(appRoot, "schema/index.ts"), generatedSchemaIndexText(release.version));
    return {
      root,
      directory,
      sourcePath: path.join(root, sourceRelativePath),
      version: release.version,
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
