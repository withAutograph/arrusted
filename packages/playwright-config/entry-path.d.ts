export function resolveAppBrowserEntryPath(
  routes: readonly string[],
  declared?: unknown,
  ownsPath?: (path: string) => boolean,
): string | undefined;
export function appTestPath(
  appRelativePath?: string,
  environment?: Readonly<Record<string, string | undefined>>,
): string;
