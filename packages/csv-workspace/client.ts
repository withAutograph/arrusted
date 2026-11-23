import type { KernelClient } from "@contracts";

import type { WorkspaceAgentResult } from "./agent";
import { CSV_WORKSPACE_MAX_REQUEST_BYTES } from "./limits";
import type {
  CsvWorkspaceContext,
  CsvWorkspaceSaveInput,
  CsvWorkspaceSaveResult,
  CsvWorkspaceTurnInput,
} from "./types";

export class CsvWorkspaceRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly outcome: unknown,
  ) {
    super(message);
    this.name = "CsvWorkspaceRequestError";
  }
}

export type CsvWorkspaceClient = KernelClient & {
  loadWorkspace(signal?: AbortSignal): Promise<CsvWorkspaceContext>;
  turn(input: CsvWorkspaceTurnInput, signal?: AbortSignal): Promise<WorkspaceAgentResult>;
  save(input: CsvWorkspaceSaveInput, signal?: AbortSignal): Promise<CsvWorkspaceSaveResult>;
};

export type AuthenticatedCsvWorkspaceClientOptions = {
  accessToken?: string | (() => string | Promise<string>);
  asOf?: string | (() => string);
  baseUrl?: string;
  credentials?: RequestCredentials;
  fetch?: typeof globalThis.fetch;
};

export function createAuthenticatedCsvWorkspaceClient(
  options: AuthenticatedCsvWorkspaceClientOptions,
): CsvWorkspaceClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const url = (path: string, saveDate?: string) => {
    const asOf = saveDate ?? (typeof options.asOf === "function" ? options.asOf() : options.asOf);
    const query =
      asOf === undefined
        ? ""
        : `${path.includes("?") ? "&" : "?"}as_of=${encodeURIComponent(asOf)}`;
    return `${options.baseUrl?.replace(/\/$/u, "") ?? "/api"}${path}${query}`;
  };
  const request = async <T>(
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    saveDate?: string,
  ): Promise<T> => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    if (
      encoded !== undefined &&
      new TextEncoder().encode(encoded).byteLength > CSV_WORKSPACE_MAX_REQUEST_BYTES
    ) {
      throw new CsvWorkspaceRequestError(
        "This request exceeds 3 MiB. Reduce the import before trying again.",
        413,
        path === "/save" ? "not_applied" : undefined,
      );
    }
    const token =
      typeof options.accessToken === "function" ? await options.accessToken() : options.accessToken;
    const response = await fetchImpl(url(path, saveDate), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      credentials: options.credentials ?? "same-origin",
      ...(encoded === undefined ? {} : { body: encoded }),
      signal,
    });
    const data = (await response.json()) as {
      error?: string | { message?: string };
      outcome?: unknown;
    };
    if (!response.ok) {
      throw new CsvWorkspaceRequestError(
        typeof data.error === "string" ? data.error : (data.error?.message ?? "Request failed"),
        response.status,
        data.outcome,
      );
    }
    return data as T;
  };
  return {
    getJson: <T>(path: string) => request<T>(workspacePath(path)),
    postJson: <T>(path: string, body: unknown) => request<T>(workspacePath(path), body),
    loadWorkspace: (signal) => request<CsvWorkspaceContext>("/workspace", undefined, signal),
    turn: (input, signal) => request<WorkspaceAgentResult>("/turn", input, signal),
    save: (input, signal) =>
      request<CsvWorkspaceSaveResult>("/save", input, signal, input.recoveryContext?.asOf),
  };
}

function workspacePath(path: string): string {
  return path === "/api" ? "" : path.startsWith("/api/") ? path.slice(4) : path;
}
