import "server-only";
import path from "node:path";
import { Pool } from "pg";
import { createSingleOrganizationAuth } from "@autograph/auth/single-organization";
import { canvasFrameOrigins, readCanvasFrameOrigins } from "@autograph/auth/canvas-frame";
import { readAppConfig } from "../../scripts/app-config";

const config = readAppConfig(path.resolve(process.cwd()));
export const appId = config.appId;
export const organizationId = config.organizationId;
export const appName = config.name;

export function requiredEnv(name: string, fallback?: string) {
  const value = process.env[name] ?? (fallback ? process.env[fallback] : undefined);
  if (!value) throw new Error(`Configure ${name} before starting the app.`);
  return value;
}
/** An idle connection closed by the database (Neon suspending) must not crash the server. */
export function reportIdleErrors(pool: Pool) {
  pool.on("error", (error: Error & { code?: string }) => {
    console.error("Idle database connection closed", error.code ?? error.name);
  });
  return pool;
}
let instance: ReturnType<typeof createSingleOrganizationAuth> | undefined;
export function getIdentity() {
  return (instance ??= createSingleOrganizationAuth({
    database: reportIdleErrors(
      new Pool({
        connectionString: requiredEnv("AUTH_DATABASE_URL", "APP_DATABASE_URL"),
        max: 5,
        connectionTimeoutMillis: 5000,
      }),
    ),
    origin: requiredEnv("BETTER_AUTH_URL"),
    secret: requiredEnv("BETTER_AUTH_SECRET"),
    appId,
    organizationId,
    name: appName,
    ownerSetupHash: process.env.APP_OWNER_SETUP_HASH,
    allowSignUp: process.env.APP_ALLOW_SIGN_UP === "true",
  }));
}
export function frameOrigins() {
  return canvasFrameOrigins({
    publicOrigin: requiredEnv("BETTER_AUTH_URL"),
    appIds: [appId],
    configured: readCanvasFrameOrigins(),
  });
}
