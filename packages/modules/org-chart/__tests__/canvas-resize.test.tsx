// Opt-in resize re-fit: debounced, only when the chart no longer fits or the
// container changed meaningfully, and never for canvases that did not opt in.

import { OrgChartCanvas, type OrgChartCanvasProps } from "../canvas";
import { RelationGraph } from "../relation-graph";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

let observers: Array<{ callback: ResizeObserverCallback; target: Element | null }> = [];
const originalResizeObserver = globalThis.ResizeObserver;

class ControlledResizeObserver {
  #entry: { callback: ResizeObserverCallback; target: Element | null };
  constructor(callback: ResizeObserverCallback) {
    this.#entry = { callback, target: null };
    observers.push(this.#entry);
  }
  observe(target: Element) {
    this.#entry.target = target;
  }
  unobserve() {}
  disconnect() {}
}

function resizeTo(width: number, height: number) {
  act(() => {
    for (const { callback, target } of observers) {
      if (!target) continue;
      callback(
        [{ target, contentRect: { width, height } } as unknown as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    }
  });
}

function transform() {
  return (screen.getByTestId("org-chart-canvas-content") as HTMLElement).style.transform;
}

const DATA: OrgChartCanvasProps["data"] = {
  key: "k",
  label: null,
  nodes: [
    { id: "a", name: "A", nodeKind: "subject", fieldValues: {} },
    { id: "b", name: "B", nodeKind: "subject", fieldValues: {} },
    { id: "c", name: "C", nodeKind: "subject", fieldValues: {} },
  ],
  links: [
    { from: "a", to: "b" },
    { from: "a", to: "c" },
  ],
};

function renderCanvas(refitOnResize?: boolean) {
  render(
    <OrgChartCanvas
      data={DATA}
      renderNode={(node) => <span>{node.data.name}</span>}
      onNodeActivate={() => {}}
      visibleFields={[]}
      asOfDate=""
      filterActive={false}
      showSlots={false}
      refitOnResize={refitOnResize}
    />,
  );
}

beforeEach(() => {
  observers = [];
  globalThis.ResizeObserver = ControlledResizeObserver as unknown as typeof ResizeObserver;
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  globalThis.ResizeObserver = originalResizeObserver;
});

describe("OrgChartCanvas refitOnResize", () => {
  it("re-fits after the debounce when the container shrinks below the chart", () => {
    renderCanvas(true);
    resizeTo(1200, 800);
    const fitted = transform();
    expect(fitted).not.toBe("");

    resizeTo(400, 300);
    expect(transform()).toBe(fitted);
    act(() => vi.advanceTimersByTime(149));
    expect(transform()).toBe(fitted);
    act(() => vi.advanceTimersByTime(1));
    expect(transform()).not.toBe(fitted);
  });

  it("ignores small resizes while the chart still fits", () => {
    renderCanvas(true);
    resizeTo(1200, 800);
    const fitted = transform();
    resizeTo(1180, 790);
    act(() => vi.advanceTimersByTime(500));
    expect(transform()).toBe(fitted);
  });

  it("does not replay an ignored resize when the host rerenders after a manual zoom", () => {
    const graph = (onSelect: () => void) => (
      <RelationGraph
        centre={{ primary: "Jane Doe" }}
        left={[{ id: "manager", items: [{ id: "m", primary: "Ann Veal", caption: "Manager" }] }]}
        right={[
          { id: "department", items: [{ id: "d", primary: "Engineering", caption: "Department" }] },
        ]}
        onSelect={onSelect}
      />
    );
    const { rerender } = render(graph(() => {}));
    resizeTo(1200, 800);
    resizeTo(1180, 790);
    act(() => vi.advanceTimersByTime(500));

    const fitted = transform();
    for (let step = 0; step < 6; step += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
      act(() => vi.advanceTimersByTime(1000));
    }
    const zoomed = transform();
    expect(zoomed).not.toBe(fitted);

    rerender(graph(() => {}));
    act(() => vi.advanceTimersByTime(1000));
    expect(transform()).toBe(zoomed);
  });

  it("re-fits when the card size changes but the cards do not", () => {
    const graph = (width: number) => (
      <RelationGraph
        centre={{ primary: "Jane Doe" }}
        left={[]}
        right={[{ id: "department", items: [{ id: "d", primary: "Engineering" }] }]}
        nodeSize={{ width, height: 56 }}
        onSelect={() => {}}
      />
    );
    const { rerender } = render(graph(208));
    resizeTo(400, 300);
    const narrow = transform();
    rerender(graph(416));
    expect(transform()).not.toBe(narrow);
  });

  describe("RelationGraph initialView", () => {
    const graph = (initialView?: "fit" | "centre") => (
      <RelationGraph
        centre={{ primary: "Jane Doe" }}
        left={[{ id: "manager", items: [{ id: "m", primary: "Ann Veal", caption: "Manager" }] }]}
        right={["A", "B", "C", "D", "E", "F"].map((name) => ({
          id: name,
          items: [{ id: name, primary: name, caption: "Column" }],
        }))}
        initialView={initialView}
        onSelect={() => {}}
      />
    );
    const scaleOf = (value: string) => Number(/scale\(([^)]+)\)/.exec(value)?.[1]);
    const translateOf = (value: string) =>
      /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(value)!.slice(1).map(Number);

    it("fits every card by default", () => {
      render(graph());
      resizeTo(400, 300);
      expect(scaleOf(transform())).toBeLessThan(1);
    });

    it("opens centred on the centre card at 100% when asked, and still fits on demand", () => {
      render(graph("centre"));
      resizeTo(400, 300);
      expect(scaleOf(transform())).toBe(1);
      const centre = screen
        .getByText("Jane Doe")
        .closest("[data-org-chart-node='true']") as HTMLElement;
      const [x, y] = translateOf(transform());
      const middleX =
        Number.parseFloat(centre.style.left) + Number.parseFloat(centre.style.width) / 2;
      const middleY =
        Number.parseFloat(centre.style.top) + Number.parseFloat(centre.style.height) / 2;
      // Vertically centred; horizontally it sits right of the zoom controls
      // (see the tests below).
      expect(x! + middleX).toBeGreaterThan(200);
      expect(y! + middleY).toBeCloseTo(150);

      fireEvent.click(screen.getByRole("button", { name: "Fit chart" }));
      act(() => vi.advanceTimersByTime(1000));
      expect(scaleOf(transform())).toBeLessThan(1);
    });

    const leftEdge = () =>
      Math.min(
        ...[...document.querySelectorAll<HTMLElement>("[data-org-chart-node='true']")].map((node) =>
          Number.parseFloat(node.style.left),
        ),
      );

    it("keeps a centred chart from starting under the zoom controls when it fits", () => {
      render(graph("centre"));
      resizeTo(1600, 600);
      const [x] = translateOf(transform());
      const centre = screen
        .getByText("Jane Doe")
        .closest("[data-org-chart-node='true']") as HTMLElement;
      const middleX =
        Number.parseFloat(centre.style.left) + Number.parseFloat(centre.style.width) / 2;
      expect(x! + middleX).toBeCloseTo(66 + (1600 - 66) / 2);
      expect(x! + leftEdge()).toBeGreaterThanOrEqual(66);
    });

    it("nudges a cropped chart right, but never past the centre card", () => {
      render(graph("centre"));
      resizeTo(400, 300);
      const [x] = translateOf(transform());
      const centre = screen
        .getByText("Jane Doe")
        .closest("[data-org-chart-node='true']") as HTMLElement;
      const centreRight =
        x! + Number.parseFloat(centre.style.left) + Number.parseFloat(centre.style.width);
      // Either the chart clears the controls, or the centre card is as far
      // right as it can go while staying in view.
      expect(x! + leftEdge() >= 66 - 0.5 || Math.abs(centreRight - (400 - 16)) < 0.5).toBe(true);
      expect(centreRight).toBeLessThanOrEqual(400 - 16 + 0.5);
      expect(x! + Number.parseFloat(centre.style.left)).toBeGreaterThanOrEqual(66);
    });

    it("leaves the default fit untouched", () => {
      render(graph());
      resizeTo(1600, 600);
      const [x] = translateOf(transform());
      const nodes = [...document.querySelectorAll<HTMLElement>("[data-org-chart-node='true']")];
      const right = Math.max(
        ...nodes.map(
          (node) => Number.parseFloat(node.style.left) + Number.parseFloat(node.style.width),
        ),
      );
      const scale = scaleOf(transform());
      // Fitted charts stay centred on the whole canvas, controls or not.
      expect(x! + ((leftEdge() + right) / 2) * scale).toBeCloseTo(800);
    });
  });

  it("does nothing on resize unless the host opts in", () => {
    renderCanvas();
    resizeTo(1200, 800);
    const fitted = transform();
    resizeTo(400, 300);
    act(() => vi.advanceTimersByTime(500));
    expect(transform()).toBe(fitted);
  });
});
