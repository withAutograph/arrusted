import type { RecordKey } from "@contracts";

export function serializeRecordKey(key: RecordKey | null | undefined): string {
  return key ? `${key.type}:${key.value}` : "";
}
