const canonicalEntry = (value) =>
  typeof value === "string" &&
  value.startsWith("/") &&
  !value.startsWith("//") &&
  !/[\p{Cc}:%*?#\\]/u.test(value) &&
  new URL(value, "https://app.invalid").pathname === value;

/** The caller may prove concrete dynamic routes with the actual official catalog matcher. */
export function resolveAppBrowserEntryPath(routes, declared, ownsPath) {
  const literals = [...new Set(routes.filter(canonicalEntry))];
  const selected =
    declared === undefined ? (literals.length === 1 ? literals[0] : undefined) : declared;
  if (!canonicalEntry(selected)) return undefined;
  if (ownsPath !== undefined) {
    try {
      return ownsPath(selected) ? selected : undefined;
    } catch {
      return undefined;
    }
  }
  return literals.includes(selected) ? selected : undefined;
}

/** Preserve the exact Auth origin; navigation is a separate app-owned path. */
export function appTestPath(appRelativePath = "/", environment = process.env) {
  const entry = environment.APP_TEST_ENTRY_PATH;
  if (entry === undefined) return appRelativePath;
  if (
    !canonicalEntry(entry) ||
    !appRelativePath.startsWith("/") ||
    appRelativePath.startsWith("//") ||
    /[\p{Cc}\\]/u.test(appRelativePath)
  ) {
    throw new Error("App browser entry path is invalid");
  }
  const relative = new URL(appRelativePath, "https://app.invalid");
  const withoutQuery = appRelativePath.split(/[?#]/u)[0];
  if (relative.origin !== "https://app.invalid" || relative.pathname !== withoutQuery)
    throw new Error("App-relative browser path is not canonical");
  return appRelativePath === "/" ? entry : `${entry.replace(/\/$/u, "")}${appRelativePath}`;
}
