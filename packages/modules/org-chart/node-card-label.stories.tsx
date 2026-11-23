// NodeCard label-form stories — the single-block card a relationship graph
// uses for its neighbours, its centre, pending placeholders, and overflow.
//
// Every card sits in a fixed box, the same way the canvas `nodeSize`
// sizes it, so truncation is proven against a real width.

import type { Meta, StoryObj } from "@storybook/react-vite";

import { NodeCard, type NodeCardLabel, type NodeCardState } from "./node-card";

const BOX = { width: 208, height: 56 };

const meta = {
  title: "Org Chart / NodeCard Label",
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div
        style={{
          minHeight: "100vh",
          background: "var(--color-bg-page)",
          color: "var(--color-text-primary)",
          fontFamily: "var(--font-sans)",
          padding: "var(--space-8)",
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function Box({ children }: { children: React.ReactNode }) {
  return <div style={{ width: BOX.width, height: BOX.height }}>{children}</div>;
}

/** Story chrome only: names the state a sheet cell demonstrates. */
function Cell({ note, children }: { note: string; children: React.ReactNode }) {
  return (
    <figure style={{ margin: 0, display: "grid", gap: "var(--space-2)" }}>
      <figcaption
        style={{
          fontSize: "var(--text-micro)",
          color: "var(--color-text-muted)",
          fontFamily: "var(--font-mono)",
        }}
      >
        {note}
      </figcaption>
      {children}
    </figure>
  );
}

const SCHEMA_NEIGHBOUR: NodeCardLabel = { primary: "Department" };
const RECORD_NEIGHBOUR: NodeCardLabel = { primary: "Ann Veal", caption: "Manager" };
const CENTRE_SCHEMA: NodeCardLabel = { primary: "Employee" };
const CENTRE_RECORD: NodeCardLabel = { primary: "Jane Doe" };
const PENDING: NodeCardLabel = { primary: "Loading", muted: true };
const LONG_TEXT: NodeCardLabel = {
  primary: "Research and Development, Platform Infrastructure",
  caption: "Profit and Loss Category for Reporting",
};
const OVERFLOW: NodeCardLabel = { primary: "+54 more", muted: true };

function Single({ label, state }: { label: NodeCardLabel; state?: NodeCardState }) {
  return (
    <Box>
      <NodeCard label={label} state={state} />
    </Box>
  );
}

export const SchemaNeighbour: Story = {
  render: () => <Single label={SCHEMA_NEIGHBOUR} />,
};

export const RecordNeighbour: Story = {
  render: () => <Single label={RECORD_NEIGHBOUR} />,
};

export const CentreSchema: Story = {
  render: () => <Single label={CENTRE_SCHEMA} state="current" />,
};

export const CentreRecord: Story = {
  render: () => <Single label={CENTRE_RECORD} state="current" />,
};

export const Pending: Story = {
  render: () => <Single label={PENDING} state="pending" />,
};

export const LongText: Story = {
  render: () => <Single label={LONG_TEXT} />,
};

export const Overflow: Story = {
  render: () => <Single label={OVERFLOW} />,
};

/** Every static state side by side, for one-glance review. */
export const StateSheet: Story = {
  render: () => (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(4, ${BOX.width}px)`,
        gap: "var(--space-6) var(--space-8)",
      }}
    >
      <Cell note="schema neighbour">
        <Single label={SCHEMA_NEIGHBOUR} />
      </Cell>
      <Cell note="record neighbour">
        <Single label={RECORD_NEIGHBOUR} />
      </Cell>
      <Cell note="centre, schema">
        <Single label={CENTRE_SCHEMA} state="current" />
      </Cell>
      <Cell note="centre, record">
        <Single label={CENTRE_RECORD} state="current" />
      </Cell>
      <Cell note="pending">
        <Single label={PENDING} state="pending" />
      </Cell>
      <Cell note="long text">
        <Single label={LONG_TEXT} />
      </Cell>
      <Cell note="overflow">
        <Single label={OVERFLOW} />
      </Cell>
    </div>
  ),
};

/**
 * Activatable cards inside a `role="button"` host, as the canvas node
 * wrapper renders them. Screenshot capture hovers the first card and
 * tab-focuses the second.
 */
function activate(id: string) {
  console.info(`activated ${id}`);
}

export const Interactive: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "var(--space-6)" }}>
      {[
        { id: "hover", label: RECORD_NEIGHBOUR },
        { id: "focus", label: { primary: "Engineering", caption: "Department" } },
        { id: "rest", label: { primary: "Work Location" } },
      ].map(({ id, label }) => (
        <div
          key={id}
          data-story-card={id}
          role="button"
          tabIndex={0}
          aria-label={label.caption ? `${label.caption}: ${label.primary}` : label.primary}
          onClick={() => activate(id)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            activate(id);
          }}
          style={{ width: BOX.width, height: BOX.height, cursor: "pointer" }}
        >
          <NodeCard label={label} />
        </div>
      ))}
    </div>
  ),
};
