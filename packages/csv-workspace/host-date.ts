/** A user-chosen effective date is a run fact; tenant and actor still come from host auth. */
export function csvWorkspaceRequestDate(request: Request): string {
  const value = new URL(request.url).searchParams.get("as_of");
  if (
    !value ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    throw new Error("A valid ISO as_of date is required");
  return value;
}
