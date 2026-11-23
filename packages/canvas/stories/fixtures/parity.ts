// An app-agnostic team with pay bands, for the canvas's newer parts: the
// sessions menu, the as-of date, an agent replacing your edit, a note, key
// figures and a range chart (all money in its currency and period), and the
// warning before saving changes the canvas does not show.
import type {
  DataDefinition,
  DataField,
  WorkSessionClient,
  WorkSessionRequest,
} from "@autograph/generated-app-runtime/data";

import type { CanvasLayout } from "@autograph/work-session-tools/layout";
import {
  createMemoryCanvasClient,
  isEdit,
  type MemoryCanvas,
  type MemoryRow,
} from "../../memory-client";

const uuid = (prefix: string, n: number) =>
  `00000000-0000-4000-${prefix}-${n.toString().padStart(12, "0")}`;
export const paritySession = uuid("8000", 5100);
export const parityTurn = uuid("9000", 5101);
export const memberId = (n: number) => uuid("d000", n);

const field = (
  id: string,
  name: string,
  label: string,
  type: DataField["type"],
  extra: Partial<DataField> = {},
) => ({ id, name, label, type, required: false, readOnly: false, ...extra });

export const parityDefinition = {
  formatVersion: 1,
  schemaVersion: "canvas-parity-1",
  models: [
    {
      id: "m_member",
      name: "member",
      label: "Team member",
      display_field_id: "f_name",
      relations: [],
      fields: [
        field("f_name", "name", "Name", "text", { required: true }),
        field("f_level", "level", "Level", "enum", {
          option_set: [
            { id: "l1", label: "Associate" },
            { id: "l2", label: "Senior" },
            { id: "l3", label: "Lead" },
          ],
        }),
        field("f_start", "start", "Start date", "date"),
        field("f_pay", "pay", "Base pay", "money_rate"),
        field("f_low", "band_low", "Band low", "money_rate", { readOnly: true }),
        field("f_target", "band_target", "Band target", "money_rate", { readOnly: true }),
        field("f_high", "band_high", "Band high", "money_rate", { readOnly: true }),
        field("f_ratio", "compa_ratio", "Compa-ratio", "number", { readOnly: true }),
      ],
    },
  ],
} as const satisfies DataDefinition;

const money = (amount: string, currency = "USD", period: "annual" | "monthly" = "annual") => ({
  type: "money_rate" as const,
  value: { amount, currency, period },
});
const bands = {
  l1: ["70000", "82000", "95000"],
  l2: ["95000", "112000", "130000"],
  l3: ["125000", "145000", "165000"],
} as const;
/** A derived quotient as Postgres numeric division returns it: 28 decimals. */
const quotient = (left: string, right: string) => {
  const digits = ((BigInt(left) * 10n ** 28n) / BigInt(right)).toString().padStart(29, "0");
  return `${digits.slice(0, -28)}.${digits.slice(-28)}`;
};
/** Name, level, start date and base pay (empty for the last hire). */
const people: [string, keyof typeof bands, string, string | null][] = [
  ["Maya Okafor", "l3", "2019-03-04", "151000"],
  ["Tomás Silva", "l3", "2021-06-14", "170000"],
  ["Ines Duarte", "l2", "2020-01-20", "118000"],
  ["Kenji Watanabe", "l2", "2022-09-05", "92000"],
  ["Priya Raman", "l2", "2023-02-13", "126000"],
  ["Lena Fischer", "l1", "2023-08-01", "78000"],
  ["Omar Haddad", "l1", "2024-04-15", "88000"],
  ["Sofia Rossi", "l1", "2025-01-06", "67000"],
  ["Noah Brooks", "l1", "2026-09-01", null],
];

export const parityRows = (): Record<string, MemoryRow[]> => ({
  m_member: people.map(([name, level, start, pay], index) => ({
    id: memberId(index + 1),
    values: {
      f_name: { type: "text", value: name },
      f_level: { type: "enum", value: level },
      f_start: { type: "date", value: start },
      f_pay: pay === null ? null : money(pay),
      f_low: money(bands[level][0]),
      f_target: money(bands[level][1]),
      f_high: money(bands[level][2]),
      // Derived: base pay over band target.
      f_ratio: pay === null ? null : { type: "number", value: quotient(pay, bands[level][1]) },
    },
  })),
});

export const parityUnits = {
  grid: "u-members",
  range: "u-range",
  kpi: "u-kpi",
  note: "u-note",
};
export const rangeChart = {
  kind: "range",
  model_id: "m_member",
  group_by: "f_level",
  value: "f_pay",
  low: "f_low",
  high: "f_high",
  target: "f_target",
};

/** Key figures across the top, the team's table, then the range chart beside a note. */
export const parityLayout: CanvasLayout = {
  units: [
    {
      id: parityUnits.kpi,
      kind: "kpi",
      config: {
        model_id: "m_member",
        metrics: [
          { fn: "count" },
          { fn: "sum", field_id: "f_pay" },
          { fn: "median", field_id: "f_pay" },
        ],
      },
      x: 32,
      y: 32,
      w: 1120,
      h: 168,
    },
    {
      id: parityUnits.grid,
      kind: "grid",
      config: { model_id: "m_member" },
      x: 32,
      y: 232,
      w: 1120,
      h: 420,
    },
    {
      id: parityUnits.range,
      kind: "chart",
      config: rangeChart,
      x: 32,
      y: 684,
      w: 680,
      h: 380,
    },
    {
      id: parityUnits.note,
      kind: "note",
      config: {
        text: "Q4 review: bring everyone below band up to its low by January. Leads above band stay as they are until the March cycle.",
      },
      x: 744,
      y: 684,
      w: 408,
      h: 220,
    },
  ],
};

/** The figures, range chart and note without the table: every staged change is off the canvas. */
export const noTableLayout: CanvasLayout = {
  units: parityLayout.units
    .filter((unit) => unit.id !== parityUnits.grid)
    .map((unit) => (unit.y > 600 ? { ...unit, y: unit.y - 452 } : unit)),
};

/** The team's canvas, with the sessions menu over three more sessions. */
export async function parityMemory(
  layout: CanvasLayout | Record<string, never> = parityLayout,
  onOpen?: (sessionId: string) => void,
  /** Gives the client drafts (Review, and Save and approve for an approver). */
  drafts?: { canApprove: boolean },
): Promise<MemoryCanvas> {
  const memory = createMemoryCanvasClient({
    definition: parityDefinition,
    rows: parityRows(),
    actorId: "user-hana",
    session: { id: paritySession, title: "Q4 pay review", as_of: "2026-10-01", layout },
    sessions: { layout: parityLayout, ...(onOpen === undefined ? {} : { onOpen }) },
    ...(drafts === undefined ? {} : { drafts }),
  });
  for (const [index, title] of ["Promotions 2027", "New hires · EMEA", "Band refresh"].entries()) {
    await memory.client.session.request({
      operation: "create",
      expected_revision: 0,
      request_id: crypto.randomUUID(),
      session_id: uuid("8000", 5200 + index),
      title,
      as_of: `2026-0${7 + index}-01`,
    });
  }
  await memory.client.session.request({
    operation: "pin",
    session_id: uuid("8000", 5202),
    expected_revision: 1,
    request_id: crypto.randomUUID(),
    pinned: true,
  });
  return memory;
}

/**
 * One request on the team's session: an edit as is (last-write-wins), any
 * other at the session's current revision.
 */
export async function send(
  client: WorkSessionClient,
  request: Record<string, unknown> & { operation: string },
) {
  if (isEdit(request))
    return client.request({ ...request, session_id: paritySession } as WorkSessionRequest);
  const header = await client.request({
    operation: "get",
    session_id: paritySession,
    overlay: false,
  });
  return client.request({
    ...request,
    session_id: paritySession,
    expected_revision: header.revision,
    request_id: crypto.randomUUID(),
  } as WorkSessionRequest);
}

const pay = (n: number, amount: string) => ({
  model_id: "m_member",
  record_id: memberId(n),
  field_id: "f_pay",
  value: money(amount),
});

/** You raise Kenji to his band's low; the agent's rule then replaces it, with its note. */
export async function agentReplacesYourEdit(memory: MemoryCanvas) {
  await send(memory.client.session, { operation: "stage", changes: [pay(4, "95000")] });
  await send(memory.client.session, { operation: "stage", changes: [pay(6, "80000")] });
  await send(memory.asAgent(parityTurn), {
    operation: "stage",
    changes: [pay(4, "96000")],
    note: "Below-band members move to their band's low plus 1,000",
  });
}
