import { render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vite-plus/test";

import type { CanvasClient } from "../client";
import { CommentModeProvider, CommentModeToggle, threadsOn, useCommentMode } from "../comment-mode";
import { RuleCard } from "../rule-card";
import { ThreadPopover } from "../thread-popover";
import { UnitFrame } from "../unit-frame";
import { useCanvasSession, type CanvasSession } from "../use-canvas-session";
import {
  act,
  dayRate,
  definition,
  ids,
  memoryCanvas,
  recordName,
  rules,
  type StoryCanvas,
} from "../stories/fixtures/threads-rules";

const THREAD = "d0000000-0000-4000-8000-000000000001";

async function mount(client: CanvasClient) {
  const hook = renderHook(() => useCanvasSession(client, ids.session));
  await waitFor(() => expect(hook.result.current.status).toBe("ready"));
  return hook;
}
const noIds = (text: string) => {
  for (const id of [
    ids.amara,
    ids.dara,
    "f_day_rate",
    "f_budget",
    "f_status",
    "m_person",
    "m_project",
  ])
    expect(text).not.toContain(id);
};

describe("comment mode", () => {
  function Row({ onPlain }: { onPlain: () => void }) {
    const comment = useCommentMode();
    return (
      <button
        type="button"
        onClick={(event) => {
          if (comment.anchor({ unit_id: "u1", model_id: "m_person", record_id: ids.amara })) {
            event.stopPropagation();
            return;
          }
          onPlain();
        }}
      >
        Amara
      </button>
    );
  }
  function setup() {
    const threadOpen = vi.fn<CanvasSession["threadOpen"]>(async () => ({ ok: true, revision: 2 }));
    const onOpened = vi.fn();
    const onPlain = vi.fn();
    render(
      <CommentModeProvider threadOpen={threadOpen} onOpened={onOpened}>
        <CommentModeToggle />
        <UnitFrame title="People" unitId="u1">
          <Row onPlain={onPlain} />
          <p>Empty space</p>
        </UnitFrame>
      </CommentModeProvider>,
    );
    return { threadOpen, onOpened, onPlain };
  }

  test("the next click anchors a new thread to the row under it, then comment mode ends", async () => {
    const { threadOpen, onOpened, onPlain } = setup();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Comment" }));
    expect(screen.getByRole("button", { name: "Comment" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Amara" }));
    expect(threadOpen).toHaveBeenCalledTimes(1);
    const [threadId, anchor] = threadOpen.mock.calls[0]!;
    expect(anchor).toEqual({ unit_id: "u1", model_id: "m_person", record_id: ids.amara });
    await waitFor(() => expect(onOpened).toHaveBeenCalledWith(threadId, anchor));
    expect(onPlain).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Comment" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    // Off again: a click is an ordinary click.
    await user.click(screen.getByRole("button", { name: "Amara" }));
    expect(onPlain).toHaveBeenCalledTimes(1);
    expect(threadOpen).toHaveBeenCalledTimes(1);
  });

  test("a click no target claims falls back to the unit", async () => {
    const { threadOpen } = setup();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Comment" }));
    await user.click(screen.getByText("Empty space"));
    expect(threadOpen).toHaveBeenCalledTimes(1);
    expect(threadOpen.mock.calls[0]![1]).toEqual({ unit_id: "u1" });
  });

  test("pins count only the open threads on exactly that target", () => {
    const thread = (id: string, anchor: object, resolved = false) =>
      ({ id, anchor, resolved, messages: [] }) as never;
    const threads = [
      thread("a", { unit_id: "u1" }),
      thread("b", { unit_id: "u1", model_id: "m", record_id: "r1" }),
      thread("c", { unit_id: "u1", model_id: "m", record_id: "r1", field_id: "f" }),
      thread("d", { unit_id: "u1", model_id: "m", record_id: "r1" }, true),
    ];
    expect(threadsOn(threads, { unit_id: "u1" }).map((t) => t.id)).toEqual(["a"]);
    expect(threadsOn(threads, { model_id: "m", record_id: "r1" }).map((t) => t.id)).toEqual(["b"]);
    expect(
      threadsOn(threads, { model_id: "m", record_id: "r1", field_id: "f" }).map((t) => t.id),
    ).toEqual(["c"]);
  });
});

describe("thread popover", () => {
  const proposeRates = (canvas: StoryCanvas, amounts: [string, string][]) =>
    act(
      canvas,
      {
        operation: "propose",
        thread_id: THREAD,
        changes: amounts.map(([record_id, amount]) => ({
          model_id: "m_person",
          record_id,
          field_id: "f_day_rate",
          value: dayRate(amount),
        })),
      },
      ids.turn,
    );
  async function seeded() {
    const canvas = memoryCanvas();
    await act(canvas, {
      operation: "thread_open",
      thread_id: THREAD,
      anchor: { unit_id: "u1", model_id: "m_person", record_id: ids.amara, field_id: "f_day_rate" },
    });
    await act(canvas, { operation: "thread_reply", thread_id: THREAD, message: "Raise Amara?" });
    await proposeRates(canvas, [
      [ids.amara, "800"],
      [ids.dara, "800"],
    ]);
    return canvas;
  }
  /** The cell the popover opens beside. */
  const cell = { current: document.createElement("div") };
  function Popover({ session }: { session: CanvasSession }) {
    return (
      <ThreadPopover
        anchorRef={cell}
        definition={definition}
        recordName={(model, record) =>
          record === ids.dara ? undefined : recordName(model, record)
        }
        session={session}
        thread={session.threads.find((t) => t.id === THREAD) ?? null}
        onClose={() => {}}
      />
    );
  }

  test("opens as a small dialog beside its anchor, and closes on an outside click", async () => {
    const canvas = await seeded();
    const hook = await mount(canvas.client);
    document.body.append(cell.current);
    const onClose = vi.fn();
    render(
      <ThreadPopover
        anchorRef={cell}
        definition={definition}
        recordName={recordName}
        session={hook.result.current}
        thread={hook.result.current.threads.find((t) => t.id === THREAD) ?? null}
        onClose={onClose}
      />,
    );
    const popover = screen.getByRole("dialog", { name: "Thread" });
    // Pinned to Amara's day rate: named by record and column header.
    expect(within(popover).getByText(/Amara Okafor · Day rate/u)).toBeInTheDocument();
    await userEvent.setup().click(cell.current);
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.setup().click(document.body);
    expect(onClose).toHaveBeenCalled();
    cell.current.remove();
  });

  test("names the anchor and proposal rows by record name and column header, never ids", async () => {
    const canvas = await seeded();
    const hook = await mount(canvas.client);
    render(<Popover session={hook.result.current} />);
    const rows = screen.getByRole("list", { name: "Proposed changes" });
    expect(within(rows).getByText("Amara Okafor")).toBeInTheDocument();
    expect(within(rows).getByText("a Person outside this view")).toBeInTheDocument();
    expect(within(rows).getAllByText("Day rate")).toHaveLength(2);
    expect(screen.getByText("Raise Amara?")).toBeInTheDocument();
    noIds(document.body.textContent ?? "");
  });

  test("Pull of a proposal that changed says so and pulls nothing", async () => {
    const canvas = await seeded();
    const base = canvas.client;
    const client: CanvasClient = {
      ...base,
      session: {
        request: async (input) => {
          if (input.operation === "pull") await proposeRates(canvas, [[ids.amara, "820"]]);
          return base.session.request(input);
        },
      },
    };
    const hook = await mount(client);
    const view = render(<Popover session={hook.result.current} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Add to unsaved changes" }));
    await waitFor(() => expect(document.querySelector("[data-proposal-changed]")).not.toBeNull());
    view.rerender(<Popover session={hook.result.current} />);
    expect(hook.result.current.entries).toHaveLength(0);
    expect(
      within(screen.getByRole("list", { name: "Proposed changes" })).getByText("£820/day", {
        exact: false,
      }),
    ).toBeInTheDocument();
  });

  test("Pull and Dismiss act only on the proposal shown, not a replacement read before it renders", async () => {
    const canvas = await seeded();
    const hook = await mount(canvas.client);
    // The popover keeps showing the first proposal while the session reads its replacement.
    render(<Popover session={hook.result.current} />);
    await proposeRates(canvas, [[ids.amara, "820"]]);
    await waitFor(() => expect(hook.result.current.threads[0]?.proposal?.changes).toHaveLength(1));
    const user = userEvent.setup();
    for (const name of ["Add to unsaved changes", "Dismiss"]) {
      await user.click(screen.getByRole("button", { name }));
      await waitFor(() => expect(document.querySelector("[data-proposal-changed]")).not.toBeNull());
    }
    expect(hook.result.current.entries).toHaveLength(0);
    expect(hook.result.current.threads[0]?.proposal?.changes).toHaveLength(1);
  });

  test("reply and resolve go to the session", async () => {
    const canvas = await seeded();
    const hook = await mount(canvas.client);
    const view = render(<Popover session={hook.result.current} />);
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "Message the agent" }), "Hold Dara{Enter}");
    await waitFor(() =>
      expect(
        hook.result.current.threads.find((t) => t.id === THREAD)?.messages.map((m) => m.message),
      ).toEqual(["Raise Amara?", "Hold Dara"]),
    );
    view.rerender(<Popover session={hook.result.current} />);
    await user.click(screen.getByRole("button", { name: "Resolve" }));
    await waitFor(() =>
      expect(hook.result.current.threads.find((t) => t.id === THREAD)?.resolved).toBe(true),
    );
    view.rerender(<Popover session={hook.result.current} />);
    expect(screen.getByText("Resolved")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
  });
});

describe("rule card", () => {
  async function withRule(rule: keyof typeof rules, turn?: string) {
    const canvas = memoryCanvas();
    await act(canvas, { operation: "rule_create", rule_id: "r1", rule: rules[rule] }, turn);
    const hook = await mount(canvas.client);
    const card = () => (
      <RuleCard
        definition={definition}
        rule={hook.result.current.rules[0]!}
        session={hook.result.current}
      />
    );
    const view = render(card());
    return { hook, rerender: () => view.rerender(card()) };
  }

  test("says the rule in plain words by column header, with its author", async () => {
    await withRule("atRisk");
    const words = document.querySelector("[data-rule-words]")!.textContent!;
    expect(words).toBe("Sets Status to At risk for each Project where Budget is more than 300000.");
    expect(screen.getByText("By you")).toBeInTheDocument();
    noIds(document.body.textContent ?? "");
  });

  test("an agent's money parameter edits in place through rule_parameters", async () => {
    const { hook, rerender } = await withRule("rateFloor", ids.turn);
    expect(screen.getByText("By the agent")).toBeInTheDocument();
    expect(document.querySelector("[data-rule-words]")!.textContent).toContain(
      "Sets Day rate to the larger of Day rate and £800/day for each Person where Team is Engineering.",
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /rate floor/ }));
    const amount = screen.getByLabelText("rate floor amount");
    await user.clear(amount);
    await user.type(amount, "850{Enter}");
    await waitFor(() =>
      expect(hook.result.current.rules[0]!.parameters).toEqual({ rate_floor: dayRate("850") }),
    );
    rerender();
    expect(document.querySelector("[data-rule-words]")!.textContent).toContain("£850/day");
  });

  test("Remove asks once more, then removes the rule", async () => {
    const { hook } = await withRule("atRisk");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(hook.result.current.rules).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: /^Remove rule and its changes\?/ }));
    await waitFor(() => expect(hook.result.current.rules).toHaveLength(0));
  });
});
