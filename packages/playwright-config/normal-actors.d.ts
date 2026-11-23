import type {
  BrowserContext,
  PlaywrightTestArgs,
  PlaywrightTestOptions,
  PlaywrightWorkerArgs,
  PlaywrightWorkerOptions,
  TestType,
} from "playwright/test";

import type { PrivatePreviewBrowserOptions } from "./private-preview-access.js";

export { expect } from "playwright/test";
export interface NormalActorIdentity {
  actorKey: string;
  actorId: string;
  organizationId: string | null;
  /** App assignments; an empty array means no app assignment. */
  roles: string[];
  storageState: string;
}
export interface NormalActorManifest {
  version: 1;
  actors: NormalActorIdentity[];
}
export interface NormalActorSelector {
  actorKey: string;
  organizationId: string | null;
}
export class NormalActorBrowserError extends Error {
  readonly code:
    | "manifest_unavailable"
    | "manifest_invalid"
    | "actor_not_found"
    | "actor_ambiguous"
    | "context_unavailable";
  constructor(code: NormalActorBrowserError["code"]);
}
export function readNormalActorManifest(manifestPath?: string): Promise<NormalActorManifest>;
export function selectNormalActor(
  manifest: NormalActorManifest,
  selector: NormalActorSelector,
): NormalActorIdentity;
export function createNormalActorContext<Context extends { close(): Promise<void> }>(
  browser: { newContext(options: { storageState: string; baseURL?: string }): Promise<Context> },
  identity: NormalActorIdentity,
  baseURL?: string,
): Promise<Context>;
export function withNormalActorContext<Context extends { close(): Promise<void> }, Result>(
  browser: { newContext(options: { storageState: string; baseURL?: string }): Promise<Context> },
  identity: NormalActorIdentity,
  operation: (context: Context) => Promise<Result>,
  baseURL?: string,
): Promise<Result>;
export function createNormalActorContextManager<Context extends { close(): Promise<void> }>(
  browser: { newContext(options: { storageState: string; baseURL?: string }): Promise<Context> },
  manifest: NormalActorManifest,
  baseURL?: string,
  previewOptions?: PrivatePreviewBrowserOptions,
): { open(selector: NormalActorSelector): Promise<Context>; close(): Promise<void> };
export interface NormalActorFixtures {
  normalActors: NormalActorManifest;
  /** Contexts close automatically during fixture teardown. */
  actorContext(selector: NormalActorSelector): Promise<BrowserContext>;
}
export const test: TestType<
  PlaywrightTestArgs & PlaywrightTestOptions & NormalActorFixtures,
  PlaywrightWorkerArgs & PlaywrightWorkerOptions
>;
