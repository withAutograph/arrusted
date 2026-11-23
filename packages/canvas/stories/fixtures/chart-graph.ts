// A small app-agnostic team for the chart and graph units: people with a
// role, a team, a base pay in US dollars or euros, and a manager.
import type { DataDefinition } from "@autograph/generated-app-runtime/data";

import { createMemoryCanvasClient, type MemoryRow } from "../../memory-client";

export const chartGraphDefinition = {
  formatVersion: 1,
  schemaVersion: "canvas-chart-graph-1",
  models: [
    {
      id: "m_person",
      name: "person",
      label: "Person",
      display_field_id: "f_name",
      relations: [],
      fields: [
        {
          id: "f_name",
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
        {
          id: "f_team",
          name: "team",
          label: "Team",
          type: "enum",
          required: false,
          readOnly: false,
          option_set: [
            { id: "eng", label: "Engineering" },
            { id: "design", label: "Design" },
            { id: "ops", label: "Operations" },
            { id: "sales", label: "Sales" },
          ],
        },
        {
          id: "f_tenure",
          name: "tenure",
          label: "Tenure (years)",
          type: "number",
          required: false,
          readOnly: false,
        },
        {
          id: "f_pay",
          name: "pay",
          label: "Base pay",
          type: "money_rate",
          required: false,
          readOnly: false,
        },
        {
          id: "f_manager",
          name: "manager",
          label: "Manager",
          type: "relation",
          target_model: "m_person",
          required: false,
          readOnly: false,
        },
      ],
    },
  ],
} as const satisfies DataDefinition;

const uuid = (prefix: string, n: number) =>
  `00000000-0000-4000-${prefix}-${n.toString().padStart(12, "0")}`;
export const chartGraphSession = uuid("8000", 7000);
export const personId = (n: number) => uuid("c000", n);

type Person = [
  name: string,
  role: string,
  team: string,
  tenure: number,
  pay: string,
  currency: "USD" | "EUR",
  manager: number | null,
];
/** Person n is `people[n - 1]`; the manager is a person number. */
const people: readonly Person[] = [
  ["Maya Okafor", "Head of Engineering", "eng", 9, "245000", "USD", null],
  ["Daniel Reyes", "Engineering manager", "eng", 6, "198000", "USD", 1],
  ["Priya Natarajan", "Design lead", "design", 5, "176000", "USD", 1],
  ["Tomás Lindqvist", "Engineering manager", "eng", 4, "142000", "EUR", 1],
  ["Hannah Weiss", "Senior engineer", "eng", 3, "168000", "USD", 2],
  ["Kwame Mensah", "Engineer", "eng", 2, "139000", "USD", 2],
  ["Sofia Marchetti", "Product designer", "design", 2, "131000", "USD", 3],
  ["Lukas Brandt", "Engineer", "eng", 1, "88000", "EUR", 4],
  ["Elif Kaya", "Senior engineer", "eng", 5, "104000", "EUR", 4],
  ["Grace Liu", "Operations manager", "ops", 7, "152000", "USD", 1],
  ["Marco Rossi", "Support specialist", "ops", 1, "61000", "EUR", 10],
  ["Aisha Bello", "Account executive", "sales", 3, "118000", "USD", 1],
  ["Noah Fischer", "Account executive", "sales", 2, "79000", "EUR", 12],
  ["Chloé Martin", "UX researcher", "design", 1, "72000", "EUR", 3],
];

const text = (value: string) => ({ type: "text" as const, value });
/** The team; `externalKeys` gives everyone an external key that managers are named by. */
const rowsOf = (externalKeys: boolean): MemoryRow[] =>
  people.map(([name, role, team, tenure, pay, currency, manager], index) => ({
    id: personId(index + 1),
    ...(externalKeys ? { externalKey: `P-${index + 1}` } : {}),
    values: {
      f_name: text(name),
      f_role: text(role),
      f_team: { type: "enum", value: team },
      f_tenure: { type: "number", value: String(tenure) },
      f_pay: { type: "money_rate", value: { amount: pay, currency, period: "annual" } },
      f_manager:
        manager === null
          ? null
          : {
              type: "relation",
              value: externalKeys
                ? { type: "external_key", value: `P-${manager}` }
                : { type: "record_id", value: personId(manager) },
            },
    },
  }));

/** The in-memory canvas over the team; `empty` has no people. */
export function chartGraphMemory(options: { empty?: boolean; externalKeys?: boolean } = {}) {
  return createMemoryCanvasClient({
    definition: chartGraphDefinition,
    rows: { m_person: options.empty ? [] : rowsOf(options.externalKeys ?? false) },
    session: { id: chartGraphSession, title: "Team review", as_of: "2026-10-01" },
  });
}

export const specs = {
  countByTeam: {
    model_id: "m_person",
    group_by: "f_team",
    metric: { fn: "count" },
    kind: "breakdown",
  },
  payByTeam: {
    model_id: "m_person",
    group_by: "f_team",
    metric: { fn: "sum", field_id: "f_pay" },
    kind: "breakdown",
  },
  countByTeamDonut: {
    model_id: "m_person",
    group_by: "f_team",
    metric: { fn: "count" },
    kind: "donut",
  },
  managers: { model_id: "m_person", field_id: "f_manager" },
} as const;
