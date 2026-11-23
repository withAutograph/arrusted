import { useRef, useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  CommentModeProvider,
  CommentModeToggle,
  ThreadPin,
  threadsOn,
  useCommentMode,
  type ThreadAnchor,
} from "../comment-mode";
import { ThreadPopover } from "../thread-popover";
import { UnitFrame } from "../unit-frame";
import { useCanvasSession } from "../use-canvas-session";
import {
  Select,
  act,
  definition,
  ids,
  recordName,
  useSeededCanvas,
} from "./fixtures/threads-rules";

const people = [
  { id: ids.amara, name: "Amara Okafor", team: "Engineering", rate: "£720/day" },
  { id: ids.ben, name: "Ben Lindqvist", team: "Design", rate: "£610/day" },
  { id: ids.chen, name: "Chen Wei", team: "Engineering", rate: "£845/day" },
  { id: ids.dara, name: "Dara Murphy", team: "Research", rate: "£690/day" },
];

/** Placeholder unit content: rows a click can anchor a thread to. */
function PeopleList({
  unitId,
  rows = people,
  pins,
}: {
  unitId: string;
  rows?: typeof people;
  pins?: (id: string) => ReactNode;
}) {
  const comment = useCommentMode();
  return (
    <ul className="m-[var(--space-0)] list-none p-[var(--space-0)]">
      {rows.map((person) => (
        <li
          className="flex items-center justify-between gap-[var(--space-3)] border-b border-[var(--color-border-subtle)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-body)] last:border-b-0 hover:bg-[var(--color-bg-hover)]"
          data-row={person.id}
          key={person.id}
          onClick={(event) => {
            if (comment.anchor({ unit_id: unitId, model_id: "m_person", record_id: person.id }))
              event.stopPropagation();
          }}
        >
          <span className="flex items-center gap-[var(--space-2)] text-[var(--color-text-primary)]">
            {person.name}
            {pins?.(person.id)}
          </span>
          <span className="text-[var(--color-text-muted)]">{person.team}</span>
          <span className="tabular-nums text-[var(--color-text-secondary)]">{person.rate}</span>
        </li>
      ))}
    </ul>
  );
}

const page = "min-h-screen bg-[var(--color-bg-page)] p-[var(--space-6)] font-[var(--font-sans)]";
const control = (
  <Select
    aria-label="Group by"
    options={[
      { value: "team", label: "By team" },
      { value: "none", label: "No grouping" },
    ]}
    size="xs"
    value="team"
    onValueChange={() => {}}
  />
);

function Sizes() {
  return (
    <div className={`${page} flex flex-wrap items-start gap-[var(--space-6)]`}>
      <div style={{ width: 280, height: 180 }}>
        <UnitFrame title="Small" unitId="u-small" onRemove={() => {}}>
          <PeopleList unitId="u-small" />
        </UnitFrame>
      </div>
      <div style={{ width: 440, height: 280 }}>
        <UnitFrame controls={control} title="People by team" unitId="u-medium" onRemove={() => {}}>
          <PeopleList unitId="u-medium" />
        </UnitFrame>
      </div>
      <div style={{ width: 640, height: 220 }}>
        <UnitFrame
          controls={control}
          pins={<ThreadPin count={2} target="People and their day rates" onOpen={() => {}} />}
          title="People and their day rates across every team this quarter"
          unitId="u-wide"
          onRemove={() => {}}
        >
          <PeopleList
            unitId="u-wide"
            rows={[...people, ...people].map((row, index) => ({
              ...row,
              id: `${row.id}-${index}`,
            }))}
          />
        </UnitFrame>
      </div>
      <div style={{ width: 320, height: 200 }}>
        <UnitFrame title="Empty unit" unitId="u-empty">
          <p className="m-[var(--space-0)] p-[var(--space-4)] text-[length:var(--text-body)] text-[var(--color-text-muted)]">
            Nothing to show yet.
          </p>
        </UnitFrame>
      </div>
      <div style={{ width: 320, height: 200 }}>
        <UnitFrame title="Broken unit" unitId="u-broken" onRemove={() => {}}>
          <Throws />
        </UnitFrame>
      </div>
    </div>
  );
}
function Throws(): ReactNode {
  throw new Error("story: a unit that fails to render");
}

/** Comment mode on: a click on a row anchors there, elsewhere in a unit to the unit, and opens the thread. */
function CommentMode() {
  const { canvas, ready } = useSeededCanvas(async (seeded) => {
    await act(seeded, {
      operation: "thread_open",
      thread_id: "d0000000-0000-4000-8000-0000000000aa",
      anchor: { unit_id: "u-people", model_id: "m_person", record_id: ids.chen },
    });
    await act(seeded, {
      operation: "thread_open",
      thread_id: "d0000000-0000-4000-8000-0000000000bb",
      anchor: { unit_id: "u-people" },
    });
  });
  const session = useCanvasSession(canvas.client, ids.session);
  const [openThread, setOpenThread] = useState<string | null>(null);
  /** The popover opens beside the units. */
  const units = useRef<HTMLDivElement | null>(null);
  if (!ready) return null;
  const pinFor = (target: ThreadAnchor, name: string) => {
    const on = threadsOn(session.threads, target);
    return <ThreadPin count={on.length} target={name} onOpen={() => setOpenThread(on[0]!.id)} />;
  };
  return (
    <CommentModeProvider initiallyOn threadOpen={session.threadOpen} onOpened={setOpenThread}>
      <div className={page}>
        <div className="mb-[var(--space-4)] flex items-center justify-between rounded-[var(--radius-panel)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-[var(--space-4)] py-[var(--space-2)]">
          <span className="text-[length:var(--text-control-md)] font-[var(--font-weight-semibold)] text-[var(--color-text-primary)]">
            Q4 staffing review
          </span>
          <CommentModeToggle />
        </div>
        <div className="flex gap-[var(--space-6)]" ref={units}>
          <div style={{ width: 460, height: 260 }}>
            <UnitFrame
              controls={control}
              pins={pinFor({ unit_id: "u-people" }, "People")}
              title="People"
              unitId="u-people"
              onRemove={() => {}}
            >
              <PeopleList
                pins={(id) =>
                  pinFor(
                    { unit_id: "u-people", model_id: "m_person", record_id: id },
                    recordName("m_person", id) ?? "",
                  )
                }
                unitId="u-people"
              />
            </UnitFrame>
          </div>
        </div>
        <p
          className="mt-[var(--space-3)] text-[length:var(--text-caption)] text-[var(--color-text-muted)]"
          data-thread-count={session.threads.length}
        >
          {session.threads.length} threads in the session
        </p>
      </div>
      <ThreadPopover
        anchorRef={units}
        definition={definition}
        recordName={recordName}
        session={session}
        thread={session.threads.find((item) => item.id === openThread) ?? null}
        unitTitle={(id) => (id === "u-people" ? "People" : undefined)}
        onClose={() => setOpenThread(null)}
      />
    </CommentModeProvider>
  );
}

const meta = {
  title: "Canvas/Frame",
  parameters: { layout: "fullscreen" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const SizesAndPin: Story = { render: () => <Sizes /> };
export const CommentModeOn: Story = { render: () => <CommentMode /> };
