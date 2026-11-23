import { z } from "zod";
import {
  assertAuthDatabaseConnection,
  readAuthDatabaseResource,
  type AuthDatabaseResource,
} from "./database-resource";
import { AuthConfigurationError, readAuthEnvironment, type AuthEnvironmentSource } from "./env";

const localAppAccessSchema = z.strictObject({
  version: z.literal(1),
  workspaceId: z.string().min(1),
  resource: z.unknown(),
});

export type LocalAppAccessBinding = Readonly<{
  version: 1;
  workspaceId: string;
  resource: AuthDatabaseResource;
}>;

/** Local app admission uses the isolated Auth database, never a managed realm. */
export function readLocalAppAccessBinding(
  source: AuthEnvironmentSource = process.env,
): LocalAppAccessBinding | undefined {
  const raw = source.PLATFORM_LOCAL_APP_ACCESS;
  if (raw === undefined) return undefined;
  try {
    if (
      source.PLATFORM_REALM_OPERATOR_LINK_CONFIG !== undefined ||
      source.AUTH_PRODUCTION_DATABASE_IDENTITY !== undefined
    ) {
      throw new Error("mixed Auth binding");
    }
    const binding = localAppAccessSchema.parse(JSON.parse(raw));
    const resource = readAuthDatabaseResource(JSON.stringify(binding.resource));
    if (
      resource === undefined ||
      resource.environment !== "local" ||
      resource.hostname !== "127.0.0.1" ||
      resource.neon !== undefined
    ) {
      throw new Error("nonlocal Auth binding");
    }
    const { databaseUrl } = readAuthEnvironment(source);
    assertAuthDatabaseConnection(databaseUrl, resource, "runtime");
    if (new URL(databaseUrl).searchParams.get("sslmode") !== "disable") {
      throw new Error("nonlocal Auth connection");
    }
    return Object.freeze({ version: 1, workspaceId: binding.workspaceId, resource });
  } catch {
    // Neither malformed nonsecret metadata nor connection errors may echo credentials.
    throw new AuthConfigurationError(["Invalid local app access binding"]);
  }
}
