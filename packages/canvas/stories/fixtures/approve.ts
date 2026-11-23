// Review mode over the canvas fixture: drafts other people saved for
// review (two of them changing the same budget), one with a thread, a
// rejected draft with its note, and a published change for the changelog.
import type { MemoryCanvas } from "../../memory-client";
import { canvasMemory, typicalLayout, unitIds } from "./canvas";
import { money, projectId } from "./grid";

export const authors = {
  hana: "user-hana",
  ravi: "user-ravi",
  mei: "user-mei",
};
const names = {
  [authors.hana]: "Hana Kim",
  [authors.ravi]: "Ravi Patel",
  [authors.mei]: "Mei Chen",
};

export const draftThreadId = "e0000000-0000-4000-8000-000000000001";

/**
 * The typical canvas with a drafts client, as Hana; `canApprove` false is a
 * member who reads the review but does not act on it.
 */
export function approveMemory(canApprove = true) {
  return canvasMemory(typicalLayout, 12, { canApprove, authors: names });
}

const project = (
  n: number,
  fieldId: string,
  value: Parameters<MemoryCanvas["seedDraft"]>[0]["changes"][number]["value"],
) => ({
  model_id: "m_project",
  record_id: projectId(n),
  field_id: fieldId,
  value,
});

/**
 * Three pending drafts: Ravi's and Mei's both change Atlas's budget (each
 * its own card); Ravi's carries a thread. Returns their ids.
 */
export function seedDrafts(memory: MemoryCanvas) {
  const ravi = memory.seedDraft({
    actorId: authors.ravi,
    sessionId: "s-ravi",
    changes: [
      project(2, "f_budget", money("120000")),
      project(4, "f_status", { type: "enum", value: "active" }),
    ],
    threads: [
      {
        id: draftThreadId,
        anchor: {
          unit_id: unitIds.grid,
          model_id: "m_project",
          record_id: projectId(2),
          field_id: "f_budget",
        },
        messages: [
          {
            actor_id: authors.ravi,
            message: "The client signed the larger scope, so the budget goes up.",
          },
        ],
      },
    ],
  });
  const mei = memory.seedDraft({
    actorId: authors.mei,
    sessionId: "s-mei",
    changes: [project(2, "f_budget", money("90000"))],
  });
  const status = memory.seedDraft({
    actorId: authors.mei,
    sessionId: "s-mei-2",
    changes: [
      project(6, "f_status", { type: "enum", value: "on_hold" }),
      project(7, "f_estimate", { type: "number", value: "30" }),
    ],
  });
  return { ravi, mei, status };
}

/** A draft rejected with a note, for the Rejected tab. */
export async function seedRejected(memory: MemoryCanvas) {
  const id = memory.seedDraft({
    actorId: authors.ravi,
    sessionId: "s-ravi-old",
    changes: [project(3, "f_estimate", { type: "number", value: "90" })],
  });
  const kernel = memory.client.drafts!.kernel;
  await kernel.postJson("/api/draft/notes", {
    change_set_id: id,
    notes: "Ninety days doesn't fit this quarter. Split it into two phases.",
  });
  await kernel.postJson("/api/draft/discard", { change_set_id: id });
  return id;
}

/** A change Ravi saved that is already published, for the changelog. */
export async function seedPublished(memory: MemoryCanvas) {
  const id = memory.seedDraft({
    actorId: authors.ravi,
    sessionId: "s-ravi-live",
    changes: [project(1, "f_status", { type: "enum", value: "active" })],
  });
  // Approved by someone else, whoever is viewing.
  memory.seedApproval(id);
  await Promise.resolve();
  return id;
}
