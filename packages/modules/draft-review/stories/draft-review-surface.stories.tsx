// DraftReviewSurface storybook fixtures.
//
// The surface mounts the full `useDraftReview` controller against a mocked
// `KernelClient`. Stories cover:
//   - Empty drafts (cold load with no pending changes)
//   - Drafts populated (named-bulk + type-grouped cards)
//   - Published tab with cards
//   - Action toasts firing (Discard / Publish wired to a no-op kernel ack)
//
// The mock schema and fixtures use generic field/model names that pass the
// boundary scanner's word-allowlist (no HC-domain words like `department`,
// `compensation`, etc. — see the workspace import and package graph checks).

import { useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { ToastProvider } from "../../../design-systems/core/components";
import type {
  ChangeSetDiff,
  DraftSummary,
  KernelClient,
  RecentActivityEntry,
  Schema,
} from "../../../contracts";

import {
  DraftReviewSurface,
  useDraftReview,
  avatarInitials,
  type CardRow,
  type RelationLabelLookup,
} from "../index";

// ---------------------------------------------------------------------------
// Mock schema — `widget` model with `name`, `level`, `notes`, `status`
// (a bool). All field/model names are in the scanner's APP_SCHEMA_WORD_ALLOWLIST
// or generic enough to never appear in any app schema.
// ---------------------------------------------------------------------------
const SCHEMA: Schema = {
  app_id: "demo",
  customer_id: "demo",
  version: "1",
  models: [
    {
      id: "widget",
      kind: "entity",
      label: "Widget",
      fields: [
        { id: "name", label: "Name", type: "text", required: true },
        { id: "level", label: "Level", type: "text", required: false },
        { id: "notes", label: "Notes", type: "text", required: false },
        { id: "status", label: "Status", type: "bool", required: false },
      ],
    },
  ],
  change_types: [
    {
      id: "widget_update",
      label: "Widget update",
      target_model: "widget",
      touches: [],
      required: [],
    },
    {
      id: "rename",
      label: "Rename",
      target_model: "widget",
      touches: ["name", "level"],
      required: [],
    },
    {
      id: "close",
      label: "Close widgets",
      target_model: "widget",
      touches: ["status"],
      required: [],
    },
  ],
};

// Widget records keyed by id, used to render the primary cell.
const WIDGETS = new Map<string, { name: string; level: string }>([
  ["wid-alpha", { name: "Alpha widget", level: "L3" }],
  ["wid-bravo", { name: "Bravo widget", level: "L3" }],
  ["wid-charlie", { name: "Charlie widget", level: "L4" }],
]);

// Canned drafts — one named bulk (close, 2 widgets) + one type-group
// (rename, 1 widget) so the surface renders both card kinds.
const POPULATED_DRAFTS: DraftSummary[] = [
  {
    id: 100,
    schema_revision_id: 1,
    actor_id: "u-1",
    source_kind: "ui",
    source_ref: null,
    change_type_id: "close",
    notes: "Close two Q1 widgets",
    created_at: "2026-05-15T00:00:00Z",
  },
  {
    id: 101,
    schema_revision_id: 1,
    actor_id: "u-1",
    source_kind: "ui",
    source_ref: null,
    change_type_id: "rename",
    notes: null,
    created_at: "2026-05-15T00:00:00Z",
  },
];

// Per-id diff payload returned by the mock `/api/diff` endpoint.
const DRAFT_DIFFS = new Map<number, ChangeSetDiff>([
  [
    100,
    {
      change_set_id: 100,
      source_change_set_id: 0,
      records: [
        {
          model_id: "widget",
          record_id: "wid-alpha",
          external_key: null,
          version_id: "v-1",
          change_set_id: 100,
          stage: "draft",
          effective_start: "2026-06-01",
          effective_end: null,
          before_tombstones_record: false,
          after_tombstones_record: false,
          before_untombstones_record: false,
          after_untombstones_record: false,
          fields: [
            {
              field_id: "status",
              before: { type: "bool", value: true },
              after: { type: "bool", value: false },
            },
          ],
          custom_fields: [],
        },
        {
          model_id: "widget",
          record_id: "wid-bravo",
          external_key: null,
          version_id: "v-2",
          change_set_id: 100,
          stage: "draft",
          effective_start: "2026-06-01",
          effective_end: null,
          before_tombstones_record: false,
          after_tombstones_record: false,
          before_untombstones_record: false,
          after_untombstones_record: false,
          fields: [
            {
              field_id: "status",
              before: { type: "bool", value: true },
              after: { type: "bool", value: false },
            },
          ],
          custom_fields: [],
        },
      ],
    },
  ],
  [
    101,
    {
      change_set_id: 101,
      source_change_set_id: 0,
      records: [
        {
          model_id: "widget",
          record_id: "wid-charlie",
          external_key: null,
          version_id: "v-3",
          change_set_id: 101,
          stage: "draft",
          effective_start: "2026-05-20",
          effective_end: null,
          before_tombstones_record: false,
          after_tombstones_record: false,
          before_untombstones_record: false,
          after_untombstones_record: false,
          fields: [
            {
              field_id: "name",
              before: { type: "text", value: "Charlie widget" },
              after: { type: "text", value: "Charlie widget (renamed)" },
            },
            {
              field_id: "level",
              before: { type: "text", value: "L3" },
              after: { type: "text", value: "L4" },
            },
          ],
          custom_fields: [],
        },
      ],
    },
  ],
]);

const PUBLISHED_ENTRIES: RecentActivityEntry[] = [
  {
    change_set_id: 100,
    status: "mainline",
    actor_id: "u-1",
    source_kind: "ui",
    source_ref: null,
    change_type_id: "close",
    notes: "Close two Q1 widgets",
    created_at: "2026-05-10T00:00:00Z",
    applied_at: "2026-05-10T00:01:00Z",
    touched_record_count: 2,
  },
];

// Build a `KernelClient` over the in-memory fixtures. The surface drives
// /api/drafts + /api/diff + /api/activity + the three action endpoints;
// the mock answers each in turn.
function makeMockClient(opts: {
  drafts: DraftSummary[];
  published: RecentActivityEntry[];
}): KernelClient {
  return {
    async getJson<T>(path: string): Promise<T> {
      if (path === "/api/drafts") return opts.drafts as T;
      if (path === "/api/schema") return SCHEMA as T;
      throw new Error(`Mock client received unexpected GET ${path}`);
    },
    async postJson<T>(path: string, body: unknown): Promise<T> {
      if (path === "/api/diff") {
        const { change_set_id } = body as { change_set_id: number };
        const diff = DRAFT_DIFFS.get(change_set_id);
        if (!diff) {
          // Synthesize a no-op diff so unknown ids don't blow up the
          // surface — useful when stories add fixture rows without
          // updating the diff map.
          return {
            change_set_id,
            source_change_set_id: 0,
            records: [],
          } as T;
        }
        return diff as T;
      }
      if (path === "/api/activity") return opts.published as T;
      if (
        path === "/api/draft/discard" ||
        path === "/api/draft/approve" ||
        path === "/api/revert"
      ) {
        return { ok: true } as T;
      }
      throw new Error(`Mock client received unexpected POST ${path}`);
    },
  };
}

// Generic primary cell: avatar + name + level subline. Mirrors the shape
// HC uses for positions, with the boundary-allowlisted "name" + "level"
// fields.
function WidgetCell(props: { row: CardRow }): ReactNode {
  const w = WIDGETS.get(props.row.record_id);
  const name = w?.name ?? props.row.record_id;
  const level = w?.level ?? "";
  const avatarStyle: React.CSSProperties = {
    width: 28,
    height: 28,
    borderRadius: "var(--radius-pill)",
    background: "var(--color-bg-subtle)",
    border: "1px solid var(--color-border-subtle)",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "var(--text-micro)",
    color: "var(--color-text-muted)",
    fontWeight: "var(--font-weight-medium)" as React.CSSProperties["fontWeight"],
    flexShrink: 0,
  };
  return (
    <div className="flex items-center gap-[var(--space-2)]">
      <div style={avatarStyle}>{avatarInitials(name)}</div>
      <div>
        <div
          style={{
            fontWeight: "var(--font-weight-medium)" as React.CSSProperties["fontWeight"],
            lineHeight: 1.2,
          }}
        >
          {name}
        </div>
        {level ? (
          <div
            style={{
              fontSize: "var(--text-caption)",
              color: "var(--color-text-muted)",
              marginTop: 2,
            }}
          >
            {level}
          </div>
        ) : null}
      </div>
    </div>
  );
}

const NULL_RELATION_LOOKUP: RelationLabelLookup = () => null;

// Story harness — wires the controller against a mock client and renders
// the surface inside a flex-column container that mimics the AppShell's
// content slot, with a ToastProvider above so action toasts can fire.
function Harness(props: {
  drafts: DraftSummary[];
  published: RecentActivityEntry[];
  initialTab?: "drafts" | "published";
}): ReactNode {
  const [client] = useState(() =>
    makeMockClient({ drafts: props.drafts, published: props.published }),
  );
  const [schema] = useState<Schema>(SCHEMA);
  const controller = useDraftReview({
    client,
    scope: { appId: "demo", customerId: "demo" },
    schema,
    primaryModel: "widget",
    defaultChangeTypeId: "widget_update",
    publishedSourceKinds: ["ui", "revert"],
  });
  // Apply the requested initial tab once the controller exists.
  if (props.initialTab && controller.tab !== props.initialTab) {
    controller.setTab(props.initialTab);
  }
  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "var(--color-bg-page)",
        color: "var(--color-text-primary)",
      }}
    >
      <DraftReviewSurface
        controller={controller}
        renderPrimaryCell={(row) => <WidgetCell row={row} />}
        primaryColumnHeader="Widget"
        relationLabel={NULL_RELATION_LOOKUP}
        emptyStateDrafts={{
          title: "No pending changes",
          body: "Stage edits in the editing surface to see them here for review.",
        }}
        emptyStatePublished={{
          title: "No published changes",
          body: "Approve a draft to see it appear in the published history.",
        }}
      />
    </div>
  );
}

const meta = {
  title: "Modules/DraftReview",
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <ToastProvider>
        <Story />
      </ToastProvider>
    ),
  ],
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

// Empty drafts — fresh surface with no pending changes. Renders the
// `emptyStateDrafts` card.
export const Empty: Story = {
  render: () => <Harness drafts={[]} published={[]} />,
};

// Populated — one named-bulk card (Close widgets, 2 records) + one
// type-group card (Renames, 1 record). Hit `Discard` or `Publish` to fire
// a success toast (mock client acks with { ok: true }).
export const WithDrafts: Story = {
  render: () => <Harness drafts={POPULATED_DRAFTS} published={[]} />,
};

// Published tab — one card showing a previously-applied bulk. Per-row
// Revert lives on the row strip when present; this fixture's card is a
// named bulk so Revert lives on the header.
export const PublishedTab: Story = {
  render: () => <Harness drafts={[]} published={PUBLISHED_ENTRIES} initialTab="published" />,
};
