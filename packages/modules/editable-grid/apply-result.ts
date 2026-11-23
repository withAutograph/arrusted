export function extractAppliedChangeSetId(value: unknown): number | null {
  if (value && typeof value === "object" && "id" in value) {
    const candidate = (value as { id: unknown }).id;
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  if (value && typeof value === "object" && "change_set" in value) {
    return extractAppliedChangeSetId((value as { change_set: unknown }).change_set);
  }
  return null;
}
