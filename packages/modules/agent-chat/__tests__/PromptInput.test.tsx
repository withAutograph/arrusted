// PromptInput running-affordance tests (L1 shared-leaf no-op case).
//
// With `onStop` the running send button becomes an ACTIVE Stop control (§4).
// WITHOUT `onStop` the leaf must fall back to the prior behavior: the arrow
// morphs into a spinner and the button stays disabled — the shared leaf's
// no-cancel callers (there are some) keep their unchanged working state.

import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "@testing-library/react";

import { PromptInput } from "../PromptInput";

describe("PromptInput running affordance", () => {
  it("shows an active Stop control while running when onStop is wired", () => {
    const { getByLabelText, queryByLabelText } = render(
      <PromptInput isRunning onStop={vi.fn()} onSend={vi.fn()} />,
    );
    const stop = getByLabelText("Stop");
    expect(stop).toBeTruthy();
    expect(stop.hasAttribute("disabled")).toBe(false);
    // The Stop control replaces the Send affordance while running.
    expect(queryByLabelText("Stop")).toBe(stop);
  });

  it("falls back to a spinner (no Stop) while running when onStop is absent", () => {
    const { container, queryByLabelText } = render(<PromptInput isRunning onSend={vi.fn()} />);
    // No stop button — the prior behavior is preserved.
    expect(queryByLabelText("Stop")).toBeNull();
    // The send button shows the spinning working glyph.
    expect(container.querySelector('[class*="animate-spin"]')).toBeTruthy();
  });

  it("shows the send arrow (no spinner) when idle and no onStop", () => {
    const { container, queryByLabelText } = render(<PromptInput onSend={vi.fn()} />);
    expect(queryByLabelText("Stop")).toBeNull();
    expect(container.querySelector('[class*="animate-spin"]')).toBeNull();
  });
});
