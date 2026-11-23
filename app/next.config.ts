import { nextAppConfig } from "@autograph/next-config";
export default nextAppConfig({
  typedRoutes: false,
  serverExternalPackages: ["pg"],
  outputFileTracingIncludes: {
    "/*": [
      "./.generated/release/**/*",
      "./schema/**/*.cue",
      "../packages/canvas-host/dist/mcp-app.html",
    ],
  },
});
