import privatePreviewReporterPath from "./private-preview-reporter-path.cjs";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import diagnostics from "./private-browser-diagnostics.cjs";

const { previewDiagnosticMessage } = diagnostics;

export class PrivatePreviewBrowserAccessError extends Error {
  constructor() {
    super(previewDiagnosticMessage);
    this.name = "PrivatePreviewBrowserAccessError";
    this.code = "private-preview-refresh-required";
  }
}
const off = (trace) =>
  trace === undefined ||
  trace === "off" ||
  (typeof trace === "object" && trace !== null && trace.mode === "off");

export function assertPrivatePreviewTracePolicy(options = {}) {
  const file = options.authorityFile ?? process.env.APP_TEST_PREVIEW_AUTHORITY_FILE;
  if (!file) return;
  const reporters = options.reporter;
  const expected = privatePreviewReporterPath;
  if (
    !off(options.trace) ||
    !off(options.video) ||
    !off(options.screenshot) ||
    !Array.isArray(reporters) ||
    reporters.length !== 1 ||
    !Array.isArray(reporters[0]) ||
    reporters[0][0] !== expected
  )
    throw new PrivatePreviewBrowserAccessError();
}

/** Exchange the real owner launch authority in this exact browser jar; never synthesize a cookie. */
export async function bootstrapPrivatePreviewContext(context, baseURL, options = {}) {
  const file = options.authorityFile ?? process.env.APP_TEST_PREVIEW_AUTHORITY_FILE;
  if (!file) return;
  assertPrivatePreviewTracePolicy(options);
  let descriptor;
  try {
    descriptor = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await descriptor.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > 4096 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw 0;
    const authority = JSON.parse(await descriptor.readFile("utf8"));
    const launch = new URL(authority.launchUrl);
    if (
      authority.version !== 1 ||
      authority.kind !== "private-preview-browser-access" ||
      authority.origin !== baseURL ||
      launch.origin !== baseURL ||
      launch.protocol !== "https:" ||
      launch.username ||
      launch.password ||
      launch.hash ||
      launch.pathname !== "/__autograph_preview_launch" ||
      launch.searchParams.size !== 1 ||
      launch.searchParams.getAll("token").length !== 1 ||
      !launch.searchParams.get("token") ||
      !Number.isFinite(Date.parse(authority.expiresAt)) ||
      Date.parse(authority.expiresAt) <= Date.now()
    )
      throw 0;
    const response = await context.request.get(launch.href, {
      maxRedirects: 0,
      failOnStatusCode: false,
    });
    try {
      const location = response.headers().location;
      if (
        response.status() !== 303 ||
        !location ||
        new URL(location, launch.origin).origin !== launch.origin ||
        Date.parse(authority.expiresAt) <= Date.now()
      )
        throw 0;
      const cookies = await context.cookies(launch.origin);
      if (
        !cookies.some(
          (cookie) =>
            cookie.name === "__Host-autograph-preview" &&
            cookie.domain === launch.hostname &&
            cookie.path === "/" &&
            cookie.secure &&
            cookie.httpOnly,
        )
      )
        throw 0;
    } finally {
      await response.dispose();
    }
  } catch {
    throw new PrivatePreviewBrowserAccessError();
  } finally {
    await descriptor?.close().catch(() => {});
  }
}
