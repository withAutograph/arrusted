import { createHash } from "node:crypto";

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

/** Both supported encodings bind the complete plan before any worker projection. */
export function readApprovedAuthOperatorPlan(
  bytes: Buffer,
  approvedDigest: string,
): { plan: unknown; planDigest: string } {
  const plan: unknown = JSON.parse(bytes.toString("utf8"));
  if (sha256(bytes) !== approvedDigest && sha256(canonical(plan)) !== approvedDigest)
    throw new Error("auth_operator_plan_mismatch");
  // The supplied approval remains the fencing and replay identity, whichever encoding matched.
  return { plan, planDigest: approvedDigest };
}
