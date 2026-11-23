// The assembled canvas over the in-memory client: layout gestures and their
// saves, adding and removing units, zoom as view state, comment-mode
// anchoring, live agent revisions and the selection filter between units.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vite-plus/test";

import type { WorkSessionRequest } from "@autograph/generated-app-runtime/data";
import { bootstrapAgGrid } from "@modules/editable-grid";

import { Canvas } from "../canvas";
import type { CanvasClient } from "../client";
import {
  addUnit,
  freeSlot,
  placeGrid,
  unitSizes,
  type CanvasLayout,
} from "@autograph/work-session-tools/layout";
import type { MemoryCanvas } from "../memory-client";
import type { CanvasSelection } from "../selection";
import {
  agentStagesTurn,
  canvasMemory,
  holdLongProjects,
  seedTypical,
  send,
  sessionId,
  threadIds,
  turns,
  typicalLayout,
  unitIds,
} from "../stories/fixtures/canvas";
import { change, money, personId, projectId, stageAs } from "../stories/fixtures/grid";

import { bootstrapAgCharts } from "@autograph/compositions";

// As the app's session view: charts render with AG Charts registered, so a
// chart test can never pass on the "Call bootstrapAgCharts" error boundary.
bootstrapAgCharts({ allowMissingLicense: true });

bootstrapAgGrid({ allowMissingLicense: true });

/** Counts the session operations the canvas sends, by operation. */
function counting(client: CanvasClient, before?: (input: WorkSessionRequest) => Promise<void>) {
  const sent: string[] = [];
  const wrapped: CanvasClient = {
    ...client,
    session: {
      request: async (input) => {
        sent.push(input.operation);
        await before?.(input);
        return client.session.request(input);
      },
    },
  };
  return { client: wrapped, sent };
}

function mount(
  client: CanvasClient,
  onSelectionChange?: (selection: CanvasSelection | null) => void,
) {
  return render(
    <div style={{ width: 1400, height: 900 }}>
      <Canvas client={client} sessionId={sessionId} onSelectionChange={onSelectionChange} />
    </div>,
  );
}

const savedLayout = async (memory: MemoryCanvas) =>
  (await memory.client.session.request({ operation: "get", session_id: sessionId, overlay: false }))
    .layout as CanvasLayout;
const unitBox = (id: string) => document.querySelector<HTMLElement>(`[data-unit-box="${id}"]`)!;
/** The layout id of the unit a frame shows. */
const unitIdOf = (_memory: MemoryCanvas, frame: HTMLElement) =>
  frame.getAttribute("data-canvas-unit")!;
const scale = () =>
  Number(screen.getByRole("region", { name: "Canvas" }).getAttribute("data-scale"));

/** Waits for the projects table to render project `n`'s row. */
const tableShows = (n: number) =>
  waitFor(() => expect(document.querySelector(`[row-id="${projectId(n)}"]`)).not.toBeNull());

/** Turns comment mode on: Comments, then Add a comment at the top of its pane. */
async function commentOn(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /^Comments/ }));
  await user.click(await screen.findByRole("button", { name: "Add a comment" }));
}

/** Drags `from` by (dx, dy) screen pixels: press, two moves, release. */
function drag(from: Element, dx: number, dy: number) {
  fireEvent.pointerDown(from, { button: 0, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(document, { clientX: 100 + dx / 2, clientY: 100 + dy / 2 });
  fireEvent.pointerMove(document, { clientX: 100 + dx, clientY: 100 + dy });
  fireEvent.pointerUp(document, { clientX: 100 + dx, clientY: 100 + dy });
}

describe("Canvas top bar", () => {
  it("keeps the unsaved changes and Save bar in place with nothing to save", async () => {
    mount(canvasMemory(typicalLayout).client);
    const bar = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-changes-bar]");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(within(bar).getByRole("button", { name: "Unsaved changes" })).toHaveTextContent(
      "No unsaved changes",
    );
    expect(within(bar).getByRole("button", { name: "Save" })).toBeDisabled();
    // Navigation and actions stay in the main bar.
    const top = document.querySelector<HTMLElement>("[data-top-bar]")!;
    expect(within(top).getByRole("button", { name: "Add to canvas" })).toBeInTheDocument();
    expect(within(top).queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("names unsaved changes in plain words, one or many", async () => {
    const memory = canvasMemory(typicalLayout);
    await seedTypical(memory);
    mount(memory.client);
    const pill = await screen.findByRole("button", { name: "Unsaved changes, 6" });
    expect(pill).toHaveTextContent("6 unsaved changes");
    expect(screen.queryByText(/staged/iu)).toBeNull();
  });

  it("one Comments control lists open comments and starts comment mode, then ends it", async () => {
    const memory = canvasMemory(typicalLayout);
    await seedTypical(memory);
    mount(memory.client);
    const user = userEvent.setup();
    const comments = await screen.findByRole("button", { name: "Comments, 2" });
    expect(comments).toHaveAttribute("data-comment-mode", "off");
    await user.click(comments);
    const pane = await screen.findByRole("dialog", { name: "Comments" });
    expect(within(pane).getByRole("list", { name: "Open comments" })).toBeInTheDocument();
    await user.click(within(pane).getByRole("button", { name: "Add a comment" }));
    // The pane closes and the control shows comment mode is on.
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Comments" })).toBeNull());
    expect(comments).toHaveAttribute("data-comment-mode", "on");
    expect(comments).toHaveAttribute("aria-pressed", "true");
    expect(comments).toHaveAttribute("title", "Click something to comment on it");
    // Clicking it again ends comment mode without opening the pane.
    await user.click(comments);
    expect(comments).toHaveAttribute("data-comment-mode", "off");
    expect(screen.queryByRole("dialog", { name: "Comments" })).toBeNull();
  });
});

describe("Canvas", () => {
  it("moves a unit locally while dragging and saves the layout once, on drop", async () => {
    const memory = canvasMemory(typicalLayout);
    const { client, sent } = counting(memory.client);
    mount(client);
    const header = within(
      await screen.findByRole("region", { name: "Project by Status" }),
    ).getByRole("heading").parentElement!.parentElement!;
    const factor = scale();

    fireEvent.pointerDown(header, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(document, { clientX: 100 + 60 * factor, clientY: 100 + 30 * factor });
    // Local while the gesture is live: shown, not saved.
    expect(unitBox(unitIds.chart).style.left).toBe("92px");
    expect(sent).not.toContain("update");
    fireEvent.pointerUp(document);

    await waitFor(async () =>
      expect(
        (await savedLayout(memory)).units.find((unit) => unit.id === unitIds.chart),
      ).toMatchObject({
        x: 92,
        y: 534,
        w: 540,
        h: 360,
      }),
    );
    expect(sent.filter((operation) => operation === "update")).toHaveLength(1);
  });

  it("keeps a unit another tab added during a drag when the drop saves", async () => {
    const memory = canvasMemory(typicalLayout);
    mount(memory.client);
    const header = within(
      await screen.findByRole("region", { name: "Project by Status" }),
    ).getByRole("heading").parentElement!.parentElement!;
    const factor = scale();

    fireEvent.pointerDown(header, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(document, { clientX: 100 + 60 * factor, clientY: 100 + 30 * factor });
    // Another tab adds a unit while the drag is live.
    const read = await memory.client.session.request({
      operation: "get",
      session_id: sessionId,
      overlay: false,
    });
    const added = { ...typicalLayout.units[1]!, id: "from-another-tab", x: 2000, y: 2000 };
    await act(() =>
      memory.client.session.request({
        operation: "update",
        session_id: sessionId,
        patch: { layout: { ...typicalLayout, units: [...typicalLayout.units, added] } },
      }),
    );
    fireEvent.pointerUp(document);

    await waitFor(async () => {
      const units = (await savedLayout(memory)).units;
      expect(units.find((unit) => unit.id === unitIds.chart)).toMatchObject({ x: 92, y: 534 });
      expect(units.map((unit) => unit.id)).toContain("from-another-tab");
    });
  });

  it("keeps the scale a drag started at until it drops, so the unit follows the pointer", async () => {
    // A viewport the layout fits at full size, so a taller plane would refit.
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(3000);
    const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(1000);
    const memory = canvasMemory(typicalLayout);
    mount(memory.client);
    const header = within(
      await screen.findByRole("region", { name: "Project by Status" }),
    ).getByRole("heading").parentElement!.parentElement!;
    expect(scale()).toBe(1);
    fireEvent.pointerDown(header, { button: 0, clientX: 100, clientY: 100 });
    // Dragging the bottom unit further down grows the plane's bounds.
    fireEvent.pointerMove(document, { clientX: 100, clientY: 500 });
    expect(scale()).toBe(1);
    expect(unitBox(unitIds.chart).style.top).toBe("904px");
    fireEvent.pointerUp(document);
    await waitFor(async () =>
      expect(
        (await savedLayout(memory)).units.find((unit) => unit.id === unitIds.chart),
      ).toMatchObject({ y: 904 }),
    );
    width.mockRestore();
    height.mockRestore();
  });

  it("saves a layout that meets an agent's stage at once, keeping the agent's change", async () => {
    const memory = canvasMemory(typicalLayout);
    let raced = false;
    const { client, sent } = counting(memory.client, async (input) => {
      // The agent stages between the canvas's read and its layout save.
      if (input.operation === "update" && !raced) {
        raced = true;
        await stageAs(memory.asAgent(turns.first), [change(2, "f_budget", money("99000"))]);
      }
    });
    mount(client);
    await screen.findByRole("region", { name: "Project by Status" });
    drag(screen.getByRole("separator", { name: "Resize Project by Status" }), 75, 75);

    await waitFor(async () =>
      expect(
        (await savedLayout(memory)).units.find((unit) => unit.id === unitIds.chart),
      ).toMatchObject({
        // The canvas opens at full size: the corner moves 75 plane pixels each way.
        w: 615,
        h: 435,
      }),
    );
    // Layout updates are last-write-wins: the save lands without a retry.
    expect(sent.filter((operation) => operation === "update")).toHaveLength(1);
    const entries = await memory.client.session.request({
      operation: "entries",
      session_id: sessionId,
    });
    expect(entries.entries.map((entry) => entry.record_id)).toEqual([projectId(2)]);
  });

  it("adds a unit at the first free slot and saves it", async () => {
    const memory = canvasMemory({ units: [typicalLayout.units[0]!] });
    mount(memory.client);
    const user = userEvent.setup();
    await screen.findByRole("region", { name: "Projects" });
    await user.click(screen.getAllByRole("button", { name: "Add to canvas" })[0]!);
    const form = await screen.findByRole("form", { name: "Add to canvas" });
    await user.click(within(form).getByRole("radio", { name: "Chart" }));
    // Option columns come first, so a new chart groups by Status.
    expect(within(form).getByLabelText("Group by")).toHaveDisplayValue("Status");
    await user.click(within(form).getByRole("button", { name: "Add chart" }));

    const before: CanvasLayout = { units: [typicalLayout.units[0]!] };
    await waitFor(async () => expect((await savedLayout(memory)).units).toHaveLength(2));
    const added = (await savedLayout(memory)).units[1]!;
    expect(added).toMatchObject({
      kind: "chart",
      // A grid canvas (the default) places it after the table, half width.
      ...placeGrid(addUnit(before, "chart", {}, added.id)).units[1],
      config: {
        model_id: "m_project",
        group_by: "f_status",
        metric: { fn: "count" },
        kind: "breakdown",
      },
      span: 6,
    });
    expect(await screen.findByRole("region", { name: "Project by Status" })).toBeInTheDocument();
  });

  it("removes a unit from the layout", async () => {
    const memory = canvasMemory(typicalLayout);
    mount(memory.client);
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: "Remove Project by Owner" }));
    await waitFor(async () =>
      expect((await savedLayout(memory)).units.map((unit) => unit.id)).toEqual([
        unitIds.grid,
        unitIds.chart,
      ]),
    );
    expect(screen.queryByRole("region", { name: "Project by Owner" })).not.toBeInTheDocument();
  });

  it("zooms with the buttons as view state only: nothing is saved", async () => {
    const memory = canvasMemory(typicalLayout);
    const { client, sent } = counting(memory.client);
    mount(client);
    await screen.findByRole("region", { name: "Projects" });
    const user = userEvent.setup();
    const zoom = within(screen.getByRole("group", { name: "Canvas zoom" }));
    // The canvas opens at full size.
    expect(scale()).toBe(1);
    await user.click(zoom.getByRole("button", { name: "Zoom in" }));
    expect(scale()).toBeGreaterThan(1);
    await user.click(zoom.getByRole("button", { name: "Zoom out" }));
    await user.click(zoom.getByRole("button", { name: "Zoom out" }));
    expect(scale()).toBeLessThan(1);
    await user.click(zoom.getByRole("button", { name: "Fit to view" }));
    expect(scale()).toBeLessThanOrEqual(1);
    expect(sent).not.toContain("update");
  });

  it("anchors a thread to the grid cell clicked in comment mode and opens it", async () => {
    const memory = canvasMemory(typicalLayout);
    mount(memory.client);
    const user = userEvent.setup();
    await waitFor(() =>
      expect(
        document.querySelector(`[row-id="${projectId(3)}"] [col-id="f_estimate"]`),
      ).not.toBeNull(),
    );
    await commentOn(user);
    await user.click(document.querySelector(`[row-id="${projectId(3)}"] [col-id="f_estimate"]`)!);

    await waitFor(async () => {
      const header = await memory.client.session.request({
        operation: "get",
        session_id: sessionId,
        overlay: false,
      });
      expect(
        Object.values(header.threads).map((thread) => (thread as { anchor: unknown }).anchor),
      ).toEqual([
        {
          unit_id: unitIds.grid,
          model_id: "m_project",
          record_id: projectId(3),
          field_id: "f_estimate",
        },
      ]);
    });
    // The sheet opens on it, named by record and column, and comment mode ends.
    const sheet = await screen.findByRole("dialog", { name: "Thread" });
    expect(within(sheet).getByText(/Data warehouse refresh/u)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Comments/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("anchors to the unit when the click lands on a unit without a target", async () => {
    const memory = canvasMemory(typicalLayout);
    mount(memory.client);
    const user = userEvent.setup();
    const chart = await screen.findByRole("region", { name: "Project by Status" });
    await commentOn(user);
    await user.click(within(chart).getByRole("heading"));
    await waitFor(async () => {
      const header = await memory.client.session.request({
        operation: "get",
        session_id: sessionId,
        overlay: false,
      });
      expect(
        Object.values(header.threads).map((thread) => (thread as { anchor: unknown }).anchor),
      ).toEqual([{ unit_id: unitIds.chart }]);
    });
  });

  it("anchors to a unit from the keyboard in comment mode", async () => {
    const memory = canvasMemory(typicalLayout);
    mount(memory.client);
    const user = userEvent.setup();
    const chart = await screen.findByRole("region", { name: "Project by Status" });
    expect(chart).not.toHaveAttribute("tabindex");
    await commentOn(user);
    chart.focus();
    await user.keyboard("{Enter}");
    await waitFor(async () => {
      const header = await memory.client.session.request({
        operation: "get",
        session_id: sessionId,
        overlay: false,
      });
      expect(
        Object.values(header.threads).map((thread) => (thread as { anchor: unknown }).anchor),
      ).toEqual([{ unit_id: unitIds.chart }]);
    });
  });

  it("shows a pushed agent revision on the badge and the impact line, and brings it into view", async () => {
    const memory = canvasMemory(typicalLayout);
    await seedTypical(memory);
    mount(memory.client);
    const staged = await screen.findByRole("button", { name: "Unsaved changes, 6" });
    expect(staged).not.toHaveAttribute("data-pulse");
    await tableShows(7);

    // The pulse is brief: record that it starts, however slowly the test runs.
    let pulsed = false;
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations)
        if (mutation.target === staged && staged.hasAttribute("data-pulse")) pulsed = true;
    });
    observer.observe(staged, { attributes: true, attributeFilter: ["data-pulse"] });
    await act(() => agentStagesTurn(memory));
    await screen.findByRole("button", { name: "Unsaved changes, 9" });
    await waitFor(() => expect(pulsed).toBe(true));
    observer.disconnect();
    // Every value is on the table, on screen here: it flashes them, with no toast.
    expect(screen.queryByText(/^Agent (staged|changed)/)).toBeNull();
    const user = userEvent.setup();
    // The staged pane lists the turn, under the impact line.
    await user.click(screen.getByRole("button", { name: "Unsaved changes, 9" }));
    const pane = await screen.findByRole("dialog", { name: "Unsaved changes" });
    await waitFor(() =>
      expect(
        within(pane).getByRole("status", { name: "Impact of unsaved changes" }),
      ).toHaveTextContent("8 records changed"),
    );
    expect(within(pane).getByText("Agent turn 3")).toBeInTheDocument();
  });

  describe("following the agent's off-screen changes", () => {
    /** Counts the plane's scrolls, by its viewport's scrollTo. */
    async function watchScrolls() {
      const plane = await screen.findByRole("region", { name: "Canvas" });
      const scrollTo = vi.fn();
      plane.scrollTo = scrollTo;
      return () => scrollTo.mock.calls.length;
    }
    /** Records each element that flashes, however briefly. */
    function watchFlashes() {
      const seen = new Set<Element>();
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations)
          if (
            mutation.target instanceof Element &&
            mutation.target.hasAttribute("data-canvas-flash")
          )
            seen.add(mutation.target);
      });
      observer.observe(document.body, {
        attributes: true,
        attributeFilter: ["data-canvas-flash"],
        subtree: true,
      });
      return {
        cells: () =>
          [...seen]
            .filter((element) => element.hasAttribute("col-id"))
            .map(
              (element) =>
                `${element.closest("[row-id]")?.getAttribute("row-id")}/${element.getAttribute("col-id")}`,
            ),
        units: () =>
          [...seen]
            .map((element) => element.getAttribute("data-unit-box"))
            .filter((id) => id !== null),
        count: () => seen.size,
        [Symbol.dispose]: () => observer.disconnect(),
      };
    }
    /** Every box matching `selector` lies far below the plane's viewport (the test setup puts all on screen). */
    function offScreen(selector: string) {
      const onScreen = HTMLElement.prototype.getBoundingClientRect;
      const spy = vi
        .spyOn(HTMLElement.prototype, "getBoundingClientRect")
        .mockImplementation(function (this: HTMLElement) {
          return this.matches(selector) ? new DOMRect(0, 5000, 200, 40) : onScreen.call(this);
        });
      return { [Symbol.dispose]: () => spy.mockRestore() };
    }
    const cell = (n: number, fieldId: string) => `${projectId(n)}/${fieldId}`;
    const rendered = (n: number, fieldId: string) =>
      document.querySelector(`[row-id="${projectId(n)}"] [col-id="${fieldId}"]`) !== null;

    it("scrolls to a loaded but off-screen row and flashes every loaded changed cell", async () => {
      const memory = canvasMemory(typicalLayout);
      await seedTypical(memory);
      mount(memory.client);
      const planeScrolls = await watchScrolls();
      await screen.findByRole("button", { name: "Unsaved changes, 6" });
      await tableShows(7);
      using _cells = offScreen(".ag-cell");
      using flashes = watchFlashes();
      await act(() => agentStagesTurn(memory));
      await waitFor(() => expect(flashes.cells()).toContain(cell(7, "f_budget")));
      const others = [cell(9, "f_budget"), cell(10, "f_status")].filter((_, index) =>
        index === 0 ? rendered(9, "f_budget") : rendered(10, "f_status"),
      );
      expect(others.length).toBeGreaterThan(0);
      await waitFor(() => expect(flashes.cells()).toEqual(expect.arrayContaining(others)));
      expect(planeScrolls()).toBeGreaterThan(0);
      expect(screen.queryByText(/^Agent changed/)).toBeNull();
    });

    it("centres the changed cell in the plane and flashes it only once the scroll settles", async () => {
      const memory = canvasMemory(typicalLayout);
      await seedTypical(memory);
      mount(memory.client);
      const plane = await screen.findByRole("region", { name: "Canvas" });
      const scrollTo = vi.fn();
      plane.scrollTo = scrollTo;
      await screen.findByRole("button", { name: "Unsaved changes, 6" });
      await tableShows(7);
      using _cells = offScreen(".ag-cell");
      using flashes = watchFlashes();
      await act(() => agentStagesTurn(memory));
      await waitFor(() => expect(scrollTo).toHaveBeenCalled());
      // The cell (0, 5000, 200 × 40) centred: its middle at the viewport's middle.
      const view = plane.getBoundingClientRect();
      expect(scrollTo).toHaveBeenLastCalledWith({
        left: Math.max(0, 100 - view.left - plane.clientWidth / 2),
        top: 5020 - view.top - plane.clientHeight / 2,
        behavior: "smooth",
      });
      // Still scrolling: nothing flashes yet.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
      });
      expect(flashes.count()).toBe(0);
      // Settled: the cell flashes.
      fireEvent(plane, new Event("scrollend"));
      await waitFor(() => expect(flashes.cells()).toContain(cell(7, "f_budget")));
    });

    it("flashes an entry already on screen without scrolling", async () => {
      const memory = canvasMemory(typicalLayout);
      await seedTypical(memory);
      mount(memory.client);
      const planeScrolls = await watchScrolls();
      await screen.findByRole("button", { name: "Unsaved changes, 6" });
      await tableShows(7);
      using flashes = watchFlashes();
      await act(() => agentStagesTurn(memory));
      await waitFor(() => expect(flashes.cells()).toContain(cell(7, "f_budget")));
      expect(planeScrolls()).toBe(0);
      expect(screen.queryByText(/^Agent changed/)).toBeNull();
    });

    it("scrolls to the change it focuses when only another changed cell is on screen", async () => {
      const memory = canvasMemory(typicalLayout);
      await seedTypical(memory);
      mount(memory.client);
      const planeScrolls = await watchScrolls();
      await screen.findByRole("button", { name: "Unsaved changes, 6" });
      await tableShows(7);
      // Only the focused change's cell is below the fold; the others are in view.
      using _cell = offScreen(`[row-id="${projectId(7)}"] [col-id="f_budget"]`);
      using flashes = watchFlashes();
      await act(() => agentStagesTurn(memory));
      await waitFor(() => expect(planeScrolls()).toBeGreaterThan(0));
      const plane = screen.getByRole("region", { name: "Canvas" });
      fireEvent(plane, new Event("scrollend"));
      await waitFor(() => expect(flashes.cells()).toContain(cell(7, "f_budget")));
    });

    it("keeps the toast only while the person is mid-gesture", async () => {
      const memory = canvasMemory(typicalLayout);
      await seedTypical(memory);
      mount(memory.client);
      const planeScrolls = await watchScrolls();
      await screen.findByRole("button", { name: "Unsaved changes, 6" });
      await tableShows(7);
      using _cells = offScreen(".ag-cell");
      using flashes = watchFlashes();
      const handle = screen.getByRole("separator", { name: "Resize Project by Status" });
      fireEvent.pointerDown(handle, { button: 0, clientX: 100, clientY: 100 });
      await act(() => agentStagesTurn(memory));
      await screen.findByText("Agent changed 3 values");
      expect(flashes.count()).toBe(0);
      expect(planeScrolls()).toBe(0);
      fireEvent.pointerUp(document);
      // View brings the first one into view.
      await userEvent.setup().click(screen.getByRole("button", { name: "View" }));
      await waitFor(() => expect(flashes.cells()).toContain(cell(7, "f_budget")));
    });

    it("keeps the toast only while a pane is open", async () => {
      const memory = canvasMemory(typicalLayout);
      await seedTypical(memory);
      mount(memory.client);
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Unsaved changes, 6" }));
      await screen.findByRole("dialog", { name: "Unsaved changes" });
      using flashes = watchFlashes();
      await act(() => agentStagesTurn(memory));
      await screen.findByText("Agent changed 3 values");
      expect(flashes.count()).toBe(0);
    });

    it("toasts a value no table shows; View opens the staged pane at it", async () => {
      const memory = canvasMemory(typicalLayout);
      await seedTypical(memory);
      mount(memory.client);
      await screen.findByRole("button", { name: "Unsaved changes, 6" });
      using flashes = watchFlashes();
      await act(() =>
        stageAs(memory.asAgent(turns.second), [
          {
            model_id: "m_person",
            record_id: personId(1),
            field_id: "f_role",
            value: { type: "text", value: "Lead" },
          },
        ]),
      );
      await screen.findByText("Agent changed 1 value");
      expect(flashes.count()).toBe(0);
      await userEvent.setup().click(screen.getByRole("button", { name: "View" }));
      await screen.findByRole("dialog", { name: "Unsaved changes" });
    });

    it("brings a unit the agent added off screen into view and flashes its frame", async () => {
      const memory = canvasMemory(typicalLayout);
      mount(memory.client);
      await screen.findByRole("region", { name: "Project by Status" });
      const planeScrolls = await watchScrolls();
      using _units = offScreen("[data-unit-box]");
      using flashes = watchFlashes();
      const layout = await savedLayout(memory);
      await act(() =>
        send(memory.asAgent(turns.second), {
          operation: "update",
          patch: {
            layout: {
              ...layout,
              units: [
                ...layout.units,
                {
                  id: "u-note",
                  kind: "note",
                  config: { text: "Budgets to check" },
                  x: 32,
                  y: 2400,
                  w: 400,
                  h: 200,
                },
              ],
            },
          },
        }),
      );
      await waitFor(() => expect(flashes.units()).toEqual(["u-note"]));
      expect(planeScrolls()).toBeGreaterThan(0);
    });

    it("with reduced motion, jumps instead of scrolling smoothly and holds the flash without fading", async () => {
      const media = vi.mocked(window.matchMedia);
      const motion = media.getMockImplementation()!;
      media.mockImplementation((query: string) => ({
        ...motion(query),
        matches: query.includes("prefers-reduced-motion"),
      }));
      const animate = vi.fn();
      Object.defineProperty(HTMLElement.prototype, "animate", {
        configurable: true,
        writable: true,
        value: animate,
      });
      try {
        const memory = canvasMemory(typicalLayout);
        mount(memory.client);
        await screen.findByRole("region", { name: "Project by Status" });
        const plane = await screen.findByRole("region", { name: "Canvas" });
        const scrollTo = vi.fn();
        plane.scrollTo = scrollTo;
        using _units = offScreen("[data-unit-box]");
        const layout = await savedLayout(memory);
        await act(() =>
          send(memory.asAgent(turns.second), {
            operation: "update",
            patch: {
              layout: {
                ...layout,
                units: [
                  ...layout.units,
                  {
                    id: "u-note",
                    kind: "note",
                    config: { text: "" },
                    x: 32,
                    y: 2400,
                    w: 400,
                    h: 200,
                  },
                ],
              },
            },
          }),
        );
        await waitFor(() => expect(animate).toHaveBeenCalled());
        expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: "auto" }));
        const [frames, timing] = animate.mock.calls[0]!;
        expect(frames).toHaveLength(2);
        expect(frames[0]).toEqual(frames[1]);
        expect(timing).not.toHaveProperty("easing");
      } finally {
        media.mockImplementation(motion);
        delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
      }
    });

    it("does not follow a unit the person added", async () => {
      const memory = canvasMemory(typicalLayout);
      mount(memory.client);
      await screen.findByRole("region", { name: "Project by Status" });
      const planeScrolls = await watchScrolls();
      using flashes = watchFlashes();
      const user = userEvent.setup();
      await user.click(screen.getAllByRole("button", { name: "Add to canvas" })[0]!);
      const form = await screen.findByRole("form", { name: "Add to canvas" });
      await user.click(within(form).getByRole("radio", { name: "Chart" }));
      await user.click(within(form).getByRole("button", { name: "Add chart" }));
      await waitFor(async () => expect((await savedLayout(memory)).units).toHaveLength(4));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
      });
      expect(planeScrolls()).toBe(0);
      expect(flashes.count()).toBe(0);
    });
  });

  it("toasts an agent's reply and proposal on a thread; Open opens it in place", async () => {
    const memory = canvasMemory(typicalLayout);
    await seedTypical(memory);
    mount(memory.client);
    await screen.findByRole("button", { name: "Unsaved changes, 6" });
    await act(() =>
      send(memory.asAgent(turns.second), {
        operation: "thread_reply",
        thread_id: threadIds.chart,
        message: "Yes, until they are cancelled.",
      }),
    );
    await screen.findByText("Agent replied on Project by Status");
    await act(() =>
      send(memory.asAgent(turns.second), {
        operation: "propose",
        thread_id: threadIds.cell,
        changes: [change(2, "f_budget", money("145000"))],
      }),
    );
    await screen.findByText("Agent proposed changes on Customer portal · Budget");
    const open = screen.getAllByRole("button", { name: "Open" });
    await userEvent.setup().click(open.at(-1)!);
    const popover = await screen.findByRole("dialog", { name: "Thread" });
    expect(
      within(popover).getByRole("button", { name: "Add to unsaved changes" }),
    ).toBeInTheDocument();
  });

  it("does not toast an agent's reply on the thread open in its popover", async () => {
    const memory = canvasMemory(typicalLayout);
    await seedTypical(memory);
    mount(memory.client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Comments, 2" }));
    await user.click(
      within(await screen.findByRole("dialog", { name: "Comments" })).getByRole("button", {
        name: /Project by Status/u,
      }),
    );
    const popover = await screen.findByRole("dialog", { name: "Thread" });
    await act(() =>
      send(memory.asAgent(turns.second), {
        operation: "thread_reply",
        thread_id: threadIds.chart,
        message: "Yes, until they are cancelled.",
      }),
    );
    await within(popover).findByText("Yes, until they are cancelled.");
    expect(screen.queryByText("Agent replied on Project by Status")).not.toBeInTheDocument();
  });

  it("names the records a proposal on an unanchored thread changes and links to", async () => {
    const memory = canvasMemory(typicalLayout);
    await seedTypical(memory);
    await send(memory.asAgent(turns.second), {
      operation: "propose",
      thread_id: threadIds.chart,
      changes: [
        change(2, "f_budget", money("145000")),
        change(7, "f_owner", {
          type: "relation",
          value: { type: "record_id", value: personId(4) },
        }),
        change(9, "f_owner", { type: "relation", value: { type: "external_key", value: "P-6" } }),
      ],
    });
    mount(memory.client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Comments, 2" }));
    const pane = await screen.findByRole("dialog", { name: "Comments" });
    await user.click(within(pane).getByRole("button", { name: /Project by Status/u }));
    const changes = within(await screen.findByRole("dialog", { name: "Thread" })).getByRole(
      "list",
      { name: "Proposed changes" },
    );
    await waitFor(() =>
      expect(
        within(changes)
          .getAllByRole("listitem")
          .map((item) => item.textContent),
      ).toEqual([
        expect.stringContaining("Customer portal"),
        expect.stringMatching(/Support chatbot.*Tomás Lindqvist/u),
        expect.stringMatching(/Partner API.*Kwame Mensah/u),
      ]),
    );
    expect(changes).not.toHaveTextContent("outside this view");
  });

  it("renames a thread's record in the Comments pane when someone else renames it", async () => {
    const memory = canvasMemory(typicalLayout);
    await seedTypical(memory);
    mount(memory.client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Comments, 2" }));
    let pane = await screen.findByRole("dialog", { name: "Comments" });
    expect(await within(pane).findByText(/Customer portal/u)).toBeInTheDocument();
    act(() => {
      memory.writeCanonical("m_project", projectId(2), {
        f_name: { type: "text", value: "Client portal" },
      });
    });
    pane = await screen.findByRole("dialog", { name: "Comments" });
    expect(await within(pane).findByText(/Client portal/u)).toBeInTheDocument();
    expect(within(pane).queryByText(/Customer portal/u)).toBeNull();
  });

  it("toasts staged values changed underneath by someone else; Review opens the log at them", async () => {
    const memory = canvasMemory(typicalLayout);
    await seedTypical(memory);
    mount(memory.client);
    await screen.findByRole("button", { name: "Unsaved changes, 6" });
    act(() => {
      memory.writeCanonical("m_project", projectId(2), { f_budget: money("70000") });
      memory.removeRecord("m_project", projectId(5));
    });
    // Project 5 has two staged values; project 2 one.
    await screen.findByText("Someone else changed 3 values you have not saved yet");
    await userEvent.setup().click(screen.getByRole("button", { name: "Review" }));
    const pane = await screen.findByRole("dialog", { name: "Unsaved changes" });
    await waitFor(() => expect(pane.querySelectorAll("[data-focused]")).toHaveLength(3));
    expect(
      [...pane.querySelectorAll("[data-focused]")].every(
        (entry) => entry.hasAttribute("data-stale") || entry.hasAttribute("data-gone"),
      ),
    ).toBe(true);
  });

  it("shows pending drafts by default; Show drafts off reads published data only", async () => {
    const memory = canvasMemory(typicalLayout, 12, {});
    const [published] = await memory.client.data.list("m_project", {
      asOf: "2026-10-01",
      where: [{ field: "id", op: "eq", value: projectId(3) }],
    });
    const estimate = String(published!.estimate);
    // Someone's pending draft makes project 3's estimate 777.
    memory.seedDraft({
      actorId: "user-ravi",
      changes: [change(3, "f_estimate", { type: "number", value: "777" })],
    });
    const reads: unknown[] = [];
    const client: CanvasClient = {
      ...memory.client,
      data: {
        list: (model, input) => {
          reads.push(input.includePendingDrafts);
          return memory.client.data.list(model, input);
        },
        aggregate: (model, input) => {
          reads.push(input.includePendingDrafts);
          return memory.client.data.aggregate(model, input);
        },
      },
    };
    mount(client);
    const cell = () => document.querySelector(`[row-id="${projectId(3)}"] [col-id="f_estimate"]`);
    await waitFor(() => expect(cell()).toHaveTextContent("777"));
    const toggle = screen.getByRole("checkbox", { name: "Show drafts" });
    expect(toggle).toBeChecked();
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((flag) => flag === true)).toBe(true);
    reads.length = 0;
    await userEvent.setup().click(toggle);
    expect(toggle).not.toBeChecked();
    await waitFor(() => expect(cell()).toHaveTextContent(estimate));
    expect(document.querySelector("[data-show-drafts]")).toHaveAttribute(
      "title",
      "Showing published data only",
    );
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((flag) => flag === undefined)).toBe(true);
    // View state only: nothing about it is saved.
    expect((await savedLayout(memory)).units).toEqual(typicalLayout.units);
  });

  it("Show drafts off shows a money cell's published value, not the draft's", async () => {
    const memory = canvasMemory(typicalLayout, 12, {});
    // Someone's pending draft makes project 3's budget $999,000.
    memory.seedDraft({
      actorId: "user-ravi",
      changes: [change(3, "f_budget", money("999000"))],
    });
    mount(memory.client);
    const cell = () => document.querySelector(`[row-id="${projectId(3)}"] [col-id="f_budget"]`);
    await waitFor(() => expect(cell()).toHaveTextContent("$999,000"));
    await userEvent.setup().click(screen.getByRole("checkbox", { name: "Show drafts" }));
    await waitFor(() => expect(cell()).not.toHaveTextContent("$999,000"));
    expect(cell()!.textContent).toMatch(/\$\d/u);
  });

  it("marks values from pending drafts quietly, and only with Show drafts on", async () => {
    const memory = canvasMemory(typicalLayout, 12, {});
    // Someone's pending drafts: project 3's estimate, and a new project.
    const changed = memory.seedDraft({
      actorId: "user-ravi",
      changes: [change(3, "f_estimate", { type: "number", value: "777" })],
    });
    const newId = projectId(99);
    const created = memory.seedDraft({
      actorId: "user-ravi",
      changes: [],
      creates: [
        {
          model_id: "m_project",
          record_id: newId,
          values: {
            f_name: { type: "text", value: "Draft launch plan" },
            f_estimate: { type: "number", value: "12" },
          },
        },
      ],
    });
    mount(memory.client);
    const cell = (id: string, field: string) =>
      document.querySelector(`[row-id="${id}"] [col-id="${field}"]`);
    await waitFor(() => expect(cell(projectId(3), "f_estimate")).toHaveTextContent("777"));
    // The changed value names its draft on hover.
    const mark = cell(projectId(3), "f_estimate")!.querySelector("[data-cell-mark]");
    expect(mark).toHaveAttribute("title", `In draft #${changed}`);
    expect(mark).toHaveTextContent("draft");
    // Published values carry no mark.
    expect(cell(projectId(3), "f_name")!.querySelector("[data-cell-mark]")).toBeNull();
    expect(cell(projectId(4), "f_estimate")!.querySelector("[data-cell-mark]")).toBeNull();
    // The new record's row is marked once, on its name.
    await waitFor(() => expect(cell(newId, "f_name")).toHaveTextContent("Draft launch plan"));
    expect(cell(newId, "f_name")!.querySelector("[data-cell-mark]")).toHaveAttribute(
      "title",
      `New in draft #${created}. Edit it in Review.`,
    );
    expect(cell(newId, "f_estimate")!.querySelector("[data-cell-mark]")).toBeNull();
    // Off: the published data, with no marks at all.
    await userEvent.setup().click(screen.getByRole("checkbox", { name: "Show drafts" }));
    await waitFor(() => expect(cell(newId, "f_name")).toBeNull());
    await waitFor(() => expect(cell(projectId(3), "f_estimate")).not.toHaveTextContent("777"));
    expect(document.querySelector("[data-cell-mark]")).toBeNull();
  });

  it("a record a pending draft creates is read-only in the grid", async () => {
    const memory = canvasMemory(typicalLayout, 12, {});
    const newId = projectId(99);
    memory.seedDraft({
      actorId: "user-ravi",
      changes: [],
      creates: [
        {
          model_id: "m_project",
          record_id: newId,
          values: { f_name: { type: "text", value: "Draft launch plan" } },
        },
      ],
    });
    const { client, sent } = counting(memory.client);
    mount(client);
    const user = userEvent.setup();
    const name = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(`[row-id="${newId}"] [col-id="f_client"]`);
      expect(found).not.toBeNull();
      return found!;
    });
    await user.dblClick(name);
    expect(name.querySelector("input")).toBeNull();
    expect(sent).not.toContain("stage");
    // A published row still edits.
    const other = document.querySelector<HTMLElement>(
      `[row-id="${projectId(3)}"] [col-id="f_client"]`,
    )!;
    await user.dblClick(other);
    await waitFor(() => expect(other.querySelector("input")).not.toBeNull());
  });

  it("a staged entry shows its cell on the canvas and flashes it", async () => {
    const memory = canvasMemory(typicalLayout);
    await seedTypical(memory);
    mount(memory.client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Unsaved changes, 6" }));
    const pane = await screen.findByRole("dialog", { name: "Unsaved changes" });
    await waitFor(() =>
      expect(
        document.querySelector(`[row-id="${projectId(3)}"] [col-id="f_estimate"]`),
      ).not.toBeNull(),
    );
    const entry = await within(pane).findByText("Data warehouse refresh");
    await user.click(entry.closest("button")!);
    expect(screen.queryByRole("dialog", { name: "Unsaved changes" })).toBeNull();
    await waitFor(() =>
      expect(
        document.querySelector(`[row-id="${projectId(3)}"] [col-id="f_estimate"]`),
      ).toHaveAttribute("data-canvas-flash"),
    );
  });

  it("a staged entry scrolls its table to a loaded row off screen, else opens its record", async () => {
    // 130 projects: the table loads the first 100 by name and renders only some of them.
    const memory = canvasMemory(typicalLayout, 130);
    const page = (offset: number) =>
      memory.client.data.list("m_project", {
        asOf: "2026-10-01",
        work: { sessionId },
        orderBy: [
          { field: "name", direction: "asc" },
          { field: "id", direction: "asc" },
        ],
        offset,
        limit: 100,
      });
    const byName = [...(await page(0)), ...(await page(100))];
    const offScreen = byName[80]!;
    const notLoaded = byName[120]!;
    await stageAs(memory.client.session, [
      { ...change(1, "f_estimate", { type: "number", value: "41" }), record_id: offScreen.id },
      { ...change(1, "f_estimate", { type: "number", value: "42" }), record_id: notLoaded.id },
    ]);
    mount(memory.client);
    const user = userEvent.setup();
    await screen.findByText("100 of 130 Project records");
    const cell = (id: string) => document.querySelector(`[row-id="${id}"] [col-id="f_estimate"]`);
    expect(cell(offScreen.id)).toBeNull();

    await user.click(await screen.findByRole("button", { name: "Unsaved changes, 2" }));
    let pane = await screen.findByRole("dialog", { name: "Unsaved changes" });
    await user.click(within(pane).getByText(String(offScreen.name)).closest("button")!);
    // The table scrolls the row into view (the brief flash is cosmetic and may
    // already have ended on a slow runner).
    await waitFor(() => expect(cell(offScreen.id)).not.toBeNull());
    expect(document.querySelector("dialog[open]")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Unsaved changes, 2" }));
    pane = await screen.findByRole("dialog", { name: "Unsaved changes" });
    await user.click(within(pane).getByText(String(notLoaded.name)).closest("button")!);
    // The drawer is named by the record, with its model as the line above.
    const drawer = await screen.findByRole("dialog", { name: String(notLoaded.name) });
    expect(within(drawer).getByText("Project")).toBeInTheDocument();
  });

  it("places a rule that arrives mid-drag after the drop, keeping the moved unit", async () => {
    const memory = canvasMemory(typicalLayout);
    const { client, sent } = counting(memory.client);
    mount(client);
    const header = within(
      await screen.findByRole("region", { name: "Project by Status" }),
    ).getByRole("heading").parentElement!.parentElement!;
    const factor = scale();
    fireEvent.pointerDown(header, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(document, { clientX: 100 + 60 * factor, clientY: 100 + 30 * factor });
    const { revision } = await memory.client.session.request({
      operation: "get",
      session_id: sessionId,
      overlay: false,
    });
    await act(async () => {
      await memory.asAgent(turns.second).request({
        operation: "rule_create",
        session_id: sessionId,
        expected_revision: revision,
        request_id: crypto.randomUUID(),
        rule_id: "r-hold",
        rule: holdLongProjects,
      });
    });
    // Nothing is saved while the drag is live.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(sent).not.toContain("update");
    fireEvent.pointerUp(document);
    await waitFor(async () => {
      const units = (await savedLayout(memory)).units;
      expect(units.find((unit) => unit.id === unitIds.chart)).toMatchObject({ x: 92, y: 534 });
      expect(units.some((unit) => unit.kind === "rule" && unit.config.rule_id === "r-hold")).toBe(
        true,
      );
    });
  });

  it("keeps a rule card placed between a press and the drag that follows it", async () => {
    const memory = canvasMemory(typicalLayout);
    mount(memory.client);
    const header = within(
      await screen.findByRole("region", { name: "Project by Status" }),
    ).getByRole("heading").parentElement!.parentElement!;
    const factor = scale();
    // Pressed, not yet dragged past the threshold.
    fireEvent.pointerDown(header, { button: 0, clientX: 100, clientY: 100 });
    const { revision } = await memory.client.session.request({
      operation: "get",
      session_id: sessionId,
      overlay: false,
    });
    await act(async () => {
      await memory.asAgent(turns.second).request({
        operation: "rule_create",
        session_id: sessionId,
        expected_revision: revision,
        request_id: crypto.randomUUID(),
        rule_id: "r-hold",
        rule: holdLongProjects,
      });
    });
    await screen.findByRole("region", { name: "Put long projects on hold" });
    await waitFor(async () =>
      expect(
        (await savedLayout(memory)).units.some(
          (unit) => unit.kind === "rule" && unit.config.rule_id === "r-hold",
        ),
      ).toBe(true),
    );
    fireEvent.pointerMove(document, { clientX: 100 + 60 * factor, clientY: 100 + 30 * factor });
    fireEvent.pointerUp(document);
    await waitFor(async () =>
      expect(
        (await savedLayout(memory)).units.find((unit) => unit.id === unitIds.chart),
      ).toMatchObject({ x: 92, y: 534 }),
    );
    expect(
      (await savedLayout(memory)).units.some(
        (unit) => unit.kind === "rule" && unit.config.rule_id === "r-hold",
      ),
    ).toBe(true);
    expect(screen.getByRole("region", { name: "Put long projects on hold" })).toBeInTheDocument();
  });

  it("places a card for each rule once, finds it from the Rules pane, and removes it with the rule", async () => {
    const memory = canvasMemory(typicalLayout);
    await seedTypical(memory);
    const { client, sent } = counting(memory.client);
    mount(client);
    const card = await screen.findByRole("region", { name: "Put long projects on hold" });
    await waitFor(async () =>
      expect((await savedLayout(memory)).units.at(-1)).toMatchObject({
        kind: "rule",
        config: { rule_id: "r-hold" },
        ...freeSlot(typicalLayout, unitSizes.rule),
        ...unitSizes.rule,
      }),
    );
    expect(sent.filter((operation) => operation === "update")).toHaveLength(1);
    // The card goes with its rule: the frame has no remove of its own.
    expect(
      within(card).queryByRole("button", { name: "Remove Put long projects on hold" }),
    ).toBeNull();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Rules, 1" }));
    const pane = await screen.findByRole("dialog", { name: "Rules" });
    await user.click(within(pane).getByRole("button", { name: /Put long projects on hold/u }));
    await waitFor(() =>
      expect(unitBox(unitIdOf(memory, card))).toHaveAttribute("data-canvas-flash"),
    );

    await user.click(within(card).getByRole("button", { name: "Remove" }));
    await user.click(within(card).getByRole("button", { name: /^Remove rule and its changes\?/u }));
    await waitFor(async () =>
      expect((await savedLayout(memory)).units.map((unit) => unit.kind)).toEqual([
        "grid",
        "chart",
        "graph",
      ]),
    );
    expect(screen.queryByRole("region", { name: "Put long projects on hold" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Rules, / })).toBeNull();
  });

  it("opens a record in a drawer from its row's open control, and closes back to the canvas", async () => {
    const memory = canvasMemory(typicalLayout);
    mount(memory.client);
    await waitFor(() =>
      expect(document.querySelector(`[row-id="${projectId(2)}"] [col-id="f_name"]`)).not.toBeNull(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Open Customer portal" }));
    // One heading: the record's name, with the model as the line above it, and
    // no section heading or repeated name row under it.
    const drawer = await screen.findByRole("dialog", { name: "Customer portal" });
    expect(within(drawer).getAllByRole("heading")).toHaveLength(1);
    expect(within(drawer).getByText("Project")).toBeInTheDocument();
    expect(within(drawer).queryByText("Details")).toBeNull();
    expect(within(drawer).queryByText("Customer portal", { selector: "dd" })).toBeNull();
    await userEvent.setup().click(within(drawer).getByRole("button", { name: "Close sheet" }));
    expect(screen.queryByRole("dialog", { name: "Customer portal" })).toBeNull();
    expect(screen.getByRole("region", { name: "Projects" })).toBeInTheDocument();
  });

  it("the record drawer marks a pending draft's value and a draft-created record", async () => {
    const memory = canvasMemory(typicalLayout, 12, {});
    const changed = memory.seedDraft({
      actorId: "user-ravi",
      changes: [change(2, "f_estimate", { type: "number", value: "777" })],
    });
    const created = memory.seedDraft({
      actorId: "user-ravi",
      changes: [],
      creates: [
        {
          model_id: "m_project",
          record_id: projectId(99),
          values: { f_name: { type: "text", value: "Draft launch plan" } },
        },
      ],
    });
    mount(memory.client);
    await waitFor(() =>
      expect(document.querySelector(`[row-id="${projectId(2)}"] [col-id="f_name"]`)).not.toBeNull(),
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Open Customer portal" }));
    let drawer = await screen.findByRole("dialog", { name: "Customer portal" });
    await waitFor(() =>
      expect(drawer.querySelector("[data-draft-mark]")).toHaveAttribute(
        "title",
        `In draft #${changed}`,
      ),
    );
    expect(drawer.querySelectorAll("[data-draft-mark]")).toHaveLength(1);
    await user.click(within(drawer).getByRole("button", { name: "Close sheet" }));
    await user.click(await screen.findByRole("button", { name: "Open Draft launch plan" }));
    drawer = await screen.findByRole("dialog", { name: "Draft launch plan" });
    await waitFor(() =>
      expect(drawer.querySelector("[data-draft-mark]")).toHaveAttribute(
        "title",
        `New in draft #${created}. Edit it in Review.`,
      ),
    );
  });

  it("in comment mode, the drawer shows the name's row so a thread can anchor to it", async () => {
    const memory = canvasMemory(typicalLayout);
    mount(memory.client);
    await waitFor(() =>
      expect(document.querySelector(`[row-id="${projectId(2)}"] [col-id="f_name"]`)).not.toBeNull(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Open Customer portal" }));
    const drawer = await screen.findByRole("dialog", { name: "Customer portal" });
    const user = userEvent.setup();
    await commentOn(user);
    await user.click(await within(drawer).findByRole("button", { name: "Project" }));
    await waitFor(async () => {
      const header = await memory.client.session.request({
        operation: "get",
        session_id: sessionId,
        overlay: false,
      });
      expect(
        Object.values(header.threads).map((thread) => (thread as { anchor: unknown }).anchor),
      ).toEqual([{ model_id: "m_project", record_id: projectId(2), field_id: "f_name" }]);
    });
  });

  it("opens a cell's thread beside the cell, and one with nothing on screen in the centre", async () => {
    const original = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "getBoundingClientRect",
    )!.value as (this: HTMLElement) => DOMRect;
    const rects = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const box = (x: number, y: number, w: number, h: number) =>
          ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h }) as DOMRect;
        if (this.getAttribute("role") === "region" && this.getAttribute("aria-label") === "Canvas")
          return box(0, 40, 1400, 800);
        if (this.getAttribute("col-id") === "f_budget" && this.closest("[row-id]") !== null)
          return box(300, 60, 120, 32);
        // The centred placeholder.
        if (this.matches("[aria-hidden].fixed")) return box(320, 200, 360, 0);
        return original.call(this);
      });
    const memory = canvasMemory(typicalLayout);
    await seedTypical(memory);
    await send(memory.client.session, {
      operation: "thread_open",
      thread_id: "00000000-0000-4000-8000-0000000000d9",
      anchor: {},
    });
    await send(memory.client.session, {
      operation: "thread_reply",
      thread_id: "00000000-0000-4000-8000-0000000000d9",
      message: "About the whole plan",
    });
    mount(memory.client);
    const pin = await screen.findByRole("button", { name: /^1 open thread on Budget/u });
    fireEvent.click(pin);
    const beside = await screen.findByRole("dialog", { name: "Thread" });
    // Just below the cell, at its left edge.
    await waitFor(() => expect(beside.style.top).toBe("96px"));
    expect(within(beside).getByText(/Customer portal · Budget/u)).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Comments, 3" }));
    await user.click(
      within(await screen.findByRole("dialog", { name: "Comments" })).getByRole("button", {
        name: /About the whole plan/u,
      }),
    );
    const centred = await screen.findByRole("dialog", { name: "Thread" });
    await within(centred).findByText("About the whole plan");
    // Below the centred placeholder.
    await waitFor(() => expect(centred.style.top).toBe("204px"));
    rects.mockRestore();
  });

  it("filters the grid by the chart bar selected, and tells the host", async () => {
    const memory = canvasMemory(typicalLayout);
    const heard = vi.fn();
    mount(memory.client, heard);
    const grid = await screen.findByRole("region", { name: "Projects" });
    await waitFor(() =>
      expect(within(grid).getByText("12 of 12 Project records")).toBeInTheDocument(),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Inspect On hold" }));

    await waitFor(() =>
      expect(within(grid).getByText("2 of 2 Project records")).toBeInTheDocument(),
    );
    expect(within(grid).getByText("Filtered by Status: On hold")).toBeInTheDocument();
    expect(heard).toHaveBeenLastCalledWith({
      kind: "segment",
      unit_id: unitIds.chart,
      model_id: "m_project",
      field_id: "f_status",
      value: "on_hold",
    });
  });

  it("starts another session with no selection carried over", async () => {
    const memory = canvasMemory(typicalLayout);
    const other = "00000000-0000-4000-8000-0000000000aa";
    await memory.client.session.request({
      operation: "create",
      session_id: other,
      expected_revision: 0,
      request_id: crypto.randomUUID(),
      title: "Other",
      as_of: "2026-10-01",
      layout: typicalLayout,
    } as WorkSessionRequest);
    const heard = vi.fn();
    const view = mount(memory.client, heard);
    fireEvent.click(await screen.findByRole("button", { name: "Inspect On hold" }));
    const grid = await screen.findByRole("region", { name: "Projects" });
    await waitFor(() =>
      expect(within(grid).getByText("2 of 2 Project records")).toBeInTheDocument(),
    );
    view.rerender(
      <div style={{ width: 1400, height: 900 }}>
        <Canvas client={memory.client} sessionId={other} onSelectionChange={heard} />
      </div>,
    );
    // The host hears that the new session starts with nothing selected.
    await waitFor(() => expect(heard).toHaveBeenLastCalledWith(null));
    await waitFor(() =>
      expect(
        within(screen.getByRole("region", { name: "Projects" })).getByText(
          "12 of 12 Project records",
        ),
      ).toBeInTheDocument(),
    );
  });

  it("steps a pin through every open thread on its target, one per click", async () => {
    const memory = canvasMemory(typicalLayout);
    for (const [id, message] of [
      ["00000000-0000-4000-8000-0000000000b1", "First question"],
      ["00000000-0000-4000-8000-0000000000b2", "Second question"],
    ] as const) {
      const { revision } = await memory.client.session.request({
        operation: "get",
        session_id: sessionId,
        overlay: false,
      });
      await memory.client.session.request({
        operation: "thread_open",
        session_id: sessionId,
        expected_revision: revision,
        request_id: crypto.randomUUID(),
        thread_id: id,
        anchor: { unit_id: unitIds.chart },
      });
      await memory.client.session.request({
        operation: "thread_reply",
        session_id: sessionId,
        expected_revision: revision + 1,
        request_id: crypto.randomUUID(),
        thread_id: id,
        message,
      });
    }
    mount(memory.client);
    const pin = await screen.findByRole("button", { name: /^2 open threads on / });
    fireEvent.click(pin);
    expect(
      await within(await screen.findByRole("dialog")).findByText("First question"),
    ).toBeInTheDocument();
    fireEvent.click(pin);
    const sheet = await screen.findByRole("dialog");
    expect(await within(sheet).findByText("Second question")).toBeInTheDocument();
    expect(within(sheet).queryByText("First question")).toBeNull();
  });

  it("lists every open thread, including ones on a whole record or on nothing", async () => {
    const memory = canvasMemory(typicalLayout);
    for (const [id, anchor, message] of [
      [
        "00000000-0000-4000-8000-0000000000c1",
        { model_id: "m_project", record_id: projectId(1) },
        "About this project",
      ],
      ["00000000-0000-4000-8000-0000000000c2", {}, "About the whole plan"],
    ] as const) {
      const { revision } = await memory.client.session.request({
        operation: "get",
        session_id: sessionId,
        overlay: false,
      });
      await memory.asAgent(turns.first).request({
        operation: "thread_open",
        session_id: sessionId,
        expected_revision: revision,
        request_id: crypto.randomUUID(),
        thread_id: id,
        anchor,
      });
      await memory.asAgent(turns.first).request({
        operation: "thread_reply",
        session_id: sessionId,
        expected_revision: revision + 1,
        request_id: crypto.randomUUID(),
        thread_id: id,
        message,
      });
    }
    mount(memory.client);
    const user = userEvent.setup();
    const comments = await screen.findByRole("button", { name: "Comments, 2" });
    await user.click(comments);
    const pane = await screen.findByRole("dialog", { name: "Comments" });
    await user.click(within(pane).getByRole("button", { name: /About the whole plan/ }));
    expect(screen.queryByRole("dialog", { name: "Comments" })).toBeNull();
    expect(
      await within(await screen.findByRole("dialog", { name: "Thread" })).findByText(
        "About the whole plan",
      ),
    ).toBeInTheDocument();
    await user.click(comments);
    await user.click(
      within(await screen.findByRole("dialog", { name: "Comments" })).getByRole("button", {
        name: /About this project/,
      }),
    );
    expect(
      await within(await screen.findByRole("dialog", { name: "Thread" })).findByText(
        "About this project",
      ),
    ).toBeInTheDocument();
  });

  it("lists and opens a thread whose anchor is not an object", async () => {
    const memory = canvasMemory(typicalLayout);
    const id = "00000000-0000-4000-8000-0000000000c3";
    const { revision } = await memory.client.session.request({
      operation: "get",
      session_id: sessionId,
      overlay: false,
    });
    await memory.asAgent(turns.first).request({
      operation: "thread_open",
      session_id: sessionId,
      expected_revision: revision,
      request_id: crypto.randomUUID(),
      thread_id: id,
      anchor: null,
    });
    await memory.asAgent(turns.first).request({
      operation: "thread_reply",
      session_id: sessionId,
      expected_revision: revision + 1,
      request_id: crypto.randomUUID(),
      thread_id: id,
      message: "About nothing in particular",
    });
    mount(memory.client);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Comments, 1" }));
    const pane = await screen.findByRole("dialog", { name: "Comments" });
    const item = within(pane).getByRole("button", { name: /About nothing in particular/ });
    expect(item).toHaveTextContent("Canvas");
    fireEvent.click(item);
    expect(
      await within(await screen.findByRole("dialog", { name: "Thread" })).findByText(
        "About nothing in particular",
      ),
    ).toBeInTheDocument();
  });
});
