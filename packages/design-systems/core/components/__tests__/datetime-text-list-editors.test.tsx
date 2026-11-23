import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vite-plus/test";

import { DatetimeEditor, parseDatetimeText } from "../editors/datetime-editor";
import type { EditorContext } from "../editors/protocol";
import { splitTextListText, TextListEditor } from "../editors/text-list-editor";

function context(type: string, label: string): EditorContext {
  return {
    rowKey: { type: "record_id", value: "r-1" },
    fieldId: "f",
    fieldType: { type, label, required: false },
  };
}

describe("parseDatetimeText", () => {
  it("normalizes date-times to the kernel's UTC form", () => {
    expect(parseDatetimeText("2026-05-04T12:00:00Z")).toBe("2026-05-04T12:00:00Z");
    expect(parseDatetimeText("2026-05-04 09:15")).toBe("2026-05-04T09:15:00Z");
    expect(parseDatetimeText(" 2026-05-04T09:15:30 UTC ")).toBe("2026-05-04T09:15:30Z");
    expect(parseDatetimeText("2026-05-04T09:15:00+02:00")).toBe("2026-05-04T07:15:00Z");
    expect(parseDatetimeText("2026-05-04T23:30:00-0130")).toBe("2026-05-05T01:00:00Z");
    expect(parseDatetimeText("2026-05-04T09:15:00.250Z")).toBe("2026-05-04T09:15:00.250Z");
  });

  it("keeps fractional seconds exactly as written", () => {
    expect(parseDatetimeText("2026-05-04T12:00:00.123456Z")).toBe("2026-05-04T12:00:00.123456Z");
    expect(parseDatetimeText("2026-05-04T12:00:00.999999+02:00")).toBe(
      "2026-05-04T10:00:00.999999Z",
    );
  });

  it("reads two-digit years as written, not as 19xx", () => {
    expect(parseDatetimeText("0050-03-01 10:00")).toBe("0050-03-01T10:00:00Z");
    expect(parseDatetimeText("0001-01-01T00:00:00Z")).toBe("0001-01-01T00:00:00Z");
    expect(parseDatetimeText("0000-01-01T00:00:00Z")).toBeNull();
  });

  it("rejects bare dates and impossible values", () => {
    expect(parseDatetimeText("2026-05-04")).toBeNull();
    expect(parseDatetimeText("2026-02-30 10:00")).toBeNull();
    expect(parseDatetimeText("2026-05-04 24:00")).toBeNull();
    expect(parseDatetimeText("next tuesday")).toBeNull();
  });
});

describe("DatetimeEditor", () => {
  const ctx = context("datetime", "Seen");

  function mount(stored: string | undefined, onClear?: () => void) {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    const onDraftChange = vi.fn();
    render(
      <DatetimeEditor.Component
        initialValue={DatetimeEditor.parse(
          stored ? { type: "datetime", value: stored } : undefined,
          ctx,
        )}
        context={ctx}
        onCommit={onCommit}
        onCancel={onCancel}
        onDraftChange={onDraftChange}
        onClear={onClear}
      />,
    );
    return {
      onCommit,
      onCancel,
      onDraftChange,
      time: screen.getByLabelText("Seen time (UTC)"),
    };
  }

  it("commits a changed time on Enter as a UTC datetime", () => {
    const { onCommit, time } = mount("2026-05-04T12:00:00Z");
    fireEvent.change(time, { target: { value: "14:30" } });
    fireEvent.keyDown(time, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(DatetimeEditor.serialize(onCommit.mock.calls[0]![0], ctx)).toEqual({
      type: "datetime",
      value: "2026-05-04T14:30:00Z",
    });
  });

  it("commits a picked day with the stored time and seconds", async () => {
    const { onCommit } = mount("2026-05-04T12:00:45Z");
    await userEvent.click(screen.getByRole("button", { name: /May 15/u }));
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(DatetimeEditor.serialize(onCommit.mock.calls[0]![0], ctx).value).toBe(
      "2026-05-15T12:00:45Z",
    );
  });

  it("keeps sub-millisecond seconds through a date-only edit", async () => {
    const { onCommit, onDraftChange } = mount("2026-05-04T12:00:00.123456Z");
    await userEvent.click(screen.getByRole("button", { name: /May 15/u }));
    expect(DatetimeEditor.serialize(onDraftChange.mock.lastCall![0], ctx).value).toBe(
      "2026-05-15T12:00:00.123456Z",
    );
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(DatetimeEditor.serialize(onCommit.mock.calls[0]![0], ctx).value).toBe(
      "2026-05-15T12:00:00.123456Z",
    );
  });

  it("keeps the editor open with an error when a changed value has no time", async () => {
    const { onCommit, onCancel, time } = mount("2026-05-04T12:00:00Z");
    await userEvent.click(screen.getByRole("button", { name: /May 15/u }));
    fireEvent.change(time, { target: { value: "" } });
    fireEvent.keyDown(time, { key: "Enter" });
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe("Enter a time.");
    fireEvent.change(time, { target: { value: "09:30" } });
    fireEvent.keyDown(time, { key: "Enter" });
    expect(DatetimeEditor.serialize(onCommit.mock.calls[0]![0], ctx).value).toBe(
      "2026-05-15T09:30:00Z",
    );
  });

  it("asks for a date when only the time of an empty value changed", async () => {
    const { onCommit, onCancel, time } = mount(undefined);
    fireEvent.change(time, { target: { value: "09:30" } });
    fireEvent.keyDown(time, { key: "Enter" });
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe("Pick a date.");
    await userEvent.click(screen.getAllByRole("button", { name: /\b15th\b/u })[0]!);
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.keyDown(time, { key: "Enter" });
    expect(DatetimeEditor.serialize(onCommit.mock.calls[0]![0], ctx).value).toMatch(
      /^\d{4}-\d{2}-15T09:30:00Z$/u,
    );
  });

  it("reaches Clear by keyboard without closing the editor", async () => {
    const onClear = vi.fn();
    const { onCommit, onCancel } = mount("2026-05-04T12:00:00Z", onClear);
    const clear = screen.getByRole("button", { name: "Clear" });
    act(() => clear.focus());
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    await userEvent.keyboard("{Enter}");
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("cancels when nothing changed", () => {
    const unchanged = mount("2026-05-04T12:00:00Z");
    fireEvent.keyDown(unchanged.time, { key: "Enter" });
    expect(unchanged.onCommit).not.toHaveBeenCalled();
    expect(unchanged.onCancel).toHaveBeenCalledTimes(1);
  });

  it("cancels on Escape", () => {
    const { onCommit, onCancel, time } = mount("2026-05-04T12:00:00Z");
    fireEvent.change(time, { target: { value: "14:30" } });
    fireEvent.keyDown(time, { key: "Escape" });
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("disables Done until a date is picked", () => {
    mount(undefined);
    expect(screen.getByRole("button", { name: "Done" })).toBeDisabled();
  });
});

describe("TextListEditor", () => {
  const ctx = context("text_list", "Tags");

  function mount(items: string[], onClear?: () => void) {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    render(
      <TextListEditor.Component
        initialValue={TextListEditor.parse({ type: "text_list", value: items }, ctx)}
        context={ctx}
        onCommit={onCommit}
        onCancel={onCancel}
        onClear={onClear}
      />,
    );
    return { onCommit, onCancel, input: screen.getByRole("textbox", { name: "Add to Tags" }) };
  }

  it("adds items on Enter, removes them, and commits on Enter in an empty input", async () => {
    const { onCommit, input } = mount(["outdoor", "priority"]);
    await userEvent.click(screen.getByRole("button", { name: "Remove outdoor" }));
    await userEvent.type(input, "north{Enter}");
    expect(onCommit).not.toHaveBeenCalled();
    await userEvent.keyboard("{Enter}");
    expect(onCommit).toHaveBeenCalledWith(["priority", "north"]);
  });

  it("keeps typed text when Done is pressed and ignores duplicates", async () => {
    const { onCommit, input } = mount(["outdoor"]);
    await userEvent.type(input, "outdoor{Enter}late");
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onCommit).toHaveBeenCalledWith(["outdoor", "late"]);
  });

  it("removes the last item with Backspace and commits an empty list", async () => {
    const { onCommit, input } = mount(["outdoor"]);
    await userEvent.click(input);
    await userEvent.keyboard("{Backspace}{Enter}");
    expect(onCommit).toHaveBeenCalledWith([]);
  });

  it("cancels when unchanged", async () => {
    const unchanged = mount(["outdoor"]);
    await userEvent.click(unchanged.input);
    await userEvent.keyboard("{Enter}");
    expect(unchanged.onCommit).not.toHaveBeenCalled();
    expect(unchanged.onCancel).toHaveBeenCalledTimes(1);
  });

  it("splits pasted text on commas and line breaks, keeping the first of repeats", () => {
    expect(splitTextListText(" a, b\nc\r\n,, a,b ")).toEqual(["a", "b", "c"]);
    expect(splitTextListText("  ")).toEqual([]);
  });

  it("adds a list pasted into the input as items, without repeats", async () => {
    const { onCommit, input } = mount(["outdoor"]);
    await userEvent.click(input);
    await userEvent.paste("north, outdoor\nsouth, north");
    expect((input as HTMLInputElement).value).toBe("");
    await userEvent.keyboard("{Enter}");
    expect(onCommit).toHaveBeenCalledWith(["outdoor", "north", "south"]);
  });

  it("pastes a list at the cursor, over any selection, before splitting it", async () => {
    const { onCommit, input } = mount([]);
    await userEvent.type(input, "west");
    await userEvent.paste("ern, north");
    await userEvent.type(input, "drop");
    (input as HTMLInputElement).setSelectionRange(0, 4);
    await userEvent.paste("south,");
    await userEvent.keyboard("{Enter}{Enter}");
    expect(onCommit).toHaveBeenCalledWith(["western", "north", "south"]);
  });

  it("offers Clear when the host can clear", async () => {
    const onClear = vi.fn();
    const { onCommit } = mount(["outdoor"], onClear);
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });
});
