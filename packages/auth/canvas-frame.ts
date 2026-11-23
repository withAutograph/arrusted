/**
 * Where the canvas in a chat runs, and the cross-origin answers it gets.
 *
 * An MCP host renders the canvas resource in a sandboxed frame on its own
 * origin. One configured list, `CANVAS_FRAME_ORIGINS`, holds the frame
 * origins an operator adds (ChatGPT's, for example); Claude's is derived from
 * the exact public MCP endpoint. That list feeds Auth `trustedOrigins` and
 * CORS on exactly the canvas's cross-origin endpoints: the device and token
 * endpoints, and the app's canvas API. CORS here never allows credentials:
 * the frame authenticates by bearer only. Server-only (`node:crypto`).
 */
import { createHash } from "node:crypto";

import { agentResourceIdentifier } from "./agent-grant-policy";

/**
 * Claude's frame domain for an MCP App served by one connector: the first 32
 * hex characters of the SHA-256 of the exact connector URL.
 */
export function claudeFrameDomain(connectorUrl: string): string {
  return `${createHash("sha256").update(connectorUrl).digest("hex").slice(0, 32)}.claudemcpcontent.com`;
}

/** Claude's frame origin for an app's MCP endpoint on this public origin. */
export function claudeFrameOrigin(publicOrigin: string, appId: string): string {
  return `https://${claudeFrameDomain(agentResourceIdentifier(publicOrigin, appId))}`;
}

const isLoopback = (url: URL) => ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);

/**
 * `CANVAS_FRAME_ORIGINS`: exact origins separated by commas or whitespace,
 * each HTTPS (HTTP only on loopback, for local proofs). Anything else is a
 * configuration error, never silently dropped.
 */
export function readCanvasFrameOrigins(
  source: Record<string, string | undefined> = process.env,
): readonly string[] {
  const raw = source.CANVAS_FRAME_ORIGINS?.trim() ?? "";
  if (raw === "") return [];
  return [
    ...new Set(
      raw.split(/[\s,]+/u).map((value) => {
        let url: URL;
        try {
          url = new URL(value);
        } catch {
          throw new Error("CANVAS_FRAME_ORIGINS must list exact origins");
        }
        if (
          url.origin !== value.replace(/\/$/u, "") ||
          !(url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url)))
        )
          throw new Error("CANVAS_FRAME_ORIGINS must list exact HTTPS origins");
        return url.origin;
      }),
    ),
  ];
}

/** The canvas frames' origins: the configured ones and Claude's for each enrolled app. */
export function canvasFrameOrigins(input: {
  publicOrigin: string;
  appIds: readonly string[];
  configured: readonly string[];
}): readonly string[] {
  return [
    ...new Set([
      ...input.configured,
      ...input.appIds.map((appId) => claudeFrameOrigin(input.publicOrigin, appId)),
    ]),
  ];
}

/**
 * CORS headers for a frame origin on the list, or null. Bearer only: no
 * `Access-Control-Allow-Credentials`, so a browser never attaches cookies.
 */
export function canvasCorsHeaders(
  origin: string | null,
  allowed: readonly string[],
): Record<string, string> | null {
  if (origin === null || !allowed.includes(origin)) return null;
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, accept, last-event-id",
    "access-control-expose-headers": "www-authenticate",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

/** `response` with the frame's CORS headers (a copy: fetched responses are immutable). */
export function withCanvasCorsHeaders(
  response: Response,
  origin: string | null,
  allowed: readonly string[],
): Response {
  const cors = canvasCorsHeaders(origin, allowed);
  if (cors === null) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(cors))
    if (name === "vary") headers.append("vary", value);
    else headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Serve `request` with the canvas frame's CORS when its path is one of
 * `paths`: a preflight is answered here without authentication (204 for a
 * listed origin, 403 otherwise), any other method reaches `handle` without
 * cookies and its answer, failures included, carries the CORS headers. Other
 * paths pass through untouched.
 */
export async function withCanvasFrameCors(
  request: Request,
  options: { origins: readonly string[]; paths: readonly string[] },
  handle: (request: Request) => Promise<Response>,
): Promise<Response> {
  const url = new URL(request.url);
  if (!options.paths.includes(url.pathname)) return await handle(request);
  const origin = request.headers.get("origin");
  if (request.method === "OPTIONS") {
    const cors = canvasCorsHeaders(origin, options.origins);
    return new Response(null, {
      status: cors === null ? 403 : 204,
      headers: { ...cors, "cache-control": "no-store" },
    });
  }
  // A frame request carries no session: the bearer or the code is the credential.
  let forwarded = request;
  if (canvasCorsHeaders(origin, options.origins) !== null && request.headers.has("cookie")) {
    const headers = new Headers(request.headers);
    headers.delete("cookie");
    forwarded = new Request(request.url, {
      method: request.method,
      headers,
      ...(request.body === null ? {} : { body: request.body, duplex: "half" }),
    } as RequestInit);
  }
  return withCanvasCorsHeaders(await handle(forwarded), origin, options.origins);
}
