// The grid unit and record panel over the in-memory canvas client: rows over
// the session, the staged layer, staging and reverting through the session,
// the selection filter, paging, and opening a record.
import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useMemo, useState } from "react";
import type { WorkChange } from "@autograph/generated-app-runtime/data";
import { describe, expect, it, vi } from "vite-plus/test";

import { bootstrapAgGrid } from "@modules/editable-grid";

import { CanvasKernelError, withPendingDrafts } from "../client";
import { CommentModeProvider } from "../comment-mode";
import {
  GridUnit,
  maxListOffset,
  openColumnId,
  pickerPage,
  focusedCell,
  rangeCells,
  useSessionRows,
} from "../grid-unit";
import { createMemoryCanvasClient } from "../memory-client";
import { RecordPanel } from "../record-panel";
import { moneyDefaults, titleField } from "../record-values";
import { createSelectionStore, type CanvasSelection, type SelectionStore } from "../selection";
import { useCanvasSession } from "../use-canvas-session";
import {
  change,
  gridDefinition,
  gridMemory,
  gridRows,
  money,
  personId,
  projectId,
  sessionId,
  stageAs,
  turns,
  withStagedValues,
} from "../stories/fixtures/grid";

bootstrapAgGrid();

type Memory = ReturnType<typeof gridMemory>;

function mount(
  memory: Memory,
  options: {
    selection?: CanvasSelection;
    onCellClicked?: (cell: { recordId: string; fieldId: string }) => void;
    pageSize?: number;
  } = {},
) {
  const opened = vi.fn();
  let store: SelectionStore | null = null;
  function Harness() {
    const session = useCanvasSession(memory.client, sessionId);
    const selection = useMemo(() => {
      const created = createSelectionStore(memory.client.definition);
      if (options.selection) created.select(options.selection);
      return created;
    }, []);
    store = selection;
    const [open, setOpen] = useState<string | null>(null);
    if (session.status !== "ready") return null;
    return (
      <div style={{ width: 1200, height: 600 }}>
        <GridUnit
          client={memory.client}
          session={session}
          selection={selection}
          unitId="grid-1"
          modelId="m_project"
          pageSize={options.pageSize}
          onOpenRecord={(id) => {
            opened(id);
            setOpen(id);
          }}
          onCellClicked={options.onCellClicked}
        />
        {open === null ? null : (
          <RecordPanel
            client={memory.client}
            session={session}
            modelId="m_project"
            recordId={open}
          />
        )}
      </div>
    );
  }
  const view = render(<Harness />);
  return { opened, store: () => store!, unmount: view.unmount };
}

const textValue = (value: string) => ({ type: "text" as const, value });
/** A row's open control (the button at the row's start). */
const openOf = (n: number) =>
  document.querySelector<HTMLElement>(`[row-id="${projectId(n)}"] [data-open-record]`);
const cell = (n: number, fieldId: string) =>
  document.querySelector<HTMLElement>(`[row-id="${projectId(n)}"] [col-id="${fieldId}"]`);
const entries = async (memory: Memory) =>
  (await memory.client.session.request({ operation: "entries", session_id: sessionId })).entries;

describe("grid unit", () => {
  it("selects the rows another unit picked, again after its rows reload, loading the page that has them", async () => {
    // Pages of 5: project 12 is on the third page.
    const memory = gridMemory();
    const { store } = mount(memory, { pageSize: 5 });
    await waitFor(() => expect(cell(1, "f_name")).not.toBeNull());
    const selected = (n: number) =>
      document
        .querySelector(`.ag-center-cols-container [row-id="${projectId(n)}"]`)
        ?.classList.contains("ag-row-selected") === true;
    act(() =>
      store().select({
        kind: "rows",
        unit_id: "chart-1",
        model_id: "m_project",
        record_ids: [projectId(12)],
      }),
    );
    await waitFor(() => expect(selected(12)).toBe(true));
    // A staged edit re-reads the grid's rows: the selection holds.
    await act(() => stageAs(memory.client.session, [change(1, "f_client", textValue("Acme"))]));
    await waitFor(() => expect(cell(1, "f_client")).toHaveTextContent("Acme"));
    await waitFor(() => expect(selected(12)).toBe(true));
    act(() => store().select(null));
    await waitFor(() => expect(selected(12)).toBe(false));
  });

  it("replaces the grid's own picks when it follows another unit's selection", async () => {
    const memory = gridMemory();
    const { store } = mount(memory);
    await waitFor(() => expect(cell(1, "f_name")).not.toBeNull());
    const selected = (n: number) =>
      document
        .querySelector(`.ag-center-cols-container [row-id="${projectId(n)}"]`)
        ?.classList.contains("ag-row-selected") === true;
    const checkbox = document.querySelector<HTMLInputElement>(
      `[row-id="${projectId(1)}"] .ag-selection-checkbox input`,
    );
    expect(checkbox).not.toBeNull();
    act(() => checkbox!.click());
    await waitFor(() => expect(selected(1)).toBe(true));
    act(() =>
      store().select({
        kind: "rows",
        unit_id: "chart-1",
        model_id: "m_project",
        record_ids: [projectId(2)],
      }),
    );
    await waitFor(() => expect(selected(2)).toBe(true));
    expect(selected(1)).toBe(false);
    act(() => store().select(null));
    await waitFor(() => expect(selected(2)).toBe(false));
    expect(selected(1)).toBe(false);
  });

  it("keeps a followed row selected when the grid takes over the selection", async () => {
    const memory = gridMemory();
    const { store } = mount(memory);
    await waitFor(() => expect(cell(1, "f_name")).not.toBeNull());
    const selected = (n: number) =>
      document
        .querySelector(`.ag-center-cols-container [row-id="${projectId(n)}"]`)
        ?.classList.contains("ag-row-selected") === true;
    act(() =>
      store().select({
        kind: "rows",
        unit_id: "chart-1",
        model_id: "m_project",
        record_ids: [projectId(1)],
      }),
    );
    await waitFor(() => expect(selected(1)).toBe(true));
    act(() =>
      document
        .querySelector<HTMLInputElement>(`[row-id="${projectId(2)}"] .ag-selection-checkbox input`)!
        .click(),
    );
    await waitFor(() => expect(selected(2)).toBe(true));
    expect(selected(1)).toBe(true);
    const selection = store().getSnapshot().selection;
    expect(selection?.kind === "rows" ? [...selection.record_ids].sort() : null).toEqual(
      [projectId(1), projectId(2)].sort(),
    );
  });

  it("loads a bounded number of pages to follow a far-off selected row", async () => {
    const memory = gridMemory(40);
    const { store } = mount(memory, { pageSize: 1 });
    const shown = () =>
      Number(/(\d+) of 40/.exec(screen.getByRole("status").textContent ?? "")?.[1] ?? 0);
    await waitFor(() => expect(shown()).toBe(1));
    // The last record by name: well past the pages the grid follows on its own.
    const last = gridRows(40)
      .m_project!.toSorted(
        (a, b) =>
          String((a.values.f_name as { value: string }).value).localeCompare(
            String((b.values.f_name as { value: string }).value),
          ) || a.id.localeCompare(b.id),
      )
      .at(-1)!.id;
    act(() =>
      store().select({
        kind: "rows",
        unit_id: "chart-1",
        model_id: "m_project",
        record_ids: [last],
      }),
    );
    // It loads exactly its five pages: a load asked for while one runs is not one of them.
    await waitFor(() => expect(shown()).toBe(6), { timeout: 3000 });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(shown()).toBe(6);
  });

  it("keeps the requested page window when an older refresh lands during a load", async () => {
    const memory = gridMemory(40);
    const pending: Array<{ offset: number; release: () => Promise<void> }> = [];
    const client = {
      ...memory.client,
      data: {
        ...memory.client.data,
        list: (...args: Parameters<typeof memory.client.data.list>) =>
          new Promise<Awaited<ReturnType<typeof memory.client.data.list>>>((resolve) => {
            pending.push({
              offset: args[1]?.offset ?? 0,
              release: async () => resolve(await memory.client.data.list(...args)),
            });
          }),
      },
    } as typeof memory.client;
    const model = memory.client.definition.models.find((item) => item.id === "m_project");
    const { result, rerender, unmount } = renderHook(
      ({ revision }) =>
        useSessionRows(
          client,
          model,
          { sessionId, asOf: "2026-10-01", where: [], revision, generation: revision },
          1,
        ),
      { initialProps: { revision: 0 } },
    );
    const release = (index: number) => act(async () => pending[index]!.release());
    try {
      await release(0);
      expect(result.current.records).toHaveLength(1);
      rerender({ revision: 1 }); // A one-page refresh starts first.
      let loading: Promise<boolean> | undefined;
      act(() => {
        loading = result.current.loadMore(); // Reserve a second page.
      });
      await release(1); // The earlier refresh lands while that load is pending.
      rerender({ revision: 2 });
      await release(3);
      expect(pending[4]?.offset).toBe(1); // The newest refresh must read both pages.
      await release(4);
      expect(result.current.records).toHaveLength(2);
      await release(2);
      await release(5);
      await act(async () => {
        await loading;
      });
      expect(result.current.records).toHaveLength(2);
    } finally {
      unmount();
    }
  });

  it("counts only the pages it loads toward following a row, not loads asked for while one runs", async () => {
    const memory = gridMemory(40);
    const slow = {
      ...memory.client,
      data: {
        ...memory.client.data,
        list: async (...args: Parameters<typeof memory.client.data.list>) => {
          await new Promise((resolve) => setTimeout(resolve, 40));
          return memory.client.data.list(...args);
        },
      },
    } as typeof memory.client;
    const { store } = mount({ ...memory, client: slow }, { pageSize: 1 });
    const shown = () =>
      Number(/(\d+) of 40/.exec(screen.getByRole("status").textContent ?? "")?.[1] ?? 0);
    await waitFor(() => expect(shown()).toBe(1));
    act(() =>
      store().select({
        kind: "rows",
        unit_id: "chart-1",
        model_id: "m_project",
        record_ids: [
          gridRows(40)
            .m_project!.toSorted(
              (a, b) =>
                String((a.values.f_name as { value: string }).value).localeCompare(
                  String((b.values.f_name as { value: string }).value),
                ) || a.id.localeCompare(b.id),
            )
            .at(-1)!.id,
        ],
      }),
    );
    // While it pages, the agent stages: each re-read refreshes the rows and the
    // follow runs again while a page is still loading.
    for (let n = 0; n < 6; n += 1)
      await act(async () => {
        await memory.asAgent(turns.first).request({
          operation: "stage",
          session_id: sessionId,
          changes: [
            {
              model_id: "m_project",
              record_id: projectId(1),
              field_id: "f_estimate",
              value: { type: "number", value: String(90 + n) },
            },
          ],
        });
        await new Promise((resolve) => setTimeout(resolve, 15));
      });
    await waitFor(() => expect(shown()).toBe(6), { timeout: 5000 });
  });

  it("pages no further than the kernel's list offset", async () => {
    const memory = gridMemory();
    const offsets: number[] = [];
    const client = {
      ...memory.client,
      data: {
        ...memory.client.data,
        list: async (_model: string, query: { offset?: number; limit?: number }) => {
          offsets.push(query.offset ?? 0);
          return Array.from({ length: query.limit ?? 0 }, (_, index) => ({
            record_id: `r${(query.offset ?? 0) + index}`,
            values: {},
          }));
        },
        aggregate: async () => ({ total: { metrics: ["50000"] } }),
      },
    } as unknown as typeof memory.client;
    const model = memory.client.definition.models.find((item) => item.id === "m_project");
    const pageSize = 4000;
    const { result } = renderHook(() =>
      useSessionRows(
        client,
        model,
        { sessionId, asOf: "2026-01-01", where: [], revision: 1, generation: 0 },
        pageSize,
      ),
    );
    await waitFor(() => expect(result.current.records).toHaveLength(4000));
    const more = async () => await act(() => result.current.loadMore());
    expect(await more()).toBe(true);
    expect(await more()).toBe(true);
    expect(result.current.records).toHaveLength(12000);
    // The next page would start past the kernel's bound: nothing is read.
    const before = offsets.length;
    expect(await more()).toBe(false);
    expect(offsets).toHaveLength(before);
    expect(Math.max(...offsets)).toBeLessThanOrEqual(maxListOffset);
  });

  it("orders a fully loaded model by name naturally (L2 before L10); a partial page keeps the kernel's order", async () => {
    const memory = gridMemory();
    for (let n = 1; n <= 12; n += 1)
      memory.writeCanonical("m_project", projectId(n), { f_name: textValue(`L${n}`) });
    const model = memory.client.definition.models.find((item) => item.id === "m_project");
    const input = { sessionId, asOf: "2026-10-01", where: [], revision: 1, generation: 0 };
    const names = (records: readonly { [name: string]: unknown }[]) =>
      records.map((record) => record.name);
    const all = renderHook(() => useSessionRows(memory.client, model, input, 100));
    await waitFor(() => expect(all.result.current.records).toHaveLength(12));
    expect(names(all.result.current.records)).toEqual(
      Array.from({ length: 12 }, (_, index) => `L${index + 1}`),
    );
    // A first page of five: what the next page continues, as the kernel ordered it.
    const page = renderHook(() => useSessionRows(memory.client, model, input, 5));
    await waitFor(() => expect(page.result.current.records).toHaveLength(5));
    expect(names(page.result.current.records)).toEqual(["L1", "L10", "L11", "L12", "L2"]);
  });

  it("shows the model's records by column header", async () => {
    mount(gridMemory());
    await waitFor(() => expect(cell(1, "f_name")).toHaveTextContent("Billing migration"));
    for (const header of ["Project", "Client", "Status", "Estimate (days)", "Budget", "Owner"])
      expect(screen.getAllByText(header).length).toBeGreaterThan(0);
    expect(cell(1, "f_status")).toHaveTextContent("Planned");
    expect(cell(1, "f_owner")).toHaveTextContent("Maya Okafor");
    expect(screen.getByRole("status")).toHaveTextContent("12 of 12 Project records");
    // No staged values: nothing reads "was".
    expect(document.querySelector(".ag-diff-was")).toBeNull();
  });

  it("leads with the records' name and starts key columns hidden", async () => {
    const [project, ...others] = gridDefinition.models;
    const definition = {
      ...gridDefinition,
      models: [
        {
          ...project,
          // The display field is named by the model, defined last, after a key column.
          display_field_id: "f_name",
          fields: [
            {
              id: "f_ref",
              name: "ref",
              label: "Project ref",
              type: "text",
              required: false,
              readOnly: false,
              is_unique: true,
            },
            ...project.fields.filter((field) => field.id !== "f_name"),
            project.fields.find((field) => field.id === "f_name")!,
          ],
        },
        ...others,
      ],
    };
    const rows = gridRows();
    const memory = createMemoryCanvasClient({
      definition,
      rows: {
        ...rows,
        m_project: rows.m_project!.map((row, index) => ({
          ...row,
          values: { ...row.values, f_ref: textValue(`PRJ-${index + 1}`) },
        })),
      },
      session: { id: sessionId, title: "Q4 planning", as_of: "2026-10-01" },
    });
    mount(memory);
    await waitFor(() => expect(cell(1, "f_name")).toHaveTextContent("Billing migration"));
    const headers = [...document.querySelectorAll<HTMLElement>(".ag-header-cell[col-id]")]
      .map((header) => header.getAttribute("col-id"))
      .filter((id) => id?.startsWith("f_"));
    expect(headers[0]).toBe("f_name");
    // The key column is not shown, but stays a column the Columns panel offers.
    expect(headers).not.toContain("f_ref");
    expect(cell(1, "f_ref")).toBeNull();
  });

  it("shows money as people read it, and a staged cell's value it replaced", async () => {
    const memory = await withStagedValues(gridMemory());
    mount(memory);
    await waitFor(() => expect(cell(1, "f_budget")).toHaveTextContent(/^\$\d{2,3},000$/u));
    // Monthly money keeps its cents and period.
    expect(cell(6, "f_budget")).toHaveTextContent(/^€[\d,]+\.00\/mo$/u);
    await waitFor(() =>
      expect(cell(2, "f_budget")).toHaveTextContent(/^\$95,000agent was \$[\d,]+$/u),
    );
    expect(cell(2, "f_budget")).not.toHaveTextContent("USD");
  });

  it("shows staged values with what they replaced and marks the agent's", async () => {
    const memory = await withStagedValues(gridMemory());
    mount(memory);
    await waitFor(() => expect(cell(2, "f_budget")).toHaveTextContent("95,000"));
    expect(cell(2, "f_budget")).toHaveTextContent(/agent.*was/u);
    expect(cell(2, "f_budget")!.querySelector("[data-agent-marker]")).not.toBeNull();
    // The user's own edit: "was …" without the agent marker.
    expect(cell(1, "f_status")).toHaveTextContent("Activewas Planned");
    expect(cell(1, "f_status")!.querySelector("[data-agent-marker]")).toBeNull();
  });

  it("stages an edit through the session and reverts it by unstaging", async () => {
    const memory = gridMemory();
    mount(memory);
    await waitFor(() => expect(cell(1, "f_client")).toHaveTextContent("Northwind"));
    const user = userEvent.setup();
    await user.dblClick(cell(1, "f_client")!);
    const input = await waitFor(() => within(cell(1, "f_client")!).getByRole("textbox"));
    await user.clear(input);
    await user.type(input, "Acme{Enter}");
    await waitFor(async () =>
      expect(await entries(memory)).toEqual([
        expect.objectContaining({
          record_id: projectId(1),
          field_id: "f_client",
          value: { type: "text", value: "Acme" },
          source: "user",
        }),
      ]),
    );
    await waitFor(() => expect(cell(1, "f_client")).toHaveTextContent("Acmewas Northwind"));

    await user.click(
      within(cell(1, "f_client")!).getByRole("button", { name: "Revert", hidden: true }),
    );
    await waitFor(async () => expect(await entries(memory)).toEqual([]));
    await waitFor(() => expect(cell(1, "f_client")).toHaveTextContent(/^Northwind$/u));
  });

  /** Grid reads (over pending drafts when `drafts`), held from `hold()` until `release()`. */
  function heldReads(memory: Memory, drafts = false) {
    const reads = withPendingDrafts(memory.client, drafts);
    const held: (() => void)[] = [];
    let holding = false;
    const list = reads.data.list;
    reads.data.list = async (modelId, query) => {
      if (holding && modelId === "m_project") await new Promise<void>((done) => held.push(done));
      return await list(modelId, query);
    };
    return {
      reads,
      held,
      hold: () => (holding = true),
      release: async () => {
        holding = false;
        await act(async () => {
          for (const done of held.splice(0)) done();
        });
      },
    };
  }
  /** Every text cell 1's Client shows from now on. */
  function watchClient() {
    const shown: string[] = [];
    const observer = new MutationObserver(() => shown.push(cell(1, "f_client")?.textContent ?? ""));
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    return { shown, stop: () => observer.disconnect() };
  }
  const stageClient = (session: Memory["client"]["session"], value: string) =>
    stageAs(session, [
      {
        model_id: "m_project",
        record_id: projectId(1),
        field_id: "f_client",
        value: { type: "text", value },
      },
    ]);
  const settling = () => cell(1, "f_client")!.querySelector("[data-settling]") !== null;

  for (const drafts of [false, true])
    it(`a revert changes the cell once: staged with a spinner until the re-read lands${drafts ? ", over pending drafts" : ""}`, async () => {
      const memory = gridMemory();
      if (drafts) {
        // A pending draft holds the field: Draftco over mainline Northwind.
        await stageClient(memory.client.session, "Draftco");
        const header = await memory.client.session.request({
          operation: "get",
          session_id: sessionId,
          overlay: false,
        });
        await memory.client.session.request({
          operation: "save",
          session_id: sessionId,
          expected_revision: header.revision,
          request_id: crypto.randomUUID(),
        });
      }
      await stageClient(memory.client.session, "Acme");
      // Over pending drafts the value beneath is the draft's, with its quiet mark.
      const beneath = drafts ? "Draftcodraft" : "Northwind";
      const reads = heldReads(memory, drafts);
      mount({ ...memory, client: reads.reads });
      await waitFor(() => expect(cell(1, "f_client")).toHaveTextContent("Acmewas Northwind"));
      const watch = watchClient();
      reads.hold();
      await userEvent
        .setup()
        .click(within(cell(1, "f_client")!).getByRole("button", { name: "Revert", hidden: true }));
      await waitFor(async () => expect(await entries(memory)).toEqual([]));
      await waitFor(() => expect(reads.held.length).toBeGreaterThan(0));
      // While the re-read is out the cell stays as it was, staged, with a spinner.
      expect(cell(1, "f_client")).toHaveTextContent("Acmewas Northwind");
      expect(settling()).toBe(true);
      await reads.release();
      await waitFor(() =>
        expect(cell(1, "f_client")).toHaveTextContent(new RegExp(`^${beneath}$`, "u")),
      );
      expect(settling()).toBe(false);
      watch.stop();
      // One step: staged, then the read's value; never the staged value bare.
      expect(watch.shown.filter((text) => text === "Acme")).toEqual([]);
      const settledAt = watch.shown.findIndex((text) => text === beneath);
      expect(watch.shown.slice(settledAt).filter((text) => text.includes("Acme"))).toEqual([]);
    });

  it("an edit shows the typed value from Enter on, never the old one while it stages", async () => {
    const memory = gridMemory();
    // Stages answer late, so the cell has time to show anything in between.
    const request = memory.client.session.request.bind(memory.client.session);
    memory.client.session.request = (async (input: Parameters<typeof request>[0]) => {
      if ((input as { operation: string }).operation === "stage")
        await new Promise((resolve) => setTimeout(resolve, 150));
      return await request(input);
    }) as typeof request;
    mount(memory);
    await waitFor(() => expect(cell(1, "f_client")).toHaveTextContent(/^Northwind$/u));
    const user = userEvent.setup();
    await user.dblClick(cell(1, "f_client")!);
    const input = await waitFor(() => within(cell(1, "f_client")!).getByRole("textbox"));
    await user.clear(input);
    await user.type(input, "Acme");
    const watch = watchClient();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(cell(1, "f_client")).toHaveTextContent("Acmewas Northwind"));
    watch.stop();
    const typedAt = watch.shown.findIndex((text) => text.startsWith("Acme"));
    expect(typedAt).toBeGreaterThanOrEqual(0);
    expect(watch.shown.slice(typedAt).filter((text) => !text.startsWith("Acme"))).toEqual([]);
  });

  it("a Save keeps the saved value shown, with a spinner, until the next read: never the value before it", async () => {
    const memory = gridMemory();
    await stageClient(memory.client.session, "Acme");
    const reads = heldReads(memory, true);
    mount({ ...memory, client: reads.reads });
    await waitFor(() => expect(cell(1, "f_client")).toHaveTextContent("Acmewas Northwind"));
    const watch = watchClient();
    reads.hold();
    const header = await memory.client.session.request({
      operation: "get",
      session_id: sessionId,
      overlay: false,
    });
    await act(async () => {
      await memory.client.session.request({
        operation: "save",
        session_id: sessionId,
        expected_revision: header.revision,
        request_id: crypto.randomUUID(),
      });
    });
    await waitFor(async () => expect(await entries(memory)).toEqual([]));
    await waitFor(() => expect(reads.held.length).toBeGreaterThan(0));
    await waitFor(() => expect(settling()).toBe(true));
    await reads.release();
    // Shown over pending drafts, the saved value is the draft's, with its quiet mark.
    await waitFor(() => expect(cell(1, "f_client")).toHaveTextContent(/^Acmedraft$/u));
    watch.stop();
    expect(
      watch.shown.filter((text) => text.includes("Northwind") && !text.includes("Acme")),
    ).toEqual([]);
  });

  it("a Save made before an edit's read lands keeps the saved value, with a spinner, never the old one", async () => {
    const memory = gridMemory();
    const reads = heldReads(memory, true);
    mount({ ...memory, client: reads.reads });
    await waitFor(() => expect(cell(1, "f_client")).toHaveTextContent(/^Northwind$/u));
    reads.hold();
    const user = userEvent.setup();
    await user.dblClick(cell(1, "f_client")!);
    const input = await waitFor(() => within(cell(1, "f_client")!).getByRole("textbox"));
    await user.clear(input);
    await user.type(input, "Acme{Enter}");
    await waitFor(() => expect(cell(1, "f_client")).toHaveTextContent("Acmewas Northwind"));
    // The edit's re-read is still out when the Save lands.
    const watch = watchClient();
    const header = await memory.client.session.request({
      operation: "get",
      session_id: sessionId,
      overlay: false,
    });
    await act(async () => {
      await memory.client.session.request({
        operation: "save",
        session_id: sessionId,
        expected_revision: header.revision,
        request_id: crypto.randomUUID(),
      });
    });
    await waitFor(async () => expect(await entries(memory)).toEqual([]));
    await waitFor(() => expect(settling()).toBe(true));
    expect(cell(1, "f_client")).toHaveTextContent("Acmewas Northwind");
    await reads.release();
    // Now the saved draft's value, with its quiet mark.
    await waitFor(() => expect(cell(1, "f_client")).toHaveTextContent(/^Acmedraft$/u));
    watch.stop();
    expect(watch.shown.filter((text) => !text.startsWith("Acme"))).toEqual([]);
  });

  it("Enter on a row's focused open control opens the record once", async () => {
    const memory = gridMemory();
    const { opened } = mount(memory);
    await waitFor(() => expect(openOf(1)).not.toBeNull());
    openOf(1)!.focus();
    await userEvent.setup().keyboard("{Enter}");
    await waitFor(() => expect(opened).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("without Enterprise cell ranges, only a focused field cell is a selection", () => {
    const at = (index: number) => (index === 0 ? { record_id: "r1" } : undefined);
    const fields = new Set(["f_name"]);
    const focus = (rowIndex: number | null, column: string) =>
      focusedCell({ rowIndex, column: { getColId: () => column } }, fields, at);
    expect(focus(0, "f_name")).toEqual({ record_id: "r1", field_id: "f_name" });
    expect(focus(0, "ag-Grid-SelectionColumn")).toBeNull();
    expect(focus(1, "f_name")).toBeNull();
    expect(focus(null, "f_name")).toBeNull();
  });

  it("a cell range across the open control selects only fields", () => {
    const column = (id: string) => ({ getColId: () => id });
    const rows = [{ record_id: "r1" }, { record_id: "r2" }];
    expect(
      rangeCells(
        [
          {
            startRow: { rowIndex: 1 },
            endRow: { rowIndex: 0 },
            columns: [column(openColumnId), column("f_name"), column("f_client")],
          },
        ],
        (index) => rows[index],
      ),
    ).toEqual([
      { record_id: "r1", field_id: "f_name" },
      { record_id: "r1", field_id: "f_client" },
      { record_id: "r2", field_id: "f_name" },
      { record_id: "r2", field_id: "f_client" },
    ]);
  });

  it("a picker ranks every match naturally, and keeps the kernel's order when it read only some", () => {
    const named = (labels: readonly string[]) => labels.map((label) => ({ label }));
    const levels = Array.from({ length: 30 }, (_, index) => `L${index + 1}`);
    // The kernel's text order: L1, L10 … L19, L2, L20 … L29, L3, L30, L4 …
    const textOrder = levels.toSorted();
    const all = pickerPage(named(textOrder), 20, 100);
    expect(all.options.map((option) => option.label)).toEqual(levels.slice(0, 20));
    expect(all.truncated).toBe(true);
    // A full scan may have stopped short: shown as the kernel ordered it.
    const partial = pickerPage(named(textOrder), 20, 30);
    expect(partial.options.map((option) => option.label)).toEqual(textOrder.slice(0, 20));
    expect(partial.truncated).toBe(true);
  });

  it("keeps a restore the session refused on the cell, in words", async () => {
    for (const [failure, note] of [
      [
        new CanvasKernelError(
          "authorization_denied",
          "authorization_denied: the session is closed",
        ),
        "Not restored. The session is closed",
      ],
      [
        new CanvasKernelError("revision_conflict", "revision_conflict: expected 2, found 3"),
        "Not restored. The session changed; check the value and try again.",
      ],
      [new Error("offline"), "Not confirmed: check the value"],
    ] as const) {
      const memory = gridMemory();
      await stageAs(memory.client.session, [
        {
          model_id: "m_project",
          record_id: projectId(1),
          field_id: "f_client",
          value: { type: "text", value: "Acme" },
        },
      ]);
      const client = {
        ...memory.client,
        session: {
          request: (input: Parameters<typeof memory.client.session.request>[0]) =>
            input.operation === "unstage"
              ? Promise.reject(failure)
              : memory.client.session.request(input),
        },
      } as typeof memory.client;
      const view = mount({ ...memory, client });
      await waitFor(() => expect(cell(1, "f_client")).toHaveTextContent("Acmewas Northwind"));
      await userEvent
        .setup()
        .click(within(cell(1, "f_client")!).getByRole("button", { name: "Revert", hidden: true }));
      await waitFor(() =>
        expect(within(cell(1, "f_client")!).getByRole("alert")).toHaveTextContent(note),
      );
      expect(await entries(memory)).toHaveLength(1);
      view.unmount();
    }
  });

  it("keeps an agent's value staged after the user clicked Restore and before it ran", async () => {
    const memory = gridMemory();
    await stageAs(memory.asAgent(turns.first), [
      change(1, "f_client", { type: "text", value: "Acme" }),
    ]);
    let release = () => {};
    let held = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = {
      ...memory.client,
      session: {
        request: async (input: Parameters<typeof memory.client.session.request>[0]) => {
          if (input.operation === "stage") {
            held += 1;
            await gate;
          }
          return memory.client.session.request(input);
        },
      },
    } as typeof memory.client;
    mount({ ...memory, client });
    await waitFor(() => expect(cell(1, "f_client")).toHaveTextContent("Acmeagent was Northwind"));
    const user = userEvent.setup();
    // Another edit holds the queue; Restore waits behind it.
    await user.dblClick(cell(2, "f_client")!);
    const input = await waitFor(() => within(cell(2, "f_client")!).getByRole("textbox"));
    await user.clear(input);
    await user.type(input, "Acme 2{Enter}");
    await waitFor(() => expect(held).toBe(1));
    await user.click(
      within(cell(1, "f_client")!).getByRole("button", { name: "Revert", hidden: true }),
    );
    // Meanwhile the agent replaces the value the user chose to restore.
    await stageAs(memory.asAgent(turns.first), [
      change(1, "f_client", { type: "text", value: "Hooli" }),
    ]);
    await act(async () => release());
    await waitFor(() =>
      expect(within(cell(1, "f_client")!).getByRole("alert")).toHaveTextContent(
        "Not restored. The session changed; check the value and try again.",
      ),
    );
    expect(await entries(memory)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          record_id: projectId(1),
          field_id: "f_client",
          value: { type: "text", value: "Hooli" },
          source: "agent",
        }),
        expect.objectContaining({ record_id: projectId(2), field_id: "f_client" }),
      ]),
    );
  });

  it("names linked records beyond the picker's first page, by id and by external key", async () => {
    const rows = gridRows();
    // 154 more people whose names sort first: the picker's first 100 never reach #150 or the six named people.
    for (let n = 7; n <= 160; n += 1)
      rows.m_person!.push({
        id: personId(n),
        values: {
          f_person_name: { type: "text", value: `Associate ${String(n).padStart(3, "0")}` },
        },
      });
    const memory = createMemoryCanvasClient({
      definition: gridDefinition,
      rows,
      session: { id: sessionId, title: "Q4 planning", as_of: "2026-10-01" },
    });
    memory.writeCanonical("m_project", projectId(1), {
      f_owner: { type: "relation", value: { type: "record_id", value: personId(150) } },
    });
    memory.writeCanonical("m_project", projectId(2), {
      f_owner: { type: "relation", value: { type: "external_key", value: "P-4" } },
    });
    // Project 3's owner is Priya (#3); a staged change keeps her as the baseline.
    await stageAs(memory.client.session, [
      {
        model_id: "m_project",
        record_id: projectId(3),
        field_id: "f_owner",
        value: { type: "relation", value: { type: "record_id", value: personId(140) } },
      },
    ]);
    mount(memory);
    await waitFor(() => expect(cell(1, "f_owner")).toHaveTextContent(/^Associate 150$/u));
    await waitFor(() => expect(cell(2, "f_owner")).toHaveTextContent(/^Tomás Lindqvist$/u));
    await waitFor(() =>
      expect(cell(3, "f_owner")).toHaveTextContent("Associate 140was Priya Natarajan"),
    );
  });

  it("shows a staged value the record has moved away from", async () => {
    const memory = await withStagedValues(gridMemory());
    memory.writeCanonical("m_project", projectId(2), { f_budget: money("70000") });
    mount(memory);
    await waitFor(() =>
      expect(cell(2, "f_budget")!.querySelector("[data-cell-note]")).toHaveTextContent(
        /Changed to \$70,000/u,
      ),
    );
    // One calm line under "was …", not an alert.
    expect(cell(2, "f_budget")!.querySelector("[data-cell-note]")).toHaveAttribute(
      "data-cell-note",
      "muted",
    );
    expect(within(cell(2, "f_budget")!).queryByRole("alert")).toBeNull();
  });

  it("never names a changed link by a record whose id equals its external key", async () => {
    const memory = await withStagedValues(gridMemory());
    memory.writeCanonical("m_project", projectId(5), {
      f_owner: { type: "relation", value: { type: "external_key", value: personId(1) } },
    });
    mount(memory);
    const note = await waitFor(() =>
      cell(5, "f_owner")!.querySelector<HTMLElement>("[data-cell-note]")!,
    );
    expect(note).toHaveTextContent("Changed to Unknown record");
  });

  it("narrows to another unit's filter and selects rows", async () => {
    const memory = gridMemory();
    const { store } = mount(memory, {
      selection: {
        kind: "segment",
        unit_id: "chart-1",
        model_id: "m_project",
        field_id: "f_status",
        value: "active",
      },
    });
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("5 of 5 Project records"),
    );
    expect(screen.getByText("Filtered by Status: Active")).toBeInTheDocument();
    expect(cell(1, "f_name")).toBeNull();

    await userEvent.setup().click(screen.getByRole("button", { name: "Clear filter" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("12 of 12"));
    expect(store().getSnapshot().selection).toBeNull();
  });

  it("names a graph node's external-key filter by the record's name", async () => {
    const memory = gridMemory();
    memory.writeCanonical("m_project", projectId(2), {
      f_owner: { type: "relation", value: { type: "external_key", value: "P-4" } },
    });
    mount(memory, {
      selection: {
        kind: "nodes",
        unit_id: "graph-1",
        model_id: "m_project",
        record_ids: [personId(4)],
        field_id: "f_owner",
        key: { type: "external_key", value: "P-4" },
      },
    });
    await waitFor(() =>
      expect(screen.getByText("Filtered by Owner: Tomás Lindqvist")).toBeInTheDocument(),
    );
  });

  it("reads a page of rows at a time", async () => {
    mount(gridMemory(250));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("100 of 250"));
    await userEvent.setup().click(screen.getByRole("button", { name: "Load 100 more" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("200 of 250"));
    await userEvent.setup().click(screen.getByRole("button", { name: "Load 50 more" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("250 of 250"));
    expect(screen.queryByRole("button", { name: /Load/u })).toBeNull();
  });

  it("re-reads when the agent stages, without losing loaded pages", async () => {
    const memory = gridMemory(250);
    mount(memory);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("100 of 250"));
    await userEvent.setup().click(screen.getByRole("button", { name: "Load 100 more" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("200 of 250"));
    const header = await memory.client.session.request({
      operation: "get",
      session_id: sessionId,
      overlay: false,
    });
    await act(async () => {
      await memory.asAgent(turns.first).request({
        operation: "stage",
        session_id: sessionId,
        changes: [
          {
            model_id: "m_project",
            record_id: projectId(1),
            field_id: "f_estimate",
            value: { type: "number", value: "99" },
          },
        ],
      });
    });
    await waitFor(() => expect(cell(1, "f_estimate")).toHaveTextContent(/99.*agent/u));
    expect(screen.getByRole("status")).toHaveTextContent("200 of 250");
  });

  it("stages edits made before the first answer one at a time, in order", async () => {
    const memory = gridMemory();
    const sent: unknown[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = {
      ...memory.client,
      session: {
        request: async (input: Parameters<typeof memory.client.session.request>[0]) => {
          if (input.operation === "stage") {
            sent.push(input.changes[0]!.value);
            await gate;
          }
          return memory.client.session.request(input);
        },
      },
    } as typeof memory.client;
    mount({ ...memory, client });
    await waitFor(() => expect(cell(1, "f_client")).toHaveTextContent("Northwind"));
    const user = userEvent.setup();
    for (const n of [1, 2]) {
      await user.dblClick(cell(n, "f_client")!);
      const input = await waitFor(() => within(cell(n, "f_client")!).getByRole("textbox"));
      await user.clear(input);
      await user.type(input, `Acme ${n}{Enter}`);
    }
    // The second edit waits for the first.
    expect(sent).toHaveLength(1);
    await act(async () => release());
    await waitFor(async () => expect(await entries(memory)).toHaveLength(2));
    expect(sent).toEqual([
      { type: "text", value: "Acme 1" },
      { type: "text", value: "Acme 2" },
    ]);
  });

  it("shows no rows of the previous filter when the new filter's read fails", async () => {
    const memory = gridMemory();
    let failing = false;
    const client = {
      ...memory.client,
      data: {
        ...memory.client.data,
        list: (modelId: string, input: Parameters<typeof memory.client.data.list>[1]) =>
          failing ? Promise.reject(new Error("offline")) : memory.client.data.list(modelId, input),
      },
    } as typeof memory.client;
    mount(
      { ...memory, client },
      {
        selection: {
          kind: "segment",
          unit_id: "chart-1",
          model_id: "m_project",
          field_id: "f_status",
          value: "active",
        },
      },
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("5 of 5 Project records"),
    );
    failing = true;
    await userEvent.setup().click(screen.getByRole("button", { name: "Clear filter" }));
    await waitFor(() =>
      expect(document.querySelectorAll(".ag-center-cols-container [row-id]")).toHaveLength(0),
    );
    expect(screen.getByText(/Could not load records/u)).toBeInTheDocument();
  });

  it("shows a canonical change heard on a reconnect at the same revision", async () => {
    const memory = gridMemory();
    mount(memory);
    await waitFor(() => expect(cell(1, "f_client")).toHaveTextContent("Northwind"));
    memory.writeCanonical("m_project", projectId(1), {
      f_client: { type: "text", value: "Globex" },
    });
    act(() => memory.reconnect(sessionId));
    await waitFor(() => expect(cell(1, "f_client")).toHaveTextContent("Globex"));
  });

  it("opening another record shows loading, never the last record's values", async () => {
    const memory = gridMemory();
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const client = {
      ...memory.client,
      data: {
        ...memory.client.data,
        list: async (modelId: string, input: Parameters<typeof memory.client.data.list>[1]) => {
          const where = input.where?.[0] as { field: string; value?: unknown } | undefined;
          if (where?.field === "id" && where.value === projectId(2)) await gate;
          return memory.client.data.list(modelId, input);
        },
      },
    } as typeof memory.client;
    mount({ ...memory, client });
    await waitFor(() => expect(cell(1, "f_name")).toHaveTextContent("Billing migration"));
    const user = userEvent.setup();
    await user.click(openOf(1)!);
    const panel = await screen.findByRole("article");
    await waitFor(() =>
      expect(within(panel).getByRole("heading", { level: 2 })).toHaveTextContent(
        "Billing migration",
      ),
    );
    await user.click(openOf(2)!);
    await waitFor(() =>
      expect(screen.getByRole("article")).not.toHaveTextContent("Billing migration"),
    );
    await act(async () => release());
    const second = cell(2, "f_name")!.textContent!;
    await waitFor(() =>
      expect(
        within(screen.getByRole("article")).getByRole("heading", { level: 2 }),
      ).toHaveTextContent(second),
    );
  });

  it("shows a re-read as it lands, even while a later re-read is still running", async () => {
    const memory = gridMemory();
    // Hold every records read until released, in order.
    const held: (() => void)[] = [];
    let holding = false;
    const list = memory.client.data.list;
    memory.client.data.list = async (modelId, query) => {
      if (holding && modelId === "m_project") await new Promise<void>((go) => held.push(go));
      return await list(modelId, query);
    };
    mount(memory);
    await waitFor(() => expect(cell(3, "f_client")).toHaveTextContent(/\S/u));
    holding = true;
    // Two changes in a row: each starts a re-read of the shown rows.
    act(() =>
      memory.writeCanonical("m_project", projectId(3), { f_client: textValue("Acme East") }),
    );
    await waitFor(() => expect(held).toHaveLength(1));
    act(() =>
      memory.writeCanonical("m_project", projectId(4), { f_client: textValue("Acme West") }),
    );
    await waitFor(() => expect(held).toHaveLength(2));
    // The first re-read lands while the second still runs: its rows show.
    await act(async () => held[0]!());
    await waitFor(() => expect(cell(3, "f_client")).toHaveTextContent("Acme East"));
    holding = false;
    await act(async () => held[1]!());
    await waitFor(() => expect(cell(4, "f_client")).toHaveTextContent("Acme West"));
  });

  it("keeps an open editor while the agent stages elsewhere", async () => {
    const memory = gridMemory();
    mount(memory);
    await waitFor(() => expect(cell(1, "f_client")).toHaveTextContent("Northwind"));
    const user = userEvent.setup();
    await user.dblClick(cell(1, "f_client")!);
    const input = await waitFor(() => within(cell(1, "f_client")!).getByRole("textbox"));
    await user.clear(input);
    await user.type(input, "Acm");
    const header = await memory.client.session.request({
      operation: "get",
      session_id: sessionId,
      overlay: false,
    });
    await act(async () => {
      await memory.asAgent(turns.first).request({
        operation: "stage",
        session_id: sessionId,
        changes: [
          {
            model_id: "m_project",
            record_id: projectId(3),
            field_id: "f_estimate",
            value: { type: "number", value: "99" },
          },
        ],
      });
    });
    await waitFor(() => expect(cell(3, "f_estimate")).toHaveTextContent(/99.*agent/u));
    const still = within(cell(1, "f_client")!).getByRole("textbox");
    expect(still).toHaveValue("Acm");
  });

  it("opens a record only from its row's open control; a cell click only selects", async () => {
    const memory = await withStagedValues(gridMemory());
    const { opened } = mount(memory);
    await waitFor(() => expect(cell(5, "f_name")).toHaveTextContent("Pricing page redesign"));
    const user = userEvent.setup();
    await user.click(cell(5, "f_budget")!);
    await user.click(cell(5, "f_name")!);
    expect(opened).not.toHaveBeenCalled();
    const open = screen.getByRole("button", { name: "Open Pricing page redesign" });
    expect(open).toBe(openOf(5));
    await user.click(open);
    expect(opened).toHaveBeenCalledWith(projectId(5));

    // The record panel: the staged values, what they replaced, and the agent marker.
    const panel = await screen.findByRole("article");
    await waitFor(() =>
      expect(within(panel).getByRole("heading", { level: 2 })).toHaveTextContent(
        "Pricing page redesign",
      ),
    );
    const budget = await waitFor(() =>
      panel.querySelector<HTMLElement>("[data-field-id='f_budget']")!,
    );
    expect(budget).toHaveTextContent(/\$82,500/u);
    expect(budget).toHaveTextContent(/was/u);
    expect(budget.querySelector("[data-agent-marker]")).not.toBeNull();
    await waitFor(() =>
      expect(panel.querySelector("[data-field-id='f_owner']")).toHaveTextContent(
        /Priya Natarajan.*was Hannah Weiss/u,
      ),
    );
    expect(panel.querySelector("[data-field-id='f_client'] [data-previous-value]")).toBeNull();
  });

  it("names a record's external-key link, and still shows the record when a link cannot be read", async () => {
    const owner = {
      type: "relation" as const,
      value: { type: "external_key" as const, value: "P-3" },
    };
    for (const linksFail of [false, true]) {
      const memory = gridMemory();
      await stageAs(memory.client.session, [
        { model_id: "m_project", record_id: projectId(5), field_id: "f_owner", value: owner },
      ]);
      const client = {
        ...memory.client,
        data: {
          ...memory.client.data,
          list: (modelId: string, input: Parameters<typeof memory.client.data.list>[1]) =>
            linksFail && modelId === "m_person"
              ? Promise.reject(new Error("offline"))
              : memory.client.data.list(modelId, input),
        },
      } as typeof memory.client;
      const view = mount({ ...memory, client });
      await waitFor(() => expect(cell(5, "f_name")).toHaveTextContent("Pricing page redesign"));
      await userEvent.setup().click(openOf(5)!);
      const panel = await screen.findByRole("article");
      await waitFor(() =>
        expect(within(panel).getByRole("heading", { level: 2 })).toHaveTextContent(
          "Pricing page redesign",
        ),
      );
      await waitFor(() =>
        expect(panel.querySelector("[data-field-id='f_owner']")).toHaveTextContent(
          linksFail ? /Unknown record/u : /Priya Natarajan/u,
        ),
      );
      view.unmount();
    }
  });

  it("shows a record's fields as skeletons while it is read, then its links once named", async () => {
    const memory = gridMemory();
    const gates: Record<string, () => void> = {};
    const reads: string[] = [];
    const client = {
      ...memory.client,
      data: {
        ...memory.client.data,
        list: async (modelId: string, input: Parameters<typeof memory.client.data.list>[1]) => {
          // The panel's own reads (by key) wait for the test; the grid's do not.
          if (input.limit === 1) {
            reads.push(modelId);
            await new Promise<void>((resolve) => (gates[modelId] = resolve));
          }
          return memory.client.data.list(modelId, input);
        },
      },
    } as typeof memory.client;
    function Panel() {
      const session = useCanvasSession(client, sessionId);
      if (session.status !== "ready") return null;
      return (
        <RecordPanel
          client={client}
          modelId="m_project"
          recordId={projectId(5)}
          session={session}
        />
      );
    }
    render(<Panel />);
    const panel = await screen.findByRole("article");
    // Reading the record: every field a skeleton, no "Loading…".
    await waitFor(() => expect(gates.m_project).toBeDefined());
    expect(panel).not.toHaveTextContent("Loading");
    expect(panel.querySelector("[data-field-id='f_budget'] [data-skeleton]")).not.toBeNull();
    act(() => gates.m_project!());
    // The record shows at once; only its link waits for its name.
    await waitFor(() =>
      expect(panel.querySelector("[data-field-id='f_budget']")).toHaveTextContent(/\$[\d,]+/u),
    );
    expect(panel.querySelector("[data-field-id='f_budget'] [data-skeleton]")).toBeNull();
    expect(panel.querySelector("[data-field-id='f_owner'] [data-skeleton]")).not.toBeNull();
    expect(panel.querySelector("[data-field-id='f_owner']")).not.toHaveTextContent("Unknown");
    await waitFor(() => expect(gates.m_person).toBeDefined());
    act(() => gates.m_person!());
    await waitFor(() =>
      expect(panel.querySelector("[data-field-id='f_owner']")).toHaveTextContent("Hannah Weiss"),
    );
    // One read for the record and one for its one link.
    expect(reads).toEqual(["m_project", "m_person"]);
  });

  it("passes cell clicks to comment mode", async () => {
    const onCellClicked = vi.fn();
    const { opened } = mount(gridMemory(), { onCellClicked });
    await waitFor(() => expect(cell(1, "f_name")).toHaveTextContent("Billing migration"));
    await userEvent.setup().click(cell(1, "f_name")!);
    expect(onCellClicked).toHaveBeenCalledWith({ recordId: projectId(1), fieldId: "f_name" });
    expect(opened).not.toHaveBeenCalled();
  });

  it("in comment mode, a record field's label opens a thread on that field", async () => {
    const memory = gridMemory();
    const threadOpen = vi.fn(async () => ({ ok: true as const, revision: 2 }));
    function Panel() {
      const session = useCanvasSession(memory.client, sessionId);
      if (session.status !== "ready") return null;
      return (
        <CommentModeProvider initiallyOn threadOpen={threadOpen} onOpened={() => {}}>
          <RecordPanel
            client={memory.client}
            session={session}
            modelId="m_project"
            recordId={projectId(5)}
          />
        </CommentModeProvider>
      );
    }
    render(<Panel />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Budget" }));
    expect(threadOpen).toHaveBeenCalledWith(expect.any(String), {
      model_id: "m_project",
      record_id: projectId(5),
      field_id: "f_budget",
    });
  });
});

describe("titleField", () => {
  it("names records by the first text column that is not retired", () => {
    const text = (id: string, lifecycle?: "retired") => ({
      id,
      name: id,
      label: id,
      type: "text",
      required: false,
      readOnly: false,
      ...(lifecycle === undefined ? {} : { lifecycle }),
    });
    const model = {
      id: "m",
      name: "m",
      label: "M",
      relations: [],
      fields: [text("f_old", "retired"), text("f_name")],
    } as unknown as Parameters<typeof titleField>[0];
    expect(titleField(model)?.id).toBe("f_name");
  });

  it("prefers a name over a unique key, and falls back to the key", () => {
    const text = (id: string, is_unique = false) => ({
      id,
      name: id,
      label: id,
      type: "text",
      required: false,
      readOnly: false,
      is_unique,
    });
    const model = (fields: ReturnType<typeof text>[]) =>
      ({ id: "m", name: "m", label: "M", relations: [], fields }) as unknown as Parameters<
        typeof titleField
      >[0];
    expect(titleField(model([text("f_ref", true), text("f_name")]))?.id).toBe("f_name");
    expect(titleField(model([text("f_ref", true)]))?.id).toBe("f_ref");
  });
});
