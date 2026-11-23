// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { compositionRegistry } from "../registry";
import { RecordDetailPanel, type RecordDetailSpec } from "../RecordDetailPanel";
import { validateRecordDetailSpec } from "../RecordDetailPanel.validation";

afterEach(cleanup);

const spec: RecordDetailSpec = {
  title: "Item Alpha",
  status: { label: "Enabled", tone: "success" },
  sections: [
    {
      id: "overview",
      title: "Overview",
      items: [
        {
          type: "field",
          id: "name",
          label: "Name",
          value: "Item Alpha",
          control: "text",
          required: true,
        },
        { type: "field", id: "count", label: "Count", value: 2, control: "number" },
        {
          type: "field",
          id: "enabled",
          label: "Enabled",
          value: true,
          control: "checkbox",
          required: true,
        },
        {
          type: "table",
          id: "related",
          ariaLabel: "Related values",
          columns: [{ id: "label", label: "Label", align: "center" }],
          rows: [{ label: "Item Beta" }],
        },
      ],
    },
  ],
};

describe("RecordDetailPanel", () => {
  it("separates long primary labels from values without changing vertical spacing", () => {
    render(
      <RecordDetailPanel
        title="Result"
        labelEmphasis="primary"
        sections={[
          {
            id: "result",
            title: "Calculation",
            items: [
              {
                type: "field",
                id: "quantity",
                label: "Modeled replenishment quantity",
                value: "72 units",
              },
            ],
          },
        ]}
      />,
    );
    const label = screen.getByText("Modeled replenishment quantity");
    expect(label.closest("dt")?.parentElement).toHaveClass(
      "gap-[var(--space-1)]",
      "@sm/record-detail:gap-x-[var(--space-4)]",
      "@sm/record-detail:gap-y-[var(--space-0)]",
    );
    expect(screen.getByText("72 units")).toBeInTheDocument();
  });

  it("preserves field selection and values with primary label emphasis", () => {
    const onFieldSelect = vi.fn();
    const { rerender } = render(
      <RecordDetailPanel {...spec} labelEmphasis="primary" onFieldSelect={onFieldSelect} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Count" }));
    expect(screen.getByRole("button", { name: "Count" }).closest("dt")).toHaveClass(
      "text-[length:var(--text-body)]",
      "leading-[var(--leading-body)]",
      "text-[var(--color-text-primary)]",
    );
    expect(onFieldSelect).toHaveBeenCalledWith("count");
    expect(screen.getByText("2", { exact: true })).toBeInTheDocument();
    rerender(<RecordDetailPanel {...spec} labelEmphasis="secondary" />);
    expect(screen.getByText("Count", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("Count", { exact: true }).closest("dt")).toHaveClass(
      "text-[length:var(--text-caption)]",
      "leading-[var(--leading-caption)]",
      "text-[var(--color-text-muted)]",
    );
    expect(screen.getByText("2", { exact: true })).toBeInTheDocument();
  });

  it("renders the canonical flat-section surface", () => {
    const { container } = render(<RecordDetailPanel {...spec} />);
    expect(container.querySelector('[data-appearance="flat"]')).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Item Alpha" })).toBeInTheDocument();
    expect(screen.getByText("Overview")).toBeInTheDocument();
  });

  it("keeps contextual notes out of landmarks and makes the scroll body keyboard-focusable", () => {
    const noteSpec: RecordDetailSpec = {
      ...spec,
      sections: [
        ...spec.sections,
        {
          id: "context",
          title: "Context",
          collapsible: false,
          items: [{ type: "note", id: "note", body: "Check this value.", tone: "info" }],
        },
      ],
    };
    render(
      <aside aria-label="Selected record">
        <RecordDetailPanel {...noteSpec} />
      </aside>,
    );

    expect(screen.getAllByRole("complementary")).toHaveLength(1);
    const scrollBody = screen.getByRole("region", { name: "Item Alpha" });
    expect(scrollBody).toHaveClass("overflow-y-auto");
    expect(scrollBody).toHaveClass("focus-visible:ring-inset");
    scrollBody.focus();
    expect(scrollBody).toHaveFocus();
  });

  it("keeps actions in the default footer and supports a single header action group", () => {
    const onAction = vi.fn();
    const { container, rerender } = render(
      <RecordDetailPanel
        {...spec}
        actions={[{ id: "save", label: "Save", intent: "primary" }]}
        onAction={onAction}
      />,
    );

    expect(container.querySelector("footer")).toBeInTheDocument();

    rerender(
      <RecordDetailPanel
        {...spec}
        actionsPlacement="header"
        actions={[{ id: "save", label: "Save", intent: "primary" }]}
        onAction={onAction}
      />,
    );
    expect(container.querySelector("footer")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Save" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Save" }).parentElement).toHaveClass(
      "mt-[var(--space-2)]",
      "justify-end",
    );
    expect(container.querySelector("header")).toHaveClass(
      "px-[var(--space-6)]",
      "py-[var(--space-4)]",
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onAction).toHaveBeenCalledWith("save");
  });

  it("uses readable label typography for read-only detail fields", () => {
    render(<RecordDetailPanel {...spec} />);
    expect(screen.getByText("Name").closest("dt")).toHaveClass(
      "text-[length:var(--text-caption)]",
      "font-[var(--font-weight-semibold)]",
      "text-[var(--color-text-muted)]",
    );
  });

  it("keeps read-only fields inline by default and supports stacked full-width values", () => {
    render(
      <RecordDetailPanel
        title="Item Alpha"
        sections={[
          {
            id: "overview",
            title: "Overview",
            items: [
              { type: "field", id: "short", label: "Short", value: "Short value" },
              {
                type: "field",
                id: "explanation",
                label: "Explanation",
                value: "A long explanatory value uses the full available width.",
                layout: "stacked",
              },
            ],
          },
        ]}
      />,
    );

    expect(screen.getByText("Short").closest("dt")?.parentElement).toHaveClass(
      "@sm/record-detail:grid-cols-[var(--size-record-detail-label-column)_minmax(var(--size-detail-value-column),1fr)]",
    );
    expect(screen.getByText("Explanation").closest("dt")?.parentElement).toHaveClass(
      "@sm/record-detail:grid-cols-1",
    );
    expect(screen.getByText("Explanation").closest("dt")?.parentElement).not.toHaveClass(
      "@sm/record-detail:gap-y-[var(--space-0)]",
    );

    const defaultLayout = validateRecordDetailSpec({
      title: "Item",
      sections: [{ id: "one", title: "One", items: [{ type: "field", id: "x", label: "X" }] }],
    });
    const stackedLayout = validateRecordDetailSpec({
      title: "Item",
      sections: [
        {
          id: "one",
          title: "One",
          items: [{ type: "field", id: "x", label: "X", layout: "stacked" }],
        },
      ],
    });
    expect(defaultLayout.sections[0]?.items[0]).not.toHaveProperty("layout");
    expect(stackedLayout.sections[0]?.items[0]).toMatchObject({ layout: "stacked" });
    expect(() =>
      validateRecordDetailSpec({
        title: "Item",
        sections: [
          {
            id: "one",
            title: "One",
            items: [{ type: "field", id: "x", label: "X", layout: "wide" }],
          },
        ],
      }),
    ).toThrow("record_detail.sections[0].items[0].layout must be inline or stacked");
  });

  it("renders controlled tabs and emits opaque tab ids", () => {
    const onTabChange = vi.fn();
    render(
      <RecordDetailPanel
        {...spec}
        tabs={[
          { id: "summary", label: "Summary" },
          { id: "activity", label: "Activity" },
        ]}
        activeTabId="summary"
        onTabChange={onTabChange}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Activity" }));
    expect(onTabChange).toHaveBeenCalledWith("activity");
  });

  it("renders labeled values and collapsible sections without app semantics", () => {
    render(<RecordDetailPanel {...spec} />);
    expect(screen.getByRole("heading", { name: "Item Alpha" })).toBeVisible();
    expect(screen.getByText("Overview")).toBeVisible();
    expect(screen.getByText("Count")).toBeVisible();
    expect(screen.getByText("2")).toBeVisible();
    expect(screen.getByText("Yes")).toBeVisible();
    expect(screen.getByRole("table", { name: "Related values" })).toBeVisible();
    expect(screen.queryByText("Related values")).not.toBeInTheDocument();
    const nameTerm = screen.getByText("Name").closest("dt");
    expect(nameTerm?.parentElement?.querySelector("dd")).toHaveTextContent("Item Alpha");
  });

  it("emits each collapsible section's open state", () => {
    const onOpenChange = vi.fn();
    render(
      <RecordDetailPanel
        title="Item Alpha"
        sections={[
          {
            id: "overview",
            title: "Overview",
            defaultOpen: false,
            onOpenChange,
            items: [],
          },
        ]}
      />,
    );

    const details = screen.getByText("Overview").closest("details");
    expect(details).not.toBeNull();
    details!.open = true;
    fireEvent(details!, new Event("toggle", { bubbles: true }));
    details!.open = false;
    fireEvent(details!, new Event("toggle", { bubbles: true }));

    expect(onOpenChange).toHaveBeenNthCalledWith(1, true);
    expect(onOpenChange).toHaveBeenNthCalledWith(2, false);
  });

  it("emits opaque field ids from selectable read labels", () => {
    const onFieldSelect = vi.fn();
    render(<RecordDetailPanel {...spec} onFieldSelect={onFieldSelect} />);

    fireEvent.click(screen.getByRole("button", { name: "Name" }));

    expect(onFieldSelect).toHaveBeenCalledWith("name");
  });

  it("keeps intrinsically wide tables inside a local horizontal scroll region", () => {
    render(<RecordDetailPanel {...spec} />);
    const table = screen.getByRole("table", { name: "Related values" });
    expect(table).toHaveClass("min-w-max");
    expect(table.parentElement).toHaveClass("overflow-x-auto");
  });

  it("applies each column alignment to both its header and body cells", () => {
    render(<RecordDetailPanel {...spec} />);
    expect(screen.getByRole("columnheader", { name: "Label" })).toHaveStyle({
      textAlign: "center",
    });
    expect(screen.getByRole("cell", { name: "Item Beta" })).toHaveStyle({ textAlign: "center" });
  });

  it("emits controlled field values and action ids", () => {
    const onValueChange = vi.fn();
    const onAction = vi.fn();
    render(
      <RecordDetailPanel
        {...spec}
        mode="edit"
        errors={{ name: "Name is required" }}
        onValueChange={onValueChange}
        actions={[{ id: "save", label: "Save", intent: "primary" }]}
        onAction={onAction}
      />,
    );

    fireEvent.change(screen.getByDisplayValue("Item Alpha"), { target: { value: "Item Beta" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Count" }), {
      target: { value: "4" },
    });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onValueChange).toHaveBeenCalledWith("name", "Item Beta");
    expect(onValueChange).toHaveBeenCalledWith("count", 4);
    expect(onValueChange).toHaveBeenCalledWith("enabled", false);
    expect(onAction).toHaveBeenCalledWith("save");
    expect(screen.getByRole("textbox", { name: /Name/ })).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("textbox", { name: /Name/ })).toBeRequired();
    expect(screen.getByRole("checkbox", { name: /Enabled/ })).toBeRequired();
    expect(screen.getByText("Name is required")).toHaveAttribute("id");
  });

  it("renders an opt-in strong primary detail action", () => {
    render(
      <RecordDetailPanel
        {...spec}
        actions={[{ id: "save", label: "Save", intent: "primary-strong" }]}
        onAction={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: "Save" })).toHaveClass(
      "bg-[var(--color-action-primary-ink)]",
    );
  });

  it("emits optional header edit and close actions", () => {
    const onEdit = vi.fn();
    const onClose = vi.fn();
    render(<RecordDetailPanel {...spec} onEdit={onEdit} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));

    expect(onEdit).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows and emits field-level revert controls for changed draft values", () => {
    const onRevertField = vi.fn();
    render(
      <RecordDetailPanel
        {...spec}
        mode="edit"
        values={{ name: "Item Beta", count: 3 }}
        originalValues={{ name: "Item Alpha", count: 2 }}
        onValueChange={() => {}}
        onRevertField={onRevertField}
      />,
    );

    expect(screen.getByText("Previous: Item Alpha")).toBeVisible();
    expect(screen.getByRole("button", { name: "Revert Name" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Revert Count" })).toBeVisible();
    const dirtyDescriptionId = screen
      .getByRole("textbox", { name: /Name/ })
      .getAttribute("aria-describedby");
    expect(document.getElementById(dirtyDescriptionId ?? "")).toHaveTextContent(
      "Previous: Item Alpha",
    );
    fireEvent.click(screen.getByRole("button", { name: "Revert Name" }));
    expect(onRevertField).toHaveBeenCalledWith("name", "Item Alpha");
  });

  it("keeps dirty and revert affordances around host-rendered editors", () => {
    const onRevertField = vi.fn();
    render(
      <RecordDetailPanel
        {...spec}
        mode="edit"
        values={{ name: "Item Beta" }}
        originalValues={{ name: "Item Alpha" }}
        onValueChange={() => {}}
        onRevertField={onRevertField}
        renderEditor={({ field }) =>
          field.id === "name" ? <div role="textbox">Custom editor</div> : undefined
        }
      />,
    );

    expect(screen.getByText("Custom editor")).toBeVisible();
    expect(screen.getByText("Previous: Item Alpha")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Revert Name" }));
    expect(onRevertField).toHaveBeenCalledWith("name", "Item Alpha");
  });

  it("tells host-rendered editors when changes cannot be emitted", () => {
    const disabledStates: boolean[] = [];
    const renderEditor = ({ disabled }: { disabled: boolean }) => {
      disabledStates.push(disabled);
      return <div role="textbox">Custom editor</div>;
    };
    const { rerender } = render(
      <RecordDetailPanel {...spec} mode="edit" renderEditor={renderEditor} />,
    );
    expect(disabledStates).toContain(true);
    rerender(
      <RecordDetailPanel
        {...spec}
        mode="edit"
        onValueChange={() => {}}
        renderEditor={renderEditor}
      />,
    );
    expect(disabledStates).toContain(false);
  });

  it("supports host renderers without adding them to the serializable spec", () => {
    render(
      <RecordDetailPanel
        {...spec}
        renderValue={(field, value) =>
          field.id === "name" ? <a href="/records/item-alpha">{String(value)}</a> : undefined
        }
      />,
    );
    expect(screen.getByRole("link", { name: "Item Alpha" })).toHaveAttribute(
      "href",
      "/records/item-alpha",
    );
  });

  it("lets a host renderer intentionally suppress a read value with null", () => {
    render(
      <RecordDetailPanel
        {...spec}
        renderValue={(field) => (field.id === "name" ? null : undefined)}
      />,
    );
    const nameTerm = screen.getByText("Name").closest("dt");
    expect(nameTerm?.parentElement?.querySelector("dd")).toBeEmptyDOMElement();
  });

  it("disables built-in editors when no change callback can receive edits", () => {
    render(<RecordDetailPanel {...spec} mode="edit" />);
    expect(screen.getByRole("textbox", { name: /Name/ })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Count" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /Enabled/ })).toBeDisabled();
  });

  it("preserves an intentional controlled null instead of restoring the spec value", () => {
    render(<RecordDetailPanel {...spec} mode="edit" values={{ name: null }} />);
    expect(screen.getByRole("textbox", { name: /Name/ })).toHaveValue("");
    expect(screen.queryByRole("button", { name: /Revert Name/ })).not.toBeInTheDocument();
  });

  it("does not infer dirty state for fields omitted from a partial original snapshot", () => {
    render(
      <RecordDetailPanel
        {...spec}
        mode="edit"
        values={{ name: "Item Beta" }}
        originalValues={{}}
        onValueChange={() => {}}
        onRevertField={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: /Revert Name/ })).not.toBeInTheDocument();
  });

  it("lets optional selects clear to null while required selects retain a placeholder", () => {
    const onValueChange = vi.fn();
    const selectSpec: RecordDetailSpec = {
      title: "Selects",
      sections: [
        {
          id: "fields",
          title: "Fields",
          items: [
            {
              type: "field",
              id: "optional-choice",
              label: "Optional choice",
              value: "one",
              control: "select",
              options: [{ value: "one", label: "One" }],
            },
            {
              type: "field",
              id: "required-choice",
              label: "Required choice",
              value: null,
              control: "select",
              required: true,
              options: [{ value: "one", label: "One" }],
            },
          ],
        },
      ],
    };
    render(
      <RecordDetailPanel
        {...selectSpec}
        mode="edit"
        emptyValueLabel="Choose one"
        onValueChange={onValueChange}
      />,
    );

    fireEvent.change(screen.getByRole("combobox", { name: "Optional choice" }), {
      target: { value: "" },
    });
    expect(onValueChange).toHaveBeenCalledWith("optional-choice", null);
    expect(
      screen.getByRole("combobox", { name: /Required choice/ }).querySelector('option[value=""]'),
    ).toBeDisabled();
  });

  it("preserves invalid number drafts and emits only empty or valid parsed values", () => {
    const onValueChange = vi.fn();
    render(<RecordDetailPanel {...spec} mode="edit" onValueChange={onValueChange} />);
    const count = screen.getByRole("textbox", { name: "Count" });

    fireEvent.change(count, { target: { value: "1e" } });
    expect(count).toHaveValue("1e");
    expect(onValueChange).not.toHaveBeenCalledWith("count", expect.anything());
    fireEvent.change(count, { target: { value: "1.5" } });
    expect(onValueChange).toHaveBeenCalledWith("count", 1.5);
    fireEvent.change(count, { target: { value: "" } });
    expect(onValueChange).toHaveBeenCalledWith("count", null);
  });

  it("uses the configured empty label for previous null values", () => {
    render(
      <RecordDetailPanel
        {...spec}
        mode="edit"
        emptyValueLabel="—"
        values={{ name: "Item Beta" }}
        originalValues={{ name: null }}
        onValueChange={() => {}}
        onRevertField={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Revert Name" }).parentElement).toHaveTextContent(
      "Previous: —",
    );
  });
});

describe("RecordDetailPanel read-mode change cues", () => {
  it("shows what a changed value was, and nothing for unchanged or unlisted fields", () => {
    render(
      <RecordDetailPanel
        {...spec}
        mode="read"
        values={{ name: "Item Beta", count: 2 }}
        originalValues={{ name: "Item Alpha", count: 2 }}
      />,
    );
    const name = document.querySelector("[data-field-id='name']")!;
    expect(name).toHaveTextContent("Item Betawas Item Alpha");
    expect(name.querySelector("[data-previous-value]")).toHaveTextContent("was Item Alpha");
    expect(document.querySelector("[data-field-id='count'] [data-previous-value]")).toBeNull();
    expect(document.querySelector("[data-field-id='enabled'] [data-previous-value]")).toBeNull();
  });

  it("labels the previous value with the host's formatter and shows host field notes", () => {
    render(
      <RecordDetailPanel
        {...spec}
        mode="read"
        values={{ name: "Item Beta" }}
        originalValues={{ name: null }}
        emptyValueLabel="—"
        fieldNotes={{ name: <span data-note>by Group A</span>, count: "in Segment 1" }}
        previousValueLabel={(field, value) => `${field.label}: ${value ?? "empty"}`}
      />,
    );
    expect(document.querySelector("[data-field-id='name']")).toHaveTextContent(
      "Item Betaby Group Awas Name: empty",
    );
    // A note alone, with no change.
    const count = document.querySelector("[data-field-id='count']")!;
    expect(count).toHaveTextContent("2in Segment 1");
    expect(count.querySelector("[data-previous-value]")).toBeNull();
  });

  it("compares by value, so an equal rebuilt value shows no change", () => {
    // Hosts may hand structured values through at runtime; the same value in a
    // new object, with keys in another order, is not a change.
    const amount = { amount: "10", currency: "EUR" } as unknown as string;
    const same = { currency: "EUR", amount: "10" } as unknown as string;
    const other = { amount: "12", currency: "EUR" } as unknown as string;
    render(
      <RecordDetailPanel
        {...spec}
        mode="read"
        values={{ name: amount, count: other }}
        originalValues={{ name: same, count: amount }}
        renderValue={() => "value"}
        previousValueLabel={() => "before"}
      />,
    );
    expect(document.querySelector("[data-field-id='name'] [data-previous-value]")).toBeNull();
    expect(
      document.querySelector("[data-field-id='count'] [data-previous-value]"),
    ).toHaveTextContent("was before");
  });

  it("keeps edit mode's previous-value notice instead of the read cue", () => {
    render(
      <RecordDetailPanel
        {...spec}
        mode="edit"
        values={{ name: "Item Beta" }}
        originalValues={{ name: "Item Alpha" }}
        onValueChange={vi.fn()}
        onRevertField={vi.fn()}
      />,
    );
    expect(screen.getByText("Previous: Item Alpha")).toBeVisible();
    expect(document.querySelector("[data-previous-value]")).toBeNull();
  });

  it("does not mark an edit field dirty when a rebuilt value equals its original", () => {
    render(
      <RecordDetailPanel
        {...spec}
        mode="edit"
        values={{ name: "Item Alpha", count: { amount: "2" } as never }}
        originalValues={{ name: "Item Alpha", count: { amount: "2" } as never }}
        onValueChange={vi.fn()}
        onRevertField={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /^Revert/ })).toBeNull();
  });
});

describe("record_detail composition spec", () => {
  it("validates agent-safe tabs and requires the active id to match", () => {
    const validated = validateRecordDetailSpec({
      ...spec,
      tabs: [
        { id: "summary", label: "Summary" },
        { id: "activity", label: "Activity" },
      ],
      activeTabId: "activity",
    });
    expect(validated.activeTabId).toBe("activity");
    expect(() =>
      validateRecordDetailSpec({
        ...spec,
        tabs: [{ id: "summary", label: "Summary" }],
        activeTabId: "missing",
      }),
    ).toThrow("activeTabId must match a configured tab");
  });

  it("validates and renders the supported agent-safe vocabulary", () => {
    const validated = validateRecordDetailSpec({
      ...spec,
      sections: [
        ...spec.sections,
        {
          id: "related",
          title: "Related",
          items: [
            {
              type: "table",
              id: "table",
              columns: [{ id: "label", label: "Label" }],
              rows: [{ label: "Item Beta" }],
            },
            { type: "note", id: "note", body: "Check this value.", tone: "info" },
          ],
        },
      ],
    });
    expect(validated.sections).toHaveLength(2);
    expect(() =>
      compositionRegistry.render({ type: "record_detail", config: validated }, "agent"),
    ).not.toThrow();
  });

  it("rejects unknown blocks, non-serializable values, and invalid select options", () => {
    expect(() => validateRecordDetailSpec({ ...spec, emptyValueLable: "—" })).toThrow(
      "record_detail.config.emptyValueLable is not supported",
    );
    expect(() =>
      validateRecordDetailSpec({
        title: "Item",
        sections: [{ id: "one", title: "One", items: [{ type: "custom", id: "x" }] }],
      }),
    ).toThrow("type must be field, table, or note");
    expect(() =>
      validateRecordDetailSpec({
        title: "Item",
        sections: [
          {
            id: "one",
            title: "One",
            items: [{ type: "field", id: "x", label: "X", value: { unsafe: true } }],
          },
        ],
      }),
    ).toThrow("finite serializable value");
    expect(() =>
      validateRecordDetailSpec({
        title: "Item",
        sections: [
          {
            id: "one",
            title: "One",
            items: [{ type: "field", id: "x", label: "X", control: "select", options: [] }],
          },
        ],
      }),
    ).toThrow("options must not be empty");
  });

  it("rejects section subtitles and visual table titles", () => {
    expect(() =>
      validateRecordDetailSpec({
        title: "Item",
        sections: [{ id: "one", title: "One", description: "Subtitle", items: [] }],
      }),
    ).toThrow("record_detail.sections[0].description is not supported");
    expect(() =>
      validateRecordDetailSpec({
        title: "Item",
        sections: [{ id: "one", title: "One", onOpenChange: vi.fn(), items: [] }],
      }),
    ).toThrow("record_detail.sections[0].onOpenChange is not supported");
    expect(() =>
      validateRecordDetailSpec({
        title: "Item",
        sections: [
          {
            id: "one",
            title: "One",
            items: [{ type: "table", id: "table", label: "Title", columns: [], rows: [] }],
          },
        ],
      }),
    ).toThrow("record_detail.sections[0].items[0].label is not supported");
  });

  it("rejects values that do not match their declared controls", () => {
    const withField = (field: Record<string, unknown>) => ({
      title: "Item",
      sections: [
        {
          id: "one",
          title: "One",
          items: [{ type: "field", id: "x", label: "X", ...field }],
        },
      ],
    });
    expect(() =>
      validateRecordDetailSpec(withField({ control: "checkbox", value: "false" })),
    ).toThrow("must be a boolean for a checkbox control");
    expect(() => validateRecordDetailSpec(withField({ control: "number", value: "12" }))).toThrow(
      "must be a number for a number control",
    );
    expect(() =>
      validateRecordDetailSpec(
        withField({
          control: "select",
          value: "missing",
          options: [{ value: "present", label: "Present" }],
        }),
      ),
    ).toThrow("must match an option for a select control");
  });

  it("rejects present invalid optional values instead of applying defaults", () => {
    expect(() =>
      validateRecordDetailSpec({ title: "Item", emptyValueLabel: false, sections: [] }),
    ).toThrow("record_detail.emptyValueLabel must be a non-empty string");
    expect(() =>
      validateRecordDetailSpec({
        title: "Item",
        sections: [{ id: "one", title: "One", collapsible: "false", items: [] }],
      }),
    ).toThrow("record_detail.sections[0].collapsible must be a boolean");
    expect(() =>
      validateRecordDetailSpec({
        title: "Item",
        sections: [
          {
            id: "one",
            title: "One",
            items: [{ type: "field", id: "x", label: "X", disabled: "true" }],
          },
        ],
      }),
    ).toThrow("record_detail.sections[0].items[0].disabled must be a boolean");
  });

  it("rejects repeated section and item identities", () => {
    expect(() =>
      validateRecordDetailSpec({
        title: "Item",
        sections: [
          { id: "duplicate", title: "One", items: [] },
          { id: "duplicate", title: "Two", items: [] },
        ],
      }),
    ).toThrow("record_detail.sections ids must be unique: duplicate");
    expect(() =>
      validateRecordDetailSpec({
        title: "Item",
        sections: [
          {
            id: "one",
            title: "One",
            items: [{ type: "field", id: "duplicate", label: "One" }],
          },
          {
            id: "two",
            title: "Two",
            items: [{ type: "field", id: "duplicate", label: "Two" }],
          },
        ],
      }),
    ).toThrow("record_detail section items ids must be unique: duplicate");
  });

  it("rejects duplicate identities in nested select and table vocabularies", () => {
    expect(() =>
      validateRecordDetailSpec({
        title: "Item",
        sections: [
          {
            id: "one",
            title: "One",
            items: [
              {
                type: "field",
                id: "choice",
                label: "Choice",
                control: "select",
                options: [
                  { value: "same", label: "One" },
                  { value: "same", label: "Two" },
                ],
              },
            ],
          },
        ],
      }),
    ).toThrow("options values must be unique: same");
    expect(() =>
      validateRecordDetailSpec({
        title: "Item",
        sections: [
          {
            id: "one",
            title: "One",
            items: [
              {
                type: "table",
                id: "table",
                columns: [
                  { id: "same", label: "One" },
                  { id: "same", label: "Two" },
                ],
                rows: [],
              },
            ],
          },
        ],
      }),
    ).toThrow("data_table.columns ids must be unique: same");
  });
});

describe("RecordDetailPanel embedded", () => {
  const sections = [
    {
      id: "details",
      title: "Details",
      collapsible: false,
      hideTitle: true,
      items: [{ type: "field" as const, id: "budget", label: "Budget" }],
    },
  ];

  it("renders only its fields inside a host that names the record", () => {
    render(
      <RecordDetailPanel
        embedded
        title="Customer portal"
        sections={sections}
        values={{ budget: "95,000" }}
        originalValues={{ budget: "145,000" }}
        fieldNotes={{ budget: <span data-note>agent</span> }}
        onClose={() => {}}
      />,
    );
    const panel = screen.getByRole("article", { name: "Customer portal" });
    expect(panel.querySelector("h2, h3, header")).toBeNull();
    expect(screen.queryByRole("button", { name: "Close panel" })).toBeNull();
    expect(screen.queryByRole("region")).toBeNull();
    const budget = panel.querySelector("[data-field-id='budget']")!;
    expect(budget).toHaveTextContent(/95,000.*agent.*was 145,000/u);
  });

  it("keeps its header and section headings when not embedded", () => {
    render(
      <RecordDetailPanel
        title="Customer portal"
        sections={sections.map(({ hideTitle: _hidden, ...section }) => section)}
        values={{ budget: "95,000" }}
      />,
    );
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Customer portal");
    expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent("Details");
  });
});
