import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type AppConfig = {
  appId: string;
  organizationId: string;
  name: string;
};

/** Read app identity and display name from compiled artifact or app/schema/app.cue. */
export function readAppConfig(appDir = path.resolve(import.meta.dirname, "..")): AppConfig {
  const artifactPath = path.join(appDir, ".generated/release/app-artifact.json");
  if (existsSync(artifactPath)) {
    try {
      const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
        schema?: { app_id?: string; customer_id?: string };
        client?: { label?: string };
      };
      const appId = artifact.schema?.app_id?.trim();
      const organizationId = artifact.schema?.customer_id?.trim();
      const name = artifact.client?.label?.trim() || appId;
      if (appId && organizationId && name) return { appId, organizationId, name };
    } catch {}
  }
  const cuePath = path.join(appDir, "schema/app.cue");
  if (existsSync(cuePath)) {
    const cue = readFileSync(cuePath, "utf8");
    const pick = (key: string) => new RegExp(`\\b${key}\\s*:\\s*"([^"]+)"`).exec(cue)?.[1]?.trim();
    const appId = pick("app_id");
    const organizationId = pick("customer_id");
    const name = pick("label") || appId;
    if (appId && organizationId && name) return { appId, organizationId, name };
  }
  throw new Error("Could not read app configuration from app/schema/app.cue.");
}
