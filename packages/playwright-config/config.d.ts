import type { PlaywrightTestConfig } from "playwright/test";

export function createPlaywrightConfig(
  environment?: Readonly<Record<string, string | undefined>>,
): PlaywrightTestConfig;
