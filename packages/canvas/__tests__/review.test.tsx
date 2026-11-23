import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { describe, expect, test } from "vite-plus/test";

import { ToastProvider } from "@autograph/components";

import { CanvasKernelError, type CanvasClient } from "../client";
import { ImpactStrip } from "../impact-strip";
import type { MemoryCanvas } from "../memory-client";
import { Provenance, provenanceLines } from "../provenance";
import { SaveBar } from "../save-bar";
import { StagedLog } from "../staged-log";
import { useCanvasSession, type CanvasSession } from "../use-canvas-session";
import {
  budget,
  ids,
  project,
  pullProposal,
  reviewMemory,
  sessionId,
  stage,
  turns,
  twoTurnsAndEdits,
  values,
} from "../stories/fixtures/review";
import { recording } from "./fixture";

type Part = (props: { client: CanvasClient; session: CanvasSession }) => ReactNode;

function Mounted(props: { client: CanvasClient; part: Part }) {
  const session = useCanvasSession(props.client, sessionId);
  if (session.status !== "ready") return null;
  return <>{props.part({ client: props.client, session })}</>;
}
async function mount(client: CanvasClient, part: Part) {
  const view = render(
    <ToastProvider>
      <Mounted client={client} part={part} />
    </ToastProvider>,
  );
  await waitFor(() => expect(view.container.firstChild).not.toBeNull());
  return view;
}
const log: Part = ({ client, session }) => <StagedLog client={client} session={session} />;
const saveBar: Part = ({ client, session }) => <SaveBar client={client} session={session} />;
const ops = (calls: Record<string, unknown>[], operation: string) =>
  calls.filter((call) => call.operation === operation);
const machinery = [
  sessionId,
  turns.first,
  turns.second,
  "m_project",
  "f_budget",
  "f_status",
  "f_lead",
];
const noMachinery = (text: string) => {
  for (const id of [...machinery, ids.project("Billing revamp"), ids.person("Priya Raman")])
    expect(text).not.toContain(id);
};

async function seeded(setup: (memory: MemoryCanvas) => Promise<void> = twoTurnsAndEdits) {
  const memory = reviewMemory();
  await setup(memory);
  return memory;
}

describe("staged-change log", () => {
  test("groups agent turns by time, then your edits, by record name and column header", async () => {
    const memory = await seeded();
    const view = await mount(memory.client, log);
    await screen.findByText("Field app");
    const groups = view.container.querySelectorAll("[data-staged-group]");
    expect([...groups].map((group) => group.querySelector("span")?.textContent)).toEqual([
      "Agent turn 1",
      "Agent turn 2",
      "Your edits",
    ]);
    const first = within(groups[0] as HTMLElement);
    expect(first.getByText("Billing revamp")).toBeInTheDocument();
    expect(first.getByText("$310,000")).toBeInTheDocument();
    expect(first.getByText("$345,000")).toBeInTheDocument();
    expect(first.getByText("€540,000")).toBeInTheDocument();
    const second = within(groups[1] as HTMLElement);
    // Option labels and related records by name.
    expect(second.getByText("On track")).toBeInTheDocument();
    expect(second.getByText("Priya Raman")).toBeInTheDocument();
    expect(second.getByText("Lead")).toBeInTheDocument();
    noMachinery(view.container.textContent ?? "");
  });

  test("reverts one change with unstage", async () => {
    const memory = await seeded();
    const { client, calls } = recording(memory.client);
    await mount(client, log);
    await userEvent.click(
      await screen.findByRole("button", { name: "Revert Annual budget for Atlas migration" }),
    );
    await waitFor(() => expect(screen.queryByText("Atlas migration")).toBeNull());
    expect(ops(calls, "unstage")).toEqual([
      expect.objectContaining({
        model_id: "m_project",
        record_id: ids.project("Atlas migration"),
        field_id: "f_budget",
      }),
    ]);
  });

  test("reverts a turn only after a confirmation that says what it does not bring back", async () => {
    const memory = await seeded();
    const { client, calls } = recording(memory.client);
    const view = await mount(client, log);
    await screen.findByText("Field app");
    const [firstTurn] = view.container.querySelectorAll<HTMLElement>("[data-staged-group='agent']");
    await userEvent.click(within(firstTurn!).getByRole("button", { name: "Revert turn" }));
    const dialog = screen.getByRole("dialog", { name: "Revert agent turn 1?" });
    expect(dialog).toHaveTextContent(
      "This removes the 3 unsaved values this turn set. It does not bring back values that an earlier turn or you had set in the same cells before it.",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(ops(calls, "discard_turn")).toEqual([]);

    await userEvent.click(within(firstTurn!).getByRole("button", { name: "Revert turn" }));
    await userEvent.click(
      within(screen.getByRole("dialog", { name: "Revert agent turn 1?" })).getByRole("button", {
        name: "Revert turn",
      }),
    );
    await screen.findByText("Reverted agent turn 1");
    expect(ops(calls, "discard_turn")).toEqual([expect.objectContaining({ turn_id: turns.first })]);
    expect(screen.queryByText("Mobile checkout")).toBeNull();
    expect(screen.getByText("Field app")).toBeInTheDocument();
  });

  test("a turn revert is last-write-wins: it removes the turn's entries as they stand", async () => {
    const memory = await seeded();
    const { client, calls } = recording(memory.client);
    const view = await mount(client, log);
    await screen.findByText("Field app");
    const [firstTurn] = view.container.querySelectorAll<HTMLElement>("[data-staged-group='agent']");
    await userEvent.click(within(firstTurn!).getByRole("button", { name: "Revert turn" }));
    const dialog = screen.getByRole("dialog", { name: "Revert agent turn 1?" });
    // The turn stages once more while the confirmation is open.
    await act(() =>
      stage(memory, [project("Support tooling", "f_budget", budget("95000"))], turns.first),
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Revert turn" }));
    await screen.findByText("Reverted agent turn 1");
    expect(ops(calls, "discard_turn")).toEqual([expect.objectContaining({ turn_id: turns.first })]);
    expect(ops(calls, "discard_turn")[0]).not.toHaveProperty("expected_revision");
    const left = await memory.client.session.request({ operation: "get", session_id: sessionId });
    expect(left.overlay.filter((entry) => entry.turn_id === turns.first)).toEqual([]);
  });

  test("discards all of the agent's changes after a confirmation; your edits stay", async () => {
    const memory = await seeded();
    const { client, calls } = recording(memory.client);
    await mount(client, log);
    await userEvent.click(
      await screen.findByRole("button", { name: "Discard all of the agent's changes" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Discard all of the agent's changes?" });
    expect(dialog).toHaveTextContent("all 6 unsaved values the agent has set");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Discard the agent's changes" }),
    );
    await screen.findByText("Discarded the agent's changes");
    expect(ops(calls, "discard_source")).toEqual([expect.objectContaining({ source: "agent" })]);
    expect(screen.getByText("Atlas migration")).toBeInTheDocument();
    expect(screen.queryByText("Billing revamp")).toBeNull();
  });

  test("counts pulled proposals as the agent's, in the summary as in Discard", async () => {
    const memory = await seeded(async (m) => {
      await twoTurnsAndEdits(m);
      await pullProposal(m, "Raise it?", [project("Support tooling", "f_budget", budget("90000"))]);
    });
    const view = await mount(memory.client, log);
    await screen.findByText("Field app");
    expect(view.container.querySelector("[data-staged-summary]")).toHaveTextContent(
      "7 by the agent · 2 yours",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Discard all of the agent's changes" }),
    );
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "all 7 unsaved values the agent has set in this session, including 1 you pulled",
    );
  });

  test("names a related record by its external key, never by a record id with the same value", async () => {
    const byKey = (type: "record_id" | "external_key", value: string) => ({
      type: "relation" as const,
      value: { type, value },
    });
    const memory = await seeded(async (m) => {
      await stage(m, [
        project("Atlas migration", "f_lead", byKey("external_key", "EMP-3")),
        // An external key that happens to equal a person's record id names no one.
        project("Billing revamp", "f_lead", byKey("external_key", ids.person("Aiko Tanaka"))),
      ]);
    });
    const view = await mount(memory.client, log);
    await waitFor(() => expect(view.container).toHaveTextContent("Priya Raman"));
    expect(view.container).not.toHaveTextContent("EMP-3");
    expect(view.container).toHaveTextContent(ids.person("Aiko Tanaka"));
    expect(view.container).not.toHaveTextContent("Aiko Tanaka");
  });

  test("marks stale and gone entries", async () => {
    const memory = await seeded(async (m) => {
      await twoTurnsAndEdits(m);
      m.writeCanonical("m_project", ids.project("Mobile checkout"), { f_budget: budget("355000") });
      m.removeRecord("m_project", ids.project("Field app"));
    });
    const view = await mount(memory.client, log);
    await screen.findByText("Changed since the edit");
    const stale = view.container.querySelector("[data-stale]") as HTMLElement;
    expect(stale).toHaveTextContent("Mobile checkout");
    expect(stale).toHaveTextContent("Changed since the editNow $355,000");
    const gone = view.container.querySelector("[data-gone='record_gone']") as HTMLElement;
    expect(within(gone).getByText("Record removed")).toBeInTheDocument();
  });

  test("shows a record's new name after someone else renames it, at the same revision", async () => {
    const memory = await seeded();
    const view = await mount(memory.client, log);
    await screen.findByText("Atlas migration");
    act(() =>
      memory.writeCanonical("m_project", ids.project("Atlas migration"), {
        f_name: values.text("Atlas cutover"),
      }),
    );
    await screen.findByText("Atlas cutover");
    expect(view.container).not.toHaveTextContent("Atlas migration");
  });

  test("a revert of a change restaged before the log re-renders is refused", async () => {
    const memory = await seeded();
    const { client, calls } = recording(memory.client);
    // The log keeps showing the first read while the session reads the restage.
    let read: number | null = null;
    const Frozen: Part = ({ client, session }) => {
      const [seen] = useState(() => ({ groups: session.groups, entries: session.entries }));
      read = session.revision;
      return <StagedLog client={client} session={{ ...session, ...seen }} />;
    };
    const view = await mount(client, (props) => <Frozen {...props} />);
    await screen.findByText("Atlas migration");
    await act(() => stage(memory, [project("Atlas migration", "f_budget", budget("450000"))]));
    const { revision } = await memory.client.session.request({
      operation: "get",
      session_id: sessionId,
      overlay: false,
    });
    await waitFor(() => expect(read).toBe(revision));
    await userEvent.click(
      screen.getByRole("button", { name: "Revert Annual budget for Atlas migration" }),
    );
    await screen.findByText(/The session changed while reverting/);
    expect(ops(calls, "unstage")).toEqual([]);
    expect(view.container).toHaveTextContent("Atlas migration");
  });

  test("a failed revert says so without re-applying", async () => {
    const memory = await seeded();
    const client: CanvasClient = {
      ...memory.client,
      session: {
        request: (input) =>
          input.operation === "unstage"
            ? Promise.reject(new CanvasKernelError("revision_conflict", "session changed"))
            : memory.client.session.request(input),
      },
    };
    await mount(client, log);
    await userEvent.click(
      await screen.findByRole("button", { name: "Revert Annual budget for Atlas migration" }),
    );
    await screen.findByText(/The session changed while reverting/);
    expect(screen.getByText("Atlas migration")).toBeInTheDocument();
  });
});

describe("provenance", () => {
  test("names who staged it, the turn, the rule and the thread, without ids", async () => {
    const memory = await seeded(async (m) => {
      await twoTurnsAndEdits(m);
      await pullProposal(m, "Can the portal take one more engineer this quarter?", [
        project("Customer portal", "f_headcount", values.num("6")),
      ]);
    });
    let session: CanvasSession | null = null;
    await mount(memory.client, ({ session: shown }) => {
      session = shown;
      return <span>ready</span>;
    });
    const current = session as unknown as CanvasSession;
    const byTarget = (name: string, field: string) =>
      current.entries.find(
        (entry) => entry.record_id === ids.project(name) && entry.field_id === field,
      )!;

    const agent = provenanceLines(byTarget("Field app", "f_lead"), current);
    expect(agent.map((line) => line.label)).toEqual(["Changed by", "When", "Turn"]);
    expect(agent[0]!.value).toBe("The agent");
    expect(agent[2]!.value).toBe("Agent turn 2");

    const pulled = provenanceLines(byTarget("Customer portal", "f_headcount"), current);
    expect(pulled[0]!.value).toBe("The agent, pulled by you");
    expect(pulled.at(-1)).toEqual({
      label: "Thread",
      value: "“Can the portal take one more engineer this quarter?”",
    });

    const mine = provenanceLines(byTarget("Atlas migration", "f_budget"), current);
    expect(mine.map((line) => line.value)[0]).toBe("You");

    const ruled = provenanceLines(
      { ...byTarget("Atlas migration", "f_budget"), rule_id: "raise" },
      {
        ...current,
        rules: [
          {
            id: "raise",
            description: "Raise budgets of on-track projects by 5%",
            model_id: "m_project",
            field_id: "f_budget",
            value: { type: "field", field: "f_budget" },
            author_principal: "human:user-1",
            author_kind: "human",
          },
        ],
      },
    );
    expect(ruled).toContainEqual({
      label: "Rule",
      value: "Raise budgets of on-track projects by 5%",
    });
    for (const line of [...agent, ...pulled, ...ruled]) noMachinery(line.value);
  });

  test("opens on hover beside the value it wraps", async () => {
    const memory = await seeded();
    let entry: CanvasSession["entries"][number] | undefined;
    await mount(memory.client, ({ session }) => {
      entry = session.entries.find((item) => item.turn_id === turns.first);
      return entry === undefined ? null : (
        <Provenance entry={entry} source={session}>
          <span>staged value</span>
        </Provenance>
      );
    });
    await userEvent.hover(await screen.findByText("staged value"));
    const card = screen.getByRole("dialog", { name: "Where this value came from" });
    expect(card).toHaveTextContent("The agent");
    expect(card).toHaveTextContent("Agent turn 1");
    await userEvent.unhover(screen.getByText("staged value"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("save bar", () => {
  test("shows the count, saves the revision shown as a draft, and says it waits for approval", async () => {
    const memory = await seeded(async (m) => {
      await stage(m, [
        project("Atlas migration", "f_budget", budget("440000")),
        project("Support tooling", "f_status", values.status("on_track")),
      ]);
    });
    const { client, calls } = recording(memory.client);
    await mount(client, saveBar);
    await userEvent.click(await screen.findByRole("button", { name: "Save 2 changes" }));
    await screen.findByText(/^Saved as draft #\d+, pending approval$/);
    const [save] = ops(calls, "save");
    expect(save).toMatchObject({ expected_revision: 2 });
    expect(save).not.toHaveProperty("mode");
    expect(save).not.toHaveProperty("confirmed_stale");
    expect(memory.saves).toHaveLength(1);
  });

  test("asks to confirm stale and gone entries by name, then passes them as confirmed", async () => {
    const memory = await seeded(async (m) => {
      await twoTurnsAndEdits(m);
      m.writeCanonical("m_project", ids.project("Mobile checkout"), { f_budget: budget("355000") });
      m.removeRecord("m_project", ids.project("Field app"));
    });
    const { client, calls } = recording(memory.client);
    await mount(client, saveBar);
    await userEvent.click(await screen.findByRole("button", { name: "Save 8 changes" }));
    const dialog = screen.getByRole("dialog", { name: "Check 2 changes before you Save" });
    expect(dialog).toHaveTextContent("Mobile checkout");
    expect(dialog).toHaveTextContent("Annual budget");
    expect(dialog).toHaveTextContent("Now $355,000; Save writes $362,000.");
    // A record removed before the canvas read it has no name to show, only what it was.
    expect(dialog).toHaveTextContent("Removed Project");
    expect(dialog).toHaveTextContent("Lead");
    expect(dialog).toHaveTextContent("Left out of the Save.");
    noMachinery(dialog.textContent ?? "");
    expect(ops(calls, "save")).toEqual([]);

    await userEvent.click(within(dialog).getByRole("button", { name: "Save 8 changes" }));
    // The removed record's change is cleared, not written.
    await screen.findByText("Saved as draft #1, pending approval");
    const [save] = ops(calls, "save") as { confirmed_stale: Record<string, unknown>[] }[];
    expect(save!.confirmed_stale).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          record_id: ids.project("Mobile checkout"),
          field_id: "f_budget",
        }),
        expect.objectContaining({ record_id: ids.project("Field app"), gone: "record_gone" }),
      ]),
    );
    expect(memory.saves).toHaveLength(1);
  });

  test("an all-removed Save says nothing was written", async () => {
    const memory = await seeded(async (m) => {
      await stage(m, [project("Atlas migration", "f_budget", budget("440000"))]);
      m.removeRecord("m_project", ids.project("Atlas migration"));
    });
    await mount(memory.client, saveBar);
    await userEvent.click(await screen.findByRole("button", { name: "Save 1 change" }));
    const dialog = screen.getByRole("dialog", { name: "Check 1 change before you Save" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Save 1 change" }));
    await screen.findByText(
      "Nothing was saved: those records were removed, so their changes were cleared.",
    );
    expect(screen.queryByText(/^Saved/u)).toBeNull();
  });

  test("a confirmation saves only what it showed: a stage meanwhile is refused for review", async () => {
    const memory = await seeded(async (m) => {
      await twoTurnsAndEdits(m);
      m.writeCanonical("m_project", ids.project("Mobile checkout"), { f_budget: budget("355000") });
    });
    const { client, calls } = recording(memory.client);
    await mount(client, saveBar);
    await userEvent.click(await screen.findByRole("button", { name: "Save 8 changes" }));
    const dialog = screen.getByRole("dialog", { name: "Check 1 change before you Save" });
    const shown = (
      await memory.client.session.request({
        operation: "get",
        session_id: sessionId,
        overlay: false,
      })
    ).revision;
    await act(() =>
      stage(memory, [project("Support tooling", "f_budget", budget("90000"))], turns.first),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save 9 changes" })).toBeInTheDocument(),
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Save 8 changes" }));
    await screen.findByText(
      "The session changed before your Save. Review what changed, then Save again.",
    );
    expect(ops(calls, "save")).toEqual([expect.objectContaining({ expected_revision: shown })]);
    expect(memory.saves).toEqual([]);
  });

  test.each([
    [
      "an unanswered Save",
      () => new TypeError("Failed to fetch"),
      "We couldn't confirm your Save. The session was re-read; check the unsaved changes before you Save again.",
    ],
    [
      "a conflict",
      () => new CanvasKernelError("revision_conflict", "session changed"),
      "The session changed before your Save. Review what changed, then Save again.",
    ],
  ])("%s shows a toast and is never re-applied", async (_, failure, message) => {
    const memory = await seeded(async (m) => {
      await stage(m, [project("Atlas migration", "f_budget", budget("440000"))]);
    });
    const { client, calls } = recording({
      ...memory.client,
      session: {
        request: (input) =>
          input.operation === "save"
            ? Promise.reject(failure())
            : memory.client.session.request(input),
      },
    });
    await mount(client, saveBar);
    await userEvent.click(await screen.findByRole("button", { name: "Save 1 change" }));
    await screen.findByText(message);
    expect(ops(calls, "save")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Save 1 change" })).toBeEnabled();
  });
});

describe("impact strip", () => {
  const strip: Part = ({ client, session }) => <ImpactStrip client={client} session={session} />;
  const column = (container: HTMLElement, header: string) =>
    waitFor(() => {
      const found = container.querySelector(`[data-impact-column='${header}']`);
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });

  test("number and money columns total before → after over the changed records, per currency", async () => {
    const memory = await seeded();
    const view = await mount(memory.client, strip);
    // Two turns and your edits touch Atlas, Billing, Data warehouse, Field app, Mobile, Support, Warehouse.
    expect(view.container).toHaveTextContent("7 records changed");
    const budgets = await column(view.container, "Annual budget");
    // EUR: Warehouse robotics 510k → 540k.
    expect(budgets).toHaveTextContent("€510,000 → €540,000 (+€30,000) over 1 changed record");
    // USD: Billing 310k → 345k, Mobile 330k → 362k, Atlas 420k → 440k.
    expect(budgets).toHaveTextContent("$1,060,000 → $1,147,000 (+$87,000) over 3 changed records");
    expect(await column(view.container, "Headcount")).toHaveTextContent(
      "Headcount:3 → 4 (+1) over 1 changed record",
    );
    noMachinery(view.container.textContent ?? "");
  });

  test("choice columns count records moved between values, by label and record name", async () => {
    const memory = await seeded();
    const view = await mount(memory.client, strip);
    const statuses = await column(view.container, "Status");
    expect(statuses).toHaveTextContent("1 record At risk → On track");
    expect(statuses).toHaveTextContent("1 record Planned → On track");
    await waitFor(async () =>
      expect(await column(view.container, "Lead")).toHaveTextContent(
        "1 record Aiko Tanaka → Priya Raman",
      ),
    );
    noMachinery(view.container.textContent ?? "");
  });

  test("moves to the same value group: N records A → B", async () => {
    const memory = await seeded(async (m) => {
      await stage(m, [
        project("Atlas migration", "f_status", values.status("paused")),
        project("Customer portal", "f_status", values.status("paused")),
        project("Partner API", "f_status", values.status("paused")),
        project("Billing revamp", "f_status", values.status("paused")),
      ]);
    });
    const view = await mount(memory.client, strip);
    const statuses = await column(view.container, "Status");
    expect(statuses).toHaveTextContent(
      "Status:3 records On track → Paused·1 record At risk → Paused",
    );
  });

  test("other columns show a change count", async () => {
    const memory = await seeded(async (m) => {
      await stage(m, [
        project("Atlas migration", "f_name", values.text("Atlas")),
        project("Billing revamp", "f_name", values.text("Billing")),
      ]);
    });
    const view = await mount(memory.client, strip);
    expect(await column(view.container, "Project")).toHaveTextContent("Project:2 changes");
  });

  test("opening the staged pane reads no aggregates: the impact comes from the staged entries", async () => {
    const memory = await seeded();
    const aggregates: string[] = [];
    const client: CanvasClient = {
      ...memory.client,
      data: {
        ...memory.client.data,
        aggregate: (modelId, input) => {
          aggregates.push(modelId);
          return memory.client.data.aggregate(modelId, input);
        },
      },
    };
    const view = await mount(client, ({ client: mounted, session }) => (
      <StagedLog client={mounted} impact session={session} />
    ));
    await waitFor(() =>
      expect(view.container).toHaveTextContent("$1,060,000 → $1,147,000 (+$87,000)"),
    );
    await waitFor(() => expect(view.container).toHaveTextContent("Aiko Tanaka → Priya Raman"));
    expect(aggregates).toEqual([]);
  });
});

describe("impact strip: the no-op case", () => {
  test("changes that cancel out total once, without a difference", async () => {
    const memory = await seeded(async (m) => {
      await stage(m, [
        project("Atlas migration", "f_budget", budget("440000")),
        project("Billing revamp", "f_budget", budget("290000")),
      ]);
    });
    const view = await mount(memory.client, ({ client, session }) => (
      <ImpactStrip client={client} session={session} />
    ));
    await waitFor(() =>
      expect(view.container).toHaveTextContent(
        "2 records changedAnnual budget:$730,000 over 2 changed records, no change",
      ),
    );
    expect(view.container.textContent).not.toContain("→");
  });

  test("nothing staged: no records changed and no columns", async () => {
    const memory = await seeded(async () => {});
    const view = await mount(memory.client, ({ client, session }) => (
      <ImpactStrip client={client} session={session} />
    ));
    await waitFor(() => expect(view.container).toHaveTextContent("0 records changed"));
    expect(view.container.querySelector("[data-impact-column]")).toBeNull();
  });
});
