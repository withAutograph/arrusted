// Mount-motion gating (GAP 2): the chat-in entrance animation must play only
// for GENUINELY NEW turns, never replay across a whole-history remount.
//
// `MessageThread` captures the message count at first mount as the "new message
// boundary"; only turns at or beyond that index animate. History renders
// instantly, so reopening the panel (a remount with full history) does not
// flash every bubble in at once.

import { describe, expect, it } from "vite-plus/test";
import { render, waitFor } from "@testing-library/react";

import { MessageThread } from "../Message";
import type { ChatMessageView } from "../types";

const history: readonly ChatMessageView[] = [
  { id: "u1", role: "human", parts: [{ kind: "text", text: "First question" }] },
  { id: "a1", role: "agent", parts: [{ kind: "text", text: "First answer" }] },
];

// The class marker the mount animation attaches (see Message.tsx CHAT_IN).
const animatedCount = (root: HTMLElement): number =>
  root.querySelectorAll('[class*="chat-in"]').length;

// The AgentAvatar sparkle mark renders as an aria-hidden span (see
// AgentAvatar.tsx). Both an agent turn and the ThinkingIndicator render one, so
// counting these spans catches the duplicate-sparkle regression directly.
const avatarCount = (root: HTMLElement): number =>
  root.querySelectorAll('span[aria-hidden="true"]').length;

describe("AgentMessage avatar ownership (duplicate-sparkle guard)", () => {
  it("renders exactly ONE avatar in the pre-first-token window (empty agent shell + running)", async () => {
    // The empty agent shell (no prose, no tool, no ticker) + isRunning is the
    // pre-first-token state the ThinkingIndicator owns. AgentMessage must render
    // NOTHING here, so only the indicator's single avatar is in the tree — not
    // two stacked sparkles.
    const emptyShell: readonly ChatMessageView[] = [
      { id: "u1", role: "human", parts: [{ kind: "text", text: "Bump Engineering." }] },
      { id: "a1", role: "agent", parts: [{ kind: "text", text: "" }] },
    ];
    const { container, findByRole } = render(<MessageThread messages={emptyShell} isRunning />);
    // The thinking indicator is present (it owns this state)…
    await findByRole("status");
    // …and it is the SOLE avatar — the empty shell contributed none.
    await waitFor(() => expect(avatarCount(container)).toBe(1));
  });

  it("still renders an avatar for a non-empty agent turn (no-op case)", async () => {
    const withProse: readonly ChatMessageView[] = [
      { id: "u1", role: "human", parts: [{ kind: "text", text: "Bump Engineering." }] },
      { id: "a1", role: "agent", parts: [{ kind: "text", text: "Done." }] },
    ];
    const { container, findByText } = render(<MessageThread messages={withProse} isRunning />);
    await findByText("Done.");
    // One agent turn with content → exactly one avatar, no thinking indicator.
    await waitFor(() => expect(avatarCount(container)).toBe(1));
  });

  it("still renders an avatar for a settled agent turn (no-op case)", async () => {
    const settled: readonly ChatMessageView[] = [
      { id: "u1", role: "human", parts: [{ kind: "text", text: "Bump Engineering." }] },
      { id: "a1", role: "agent", parts: [{ kind: "text", text: "Drafted a bump." }] },
    ];
    const { container, findByText } = render(<MessageThread messages={settled} />);
    await findByText("Drafted a bump.");
    await waitFor(() => expect(avatarCount(container)).toBe(1));
  });
});

describe("MessageThread mount motion", () => {
  it("does not animate any pre-existing turn on mount (remount replay guard)", () => {
    const { container } = render(<MessageThread messages={history} />);
    // Two history turns present, zero animating — a remount would look identical.
    expect(animatedCount(container)).toBe(0);
  });

  it("animates only turns appended after the initial mount", async () => {
    const { container, findByText, rerender } = render(<MessageThread messages={history} />);
    expect(animatedCount(container)).toBe(0);

    const withNewTurn: readonly ChatMessageView[] = [
      ...history,
      { id: "u2", role: "human", parts: [{ kind: "text", text: "A brand new turn" }] },
    ];
    rerender(<MessageThread messages={withNewTurn} />);
    // The external-store runtime flushes the appended turn asynchronously.
    await findByText("A brand new turn");

    // Exactly the newly-appended turn animates; the two history turns stay put.
    await waitFor(() => expect(animatedCount(container)).toBe(1));
  });
});
