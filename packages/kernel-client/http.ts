import type { ActiveSchemaRevision, AppliedChangeSet, VisibleRecord } from "../contracts/index";
import { canonicalDryRunResult, KernelFailure, type CanonicalKernelOperations } from "./postgres";

/** The host supplies authenticated transport; canonical app endpoints retain write authority. */
export function createHttpKernelClient(
  fetch: (path: string, init?: RequestInit) => Promise<Response>,
): CanonicalKernelOperations & { readActiveSchemaRevision(): Promise<ActiveSchemaRevision> } {
  async function call<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(
      path,
      body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
    );
    const data = await response.json();
    if (!response.ok) {
      // Only a canonical negative envelope is definitive. Proxy/transport failures retain Save.
      if (
        response.status < 500 &&
        data &&
        typeof data.code === "string" &&
        typeof data.message === "string"
      )
        throw new KernelFailure(data);
      throw new Error(`Kernel transport failed (${response.status})`);
    }
    return data as T;
  }
  return {
    async readActiveSchemaRevision() {
      const active = await call<ActiveSchemaRevision>("/api/schema/active");
      return { ...active, schema_revision_id: String(active.schema_revision_id) };
    },
    async readVisibleRecords(request) {
      const query = new URLSearchParams({ model_id: request.model_id, as_of: request.as_of });
      const records = await call<VisibleRecord[]>(`/api/records?${query}`);
      const selected = request.record_ids ? new Set(request.record_ids) : null;
      return selected ? records.filter((record) => selected.has(record.record_id)) : records;
    },
    async validateChangeSetDryRun(request) {
      const result = await call<{ change_set: AppliedChangeSet }>(
        "/api/apply?dry_run=true",
        request,
      );
      return canonicalDryRunResult(result.change_set);
    },
    async applyChangeSet(request) {
      const result = await call<{ change_set: AppliedChangeSet }>("/api/apply", request);
      if (!result.change_set) throw new Error("Kernel apply receipt is missing");
      return {
        ...result.change_set,
        schema_revision_id: String(result.change_set.schema_revision_id),
      };
    },
    recentActivity: (request) => call("/api/activity", request),
    changeSetDiff: (request) => call("/api/diff", request),
  };
}
