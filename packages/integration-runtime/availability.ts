import { z } from "zod";
import type { IntegrationBinding } from "../contracts/integrations";

// Validate the public DTO without importing private platform policy or runtime setup.
const bindingSchema = z.object({
  id: z.string().min(1),
  connectionId: z.string().min(1),
  appId: z.string().min(1),
  routingId: z.string().min(1),
  lifecycle: z.enum(["pending", "active", "suspending", "removed"]),
  revision: z.number().int().positive(),
}) satisfies z.ZodType<IntegrationBinding>;

export type IntegrationAvailability = Readonly<{
  status: "unavailable" | "not_configured" | "configured";
}>;

export type SupportedIntegrationAvailability = {
  kind: "supported";
  /** The installed authorized reader returns only the current scoped binding, never a provider probe. */
  readBinding: () => Promise<IntegrationBinding | null>;
  /** Use the installed authority error contract; denial must never become an empty binding or an unavailable badge. */
  isAuthorityFailure: (error: unknown) => boolean;
};

/** A status read grants nothing and does not initialize deferred integration infrastructure. */
export async function readIntegrationAvailability(input: {
  /** Recheck current app, tenant and actor authority before and after any awaited read. */
  assertAuthorized: () => Promise<void>;
  implementation?: SupportedIntegrationAvailability | { kind: "deferred" };
}): Promise<IntegrationAvailability> {
  await input.assertAuthorized();
  const implementation = input.implementation;
  if (implementation?.kind !== "supported") return { status: "unavailable" };

  let binding: IntegrationBinding | null;
  try {
    binding = await implementation.readBinding();
  } catch (error) {
    await input.assertAuthorized();
    if (implementation.isAuthorityFailure(error)) throw error;
    return { status: "unavailable" };
  }
  await input.assertAuthorized();
  if (binding === null) return { status: "not_configured" };
  // A retained binding is configuration metadata in every lifecycle, never an activation claim.
  // Malformed adapter output is failed evidence, not configuration or an empty binding.
  return { status: bindingSchema.safeParse(binding).success ? "configured" : "unavailable" };
}
