import type { WorkChange, WorkJson } from "@autograph/generated-app-runtime/data";
import { z } from "zod";

type FieldValue = NonNullable<WorkChange["value"]>;

/**
 * A session thread as `kernel_work_session` stores it (`thread_open`,
 * `thread_reply`, `propose`) and `get` returns it: anchors and proposal
 * changes on a gone record carry `gone`. The anchor is whatever JSON the
 * opener passed.
 */
const targetSchema = z.object({
  model_id: z.string(),
  record_id: z.string(),
  field_id: z.string(),
});
export const threadSchema = z.object({
  id: z.string(),
  anchor: z.custom<WorkJson>(),
  resolved: z.boolean(),
  messages: z.array(
    z.object({
      /** The request id of the reply. */
      id: z.string(),
      actor_id: z.string(),
      author_kind: z.enum(["human", "agent"]),
      message: z.string(),
      created_at: z.string(),
    }),
  ),
  proposal: z
    .object({
      /** The request id of the proposal; a new proposal has a new id. */
      id: z.string(),
      changes: z.array(
        targetSchema.extend({
          value: z.custom<FieldValue | null>(),
          gone: z.enum(["record_gone", "field_archived"]).optional(),
        }),
      ),
      actor_id: z.string(),
      author_principal: z.string(),
      author_kind: z.enum(["human", "agent"]),
      created_at: z.string(),
    })
    .optional(),
});
export type CanvasThread = z.infer<typeof threadSchema>;

/** A session thread of kind `save_request`: the agent's request to Save, not a discussion. */
const isSaveRequest = (thread: unknown) =>
  (thread as { kind?: unknown } | null)?.kind === "save_request";

/**
 * The session's discussion threads (`get` returns them keyed by id), each
 * parsed with the one schema. Save requests are not discussions: see
 * `parseSaveRequest`.
 */
export function parseThreads(threads: Readonly<Record<string, unknown>>): CanvasThread[] {
  return Object.values(threads)
    .filter((thread) => !isSaveRequest(thread))
    .map((thread) => threadSchema.parse(thread));
}

/**
 * The agent's open request to Save (a `save_request` thread): its reason and
 * the session revision it was made at. A later revision means the session
 * changed since the agent asked. There is at most one open request.
 */
const saveRequestSchema = z.object({
  id: z.string(),
  kind: z.literal("save_request"),
  reason: z.string(),
  resolved: z.boolean(),
  revision: z.number().int().positive(),
});
export type CanvasSaveRequest = { id: string; reason: string; revision: number };

/** The open save request among the session's threads, or null. */
export function parseSaveRequest(
  threads: Readonly<Record<string, unknown>>,
): CanvasSaveRequest | null {
  for (const thread of Object.values(threads)) {
    if (!isSaveRequest(thread)) continue;
    const parsed = saveRequestSchema.safeParse(thread);
    if (parsed.success && !parsed.data.resolved)
      return { id: parsed.data.id, reason: parsed.data.reason, revision: parsed.data.revision };
  }
  return null;
}
