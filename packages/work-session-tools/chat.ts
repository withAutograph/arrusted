import type { AgentRuntimeTool } from "@agent-foundation";
import type { DataContext, DataDefinition } from "@autograph/generated-app-runtime/data";
import { createWorkSessionToolCore, type WorkSessionToolId } from "./core";

export const WORK_SESSION_TOOL_GROUP = "work_session";

/** In-app chat: one turn per user message, minted by the host. */
export type WorkSessionChatInput = {
  definition: DataDefinition;
  /** The chat thread's identity. */
  conversationId: string;
  /** The platform agent context for this user message's turn. */
  context: DataContext;
};

/** The same tool core as runtime tools; failures return as tool results. */
export function createWorkSessionChatTools(input: WorkSessionChatInput): AgentRuntimeTool[] {
  const core = createWorkSessionToolCore(input.definition);
  return core.tools.map((spec) => ({
    definition: {
      id: spec.id,
      label: spec.label,
      description: spec.description,
      groupId: WORK_SESSION_TOOL_GROUP,
      capability: spec.capability,
      inputSchema: spec.inputSchema as AgentRuntimeTool["definition"]["inputSchema"],
      outputSchema: { type: "object" },
    },
    execute: async (args, options) =>
      await core.call(spec.id, args, {
        context: input.context,
        conversationId: input.conversationId,
        callId: options?.toolCallId ?? fail(),
      }),
  }));
}

function fail(): never {
  throw new Error("contract_validation_failed: a tool call id is required");
}

/** Generic status labels for the chat status ticker, keyed by tool id. */
export const workSessionToolLabels: Readonly<Record<WorkSessionToolId, string>> =
  Object.fromEntries(
    createWorkSessionToolCore({ formatVersion: 1, schemaVersion: "", models: [] }).tools.map(
      (spec) => [spec.id, spec.label],
    ),
  ) as Record<WorkSessionToolId, string>;
