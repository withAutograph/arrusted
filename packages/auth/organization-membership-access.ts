import { createHash } from "node:crypto";
import { z } from "zod";

const membershipSchema = z.strictObject({
  id: z.string().min(1),
  actorId: z.string().min(1),
  organizationId: z.string().min(1),
});
export type OrganizationMembership = z.infer<typeof membershipSchema>;
export type OrganizationMembershipLoader = (input: {
  actorId: string;
  organizationIds: readonly string[];
}) => Promise<readonly OrganizationMembership[]>;

/** The protected join creates this ID only for an absent membership and preserves existing IDs. */
export function isAppCreatedOrganizationMembership(membership: OrganizationMembership): boolean {
  return (
    membership.id ===
    createHash("sha256")
      .update(
        JSON.stringify(["managed-membership-v1", membership.organizationId, membership.actorId]),
      )
      .digest("hex")
  );
}

export async function readOrganizationMemberships(
  database: {
    query(text: string, values: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  },
  input: Parameters<OrganizationMembershipLoader>[0],
): ReturnType<OrganizationMembershipLoader> {
  const result = await database.query(
    `select id,"organizationId","userId" as "actorId" from public.member
      where "userId"=$1 and "organizationId"=any($2::text[])`,
    [input.actorId, input.organizationIds],
  );
  return z.array(membershipSchema).parse(result.rows);
}
