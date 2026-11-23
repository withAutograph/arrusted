// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { StepRailComposition } from "../StepRail";

afterEach(cleanup);

describe("StepRailComposition", () => {
  it("only exposes disclosure behavior for steps with content", () => {
    const { container } = render(
      <StepRailComposition
        spec={{
          type: "step_rail",
          config: {
            steps: [
              { id: "ready", title: "Ready", state: "done" },
              { id: "review", title: "Review", state: "pending", body: "Review details" },
            ],
          },
        }}
      />,
    );

    expect(container.querySelectorAll("details")).toHaveLength(1);
    expect(container.querySelectorAll("[data-disclosure-caret]")).toHaveLength(1);
    expect(screen.getByText("Ready").closest("details")).toBeNull();

    const reviewSummary = screen.getByText("Review").closest("summary");
    expect(reviewSummary).not.toBeNull();
    expect(reviewSummary?.parentElement).not.toHaveAttribute("open");
    fireEvent.click(reviewSummary!);
    expect(reviewSummary?.parentElement).toHaveAttribute("open");
  });
});
