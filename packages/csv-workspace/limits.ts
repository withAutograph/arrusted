/** One request covers the complete draft; oversized imports are never split into partial Saves. */
export const CSV_WORKSPACE_MAX_REQUEST_BYTES = 3 * 1024 * 1024;

export function workspaceRequestFits(body: unknown): boolean {
  return (
    new TextEncoder().encode(JSON.stringify(body)).byteLength <= CSV_WORKSPACE_MAX_REQUEST_BYTES
  );
}

/** Match the server's context window before transport, not after the body limit. */
export function workspaceConversation(
  messages: readonly { role: "user" | "assistant"; content: string }[],
) {
  return messages
    .slice(-8)
    .map((message) => ({ ...message, content: message.content.slice(0, 4000) }));
}
