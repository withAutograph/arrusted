const MIN_STANDALONE_SECRET_LEN = 9;

const SECRET_ENV_NAME =
  /(?:^|_)(?:DATABASE_URL|POSTGRES_URL|PGURI|PGPASSWORD|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|LICENSE_KEY|ACCESS_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|VERCEL_TOKEN)$/i;

const DB_URL_ENV_NAME = /(?:^|_)(?:DATABASE_URL|POSTGRES_URL|PGURI)$/i;

/** Preserve diagnostics, never serialize database detail/rows or arbitrary error objects. */
export function redact(
  message: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const secrets = new Set<string>();
  const addStandalone = (candidate: string | undefined) => {
    if (candidate && candidate.length >= MIN_STANDALONE_SECRET_LEN) secrets.add(candidate);
  };
  for (const [name, value] of Object.entries(env)) {
    if (!value || !SECRET_ENV_NAME.test(name)) continue;
    addStandalone(value);
    if (DB_URL_ENV_NAME.test(name)) {
      try {
        const url = new URL(value);
        const dbName = url.pathname.replace(/^\/+/, "");
        if (url.password) {
          for (const candidate of [
            url.password,
            (() => {
              try {
                return decodeURIComponent(url.password);
              } catch {
                return url.password;
              }
            })(),
          ]) {
            if (candidate !== url.username && candidate !== dbName) addStandalone(candidate);
          }
        }
      } catch {
        // Libpq keyword/value connection string (e.g. host=... password=...)
        const kvPass = /\bpassword\s*=\s*(?:'((?:\\'|[^'])*)'|"((?:\\"|[^"])*)"|([^\s]+))/i.exec(
          value,
        );
        const extracted = kvPass?.[1] ?? kvPass?.[2] ?? kvPass?.[3];
        if (extracted) addStandalone(extracted);
      }
    }
  }
  let text = message;
  for (const value of [...secrets].sort((a, b) => b.length - a.length))
    text = text.replaceAll(value, "[REDACTED]");
  return text
    .replace(
      /([a-z][a-z0-9+.-]*:\/\/)[^\s/@"'`<>]+:[^\s"'`<>]*@(?=[^\s@/"'`<>]+)/gi,
      "$1[REDACTED]@",
    )
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/"'`<>]+@/gi, "$1[REDACTED]@")
    .replace(
      /\b(password\s*=\s*)(?:'(?:\\'|[^'])*'|"(?:\\"|[^"])*"|[^\s&;,)"'`<>]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/([#&?]token=)[^\s&"'<>]+/gi, "$1[REDACTED]")
    .replace(/\b(Bearer\s+)[^\s"'`]+/gi, "$1[REDACTED]");
}

/** Extract only error code and message (never pg detail/rows or arbitrary object fields). */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    const prefix = typeof code === "string" && code.length > 0 ? `${code}: ` : "";
    return `${prefix}${error.message}`;
  }
  if (error && typeof error === "object") {
    const maybe = error as { code?: unknown; message?: unknown };
    if (typeof maybe.message === "string" && maybe.message.length > 0) {
      const prefix =
        typeof maybe.code === "string" && maybe.code.length > 0 ? `${maybe.code}: ` : "";
      return `${prefix}${maybe.message}`;
    }
  }
  return typeof error === "string" ? error : "Unknown error";
}
