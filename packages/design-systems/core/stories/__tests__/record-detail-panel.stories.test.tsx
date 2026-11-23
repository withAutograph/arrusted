// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { EditableFixture } from "../record-detail-panel.fixture";

afterEach(cleanup);

describe("Record detail editable story", () => {
  it("discards canceled drafts and persists saved drafts", () => {
    render(<EditableFixture />);

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByDisplayValue("Item Alpha"), {
      target: { value: "Canceled rename" },
    });
    expect(screen.getByText("Previous: Item Alpha")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Revert Name" }));
    expect(screen.getByDisplayValue("Item Alpha")).toBeVisible();
    fireEvent.change(screen.getByDisplayValue("Item Alpha"), {
      target: { value: "Canceled rename" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Canceled rename")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByDisplayValue("Item Alpha"), {
      target: { value: "Saved rename" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(screen.getByText("Saved rename")).toBeVisible();
  });
});
