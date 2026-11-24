// Review mode and draft threads over the in-memory drafts client: no drafts
// client means no Work/Review toggle; every member gets it and reads the same
// cards, threads and authors, but only an approver acts and only a draft's
// author or an approver resolves; the toggle swaps the plane for the review
// and back without losing the staged view; Publish and Discard confirm first,
// Discard saves an optional note; card threads take replies; the author's
// Comments pane shows threads on drafts this session saved; with mainline
// Saves Review is the published changelog.
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
import { describe, expect, it, vi } from "vite-plus/test";

import { bootstrapAgGrid } from "@modules/editable-grid";

import { Canvas } from "../canvas";
import { useSessionDrafts } from "../draft-threads";
import type { CanvasSessionDraft } from "../client";
import type { MemoryCanvas } from "../memory-client";
import {
  approveMemory,
  authors,
  draftThreadId,
  seedDrafts,
  seedPublished,
  seedRejected,
} from "../stories/fixtures/approve";
import { canvasMemory, send, sessionId, typicalLayout, unitIds } from "../stories/fixtures/canvas";
import { change, personId, projectId, stageAs } from "../stories/fixtures/grid";

bootstrapAgGrid();

function mount(memory: MemoryCanvas) {
  return render(
    <div style={{ width: 1400, height: 900 }}>
      <Canvas client={memory.client} sessionId={sessionId} />
    </div>,
  );
}

/** Review, with the count of drafts waiting on the viewer in its name. */
const review = () => screen.findByRole("radio", { name: /^Review/ });
const modeRadio = (name: "Work" | "Review") =>
  within(screen.getByRole("radiogroup", { name: "Canvas mode" })).getByRole("radio", {
    name: name === "Review" ? /^Review/ : name,
  });
const cards = () => [...document.querySelectorAll<HTMLElement>("[data-card]")];
const ownThreadId = "e0000000-0000-4000-8000-000000000002";

const threadOf = () =>
  waitFor(() => {
    const found = document.querySelector<HTMLElement>(`[data-draft-thread="${draftThreadId}"]`);
    expect(found).not.toBeNull();
    return found!;
  });

describe("Review mode", () => {
  it("has no Work/Review toggle without a drafts client", async () => {
    mount(canvasMemory(typicalLayout));
    await screen.findByRole("button", { name: /^Unsaved changes/ });
    expect(screen.queryByRole("radiogroup", { name: "Canvas mode" })).toBeNull();
  });

  it("shows a member the same cards, authors and threads, read-only but for replies", async () => {
    const memory = approveMemory(false);
    const ids = seedDrafts(memory);
    await seedRejected(memory);
    mount(memory);
    // Review counts what waits on the viewer: a member's own pending drafts
    // (these three are other people's), an approver's every pending draft.
    await waitFor(async () => expect(await review()).toBeTruthy());
    expect((await review()).getAttribute("aria-label")).toBe("Review");
    fireEvent.click(modeRadio("Review"));
    await waitFor(() => expect(cards()).toHaveLength(3));
    expect(screen.getByText("Draft by Ravi Patel")).toBeTruthy();
    // No merge actions and no discard dialog for a member.
    expect(screen.queryByRole("button", { name: /^(Publish|Discard|Revert)$/ })).toBeNull();
    // Another person's thread: the member replies but may not resolve it.
    const thread = await threadOf();
    expect(within(thread).queryByRole("button", { name: "Resolve" })).toBeNull();
    await userEvent.setup().type(within(thread).getByRole("textbox"), "Which scope?{Enter}");
    await within(thread).findByText("Which scope?");
    const { threads } = await memory.client.drafts!.threads.list(ids.ravi);
    expect(threads[0]!.messages.map((m) => m.message)).toContain("Which scope?");
    // Rejected drafts and their notes are the workspace's too.
    fireEvent.click(screen.getByRole("radio", { name: /^Rejected/ }));
    await screen.findByText(/Split it into two phases/);
    fireEvent.click(screen.getByRole("radio", { name: /^Published/ }));
    expect(screen.queryByRole("button", { name: /^(Publish|Discard|Revert)$/ })).toBeNull();
    // Their own draft Save waits on them.
    await act(async () => {
      await stageAs(memory.client.session, [
        change(5, "f_status", { type: "enum", value: "on_hold" }),
      ]);
      await send(memory.client.session, { operation: "save" });
    });
    await waitFor(async () =>
      expect((await review()).getAttribute("aria-label")).toBe("Review, 1 draft waiting"),
    );
  });

  it("lets a draft's author resolve its threads; nobody else but an approver", async () => {
    const memory = approveMemory(false);
    // Hana (this member) saved one draft with a thread; Ravi saved another.
    const own = memory.seedDraft({
      actorId: authors.hana,
      sessionId: "s-hana",
      changes: [change(5, "f_status", { type: "enum", value: "on_hold" })],
      threads: [
        {
          id: ownThreadId,
          anchor: { unit_id: unitIds.grid, model_id: "m_project", record_id: projectId(5) },
          messages: [{ actor_id: authors.ravi, message: "Why on hold?" }],
        },
      ],
    });
    const ids = seedDrafts(memory);
    mount(memory);
    fireEvent.click(await review());
    const ownThread = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(`[data-draft-thread="${ownThreadId}"]`);
      expect(found).not.toBeNull();
      return found!;
    });
    expect(within(await threadOf()).queryByRole("button", { name: "Resolve" })).toBeNull();
    fireEvent.click(within(ownThread).getByRole("button", { name: "Resolve" }));
    await within(ownThread).findByText("Resolved");
    expect((await memory.client.drafts!.threads.list(own)).threads[0]!.resolved).toBe(true);
    // The host refuses the gesture regardless of what the card shows.
    await expect(
      memory.client.drafts!.threads.resolve(ids.ravi, draftThreadId),
    ).rejects.toMatchObject({ envelope: { code: "authorization_denied" } });
  });

  it("lists published changes in Review; only an approver reverts", async () => {
    for (const canApprove of [true, false]) {
      const memory = approveMemory(canApprove);
      await seedPublished(memory);
      const view = mount(memory);
      await screen.findByRole("button", { name: /^Unsaved changes/ });
      fireEvent.click(modeRadio("Review"));
      fireEvent.click(await screen.findByRole("radio", { name: /^Published/ }));
      await waitFor(() => expect(cards()).toHaveLength(1));
      expect(screen.getByText("Change by Ravi Patel")).toBeTruthy();
      expect(Boolean(within(cards()[0]!).queryByRole("button", { name: "Revert" }))).toBe(
        canApprove,
      );
      view.unmount();
    }
  });

  it("counts pending drafts on Review and lists each draft as its own card", async () => {
    const memory = approveMemory();
    seedDrafts(memory);
    mount(memory);
    await waitFor(async () =>
      expect((await review()).getAttribute("aria-label")).toBe("Review, 3 drafts waiting"),
    );
    fireEvent.click(await review());
    await waitFor(() => expect(cards()).toHaveLength(3));
    // Two drafts change Atlas's budget; each is its own card, named by author.
    const budgetCards = cards().filter((card) => card.textContent?.includes("Budget"));
    expect(budgetCards.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Draft by Ravi Patel")).toBeTruthy();
    // Records are named by their title column, never by id.
    expect(document.body.textContent).not.toContain(projectId(2));
    expect(document.body.textContent).not.toContain("f_budget");
    // Save and plane controls hide in Review mode.
    expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
  });

  it("names a draft card's record and the related record, never an id while names load", async () => {
    const memory = approveMemory();
    // Project 3, Data warehouse refresh, moves from Priya Natarajan to Hannah Weiss.
    memory.seedDraft({
      actorId: authors.ravi,
      sessionId: "s-ravi-owner",
      changes: [
        {
          model_id: "m_project",
          record_id: projectId(3),
          field_id: "f_owner",
          value: { type: "relation", value: { type: "record_id", value: personId(5) } },
        },
      ],
    });
    // Name reads (one record by key) wait until released, as over a slow network.
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const list = memory.client.data.list.bind(memory.client.data);
    const client = {
      ...memory.client,
      data: {
        ...memory.client.data,
        list: async (...args: Parameters<typeof list>) => {
          if (args[1].limit === 1 && args[1].where?.length === 1) await released;
          return await list(...args);
        },
      },
    };
    render(
      <div style={{ width: 1400, height: 900 }}>
        <Canvas client={client} sessionId={sessionId} />
      </div>,
    );
    await review();
    fireEvent.click(modeRadio("Review"));
    const card = await waitFor(() => {
      const found = cards().find((item) => item.textContent?.includes("Owner"));
      expect(found).toBeDefined();
      return found!;
    });
    const machinery = [projectId(3), personId(3), personId(5), "f_owner", "m_person"];
    const noMachinery = () => {
      for (const id of machinery) expect(document.body.textContent).not.toContain(id);
      expect(document.body.textContent).not.toContain("outside this view");
    };
    // While names load the card shows a placeholder, never an id or an unknown.
    expect(card.textContent).toContain("…");
    noMachinery();
    act(() => release());
    await waitFor(() => expect(card.textContent).toContain("Hannah Weiss"));
    expect(card.textContent).toContain("Data warehouse refresh");
    expect(card.textContent).toContain("Priya Natarajan");
    noMachinery();
  });

  it("hears drafts saved and discarded elsewhere while it is open", async () => {
    const memory = approveMemory();
    const { mei } = seedDrafts(memory);
    mount(memory);
    await waitFor(async () =>
      expect((await review()).getAttribute("aria-label")).toBe("Review, 3 drafts waiting"),
    );
    // Another approver rejects one: the count re-reads without a reload.
    await act(async () => {
      await memory.client.drafts!.kernel.postJson("/api/draft/discard", { change_set_id: mei });
    });
    await waitFor(async () =>
      expect((await review()).getAttribute("aria-label")).toBe("Review, 2 drafts waiting"),
    );
    // This session's own draft Save reaches its approver too.
    await act(async () => {
      await stageAs(memory.client.session, [
        change(5, "f_status", { type: "enum", value: "on_hold" }),
      ]);
      await send(memory.client.session, { operation: "save" });
    });
    await waitFor(async () =>
      expect((await review()).getAttribute("aria-label")).toBe("Review, 3 drafts waiting"),
    );
  });

  it("refreshes the Review count on reconnect after a discard it missed", async () => {
    const memory = approveMemory();
    const { mei } = seedDrafts(memory);
    mount(memory);
    await waitFor(async () =>
      expect((await review()).getAttribute("aria-label")).toBe("Review, 3 drafts waiting"),
    );
    // The stream drops; another approver discards a draft unannounced.
    memory.disconnect(sessionId);
    await act(async () => {
      await memory.client.drafts!.kernel.postJson("/api/draft/discard", { change_set_id: mei });
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await review()).getAttribute("aria-label")).toBe("Review, 3 drafts waiting");
    act(() => memory.reconnect(sessionId));
    await waitFor(async () =>
      expect((await review()).getAttribute("aria-label")).toBe("Review, 2 drafts waiting"),
    );
  });

  it("hides the plane and brings the staged view back unchanged", async () => {
    const memory = approveMemory();
    await stageAs(memory.client.session, [
      change(1, "f_status", { type: "enum", value: "active" }),
    ]);
    mount(memory);
    const unit = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(`[data-canvas-unit="${unitIds.grid}"]`);
      expect(found).not.toBeNull();
      return found!;
    });
    const staged = await screen.findByRole("button", { name: "Unsaved changes, 1" });
    expect(staged).toBeTruthy();
    fireEvent.click(modeRadio("Review"));
    await waitFor(() =>
      expect(document.querySelector("[data-work-plane]")!.className).toContain("hidden"),
    );
    expect(document.querySelector("[data-review-surface]")).not.toBeNull();
    // Review has no unsaved changes or Save bar.
    expect(document.querySelector("[data-changes-bar]")).toBeNull();
    fireEvent.click(modeRadio("Work"));
    await waitFor(() => expect(document.querySelector("[data-review-surface]")).toBeNull());
    // The same unit element: the plane was never remounted.
    expect(document.querySelector(`[data-canvas-unit="${unitIds.grid}"]`)).toBe(unit);
    expect(screen.getByRole("button", { name: "Unsaved changes, 1" })).toBeTruthy();
    expect(document.querySelector("[data-changes-bar]")).not.toBeNull();
  });

  it("publishes after a second click and discards with a note after a dialog", async () => {
    const memory = approveMemory();
    const ids = seedDrafts(memory);
    mount(memory);
    fireEvent.click(await review());
    await waitFor(() => expect(cards()).toHaveLength(3));

    // Newest first: Mei's status draft, Mei's budget, Ravi's budget.
    const [statusCard] = cards();
    fireEvent.click(within(statusCard!).getByRole("button", { name: "Publish" }));
    expect(memory.changeSetStatus(ids.status)).toBe("draft");
    fireEvent.click(within(statusCard!).getByRole("button", { name: /^Confirm publish\?/ }));
    await waitFor(() => expect(memory.changeSetStatus(ids.status)).toBe("mainline"));
    await waitFor(() => expect(cards()).toHaveLength(2));

    const [meiCard] = cards();
    fireEvent.click(within(meiCard!).getByRole("button", { name: "Discard" }));
    const dialog = await screen.findByRole("dialog", { name: "Discard this draft?" });
    expect(memory.changeSetStatus(ids.mei)).toBe("draft");
    fireEvent.change(within(dialog).getByRole("textbox"), {
      target: { value: "Ravi's figure is the signed one." },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard draft" }));
    await waitFor(() => expect(memory.changeSetStatus(ids.mei)).toBe("discarded"));
    expect(memory.changeSetNotes(ids.mei)).toBe("Ravi's figure is the signed one.");

    // The rejected draft stays readable on the Rejected tab, with its note.
    fireEvent.click(await screen.findByRole("radio", { name: /^Rejected/ }));
    await waitFor(() => expect(cards()).toHaveLength(1));
    expect(screen.getByText("Ravi's figure is the signed one.")).toBeTruthy();
    expect(within(cards()[0]!).queryByRole("button", { name: /Publish|Discard/ })).toBeNull();
  });

  it("shows a seeded rejected draft with its note", async () => {
    const memory = approveMemory();
    await seedRejected(memory);
    mount(memory);
    fireEvent.click(await review());
    fireEvent.click(await screen.findByRole("radio", { name: /^Rejected/ }));
    await screen.findByText(/Split it into two phases/);
    expect(screen.getByText("Rejected")).toBeTruthy();
  });

  it("shows a draft's threads on its card and takes a reply", async () => {
    const memory = approveMemory();
    const ids = seedDrafts(memory);
    mount(memory);
    fireEvent.click(await review());
    const thread = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(`[data-draft-thread="${draftThreadId}"]`);
      expect(found).not.toBeNull();
      return found!;
    });
    expect(thread.textContent).toContain("The client signed the larger scope");
    await userEvent
      .setup()
      .type(within(thread).getByRole("textbox"), "Approving with the signed figure.{Enter}");
    await waitFor(async () => {
      const [found] = (await memory.client.drafts!.threads.list(ids.ravi)).threads;
      expect(found!.messages.map((m) => m.message)).toContain("Approving with the signed figure.");
    });
    await within(thread).findByText("Approving with the signed figure.");
  });

  it("refreshes a card's threads when someone else replies while it is open", async () => {
    const memory = approveMemory();
    const ids = seedDrafts(memory);
    mount(memory);
    fireEvent.click(await review());
    const thread = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(`[data-draft-thread="${draftThreadId}"]`);
      expect(found).not.toBeNull();
      return found!;
    });
    // Another approver's reply, from their own client.
    act(() => memory.replyOnDraft(ids.ravi, draftThreadId, "user:mei", "Signed copy is in."));
    await within(thread).findByText("Signed copy is in.");
  });

  it("refreshes an open card on reconnect after a reply it missed, at the same revision", async () => {
    const memory = approveMemory();
    const ids = seedDrafts(memory);
    mount(memory);
    fireEvent.click(await review());
    const thread = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(`[data-draft-thread="${draftThreadId}"]`);
      expect(found).not.toBeNull();
      return found!;
    });
    // The stream drops; a reply lands unannounced and the session does not move.
    memory.disconnect(sessionId);
    act(() =>
      memory.replyOnDraft(ids.ravi, draftThreadId, "user:mei", "Sent while you were away."),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(within(thread).queryByText("Sent while you were away.")).toBeNull();
    act(() => memory.reconnect(sessionId));
    await within(thread).findByText("Sent while you were away.");
  });
});

describe("Draft threads in the author's Comments pane", () => {
  it("lists threads on drafts saved from this session, with replies", async () => {
    const memory = approveMemory(false);
    await stageAs(memory.client.session, [change(2, "f_status", { type: "enum", value: "done" })]);
    await send(memory.client.session, {
      operation: "thread_open",
      thread_id: "f0000000-0000-4000-8000-000000000001",
      anchor: {
        unit_id: unitIds.grid,
        model_id: "m_project",
        record_id: projectId(2),
        field_id: "f_status",
      },
    });
    await send(memory.client.session, {
      operation: "thread_reply",
      thread_id: "f0000000-0000-4000-8000-000000000001",
      message: "Marking this done; the client signed off.",
    });
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
    const [saved] = await memory.client.drafts!.threads.forSession(sessionId);
    await memory.client.drafts!.threads.reply(
      saved!.change_set_id,
      "f0000000-0000-4000-8000-000000000001",
      "Can you attach the sign-off?",
    );
    mount(memory);
    const comments = await screen.findByRole("button", { name: /^Comments/ });
    await act(async () => fireEvent.click(comments));
    const group = await screen.findByRole("region", { name: "On your drafts" });
    await within(group).findByText("Can you attach the sign-off?");
    expect(within(group).getByText("Waiting for review")).toBeTruthy();
    // In the narrow pane the reply box opens from Reply.
    const user = userEvent.setup();
    await user.click(within(group).getByRole("button", { name: "Reply" }));
    await user.type(within(group).getByRole("textbox"), "Attached in the folder.{Enter}");
    await within(group).findByText("Attached in the folder.");
  });

  it("hears the author's own Save and a reviewer's reply and resolve while Comments stays open", async () => {
    const threadId = "f0000000-0000-4000-8000-000000000002";
    const memory = approveMemory(false);
    await stageAs(memory.client.session, [change(2, "f_status", { type: "enum", value: "done" })]);
    await send(memory.client.session, {
      operation: "thread_open",
      thread_id: threadId,
      anchor: {
        unit_id: unitIds.grid,
        model_id: "m_project",
        record_id: projectId(2),
        field_id: "f_status",
      },
    });
    await send(memory.client.session, {
      operation: "thread_reply",
      thread_id: threadId,
      message: "Done per the client.",
    });
    mount(memory);
    const comments = await screen.findByRole("button", { name: /^Comments/ });
    await act(async () => fireEvent.click(comments));
    await screen.findByText("Done per the client.");
    expect(screen.queryByRole("region", { name: "On your drafts" })).toBeNull();
    // The author Saves as a draft with Comments open: the Save's result
    // re-reads, and the draft's group appears.
    const button = document.querySelector<HTMLButtonElement>("[data-save-button]")!;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    const group = await screen.findByRole("region", { name: "On your drafts" });
    const [saved] = await memory.client.drafts!.threads.forSession(sessionId);
    // A reviewer replies and resolves from their own client; the pane hears both.
    act(() => memory.replyOnDraft(saved!.change_set_id, threadId, "user:ravi", "Which client?"));
    await within(group).findByText("Which client?");
    await act(async () => {
      await memory.client.drafts!.threads.resolve(saved!.change_set_id, threadId);
    });
    await within(group).findByText("Resolved");
  });

  it("names another person's draft as published, not by the reviewer's staged rename", async () => {
    const memory = approveMemory();
    seedDrafts(memory);
    await stageAs(memory.client.session, [
      change(2, "f_name", { type: "text", value: "Staged rename" }),
    ]);
    mount(memory);
    fireEvent.click(await review());
    await waitFor(() => expect(cards()).toHaveLength(3));
    await waitFor(() =>
      expect(cards().some((card) => card.textContent?.includes("Customer portal"))).toBe(true),
    );
    expect(cards().some((card) => card.textContent?.includes("Staged rename"))).toBe(false);
  });

  it("shows the author a rejection note on a draft that had no threads", async () => {
    const memory = approveMemory(false);
    const id = memory.seedDraft({
      actorId: "user:local",
      sessionId,
      changes: [change(3, "f_estimate", { type: "number", value: "90" })],
    });
    const kernel = memory.client.drafts!.kernel;
    await kernel.postJson("/api/draft/notes", {
      change_set_id: id,
      notes: "Split it into two phases.",
    });
    await kernel.postJson("/api/draft/discard", { change_set_id: id });
    mount(memory);
    const comments = await screen.findByRole("button", { name: /^Comments/ });
    await act(async () => fireEvent.click(comments));
    const group = await screen.findByRole("region", { name: "On your drafts" });
    await within(group).findByText(/Split it into two phases\./);
  });

  it("keeps the latest read of the author's drafts when an older one answers last", async () => {
    const memory = approveMemory(false);
    const answers: ((value: CanvasSessionDraft[]) => void)[] = [];
    const drafts = {
      ...memory.client.drafts!,
      threads: {
        ...memory.client.drafts!.threads,
        forSession: () => new Promise<never>((resolve) => answers.push(resolve as never)),
      },
    };
    const { result } = renderHook(() => useSessionDrafts(memory.client, drafts, sessionId));
    await waitFor(() => expect(answers.length).toBeGreaterThan(0));
    const first = answers.length - 1;
    void result.current.reload();
    await waitFor(() => expect(answers.length).toBe(first + 2));
    const newer = [{ change_set_id: 2, status: "draft" as const, notes: null, threads: [] }];
    const older = [{ change_set_id: 1, status: "draft" as const, notes: null, threads: [] }];
    await act(async () => answers[first + 1]!(newer));
    await act(async () => answers[first]!(older));
    expect(result.current.saved).toEqual(newer);
  });

  it("staging edits does not re-read the session's drafts", async () => {
    const memory = approveMemory(false);
    const forSession = vi.spyOn(memory.client.drafts!.threads, "forSession");
    mount(memory);
    await screen.findByRole("button", { name: /^Comments/ });
    await waitFor(() => expect(forSession).toHaveBeenCalled());
    // Let the first connect's read settle.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const before = forSession.mock.calls.length;
    await act(async () => {
      await stageAs(memory.client.session, [
        change(2, "f_status", { type: "enum", value: "done" }),
      ]);
      await stageAs(memory.client.session, [
        change(3, "f_status", { type: "enum", value: "done" }),
      ]);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(forSession.mock.calls.length).toBe(before);
  });
});
