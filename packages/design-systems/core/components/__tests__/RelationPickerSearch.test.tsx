// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { RecordKey } from "@contracts";

import type {
  EditorContext,
  RelationOptionItem,
  RelationOptionResults,
  RelationOptionSearch,
} from "../editors/protocol";
import { RelationPicker, RelationSearchSelect } from "../editors/relation-picker";

afterEach(cleanup);

const key = (value: string): RecordKey => ({ type: "record_id", value });

const NAMES = ["Alan", "Alice", "Bob", "Carol"];

// A server-like search: case-insensitive substring (and "alcie" finds Alice,
// as a typo-tolerant server would), the best three and whether more match.
function fakeSearch(): RelationOptionSearch & { calls: string[] } {
  const calls: string[] = [];
  const search = async (query: string): Promise<RelationOptionResults> => {
    calls.push(query);
    const matches =
      query === "alcie"
        ? ["Alice"]
        : NAMES.filter((name) => name.toLowerCase().includes(query.toLowerCase()));
    return {
      options: matches.slice(0, 3).map((name) => ({ key: key(`id-${name}`), label: name })),
      truncated: matches.length > 3,
    };
  };
  return Object.assign(search, { calls });
}

function context(
  search: RelationOptionSearch,
  onRelationOptionPicked?: (option: RelationOptionItem) => void,
): EditorContext {
  return {
    rowKey: key("row"),
    fieldId: "linked",
    fieldType: {
      type: "relation",
      label: "Linked record",
      searchRelationOptions: search,
      onRelationOptionPicked,
    },
  };
}

describe("RelationPicker search", () => {
  it("shows the best matches for an empty query without waiting", async () => {
    const search = fakeSearch();
    render(
      <RelationPicker.Component
        initialValue={null}
        context={context(search)}
        onCommit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(await screen.findByRole("option", { name: "Alan" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Bob" })).toBeInTheDocument();
    expect(search.calls).toEqual([""]);
  });

  it("asks the user to keep typing when more match than are shown", async () => {
    const search = fakeSearch();
    const user = userEvent.setup();
    render(
      <RelationPicker.Component
        initialValue={null}
        context={context(search)}
        onCommit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(await screen.findByText("Keep typing to narrow")).toBeInTheDocument();
    await user.type(screen.getByRole("combobox", { name: "Linked record" }), "al");
    expect(await screen.findByRole("option", { name: "Alice" })).toBeInTheDocument();
    expect(screen.queryByText("Keep typing to narrow")).not.toBeInTheDocument();
  });

  it("searches once after a pause in typing and shows only that query's results", async () => {
    const search = fakeSearch();
    const user = userEvent.setup();
    render(
      <RelationPicker.Component
        initialValue={null}
        context={context(search)}
        onCommit={() => {}}
        onCancel={() => {}}
      />,
    );
    await screen.findByRole("option", { name: "Alan" });
    await user.type(screen.getByRole("combobox", { name: "Linked record" }), "car");
    expect(await screen.findByRole("option", { name: "Carol" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Alan" })).not.toBeInTheDocument();
    expect(search.calls).toEqual(["", "car"]);
  });

  it("commits the picked option's RecordKey and reports the pick", async () => {
    const search = fakeSearch();
    const user = userEvent.setup();
    const onCommit = vi.fn();
    const onPicked = vi.fn();
    render(
      <RelationPicker.Component
        initialValue={key("id-Alan")}
        context={context(search, onPicked)}
        onCommit={onCommit}
        onCancel={() => {}}
      />,
    );
    await user.type(screen.getByRole("combobox", { name: "Linked record" }), "bo");
    await user.click(await screen.findByRole("option", { name: "Bob" }));
    expect(onCommit).toHaveBeenCalledWith(key("id-Bob"));
    expect(onPicked).toHaveBeenCalledWith({ key: key("id-Bob"), label: "Bob" });
  });

  it("commits the top result on Tab, even one the query does not spell", async () => {
    const search = fakeSearch();
    const user = userEvent.setup();
    const onCommit = vi.fn();
    const onNavigate = vi.fn();
    render(
      <RelationPicker.Component
        initialValue={null}
        context={context(search)}
        onCommit={onCommit}
        onCancel={() => {}}
        onNavigate={onNavigate}
      />,
    );
    await user.type(screen.getByRole("combobox", { name: "Linked record" }), "alcie");
    await screen.findByRole("option", { name: "Alice" });
    await user.keyboard("{Tab}");
    expect(onCommit).toHaveBeenCalledWith(key("id-Alice"));
    expect(onNavigate).toHaveBeenCalledWith("next");
  });

  it("says when nothing matches", async () => {
    const search = fakeSearch();
    const user = userEvent.setup();
    render(
      <RelationPicker.Component
        initialValue={null}
        context={context(search)}
        onCommit={() => {}}
        onCancel={() => {}}
      />,
    );
    await user.type(screen.getByRole("combobox", { name: "Linked record" }), "zed");
    expect(await screen.findByText("No matches")).toBeInTheDocument();
  });
});

describe("RelationSearchSelect", () => {
  function Field(props: { onChange: (option: RelationOptionItem | null) => void }) {
    const [value, setValue] = useState<RecordKey | null>(null);
    return (
      <RelationSearchSelect
        ariaLabel="Linked record"
        placeholder="Search"
        search={fakeSearch()}
        value={value}
        onValueChange={(option) => {
          setValue(option?.key ?? null);
          props.onChange(option);
        }}
      />
    );
  }

  it("clears the chosen record when its text is edited or cleared", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Field onChange={onChange} />);
    const input = screen.getByRole("combobox", { name: "Linked record" });
    await user.click(input);
    await user.click(await screen.findByRole("option", { name: "Bob" }));
    expect(onChange).toHaveBeenLastCalledWith({ key: key("id-Bob"), label: "Bob" });
    expect(input).toHaveValue("Bob");

    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(onChange).toHaveBeenLastCalledWith(null);
    await waitFor(() => expect(input).toHaveValue(""));
  });
});
