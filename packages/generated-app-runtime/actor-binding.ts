import { z } from "zod";
import type { Pool } from "pg";
import { kernelCall } from "../kernel-client/postgres";

const bindingSchema = z.strictObject({
  active: z.boolean(),
  actorId: z.string().min(1),
  appId: z.string().min(1),
  fenceGeneration: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  organizationId: z.string().min(1),
  role: z.string().min(1),
});
export type AppActorBinding = z.infer<typeof bindingSchema>;

/** Read only through this app's restricted runtime principal, never an admin connection. */
export async function readPostgresAppActorBinding(input: {
  actorId: string;
  appId: string;
  organizationId: string;
  pool: Pool;
  role: string;
}): Promise<AppActorBinding | null> {
  const binding = z.nullable(bindingSchema).parse(
    await kernelCall(input.pool, "kernel_read_actor_binding", {
      actor_id: input.actorId,
      app_id: input.appId,
      customer_id: input.organizationId,
      role: input.role,
    }),
  );
  if (
    binding &&
    (binding.actorId !== input.actorId ||
      binding.appId !== input.appId ||
      binding.organizationId !== input.organizationId ||
      binding.role !== input.role)
  )
    throw new Error("Actor binding does not match the requested scope");
  return binding;
}

const accessSchema = bindingSchema.omit({ role: true }).extend({
  fenceGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type AppActorAccess = z.infer<typeof accessSchema>;

/** Explicit app admission, independently read through the restricted app runtime principal. */
export async function readPostgresAppActorAccess(input: {
  actorId: string;
  appId: string;
  organizationId: string;
  pool: Pool;
}): Promise<AppActorAccess | null> {
  const access = z.nullable(accessSchema).parse(
    await kernelCall(input.pool, "kernel_read_actor_access", {
      actor_id: input.actorId,
      app_id: input.appId,
      customer_id: input.organizationId,
    }),
  );
  if (
    access &&
    (access.actorId !== input.actorId ||
      access.appId !== input.appId ||
      access.organizationId !== input.organizationId)
  )
    throw new Error("Actor access does not match the requested scope");
  return access;
}
