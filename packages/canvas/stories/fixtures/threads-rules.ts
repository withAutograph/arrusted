// A small app-agnostic fixture for the threads, rules and frame stories:
// people on teams with a day rate, and the projects they lead.
import { useEffect, useRef, useState } from "react";
import type {
  DataDefinition,
  WorkRule,
  WorkSessionRequest,
} from "@autograph/generated-app-runtime/data";

import type { CanvasClient } from "../../client";
// Stories are outside the package tsconfig, so they take design-system parts through here.
export { Select } from "@autograph/components";
import { createMemoryCanvasClient, isEdit, type MemoryRow } from "../../memory-client";

export const definition = {
  formatVersion: 1,
  schemaVersion: "stories-threads-rules",
  models: [
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
          id: "f_team",
          name: "team",
          label: "Team",
          type: "enum",
          required: false,
          readOnly: false,
          option_set: [
            { id: "design", label: "Design" },
            { id: "engineering", label: "Engineering" },
            { id: "research", label: "Research" },
          ],
        },
        {
          id: "f_day_rate",
          name: "day_rate",
          label: "Day rate",
          type: "money_rate",
          required: false,
          readOnly: false,
        },
        {
          id: "f_utilisation",
          name: "utilisation",
          label: "Utilisation %",
          type: "number",
          required: false,
          readOnly: false,
        },
      ],
    },
    {
      id: "m_project",
      name: "project",
      label: "Project",
      relations: [],
      fields: [
        {
          id: "f_project_name",
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
            { id: "on_track", label: "On track" },
            { id: "at_risk", label: "At risk" },
            { id: "paused", label: "Paused" },
          ],
        },
        {
          id: "f_budget",
          name: "budget",
          label: "Budget",
          type: "number",
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
  ],
} as const satisfies DataDefinition;

const text = (value: string) => ({ type: "text" as const, value });
const num = (value: string) => ({ type: "number" as const, value });
const enumOf = (value: string) => ({ type: "enum" as const, value });
export const dayRate = (amount: string, currency = "GBP") => ({
  type: "money_rate" as const,
  value: { amount, currency, period: "daily" as const },
});
const lead = (id: string) => ({
  type: "relation" as const,
  value: { type: "record_id" as const, value: id },
});

export const ids = {
  session: "5e550000-0000-4000-8000-000000000001",
  amara: "a0000000-0000-4000-8000-000000000001",
  ben: "a0000000-0000-4000-8000-000000000002",
  chen: "a0000000-0000-4000-8000-000000000003",
  dara: "a0000000-0000-4000-8000-000000000004",
  atlas: "b0000000-0000-4000-8000-000000000001",
  beacon: "b0000000-0000-4000-8000-000000000002",
  cobalt: "b0000000-0000-4000-8000-000000000003",
  turn: "c0000000-0000-4000-8000-000000000001",
  turn2: "c0000000-0000-4000-8000-000000000002",
};

const people: MemoryRow[] = [
  {
    id: ids.amara,
    values: {
      f_person_name: text("Amara Okafor"),
      f_team: enumOf("engineering"),
      f_day_rate: dayRate("720"),
      f_utilisation: num("82"),
    },
  },
  {
    id: ids.ben,
    values: {
      f_person_name: text("Ben Lindqvist"),
      f_team: enumOf("design"),
      f_day_rate: dayRate("610"),
      f_utilisation: num("64"),
    },
  },
  {
    id: ids.chen,
    values: {
      f_person_name: text("Chen Wei"),
      f_team: enumOf("engineering"),
      f_day_rate: dayRate("845"),
      f_utilisation: num("91"),
    },
  },
  {
    id: ids.dara,
    values: {
      f_person_name: text("Dara Murphy"),
      f_team: enumOf("research"),
      f_day_rate: dayRate("690"),
      f_utilisation: num("58"),
    },
  },
];
const projects: MemoryRow[] = [
  {
    id: ids.atlas,
    values: {
      f_project_name: text("Atlas onboarding"),
      f_status: enumOf("on_track"),
      f_budget: num("180000"),
      f_lead: lead(ids.amara),
    },
  },
  {
    id: ids.beacon,
    values: {
      f_project_name: text("Beacon redesign"),
      f_status: enumOf("at_risk"),
      f_budget: num("320000"),
      f_lead: lead(ids.ben),
    },
  },
  {
    id: ids.cobalt,
    values: {
      f_project_name: text("Cobalt migration"),
      f_status: enumOf("on_track"),
      f_budget: num("410000"),
      f_lead: lead(ids.chen),
    },
  },
];

const names = new Map<string, string>(
  [
    ...people.map((row) => [row.id, row.values.f_person_name]),
    ...projects.map((row) => [row.id, row.values.f_project_name]),
  ].map(([id, value]) => [id as string, (value as { value: string }).value]),
);
/** A record's name, as a host with the rows loaded knows it. */
export const recordName = (_modelId: string, recordId: string) => names.get(recordId);

/** A fresh in-memory canvas over the fixture, with one session. */
export function memoryCanvas() {
  return createMemoryCanvasClient({
    definition,
    rows: { m_person: people, m_project: projects },
    actorId: "user-hana",
    session: { id: ids.session, title: "Q4 staffing review", as_of: "2026-10-01" },
  });
}
export type StoryCanvas = ReturnType<typeof memoryCanvas>;

type Request = Record<string, unknown> & { operation: string };
/** One mutation at the session's current revision, as the user or as the agent in `turn`. */
export async function act(canvas: StoryCanvas, request: Request, turn?: string) {
  if (isEdit(request))
    return (await (turn === undefined ? canvas.client.session : canvas.asAgent(turn)).request({
      ...request,
      session_id: ids.session,
    } as WorkSessionRequest)) as Record<string, unknown>;
  const { revision } = await canvas.client.session.request({
    operation: "get",
    session_id: ids.session,
    overlay: false,
  });
  const session = turn === undefined ? canvas.client.session : canvas.asAgent(turn);
  return (await session.request({
    ...request,
    session_id: ids.session,
    expected_revision: revision,
    request_id: crypto.randomUUID(),
  } as WorkSessionRequest)) as Record<string, unknown>;
}

/** Rules for the rule stories, by field id. */
export const rules = {
  /** By the user: flags big projects. */
  atRisk: {
    description: "Flag large projects",
    model_id: "m_project",
    field_id: "f_status",
    condition: {
      type: "compare",
      op: "gt",
      left: { type: "field", field: "f_budget" },
      right: { type: "parameter", parameter: "budget_threshold" },
    },
    value: { type: "literal", value: { type: "enum", value: "at_risk" } },
    parameters: { budget_threshold: num("300000") },
  },
  /** By the agent: a day-rate floor for engineers, with a money parameter. */
  rateFloor: {
    model_id: "m_person",
    field_id: "f_day_rate",
    condition: {
      type: "compare",
      op: "eq",
      left: { type: "field", field: "f_team" },
      right: { type: "literal", value: { type: "enum", value: "engineering" } },
    },
    value: {
      type: "max",
      left: { type: "field", field: "f_day_rate" },
      right: { type: "parameter", parameter: "rate_floor" },
    },
    parameters: { rate_floor: dayRate("800") },
  },
} satisfies Record<string, WorkRule>;

/** Wraps a client so one operation is refused with a kernel error. */
export function refusing(
  client: CanvasClient,
  operation: string,
  code: string,
  message: string,
): CanvasClient {
  return {
    ...client,
    session: {
      request: (input) =>
        input.operation === operation
          ? Promise.reject(
              Object.assign(new Error(message), { envelope: { code, message, details: [] } }),
            )
          : client.session.request(input),
    },
  };
}

/**
 * A canvas seeded once by `setup` (which may stage, open threads, reply as
 * the agent…); `ready` turns true when the seed is in place.
 */
export function useSeededCanvas<T>(setup: (canvas: StoryCanvas) => Promise<T>) {
  const [canvas] = useState(memoryCanvas);
  const [seed, setSeed] = useState<{ value: T } | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void setup(canvas).then(
      (value) => setSeed({ value }),
      (error: unknown) => console.error("story seed failed", error),
    );
  }, [canvas, setup]);
  return { canvas, seed: seed?.value, ready: seed !== null };
}
