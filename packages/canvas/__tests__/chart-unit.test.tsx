import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";

import type { DataDefinition } from "@autograph/generated-app-runtime/data";

import { ChartUnit, nameReads, nameScan } from "../chart-unit";
import {
  chartPanels,
  chartTitle,
  isRange,
  rangeConfig,
  rangePanels,
  rangeSummary,
  rankCompare,
  resolveChartSpec,
} from "../chart-spec";
import { CanvasKernelError, type CanvasClient } from "../client";
import { createMemoryCanvasClient } from "../memory-client";
import { createSelectionStore } from "../selection";
import { ChartFilters, chartFilterFields } from "../unit-filters";
import { chartGraphMemory, chartGraphSession, specs } from "../stories/fixtures/chart-graph";

import { bootstrapAgCharts } from "@autograph/compositions";

// As the app's session view: charts render with AG Charts registered, so a
// chart test can never pass on the "Call bootstrapAgCharts" error boundary.
bootstrapAgCharts({ allowMissingLicense: true });

function mount(client: CanvasClient, config: unknown, unitId = "chart-1") {
  const store = createSelectionStore(client.definition);
  const view = render(
    <ChartUnit
      client={client}
      unitId={unitId}
      config={config}
      session={{ session: { id: chartGraphSession, as_of: "2026-10-01" }, revision: 1 }}
      selection={store}
    />,
  );
  return { store, ...view };
}

describe("ChartUnit", () => {
  it("mounts a chart with AG Charts registered, never the bootstrap error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // The chart theme reads these tokens; jsdom has no stylesheet, so set
    // them here and the chart reaches AG Charts itself.
    const root = document.documentElement.style;
    for (const [name, value] of [
      ["--font-sans", "sans-serif"],
      ["--text-caption", "12px"],
      ["--radius-xs", "2px"],
    ] as const)
      root.setProperty(name, value);
    try {
      const { client } = chartGraphMemory();
      const { container } = mount(client, specs.countByTeam);
      await screen.findByRole("table");
      await waitFor(() => expect(container.textContent).not.toMatch(/Loading [^…]*…/u), {
        timeout: 30_000,
      });
      // jsdom has no canvas, so AG Charts may still fail later; never for registration.
      expect(container.textContent).not.toMatch(
        /bootstrapAgCharts|No modules have been registered/u,
      );
    } finally {
      for (const name of ["--font-sans", "--text-caption", "--radius-xs"])
        root.removeProperty(name);
    }
  }, 60_000);

  it("draws a count by an enum column, labelled by option, in option order", async () => {
    const { client } = chartGraphMemory();
    mount(client, specs.countByTeam);
    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Engineering7"),
      expect.stringContaining("Design3"),
      expect.stringContaining("Operations2"),
      expect.stringContaining("Sales2"),
    ]);
  });

  it("selects a bar as a segment, which filters by the group value, and clears it on a second click", async () => {
    const { client } = chartGraphMemory();
    const { store } = mount(client, specs.countByTeam);
    fireEvent.click(await screen.findByRole("button", { name: "Inspect Design" }));
    expect(store.getSnapshot().selection).toEqual({
      kind: "segment",
      unit_id: "chart-1",
      model_id: "m_person",
      field_id: "f_team",
      value: "design",
    });
    expect(store.getSnapshot().filter).toEqual({
      model_id: "m_person",
      field_id: "f_team",
      op: "eq",
      value: "design",
    });
    expect(await screen.findByText("Design", { selector: "span" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Inspect Design" }));
    expect(store.getSnapshot().selection).toBeNull();
  });

  it("keeps money in separate charts per currency and period, with the unit on every value", async () => {
    const { client } = chartGraphMemory();
    const { container } = mount(client, specs.payByTeam);
    await waitFor(() => expect(container.querySelectorAll("[data-chart-panel]")).toHaveLength(2));
    const panels = [...container.querySelectorAll("[data-chart-panel]")];
    expect(panels.map((panel) => panel.getAttribute("data-chart-panel"))).toEqual([
      "EUR · annual",
      "USD · annual",
    ]);
    // Engineering in euros: 142,000 + 88,000 + 104,000.
    // Annual money as people read it: the currency's symbol, no period.
    expect(within(panels[0] as HTMLElement).getByText("€334K")).toBeInTheDocument();
    expect(within(panels[1] as HTMLElement).getByText("$750K")).toBeInTheDocument();
  });

  it("names related records by their name column, never by id", async () => {
    const { client } = chartGraphMemory();
    mount(client, { model_id: "m_person", group_by: "f_manager", metric: { fn: "count" } });
    const table = await screen.findByRole("table");
    expect(within(table).getByText("Maya Okafor")).toBeInTheDocument();
    expect(within(table).getByText("No Manager")).toBeInTheDocument();
    expect(table.textContent).not.toMatch(/0000-4000/);
  });

  it("labels a group of empty text visibly, keeping its key", () => {
    const { client } = chartGraphMemory();
    const resolved = resolveChartSpec(client.definition, {
      model_id: "m_person",
      group_by: "f_role",
      metric: { fn: "count" },
    });
    if (!resolved.ok || isRange(resolved.chart)) throw new Error("spec did not resolve");
    const [panel] = chartPanels(
      client.definition,
      resolved.chart,
      { groups: [{ key: [""], metrics: ["2"] }] } as never,
      () => "",
    );
    expect(panel!.data).toEqual([expect.objectContaining({ label: "Blank Role", key: "" })]);
  });

  it("names related records past the first thousand by id, a few reads at a time", async () => {
    const { client } = chartGraphMemory();
    // 1,200 managers; the chart's groups name the last twenty.
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const ids = Array.from({ length: 20 }, (_, index) => id(1180 + index));
    let inFlight = 0;
    let most = 0;
    const lists: unknown[] = [];
    const stubbed: CanvasClient = {
      ...client,
      data: {
        aggregate: async () =>
          ({
            as_of: "2026-10-01",
            units: [null],
            groups: ids.map((value) => ({
              key: [{ type: "record_id", value }],
              metrics: ["1"],
            })),
            total: { metrics: ["20"] },
          }) as never,
        list: async (_model, input) => {
          lists.push(input);
          inFlight += 1;
          most = Math.max(most, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 1));
          inFlight -= 1;
          const wanted = (input.where?.[0] as { value?: string } | undefined)?.value;
          // The one name scan sees the first records only.
          return wanted === undefined
            ? Array.from({ length: input.limit ?? 0 }, (_, n) => ({
                id: id(n),
                name: `Manager ${n}`,
              }))
            : [{ id: wanted, name: `Manager ${Number(wanted.slice(-4))}` }];
        },
      },
    };
    mount(stubbed, { model_id: "m_person", group_by: "f_manager", metric: { fn: "count" } });
    const table = await screen.findByRole("table");
    await waitFor(() => expect(within(table).getByText("Manager 1199")).toBeInTheDocument());
    expect(within(table).getByText("Manager 1180")).toBeInTheDocument();
    expect(most).toBeLessThanOrEqual(nameReads);
    // One scan of the first names, then one read by id for each it missed.
    expect(lists).toHaveLength(21);
    expect(lists[0]).toMatchObject({ limit: nameScan });
    for (const input of lists.slice(1))
      expect(input).toMatchObject({ where: [{ field: "id", op: "eq" }], limit: 1 });
  });

  it("reads under the filter another unit's selection sets on the same model", async () => {
    const { client } = chartGraphMemory();
    const aggregate = vi.spyOn(client.data, "aggregate");
    const { store } = mount(client, specs.payByTeam);
    await screen.findAllByRole("table");
    act(() =>
      store.select({
        kind: "segment",
        unit_id: "chart-2",
        model_id: "m_person",
        field_id: "f_team",
        value: "ops",
      }),
    );
    await waitFor(() =>
      expect(aggregate).toHaveBeenLastCalledWith(
        "m_person",
        expect.objectContaining({ where: [{ field: "team", op: "eq", value: "ops" }] }),
      ),
    );
  });

  it("shows the empty state when nothing aggregates", async () => {
    const { client } = chartGraphMemory({ empty: true });
    mount(client, specs.countByTeam);
    expect(await screen.findByText("No Person records to chart")).toBeInTheDocument();
  });

  it("shows the kernel's message on a failed read, and retries", async () => {
    const { client } = chartGraphMemory();
    const aggregate = vi
      .spyOn(client.data, "aggregate")
      .mockRejectedValueOnce(
        new CanvasKernelError("permission_denied", "You cannot read Base pay."),
      );
    mount(client, specs.payByTeam);
    expect(await screen.findByRole("alert")).toHaveTextContent("You cannot read Base pay.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(aggregate).toHaveBeenCalledTimes(2);
  });

  it("says in a sentence when a donut has negative totals, instead of failing", async () => {
    const { client } = chartGraphMemory();
    const read = client.data.aggregate.bind(client.data);
    vi.spyOn(client.data, "aggregate").mockImplementation(async (modelId, input) => {
      const result = await read(modelId, input);
      return {
        ...result,
        groups: result.groups.map((group, index) =>
          index === 0 ? { ...group, metrics: group.metrics.map((m) => `-${m}`) } : group,
        ),
      };
    });
    mount(client, { ...specs.countByTeamDonut, metric: { fn: "sum", field_id: "f_tenure" } });
    expect(
      await screen.findByText(
        "This chart can't be drawn as a donut because some totals are negative.",
      ),
    ).toBeInTheDocument();
  });

  it("shows loading, not the previous chart's bars, when its spec changes", async () => {
    const { client } = chartGraphMemory();
    const store = createSelectionStore(client.definition);
    const session = { session: { id: chartGraphSession, as_of: "2026-10-01" }, revision: 1 };
    const view = render(
      <ChartUnit
        client={client}
        config={specs.countByTeam}
        selection={store}
        session={session}
        unitId="chart-1"
      />,
    );
    await screen.findByRole("table");
    let release = () => {};
    const read = client.data.aggregate.bind(client.data);
    vi.spyOn(client.data, "aggregate").mockImplementation(
      (modelId, input) =>
        new Promise((resolve) => {
          release = () => resolve(read(modelId, input));
        }),
    );
    view.rerender(
      <ChartUnit
        client={client}
        config={specs.payByTeam}
        selection={store}
        session={session}
        unitId="chart-1"
      />,
    );
    expect(screen.getByText("Loading chart…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Inspect Design" })).toBeNull();
    await act(async () => release());
    await waitFor(() =>
      expect(view.container.querySelectorAll("[data-chart-panel]")).toHaveLength(2),
    );
  });

  it("keeps its bars on screen through a session reload: an equal config and a new revision", async () => {
    const { client } = chartGraphMemory();
    const store = createSelectionStore(client.definition);
    const at = (revision: number) => ({
      session: { id: chartGraphSession, as_of: "2026-10-01" },
      revision,
    });
    const view = render(
      <ChartUnit
        client={client}
        config={{ ...specs.countByTeam }}
        selection={store}
        session={at(1)}
        unitId="chart-1"
      />,
    );
    await screen.findByRole("button", { name: "Inspect Design" });
    let release = () => {};
    const read = client.data.aggregate.bind(client.data);
    const aggregate = vi.spyOn(client.data, "aggregate").mockImplementation(
      (modelId, input) =>
        new Promise((resolve) => {
          release = () => resolve(read(modelId, input));
        }),
    );
    // As a reload hands it: the same config as a new object, with header filters, at a new revision.
    view.rerender(
      <ChartUnit
        client={client}
        config={{ ...specs.countByTeam, filters: [{ field_id: "f_team", value: "eng" }] }}
        selection={store}
        session={at(2)}
        unitId="chart-1"
      />,
    );
    expect(screen.queryByText("Loading chart…")).toBeNull();
    expect(screen.getByRole("button", { name: "Inspect Design" })).toBeInTheDocument();
    await waitFor(() => expect(aggregate).toHaveBeenCalled());
    // The header filter narrows the read.
    expect(aggregate).toHaveBeenLastCalledWith(
      "m_person",
      expect.objectContaining({ where: [{ field: "team", op: "eq", value: "eng" }] }),
    );
    await act(async () => release());
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Inspect Design" })).toBeNull(),
    );
    expect(screen.getByRole("button", { name: "Inspect Engineering" })).toBeInTheDocument();
    expect(screen.queryByText("Loading chart…")).toBeNull();
  });

  it("shows a plain sentence, not decoder text, when a response cannot be decoded", async () => {
    const { client } = chartGraphMemory();
    const malformed = Object.assign(
      new Error(
        "Generated data response contract violation: kernel_data_query response expected object",
      ),
      { name: "DataResponseError" },
    );
    vi.spyOn(client.data, "aggregate").mockRejectedValueOnce(malformed);
    mount(client, specs.countByTeam);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This chart could not be read: The chart could not be read.",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent("contract violation");
  });

  it("refuses a spec whose column is gone, by table label", async () => {
    const { client } = chartGraphMemory();
    mount(client, { ...specs.countByTeam, group_by: "f_gone" });
    expect(screen.getByRole("alert")).toHaveTextContent("no longer in Person");
  });
});

describe("resolveChartSpec", () => {
  it("reads a missing or old bar kind as a breakdown and rejects unknown keys", () => {
    const { client } = chartGraphMemory();
    const resolved = resolveChartSpec(client.definition, {
      model_id: "m_person",
      group_by: "f_team",
      metric: { fn: "avg", field_id: "f_tenure" },
    });
    expect(resolved.ok && resolved.chart.spec.kind).toBe("breakdown");
    const old = resolveChartSpec(client.definition, { ...specs.countByTeam, kind: "bar" });
    expect(old.ok && old.chart.spec.kind).toBe("breakdown");
    expect(resolveChartSpec(client.definition, { ...specs.countByTeam, data: [] }).ok).toBe(false);
  });
});

describe("memory aggregate avg", () => {
  it("averages a number column per group, as the kernel does", async () => {
    const { client } = chartGraphMemory();
    const result = await client.data.aggregate("m_person", {
      asOf: "2026-10-01",
      groupBy: ["team"],
      metrics: [{ fn: "avg", field: "tenure" }],
    });
    expect(result.groups.find((group) => group.key[0] === "sales")?.metrics).toEqual(["2.5"]);
  });
});

/** Levels named L10, L4 and L3 (stored in that order), two departments and four people. */
const rangeDefinition = {
  formatVersion: 1,
  schemaVersion: "canvas-range-1",
  models: [
    {
      id: "m_level",
      name: "level",
      label: "Level",
      display_field_id: "f_level_name",
      relations: [],
      fields: [
        {
          id: "f_level_name",
          name: "name",
          label: "Name",
          type: "text",
          required: true,
          readOnly: false,
        },
      ],
    },
    {
      id: "m_dept",
      name: "department",
      label: "Department",
      display_field_id: "f_dept_name",
      relations: [],
      fields: [
        {
          id: "f_dept_name",
          name: "name",
          label: "Name",
          type: "text",
          required: true,
          readOnly: false,
        },
      ],
    },
    {
      id: "m_emp",
      name: "employee",
      label: "Employee",
      display_field_id: "f_name",
      relations: [],
      fields: [
        {
          id: "f_name",
          name: "name",
          label: "Name",
          type: "text",
          required: true,
          readOnly: false,
        },
        {
          id: "f_level",
          name: "level",
          label: "Level",
          type: "relation",
          target_model: "m_level",
          required: false,
          readOnly: false,
        },
        {
          id: "f_dept",
          name: "department",
          label: "Department",
          type: "relation",
          target_model: "m_dept",
          required: false,
          readOnly: false,
        },
        {
          id: "f_pay",
          name: "pay",
          label: "Base pay",
          type: "money_rate",
          required: false,
          readOnly: false,
        },
        {
          id: "f_low",
          name: "pay_low",
          label: "Pay low",
          type: "money_rate",
          required: false,
          readOnly: true,
        },
        {
          id: "f_high",
          name: "pay_high",
          label: "Pay high",
          type: "money_rate",
          required: false,
          readOnly: true,
        },
      ],
    },
  ],
} as const satisfies DataDefinition;
const rangeId = (prefix: string, n: number) =>
  `00000000-0000-4000-${prefix}-${String(n).padStart(12, "0")}`;
const rangeSession = rangeId("8000", 9000);
const usd = (amount: string) => ({
  type: "money_rate" as const,
  value: { amount, currency: "USD", period: "annual" as const },
});
const related = (prefix: string, n: number) => ({
  type: "relation" as const,
  value: { type: "record_id" as const, value: rangeId(prefix, n) },
});
function rangeMemory() {
  const person = (
    n: number,
    name: string,
    level: number,
    dept: number,
    pay: string,
    low: string,
    high: string,
  ) => ({
    id: rangeId("e000", n),
    values: {
      f_name: { type: "text" as const, value: name },
      f_level: related("a000", level),
      f_dept: related("b000", dept),
      f_pay: usd(pay),
      f_low: usd(low),
      f_high: usd(high),
    },
  });
  return createMemoryCanvasClient({
    definition: rangeDefinition,
    rows: {
      m_level: ["L10", "L4", "L3"].map((name, index) => ({
        id: rangeId("a000", index + 1),
        values: { f_level_name: { type: "text" as const, value: name } },
      })),
      m_dept: ["Sales", "Engineering"].map((name, index) => ({
        id: rangeId("b000", index + 1),
        values: { f_dept_name: { type: "text" as const, value: name } },
      })),
      m_emp: [
        person(1, "Ann", 1, 2, "300000", "200000", "250000"),
        person(2, "Bob", 2, 1, "90000", "100000", "150000"),
        person(3, "Cy", 3, 2, "60000", "50000", "80000"),
        person(4, "Di", 2, 2, "120000", "100000", "150000"),
      ],
    },
    session: { id: rangeSession, title: "Ranges", as_of: "2026-10-01" },
  });
}
const rangeSpec = {
  kind: "range",
  model_id: "m_emp",
  group_by: "f_level",
  value: "f_pay",
  low: "f_low",
  high: "f_high",
};
const rangeUnitSession = { session: { id: rangeSession, as_of: "2026-10-01" }, revision: 1 };

describe("range chart", () => {
  it("is the `range` kind; the old `band` kind does not resolve", () => {
    expect(resolveChartSpec(rangeDefinition, rangeSpec).ok).toBe(true);
    expect(resolveChartSpec(rangeDefinition, { ...rangeSpec, kind: "band" }).ok).toBe(false);
  });

  it("names its title, legend and summary from the field headers, in neutral words", () => {
    const resolved = resolveChartSpec(rangeDefinition, rangeSpec);
    if (!resolved.ok || !isRange(resolved.chart)) throw new Error("range chart did not resolve");
    expect(chartTitle(resolved.chart)).toBe("Base pay vs range");
    const record = (pay: string, low: string, high: string) => ({
      id: rangeId("e000", Number(pay)),
      name: pay,
      level: rangeId("a000", 1),
      pay: usd(pay).value,
      pay_low: usd(low).value,
      pay_high: usd(high).value,
    });
    const { panels } = rangePanels(
      rangeDefinition,
      resolved.chart,
      [record("1", "5", "10"), record("7", "5", "10"), record("12", "5", "10")],
      { record: (item) => String(item.name), related: () => "L10" },
    );
    expect(rangeSummary(panels[0]!)).toBe(
      "1 below · 1 within · 1 above range. Showing USD · annual.",
    );
    expect(rangeSummary({ ...panels[0]!, unit: null })).toBe("1 below · 1 within · 1 above range.");
    const config = rangeConfig(resolved.chart, panels[0]!, 200) as {
      rangeLabel: string;
      markerLabel: string;
      points: { group: string }[];
    };
    expect(config.rangeLabel).toBe("Pay low – Pay high");
    expect(config.markerLabel).toBe("Middle of range");
    expect(config.points.map((point) => point.group)).toEqual([
      "Below range",
      "Within range",
      "Above range",
    ]);
    const withTarget = { ...resolved.chart, target: resolved.chart.high };
    expect((rangeConfig(withTarget, panels[0]!, 200) as { markerLabel: string }).markerLabel).toBe(
      "Pay high",
    );
  });

  it("draws levels in rank order, says where everyone sits, and selects a point's record", async () => {
    const { client } = rangeMemory();
    const store = createSelectionStore(client.definition);
    render(
      <ChartUnit
        client={client}
        config={rangeSpec}
        selection={store}
        session={rangeUnitSession}
        unitId="range-1"
      />,
    );
    expect(
      await screen.findByText("1 below · 2 within · 1 above range. Showing USD · annual."),
    ).toBeInTheDocument();
    const [ranges] = screen.getAllByRole("table");
    expect(
      within(ranges!)
        .getAllByRole("row")
        .slice(1)
        .map((row) => row.querySelector("td, th")?.textContent),
    ).toEqual([
      expect.stringContaining("L3"),
      expect.stringContaining("L4"),
      expect.stringContaining("L10"),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Inspect Bob" }));
    expect(store.getSnapshot().selection).toEqual({
      kind: "rows",
      unit_id: "range-1",
      model_id: "m_emp",
      record_ids: [rangeId("e000", 2)],
    });
    expect(screen.getByText("Bob", { selector: "span" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Inspect Bob" }));
    expect(store.getSnapshot().selection).toBeNull();
    // A range selects its level, which filters the other units.
    fireEvent.click(screen.getByRole("button", { name: "Inspect L4" }));
    expect(store.getSnapshot().filter).toEqual({
      model_id: "m_emp",
      field_id: "f_level",
      op: "eq",
      value: rangeId("a000", 2),
    });
  });

  it("reads under its header filters, stored in its config", async () => {
    const { client } = rangeMemory();
    const store = createSelectionStore(client.definition);
    render(
      <ChartUnit
        client={client}
        config={{ ...rangeSpec, filters: [{ field_id: "f_dept", value: rangeId("b000", 2) }] }}
        selection={store}
        session={rangeUnitSession}
        unitId="range-1"
      />,
    );
    // Bob is in Sales: left out.
    expect(
      await screen.findByText("0 below · 2 within · 1 above range. Showing USD · annual."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Inspect Bob" })).toBeNull();
  });

  it("offers the configured columns and its levels as header pickers, and stores a choice", async () => {
    const { client } = rangeMemory();
    const config = { ...rangeSpec, filters: [{ field_id: "f_dept" }] };
    expect(chartFilterFields(client, config).map((field) => field.id)).toEqual([
      "f_dept",
      "f_level",
    ]);
    expect(chartFilterFields(client, rangeSpec).map((field) => field.id)).toEqual(["f_level"]);
    // A full config, counting filters without a picker, has no room for a level choice.
    const full = ["f_dept", "f_name", "f_pay", "f_low", "f_high", "f_name"].map((field_id) => ({
      field_id,
    }));
    expect(
      chartFilterFields(client, { ...rangeSpec, filters: full }).map((field) => field.id),
    ).toEqual(["f_dept"]);
    expect(
      chartFilterFields(client, { ...rangeSpec, filters: full.slice(0, 5) }).map(
        (field) => field.id,
      ),
    ).toEqual(["f_dept", "f_level"]);
    const onChange = vi.fn();
    render(
      <ChartFilters
        client={client}
        config={config}
        session={rangeUnitSession}
        unitLabel="Base pay vs range"
        onChange={onChange}
      />,
    );
    // "All" and the header as it is, never pluralised.
    expect(
      screen.getByRole("button", {
        name: "Department filter for Base pay vs range: All Department",
      }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Level filter for Base pay vs range: All Level" }),
    );
    const options = await screen.findAllByRole("option");
    await waitFor(() =>
      expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
        "All Level",
        "L3",
        "L4",
        "L10",
      ]),
    );
    expect(options.length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("option", { name: "L4" }));
    expect(onChange).toHaveBeenCalledWith([
      { field_id: "f_dept" },
      { field_id: "f_level", value: rangeId("a000", 2) },
    ]);
  });
});

describe("rankCompare", () => {
  it("orders levels naturally, enums by option, and empty last", () => {
    const text = { id: "t", name: "t", type: "text", required: false, readOnly: false };
    const sorted = ["L10", "L4", null, "L3", "l5"]
      .map((key) => ({ key, label: key ?? "No level" }))
      .toSorted(rankCompare(text));
    expect(sorted.map((item) => item.key)).toEqual(["L3", "L4", "l5", "L10", null]);
    const enumField = { ...text, type: "enum", option_set: [{ id: "z" }, { id: "a" }] };
    expect(
      [
        { key: "a", label: "A" },
        { key: "z", label: "Z" },
      ]
        .toSorted(rankCompare(enumField))
        .map((item) => item.key),
    ).toEqual(["z", "a"]);
    // Decimal group keys arrive as strings; their labels may group digits.
    const decimal = { ...text, type: "decimal" };
    expect(
      [
        { key: "1000.5", label: "1,000.5" },
        { key: "-2", label: "-2" },
        { key: "250", label: "250" },
      ]
        .toSorted(rankCompare(decimal))
        .map((item) => item.key),
    ).toEqual(["-2", "250", "1000.5"]);
  });
});
