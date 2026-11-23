// ClarificationCard behavior.
//
// A choice is a self-contained answer: clicking it answers immediately. When the
// agent needs data / open-ended input it emits NO choices and offers a free-text
// follow-up instead — choices + free-text is an invalid state, not a supported
// affordance, so the two shapes below are the only ones the card renders.

import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "@testing-library/react";

import { ClarificationCard } from "../ClarificationCard";
import type { ClarificationView } from "../types";

// Set a controlled textarea's value the way the browser would, so React's
// onChange fires (assigning `.value` directly is swallowed by React's controlled
// input). Uses the native prototype setter + a bubbling input event.
function typeInto(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ClarificationCard", () => {
  it("an ordinary choice answers immediately, carrying any typed follow-up", () => {
    const onAnswer = vi.fn();
    const clarification: ClarificationView = {
      headline: "Which roles?",
      choices: [{ id: "eng", label: "Engineering", intent: "primary" }],
      canAskFollowUp: false,
    };
    const { getByRole } = render(
      <ClarificationCard clarification={clarification} onAnswer={onAnswer} />,
    );
    getByRole("button", { name: "Engineering" }).click();
    expect(onAnswer).toHaveBeenCalledWith("eng", "");
  });

  it("free-text only (no choices): Send answers with a null choice, gated on non-empty text", () => {
    const onAnswer = vi.fn();
    const clarification: ClarificationView = {
      headline: "I need the current pay for these roles.",
      choices: [],
      canAskFollowUp: true,
    };
    const { getByRole, getByLabelText } = render(
      <ClarificationCard clarification={clarification} onAnswer={onAnswer} />,
    );

    // The free-text input is present, and Send is disabled until there is text.
    const input = getByLabelText("Add a detail to your answer") as HTMLTextAreaElement;
    const send = getByRole("button", { name: "Send" });
    expect(send.hasAttribute("disabled")).toBe(true);

    // Type an answer: Send enables and submits a null choice id + the text.
    typeInto(input, "Staff SWE is 210k");
    expect(send.hasAttribute("disabled")).toBe(false);
    send.click();
    expect(onAnswer).toHaveBeenCalledWith(null, "Staff SWE is 210k");
  });
});
