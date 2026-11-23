import { test as playwrightTest } from "playwright/test";
import { readProtectedNormalActorFixture } from "./normal-actor-private-fixture.js";
import {
  assertPrivatePreviewTracePolicy,
  PrivatePreviewBrowserAccessError,
  bootstrapPrivatePreviewContext,
} from "./private-preview-access.js";
import diagnostics from "./private-browser-diagnostics.cjs";

const { loginDiagnosticMessage, markPrivateBrowserError, privateBrowserErrorStage } = diagnostics;

const defaultSignInPath = "/auth/sign-in";
const protectedUiContexts = new WeakMap();
const internalDiagnostic = Symbol("protected browser diagnostic");
const bootstrapStage = (error, stage) =>
  stage === "preview-bootstrap" && error instanceof PrivatePreviewBrowserAccessError
    ? "preview-refresh-required"
    : stage;

export class NormalActorUiLoginError extends Error {
  constructor(token, stage) {
    const selected = token === internalDiagnostic ? stage : "protected-operation";
    // The message never interpolates an unrecognized stage or caught error.
    super(loginDiagnosticMessage(selected));
    if (token === internalDiagnostic) markPrivateBrowserError(this, selected);
    this.name = "NormalActorUiLoginError";
    this.code = "normal-actor-ui-login-unavailable";
  }
}
const loginError = (stage) => new NormalActorUiLoginError(internalDiagnostic, stage);

/** Real UI login in a fresh context, never a restored fixture session. */
export async function withNormalActorUiLogin(input, operation) {
  let context;
  let page;
  let scope;
  let stage = "recording-policy";
  try {
    const testInfo = playwrightTest.info();
    const policy = {
      reporter: testInfo.config.reporter,
      trace: testInfo.project.use.trace,
      video: testInfo.project.use.video,
      screenshot: testInfo.project.use.screenshot,
    };
    // Actual runner policy, never caller claims, governs credential retention.
    assertPrivatePreviewTracePolicy({ ...policy, authorityFile: "local-ui-login" });
    if (
      ![undefined, "off"].includes(policy.video) ||
      ![undefined, "off"].includes(policy.screenshot)
    )
      throw 0;
    stage = "fixture-scope";
    if (typeof input.appId !== "string" || input.appId.length === 0) throw 0;
    scope = await readProtectedNormalActorFixture(input);
    const signInPath = input.signInPath ?? defaultSignInPath;
    if (
      !signInPath.startsWith("/") ||
      signInPath.startsWith("//") ||
      new URL(signInPath, input.baseURL).origin !== input.baseURL
    )
      throw 0;
    stage = "preview-bootstrap";
    context = await input.browser.newContext({ baseURL: input.baseURL });
    await bootstrapPrivatePreviewContext(context, input.baseURL, policy);
    stage = "auth-ui";
    page = await context.newPage();
    await page.goto(signInPath);
    await scope.fillLoginFields(page);
    const [response] = await Promise.all([
      page.waitForResponse((candidate) => {
        const url = new URL(candidate.url());
        return (
          url.origin === input.baseURL &&
          url.pathname === "/api/auth/sign-in/email" &&
          candidate.request().method() === "POST"
        );
      }),
      page.locator('form button[type="submit"]').click(),
    ]);
    if (response.status() !== 200) throw 0;
    stage = "auth-session";
    const observed = await context.request.get(
      new URL("/api/auth/get-session", input.baseURL).href,
      { maxRedirects: 0 },
    );
    if (observed.status() !== 200) throw 0;
    const session = await observed.json();
    if (
      session?.user?.id !== scope.identity.actorId ||
      session?.session?.userId !== scope.identity.actorId ||
      session?.session?.activeOrganizationId !== scope.identity.organizationId
    )
      throw 0;
    if (new URL(page.url()).origin !== input.baseURL) throw 0;
    stage = "fixture-recheck";
    await scope.assertCurrent();
  } catch (error) {
    await context?.close().catch(() => {});
    throw loginError(bootstrapStage(error, stage));
  }
  try {
    protectedUiContexts.set(context, { appId: input.appId, baseURL: input.baseURL });
    stage = "protected-operation";
    await operation({ context, page });
    stage = "fixture-recheck";
    await scope.assertCurrent();
  } catch (error) {
    throw loginError(privateBrowserErrorStage(error) ?? stage);
  } finally {
    protectedUiContexts.delete(context);
    await context.close().catch(() => {});
  }
}

/** Genuine sign-in after UI logout, preserving all caller-owned tabs and cookies. */
export async function signInNormalActorInContext(input) {
  let page;
  let failure;
  let stage = "recording-policy";
  try {
    const testInfo = playwrightTest.info();
    const policy = {
      reporter: testInfo.config.reporter,
      trace: testInfo.project.use.trace,
      video: testInfo.project.use.video,
      screenshot: testInfo.project.use.screenshot,
    };
    assertPrivatePreviewTracePolicy({ ...policy, authorityFile: "local-ui-login" });
    const protectedScope = protectedUiContexts.get(input.context);
    if (
      protectedScope?.appId !== input.appId ||
      protectedScope.baseURL !== input.baseURL ||
      ![undefined, "off"].includes(policy.video) ||
      ![undefined, "off"].includes(policy.screenshot) ||
      typeof input.appId !== "string" ||
      input.appId.length === 0 ||
      input.context.pages().some((existing) => existing.video() !== null)
    )
      throw 0;
    stage = "preview-bootstrap";
    await bootstrapPrivatePreviewContext(input.context, input.baseURL, policy);
    // A successful different actor login is not evidence that the old session
    // was signed out. Observe genuine logout before private credential entry.
    stage = "signed-out-session";
    const signedOut = await input.context.request.get(
      new URL("/api/auth/get-session", input.baseURL).href,
      { maxRedirects: 0 },
    );
    try {
      if (signedOut.status() !== 200 || (await signedOut.json()) !== null) throw 0;
    } finally {
      await signedOut.dispose();
    }
    stage = "fixture-scope";
    page = await input.context.newPage();
    if (page.video() !== null || page.context() !== input.context) throw 0;
    const scope = await readProtectedNormalActorFixture(input);
    const signInPath = input.signInPath ?? defaultSignInPath;
    if (
      !signInPath.startsWith("/") ||
      signInPath.startsWith("//") ||
      new URL(signInPath, input.baseURL).origin !== input.baseURL
    )
      throw 0;
    stage = "auth-ui";
    await page.goto(signInPath);
    await scope.fillLoginFields(page);
    const [response] = await Promise.all([
      page.waitForResponse((candidate) => {
        const url = new URL(candidate.url());
        return (
          url.origin === input.baseURL &&
          url.pathname === "/api/auth/sign-in/email" &&
          candidate.request().method() === "POST"
        );
      }),
      page.locator('form button[type="submit"]').click(),
    ]);
    if (response.status() !== 200) throw 0;
    stage = "auth-session";
    const observed = await input.context.request.get(
      new URL("/api/auth/get-session", input.baseURL).href,
      { maxRedirects: 0 },
    );
    try {
      if (observed.status() !== 200) throw 0;
      const session = await observed.json();
      if (
        session?.user?.id !== scope.identity.actorId ||
        session?.session?.userId !== scope.identity.actorId ||
        session?.session?.activeOrganizationId !== scope.identity.organizationId
      )
        throw 0;
    } finally {
      await observed.dispose();
    }
    if (new URL(page.url()).origin !== input.baseURL) throw 0;
    stage = "fixture-recheck";
    await scope.assertCurrent();
  } catch (error) {
    failure = loginError(bootstrapStage(error, stage));
  } finally {
    try {
      await page?.close();
    } catch {
      failure ??= loginError("context-cleanup");
    }
  }
  if (failure !== undefined) throw failure;
}
