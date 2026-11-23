// Internal runtime bridge for the primitive-backed leaves.
//
// assistant-ui's ThreadPrimitive / MessagePrimitive / ComposerPrimitive read
// from a runtime context. Phase-1 leaves are PRESENTATIONAL (data in via
// props, no backend/LLM), so we feed a thin external-store runtime built from
// the caller's `ChatMessageView[]` + an `onSend` callback.
//
// This keeps runtime coupling view-only (spec §6 guardrail): the runtime here
// is a display adapter over static props, NOT a source of truth and NOT a
// lifecycle. The live surface (PR E) swaps this for a real external store fed
// by `useAgentChatSession`; the leaves are unchanged because they only ever
// read the runtime.

import type { ReactNode } from "react";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type TextMessagePart,
  type ThreadMessageLike,
  type ToolCallMessagePart,
} from "@assistant-ui/react";

import type { ChatMessageView, MessagePartView } from "./types";

function partToThreadPart(part: MessagePartView): TextMessagePart | ToolCallMessagePart {
  if (part.kind === "text") {
    return { type: "text", text: part.text };
  }
  // The tool part carries our humanized view through `result`; the custom
  // tool renderer (ToolCallRow) reads it back. args stays empty — the module
  // never round-trips raw tool args.
  return {
    type: "tool-call",
    toolCallId: part.tool.id,
    toolName: "agent_tool",
    args: {},
    argsText: "",
    result: part.tool,
  };
}

function convertMessage(message: ChatMessageView): ThreadMessageLike {
  const content: ThreadMessageLike["content"] = message.parts.map(partToThreadPart);
  return {
    id: message.id,
    role: message.role === "human" ? "user" : "assistant",
    content,
  };
}

export type ChatRuntimeProviderProps = {
  messages: readonly ChatMessageView[];
  /** Called with the composed text when the human sends. */
  onSend?: (text: string) => void;
  /** True while the agent is producing a turn (drives the composer state). */
  isRunning?: boolean;
  children: ReactNode;
};

export function ChatRuntimeProvider(props: ChatRuntimeProviderProps) {
  const { messages, onSend, isRunning, children } = props;
  const runtime = useExternalStoreRuntime({
    isRunning: isRunning ?? false,
    messages: messages as ChatMessageView[],
    convertMessage,
    onNew: async (message) => {
      const first = message.content[0];
      if (first?.type === "text") onSend?.(first.text);
    },
  });
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}
