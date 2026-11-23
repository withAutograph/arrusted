import { describe, expect, it } from "vitest";
import {
  CSV_WORKSPACE_MAX_REQUEST_BYTES,
  workspaceConversation,
  workspaceRequestFits,
} from "../limits";

describe("workspace request bounds", () => {
  it("accepts exactly the serialized UTF-8 limit and rejects one byte more", () => {
    const overhead = new TextEncoder().encode(JSON.stringify({ text: "" })).byteLength;
    const text = "é".repeat((CSV_WORKSPACE_MAX_REQUEST_BYTES - overhead - 1) / 2);
    expect(workspaceRequestFits({ text: text + "x" })).toBe(true);
    expect(workspaceRequestFits({ text: text + "xx" })).toBe(false);
  });
  it("counts JSON escaping and keeps only the existing bounded conversation window", () => {
    expect(
      workspaceRequestFits({ text: "\u0000".repeat(CSV_WORKSPACE_MAX_REQUEST_BYTES / 6) }),
    ).toBe(false);
    const messages = Array.from({ length: 10 }, (_, index) => ({
      role: "user" as const,
      content: String(index) + "x".repeat(5000),
    }));
    const bounded = workspaceConversation(messages);
    expect(bounded).toHaveLength(8);
    expect(bounded[0]!.content[0]).toBe("2");
    expect(bounded.every((message) => message.content.length === 4000)).toBe(true);
    expect(messages[0]!.content).toHaveLength(5001);
  });
});
