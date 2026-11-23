// A small app-agnostic fixture for the review stories (staged-change log,
// provenance, Save bar, impact strip): projects with budgets in two
// currencies, and the people who lead them.
import type { DataDefinition, WorkChange, WorkTarget } from "@autograph/generated-app-runtime/data";

import { createMemoryCanvasClient, type MemoryCanvas, type MemoryRow } from "../../memory-client";

type FieldValue = NonNullable<WorkChange["value"]>;

export const definition = {
  formatVersion: 1,
  schemaVersion: "stories-review",
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
          id: "f_status",
          name: "status",
          label: "Status",
          type: "enum",
          required: false,
          readOnly: false,
          option_set: [
            { id: "planned", label: "Planned" },
            { id: "on_track", label: "On track" },
            { id: "at_risk", label: "At risk" },
            { id: "paused", label: "Paused" },
          ],
        },
        {
          id: "f_headcount",
          name: "headcount",
          label: "Headcount",
          type: "number",
          required: false,
          readOnly: false,
        },
        {
          id: "f_budget",
          name: "budget",
          label: "Annual budget",
          type: "money_rate",
          required: false,
          readOnly: false,
        },
        {
          id: "f_lead",
          name: "lead",
          label: "Lead",
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

export const sessionId = "00000000-0000-4000-8000-0000000000aa";
export const turns = {
  first: "00000000-0000-4000-8000-0000000000b1",
  second: "00000000-0000-4000-8000-0000000000b2",
};

const text = (value: string) => ({ type: "text" as const, value });
const num = (value: string) => ({ type: "number" as const, value });
const status = (value: string) => ({ type: "enum" as const, value });
export const budget = (amount: string, currency = "USD") => ({
  type: "money_rate" as const,
  value: { amount, currency, period: "annual" as const },
});
const person = (id: string) => ({
  type: "relation" as const,
  value: { type: "record_id" as const, value: id },
});

const projectId = (n: number) => `00000000-0000-4000-8000-${String(100 + n).padStart(12, "0")}`;
const personId = (n: number) => `00000000-0000-4000-8000-${String(900 + n).padStart(12, "0")}`;

const people = ["Maya Okafor", "Jonas Lindqvist", "Priya Raman", "Tomás Herrera", "Aiko Tanaka"];
const projects: [string, string, string, string, string][] = [
  // name, status, headcount, budget, currency
  ["Atlas migration", "on_track", "6", "420000", "USD"],
  ["Billing revamp", "at_risk", "4", "310000", "USD"],
  ["Customer portal", "on_track", "5", "275000", "USD"],
  ["Data warehouse", "planned", "3", "380000", "EUR"],
  ["Field app", "paused", "2", "150000", "EUR"],
  ["Identity service", "on_track", "4", "260000", "USD"],
  ["Localization", "planned", "2", "90000", "EUR"],
  ["Mobile checkout", "at_risk", "5", "330000", "USD"],
  ["Partner API", "on_track", "3", "210000", "USD"],
  ["Search relevance", "on_track", "4", "240000", "EUR"],
  ["Support tooling", "planned", "2", "120000", "USD"],
  ["Warehouse robotics", "at_risk", "6", "510000", "EUR"],
];

export const ids = {
  project: (name: string) => projectId(projects.findIndex(([n]) => n === name)),
  person: (name: string) => personId(people.indexOf(name)),
};

const rows: Record<string, MemoryRow[]> = {
  m_person: people.map((name, n) => ({
    id: personId(n),
    externalKey: `EMP-${n + 1}`,
    values: {
      f_person_name: text(name),
      f_role: text(n % 2 === 0 ? "Engineering lead" : "Product lead"),
    },
  })),
  m_project: projects.map(([name, state, headcount, amount, currency], n) => ({
    id: projectId(n),
    values: {
      f_name: text(name),
      f_status: status(state),
      f_headcount: num(headcount),
      f_budget: budget(amount, currency),
      f_lead: person(personId(n % people.length)),
    },
  })),
};

/** Every project's name and published budget, for stories that stage across all of them. */
export const projectBudgets = projects.map(([name, , , amount, currency]) => ({
  name,
  amount,
  currency,
}));

/** A fresh in-memory canvas over the fixture, with the review session at revision 1. */
export const reviewMemory = () =>
  createMemoryCanvasClient({
    definition,
    rows,
    session: { id: sessionId, title: "Q3 planning", as_of: "2026-10-01" },
  });

type Change = WorkTarget & { value: FieldValue | null };
/** A change to one project column. */
export const project = (name: string, field: string, value: FieldValue | null): Change => ({
  model_id: "m_project",
  record_id: ids.project(name),
  field_id: field,
  value,
});
export const values = { text, num, status, budget, person };

/** Stages as the user, or as the agent in `turn`, at the session's current revision. */
export async function stage(memory: MemoryCanvas, changes: readonly Change[], turn?: string) {
  const { revision } = await memory.client.session.request({
    operation: "get",
    session_id: sessionId,
    overlay: false,
  });
  const client = turn === undefined ? memory.client.session : memory.asAgent(turn);
  await client.request({
    operation: "stage",
    session_id: sessionId,
    changes,
  });
}

/** Opens a thread, lets the agent propose `changes` in it, and pulls them as the user. */
export async function pullProposal(
  memory: MemoryCanvas,
  message: string,
  changes: readonly Change[],
) {
  const threadId = crypto.randomUUID();
  const at = async () =>
    (
      await memory.client.session.request({
        operation: "get",
        session_id: sessionId,
        overlay: false,
      })
    ).revision;
  const guard = async () => ({
    session_id: sessionId,
    expected_revision: await at(),
    request_id: crypto.randomUUID(),
  });
  await memory.client.session.request({
    operation: "thread_open",
    ...(await guard()),
    thread_id: threadId,
    anchor: { model_id: changes[0]!.model_id, record_id: changes[0]!.record_id },
  });
  await memory.client.session.request({
    operation: "thread_reply",
    ...(await guard()),
    thread_id: threadId,
    message,
  });
  await memory.asAgent(turns.second).request({
    operation: "propose",
    ...(await guard()),
    thread_id: threadId,
    changes,
  });
  await memory.client.session.request({
    operation: "pull",
    ...(await guard()),
    thread_id: threadId,
  });
}

/** The two agent turns and the user's own edits most stories start from. */
export async function twoTurnsAndEdits(memory: MemoryCanvas) {
  await stage(
    memory,
    [
      project("Billing revamp", "f_budget", budget("345000")),
      project("Mobile checkout", "f_budget", budget("362000")),
      project("Warehouse robotics", "f_budget", budget("540000", "EUR")),
    ],
    turns.first,
  );
  await stage(
    memory,
    [
      project("Billing revamp", "f_status", status("on_track")),
      project("Field app", "f_lead", person(ids.person("Priya Raman"))),
      project("Data warehouse", "f_headcount", num("4")),
    ],
    turns.second,
  );
  await stage(memory, [
    project("Atlas migration", "f_budget", budget("440000")),
    project("Support tooling", "f_status", status("on_track")),
  ]);
}
