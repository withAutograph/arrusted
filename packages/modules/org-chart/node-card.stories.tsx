// NodeCard stories — visual verification of the linked-card leaf in
// isolation. Stories cover the (occupant × state × details) matrix
// and an accent palette demonstrating apps mapping their domain
// category onto the detail dots.

import type { Meta, StoryObj } from "@storybook/react-vite";

import { NodeCard } from "./node-card";

// Story-local accent palette per fixture group. The module ships no
// domain palette — apps own the mapping and declare equivalent
// variables wherever their canvas lives. Scoped to the decorator
// wrapper so the story file is the only place these colors live.
const STORY_PALETTE: React.CSSProperties = {
  ["--story-accent-eng" as string]: "#8192ff",
  ["--story-accent-prod" as string]: "#b78ad6",
  ["--story-accent-design" as string]: "#e98aa5",
  ["--story-accent-sales" as string]: "#eb8526",
  ["--story-accent-ops" as string]: "#17b196",
};

const meta = {
  title: "Org Chart / NodeCard",
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div
        style={{
          ...STORY_PALETTE,
          minHeight: "100vh",
          background: "var(--color-bg-page)",
          color: "var(--color-text-primary)",
          fontFamily: "var(--font-sans)",
          padding: "var(--space-8)",
          display: "flex",
          flexWrap: "wrap",
          alignItems: "flex-start",
          gap: "var(--space-6)",
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const ALICE = {
  slot: {
    title: "Platform Lead",
    badge: "L7",
    details: [
      {
        label: "Platform",
        accent: { color: "var(--story-accent-eng)", label: "Platform" },
      },
      { label: "San Francisco, CA" },
    ] as const,
  },
  occupant: {
    primary: "Alice Park",
    details: [{ label: "alice.park@example.test" }] as const,
  },
};

const JORDAN = {
  slot: {
    title: "Senior Builder, Backend",
    badge: "L5",
    details: [
      {
        label: "Platform",
        accent: { color: "var(--story-accent-eng)", label: "Platform" },
      },
      { label: "San Francisco, CA" },
    ] as const,
  },
  occupant: {
    primary: "Jordan Lee",
    details: [{ label: "jordan.lee@example.test" }] as const,
  },
};

const FRONTEND_EMPTY = {
  slot: {
    title: "SW Builder, Frontend",
    badge: "L4",
    details: [
      {
        label: "Platform",
        accent: { color: "var(--story-accent-eng)", label: "Platform" },
      },
      { label: "Remote (US)" },
    ] as const,
  },
};

const CAROL = {
  slot: {
    title: "Head of Experience",
    badge: "L6",
    details: [
      {
        label: "Experience",
        accent: { color: "var(--story-accent-design)", label: "Experience" },
      },
      { label: "San Francisco, CA" },
    ] as const,
  },
  occupant: {
    primary: "Carol Singh",
    details: [{ label: "carol.singh@example.test" }] as const,
  },
};

const BOB = {
  slot: {
    title: "Director of Planning",
    badge: "L6",
    details: [
      {
        label: "Planning",
        accent: { color: "var(--story-accent-prod)", label: "Planning" },
      },
      { label: "New York, NY" },
    ] as const,
  },
  occupant: {
    primary: "Bob Tan",
    details: [{ label: "bob.tan@example.test" }] as const,
  },
};

const DAN = {
  slot: {
    title: "Market Lead",
    badge: "L7",
    details: [
      {
        label: "Market",
        accent: { color: "var(--story-accent-sales)", label: "Market" },
      },
      { label: "Chicago, IL" },
    ] as const,
  },
  occupant: {
    primary: "Dan Alvarez",
    details: [{ label: "dan.alvarez@example.test" }] as const,
  },
};

const EVE = {
  slot: {
    title: "Director of Business",
    badge: "L6",
    details: [
      {
        label: "Business",
        accent: { color: "var(--story-accent-ops)", label: "Business" },
      },
      { label: "Remote (US)" },
    ] as const,
  },
  occupant: {
    primary: "Eve Nakamura",
    details: [{ label: "eve.nakamura@example.test" }] as const,
  },
};

const MARCUS_DIMMED = {
  slot: {
    title: "Platform Manager, Mobile",
    badge: "L6",
    details: [
      {
        label: "Platform",
        accent: { color: "var(--story-accent-eng)", label: "Platform" },
      },
      { label: "San Francisco, CA" },
    ] as const,
  },
  occupant: {
    primary: "Marcus Hill",
    details: [{ label: "marcus.hill@example.test" }] as const,
  },
};

export const Filled: Story = {
  render: () => <NodeCard slot={ALICE.slot} occupant={ALICE.occupant} />,
};

export const FilledFocused: Story = {
  render: () => <NodeCard slot={JORDAN.slot} occupant={JORDAN.occupant} state="focused" />,
};

export const FilledDimmed: Story = {
  render: () => <NodeCard slot={CAROL.slot} occupant={CAROL.occupant} state="dimmed" />,
};

export const Empty: Story = {
  render: () => <NodeCard slot={FRONTEND_EMPTY.slot} />,
};

export const EmptyFocused: Story = {
  render: () => <NodeCard slot={FRONTEND_EMPTY.slot} state="focused" />,
};

export const EmptyDimmed: Story = {
  render: () => <NodeCard slot={FRONTEND_EMPTY.slot} state="dimmed" />,
};

// Single-detail variant — slot has only the group detail with
// no region, occupant has no details at all. Confirms left-only
// detail rendering doesn't shift the rest of the layout.
export const SingleDetail: Story = {
  render: () => (
    <NodeCard
      slot={{
        title: "Director of Planning",
        badge: "L6",
        details: [
          {
            label: "Planning",
            accent: { color: "var(--story-accent-prod)", label: "Planning" },
          },
        ],
      }}
      occupant={{ primary: "Bob Tan" }}
    />
  ),
};

// No details at all on either half — just primary identity per half.
export const NoDetails: Story = {
  render: () => (
    <NodeCard slot={{ title: "Market Lead", badge: "L7" }} occupant={{ primary: "Dan Alvarez" }} />
  ),
};

export const AccentPalette: Story = {
  render: () => (
    <>
      <NodeCard slot={ALICE.slot} occupant={ALICE.occupant} />
      <NodeCard slot={BOB.slot} occupant={BOB.occupant} />
      <NodeCard slot={CAROL.slot} occupant={CAROL.occupant} />
      <NodeCard slot={DAN.slot} occupant={DAN.occupant} />
      <NodeCard slot={EVE.slot} occupant={EVE.occupant} />
    </>
  ),
};

export const SubtreeMixed: Story = {
  render: () => (
    <>
      <NodeCard slot={ALICE.slot} occupant={ALICE.occupant} />
      <NodeCard slot={JORDAN.slot} occupant={JORDAN.occupant} state="focused" />
      <NodeCard slot={FRONTEND_EMPTY.slot} />
      <NodeCard slot={MARCUS_DIMMED.slot} occupant={MARCUS_DIMMED.occupant} state="dimmed" />
    </>
  ),
};
