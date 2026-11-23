// The options the canvas's Review mode uses, each off by default so hc's
// Approvals page is unchanged: the Rejected tab, one card per draft with its
// author and note, model scoping, Discard with a note, the card footer, a
// read-only surface without actions, and a review with no pending drafts.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";

import { ToastProvider } from "@autograph/components";
import type { ChangeSetDiff, DraftSummary, KernelClient, Schema } from "@contracts";

import {
  DraftReviewSurface,
  useDraftReview,
  type UseDraftReviewConfig,
  type DraftReviewSurfaceProps,
} from "../index";

const schema: Schema = {
  app_id: "canvas",
  customer_id: "canvas",
  version: "test",
  change_types: [],
  models: [
    {
      id: "m_project",
      kind: "entity",
      label: "Project",
      fields: [{ id: "f_budget", label: "Budget", type: "number", required: false }],
    },
    {
      id: "m_person",
      kind: "entity",
      label: "Person",
      fields: [{ id: "f_role", label: "Role", type: "text", required: false }],
    },
  ],
};

const summary = (id: number, actor: string, notes: string | null = null): DraftSummary => ({
  id,
  schema_revision_id: "1",
  actor_id: actor,
  source_kind: "work_session",
  source_ref: null,
  change_type_id: null,
  notes,
  created_at: "2026-10-29T14:05:00Z",
});

const diff = (id: number, model: string, field: string, after: string): ChangeSetDiff => ({
  change_set_id: id,
  source_change_set_id: id,
  records: [
    {
      model_id: model,
      record_id: `r-${id}`,
      version_id: `v-${id}`,
      change_set_id: id,
      stage: "draft",
      effective_start: "2026-10-01",
      before_tombstones_record: false,
      after_tombstones_record: false,
      before_untombstones_record: false,
      after_untombstones_record: false,
      fields: [
        {
          field_id: field,
          before: null,
          after:
            field === "f_role" ? { type: "text", value: after } : { type: "number", value: after },
        },
      ],
      custom_fields: [],
    },
  ],
});

function fakeClient() {
  const drafts = [summary(1, "ravi"), summary(2, "mei"), summary(3, "mei")];
  const rejected = [summary(4, "ravi", "Too big for this quarter.")];
  const diffs: Record<number, ChangeSetDiff> = {
    1: diff(1, "m_project", "f_budget", "120000"),
    2: diff(2, "m_project", "f_budget", "90000"),
    3: diff(3, "m_person", "f_role", "Lead"),
    4: diff(4, "m_project", "f_budget", "500000"),
  };
  const getJson = vi.fn(async (path: string) => {
    if (path === "/api/drafts") return drafts;
    if (path === "/api/drafts/rejected") return rejected;
    throw new Error(`unexpected ${path}`);
  });
  const postJson = vi.fn(async (path: string, body: unknown) => {
    const id = (body as { change_set_id: number }).change_set_id;
    if (path === "/api/diff") return diffs[id] ?? diff(id, "m_project", "f_budget", "1");
    if (path === "/api/activity")
      // As the kernel: only the source kinds asked for.
      return [
        {
          change_set_id: 5,
          status: "mainline",
          actor_id: "ravi",
          source_kind: "work_session",
          source_ref: null,
          change_type_id: null,
          notes: null,
          created_at: "2026-10-28T10:00:00Z",
          applied_at: "2026-10-28T11:00:00Z",
          touched_record_count: 1,
        },
      ].filter((entry) =>
        ((body as { source_kinds?: string[] }).source_kinds ?? []).includes(entry.source_kind),
      );
    return { ok: true };
  });
  return { getJson, postJson } as KernelClient & {
    getJson: ReturnType<typeof vi.fn>;
    postJson: ReturnType<typeof vi.fn>;
  };
}

function Harness(props: {
  client: KernelClient;
  config?: Partial<UseDraftReviewConfig>;
  surface?: Partial<DraftReviewSurfaceProps>;
}) {
  const controller = useDraftReview({
    client: props.client,
    scope: { appId: "canvas", customerId: "canvas" },
    schema,
    primaryModel: "m_project",
    defaultChangeTypeId: "",
    // As the canvas: canvas Saves publish as work_session change sets.
    publishedSourceKinds: ["work_session", "user", "agent", "revert"],
    ...props.config,
  });
  return (
    <div>
      <span data-pending={controller.pendingDrafts} />
      <DraftReviewSurface
        controller={controller}
        relationLabel={() => null}
        renderPrimaryCell={(row) => `${row.model_id}:${row.record_id}`}
        {...props.surface}
      />
    </div>
  );
}

const mount = (client: KernelClient, props: Omit<Parameters<typeof Harness>[0], "client"> = {}) =>
  render(
    <ToastProvider>
      <Harness client={client} {...props} />
    </ToastProvider>,
  );
const cards = () => [...document.querySelectorAll<HTMLElement>("[data-card]")];

describe("draft-review canvas options", () => {
  it("has no Rejected tab and never reads rejected drafts unless asked", async () => {
    const client = fakeClient();
    mount(client);
    await screen.findByRole("radio", { name: /^Drafts/ });
    expect(screen.queryByRole("radio", { name: /^Rejected/ })).toBeNull();
    expect(client.getJson.mock.calls.map((call) => call[0])).not.toContain("/api/drafts/rejected");
  });

  it("groups unnamed drafts by type by default, and one card per draft when asked", async () => {
    const grouped = fakeClient();
    const view = mount(grouped);
    await waitFor(() => expect(cards().length).toBeGreaterThan(0));
    // One type-group card holds all three unnamed drafts.
    expect(cards()).toHaveLength(1);
    view.unmount();

    mount(fakeClient(), {
      config: { cardPerDraft: true, models: ["m_project", "m_person"] },
      surface: { authorLabel: (id) => (id === "mei" ? "Mei Chen" : null) },
    });
    await waitFor(() => expect(cards()).toHaveLength(3));
    // Newest first; each record's columns are labelled from its own model.
    expect(cards()[0]!.textContent).toContain("Person");
    expect(cards()[0]!.textContent).toContain("Role");
    expect(cards()[0]!.textContent).toContain("Mei Chen");
    // An author the app cannot name is left out, never shown by id.
    expect(cards()[2]!.textContent).not.toContain("ravi");
    expect(document.body.textContent).not.toContain("f_budget");
  });

  it("labels every model's columns one card per draft with no scope", async () => {
    mount(fakeClient(), { config: { cardPerDraft: true } });
    await waitFor(() => expect(cards()).toHaveLength(3));
    expect(cards()[0]!.textContent).toContain("Role");
    expect(document.body.textContent).not.toContain("f_role");
  });

  it("lists and counts only drafts touching the scope models", async () => {
    mount(fakeClient(), { config: { cardPerDraft: true, models: ["m_project"] } });
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(document.querySelector("[data-pending]")!.getAttribute("data-pending")).toBe("2");
  });

  it("shows rejected drafts read-only with their note on the Rejected tab", async () => {
    mount(fakeClient(), { config: { cardPerDraft: true, rejected: true } });
    fireEvent.click(await screen.findByRole("radio", { name: "Rejected (1)" }));
    await waitFor(() => expect(cards()).toHaveLength(1));
    const card = cards()[0]!;
    expect(card.getAttribute("data-card-status")).toBe("rejected");
    expect(card.textContent).toContain("Rejection note: Too big for this quarter.");
    expect(within(card).queryByRole("button")).toBeNull();
  });

  it("asks before Discard and sends the note with the discard", async () => {
    const client = fakeClient();
    mount(client, { config: { cardPerDraft: true }, surface: { discardNote: true } });
    await waitFor(() => expect(cards()).toHaveLength(3));
    fireEvent.click(within(cards()[2]!).getByRole("button", { name: "Discard" }));
    const dialog = await screen.findByRole("dialog", { name: "Discard this draft?" });
    expect(client.postJson.mock.calls.map((call) => call[0])).not.toContain("/api/draft/discard");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Use Mei's." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard draft" }));
    await waitFor(() =>
      expect(client.postJson.mock.calls.map((call) => call[0])).toContain("/api/draft/discard"),
    );
    const posts = client.postJson.mock.calls.filter((call) => call[0].startsWith("/api/draft/"));
    // One call, so the note is saved only if the discard lands.
    expect(posts).toEqual([["/api/draft/discard", { change_set_id: 1, notes: "Use Mei's." }]]);
  });

  it("shows a row's rule note under the value it set", async () => {
    const client = fakeClient();
    const drafts = [
      {
        ...summary(1, "ravi"),
        entry_notes: { "m_project:r-1:f_budget": "Raise to the band floor" },
      },
    ];
    client.getJson.mockImplementation(async (path: string) => {
      if (path === "/api/drafts") return drafts;
      throw new Error(`unexpected ${path}`);
    });
    mount(client, { config: { cardPerDraft: true } });
    await waitFor(() => expect(cards()).toHaveLength(1));
    const note = await within(cards()[0]!).findByText("By rule: Raise to the band floor");
    expect(note.closest("td")!.textContent).toMatch(/120,?000/u);
  });

  it("discards without a note in the plain body hc's API takes", async () => {
    const client = fakeClient();
    mount(client, { config: { cardPerDraft: true }, surface: { discardNote: true } });
    await waitFor(() => expect(cards()).toHaveLength(3));
    fireEvent.click(within(cards()[2]!).getByRole("button", { name: "Discard" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard draft" }));
    await waitFor(() =>
      expect(client.postJson.mock.calls.map((call) => call[0])).toContain("/api/draft/discard"),
    );
    const posts = client.postJson.mock.calls.filter((call) => call[0].startsWith("/api/draft/"));
    expect(posts).toEqual([["/api/draft/discard", { change_set_id: 1 }]]);
  });

  it("keeps the dialog open with its note when the discard fails, and closes once it lands", async () => {
    const client = fakeClient();
    let discardFails = true;
    client.postJson.mockImplementation(async (path: string, body: unknown) => {
      const id = (body as { change_set_id: number }).change_set_id;
      if (path === "/api/diff") return diff(id, "m_project", "f_budget", "1");
      if (path === "/api/activity") return [];
      if (path === "/api/draft/discard" && discardFails) throw new Error("discard unavailable");
      return { ok: true };
    });
    mount(client, { config: { cardPerDraft: true }, surface: { discardNote: true } });
    await waitFor(() => expect(cards()).toHaveLength(3));
    fireEvent.click(within(cards()[0]!).getByRole("button", { name: "Discard" }));
    const dialog = await screen.findByRole("dialog", { name: "Discard this draft?" });
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Not yet." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard draft" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "The draft was not discarded.",
    );
    expect(screen.getByRole("dialog", { name: "Discard this draft?" })).toBeTruthy();
    expect((within(dialog).getByRole("textbox") as HTMLTextAreaElement).value).toBe("Not yet.");
    // A retry that lands closes the dialog.
    discardFails = false;
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard draft" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Discard this draft?" })).toBeNull(),
    );
    const discards = client.postJson.mock.calls.filter((call) => call[0] === "/api/draft/discard");
    expect(discards).toHaveLength(2);
  });

  it("keeps Publish, Discard and Revert by default, as hc's Approvals page uses it", async () => {
    mount(fakeClient());
    await waitFor(() => expect(cards()).toHaveLength(1));
    expect(within(cards()[0]!).getAllByRole("button", { name: "Publish" }).length).toBe(3);
    expect(within(cards()[0]!).getAllByRole("button", { name: "Discard" }).length).toBe(3);
    fireEvent.click(screen.getByRole("radio", { name: /^Published/ }));
    await waitFor(() => expect(cards()).toHaveLength(1));
    expect(within(cards()[0]!).getByRole("button", { name: "Revert" })).toBeTruthy();
  });

  it("read-only shows the same cards and footers without Publish, Discard or Revert", async () => {
    for (const config of [{}, { cardPerDraft: true }]) {
      const view = mount(fakeClient(), {
        config,
        surface: {
          readOnly: true,
          discardNote: true,
          renderCardFooter: (card) => (card.kind === "named" ? <span>Threads</span> : null),
        },
      });
      await waitFor(() => expect(cards().length).toBeGreaterThan(0));
      expect(screen.queryByRole("button", { name: /^(Publish|Discard|Revert)$/ })).toBeNull();
      fireEvent.click(screen.getByRole("radio", { name: /^Published/ }));
      await waitFor(() => expect(cards()[0]!.getAttribute("data-card-status")).toBe("published"));
      expect(screen.queryByRole("button", { name: /^(Publish|Discard|Revert)$/ })).toBeNull();
      expect(screen.queryByRole("dialog")).toBeNull();
      view.unmount();
    }
  });

  it("without pending drafts is the published history alone, and never reads drafts", async () => {
    const client = fakeClient();
    mount(client, { config: { cardPerDraft: true, pending: false } });
    await waitFor(() => expect(cards()).toHaveLength(1));
    const tabs = screen.getByRole("radiogroup", { name: "Approval status" });
    expect(
      within(tabs)
        .getAllByRole("radio")
        .map((radio) => radio.textContent),
    ).toEqual(["Published (1)"]);
    expect(cards()[0]!.getAttribute("data-card-status")).toBe("published");
    expect(document.querySelector("[data-pending]")!.getAttribute("data-pending")).toBe("0");
    expect(client.getJson).not.toHaveBeenCalled();
  });

  it("renders app content under each card", async () => {
    mount(fakeClient(), {
      config: { cardPerDraft: true },
      surface: {
        renderCardFooter: (card) =>
          card.kind === "named" ? <span>Threads for draft {card.change_set_id}</span> : null,
      },
    });
    await screen.findByText("Threads for draft 3");
    expect(document.querySelectorAll("[data-card-footer]")).toHaveLength(3);
  });
});
