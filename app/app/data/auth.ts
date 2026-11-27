import "server-only";
import { ResilientPool } from "./pool";
import { createSingleOrganizationAuth } from "@autograph/auth/single-organization";
import { canvasFrameOrigins, readCanvasFrameOrigins } from "@autograph/auth/canvas-frame";

export const appId = "starter";
export const organizationId = "starter";
export function requiredEnv(name: string, fallback?: string) {
  const value = process.env[name] ?? (fallback ? process.env[fallback] : undefined);
  if (!value) throw new Error(`Configure ${name} before starting the app.`);
  return value;
}
let instance: ReturnType<typeof createSingleOrganizationAuth> | undefined;
export function getIdentity() {
  const authSchema = process.env.AUTH_SCHEMA?.trim() || undefined;
  return (instance ??= createSingleOrganizationAuth({
    database: new ResilientPool({
      connectionString: requiredEnv("AUTH_DATABASE_URL", "APP_DATABASE_URL"),
      ...(authSchema ? { searchPath: authSchema } : {}),
      max: 5,
    }),
    ...(authSchema ? { authSchema } : {}),
    origin: requiredEnv("BETTER_AUTH_URL"),
    secret: requiredEnv("BETTER_AUTH_SECRET"),
    appId,
    organizationId,
    name: "Starter",
    allowSignUp: process.env.APP_ALLOW_SIGN_UP !== "false",
  }));
}
export function frameOrigins() {
  return canvasFrameOrigins({
    publicOrigin: requiredEnv("BETTER_AUTH_URL"),
    appIds: [appId],
    configured: readCanvasFrameOrigins(),
  });
}
