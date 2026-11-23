import { z } from "zod";

const catalogSchema = z
  .array(z.string().min(1))
  .min(1)
  .refine((ids) => new Set(ids).size === ids.length);

/** Operator-supplied provisioning input; never infer access from deployment layout. */
export function readAuthCatalogAppIds(env: Record<string, string | undefined>): string[] {
  try {
    return catalogSchema.parse(JSON.parse(env.AUTH_CATALOG_APP_IDS ?? "null")).sort();
  } catch {
    throw Object.assign(
      new Error("AUTH_CATALOG_APP_IDS must be a nonempty JSON array of unique app IDs"),
      {
        code: "invalid_catalog_app_ids",
      },
    );
  }
}
