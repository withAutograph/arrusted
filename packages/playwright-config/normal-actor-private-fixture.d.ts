import type { Page } from "playwright/test";
import type { NormalActorIdentity, NormalActorSelector } from "./normal-actors.js";
export interface ProtectedLocalFixturePlan {
  version: 1;
  appId: string;
  environment: "local";
  runtimeId: string;
  database: string;
  authDatabase: string;
  principal: string;
  roles: readonly string[];
  tenants: readonly string[];
  releaseId: string;
  artifactHash: string;
  authScope?: "context";
  authPrincipal?: string;
}
export interface ProtectedLocalFixtureInput {
  appId?: string;
  selector: NormalActorSelector;
  baseURL?: string;
  manifestPath?: string;
  environment?: Readonly<Record<string, string | undefined>>;
}
export class NormalActorFixtureError extends Error {
  readonly code: "local-fixture-unavailable";
}
/** Internal only: URLs stay in process; no password or email is exposed. */
export function readProtectedNormalActorFixture(input: ProtectedLocalFixtureInput): Promise<{
  plan: ProtectedLocalFixturePlan;
  identity: NormalActorIdentity & { role: string | null; access: "admitted" | "unassigned" };
  appRuntimeUrl: string;
  authRuntimeUrl: string;
  assertCurrent(): Promise<void>;
  fillLoginFields(page: Page): Promise<void>;
}>;
