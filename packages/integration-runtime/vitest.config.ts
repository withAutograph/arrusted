import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../..", import.meta.url));
export default {
  root,
  resolve: {
    alias: {
      "@modules/integrations": path.join(root, "packages/modules/integrations/index.ts"),
      "@autograph/components": path.join(root, "packages/design-systems/core/components/index.ts"),
    },
  },
  test: {
    include: ["packages/integration-runtime/__tests__/*.test.{ts,tsx}"],
    environment: "node",
  },
};
