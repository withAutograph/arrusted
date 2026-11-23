// RelationGraph behaviour: the centre is current and inert, every
// neighbour and overflow card is a keyboard-activatable button, and
// placeholders are inert.

import { OrgChartCanvas } from "../canvas";
import { RelationGraph, capRelationGroup, type RelationGraphGroup } from "../relation-graph";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(cleanup);

const noop = () => {};

describe("RelationGraph", () => {
  it("marks the centre current and leaves it out of the tab order", () => {
    const { container } = render(
      <RelationGraph
        centre={{ primary: "Jane Doe" }}
        left={[{ id: "manager", items: [{ id: "m", primary: "Ann Veal", caption: "Manager" }] }]}
        right={[]}
        onSelect={noop}
      />,
    );
    const current = container.querySelector("[aria-current='true']")!;
    expect(current.textContent).toBe("Jane Doe");
    const wrapper = current.closest("[data-org-chart-node='true']")!;
    expect(wrapper.getAttribute("role")).toBeNull();
    expect(wrapper.getAttribute("tabindex")).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Activate/ })).toHaveLength(1);
  });

  it("activates neighbours and overflow cards with Enter and Space", () => {
    const onSelect = vi.fn();
    const onOverflow = vi.fn();
    const reports: RelationGraphGroup = capRelationGroup({
      id: "reports",
      items: ["A", "B", "C", "D"].map((name) => ({ id: name, primary: name })),
      total: 8,
      overflowLabel: (hidden) => `+${hidden} more`,
      onOverflow,
    });
    render(
      <RelationGraph
        centre={{ primary: "Jane Doe" }}
        left={[]}
        right={[
          { id: "department", items: [{ id: "d", primary: "Engineering", caption: "Department" }] },
        ]}
        below={[reports]}
        onSelect={onSelect}
      />,
    );

    const department = screen.getByRole("button", { name: "Activate Department: Engineering" });
    expect(department.tabIndex).toBe(0);
    fireEvent.keyDown(department, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "d", primary: "Engineering" }),
      expect.objectContaining({ id: "department" }),
    );

    expect(screen.queryByText("D")).toBeNull();
    const more = screen.getByRole("button", { name: "Activate +5 more" });
    fireEvent.keyDown(more, { key: " " });
    expect(onOverflow).toHaveBeenCalledTimes(1);
  });

  it("keeps cards distinct when host ids contain separators or look reserved", () => {
    const onSelect = vi.fn();
    const onOverflow = vi.fn();
    render(
      <RelationGraph
        centre={{ primary: "Jane Doe" }}
        left={[]}
        right={[
          { id: "a/b", items: [{ id: "c", primary: "First", caption: "One" }] },
          { id: "a", items: [{ id: "b/c", primary: "Second", caption: "Two" }] },
          {
            id: "g",
            items: [{ id: "+more", primary: "Third", caption: "Three" }],
            overflow: { label: "+2 more", onSelect: onOverflow },
          },
        ]}
        onSelect={onSelect}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Activate One: First" }));
    fireEvent.click(screen.getByRole("button", { name: "Activate Two: Second" }));
    fireEvent.click(screen.getByRole("button", { name: "Activate Three: Third" }));
    expect(onSelect.mock.calls.map(([item, group]) => [group.id, item.id])).toEqual([
      ["a/b", "c"],
      ["a", "b/c"],
      ["g", "+more"],
    ]);
    expect(onOverflow).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Activate +2 more" }));
    expect(onOverflow).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledTimes(3);
  });

  it("calls the latest onSelect without rebuilding when only the handler changes", () => {
    const first = vi.fn();
    const second = vi.fn();
    const right = [{ id: "department", items: [{ id: "d", primary: "Engineering" }] }];
    const { rerender } = render(
      <RelationGraph centre={{ primary: "Jane Doe" }} left={[]} right={right} onSelect={first} />,
    );
    const card = screen.getByRole("button", { name: "Activate Engineering" });
    rerender(
      <RelationGraph centre={{ primary: "Jane Doe" }} left={[]} right={right} onSelect={second} />,
    );
    expect(screen.getByRole("button", { name: "Activate Engineering" })).toBe(card);
    fireEvent.click(card);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("renders inert placeholders while pending", () => {
    const { container } = render(
      <RelationGraph
        centre={{ primary: "Jane Doe" }}
        left={[]}
        right={[]}
        below={[]}
        pending
        onSelect={noop}
      />,
    );
    const busy = container.querySelectorAll("[aria-busy='true']");
    expect(busy).toHaveLength(3);
    for (const card of busy) expect(card.textContent).toBe("Loading");
    expect(screen.queryAllByRole("button", { name: /^Activate/ })).toHaveLength(0);
  });
});

describe("RelationGraph frames", () => {
  const assignment = (onSelect?: () => void): RelationGraphGroup => ({
    id: "assignment",
    items: [
      { id: "p", primary: "Staff Engineer", caption: "Position" },
      { id: "m", primary: "Ann Veal", caption: "Manager" },
    ],
    frame: { caption: "Org Assignment", onSelect },
  });

  it("makes the caption a button that precedes its cards in tab order", () => {
    const onFrame = vi.fn();
    const onSelect = vi.fn();
    const { container } = render(
      <RelationGraph
        centre={{ primary: "Jane Doe" }}
        left={[assignment(onFrame)]}
        right={[{ id: "d", items: [{ id: "d", primary: "Engineering", caption: "Department" }] }]}
        onSelect={onSelect}
      />,
    );
    const caption = screen.getByRole("button", { name: "Open Org Assignment" });
    expect(caption.tagName).toBe("BUTTON");
    expect(caption.getAttribute("type")).toBe("button");
    expect(caption.textContent).toBe("Org Assignment");
    // Pressing the caption must not start a canvas pan.
    expect(caption.getAttribute("data-org-chart-control")).toBe("true");
    fireEvent.click(caption);
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();

    const focusable = [
      ...container.querySelectorAll<HTMLElement>("button, [role='button'][tabindex='0']"),
    ]
      .filter(
        (element) => !element.closest("[data-org-chart-control='true']") || element === caption,
      )
      .map((element) => element.getAttribute("aria-label"));
    expect(focusable).toEqual([
      "Open Org Assignment",
      "Activate Position: Staff Engineer",
      "Activate Manager: Ann Veal",
      "Activate Department: Engineering",
    ]);

    // The cards inside stay individually activatable.
    fireEvent.keyDown(screen.getByRole("button", { name: "Activate Manager: Ann Veal" }), {
      key: "Enter",
    });
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "m" }),
      expect.objectContaining({ id: "assignment" }),
    );
    expect(container.querySelectorAll("[data-relation-graph-frame='true']")).toHaveLength(1);
  });

  it("renders a plain caption when the frame has no onSelect", () => {
    render(
      <RelationGraph
        centre={{ primary: "Employee" }}
        left={[
          {
            id: "assignment",
            items: [
              { id: "p", primary: "Position" },
              { id: "m", primary: "Manager" },
            ],
            frame: { caption: "Org Assignment" },
          },
        ]}
        right={[]}
        onSelect={noop}
      />,
    );
    expect(screen.getByText("Org Assignment").closest("button")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Open/ })).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Activate/ })).toHaveLength(2);
  });

  it("draws no frame for unframed groups", () => {
    const { container } = render(
      <RelationGraph
        centre={{ primary: "Jane Doe" }}
        left={[{ ...assignment(), frame: undefined }]}
        right={[]}
        below={[{ id: "r", items: [{ id: "a", primary: "A" }] }]}
        onSelect={noop}
      />,
    );
    expect(container.querySelector("[data-relation-graph-frame]")).toBeNull();
    expect(container.querySelector(".relation-graph-frame-caption")).toBeNull();
  });
});

describe("capRelationGroup", () => {
  it("shows the first three and no overflow when nothing is hidden", () => {
    const items = ["A", "B", "C"].map((name) => ({ id: name, primary: name }));
    const group = capRelationGroup({
      id: "g",
      items,
      total: 3,
      overflowLabel: (hidden) => `+${hidden} more`,
      onOverflow: noop,
    });
    expect(group.items).toHaveLength(3);
    expect(group.overflow).toBeUndefined();
  });

  it("uses the host total, not the loaded item count", () => {
    const items = ["A", "B", "C"].map((name) => ({ id: name, primary: name }));
    const group = capRelationGroup({
      id: "g",
      items,
      total: 57,
      overflowLabel: (hidden) => `+${hidden} more`,
      onOverflow: noop,
    });
    expect(group.overflow?.label).toBe("+54 more");
  });
});

describe("OrgChartCanvas siblingGap", () => {
  it("forwards the sibling gap to the layout", () => {
    const data = {
      key: "gap",
      label: null,
      nodes: ["a", "b", "c"].map((id) => ({
        id,
        name: id.toUpperCase(),
        nodeKind: "subject" as const,
        fieldValues: {},
      })),
      links: [
        { from: "a", to: "b" },
        { from: "a", to: "c" },
      ],
    };
    const gapBetween = (siblingGap?: number) => {
      const { unmount } = render(
        <OrgChartCanvas
          data={data}
          renderNode={(node) => <span>{node.data.name}</span>}
          onNodeActivate={noop}
          visibleFields={[]}
          asOfDate=""
          filterActive={false}
          showSlots={false}
          nodeSize={{ width: 100, height: 40 }}
          siblingGap={siblingGap}
        />,
      );
      const left = (name: string) =>
        Number.parseFloat(
          (screen.getByText(name).closest("[style*='left']") as HTMLElement).style.left,
        );
      const gap = left("C") - left("B") - 100;
      unmount();
      return gap;
    };
    expect(gapBetween(10)).toBe(10);
    expect(gapBetween(40)).toBe(40);
  });
});

describe("OrgChartCanvas interactive opt-out", () => {
  it("keeps nodes activatable by default and drops activation when interactive is false", () => {
    render(
      <OrgChartCanvas
        data={{
          key: "k",
          label: null,
          nodes: [
            { id: "a", name: "A", nodeKind: "subject", fieldValues: {} },
            { id: "b", name: "B", nodeKind: "subject", fieldValues: {}, interactive: false },
          ],
          links: [{ from: "a", to: "b" }],
        }}
        renderNode={(node) => <span>{node.data.name}</span>}
        onNodeActivate={noop}
        visibleFields={[]}
        asOfDate=""
        filterActive={false}
        showSlots={false}
      />,
    );
    expect(screen.getByRole("button", { name: "Activate A" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Activate B" })).toBeNull();
    expect(
      screen.getByText("B").closest("[data-org-chart-node='true']")!.getAttribute("role"),
    ).toBe(null);
  });
});

describe("RelationGraph surface", () => {
  it("is flat content: no canvas fill or dotted grid, while the zoom controls stay", () => {
    const { container } = render(
      <RelationGraph centre={{ primary: "Jane Doe" }} left={[]} right={[]} onSelect={noop} />,
    );
    const canvas = container.querySelector("[data-testid='org-chart-canvas']")!;
    expect(canvas.getAttribute("data-surface")).toBe("flat");
    expect(container.querySelector(".org-chart-canvas-grid")).toBeNull();
    expect(screen.getByRole("button", { name: "Fit chart" })).toBeTruthy();
  });

  it("leaves OrgChartCanvas a canvas with its dotted grid by default", () => {
    const { container } = render(
      <OrgChartCanvas
        data={{ key: "k", label: null, nodes: [], links: [] }}
        renderNode={() => null}
        onNodeActivate={noop}
        visibleFields={[]}
        asOfDate=""
        filterActive={false}
        showSlots={false}
      />,
    );
    const canvas = container.querySelector("[data-testid='org-chart-canvas']")!;
    expect(canvas.getAttribute("data-surface")).toBe("canvas");
    expect(container.querySelector(".org-chart-canvas-grid")).not.toBeNull();
  });
});
