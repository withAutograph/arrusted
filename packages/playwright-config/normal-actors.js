import { readFile } from "node:fs/promises";
import path from "node:path";
import { test as base, expect } from "playwright/test";
import {
  assertPrivatePreviewTracePolicy,
  bootstrapPrivatePreviewContext,
} from "./private-preview-access.js";

export { expect };

/** Never attach private manifest paths, cookie bytes, or parser diagnostics to this error. */
export class NormalActorBrowserError extends Error {
  constructor(code) {
    super(`Normal actor browser setup failed (${code}).`);
    this.name = "NormalActorBrowserError";
    this.code = code;
  }
}

const nonemptyString = (value) => typeof value === "string" && value.length > 0;
const object = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const parseActor = (value, directory) => {
  if (
    !object(value) ||
    !nonemptyString(value.actorKey) ||
    !nonemptyString(value.actorId) ||
    !(value.organizationId === null || nonemptyString(value.organizationId)) ||
    !Array.isArray(value.roles) ||
    !value.roles.every(nonemptyString) ||
    !nonemptyString(value.storageState)
  ) {
    throw new NormalActorBrowserError("manifest_invalid");
  }
  return {
    actorKey: value.actorKey,
    actorId: value.actorId,
    organizationId: value.organizationId,
    roles: [...value.roles],
    storageState: path.isAbsolute(value.storageState)
      ? value.storageState
      : path.resolve(directory, value.storageState),
  };
};

const parseRuntimeIdentity = (value, directory) => {
  if (!object(value) || !(value.role === null || nonemptyString(value.role))) {
    throw new NormalActorBrowserError("manifest_invalid");
  }
  return parseActor(
    {
      actorKey: value.actorId,
      actorId: value.actorId,
      organizationId: value.organizationId,
      roles: value.role === null ? [] : [value.role],
      storageState: value.storageState,
    },
    directory,
  );
};

/** Read the Builder's private normal-session manifest; cookie files remain untouched. */
export async function readNormalActorManifest(manifestPath = process.env.APP_TEST_IDENTITIES_FILE) {
  if (!nonemptyString(manifestPath)) {
    throw new NormalActorBrowserError("manifest_unavailable");
  }
  let content;
  try {
    content = await readFile(manifestPath, "utf8");
  } catch {
    throw new NormalActorBrowserError("manifest_unavailable");
  }
  let manifest;
  try {
    manifest = JSON.parse(content);
  } catch {
    throw new NormalActorBrowserError("manifest_invalid");
  }
  if (!object(manifest) || manifest.version !== 1) {
    throw new NormalActorBrowserError("manifest_invalid");
  }
  const directory = path.dirname(path.resolve(manifestPath));
  const hasActors = Object.hasOwn(manifest, "actors");
  if (hasActors) {
    if (!Array.isArray(manifest.actors)) {
      throw new NormalActorBrowserError("manifest_invalid");
    }
    return { version: 1, actors: manifest.actors.map((actor) => parseActor(actor, directory)) };
  }
  if (Array.isArray(manifest.identities)) {
    return {
      version: 1,
      actors: manifest.identities.map((identity) => parseRuntimeIdentity(identity, directory)),
    };
  }
  throw new NormalActorBrowserError("manifest_invalid");
}

/** The same account may have independent selected sessions in several organizations. */
export function selectNormalActor(manifest, selector) {
  const matching = manifest.actors.filter(
    (actor) =>
      actor.actorKey === selector.actorKey && actor.organizationId === selector.organizationId,
  );
  if (matching.length === 0) {
    throw new NormalActorBrowserError("actor_not_found");
  }
  if (matching.length !== 1) {
    throw new NormalActorBrowserError("actor_ambiguous");
  }
  return matching[0];
}

/** Restore the actual jar at the configured browser origin; do not synthesize headers or cookies. */
export async function createNormalActorContext(browser, identity, baseURL) {
  try {
    return await browser.newContext({
      storageState: identity.storageState,
      ...(baseURL === undefined ? {} : { baseURL }),
    });
  } catch {
    throw new NormalActorBrowserError("context_unavailable");
  }
}

/** Own one context for a scoped operation, including exceptional completion. */
export async function withNormalActorContext(browser, identity, operation, baseURL) {
  const context = await createNormalActorContext(browser, identity, baseURL);
  try {
    return await operation(context);
  } finally {
    await context.close();
  }
}

/** Own every selected context for a test and close all of them during teardown. */
export function createNormalActorContextManager(browser, manifest, baseURL, previewOptions) {
  const contexts = [];
  return {
    async open(selector) {
      assertPrivatePreviewTracePolicy(previewOptions);
      const identity = selectNormalActor(manifest, selector);
      const context = await createNormalActorContext(browser, identity, baseURL);
      contexts.push(context);
      await bootstrapPrivatePreviewContext(context, baseURL, previewOptions);
      return context;
    },
    async close() {
      const closing = contexts.splice(0);
      await Promise.all(closing.map((context) => context.close()));
    },
  };
}

/** Lazy fixtures: ordinary anonymous page tests do not require an actor manifest. */
export const test = base.extend({
  context: async ({ context, baseURL }, use, testInfo) => {
    await bootstrapPrivatePreviewContext(context, baseURL, {
      trace: testInfo.project.use.trace,
      video: testInfo.project.use.video,
      screenshot: testInfo.project.use.screenshot,
      reporter: testInfo.config.reporter,
    });
    await use(context);
  },
  // oxlint-disable-next-line eslint/no-empty-pattern -- Playwright requires an object-destructured fixture dependency parameter.
  normalActors: async ({}, use) => {
    await use(await readNormalActorManifest());
  },
  actorContext: async ({ browser, normalActors, baseURL }, use, testInfo) => {
    const contexts = createNormalActorContextManager(browser, normalActors, baseURL, {
      trace: testInfo.project.use.trace,
      video: testInfo.project.use.video,
      screenshot: testInfo.project.use.screenshot,
      reporter: testInfo.config.reporter,
    });
    try {
      await use((selector) => contexts.open(selector));
    } finally {
      await contexts.close();
    }
  },
});
