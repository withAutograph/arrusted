import { expect, test } from "vite-plus/test";
import { schemaCompilerCommand } from "./schema-compiler-command";

test("keeps local schema compilation on the direct Cargo path", () => {
  const invocation = schemaCompilerCommand(
    ["run", "--locked", "-p", "schema-compiler", "--", "--app-artifact"],
    { PATH: "/local/toolchain/bin" },
  );

  expect(invocation.executable).toBe("cargo");
  expect(invocation.args).toEqual([
    "run",
    "--locked",
    "-p",
    "schema-compiler",
    "--",
    "--app-artifact",
  ]);
  expect(invocation.env.PATH).toBe("/local/toolchain/bin");
});

test("uses the pinned provider Mise context with Rust and CUE", () => {
  const environment = {
    PATH: "/provider/bin",
    VERCEL: "1",
    VERCEL_MISE_BIN: "/private/cache/mise/bin/mise",
    MISE_CONFIG_FILE: "/repo/.config/mise/config.toml",
    MISE_CONFIG_DIR: "/private/cache/mise/config",
    MISE_DATA_DIR: "/private/cache/mise/data",
    MISE_ENABLE_TOOLS: "bun",
  };
  const invocation = schemaCompilerCommand(
    ["run", "--locked", "-p", "schema-compiler", "--", "--app-artifact"],
    environment,
  );

  expect(invocation.executable).toBe(environment.VERCEL_MISE_BIN);
  expect(invocation.args).toEqual([
    "exec",
    "--locked",
    "--",
    "cargo",
    "run",
    "--locked",
    "-p",
    "schema-compiler",
    "--",
    "--app-artifact",
  ]);
  expect(invocation.env.MISE_ENABLE_TOOLS).toBe("rust,cue");
  expect(invocation.env.MISE_CONFIG_FILE).toBe(environment.MISE_CONFIG_FILE);
  expect(invocation.env.MISE_CONFIG_DIR).toBe(environment.MISE_CONFIG_DIR);
  expect(invocation.env.MISE_DATA_DIR).toBe(environment.MISE_DATA_DIR);
  expect(environment.MISE_ENABLE_TOOLS).toBe("bun");
});
