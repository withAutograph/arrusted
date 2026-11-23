#!/usr/bin/env bun
import { readAuthEnvironment } from "../../../../packages/auth/env";

const strict = process.argv.includes("--strict") || process.env.NODE_ENV === "production";

try {
  const env = readAuthEnvironment(process.env, {
    allowPlaceholderConfig: !strict,
  });
  if (env.usingPlaceholderConfig) {
    console.log("Auth config check passed with local placeholder config for schema tooling.");
  } else {
    console.log("Auth config check passed with explicit environment.");
  }
} catch (error) {
  if (isAuthConfigurationError(error)) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

function isAuthConfigurationError(error: unknown): error is { message: string } {
  if (!error || typeof error !== "object") {
    return false;
  }
  return (
    "code" in error &&
    error.code === "auth_configuration_error" &&
    "message" in error &&
    typeof error.message === "string"
  );
}
