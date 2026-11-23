import type { DataContext } from "@autograph/generated-app-runtime/data";
import type { NormalActorSelector } from "./normal-actors.js";

export class NormalActorReadbackError extends Error {
  readonly code:
    | "runtime_unavailable"
    | "actor_not_authorized"
    | "scope_closed"
    | "release_unavailable"
    | "readback_unavailable";
  constructor(code: NormalActorReadbackError["code"]);
}

/** No credential, pool or record value is returned; assertions execute in process under current fixture authority. */
export function withNormalActorReadback(
  input: { appId: string; selector: NormalActorSelector; baseURL?: string; appRoot?: string },
  readback: (context: DataContext) => Promise<void>,
): Promise<void>;
