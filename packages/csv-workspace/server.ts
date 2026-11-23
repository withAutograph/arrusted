import { KernelFailure } from "../kernel-client/postgres";
import { SaveNotAppliedFailure, WorkspaceInputFailure, type CsvWorkspaceService } from "./service";
import type { CsvWorkspaceSaveInput, CsvWorkspaceTurnInput } from "./types";
import type { WorkspaceDraft } from "./draft";
import { CSV_WORKSPACE_MAX_REQUEST_BYTES } from "./limits";

export {
  createCsvWorkspaceService,
  parseWorkspaceDraft,
  SaveNotAppliedFailure,
  WorkspaceInputFailure,
} from "./service";
export type { CsvWorkspaceService, CsvWorkspaceServiceOptions } from "./service";
export type * from "./types";
export type { WorkspaceDraft, WorkspaceRow, WorkspaceIssue } from "./draft";
export { buildWorkspaceWrites } from "./draft";
export type { ImportIdentityPolicy } from "../engines/import-classification/index";
export type { AgentIdentity, AgentExecutionProfile } from "../agent-foundation/index";
export { WORKSPACE_TOOL_GROUP } from "./agent";
export { createPostgresKernelClient, kernelCall, KernelFailure } from "../kernel-client/postgres";
export type { QueryPort, CanonicalKernelOperations } from "../kernel-client/postgres";

async function body(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw new WorkspaceInputFailure("Expected request body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    request.signal.throwIfAborted();
    const next = await reader.read();
    if (next.done) break;
    size += next.value.length;
    if (size > CSV_WORKSPACE_MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new WorkspaceInputFailure("Request exceeds 3 MiB");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new WorkspaceInputFailure("Expected valid UTF-8 JSON");
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded))
    throw new WorkspaceInputFailure("Expected object");
  return decoded as Record<string, unknown>;
}
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "cache-control": "no-store" } });
export function kernelFailureResponse(error: KernelFailure) {
  return json(
    {
      error: error.envelope,
      ...(error instanceof SaveNotAppliedFailure ? { outcome: "not_applied" } : {}),
    },
    422,
  );
}

/** Call only after host authentication/origin checks; service context is trusted host configuration. */
export function createCsvWorkspaceRequestHandler(
  service: CsvWorkspaceService,
  options: { basePath?: string; onError?: (error: unknown) => void } = {},
) {
  const basePath = (options.basePath ?? "/api").replace(/\/$/, "");
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(`${basePath}/`)) return json({ error: "Route not found" }, 404);
    const path = url.pathname.slice(basePath.length);
    try {
      if (request.method === "GET") {
        if (path === "/workspace") return json(await service.inspect(request.signal));
        if (path === "/schema") return json(service.schema);
        if (path === "/records")
          return json(await service.read(url.searchParams.get("model_id") ?? ""));
        if (path === "/activity") return json(await service.activity());
        if (path === "/diff")
          return json(await service.diff(Number(url.searchParams.get("change_set_id"))));
      }
      if (request.method !== "POST" || !["/turn", "/save", "/dry-run"].includes(path))
        return json({ error: "Route not found" }, 404);
      const input = await body(request);
      if (
        ["app_id", "customer_id", "actor_id", "scope", "asOf", "as_of"].some((key) => key in input)
      )
        throw new WorkspaceInputFailure("Scope, actor and as-of are frozen by this host");
      if (path === "/dry-run")
        return json({
          issues: await service.dryRun(input.draft as WorkspaceDraft, request.signal),
        });
      if (path === "/save")
        return json(await service.save(input as CsvWorkspaceSaveInput, request.signal));
      return json(await service.turn(input as CsvWorkspaceTurnInput, request.signal));
    } catch (error) {
      if (error instanceof KernelFailure) return kernelFailureResponse(error);
      options.onError?.(error);
      return json(
        {
          error:
            error instanceof WorkspaceInputFailure
              ? error.message
              : "Request failed validation or execution",
          ...(path === "/save" && error instanceof WorkspaceInputFailure
            ? { outcome: "not_applied" }
            : {}),
        },
        error instanceof WorkspaceInputFailure ? 400 : 500,
      );
    }
  };
}

export { createHttpKernelClient } from "../kernel-client/http";
export { csvWorkspaceRequestDate } from "./host-date";
