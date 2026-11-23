/** Sanitized, provider-neutral operational receipt for a Vercel Service. */
export type VercelOperationalEnvironmentSource = Readonly<Record<string, string | undefined>>;

export type VercelOperationalEvent = {
  schemaVersion: 1;
  event: "vercel_operational_event";
  severity: "info" | "warning" | "error" | "critical";
  project: string;
  service: string;
  environment: "preview" | "production";
  category: string;
  failureClass: string;
  deploymentId?: string;
  sourceSha?: string;
  routeCategory?: string;
  requestId?: string;
  status?: number;
  durationMs?: number;
};

export const VERCEL_OPERATIONAL_EVENT_KEYS = [
  "schemaVersion",
  "event",
  "severity",
  "project",
  "service",
  "environment",
  "category",
  "failureClass",
  "deploymentId",
  "sourceSha",
  "routeCategory",
  "requestId",
  "status",
  "durationMs",
] as const satisfies readonly (keyof VercelOperationalEvent)[];

const ALLOWED_KEYS = new Set<string>(VERCEL_OPERATIONAL_EVENT_KEYS);
const IDENTIFIER = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const DEPLOYMENT_ID = /^dpl_[A-Za-z0-9]{1,96}$/u;
const SOURCE_SHA = /^[0-9a-f]{40}$/iu;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function serializeVercelOperationalEvent(input: VercelOperationalEvent): string {
  const source = input as unknown as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (!ALLOWED_KEYS.has(key))
      throw new Error(`Vercel operational event field is not allowlisted: ${key}`);
  }
  const receipt: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of VERCEL_OPERATIONAL_EVENT_KEYS) {
    const value = source[key];
    if (value !== undefined) receipt[key] = value;
  }
  if (receipt.schemaVersion !== 1 || receipt.event !== "vercel_operational_event")
    throw new Error("Vercel operational event identity is invalid");
  requireOneOf(receipt.severity, ["info", "warning", "error", "critical"], "severity");
  requireOneOf(receipt.environment, ["preview", "production"], "environment");
  for (const field of ["project", "service", "category", "failureClass"] as const)
    requireIdentifier(receipt[field], field);
  if (receipt.routeCategory !== undefined)
    requireIdentifier(receipt.routeCategory, "routeCategory");
  if (
    receipt.deploymentId !== undefined &&
    (typeof receipt.deploymentId !== "string" || !DEPLOYMENT_ID.test(receipt.deploymentId))
  )
    throw new Error("Vercel operational event deploymentId is invalid");
  if (
    receipt.sourceSha !== undefined &&
    (typeof receipt.sourceSha !== "string" || !SOURCE_SHA.test(receipt.sourceSha))
  )
    throw new Error("Vercel operational event sourceSha is invalid");
  if (
    receipt.requestId !== undefined &&
    (typeof receipt.requestId !== "string" || !REQUEST_ID.test(receipt.requestId))
  )
    throw new Error("Vercel operational event requestId is invalid");
  if (
    receipt.status !== undefined &&
    (!Number.isInteger(receipt.status) ||
      Number(receipt.status) < 100 ||
      Number(receipt.status) > 599)
  )
    throw new Error("Vercel operational event status is invalid");
  if (
    receipt.durationMs !== undefined &&
    (!Number.isInteger(receipt.durationMs) || Number(receipt.durationMs) < 0)
  )
    throw new Error("Vercel operational event durationMs is invalid");
  return JSON.stringify(receipt);
}

export function vercelOperationalEnvironment(
  environment: VercelOperationalEnvironmentSource = process.env,
): "preview" | "production" {
  return environment.VERCEL_ENV === "production" ? "production" : "preview";
}

export function vercelOperationalDeploymentContext(
  environment: VercelOperationalEnvironmentSource = process.env,
): Pick<VercelOperationalEvent, "deploymentId" | "sourceSha"> {
  const context: Pick<VercelOperationalEvent, "deploymentId" | "sourceSha"> = {};
  if (environment.VERCEL_DEPLOYMENT_ID && DEPLOYMENT_ID.test(environment.VERCEL_DEPLOYMENT_ID))
    context.deploymentId = environment.VERCEL_DEPLOYMENT_ID;
  if (environment.VERCEL_GIT_COMMIT_SHA && SOURCE_SHA.test(environment.VERCEL_GIT_COMMIT_SHA))
    context.sourceSha = environment.VERCEL_GIT_COMMIT_SHA;
  return context;
}

export function vercelRouteCategoryForApplication(name: string): string {
  if (name.length > 64 || !IDENTIFIER.test(name))
    throw new Error("Vercel operational route category is invalid");
  return name;
}

function requireIdentifier(value: unknown, field: string): void {
  if (typeof value !== "string" || !IDENTIFIER.test(value))
    throw new Error(`Vercel operational event ${field} is invalid`);
}

function requireOneOf(value: unknown, values: readonly string[], field: string): void {
  if (typeof value !== "string" || !values.includes(value))
    throw new Error(`Vercel operational event ${field} is invalid`);
}
