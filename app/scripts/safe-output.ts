import { errorMessage, redact } from "../../packages/auth/redact";
export { errorMessage, redact } from "../../packages/auth/redact";

export class SafeError extends Error {}

export function reportError(
  error: unknown,
  operation: string,
  env: Record<string, string | undefined> = process.env,
) {
  if (error instanceof SafeError && error.message) {
    console.error(redact(error.message, env));
    return;
  }
  console.error(redact(`${operation}: ${errorMessage(error)}`, env));
}
