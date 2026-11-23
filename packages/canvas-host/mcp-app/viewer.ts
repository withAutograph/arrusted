// The viewer's permissions over the canvas API, as the frame loads them
// before it mounts the canvas: a refused or missing sign-in returns to the
// sign-in panel; an unreachable server or another failure is an explicit,
// retryable state.
import type { CanvasActionResult } from "../protocol";
import type { FrameSession } from "./client";
import type { CanvasFrameConfig } from "./config";

export type Viewer = { canApprove: boolean; authors: boolean };

/**
 * The viewer's permissions over the canvas API. `signed-out` has already
 * returned the frame to its sign-in panel (a refused or missing sign-in).
 */
export async function loadViewer(
  config: Pick<CanvasFrameConfig, "canvasUrl">,
  session: Pick<FrameSession, "bearer">,
  send: (url: string, init: RequestInit) => Promise<Response> = (url, init) =>
    globalThis.fetch(url, init),
): Promise<
  { kind: "viewer"; viewer: Viewer } | { kind: "signed-out" } | { kind: "failed"; message: string }
> {
  const unreachable = {
    kind: "failed",
    message: "The canvas could not reach its server.",
  } as const;
  let token: string | null;
  try {
    token = await session.bearer.token();
  } catch {
    return unreachable;
  }
  if (token === null) return { kind: "signed-out" };
  let response: Response;
  try {
    response = await send(config.canvasUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ call: "viewer" }),
      credentials: "omit",
    });
  } catch {
    return unreachable;
  }
  if (response.status === 401) {
    session.bearer.refused(token);
    return { kind: "signed-out" };
  }
  const result = (await response.json().catch(() => null)) as CanvasActionResult<Viewer> | null;
  if (result?.ok) return { kind: "viewer", viewer: result.value };
  return { kind: "failed", message: result?.error.message ?? "The canvas could not load." };
}
