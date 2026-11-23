// The assembled canvas over the grid fixture's projects and their owners: a
// layout with a table, a chart and a graph, staged values from two agent
// turns and the user, a rule and an open thread.
import type {
  DataDefinition,
  WorkRule,
  WorkSessionClient,
  WorkSessionRequest,
} from "@autograph/generated-app-runtime/data";

import type { CanvasLayout } from "@autograph/work-session-tools/layout";
import { createMemoryCanvasClient, isEdit, type MemoryCanvas } from "../../memory-client";
import {
  change,
  gridDefinition,
  gridRows,
  money,
  personId,
  projectId,
  sessionId,
  stageAs,
  turns,
} from "./grid";

export { sessionId, turns };
export const canvasTurns = { ...turns, third: "00000000-0000-4000-9000-000000000003" };

/** The grid fixture's models, each naming its records by a display column. */
export const canvasDefinition = {
  ...gridDefinition,
  models: gridDefinition.models.map((model) => ({
    ...model,
    display_field_id: model.id === "m_project" ? "f_name" : "f_person_name",
  })),
} satisfies DataDefinition;

export const unitIds = { grid: "u-projects", chart: "u-status", graph: "u-owners" };

/**
 * A table of projects across the top, a status chart and an owner graph
 * below, placed by hand (a free layout: units move by their headers).
 */
export const typicalLayout: CanvasLayout = {
  mode: "free",
  units: [
    {
      id: unitIds.grid,
      kind: "grid",
      config: { model_id: "m_project" },
      x: 32,
      y: 32,
      w: 1120,
      h: 440,
    },
    {
      id: unitIds.chart,
      kind: "chart",
      config: {
        model_id: "m_project",
        group_by: "f_status",
        metric: { fn: "count" },
        kind: "breakdown",
      },
      x: 32,
      y: 504,
      w: 540,
      h: 360,
    },
    {
      id: unitIds.graph,
      kind: "graph",
      config: { model_id: "m_project", field_id: "f_owner" },
      x: 604,
      y: 504,
      w: 548,
      h: 360,
    },
  ],
};

/**
 * An in-memory canvas whose session starts with `layout` (`{}` holds no
 * units), over `count` projects.
 */
export function canvasMemory(
  layout: CanvasLayout | Record<string, never> = {},
  count = 12,
  drafts?: Parameters<typeof createMemoryCanvasClient>[0]["drafts"],
) {
  return createMemoryCanvasClient({
    definition: canvasDefinition,
    rows: gridRows(count),
    actorId: "user-hana",
    session: { id: sessionId, title: "Q4 planning", as_of: "2026-10-01", layout },
    ...(drafts === undefined ? {} : { drafts }),
  });
}

type Request = Record<string, unknown> & { operation: string };
/** One request: an edit as is (last-write-wins), any other at the session's current revision. */
export async function send(client: WorkSessionClient, request: Request) {
  if (isEdit(request))
    return client.request({ ...request, session_id: sessionId } as WorkSessionRequest);
  const header = await client.request({ operation: "get", session_id: sessionId, overlay: false });
  return client.request({
    ...request,
    session_id: sessionId,
    expected_revision: header.revision,
    request_id: crypto.randomUUID(),
  } as WorkSessionRequest);
}

export const holdLongProjects: WorkRule = {
  description: "Put long projects on hold",
  model_id: "m_project",
  field_id: "f_status",
  condition: {
    type: "compare",
    op: "gt",
    left: { type: "field", field: "f_estimate" },
    right: { type: "parameter", parameter: "estimate_limit" },
  },
  value: { type: "literal", value: { type: "enum", value: "on_hold" } },
  parameters: { estimate_limit: { type: "number", value: "55" } },
};

export const threadIds = {
  cell: "d0000000-0000-4000-8000-000000000001",
  chart: "d0000000-0000-4000-8000-000000000002",
};

/** Your edits and two agent turns, the agent's rule, and a thread on a staged budget. */
export async function seedTypical(memory: MemoryCanvas) {
  await stageAs(memory.client.session, [
    change(1, "f_status", { type: "enum", value: "active" }),
    change(3, "f_estimate", { type: "number", value: "45" }),
  ]);
  await stageAs(memory.asAgent(turns.first), [
    change(2, "f_budget", money("95000")),
    change(5, "f_budget", money("82500")),
    change(5, "f_owner", { type: "relation", value: { type: "record_id", value: personId(3) } }),
  ]);
  await stageAs(memory.asAgent(turns.second), [
    change(4, "f_status", { type: "enum", value: "done" }),
  ]);
  await send(memory.asAgent(turns.second), {
    operation: "rule_create",
    rule_id: "r-hold",
    rule: holdLongProjects,
  });
  await send(memory.client.session, {
    operation: "thread_open",
    thread_id: threadIds.cell,
    anchor: {
      unit_id: unitIds.grid,
      model_id: "m_project",
      record_id: projectId(2),
      field_id: "f_budget",
    },
  });
  await send(memory.client.session, {
    operation: "thread_reply",
    thread_id: threadIds.cell,
    message: "Why did this budget drop? The client signed the larger scope last week.",
  });
  await send(memory.asAgent(turns.second), {
    operation: "thread_reply",
    thread_id: threadIds.cell,
    message:
      "I lowered it to 95,000 USD to match the revised plan. If the larger scope is signed, revert my change and I'll stage 145,000 USD again.",
  });
  await send(memory.client.session, {
    operation: "thread_open",
    thread_id: threadIds.chart,
    anchor: { unit_id: unitIds.chart },
  });
  await send(memory.client.session, {
    operation: "thread_reply",
    thread_id: threadIds.chart,
    message: "Should On hold projects still count toward this quarter's capacity?",
  });
  return memory;
}

/** The agent stages a third turn: two budgets and a status. */
export async function agentStagesTurn(memory: MemoryCanvas) {
  await stageAs(memory.asAgent(canvasTurns.third), [
    change(7, "f_budget", money("120000")),
    change(9, "f_budget", money("150000")),
    change(10, "f_status", { type: "enum", value: "active" }),
  ]);
}
