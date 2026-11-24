// The canvas's newer parts over the in-memory client: Restore yours after an
// agent replaced an edit, the warning before saving changes the canvas does
// not show, the note, figures and chart kinds, money defaults, the Save
// toast, the sessions menu and the as-of date.
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vite-plus/test";

import { bootstrapAgGrid } from "@modules/editable-grid";

import { Canvas } from "../canvas";
import { rangeMaxOffset, ChartUnit } from "../chart-unit";
import {
  rangePanels,
  distinctLabels,
  isRange,
  panelConfig,
  resolveChartSpec,
  type AggregateChart,
} from "../chart-spec";
import type { CanvasClient } from "../client";
import { KpiUnit } from "../kpi-unit";
import type { MemoryCanvas } from "../memory-client";
import { RecordPanel } from "../record-panel";
import { createSelectionStore, selectionOutdated } from "../selection";
import { DraftCardThreads } from "../draft-threads";
import { createMemoryCanvasClient } from "../memory-client";
import { saveToast } from "../save-bar";
import { useCanvasSession } from "../use-canvas-session";
import type { DataDefinition } from "@autograph/generated-app-runtime/data";
import type { CanvasLayout } from "@autograph/work-session-tools/layout";
import {
  agentReplacesYourEdit,
  rangeChart,
  parityDefinition,
  parityRows,
  send,
  memberId,
  noTableLayout,
  parityLayout,
  parityMemory,
  paritySession,
  parityTurn,
  parityUnits,
} from "../stories/fixtures/parity";

import { bootstrapAgCharts } from "@autograph/compositions";

// As the app's session view: charts render with AG Charts registered, so a
// chart test can never pass on the "Call bootstrapAgCharts" error boundary.
bootstrapAgCharts();

bootstrapAgGrid();

/** Records every session request the canvas sends. */
function recording(client: CanvasClient) {
  const calls: Record<string, unknown>[] = [];
  const wrapped: CanvasClient = {
    ...client,
    session: {
      request: (input) => {
        calls.push(structuredClone(input) as Record<string, unknown>);
        return client.session.request(input);
      },
    },
  };
  return { client: wrapped, calls };
}
const ops = (calls: Record<string, unknown>[], operation: string) =>
  calls.filter((call) => call.operation === operation);

function mount(client: CanvasClient, sessionId = paritySession) {
  return render(
    <div style={{ width: 1400, height: 900 }}>
      <Canvas client={client} sessionId={sessionId} />
    </div>,
  );
}
const entryOf = async (memory: MemoryCanvas, recordId: string) =>
  (
    await memory.client.session.request({ operation: "get", session_id: paritySession })
  ).overlay.find((entry) => entry.record_id === recordId && entry.field_id === "f_pay");
const unitSession = { session: { id: paritySession, as_of: "2026-10-01" }, revision: 1 };

describe("agent replaced your edit", () => {
  it("says so on the cell, and Restore yours stages your value again as yours", async () => {
    const memory = await parityMemory();
    await agentReplacesYourEdit(memory);
    expect(await entryOf(memory, memberId(4))).toMatchObject({
      author_kind: "agent",
      note: "Below-band members move to their band's low plus 1,000",
      replaced: { value: { type: "money_rate" }, author_kind: "human" },
    });
    mount(memory.client);
    const restore = await screen.findByRole("button", { name: "Restore yours" });
    expect(restore.closest("[data-cell-note]")).toHaveTextContent("Replaced your edit");
    fireEvent.click(restore);
    await waitFor(async () =>
      expect(await entryOf(memory, memberId(4))).toMatchObject({
        author_kind: "human",
        value: { value: { amount: "95000" } },
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Restore yours" })).not.toBeInTheDocument(),
    );
  });

  it("an agent may not unstage your edit; setting it back to saved keeps Restore yours", async () => {
    const memory = await parityMemory();
    const target = { model_id: "m_member", record_id: memberId(4), field_id: "f_pay" };
    await send(memory.client.session, {
      operation: "stage",
      changes: [
        {
          ...target,
          value: {
            type: "money_rate",
            value: { amount: "95000", currency: "USD", period: "annual" },
          },
        },
      ],
    });
    const saved = (await entryOf(memory, memberId(4)))!.baseline;
    await expect(
      send(memory.asAgent(parityTurn), { operation: "unstage", ...target }),
    ).rejects.toMatchObject({ envelope: { code: "authorization_denied" } });
    await send(memory.asAgent(parityTurn), {
      operation: "stage",
      changes: [{ ...target, value: saved }],
    });
    expect(await entryOf(memory, memberId(4))).toMatchObject({
      author_kind: "agent",
      value: saved,
      replaced: { author_kind: "human", value: { value: { amount: "95000" } } },
    });
    const before = await memory.client.data.list("m_member", {
      asOf: "2026-10-01",
      where: [{ field: "id", op: "eq", value: memberId(4) }],
    });
    const read = await memory.client.data.list("m_member", {
      asOf: "2026-10-01",
      work: { sessionId: paritySession },
      where: [{ field: "id", op: "eq", value: memberId(4) }],
    });
    expect(read[0]?.pay).toEqual(before[0]?.pay);
    mount(memory.client);
    const restore = await screen.findByRole("button", { name: "Restore yours" });
    expect(restore.closest("[data-cell-note]")).toHaveTextContent("Replaced your edit");
  });

  it("keeps Restore yours beside the warning when the record moved under the agent's value", async () => {
    const memory = await parityMemory();
    await agentReplacesYourEdit(memory);
    memory.writeCanonical("m_member", memberId(4), {
      f_pay: { type: "money_rate", value: { amount: "90000", currency: "USD", period: "annual" } },
    });
    mount(memory.client);
    const restore = await screen.findByRole("button", { name: "Restore yours" });
    const note = restore.closest("[data-cell-note]")!;
    expect(note).toHaveTextContent(/Changed to \$90,000/u);
    expect(note).toHaveTextContent("Replaced your edit");
  });

  it("shows the rule's note and Restore yours in the record panel and the staged list", async () => {
    const memory = await parityMemory();
    await agentReplacesYourEdit(memory);
    function Panel() {
      const session = useCanvasSession(memory.client, paritySession);
      return (
        <RecordPanel
          client={memory.client}
          modelId="m_member"
          recordId={memberId(4)}
          session={session}
        />
      );
    }
    render(<Panel />);
    const replaced = await screen.findByText(/Agent replaced your \$95,000/);
    expect(await screen.findByText(/By rule: Below-band members move/)).toBeInTheDocument();
    fireEvent.click(within(replaced.parentElement!).getByRole("button", { name: "Restore yours" }));
    await waitFor(async () =>
      expect(await entryOf(memory, memberId(4))).toMatchObject({ author_kind: "human" }),
    );
  });
});

describe("saving changes the canvas does not show", () => {
  it("opens the staged list first when no table shows them, then saves on the second Save", async () => {
    const memory = await parityMemory(noTableLayout);
    await agentReplacesYourEdit(memory);
    const { client, calls } = recording(memory.client);
    mount(client);
    const save = await screen.findByRole("button", { name: "Save 2 changes" });
    fireEvent.click(save);
    const warning = await waitFor(() => {
      const found = document.querySelector("[data-hidden-warning]");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(warning).toHaveTextContent("2 unsaved changes not shown on canvas — review");
    expect(document.querySelectorAll("[data-staged-entry][data-focused]")).toHaveLength(2);
    expect(ops(calls, "save")).toEqual([]);
    fireEvent.click(save);
    await screen.findByText("Saved as draft #1, pending approval");
    expect(ops(calls, "save")).toHaveLength(1);
    expect(ops(calls, "save")[0]).not.toHaveProperty("mode");
  });

  it("counts an entry shown when a table has its record loaded and its column displayed", async () => {
    const memory = await parityMemory(parityLayout);
    await agentReplacesYourEdit(memory);
    const { client, calls } = recording(memory.client);
    mount(client);
    await screen.findByRole("button", { name: "Restore yours" });
    fireEvent.click(screen.getByRole("button", { name: "Save 2 changes" }));
    await screen.findByText("Saved as draft #1, pending approval");
    expect(document.querySelector("[data-hidden-warning]")).toBeNull();
    expect(ops(calls, "save")).toHaveLength(1);
  });

  it("counts an entry whose record the table has not loaded (filtered out) as not shown", async () => {
    const byLevel: CanvasLayout = {
      units: [
        ...parityLayout.units,
        {
          id: "u-levels",
          kind: "chart",
          config: {
            kind: "breakdown",
            model_id: "m_member",
            group_by: "f_level",
            metric: { fn: "count" },
          },
          x: 1200,
          y: 32,
          w: 480,
          h: 360,
        },
      ],
    };
    const memory = await parityMemory(byLevel);
    await agentReplacesYourEdit(memory);
    mount(memory.client);
    await screen.findByRole("button", { name: "Restore yours" });
    // Selecting the Lead bar filters the table to Leads: neither changed member is loaded.
    // The breakdown's Lead bar (the range chart offers its Lead range too).
    await waitFor(() =>
      expect(document.querySelector('[data-unit-box="u-levels"]')).not.toBeNull(),
    );
    const levels = within(document.querySelector<HTMLElement>('[data-unit-box="u-levels"]')!);
    fireEvent.click(await levels.findByRole("button", { name: "Inspect Lead" }));
    await waitFor(() => expect(document.querySelector(`[row-id="${memberId(4)}"]`)).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Save 2 changes" }));
    await waitFor(() =>
      expect(document.querySelector("[data-hidden-warning]")).toHaveTextContent(
        "2 unsaved changes not shown on canvas — review",
      ),
    );
  });
});

describe("units", () => {
  it("edits a note in place and saves it into the unit's config", async () => {
    const memory = await parityMemory();
    mount(memory.client);
    const note = await screen.findByRole("textbox", { name: "Note" });
    fireEvent.focus(note);
    fireEvent.change(note, { target: { value: "Raise the associates first." } });
    fireEvent.blur(note);
    await waitFor(async () => {
      const header = await memory.client.session.request({
        operation: "get",
        session_id: paritySession,
        overlay: false,
      });
      const unit = (header.layout as CanvasLayout).units.find((u) => u.id === parityUnits.note);
      expect(unit?.config).toEqual({ text: "Raise the associates first." });
    });
  });

  it("shows key figures, money with its currency and period", async () => {
    const memory = await parityMemory();
    const store = createSelectionStore(memory.client.definition);
    render(
      <KpiUnit
        client={memory.client}
        config={parityLayout.units[0]!.config}
        selection={store}
        session={unitSession}
        unitId={parityUnits.kpi}
      />,
    );
    expect(await screen.findByText("9")).toBeInTheDocument();
    expect(screen.getByText("Total Base pay")).toBeInTheDocument();
    expect(screen.getByText("$890K")).toBeInTheDocument();
    expect(screen.getByText("Median Base pay")).toBeInTheDocument();
  });

  it("draws a range chart: one range per group, each record a point, in its money unit", async () => {
    const memory = await parityMemory();
    const store = createSelectionStore(memory.client.definition);
    const { container } = render(
      <ChartUnit
        client={memory.client}
        config={rangeChart}
        selection={store}
        session={unitSession}
        unitId={parityUnits.range}
      />,
    );
    await waitFor(() =>
      expect(container.querySelector("[data-chart-panel]")).toHaveAttribute(
        "data-chart-panel",
        "USD · annual",
      ),
    );
    // Noah has no base pay yet: left out, and said so.
    expect(screen.getByText(/1 record is not shown/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/bootstrapAgCharts|No modules have been registered/u);
    await screen.findAllByRole("table");
    const summary = container.textContent ?? "";
    for (const level of ["Associate", "Senior", "Lead"]) expect(summary).toContain(level);
  });

  it.each([
    ["heatmap", { kind: "heatmap", series_by: "f_start" }],
    ["stacked timeline", { kind: "stacked_timeline", group_by: "f_start", series_by: "f_level" }],
    ["donut", { kind: "donut" }],
  ])("draws a %s from the kernel's aggregate", async (_name, overrides) => {
    const memory = await parityMemory();
    const store = createSelectionStore(memory.client.definition);
    const { container } = render(
      <ChartUnit
        client={memory.client}
        config={{
          model_id: "m_member",
          group_by: "f_level",
          metric: { fn: "sum", field_id: "f_pay" },
          ...overrides,
        }}
        selection={store}
        session={unitSession}
        unitId="u-chart"
      />,
    );
    await waitFor(() =>
      expect(container.querySelector("[data-chart-panel]")).toHaveAttribute(
        "data-chart-panel",
        "USD · annual",
      ),
    );
    expect(container.querySelector("[role='alert']")).toBeNull();
  });
});

describe("derived numbers", () => {
  it("shows a derived quotient rounded in the table and the record panel", async () => {
    const memory = await parityMemory();
    mount(memory.client);
    const cell = () => document.querySelector(`[row-id="${memberId(3)}"] [col-id="f_ratio"]`);
    // Ines: 118,000 over a 112,000 target, 28 decimals as Postgres divides.
    await waitFor(() => expect(cell()).toHaveTextContent("1.0536"));
    expect(cell()!.textContent).not.toContain("1.05357");
    fireEvent.click(screen.getByRole("button", { name: "Open Ines Duarte" }));
    const drawer = await screen.findByRole("dialog", { name: "Ines Duarte" });
    expect(within(drawer).getByText("1.0536")).toBeInTheDocument();
  });
});

describe("money defaults", () => {
  it("leaves an empty money cell blank in the grid; the record panel says what it takes", async () => {
    const memory = await parityMemory();
    mount(memory.client);
    const cell = await waitFor(() => {
      const found = document.querySelector(`[row-id="${memberId(9)}"] [col-id="f_pay"]`);
      expect(found).not.toBeNull();
      return found!;
    });
    // Blank, as the spike's grid shows it: no note makes the row taller.
    expect(cell).not.toHaveTextContent("Takes USD · annual");
    function Panel() {
      const session = useCanvasSession(memory.client, paritySession);
      return (
        <RecordPanel
          client={memory.client}
          modelId="m_member"
          recordId={memberId(9)}
          session={session}
        />
      );
    }
    render(<Panel />);
    await waitFor(() =>
      expect(document.querySelector("[data-money-default]")).toHaveTextContent(
        "Takes USD · annual",
      ),
    );
  });

  it("carries the record's own money unit: a member banded in euros takes euros", async () => {
    const memory = await parityMemory();
    const euros = {
      type: "money_rate" as const,
      value: { amount: "60000", currency: "EUR", period: "monthly" as const },
    };
    memory.writeCanonical("m_member", memberId(9), {
      f_low: euros,
      f_target: euros,
      f_high: euros,
    });
    function Panel() {
      const session = useCanvasSession(memory.client, paritySession);
      return (
        <RecordPanel
          client={memory.client}
          modelId="m_member"
          recordId={memberId(9)}
          session={session}
        />
      );
    }
    render(<Panel />);
    await waitFor(() =>
      expect(document.querySelector("[data-money-default]")).toHaveTextContent(
        "Takes EUR · monthly",
      ),
    );
  });

  it("takes the unit of the money field the app names for the model, before the first one", async () => {
    const memory = await parityMemory();
    const money = (currency: string, period: "monthly" | "annual") => ({
      type: "money_rate" as const,
      value: { amount: "60000", currency, period },
    });
    memory.writeCanonical("m_member", memberId(9), {
      f_low: money("EUR", "monthly"),
      f_target: money("GBP", "annual"),
      f_high: money("EUR", "monthly"),
    });
    const client = { ...memory.client, moneyDefaults: { m_member: "f_target" } };
    function Panel() {
      const session = useCanvasSession(client, paritySession);
      return (
        <RecordPanel client={client} modelId="m_member" recordId={memberId(9)} session={session} />
      );
    }
    render(<Panel />);
    await waitFor(() =>
      expect(document.querySelector("[data-money-default]")).toHaveTextContent(
        "Takes GBP · annual",
      ),
    );
  });
});

describe("top bar", () => {
  it("saves a draft for review; an approver's Save and approve publishes in one action", async () => {
    const memory = await parityMemory(parityLayout, undefined, { canApprove: true });
    await agentReplacesYourEdit(memory);
    mount(memory.client);
    await screen.findByRole("button", { name: "Restore yours" });
    fireEvent.click(screen.getByRole("button", { name: "Save and approve 2 changes" }));
    await screen.findByText("Saved and published #1");
    const published = await memory.client.drafts!.kernel.postJson<{ change_set_id: number }[]>(
      "/api/activity",
      { statuses: ["mainline"] },
    );
    expect(published.map((set) => set.change_set_id)).toContain(1);
    expect(await memory.client.drafts!.kernel.getJson<unknown[]>("/api/drafts")).toEqual([]);
  });

  it("a plain Save leaves the draft waiting for approval", async () => {
    const memory = await parityMemory(parityLayout, undefined, { canApprove: true });
    await agentReplacesYourEdit(memory);
    mount(memory.client);
    await screen.findByRole("button", { name: "Restore yours" });
    fireEvent.click(screen.getByRole("button", { name: "Save 2 changes" }));
    await screen.findByText("Saved as draft #1, pending approval");
    expect(await memory.client.drafts!.kernel.getJson<unknown[]>("/api/drafts")).toHaveLength(1);
  });

  it("gives a member Save only, never Save and approve", async () => {
    const memory = await parityMemory(parityLayout, undefined, { canApprove: false });
    await agentReplacesYourEdit(memory);
    mount(memory.client);
    await screen.findByRole("button", { name: "Save 2 changes" });
    expect(screen.queryByRole("button", { name: /Save and approve/ })).toBeNull();
  });

  it("lists sessions pinned first, opens one, and starts a New session", async () => {
    const opened: string[] = [];
    const memory = await parityMemory(parityLayout, (id) => opened.push(id));
    mount(memory.client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Q4 pay review/ }));
    const list = await screen.findByRole("list", { name: "Your sessions" });
    const titles = within(list)
      .getAllByRole("listitem")
      .map((item) => item.querySelector("span span")?.textContent);
    expect(titles[0]).toBe("Band refresh");
    await user.type(screen.getByRole("textbox", { name: "Search sessions" }), "promo");
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    await user.click(within(list).getByRole("button", { name: /^Promotions 2027/ }));
    expect(opened).toEqual(["00000000-0000-4000-8000-000000005200"]);

    await user.click(screen.getByRole("button", { name: /Q4 pay review/ }));
    await user.click(await screen.findByRole("button", { name: "New session" }));
    await user.type(screen.getByRole("textbox", { name: "New session title" }), "Bonus pool");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(opened).toHaveLength(2));
    const created = await memory.client.session.request({
      operation: "get",
      session_id: opened[1]!,
      overlay: false,
    });
    expect(created.title).toBe("Bonus pool");
  });

  it("pins and archives a session at its listed revision; a rename is last-write-wins", async () => {
    const memory = await parityMemory();
    const { client, calls } = recording(memory.client);
    mount(client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Q4 pay review/ }));
    await user.click(await screen.findByRole("button", { name: "Actions for Promotions 2027" }));
    await user.click(screen.getByRole("button", { name: "Pin" }));
    await waitFor(() => expect(ops(calls, "pin")).toHaveLength(1));
    expect(ops(calls, "pin")[0]).toMatchObject({ pinned: true, expected_revision: 1 });

    await user.click(await screen.findByRole("button", { name: "Actions for Promotions 2027" }));
    await user.click(screen.getByRole("button", { name: "Rename" }));
    const title = screen.getByRole("textbox", { name: "Session title" });
    await user.clear(title);
    await user.type(title, "Promotions 2027 (H1){Enter}");
    await waitFor(() =>
      expect(ops(calls, "update")).toEqual([
        expect.objectContaining({ patch: { title: "Promotions 2027 (H1)" } }),
      ]),
    );
    expect(ops(calls, "update")[0]).not.toHaveProperty("expected_revision");

    await user.click(
      await screen.findByRole("button", { name: "Actions for Promotions 2027 (H1)" }),
    );
    await user.click(screen.getByRole("button", { name: "Archive" }));
    await user.click(screen.getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(ops(calls, "archive")).toHaveLength(1));
    // A fresh request id per gesture.
    const ids = calls.flatMap((call) => (call.request_id === undefined ? [] : [call.request_id]));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("moves the session to another as-of date from the date picker", async () => {
    const memory = await parityMemory();
    mount(memory.client);
    const pill = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-as-of] button");
      expect(found).not.toBeNull();
      return found!;
    });
    await act(async () => pill.click());
    fireEvent.click(await screen.findByRole("button", { name: /October 15/ }));
    await waitFor(async () => {
      const header = await memory.client.session.request({
        operation: "get",
        session_id: paritySession,
        overlay: false,
      });
      expect(header.as_of).toBe("2026-10-15");
    });
    expect(document.querySelector("[data-as-of]")).toHaveAttribute("data-as-of", "2026-10-15");
  });
});

describe("review fix batch", () => {
  it("carries the rule note of a saved agent value to its review card", async () => {
    const memory = createMemoryCanvasClient({
      definition: parityDefinition,
      rows: parityRows(),
      actorId: "user-hana",
      session: { id: paritySession, title: "Q4", as_of: "2026-10-01", layout: parityLayout },
      drafts: { canApprove: true },
    });
    await agentReplacesYourEdit(memory);
    const saved = (await send(memory.client.session, { operation: "save" })) as {
      change_set: { id: number } | null;
    };
    const changeSetId = saved.change_set!.id;
    const found = await memory.client.drafts!.threads.list(changeSetId);
    expect(Object.values(found.ruleNotes ?? {})).toContain(
      "Below-band members move to their band's low plus 1,000",
    );
    function Card() {
      const session = useCanvasSession(memory.client, paritySession);
      return (
        <DraftCardThreads
          changeSetId={changeSetId}
          client={memory.client}
          drafts={memory.client.drafts!}
          session={session}
        />
      );
    }
    render(<Card />);
    expect(await screen.findByText(/By rule: Below-band members move/)).toBeInTheDocument();
  });

  it("says nothing was saved when every change was at its saved value", () => {
    expect(saveToast({ ok: true, revision: 2, changeSetId: null, published: false }, 1)).toEqual({
      variant: "success",
      message: "Nothing to save: the changes were already at their saved values.",
    });
  });

  it("drops a selection whose unit's query changed or went", () => {
    const selection = { kind: "rows", unit_id: "u1", model_id: "m", record_ids: ["r"] } as const;
    const before = new Map([["u1", '{"kind":"breakdown"}']]);
    expect(selectionOutdated(selection, before, new Map([["u1", '{"kind":"breakdown"}']]))).toBe(
      false,
    );
    expect(selectionOutdated(selection, before, new Map([["u1", '{"kind":"donut"}']]))).toBe(true);
    expect(selectionOutdated(selection, before, new Map())).toBe(true);
    expect(selectionOutdated(null, before, new Map())).toBe(false);
    // The first layout seen changes nothing.
    expect(selectionOutdated(selection, null, new Map())).toBe(false);
  });
});

describe("Save and approve", () => {
  const staged = async (canApprove: boolean) => {
    const memory = await parityMemory(parityLayout, undefined, { canApprove });
    await send(memory.client.session, {
      operation: "stage",
      changes: [{ model_id: "m_member", record_id: memberId(4), field_id: "f_pay", value: null }],
    });
    const { result } = renderHook(() => useCanvasSession(memory.client, paritySession));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    return { memory, result };
  };

  it("saves the draft, then approves it through the ordinary approval", async () => {
    const { result } = await staged(true);
    const outcome = await act(() =>
      result.current.save(result.current.revision!, [], { approve: true }),
    );
    expect(outcome).toMatchObject({ ok: true, changeSetId: 1, published: true });
    expect(saveToast(outcome, 1)).toEqual({
      variant: "success",
      message: "Saved and published #1",
    });
  });

  it("keeps the draft for review when approval is refused", async () => {
    const { memory, result } = await staged(false);
    const outcome = await act(() =>
      result.current.save(result.current.revision!, [], { approve: true }),
    );
    expect(outcome).toMatchObject({
      ok: true,
      changeSetId: 1,
      published: false,
      approveFailure: { code: "authorization_denied" },
    });
    expect(saveToast(outcome, 1).variant).toBe("warning");
    expect(await memory.client.drafts!.kernel.getJson<unknown[]>("/api/drafts")).toHaveLength(1);
  });
});

describe("chart edges", () => {
  it("keeps heatmap categories with the same name apart", () => {
    expect([
      ...distinctLabels([
        ["a", "Kim"],
        ["b", "Kim"],
        ["a", "Kim"],
        ["c", "Lee"],
      ]),
    ]).toEqual([
      ["a", "Kim"],
      ["b", "Kim (2)"],
      ["c", "Lee"],
    ]);
  });

  it("never makes a generated label that collides with a real one", () => {
    const labels = distinctLabels([
      ["a", "Associate"],
      ["b", "Associate"],
      ["c", "Associate (2)"],
    ]);
    expect([...labels.values()]).toEqual(["Associate", "Associate (3)", "Associate (2)"]);
    expect(new Set(labels.values()).size).toBe(3);
  });

  it("keeps donut, bar and timeline categories with one name apart", () => {
    const aggregate = (spec: Record<string, unknown>) => {
      const resolved = resolveChartSpec(parityDefinition, {
        model_id: "m_member",
        metric: { fn: "count" },
        ...spec,
      });
      if (!resolved.ok) throw new Error(resolved.error);
      return resolved.chart as AggregateChart;
    };
    const twoKims = {
      unit: null,
      data: [
        { id: "a", label: "Kim", value: 1, key: "a" },
        { id: "b", label: "Kim", value: 2, key: "b" },
      ],
    };
    const options = { height: 200, selectedId: null };
    for (const kind of ["donut", "breakdown"]) {
      const config = panelConfig(aggregate({ kind, group_by: "f_level" }), twoKims, options);
      const labels = (config as unknown as { data: { label: string }[] }).data.map((d) => d.label);
      expect(labels).toEqual(["Kim", "Kim (2)"]);
    }
    const timeline = panelConfig(
      aggregate({ kind: "stacked_timeline", group_by: "f_start", series_by: "f_level" }),
      {
        unit: null,
        data: [
          { id: "1", label: "Jan", value: 1, key: "2026-01", series: { id: "s1", label: "Kim" } },
          { id: "2", label: "Jan", value: 1, key: "2026-02", series: { id: "s2", label: "Kim" } },
        ],
      },
      options,
    ) as unknown as { series: { label: string }[]; data: { periodLabel: string }[] };
    expect(timeline.series.map((series) => series.label)).toEqual(["Kim", "Kim (2)"]);
    expect(timeline.data.map((period) => period.periodLabel)).toEqual(["Jan", "Jan (2)"]);
  });

  it("refuses a range chart whose target column no longer resolves", () => {
    const resolved = resolveChartSpec(parityDefinition, { ...rangeChart, target: "f_gone" });
    expect(resolved).toEqual({
      ok: false,
      error: expect.stringMatching(/^A column this chart uses is no longer in /u),
    });
  });

  it("keeps range rows with the same name apart", () => {
    const [member] = parityDefinition.models;
    const definition = {
      ...parityDefinition,
      models: [
        {
          ...member,
          fields: member.fields.map((field) =>
            field.id === "f_level"
              ? {
                  ...field,
                  option_set: [
                    { id: "l1", label: "Associate" },
                    { id: "l2", label: "Associate" },
                  ],
                }
              : field,
          ),
        },
      ],
    } as unknown as DataDefinition;
    const resolved = resolveChartSpec(definition, rangeChart);
    if (!resolved.ok || !isRange(resolved.chart)) throw new Error("range chart did not resolve");
    const pay = (amount: number) => ({ amount: String(amount), currency: "USD", period: "annual" });
    const record = (id: string, level: string, low: number, high: number) => ({
      id,
      name: id,
      level,
      pay: pay(low + 1),
      band_low: pay(low),
      band_target: pay((low + high) / 2),
      band_high: pay(high),
    });
    const { panels } = rangePanels(
      definition,
      resolved.chart,
      [record("a", "l1", 70000, 95000), record("b", "l2", 95000, 130000)],
      { record: (row) => String(row.id), related: (id) => id },
    );
    expect(panels[0]?.rows.map(({ label, low }) => [label, low])).toEqual([
      ["Associate", 70000],
      ["Associate (2)", 95000],
    ]);
  });

  it("reads a range chart no further than the kernel's offset and says how many it left out", async () => {
    const memory = await parityMemory();
    const offsets: number[] = [];
    const client: CanvasClient = {
      ...memory.client,
      data: {
        ...memory.client.data,
        list: async (_model, input) => {
          offsets.push(input.offset ?? 0);
          // Every page is full: 12,000 records in all.
          return Array.from({ length: 100 }, (_, index) => ({
            id: `00000000-0000-4000-8000-${String((input.offset ?? 0) + index).padStart(12, "0")}`,
          }));
        },
        aggregate: async () =>
          ({
            as_of: "2026-10-01",
            units: [null],
            groups: [],
            total: { metrics: ["12000"] },
          }) as never,
      },
    };
    const store = createSelectionStore(client.definition);
    render(
      <ChartUnit
        client={client}
        config={rangeChart}
        // Small enough that the note's room would take it under the chart's minimum.
        height={180}
        selection={store}
        session={unitSession}
        unitId={parityUnits.range}
      />,
    );
    expect(await screen.findByText(/1900 more records are not shown/)).toBeInTheDocument();
    expect(document.querySelector("[data-chart-panel]")).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(Math.max(...offsets)).toBe(rangeMaxOffset);
  });
});
