// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { RecordList } from "../RecordList";

afterEach(cleanup);

it("owns record-row selection and aligns trailing evidence", () => {
  const onSelect = vi.fn();
  render(
    <RecordList
      ariaLabel="Products to review"
      heading="Products to review"
      summary="On hand / reorder point"
      selectedId="oat"
      onSelect={onSelect}
      items={[
        {
          id: "oat",
          primary: "Organic Oat Milk",
          secondary: "SKU 1048 · Downtown",
          trailing: <span>3 / 18</span>,
        },
        { id: "water", primary: "Sparkling Water", trailing: <span>11 / 24</span> },
      ]}
    />,
  );
  const selected = screen.getByRole("button", { name: /Organic Oat Milk/ });
  expect(selected).toHaveAttribute("aria-pressed", "true");
  expect(selected).toHaveAttribute("data-selected", "true");
  expect(screen.getByText("3 / 18").parentElement).toHaveClass("items-end");
  fireEvent.click(screen.getByRole("button", { name: /Sparkling Water/ }));
  expect(onSelect).toHaveBeenCalledWith("water");
});

it("uses a shared empty state instead of a replacement row control", () => {
  render(
    <RecordList
      ariaLabel="Products"
      onSelect={vi.fn()}
      items={[]}
      emptyState="No matching products."
    />,
  );
  expect(screen.getByText("No matching products.")).toBeVisible();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

it("renders zero-valued optional slots", () => {
  render(
    <RecordList
      ariaLabel="Records"
      heading={0}
      summary={0}
      onSelect={vi.fn()}
      items={[{ id: "alpha", primary: "Item Alpha", secondary: 0, trailing: 0 }]}
    />,
  );
  expect(screen.getAllByText("0")).toHaveLength(4);
});

it("renders supporting description below the heading and summary", () => {
  render(
    <RecordList
      ariaLabel="Products"
      heading="Products"
      summary="24 items"
      description="Choose a product to review its replenishment details."
      onSelect={vi.fn()}
      items={[{ id: "oat", primary: "Organic Oat Milk" }]}
    />,
  );

  const description = screen.getByText("Choose a product to review its replenishment details.");
  expect(description.tagName).toBe("P");
  expect(description.previousElementSibling).toHaveTextContent("Products");
  expect(description.previousElementSibling).toHaveTextContent("24 items");
});
