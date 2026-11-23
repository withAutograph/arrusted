// A small app-agnostic data set for the grid unit and record panel: projects
// with an owner (a person), a status, an estimate and a budget.
import type { DataDefinition, WorkChange } from "@autograph/generated-app-runtime/data";
import type { WorkSessionClient } from "@autograph/generated-app-runtime/data";

import { createMemoryCanvasClient, type MemoryRow } from "../../memory-client";

export const gridDefinition = {
  formatVersion: 1,
  schemaVersion: "canvas-grid-1",
  models: [
    {
      id: "m_project",
      name: "project",
      label: "Project",
      relations: [],
      fields: [
        {
          id: "f_name",
          name: "name",
          label: "Project",
          type: "text",
          required: true,
          readOnly: false,
        },
        {
          id: "f_client",
          name: "client",
          label: "Client",
          type: "text",
          required: false,
          readOnly: false,
        },
        {
          id: "f_status",
          name: "status",
          label: "Status",
          type: "enum",
          required: false,
          readOnly: false,
          option_set: [
            { id: "planned", label: "Planned" },
            { id: "active", label: "Active" },
            { id: "on_hold", label: "On hold" },
            { id: "done", label: "Done" },
          ],
        },
        {
          id: "f_estimate",
          name: "estimate",
          label: "Estimate (days)",
          type: "number",
          required: false,
          readOnly: false,
        },
        {
          id: "f_budget",
          name: "budget",
          label: "Budget",
          type: "money_rate",
          required: false,
          readOnly: false,
        },
        {
          id: "f_owner",
          name: "owner",
          label: "Owner",
          type: "relation",
          target_model: "m_person",
          required: false,
          readOnly: false,
        },
      ],
    },
    {
      id: "m_person",
      name: "person",
      label: "Person",
      relations: [],
      fields: [
        {
          id: "f_person_name",
          name: "name",
          label: "Name",
          type: "text",
          required: true,
          readOnly: false,
        },
        {
          id: "f_role",
          name: "role",
          label: "Role",
          type: "text",
          required: false,
          readOnly: false,
        },
      ],
    },
  ],
} as const satisfies DataDefinition;

const uuid = (prefix: string, n: number) =>
  `00000000-0000-4000-${prefix}-${n.toString().padStart(12, "0")}`;
export const sessionId = uuid("8000", 9000);
export const turns = { first: uuid("9000", 1), second: uuid("9000", 2) };
export const personId = (n: number) => uuid("a000", n);
export const projectId = (n: number) => uuid("b000", n);

const people = [
  ["Maya Okafor", "Engineering lead"],
  ["Daniel Reyes", "Product manager"],
  ["Priya Natarajan", "Designer"],
  ["Tomás Lindqvist", "Delivery manager"],
  ["Hannah Weiss", "Engineer"],
  ["Kwame Mensah", "Data analyst"],
] as const;
const clients = [
  "Northwind",
  "Contoso",
  "Fabrikam",
  "Globex",
  "Initech",
  "Umbrella Health",
  "Tailspin",
];
const projects = [
  "Billing migration",
  "Customer portal",
  "Data warehouse refresh",
  "Mobile onboarding",
  "Pricing page redesign",
  "Search relevance",
  "Support chatbot",
  "Warehouse scanners",
  "Partner API",
  "Security review",
  "Analytics dashboard",
  "Checkout speedup",
];
const statuses = ["planned", "active", "active", "on_hold", "done"] as const;

const text = (value: string) => ({ type: "text" as const, value });
export const money = (
  amount: string,
  currency = "USD",
  period: "annual" | "monthly" = "annual",
) => ({
  type: "money_rate" as const,
  value: { amount, currency, period },
});
const link = (id: string) => ({
  type: "relation" as const,
  value: { type: "record_id" as const, value: id },
});

function projectRows(count: number): MemoryRow[] {
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    const base = projects[index % projects.length]!;
    const round = Math.floor(index / projects.length);
    return {
      id: projectId(n),
      values: {
        f_name: text(round === 0 ? base : `${base} ${round + 1}`),
        f_client: text(clients[(index * 3) % clients.length]!),
        f_status: { type: "enum", value: statuses[index % statuses.length]! },
        f_estimate: { type: "number", value: String(10 + ((index * 7) % 50)) },
        f_budget:
          index % 6 === 5
            ? money(String(8000 + (index % 5) * 500), "EUR", "monthly")
            : money(String(60000 + ((index * 37) % 20) * 5000)),
        f_owner: link(personId((index % people.length) + 1)),
      },
    };
  });
}

/** The fixture's rows: `count` projects and their owners. */
export function gridRows(count = 12): Record<string, MemoryRow[]> {
  return {
    m_project: projectRows(count),
    m_person: people.map(([name, role], index) => ({
      id: personId(index + 1),
      externalKey: `P-${index + 1}`,
      values: { f_person_name: text(name), f_role: text(role) },
    })),
  };
}

/** The in-memory canvas over `count` projects, with an empty session. */
export function gridMemory(count = 12) {
  return createMemoryCanvasClient({
    definition: gridDefinition,
    rows: gridRows(count),
    session: { id: sessionId, title: "Q4 planning", as_of: "2026-10-01" },
  });
}

/** Stages changes through one session client at the session's current revision. */
export async function stageAs(
  client: WorkSessionClient,
  changes: readonly Pick<WorkChange, "model_id" | "record_id" | "field_id" | "value">[],
) {
  const header = await client.request({ operation: "get", session_id: sessionId, overlay: false });
  await client.request({
    operation: "stage",
    session_id: sessionId,
    changes,
  });
}

export const change = (
  n: number,
  fieldId: string,
  value: WorkChange["value"],
): Pick<WorkChange, "model_id" | "record_id" | "field_id" | "value"> => ({
  model_id: "m_project",
  record_id: projectId(n),
  field_id: fieldId,
  value,
});

/** A typical review: the user's own edits and two agent turns. */
export async function withStagedValues(memory: ReturnType<typeof gridMemory>) {
  await stageAs(memory.client.session, [
    change(1, "f_status", { type: "enum", value: "active" }),
    change(3, "f_estimate", { type: "number", value: "45" }),
  ]);
  await stageAs(memory.asAgent(turns.first), [
    change(2, "f_budget", money("95000")),
    change(5, "f_budget", money("82500")),
    change(5, "f_owner", link(personId(3))),
  ]);
  await stageAs(memory.asAgent(turns.second), [
    change(4, "f_status", { type: "enum", value: "done" }),
  ]);
  return memory;
}
