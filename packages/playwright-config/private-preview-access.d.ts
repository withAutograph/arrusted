import type { BrowserContext, PlaywrightTestOptions, FullConfig } from "playwright/test";
export interface PrivatePreviewBrowserOptions {
  authorityFile?: string;
  trace?: PlaywrightTestOptions["trace"];
  video?: PlaywrightTestOptions["video"];
  screenshot?: PlaywrightTestOptions["screenshot"];
  reporter?: FullConfig["reporter"];
}
export class PrivatePreviewBrowserAccessError extends Error {
  readonly code: "private-preview-refresh-required";
}
export function bootstrapPrivatePreviewContext(
  context: Pick<BrowserContext, "request" | "cookies">,
  baseURL?: string,
  options?: PrivatePreviewBrowserOptions,
): Promise<void>;
export function assertPrivatePreviewTracePolicy(options?: PrivatePreviewBrowserOptions): void;
