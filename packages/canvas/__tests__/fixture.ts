import type { DataDefinition } from "@autograph/generated-app-runtime/data";
import type { CanvasClient } from "../client";
import { createMemoryCanvasClient } from "../memory-client";

export const definition = {
  formatVersion: 1,
  schemaVersion: "test-1",
  models: [
    {
      id: "m_person",
      name: "person",
      label: "Person",
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
          id: "f_team",
          name: "team",
          label: "Team",
          type: "enum",
          required: false,
          readOnly: false,
          option_set: [
            { id: "eng", label: "Engineering" },
            { id: "ops", label: "Operations" },
          ],
        },
        {
          id: "f_score",
          name: "score",
          label: "Score",
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
        {
          id: "f_notes",
          name: "notes",
          label: "Notes",
          type: "json",
          required: false,
          readOnly: false,
        },
      ],
    },
  ],
} as const satisfies DataDefinition;

export const ids = {
  ada: "00000000-0000-4000-8000-000000000001",
  bo: "00000000-0000-4000-8000-000000000002",
  cy: "00000000-0000-4000-8000-000000000003",
  session: "00000000-0000-4000-8000-0000000000aa",
  turn1: "00000000-0000-4000-8000-0000000000b1",
  turn2: "00000000-0000-4000-8000-0000000000b2",
};

export const money = (
  amount: string,
  currency = "USD",
  period: "annual" | "monthly" = "annual",
) => ({
  type: "money_rate" as const,
  value: { amount, currency, period },
});
export const num = (value: string) => ({ type: "number" as const, value });
export const text = (value: string) => ({ type: "text" as const, value });

/** The fixture's people; with `drafts`, the client also reviews drafts (as an approver unless `canApprove` is false). */
export function memory(options: { drafts?: boolean; canApprove?: boolean } = {}) {
  return createMemoryCanvasClient({
    ...(options.drafts
      ? { drafts: options.canApprove === undefined ? {} : { canApprove: options.canApprove } }
      : {}),
    definition,
    rows: {
      m_person: [
        {
          id: ids.ada,
          values: {
            f_name: text("Ada"),
            f_team: { type: "enum", value: "eng" },
            f_score: num("1"),
            f_pay: money("100"),
          },
        },
        {
          id: ids.bo,
          values: {
            f_name: text("Bo"),
            f_team: { type: "enum", value: "eng" },
            f_score: num("2"),
            f_pay: money("200"),
            f_manager: { type: "relation", value: { type: "record_id", value: ids.ada } },
          },
        },
        {
          id: ids.cy,
          values: {
            f_name: text("Cy"),
            f_team: { type: "enum", value: "ops" },
            f_score: num("3"),
            f_pay: money("50", "EUR", "monthly"),
            f_manager: { type: "relation", value: { type: "record_id", value: ids.ada } },
          },
        },
      ],
    },
    session: { id: ids.session, title: "Review", as_of: "2026-10-01" },
  });
}

let counter = 0;
/** A guard for a direct session call at `revision`. */
export const guard = (revision: number, requestId = `req-${(counter += 1)}`) => ({
  session_id: ids.session,
  expected_revision: revision,
  request_id: requestId,
});

/** A last-write-wins edit names only the session: no revision, no request id. */
export const edit = () => ({ session_id: ids.session });

/** Records every session request; `silent` drops live pushes (a slow stream). */
export function recording(client: CanvasClient, options: { silent?: boolean } = {}) {
  const calls: Record<string, unknown>[] = [];
  const wrapped: CanvasClient = {
    ...client,
    session: {
      request: (input) => {
        calls.push(structuredClone(input) as Record<string, unknown>);
        return client.session.request(input);
      },
    },
    subscribe: options.silent ? () => () => {} : client.subscribe,
  };
  return { client: wrapped, calls };
}
