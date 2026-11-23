import { readFile } from "node:fs/promises";
import path from "node:path";

// Embed the installed parser's real WASM so compiled workers need no checkout assets.
export function protectedParserAssetsPlugin() {
  return {
    name: "protected-parser-owned-assets",
    setup(build) {
      build.onLoad(
        { filter: /[/\\]@libpg-query[/\\]parser[/\\]wasm[/\\]libpg-query\.(?:js|cjs)$/u },
        async ({ path: modulePath }) => {
          const source = await Bun.file(modulePath).text();
          const binary = await readFile(path.join(path.dirname(modulePath), "libpg-query.wasm"));
          if (!source.includes("var wasmBinary;"))
            throw new Error("Installed PostgreSQL parser cannot embed its WASM input");
          return {
            contents: source.replace(
              "var wasmBinary;",
              `var wasmBinary=Uint8Array.from(Buffer.from(${JSON.stringify(binary.toString("base64"))},"base64"));`,
            ),
            loader: "js",
          };
        },
      );
    },
  };
}
