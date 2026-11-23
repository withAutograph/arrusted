// RelationGraph stories — fixture data only. Captions are real column
// headers from an HR-style schema; the component itself knows none of them.
// The graph is flat content, so each story hosts it on a surface card, as
// Explore and the canvas graph unit do.

import { useState } from "react";

import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  RelationGraph,
  capRelationGroup,
  type RelationGraphGroup,
  type RelationGraphItem,
  type RelationGraphProps,
} from "./relation-graph";

const noop = () => {};
const moreLabel = (hidden: number) => `+${hidden} more`;

const meta = {
  title: "Org Chart / RelationGraph",
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div
        style={{
          width: "100vw",
          height: "100vh",
          boxSizing: "border-box",
          display: "flex",
          padding: 24,
          background: "var(--color-bg-page)",
          color: "var(--color-text-primary)",
          fontFamily: "var(--font-sans)",
        }}
      >
        <section
          style={{
            display: "flex",
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            border: "1px solid var(--color-border-subtle)",
            borderRadius: "var(--radius-panel)",
            background: "var(--color-bg-surface)",
          }}
        >
          <Story />
        </section>
      </div>
    ),
  ],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** One single-item group per column header. */
function columns(entries: ReadonlyArray<[header: string, value?: string]>): RelationGraphGroup[] {
  return entries.map(([header, value]) => ({
    id: header,
    items: [
      value === undefined
        ? { id: header, primary: header }
        : { id: `${header}=${value}`, primary: value, caption: header },
    ],
  }));
}

function people(names: readonly string[]): RelationGraphItem[] {
  return names.map((name) => ({ id: name, primary: name }));
}

const REPORTS = [
  "George Michael",
  "Maeby Fünke",
  "Steve Holt",
  "Tobias Fünke",
  "Lindsay Bluth",
  "Buster Bluth",
  "Kitty Sanchez",
  "Barry Zuckerkorn",
];

const MEMBER_NAMES = [
  "Ann Veal",
  "Jane Doe",
  "George Michael",
  ...Array.from({ length: 54 }, (_, i) => `Member ${i + 4}`),
];

const JANE_LEFT = columns([
  ["Manager", "Ann Veal"],
  ["Position", "Staff Engineer"],
]);

const JANE_RIGHT = columns([
  ["Department", "Engineering"],
  ["Work Location", "San Francisco"],
  ["Job Family", "Software Engineering"],
  ["Business Unit", "Platform"],
  ["P&L Category", "Research & Development"],
  ["Compensation Level", "L6"],
]);

function reportsGroup(names: readonly string[]): RelationGraphGroup {
  return capRelationGroup({
    id: "reports",
    items: people(names),
    total: names.length,
    overflowLabel: moreLabel,
    onOverflow: noop,
  });
}

const SCHEMA_EMPLOYEE: RelationGraphProps = {
  centre: { primary: "Employee" },
  left: columns([["Manager"], ["Position"]]),
  right: columns([
    ["Department"],
    ["Work Location"],
    ["Job Family"],
    ["Business Unit"],
    ["P&L Category"],
    ["Compensation Level"],
  ]),
  onSelect: noop,
};

const RECORD_JANE: RelationGraphProps = {
  centre: { primary: "Jane Doe" },
  left: JANE_LEFT,
  right: JANE_RIGHT,
  below: [reportsGroup(REPORTS.slice(0, 3))],
  onSelect: noop,
};

const RECORD_JANE_MANY_REPORTS: RelationGraphProps = {
  ...RECORD_JANE,
  below: [reportsGroup(REPORTS)],
};

const RECORD_DEPARTMENT: RelationGraphProps = {
  centre: { primary: "Engineering" },
  left: [],
  right: [],
  below: [
    capRelationGroup({
      id: "members",
      items: people(MEMBER_NAMES.slice(0, 3)),
      total: MEMBER_NAMES.length,
      overflowLabel: moreLabel,
      onOverflow: noop,
    }),
  ],
  onSelect: noop,
};

const RECORD_POSITION: RelationGraphProps = {
  centre: { primary: "Staff Engineer" },
  left: columns([["Reports To Position", "Engineering Manager"]]),
  right: columns([
    ["Department", "Engineering"],
    ["Work Location", "San Francisco"],
    ["Business Unit", "Platform"],
    ["Job Family", "Software Engineering"],
    ["Level", "L6"],
    ["P&L Category", "Research & Development"],
    ["Employee", "Jane Doe"],
  ]),
  onSelect: noop,
};

const RECORD_PENDING: RelationGraphProps = {
  centre: { primary: "Jane Doe" },
  left: [],
  right: [],
  below: [],
  pending: true,
  onSelect: noop,
};

const RECORD_ANN: RelationGraphProps = {
  centre: { primary: "Ann Veal" },
  left: columns([
    ["Manager", "Lucille Bluth"],
    ["Position", "Engineering Manager"],
  ]),
  right: columns([
    ["Department", "Engineering"],
    ["Work Location", "San Francisco"],
    ["Job Family", "Software Engineering"],
    ["Business Unit", "Platform"],
    ["P&L Category", "Research & Development"],
    ["Compensation Level", "M2"],
  ]),
  below: [reportsGroup(["Jane Doe", "Gob Bluth"])],
  onSelect: noop,
};

export const SchemaEmployee: Story = { render: () => <RelationGraph {...SCHEMA_EMPLOYEE} /> };

export const RecordEmployee: Story = { render: () => <RelationGraph {...RECORD_JANE} /> };

export const RecordEmployeeManyReports: Story = {
  render: () => <RelationGraph {...RECORD_JANE_MANY_REPORTS} />,
};

/** Twelve right-side cards wrap into three brick-offset columns. */
export const RecordEmployeeManyColumns: Story = {
  render: () => (
    <RelationGraph
      {...RECORD_JANE}
      right={[
        ...JANE_RIGHT,
        ...columns([
          ["Employment Status", "Active"],
          ["Start Date", "Mar 4, 2021"],
          ["Work Email", "jane.doe@example.test"],
          ["Employee Ref", "E-1042"],
          ["Base Salary", "$212,000 / yr"],
          ["Target Bonus", "15%"],
        ]),
      ]}
    />
  ),
};

export const RecordDepartment: Story = { render: () => <RelationGraph {...RECORD_DEPARTMENT} /> };

export const RecordPosition: Story = { render: () => <RelationGraph {...RECORD_POSITION} /> };

export const Pending: Story = { render: () => <RelationGraph {...RECORD_PENDING} /> };

// ---- Framed groups ----
// A mapping table's look-through relations sit in one box captioned with the
// table's label; the host supplies the caption.

function framed(
  caption: string,
  items: RelationGraphItem[],
  onSelect: (() => void) | undefined = noop,
): RelationGraphGroup {
  return {
    id: `${caption}:${items.map((item) => item.id).join(",")}`,
    items,
    frame: { caption, onSelect },
  };
}

const JANE_ASSIGNMENT = framed("Org Assignment", [
  { id: "position", primary: "Staff Engineer", caption: "Position" },
  { id: "manager", primary: "Ann Veal", caption: "Manager" },
]);

const FRAMED_RECORD_JANE: RelationGraphProps = {
  centre: { primary: "Jane Doe" },
  left: [JANE_ASSIGNMENT],
  right: JANE_RIGHT,
  below: [reportsGroup(REPORTS.slice(0, 3))],
  onSelect: noop,
};

const FRAMED_SCHEMA_EMPLOYEE: RelationGraphProps = {
  ...SCHEMA_EMPLOYEE,
  left: [
    framed("Org Assignment", [
      { id: "position", primary: "Position" },
      { id: "manager", primary: "Manager" },
    ]),
  ],
};

/**
 * A mapping row's other relations all sit in one frame on the left: who
 * fills the position and what it reports to. Its own values go right.
 */
const FRAMED_RECORD_POSITION: RelationGraphProps = {
  centre: { primary: "Staff Engineer" },
  left: [
    framed("Org Assignment", [
      { id: "employee", primary: "Jane Doe", caption: "Employee" },
      { id: "reports-to", primary: "Engineering Manager", caption: "Reports To Position" },
    ]),
  ],
  right: columns([
    ["Department", "Engineering"],
    ["Work Location", "San Francisco"],
    ["Business Unit", "Platform"],
    ["Job Family", "Software Engineering"],
    ["Level", "L6"],
    ["P&L Category", "Research & Development"],
  ]),
  onSelect: noop,
};

/** A framed group in the below row, beside a plain one. */
const FRAMED_RECORD_ANN_BELOW: RelationGraphProps = {
  centre: { primary: "Ann Veal" },
  left: columns([["Position", "Engineering Manager"]]),
  right: columns([
    ["Department", "Engineering"],
    ["Work Location", "San Francisco"],
  ]),
  below: [
    framed("Org Assignment", people(["Jane Doe", "Gob Bluth"])),
    { id: "others", items: people(["Steve Holt"]) },
  ],
  onSelect: noop,
};

export const FramedRecordEmployee: Story = {
  render: () => <RelationGraph {...FRAMED_RECORD_JANE} />,
};

export const FramedSchemaEmployee: Story = {
  render: () => <RelationGraph {...FRAMED_SCHEMA_EMPLOYEE} />,
};

export const FramedRecordPosition: Story = {
  render: () => <RelationGraph {...FRAMED_RECORD_POSITION} />,
};

export const FramedBelow: Story = {
  render: () => <RelationGraph {...FRAMED_RECORD_ANN_BELOW} />,
};

/** Hover or tab to the "Org Assignment" caption; it is a button. */
export const FramedCaptionStates: Story = {
  render: () => <RelationGraph {...FRAMED_RECORD_JANE} />,
};

const RECENTRE_FIXTURES: Record<string, RelationGraphProps> = {
  "Jane Doe": RECORD_JANE,
  "Ann Veal": RECORD_ANN,
  "Staff Engineer": RECORD_POSITION,
  Engineering: RECORD_DEPARTMENT,
};

function RecentreHarness() {
  const [centre, setCentre] = useState("Jane Doe");
  const fixture = RECENTRE_FIXTURES[centre]!;
  return (
    <RelationGraph
      {...fixture}
      onSelect={(item) => {
        if (RECENTRE_FIXTURES[item.primary]) setCentre(item.primary);
      }}
    />
  );
}

/** Click "Ann Veal", "Staff Engineer", "Engineering" or "Jane Doe" to re-centre. */
export const Recentre: Story = { render: () => <RecentreHarness /> };
