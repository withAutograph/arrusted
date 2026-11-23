import type { Browser, BrowserContext, Page } from "playwright/test";
import type { ProtectedLocalFixtureInput } from "./normal-actor-private-fixture.js";
export class NormalActorUiLoginError extends Error {
  readonly code: "normal-actor-ui-login-unavailable";
}
/** Verifies genuine sign-in's initial organization; never switches or patches it. */
export function withNormalActorUiLogin(
  input: ProtectedLocalFixtureInput & {
    appId: string;
    browser: Pick<Browser, "newContext">;
    baseURL: string;
    signInPath?: string;
  },
  operation: (input: { context: BrowserContext; page: Page }) => Promise<void>,
): Promise<void>;

/** After genuine UI logout, use a temporary tab in the context owned by
 * withNormalActorUiLogin (no arbitrary recorded/restored contexts).
 * Verifies actual initial organization; closes only the helper-owned sign-in tab.
 */
export function signInNormalActorInContext(
  input: ProtectedLocalFixtureInput & {
    appId: string;
    context: BrowserContext;
    baseURL: string;
    signInPath?: string;
  },
): Promise<void>;
