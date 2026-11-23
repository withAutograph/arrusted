// What the agent learns from the canvas in the chat, at once: the person's
// selection and their last 20 actions here, as sentences by label (model
// labels, column headers) plus structured content, sent with
// `updateModelContext` 300 ms after the last change. It never triggers a
// reply, and never carries a token, a code or a request id.
import type { CanvasClient, CanvasSelection } from "@autograph/canvas";
import type {
  DataDefinition,
  WorkSessionRequest,
  WorkTarget,
} from "@autograph/generated-app-runtime/data";
import { createLabelIndex } from "@autograph/work-session-tools/labels";

/** How long changes settle before the context is sent. */
export const MODEL_CONTEXT_DEBOUNCE_MS = 300;
/** The most recent actions the context keeps. */
export const MODEL_CONTEXT_ACTIONS = 20;

/** One thing the person did in the chat's canvas, as the agent reads it. */
export type CanvasAction = { action: string; sentence: string; at: string };

type ModelContextUpdate = {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const list = (items: readonly string[]) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/** Sentences by label for selections and session operations. */
export function describer(definition: DataDefinition) {
  const labels = createLabelIndex(definition);
  const model = (id: string) => labels.modelLabel(id);
  const header = (modelId: string, fieldId: string) => labels.header(modelId, fieldId);
  /** "Base pay on 2 Employee records". */
  const targets = (items: readonly WorkTarget[]) => {
    const byModel = new Map<string, { fields: Set<string>; records: Set<string> }>();
    for (const item of items) {
      const entry = byModel.get(item.model_id) ?? { fields: new Set(), records: new Set() };
      entry.fields.add(header(item.model_id, item.field_id));
      entry.records.add(item.record_id);
      byModel.set(item.model_id, entry);
    }
    return list(
      [...byModel].map(
        ([modelId, entry]) =>
          `${list([...entry.fields])} on ${plural(entry.records.size, `${model(modelId)} record`)}`,
      ),
    );
  };
  return {
    model,
    selection(selection: CanvasSelection | null): string {
      if (selection === null) return "Nothing is selected.";
      switch (selection.kind) {
        case "cells": {
          const fields = [...new Set(selection.cells.map((cell) => cell.field_id))];
          const records = new Set(selection.cells.map((cell) => cell.record_id)).size;
          return `Selected ${list(fields.map((field) => header(selection.model_id, field)))} of ${plural(records, `${model(selection.model_id)} record`)}.`;
        }
        case "rows":
        case "nodes":
          return `Selected ${plural(selection.record_ids.length, `${model(selection.model_id)} record`)}.`;
        case "segment":
          return `Selected one ${header(selection.model_id, selection.field_id)} group of ${model(selection.model_id)} records.`;
      }
    },
    /** The selection as structured content: its kind, model, columns and record count; no ids. */
    selectionSummary(selection: CanvasSelection) {
      const columns =
        selection.kind === "cells"
          ? [...new Set(selection.cells.map((cell) => header(selection.model_id, cell.field_id)))]
          : selection.kind === "segment"
            ? [header(selection.model_id, selection.field_id)]
            : [];
      const records =
        selection.kind === "cells"
          ? new Set(selection.cells.map((cell) => cell.record_id)).size
          : selection.kind === "segment"
            ? null
            : selection.record_ids.length;
      return {
        kind: selection.kind,
        model: model(selection.model_id),
        ...(columns.length === 0 ? {} : { columns }),
        ...(records === null ? {} : { records }),
      };
    },
    /** The sentence for a successful session operation, or null for reads and presence. */
    operation(input: WorkSessionRequest, result: unknown): string | null {
      const request = input as Record<string, unknown> & { operation: string };
      switch (request.operation) {
        case "stage": {
          const changes = (request.changes ?? []) as WorkTarget[];
          return `Staged ${targets(changes)}.`;
        }
        case "unstage":
          return `Reverted ${targets([request as unknown as WorkTarget])}.`;
        case "discard_turn":
          return "Reverted one of your turns.";
        case "discard_source":
          return request.source === "agent"
            ? "Reverted every change you staged."
            : "Discarded their own staged edits.";
        case "save": {
          // Save always drafts; a null change set means nothing needed writing.
          const changeSet = (result as { change_set?: { id?: unknown } | null } | null)?.change_set;
          return changeSet == null
            ? "Saved; nothing needed writing."
            : typeof changeSet.id === "number"
              ? `Saved the staged changes as draft #${changeSet.id} for review.`
              : "Saved the staged changes as a draft for review.";
        }
        case "thread_open":
          return "Opened a comment thread.";
        case "thread_reply":
          return "Replied on a comment thread.";
        case "thread_resolve":
          return "Resolved a thread (or answered your request to Save with Not now).";
        case "pull":
          return "Pulled a proposal into the staged changes.";
        case "dismiss":
          return "Dismissed a proposal.";
        case "rule_create":
          return "Created a rule.";
        case "rule_parameters":
          return "Changed a rule's parameters.";
        case "rule_remove":
          return "Removed a rule.";
        case "update": {
          const patch = (request.patch ?? {}) as Record<string, unknown>;
          if (typeof patch.as_of === "string") return `Moved the session to ${patch.as_of}.`;
          if (typeof patch.title === "string") return "Renamed the session.";
          return "Arranged the canvas.";
        }
        default:
          return null;
      }
    },
    /** The sentence for a successful review action, or null for reads. */
    review(path: string): string | null {
      switch (path) {
        case "/api/draft/approve":
          return "Approved and published a draft.";
        case "/api/draft/discard":
          return "Rejected a draft.";
        case "/api/revert":
          return "Reverted a published change.";
        case "/api/draft/notes":
          return "Edited a draft's notes.";
        default:
          return null;
      }
    },
  };
}

/**
 * The client the canvas uses, observed: each successful mutation is one
 * action. Reads, presence and failures are not actions.
 */
export function observedClient(
  client: CanvasClient,
  onAction: (action: string, sentence: string) => void,
): CanvasClient {
  const describe = describer(client.definition);
  const drafts = client.drafts;
  return {
    ...client,
    session: {
      request: async (input) => {
        const result = await client.session.request(input);
        const sentence = describe.operation(input, result);
        if (sentence !== null) onAction(input.operation, sentence);
        return result;
      },
    },
    ...(drafts === undefined
      ? {}
      : {
          drafts: {
            ...drafts,
            kernel: {
              ...drafts.kernel,
              postJson: async <T>(path: string, body: unknown) => {
                const result = await drafts.kernel.postJson<T>(path, body);
                const sentence = describe.review(path);
                if (sentence !== null) onAction(path.replace(/^\/api\//u, ""), sentence);
                return result;
              },
            },
          },
        }),
  };
}

/** The selection and recent actions, sent to the model 300 ms after the last change. */
export function createModelContext(input: {
  definition: DataDefinition;
  send: (update: ModelContextUpdate) => Promise<unknown>;
  setTimeout?: (run: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}) {
  const describe = describer(input.definition);
  const later = input.setTimeout ?? ((run, ms) => globalThis.setTimeout(run, ms));
  const cancel =
    input.clearTimeout ??
    ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  let sessionTitle: string | null = null;
  let selection: CanvasSelection | null = null;
  const actions: CanvasAction[] = [];
  let timer: unknown;
  const schedule = () => {
    if (timer !== undefined) cancel(timer);
    timer = later(() => {
      timer = undefined;
      void input.send(build()).catch(() => {});
    }, MODEL_CONTEXT_DEBOUNCE_MS);
  };
  const build = (): ModelContextUpdate => {
    const lines = [
      `The person is working in the canvas${sessionTitle === null ? "" : ` "${sessionTitle}"`} in this chat, as themselves.`,
      describe.selection(selection),
      ...(actions.length === 0
        ? []
        : [
            "Their recent actions here, oldest first:",
            ...actions.map((action) => `- ${action.sentence}`),
          ]),
    ];
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: {
        // Counts and column headers only: describe_workspace names the records.
        selection: selection === null ? null : describe.selectionSummary(selection),
        actions: actions.map(({ action, sentence, at }) => ({ action, sentence, at })),
      },
    };
  };
  return {
    session(title: string) {
      sessionTitle = title;
    },
    select(next: CanvasSelection | null) {
      selection = next;
      schedule();
    },
    action(action: string, sentence: string) {
      actions.push({ action, sentence, at: new Date().toISOString() });
      if (actions.length > MODEL_CONTEXT_ACTIONS)
        actions.splice(0, actions.length - MODEL_CONTEXT_ACTIONS);
      schedule();
    },
    /** Signed out or pairing again: forget the selection and actions, and send nothing pending. */
    reset() {
      if (timer !== undefined) cancel(timer);
      timer = undefined;
      selection = null;
      actions.length = 0;
    },
    /** For tests: the update the next send would carry. */
    current: build,
  };
}
