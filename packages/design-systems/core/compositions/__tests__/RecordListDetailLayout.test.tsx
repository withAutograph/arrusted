// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { RecordList } from "../../components/RecordList";
import { RecordListDetailLayout } from "../RecordListDetailLayout";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Fixture() {
  const [selectedId, setSelectedId] = useState<string>();
  return (
    <RecordListDetailLayout
      hasSelection={Boolean(selectedId)}
      selectedId={selectedId}
      onBack={() => setSelectedId(undefined)}
      list={
        <RecordList
          ariaLabel="Records"
          items={[
            { id: "alpha", primary: "Item Alpha" },
            { id: "beta", primary: "Item Beta" },
          ]}
          onSelect={setSelectedId}
          selectedId={selectedId}
        />
      }
      detail={selectedId ? <article aria-label="Selected record">Detail</article> : null}
    />
  );
}

it("moves focus to Back for constrained detail, then returns it to the selected row", () => {
  render(<Fixture />);
  const row = screen.getByRole("button", { name: "Item Alpha" });
  row.focus();
  fireEvent.click(row);
  const back = screen.getByRole("button", { name: "Back" });
  expect(back.parentElement).toHaveClass("@3xl/record-list-detail:hidden");
  expect(back).toHaveFocus();
  fireEvent.click(back);
  expect(row).toHaveFocus();
});

it("keeps wide selection focus on the row", () => {
  const getComputedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
    const style = getComputedStyle(element);
    if (!element.classList.contains("@3xl/record-list-detail:hidden")) return style;
    return new Proxy(style, {
      get(target, property) {
        if (property === "display") return "none";
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as CSSStyleDeclaration;
  });
  render(<Fixture />);
  const row = screen.getByRole("button", { name: "Item Alpha" });
  row.focus();
  fireEvent.click(row);
  expect(row).toHaveFocus();
  expect(screen.getByRole("button", { name: "Back", hidden: true })).not.toHaveFocus();
});

it("can defer a selected detail only in constrained layouts", () => {
  const { rerender } = render(
    <RecordListDetailLayout
      hasSelection
      showDetailOnConstrained={false}
      onBack={() => {}}
      list={<div>List</div>}
      detail={<article aria-label="Selected record">Detail</article>}
    />,
  );

  expect(screen.getByText("List").parentElement).not.toHaveClass(
    "@max-3xl/record-list-detail:hidden",
  );
  expect(screen.getByLabelText("Selected record").parentElement).toHaveClass(
    "hidden",
    "@3xl/record-list-detail:block",
  );
  expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();

  rerender(
    <RecordListDetailLayout
      hasSelection
      showDetailOnConstrained
      onBack={() => {}}
      list={<div>List</div>}
      detail={<article aria-label="Selected record">Detail</article>}
    />,
  );

  expect(screen.getByText("List").parentElement).toHaveClass("@max-3xl/record-list-detail:hidden");
  expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
});

it("lets a list render callback keep selection aligned with visible detail", () => {
  const observers: Array<{
    disconnect: ReturnType<typeof vi.fn>;
    observe: ReturnType<typeof vi.fn>;
  }> = [];
  class TestResizeObserver {
    disconnect = vi.fn();
    observe = vi.fn();

    constructor() {
      observers.push(this);
    }
  }
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  const getComputedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
    const style = getComputedStyle(element);
    if (!element.classList.contains("hidden")) return style;
    return new Proxy(style, {
      get(target, property) {
        if (property === "display") return "none";
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as CSSStyleDeclaration;
  });
  const renderList = ({ isDetailVisible }: { isDetailVisible: boolean }) => (
    <>
      <span>{isDetailVisible ? "Review selected record" : "Open selected record"}</span>
      <RecordList
        ariaLabel="Records"
        items={[{ id: "alpha", primary: "Item Alpha" }]}
        onSelect={() => {}}
        selectedId={isDetailVisible ? "alpha" : undefined}
      />
    </>
  );
  const { rerender } = render(
    <RecordListDetailLayout
      hasSelection
      showDetailOnConstrained={false}
      onBack={() => {}}
      list={renderList}
      detail={<article aria-label="Selected record">Detail</article>}
    />,
  );

  expect(screen.getByText("Open selected record")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Item Alpha" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect(observers[0]?.observe).toHaveBeenCalledTimes(1);

  rerender(
    <RecordListDetailLayout
      hasSelection
      showDetailOnConstrained
      onBack={() => {}}
      list={renderList}
      detail={<article aria-label="Selected record">Detail</article>}
    />,
  );

  expect(screen.getByText("Review selected record")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Item Alpha" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(observers[0]?.disconnect).toHaveBeenCalledTimes(1);
  expect(observers[1]?.observe).toHaveBeenCalledTimes(1);
});

it("restores focus when constrained detail is deferred while selection remains", () => {
  const list = (
    <RecordList
      ariaLabel="Records"
      items={[{ id: "alpha", primary: "Item Alpha" }]}
      onSelect={() => {}}
      selectedId="alpha"
    />
  );
  const { rerender } = render(
    <RecordListDetailLayout
      hasSelection
      selectedId="alpha"
      showDetailOnConstrained={false}
      onBack={() => {}}
      list={list}
      detail={<article aria-label="Selected record">Detail</article>}
    />,
  );

  rerender(
    <RecordListDetailLayout
      hasSelection
      selectedId="alpha"
      showDetailOnConstrained
      onBack={() => {}}
      list={list}
      detail={<article aria-label="Selected record">Detail</article>}
    />,
  );
  expect(screen.getByRole("button", { name: "Back" })).toHaveFocus();
  rerender(
    <RecordListDetailLayout
      hasSelection
      selectedId="alpha"
      showDetailOnConstrained={false}
      onBack={() => {}}
      list={list}
      detail={<article aria-label="Selected record">Detail</article>}
    />,
  );

  expect(screen.getByRole("button", { name: "Item Alpha" })).toHaveFocus();
});

it("returns focus to the most recently selected controlled row", () => {
  render(<Fixture />);
  fireEvent.click(screen.getByRole("button", { name: "Item Alpha" }));
  const beta = screen.getByRole("button", { name: "Item Beta" });
  fireEvent.click(beta);
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(beta).toHaveFocus();
});
