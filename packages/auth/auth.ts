import { createAuth, readAuthApplicationName } from "./server";

export const auth = createAuth({
  appName: readAuthApplicationName({
    // This direct access is required for Next's next.config.ts substitution.
    BETTER_AUTH_APP_NAME: process.env.BETTER_AUTH_APP_NAME,
  }),
  allowPlaceholderConfig: process.env.PLATFORM_AUTH_ALLOW_PLACEHOLDER_CONFIG === "1",
});

export default auth;
