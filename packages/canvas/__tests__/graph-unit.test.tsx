import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

import type { CanvasClient } from "../client";
import { GraphUnit, resolveGraphSpec } from "../graph-unit";
import { createSelectionStore } from "../selection";
import {
  chartGraphMemory,
  chartGraphSession,
  personId,
  specs,
} from "../stories/fixtures/chart-graph";

function mount(client: CanvasClient, config: unknown) {
  const store = createSelectionStore(client.definition);
  const view = render(
    <GraphUnit
      client={client}
      unitId="graph-1"
      config={config}
      session={{ session: { id: chartGraphSession, as_of: "2026-10-01" }, revision: 1 }}
      selection={store}
    />,
  );
  return { store, ...view };
}

describe("GraphUnit", () => {
  it("centres on the record the relation names most, with its records by name as flat content", async () => {
    const { client } = chartGraphMemory();
    const { container } = mount(client, specs.managers);
    expect(await screen.findByText("Maya Okafor")).toBeInTheDocument();
    for (const name of [
      "Aisha Bello",
      "Daniel Reyes",
      "Grace Liu",
      "Priya Natarajan",
      "Tomás Lindqvist",
    ])
      expect(screen.getByRole("button", { name: `Activate ${name}` })).toBeInTheDocument();
    expect(screen.getByText("Manager: Maya Okafor")).toBeInTheDocument();
    expect(container.querySelector("[data-surface='flat']")).not.toBeNull();
    expect(container.querySelector(".org-chart-canvas-grid")).toBeNull();
    expect(container.textContent).not.toMatch(/0000-4000/);
  });

  it("selecting a card centres on it and selects it as a value of the relation", async () => {
    const { client } = chartGraphMemory();
    const { store } = mount(client, specs.managers);
    fireEvent.click(await screen.findByRole("button", { name: "Activate Tomás Lindqvist" }));
    expect(store.getSnapshot().selection).toEqual({
      kind: "nodes",
      unit_id: "graph-1",
      model_id: "m_person",
      record_ids: [personId(4)],
      field_id: "f_manager",
      key: { type: "record_id", value: personId(4) },
    });
    expect(store.getSnapshot().filter).toEqual({
      model_id: "m_person",
      field_id: "f_manager",
      op: "eq",
      value: personId(4),
    });
    // Centred on Tomás: his manager on the left, his reports on the right.
    expect(
      await screen.findByRole("button", { name: "Activate Manager: Maya Okafor" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Activate Elif Kaya" })).toBeInTheDocument();
    expect(screen.getByText("Tomás Lindqvist", { selector: "span" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(store.getSnapshot().selection).toBeNull();
  });

  it("a selection never resizes the graph: its Selected line lies over the graph, not below it", async () => {
    // A graph that shrinks re-fits (moves) every card: a click would jitter.
    const { client } = chartGraphMemory();
    const { container } = mount(client, specs.managers);
    await screen.findByText("Maya Okafor");
    const area = container.querySelector("[data-graph-unit] > div");
    expect(area?.querySelector("[data-surface='flat']")).not.toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Activate Tomás Lindqvist" }));
    const bar = await waitFor(() => {
      const found = container.querySelector<HTMLElement>("[data-graph-selected]");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(bar).toHaveTextContent("Selected: Tomás Lindqvist");
    // The graph keeps the whole unit; the line is positioned over it.
    expect(container.querySelector("[data-graph-unit] > div")).toBe(area);
    expect(bar.classList).toContain("absolute");
    expect(bar.parentElement).toHaveAttribute("data-graph-unit");
    expect(bar.parentElement!.classList).toContain("relative");
  });

  it("lists only the records another unit's selection filters to, and re-reads when it changes", async () => {
    const { client } = chartGraphMemory();
    const { store } = mount(client, specs.managers);
    expect(await screen.findByRole("button", { name: "Activate Grace Liu" })).toBeInTheDocument();
    act(() =>
      store.select({
        kind: "segment",
        unit_id: "chart-1",
        model_id: "m_person",
        field_id: "f_team",
        value: "design",
      }),
    );
    // Among designers, Priya manages most: her designers on the right, her manager on the left.
    expect(
      await screen.findByRole("button", { name: "Activate Sofia Marchetti" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Activate Chloé Martin" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Activate Manager: Maya Okafor" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Activate Grace Liu" })).toBeNull();
    act(() => store.select(null));
    expect(await screen.findByRole("button", { name: "Activate Grace Liu" })).toBeInTheDocument();
  });

  it("follows a relation that names records by external key, both ways", async () => {
    const { client } = chartGraphMemory({ externalKeys: true });
    mount(client, specs.managers);
    expect(await screen.findByText("Manager: Maya Okafor")).toBeInTheDocument();
    for (const name of ["Aisha Bello", "Daniel Reyes", "Grace Liu"])
      expect(screen.getByRole("button", { name: `Activate ${name}` })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Activate Daniel Reyes" }));
    expect(
      await screen.findByRole("button", { name: "Activate Manager: Maya Okafor" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Activate Kwame Mensah" })).toBeInTheDocument();
  });

  it("selecting a record named by external key filters other units by that key", async () => {
    const { client } = chartGraphMemory({ externalKeys: true });
    const { store } = mount(client, specs.managers);
    // The people a filter selects, as another unit on the same model reads them.
    const filtered = async () => {
      const filter = store.getSnapshot().filter;
      expect(filter).not.toBeNull();
      return client.data.list("m_person", {
        asOf: "2026-10-01",
        work: { sessionId: chartGraphSession },
        where: [{ field: "manager", op: "eq", value: filter!.value }],
        limit: 100,
      });
    };
    // A report on the right: Daniel is named by his external key.
    fireEvent.click(await screen.findByRole("button", { name: "Activate Daniel Reyes" }));
    expect(store.getSnapshot().filter).toEqual({
      model_id: "m_person",
      field_id: "f_manager",
      op: "eq",
      value: "P-2",
    });
    expect(await filtered()).not.toHaveLength(0);
    // His manager on the left: Maya, by hers.
    fireEvent.click(await screen.findByRole("button", { name: "Activate Manager: Maya Okafor" }));
    expect(store.getSnapshot().selection).toMatchObject({
      record_ids: [personId(1)],
      key: { type: "external_key", value: "P-1" },
    });
    expect(store.getSnapshot().filter).toMatchObject({ value: "P-1" });
    expect((await filtered()).map((row) => row.id)).toContain(personId(2));
  });

  it("opens on the configured record", async () => {
    const { client } = chartGraphMemory();
    mount(client, { ...specs.managers, record_id: personId(13) });
    expect(
      await screen.findByRole("button", { name: "Activate Manager: Aisha Bello" }),
    ).toBeInTheDocument();
  });

  it("a new configuration drops the record navigated to under the old one", async () => {
    const { client } = chartGraphMemory();
    const { store, rerender } = mount(client, specs.managers);
    fireEvent.click(await screen.findByRole("button", { name: "Activate Tomás Lindqvist" }));
    expect(await screen.findByRole("button", { name: "Activate Elif Kaya" })).toBeInTheDocument();
    rerender(
      <GraphUnit
        client={client}
        unitId="graph-1"
        config={{ ...specs.managers, record_id: personId(13) }}
        session={{ session: { id: chartGraphSession, as_of: "2026-10-01" }, revision: 1 }}
        selection={store}
      />,
    );
    expect(
      await screen.findByRole("button", { name: "Activate Manager: Aisha Bello" }),
    ).toBeInTheDocument();
  });

  it("says when there is nothing to show", async () => {
    const { client } = chartGraphMemory({ empty: true });
    mount(client, specs.managers);
    expect(await screen.findByText("No Person records to show.")).toBeInTheDocument();
  });

  it("refuses a column that is not a relation", () => {
    const { client } = chartGraphMemory();
    expect(
      resolveGraphSpec(client.definition, { model_id: "m_person", field_id: "f_team" }).ok,
    ).toBe(false);
  });
});
