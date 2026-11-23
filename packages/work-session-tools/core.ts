import { createHash } from "node:crypto";
import {
  createDataClient,
  type DataContext,
  type DataDefinition,
  type DataField,
  type DataModel,
  type WorkChange,
  type WorkJson,
  type WorkTarget,
} from "@autograph/generated-app-runtime/data";
import {
  createLabelIndex,
  displayDecoded,
  displayWire,
  encodeCell,
  fieldHeader,
  modelLabel,
  titleFieldOf,
  resolveExpression,
  WorkSessionToolInputError,
  mainModelOrder,
  type LabelIndex,
} from "./labels";
import {
  addUnit,
  arrangeLayout,
  ArrangeError,
  chartConfigSchema,
  chartKinds,
  kpiConfigSchema,
  noteConfigSchema,
  noteMaxLength,
  newSessionLayout,
  parseLayout,
  placedLayout,
  type ArrangeInput,
  type CanvasLayout,
  type CanvasUnit,
} from "./layout";
import * as schema from "./schemas";
import { mapImportCsv } from "@autograph/csv-workspace/mapping";
import { prepareRecordImport } from "./records";

export type WorkSessionToolId =
  | "list_sessions"
  | "create_session"
  | "describe_workspace"
  | "read_entries"
  | "find_records"
  | "aggregate"
  | "field_options"
  | "record_history"
  | "propose_records"
  | "import_csv"
  | "stage_changes"
  | "unstage"
  | "discard_mine"
  | "revert_turn"
  | "open_thread"
  | "propose_changes"
  | "reply"
  | "dismiss_proposal"
  | "create_rule"
  | "set_rule_parameters"
  | "remove_rule"
  | "resolve_thread"
  | "request_save"
  | "set_as_of"
  | "add_unit"
  | "update_unit"
  | "move_unit"
  | "arrange_layout"
  | "remove_unit";

/** A provider-neutral tool: adapters publish its id, description and input schema. */
export type WorkSessionToolSpec = {
  id: WorkSessionToolId;
  /** Generic status line while the tool runs. */
  label: string;
  description: string;
  /** Reads, or working-state changes a human reviews before Save. */
  capability: "read_only" | "proposal";
  inputSchema: schema.JsonSchemaObject;
};

/** One tool call. Each call runs as its own short transaction in `context`. */
export type WorkSessionToolCall = {
  /** The platform agent context for this call's turn. */
  context: DataContext;
  /** Stable identity of the conversation (chat thread, MCP connection). */
  conversationId: string;
  /** The transport's id for this call; a retry reuses it. */
  callId: string | number;
};

export type WorkSessionToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

const read = "read_only" as const;
const proposal = "proposal" as const;
const guarded = (
  properties: Readonly<Record<string, schema.JsonSchemaObject>>,
  required: readonly string[],
) => schema.object({ ...schema.guarded, ...properties }, [...schema.guardedRequired, ...required]);
/** Edits are last-write-wins: they name the session and carry no revision. */
const editing = (
  properties: Readonly<Record<string, schema.JsonSchemaObject>>,
  required: readonly string[],
) => schema.object({ ...schema.sessionOnly, ...properties }, ["session_id", ...required]);
const where = {
  type: "array",
  maxItems: 20,
  items: schema.object(
    {
      column: schema.column,
      op: { enum: ["eq", "ne", "lt", "lte", "gt", "gte", "contains", "isNull"] },
      value: { type: ["string", "number", "boolean"] },
    },
    ["column", "op"],
  ),
};

/** Unit settings shared by add_unit and update_unit; each kind reads its own. */
const unitSettings = {
  group_by: {
    ...schema.column,
    description: "Chart: the column to group by (a timeline's date column; a range chart's group).",
  },
  series_by: {
    ...schema.column,
    description: "Chart: a heatmap's column dimension, or a stacked timeline's stacks.",
  },
  metric: {
    enum: ["count", "sum", "avg"],
    description: "Chart: what to measure (count).",
  },
  measure: { ...schema.column, description: "Chart: the column summed or averaged." },
  chart: {
    enum: [...chartKinds],
    description:
      "Chart: breakdown (bars), donut, heatmap (group_by × series_by), stacked_timeline (date group_by, stacked by series_by) or range (each record's `value` against its own `low`–`high` range and optional `target`, grouped by group_by).",
  },
  value: { ...schema.column, description: "Range chart: the value column plotted as points." },
  low: { ...schema.column, description: "Range chart: the low column." },
  target: { ...schema.column, description: "Range chart: the target column (optional)." },
  high: { ...schema.column, description: "Range chart: the high column." },
  relation: { ...schema.column, description: "Graph: the relation column it follows." },
  record_id: { ...schema.recordId, description: "Graph: the record to centre on first." },
  text: {
    type: "string",
    maxLength: noteMaxLength,
    description: "Note: its plain text.",
  },
  kpis: {
    type: "array",
    minItems: 1,
    maxItems: 6,
    description: "KPI strip: up to six aggregates; money shows its currency and period.",
    items: schema.object(
      {
        fn: { enum: ["count", "sum", "avg", "min", "max", "median"] },
        column: schema.column,
      },
      ["fn"],
    ),
  },
} as const;

/**
 * The tool table. A tool may start a new session for the person (like
 * `git checkout -b`); none duplicates, retitles, rescopes, pins, pulls,
 * approves, publishes or Saves, or changes a setting; the layout tools
 * arrange the session's canvas only.
 */
export const workSessionToolSpecs: readonly WorkSessionToolSpec[] = [
  {
    id: "list_sessions",
    label: "Listing working sessions",
    capability: read,
    description: "List your working sessions (headers only).",
    inputSchema: schema.object({ status: { enum: ["active", "archived"] } }),
  },
  {
    id: "create_session",
    label: "Starting a session",
    capability: proposal,
    description:
      "Start a new working session for the person: one grid per model, arranged. It is theirs and private to them; only they Save it. as_of (YYYY-MM-DD) defaults to today. When the person has no canvas yet, first offer them two or three starting canvases and create the one they pick, then add its units with add_unit.",
    inputSchema: schema.object(
      {
        title: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "The session's title.",
        },
        as_of: {
          type: "string",
          pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$",
          description: "The date the session reads its data at (YYYY-MM-DD).",
        },
      },
      ["title"],
    ),
  },
  {
    id: "describe_workspace",
    label: "Reading the workspace",
    capability: read,
    description:
      "Describe a session: its as-of date and revision, every model's columns by header (with option labels and related models), the units on its canvas, the session's rules and its open threads, what the person has selected in the canvas (records by name, columns by header) and your open request to Save.",
    inputSchema: schema.object(schema.sessionOnly, ["session_id"]),
  },
  {
    id: "read_entries",
    label: "Reading staged changes",
    capability: read,
    description:
      "Read one page of the session's staged changes in key order, optionally filtered by model, source or turn. Continue with `after` set to the returned `next`.",
    inputSchema: schema.object(
      {
        ...schema.sessionOnly,
        model: schema.model,
        source: { enum: ["user", "agent"] },
        turn_id: { type: "string" },
        after: schema.target,
        limit: { type: "integer", minimum: 1, maximum: 1000 },
      },
      ["session_id"],
    ),
  },
  {
    id: "find_records",
    label: "Finding records",
    capability: read,
    description:
      "Find records of one model as they stand in the session at its as-of date: saved drafts still waiting for approval are included (the latest saved wins per column), then the session's staged values. Filter, search and sort by column header; 1 to 100 records per page.",
    inputSchema: schema.object(
      {
        ...schema.sessionOnly,
        model: schema.model,
        columns: { type: "array", items: schema.column, minItems: 1 },
        where,
        search: schema.object(
          {
            query: { type: "string" },
            columns: { type: "array", items: schema.column, minItems: 1 },
          },
          ["query", "columns"],
        ),
        order_by: {
          type: "array",
          maxItems: 5,
          items: schema.object({ column: schema.column, direction: { enum: ["asc", "desc"] } }, [
            "column",
            "direction",
          ]),
        },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        offset: { type: "integer", minimum: 0 },
      },
      ["session_id", "model"],
    ),
  },
  {
    id: "aggregate",
    label: "Aggregating",
    capability: read,
    description:
      "Aggregate one model over the session's staged values and the saved drafts still waiting for approval (as the canvas shows them by default): count, count_distinct, sum, avg, min, max, median or percentile, optionally grouped by up to two columns.",
    inputSchema: schema.object(
      {
        ...schema.sessionOnly,
        model: schema.model,
        where,
        group_by: {
          type: "array",
          maxItems: 2,
          items: {
            anyOf: [
              schema.column,
              schema.object(
                {
                  column: schema.column,
                  edges: { type: "array", items: { type: "string" }, minItems: 2 },
                  unit: schema.object(
                    { currency: { type: "string" }, period: { type: "string" } },
                    ["currency", "period"],
                  ),
                },
                ["column", "edges"],
              ),
            ],
          },
        },
        metrics: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: schema.object(
            {
              fn: {
                enum: [
                  "count",
                  "count_distinct",
                  "sum",
                  "avg",
                  "min",
                  "max",
                  "median",
                  "percentile",
                ],
              },
              column: schema.column,
              p: { type: "number", minimum: 0, maximum: 1 },
            },
            ["fn"],
          ),
        },
      },
      ["session_id", "model", "metrics"],
    ),
  },
  {
    id: "field_options",
    label: "Reading allowed values",
    capability: read,
    description: "List a column's allowed values by label.",
    inputSchema: schema.object({ model: schema.model, column: schema.column }, ["model", "column"]),
  },
  {
    id: "record_history",
    label: "Reading record history",
    capability: read,
    description: "Read a record's canonical field history (saved changes only).",
    inputSchema: schema.object(
      {
        model: schema.model,
        record_id: schema.recordId,
        as_of: { type: "string" },
        limit: { type: "integer", minimum: 1 },
      },
      ["model", "record_id"],
    ),
  },
  {
    id: "propose_records",
    label: "Preparing new records",
    capability: proposal,
    description:
      "Prepare new records for human review. Returns a JSON proposal; it does not persist records or session drafts. Give the person the proposal to paste into Add records or import CSV → Claude proposal in the web Canvas, preview, then apply or save drafts. Existing-record copy/fill can use stage_changes instead. External keys update matching records when the human applies.",
    inputSchema: editing(
      {
        model: schema.model,
        rows: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: schema.object(
            {
              values: { type: "object", additionalProperties: schema.cellValue },
              external_key: { type: "string", minLength: 1 },
            },
            ["values"],
          ),
        },
      },
      ["model", "rows"],
    ),
  },
  {
    id: "import_csv",
    label: "Preparing a CSV import",
    capability: proposal,
    description:
      "Map CSV headings to model column headers/ids, or $externalKey for repeat-import matching. Empty cells leave existing values unchanged; duplicate external keys within a file are refused. Returns a human-review JSON proposal only: no records or session drafts are persisted. The person pastes it into Add records or import CSV → Claude proposal, previews and applies or saves drafts. Up to 100 rows and 512 KiB.",
    inputSchema: editing(
      {
        model: schema.model,
        csv: { type: "string", maxLength: 524288 },
        mapping: { type: "object", additionalProperties: { type: "string" } },
      },
      ["model", "csv", "mapping"],
    ),
  },
  {
    id: "stage_changes",
    label: "Staging changes",
    capability: proposal,
    description:
      'Stage values in the session; a human reviews and Saves them. Staging is last-write-wins: no revision is needed, and the latest value staged on a field stays. You may change any staged value, a human\'s edit too: the human sees that you replaced it and can restore theirs. Pass `rule.description` to say in plain words why (shown as "By rule: …").',
    inputSchema: editing(
      {
        changes: schema.changes,
        rule: schema.object({ description: { type: "string", minLength: 1, maxLength: 200 } }, [
          "description",
        ]),
      },
      ["changes"],
    ),
  },
  {
    id: "unstage",
    label: "Removing a staged change",
    capability: proposal,
    description:
      "Remove one staged change an agent made; the field returns to its saved value, or to the human's edit it replaced. A human's own edit is theirs to remove: unstaging it is refused.",
    inputSchema: editing(
      { model: schema.model, record_id: schema.recordId, column: schema.column },
      ["model", "record_id", "column"],
    ),
  },
  {
    id: "discard_mine",
    label: "Discarding my changes",
    capability: proposal,
    description: "Remove every change you staged in the session.",
    inputSchema: editing({}, []),
  },
  {
    id: "revert_turn",
    label: "Reverting a turn",
    capability: proposal,
    description: "Remove the changes you staged in one turn (its turn_id from read_entries).",
    inputSchema: editing({ turn_id: { type: "string" } }, ["turn_id"]),
  },
  {
    id: "open_thread",
    label: "Opening a thread",
    capability: proposal,
    description: "Open a discussion thread, optionally anchored to a record or one of its columns.",
    inputSchema: guarded(
      {
        anchor: schema.object(
          { model: schema.model, record_id: schema.recordId, column: schema.column },
          ["model", "record_id"],
        ),
      },
      [],
    ),
  },
  {
    id: "propose_changes",
    label: "Proposing changes",
    capability: proposal,
    description:
      "Propose changes in a thread for a human to pull or dismiss, when you want agreement before staging.",
    inputSchema: guarded({ thread_id: schema.threadId, changes: schema.changes }, [
      "thread_id",
      "changes",
    ]),
  },
  {
    id: "reply",
    label: "Replying",
    capability: proposal,
    description: "Reply in a thread.",
    inputSchema: guarded(
      { thread_id: schema.threadId, message: { type: "string", minLength: 1 } },
      ["thread_id", "message"],
    ),
  },
  {
    id: "dismiss_proposal",
    label: "Dismissing a proposal",
    capability: proposal,
    description: "Dismiss your proposal in a thread.",
    inputSchema: guarded({ thread_id: schema.threadId }, ["thread_id"]),
  },
  {
    id: "create_rule",
    label: "Creating a rule",
    capability: proposal,
    description:
      "Create a rule that stages `value` in one column for every record of a model where the optional boolean `condition` holds. Expressions name columns by header.",
    inputSchema: guarded(
      {
        model: schema.model,
        column: schema.column,
        description: { type: "string" },
        value: schema.expression("Value expression, typed like the column."),
        condition: schema.expression("Optional boolean condition."),
        parameters: schema.ruleParameters,
      },
      ["model", "column", "value"],
    ),
  },
  {
    id: "set_rule_parameters",
    label: "Updating rule parameters",
    capability: proposal,
    description: "Set a rule's parameters (any rule); the rule re-evaluates.",
    inputSchema: guarded({ rule_id: schema.ruleId, parameters: schema.ruleParameters }, [
      "rule_id",
      "parameters",
    ]),
  },
  {
    id: "remove_rule",
    label: "Removing a rule",
    capability: proposal,
    description: "Remove one of your rules and the values it staged.",
    inputSchema: guarded({ rule_id: schema.ruleId }, ["rule_id"]),
  },
  {
    id: "resolve_thread",
    label: "Resolving a thread",
    capability: proposal,
    description: "Mark a thread in the session resolved.",
    inputSchema: guarded({ thread_id: schema.threadId }, ["thread_id"]),
  },
  {
    id: "request_save",
    label: "Asking to Save",
    capability: proposal,
    description:
      "Ask the person to Save the session's staged changes; you cannot Save. They see your reason on the Save bar and answer Save or Not now. A new request replaces an open one; describe_workspace shows the open request.",
    inputSchema: guarded(
      {
        reason: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Why to Save now, in a sentence the person reads (at most 200 characters).",
        },
      },
      ["reason"],
    ),
  },
  {
    id: "set_as_of",
    label: "Changing the as-of date",
    capability: proposal,
    description:
      "Change the date the session reads its data at (YYYY-MM-DD). Every view re-reads and rules re-run; staged values stay, and any whose record changed by then is confirmed by the human at Save.",
    inputSchema: editing({ as_of: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" } }, [
      "as_of",
    ]),
  },
  {
    id: "add_unit",
    label: "Adding to the canvas",
    capability: proposal,
    description:
      "Add a unit to the session's canvas, after the others in grid order (in the first free place on a free canvas): a grid of a model's records, a chart, a relationship graph over one relation column, a note (plain text) or a KPI strip. Rules place their own cards. Applies to the latest layout; returns the unit_id.",
    inputSchema: schema.object(
      {
        ...schema.sessionOnly,
        kind: { enum: ["grid", "chart", "graph", "note", "kpi"] },
        model: { ...schema.model, description: "Model label; every kind but a note needs one." },
        ...unitSettings,
      },
      ["session_id", "kind"],
    ),
  },
  {
    id: "update_unit",
    label: "Changing a canvas unit",
    capability: proposal,
    description:
      "Replace one unit's settings (its unit_id from describe_workspace), given as for add_unit; the model defaults to the unit's own. Applies to the latest layout.",
    inputSchema: schema.object(
      {
        ...schema.sessionOnly,
        unit_id: schema.unitId,
        model: schema.model,
        ...unitSettings,
      },
      ["session_id", "unit_id"],
    ),
  },
  {
    id: "move_unit",
    label: "Arranging the canvas",
    capability: proposal,
    description:
      "Move or resize one canvas unit (its unit_id from describe_workspace) in plane pixels; omitted coordinates stay. Moving a unit puts the canvas in free placement; arrange_layout tidies it into a grid again. Applies to the latest layout.",
    inputSchema: schema.object(
      {
        ...schema.sessionOnly,
        unit_id: schema.unitId,
        x: { type: "number" },
        y: { type: "number" },
        w: { type: "number", exclusiveMinimum: 0 },
        h: { type: "number", exclusiveMinimum: 0 },
      },
      ["session_id", "unit_id"],
    ),
  },
  {
    id: "arrange_layout",
    label: "Arranging the canvas",
    capability: proposal,
    description:
      'Arrange the canvas so it reads well. mode "grid": columns (1-24, default 12) and gap (px); units [{unit_id, span (columns), order, h}] flow left to right and wrap, each row as tall as its tallest unit. mode "free": units [{unit_id, x, y, w, h}] in canvas pixels (w/h 80-4000), Figma-like. mode "auto": a tidy grid chosen for you (grids and KPI strips full width on top; charts, graphs, rules and notes in a row below). Units you do not list keep their settings and follow the listed ones. Either way everything stays on the one canvas.',
    inputSchema: schema.object(
      {
        ...schema.sessionOnly,
        mode: { enum: ["grid", "free", "auto"] },
        columns: { type: "integer", minimum: 1, maximum: 24 },
        gap: { type: "number", minimum: 0, maximum: 400 },
        units: {
          type: "array",
          maxItems: 50,
          items: schema.object(
            {
              unit_id: schema.unitId,
              span: { type: "integer", minimum: 1, maximum: 24 },
              order: { type: "integer" },
              x: { type: "number" },
              y: { type: "number" },
              w: { type: "number" },
              h: { type: "number" },
            },
            ["unit_id"],
          ),
        },
      },
      ["session_id", "mode"],
    ),
  },
  {
    id: "remove_unit",
    label: "Removing from the canvas",
    capability: proposal,
    description:
      "Remove one grid, chart or graph from the session's canvas; a rule's card goes with remove_rule. Applies to the latest layout.",
    inputSchema: schema.object({ ...schema.sessionOnly, unit_id: schema.unitId }, [
      "session_id",
      "unit_id",
    ]),
  },
].map((spec) =>
  spec.id === "create_rule"
    ? { ...spec, inputSchema: { ...spec.inputSchema, $defs: schema.derivedExpressionDefs } }
    : spec,
) as readonly WorkSessionToolSpec[];

/** An unambiguous serialization: a call id keeps its type, so `1` and `"1"` differ. */
const digest = (purpose: string, conversationId: string, callId: string | number, name: string) =>
  createHash("sha256")
    .update(JSON.stringify([purpose, conversationId, typeof callId, callId, name]))
    .digest();
/** The work-session request ID for one tool call; a retried call replays from its receipt. */
export function workSessionRequestId(
  conversationId: string,
  callId: string | number,
  tool: string,
): string {
  return `agent:${digest("request", conversationId, callId, tool).toString("base64url")}`;
}
/** A UUID derived from the call, so a retried create names the same thread or rule. */
export function mintedId(conversationId: string, callId: string | number, purpose: string): string {
  const bytes = digest("minted", conversationId, callId, purpose);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Kernel and resolution failures come back as tool errors, unchanged. */
export function toolError(error: unknown): Extract<WorkSessionToolResult, { ok: false }> {
  if (error !== null && typeof error === "object" && "envelope" in error) {
    const envelope = (
      error as { envelope: { code?: unknown; message?: unknown; details?: unknown } }
    ).envelope;
    return {
      ok: false,
      error: {
        code: typeof envelope.code === "string" ? envelope.code : "kernel_error",
        message: typeof envelope.message === "string" ? envelope.message : "Kernel request failed",
        ...(envelope.details === undefined ? {} : { details: envelope.details }),
      },
    };
  }
  if (error instanceof WorkSessionToolInputError)
    return { ok: false, error: { code: error.code, message: error.message } };
  const message = error instanceof Error ? error.message : "Tool call failed";
  const coded = /^([a-z][a-z_]+): ([\s\S]*)$/u.exec(message);
  return coded
    ? { ok: false, error: { code: coded[1]!, message: coded[2]! } }
    : { ok: false, error: { code: "tool_failed", message } };
}

type Args = Record<string, unknown>;
const fail = (message: string): never => {
  throw new WorkSessionToolInputError(message);
};
const text = (args: Args, key: string): string =>
  typeof args[key] === "string" ? (args[key] as string) : fail(`${key} must be a string`);
const optionalText = (args: Args, key: string): string | undefined =>
  args[key] === undefined ? undefined : text(args, key);
const integerArg = (args: Args, key: string): number =>
  Number.isSafeInteger(args[key]) ? (args[key] as number) : fail(`${key} must be an integer`);
const optionalInteger = (args: Args, key: string): number | undefined =>
  args[key] === undefined ? undefined : integerArg(args, key);
const record = (value: unknown, key: string): Args =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Args)
    : fail(`${key} must be an object`);
const list = (args: Args, key: string): unknown[] =>
  Array.isArray(args[key]) ? (args[key] as unknown[]) : fail(`${key} must be an array`);
const optionalNumber = (args: Args, key: string): number | undefined =>
  args[key] === undefined
    ? undefined
    : Number.isFinite(args[key])
      ? (args[key] as number)
      : fail(`${key} must be a number`);

type ModelOperations = {
  list(input: unknown): Promise<Record<string, unknown>[]>;
  aggregate(input: unknown): Promise<{
    as_of: string;
    units: unknown[];
    groups: { key: unknown[]; metrics: unknown[] }[];
    total: { metrics: unknown[] };
    other_units?: string;
  }>;
  history(input: unknown): Promise<Record<string, unknown>[]>;
};

/** A calendar date as YYYY-MM-DD, or why it is not one. */
const calendarDate = (value: string) => {
  const date = new Date(`${value}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  )
    fail("as_of must be a calendar date (YYYY-MM-DD)");
  return value;
};

/**
 * The work-session tool core over the generated data and work-session clients.
 * Tools resolve labels to ids and pass them through; the kernel decides.
 */
export function createWorkSessionToolCore(definition: DataDefinition) {
  const labels = createLabelIndex(definition);
  const specs = new Map(workSessionToolSpecs.map((spec) => [spec.id, spec]));
  const views = createViews(labels);

  async function run(id: WorkSessionToolId, args: Args, call: WorkSessionToolCall) {
    const client = createDataClient(definition, call.context);
    const work = client.workSessions;
    const modelOps = (model: DataModel) =>
      (client as unknown as Record<string, ModelOperations>)[model.name] ??
      fail(`model ${modelLabel(model)} has no data client`);
    const guard = () => ({
      session_id: text(args, "session_id"),
      expected_revision: integerArg(args, "expected_revision"),
      request_id: workSessionRequestId(call.conversationId, call.callId, id),
    });
    const edit = () => ({ session_id: text(args, "session_id") });
    const resolveTarget = (value: unknown, key: string): WorkTarget => {
      const target = record(value, key);
      const model = labels.model(text(target, "model"));
      return {
        model_id: model.id,
        record_id: text(target, "record_id"),
        field_id: labels.field(model, text(target, "column")).id,
      };
    };
    // A client `thread_id` is never forwarded: only pull stages with a thread.
    const resolveChanges = () =>
      list(args, "changes").map((item) => {
        const change = record(item, "change");
        const model = labels.model(text(change, "model"));
        const field = labels.field(model, text(change, "column"));
        return {
          model_id: model.id,
          record_id: text(change, "record_id"),
          field_id: field.id,
          value: encodeCell(labels, field, change.value),
        };
      });
    const header = async (sessionId: string) =>
      await work.request({ operation: "get", session_id: sessionId, overlay: false });
    // The layout tools change the latest layout, as a drag on the canvas does;
    // layout updates are last-write-wins. `change` answers null when the
    // layout already shows it (a retried call).
    const arrange = async (change: (layout: CanvasLayout) => CanvasLayout | null) => {
      const sessionId = text(args, "session_id");
      const session = await header(sessionId);
      const current = parseLayout(session.layout);
      if (!current.ok) throw new Error(`layout_invalid: ${current.error}`);
      const layout = change(current.layout);
      if (layout === null) return { revision: session.revision };
      return await work.request({
        operation: "update",
        session_id: sessionId,
        patch: { layout: layout as unknown as WorkJson },
      });
    };
    const unitIn = (layout: CanvasLayout): CanvasUnit => {
      const unitId = text(args, "unit_id");
      const unit = layout.units.find((item) => item.id === unitId);
      if (unit === undefined) throw new Error(`unit_not_found: no unit ${unitId} on the canvas`);
      return unit;
    };
    const filters = (model: DataModel) =>
      args.where === undefined
        ? {}
        : {
            where: list(args, "where").map((item) => {
              const filter = record(item, "where");
              const field = labels.field(model, text(filter, "column"));
              const value = filter.value;
              return {
                field: field.name,
                op: text(filter, "op"),
                ...(value === undefined
                  ? {}
                  : {
                      value:
                        typeof value === "boolean"
                          ? value
                          : field.type === "enum"
                            ? labels.optionId(field, String(value))
                            : String(value),
                    }),
              };
            }),
          };

    /**
     * The person's selection (session presence) as they read it: each record
     * by its model and name, with the columns selected in it by header. Only
     * records a read over the session returns are named; at most 50.
     */
    const selection = async (session: {
      id: string;
      as_of: string;
      presence?: {
        selection: readonly { model_id: string; record_id: string; field_id?: string }[];
      } | null;
    }) => {
      const targets = session.presence?.selection ?? [];
      const records = new Map<string, { model: DataModel; record_id: string; fields: string[] }>();
      for (const item of targets) {
        const model = definition.models.find((candidate) => candidate.id === item.model_id);
        if (model === undefined) continue;
        const key = `${model.id}:${item.record_id}`;
        const entry = records.get(key) ?? { model, record_id: item.record_id, fields: [] };
        if (item.field_id !== undefined && !entry.fields.includes(item.field_id))
          entry.fields.push(item.field_id);
        records.set(key, entry);
      }
      const named = [...records.values()].slice(0, 50);
      const shown = await Promise.all(
        named.map(async ({ model, record_id, fields }) => {
          const title = titleFieldOf(model);
          const [row] = await modelOps(model).list({
            asOf: session.as_of,
            work: { sessionId: session.id },
            includePendingDrafts: true,
            where: [{ field: "id", op: "eq", value: record_id }],
            select: ["id", ...(title === undefined ? [] : [title.name])],
            limit: 1,
          });
          if (row === undefined) return [];
          const name = title === undefined ? undefined : row[title.name];
          return [
            {
              model: modelLabel(model),
              record_id,
              record:
                typeof name === "string" && name.trim() !== ""
                  ? name
                  : typeof name === "number"
                    ? String(name)
                    : `Untitled ${modelLabel(model)}`,
              ...(fields.length === 0
                ? {}
                : { columns: fields.map((fieldId) => labels.header(model.id, fieldId)) }),
            },
          ];
        }),
      );
      return {
        records: shown.flat(),
        ...(records.size > named.length ? { more_records: records.size - named.length } : {}),
      };
    };

    const column = (model: DataModel, key: string) => labels.field(model, text(args, key)).id;
    const optionalColumn = (model: DataModel, key: string) =>
      args[key] === undefined ? undefined : column(model, key);
    // A unit's settings from the call's arguments: labels resolve to ids, and
    // the shared unit schemas check the shape; the unit itself reports a
    // chart, KPI or graph it cannot draw.
    const unitConfig = (kind: string, model: DataModel | null): Record<string, WorkJson> => {
      const settings = (
        schemaFor: { safeParse(value: unknown): { success: boolean } },
        value: Record<string, unknown>,
      ) => {
        if (!schemaFor.safeParse(value).success) fail(`the ${kind} settings are incomplete`);
        return value as Record<string, WorkJson>;
      };
      if (kind === "note")
        return settings(noteConfigSchema, { text: optionalText(args, "text") ?? "" });
      if (model === null) return fail(`a ${kind} needs a model`);
      if (kind === "grid") return { model_id: model.id };
      if (kind === "graph") {
        const relation = labels.field(model, text(args, "relation"));
        // The graph follows one record's single relation, as the canvas draws it.
        if (relation.type !== "relation" || typeof relation.target_model !== "string")
          fail(`${fieldHeader(relation)} is not a single relation column`);
        return {
          model_id: model.id,
          field_id: relation.id,
          ...(args.record_id === undefined ? {} : { record_id: text(args, "record_id") }),
        };
      }
      if (kind === "kpi")
        return settings(kpiConfigSchema, {
          model_id: model.id,
          metrics: list(args, "kpis").map((item) => {
            const kpi = record(item, "kpi");
            const fn = text(kpi, "fn");
            return {
              fn,
              ...(fn === "count" ? {} : { field_id: labels.field(model, text(kpi, "column")).id }),
            };
          }),
        });
      if (kind !== "chart") return fail(`unknown unit kind ${kind}`);
      const chart = optionalText(args, "chart") ?? "breakdown";
      if (chart === "range")
        return settings(chartConfigSchema, {
          kind: "range",
          model_id: model.id,
          group_by: column(model, "group_by"),
          value: column(model, "value"),
          low: column(model, "low"),
          high: column(model, "high"),
          ...(args.target === undefined ? {} : { target: column(model, "target") }),
        });
      const metric = optionalText(args, "metric") ?? "count";
      if (!["count", "sum", "avg"].includes(metric)) fail("metric must be count, sum or avg");
      const seriesBy = optionalColumn(model, "series_by");
      return settings(chartConfigSchema, {
        kind: chart,
        model_id: model.id,
        group_by: column(model, "group_by"),
        metric:
          metric === "count" ? { fn: "count" } : { fn: metric, field_id: column(model, "measure") },
        ...(seriesBy === undefined ? {} : { series_by: seriesBy }),
      });
    };

    switch (id) {
      case "list_sessions": {
        const status = optionalText(args, "status") as "active" | "archived" | undefined;
        const sessions = await work.request({
          operation: "list",
          ...(status === undefined ? {} : { status }),
        });
        return sessions.map((session) => ({
          session_id: session.id,
          title: session.title,
          as_of: session.as_of,
          revision: session.revision,
          status: session.status,
          pinned: session.pinned,
        }));
      }
      case "create_session": {
        const title = text(args, "title").trim();
        if (title === "" || title.length > 200) fail("title must be 1 to 200 characters");
        const asOf = calendarDate(
          optionalText(args, "as_of") ?? new Date().toISOString().slice(0, 10),
        );
        const { models, layout } = newSessionLayout(
          mainModelOrder(definition).map((model) => model.id),
        );
        // Named by the call, so a retried call replays the same create.
        const sessionId = mintedId(call.conversationId, call.callId, "session");
        let created: { revision: number };
        try {
          created = await work.request({
            operation: "create",
            session_id: sessionId,
            expected_revision: 0,
            request_id: workSessionRequestId(call.conversationId, call.callId, id),
            title,
            as_of: asOf,
            scope: { models },
            layout: layout as unknown as WorkJson,
          });
        } catch (error) {
          // This call already created its session, with a request that differs
          // only by a default (a retry after UTC midnight dates it a day
          // later): answer with the session it created.
          if (toolError(error).error.code !== "idempotency_conflict") throw error;
          const existing = await header(sessionId);
          const stored = parseLayout(existing.layout);
          return {
            session_id: sessionId,
            title: existing.title,
            as_of: existing.as_of,
            revision: existing.revision,
            units: stored.ok ? stored.layout.units.map(views.unit) : [],
          };
        }
        return {
          session_id: sessionId,
          title,
          as_of: asOf,
          revision: created.revision,
          units: layout.units.map(views.unit),
        };
      }
      case "describe_workspace": {
        const sessionId = text(args, "session_id");
        return await call.context.transaction(async () => {
          const session = await header(sessionId);
          return {
            ...views.workspace(definition, session),
            selection: await selection(session),
          };
        });
      }
      case "read_entries": {
        const page = await work.request({
          operation: "entries",
          session_id: text(args, "session_id"),
          ...(args.model === undefined ? {} : { model_id: labels.model(text(args, "model")).id }),
          ...(args.source === undefined
            ? {}
            : { source: text(args, "source") as "user" | "agent" }),
          ...(args.turn_id === undefined ? {} : { turn_id: text(args, "turn_id") }),
          ...(args.after === undefined ? {} : { after: resolveTarget(args.after, "after") }),
          ...(args.limit === undefined ? {} : { limit: integerArg(args, "limit") }),
        });
        return {
          revision: page.revision,
          ...views.staged(page.entries),
          has_more: page.has_more,
          next: page.next === null ? null : views.target(page.next),
        };
      }
      case "find_records": {
        const model = labels.model(text(args, "model"));
        const sessionId = text(args, "session_id");
        const columns =
          args.columns === undefined
            ? undefined
            : list(args, "columns").map((name) => labels.field(model, String(name)));
        return await call.context.transaction(async () => {
          const session = await header(sessionId);
          const search =
            args.search === undefined
              ? {}
              : (() => {
                  const input = record(args.search, "search");
                  return {
                    search: {
                      query: text(input, "query"),
                      fields: list(input, "columns").map(
                        (name) => labels.field(model, String(name)).name,
                      ),
                    },
                  };
                })();
          const rows = await modelOps(model).list({
            asOf: session.as_of,
            work: { sessionId },
            includePendingDrafts: true,
            ...filters(model),
            ...search,
            ...(args.order_by === undefined
              ? {}
              : {
                  orderBy: list(args, "order_by").map((item) => {
                    const order = record(item, "order_by");
                    return {
                      field: labels.field(model, text(order, "column")).name,
                      direction: text(order, "direction"),
                    };
                  }),
                }),
            limit: optionalInteger(args, "limit") ?? 25,
            ...(args.offset === undefined ? {} : { offset: integerArg(args, "offset") }),
            ...(columns === undefined
              ? {}
              : { select: ["id", ...columns.map((field) => field.name)] }),
          });
          return { as_of: session.as_of, records: rows.map((row) => views.record(model, row)) };
        });
      }
      case "aggregate": {
        const model = labels.model(text(args, "model"));
        const sessionId = text(args, "session_id");
        const groups = (args.group_by === undefined ? [] : list(args, "group_by")).map((item) => {
          if (typeof item === "string") return { field: labels.field(model, item) };
          const group = record(item, "group_by");
          return {
            field: labels.field(model, text(group, "column")),
            bins: { edges: list(group, "edges").map(String) },
            ...(group.unit === undefined ? {} : { unit: record(group.unit, "unit") }),
          };
        });
        const metrics = list(args, "metrics").map((item) => {
          const metric = record(item, "metric");
          return {
            fn: text(metric, "fn"),
            ...(metric.column === undefined
              ? {}
              : { field: labels.field(model, text(metric, "column")) }),
            ...(metric.p === undefined ? {} : { p: metric.p }),
          };
        });
        return await call.context.transaction(async () => {
          const session = await header(sessionId);
          const result = await modelOps(model).aggregate({
            asOf: session.as_of,
            work: { sessionId },
            includePendingDrafts: true,
            ...filters(model),
            ...(groups.length === 0
              ? {}
              : {
                  groupBy: groups.map((group) =>
                    "bins" in group ? { ...group, field: group.field.name } : group.field.name,
                  ),
                }),
            metrics: metrics.map((metric) =>
              metric.field === undefined ? metric : { ...metric, field: metric.field.name },
            ),
          });
          return {
            as_of: result.as_of,
            group_by: groups.map((group) => fieldHeader(group.field)),
            metrics: metrics.map((metric) => ({
              fn: metric.fn,
              ...(metric.field === undefined ? {} : { column: fieldHeader(metric.field) }),
              ...(metric.p === undefined ? {} : { p: metric.p }),
            })),
            units: result.units,
            groups: result.groups.map((group) => ({
              key: group.key.map((key, index) =>
                index < groups.length ? displayDecoded(labels, groups[index]!.field, key) : key,
              ),
              metrics: group.metrics,
            })),
            total: result.total,
            ...(result.other_units === undefined ? {} : { other_units: result.other_units }),
          };
        });
      }
      case "field_options": {
        const model = labels.model(text(args, "model"));
        const field = labels.field(model, text(args, "column"));
        return {
          column: fieldHeader(field),
          type: field.type,
          options: labels
            .options(field)
            .filter((option) => option.lifecycle !== "retired")
            .map((option) => ({
              label: typeof option.label === "string" ? option.label : option.id,
              ...(Array.isArray(option.aliases) && option.aliases.length > 0
                ? { aliases: option.aliases }
                : {}),
            })),
          ...(typeof field.target_model === "string"
            ? { relates_to: labels.modelLabel(field.target_model) }
            : {}),
        };
      }
      case "record_history": {
        const model = labels.model(text(args, "model"));
        const history = await modelOps(model).history({
          id: text(args, "record_id"),
          ...(args.as_of === undefined ? {} : { asOf: text(args, "as_of") }),
          ...(args.limit === undefined ? {} : { limit: integerArg(args, "limit") }),
        });
        return history.map((entry) => views.history(model, entry));
      }
      case "propose_records":
      case "import_csv": {
        const session = await header(text(args, "session_id"));
        const rows =
          id === "import_csv"
            ? mapImportCsv(
                text(args, "csv"),
                record(args.mapping, "mapping") as Record<string, string>,
              )
            : list(args, "rows").map((value) => {
                const row = record(value, "row");
                return {
                  values: record(row.values, "values"),
                  ...(row.external_key === undefined
                    ? {}
                    : { externalKey: text(row, "external_key") }),
                };
              });
        const input = {
          model: text(args, "model"),
          asOf: String(session.as_of).slice(0, 10),
          requestId: mintedId(call.conversationId, call.callId, id),
          rows,
        };
        const prepared = prepareRecordImport(definition, input);
        return {
          persisted: false,
          proposal: prepared.input,
          next_action:
            "Paste proposal JSON into Add records or import CSV → Claude proposal on the web Canvas. Preview validates the current schema and data; only the person's Apply records or Save drafts writes records.",
        };
      }
      case "stage_changes": {
        const note =
          args.rule === undefined ? undefined : text(record(args.rule, "rule"), "description");
        return views.touched(
          await work.request({
            operation: "stage",
            ...edit(),
            changes: resolveChanges(),
            ...(note === undefined ? {} : { note }),
          }),
        );
      }
      case "unstage":
        return views.touched(
          await work.request({
            operation: "unstage",
            ...edit(),
            ...resolveTarget(args, "unstage"),
          }),
        );
      case "discard_mine":
        return views.touched(
          await work.request({ operation: "discard_source", ...edit(), source: "agent" }),
        );
      case "revert_turn":
        return views.touched(
          await work.request({
            operation: "discard_turn",
            ...edit(),
            turn_id: text(args, "turn_id"),
          }),
        );
      case "open_thread": {
        const threadId = mintedId(call.conversationId, call.callId, "thread");
        const anchor =
          args.anchor === undefined
            ? {}
            : (() => {
                const input = record(args.anchor, "anchor");
                const model = labels.model(text(input, "model"));
                return {
                  model_id: model.id,
                  record_id: text(input, "record_id"),
                  ...(input.column === undefined
                    ? {}
                    : { field_id: labels.field(model, text(input, "column")).id }),
                };
              })();
        const result = await work.request({
          operation: "thread_open",
          ...guard(),
          thread_id: threadId,
          anchor,
        });
        return {
          revision: result.revision,
          thread_id: threadId,
          thread: views.thread(result.thread),
        };
      }
      case "propose_changes": {
        const result = await work.request({
          operation: "propose",
          ...guard(),
          thread_id: text(args, "thread_id"),
          changes: resolveChanges(),
        });
        return { revision: result.revision, proposal: views.proposal(result.proposal) };
      }
      case "reply": {
        const result = await work.request({
          operation: "thread_reply",
          ...guard(),
          thread_id: text(args, "thread_id"),
          message: text(args, "message"),
        });
        return { revision: result.revision, message: result.message };
      }
      case "dismiss_proposal":
        return await work.request({
          operation: "dismiss",
          ...guard(),
          thread_id: text(args, "thread_id"),
        });
      case "create_rule": {
        const ruleId = mintedId(call.conversationId, call.callId, "rule");
        const model = labels.model(text(args, "model"));
        const result = await work.request({
          operation: "rule_create",
          ...guard(),
          rule_id: ruleId,
          rule: {
            model_id: model.id,
            field_id: labels.field(model, text(args, "column")).id,
            value: resolveExpression(labels, model, args.value),
            ...(args.condition === undefined
              ? {}
              : { condition: resolveExpression(labels, model, args.condition) }),
            ...(args.parameters === undefined
              ? {}
              : { parameters: record(args.parameters, "parameters") as never }),
            ...(args.description === undefined ? {} : { description: text(args, "description") }),
          },
        });
        return { rule_id: ruleId, ...views.rule(result) };
      }
      case "set_rule_parameters":
        return views.rule(
          await work.request({
            operation: "rule_parameters",
            ...guard(),
            rule_id: text(args, "rule_id"),
            parameters: record(args.parameters, "parameters") as never,
          }),
        );
      case "remove_rule":
        return views.touched(
          await work.request({
            operation: "rule_remove",
            ...guard(),
            rule_id: text(args, "rule_id"),
          }),
        );
      case "resolve_thread":
        return await work.request({
          operation: "thread_resolve",
          ...guard(),
          thread_id: text(args, "thread_id"),
        });
      case "request_save": {
        const reason = text(args, "reason").trim();
        if (reason === "" || reason.length > 200) fail("reason must be 1 to 200 characters");
        const result = await work.request({
          operation: "save_request",
          ...guard(),
          thread_id: mintedId(call.conversationId, call.callId, "save_request"),
          reason,
        });
        return { revision: result.revision, asked: true };
      }
      case "set_as_of": {
        const asOf = text(args, "as_of");
        if (!/^\d{4}-\d{2}-\d{2}$/u.test(asOf)) fail("as_of must be a YYYY-MM-DD date");
        return await work.request({ operation: "update", ...edit(), patch: { as_of: asOf } });
      }
      case "add_unit": {
        const kind = text(args, "kind");
        if (!["grid", "chart", "graph", "note", "kpi"].includes(kind))
          fail("kind must be grid, chart, graph, note or kpi");
        const config = unitConfig(kind, kind === "note" ? null : labels.model(text(args, "model")));
        // Named by the call, so a retried call finds the unit it already added.
        const unitId = `unit-${mintedId(call.conversationId, call.callId, "unit").slice(0, 8)}`;
        const result = await arrange((layout) =>
          layout.units.some((unit) => unit.id === unitId)
            ? null
            : addUnit(layout, kind as CanvasUnit["kind"], config, unitId),
        );
        return { unit_id: unitId, revision: result.revision };
      }
      case "update_unit": {
        let updated: CanvasUnit | undefined;
        const result = await arrange((layout) => {
          const unit = unitIn(layout);
          if (unit.kind === "rule")
            throw new Error("rule_unit: a rule's card changes with set_rule_parameters");
          const model =
            unit.kind === "note"
              ? null
              : args.model === undefined
                ? (labels.modelById(String(unit.config.model_id)) ??
                  fail("the unit's model is no longer in this app"))
                : labels.model(text(args, "model"));
          // A chart keeps the header filters the person chose, on the same model
          // only (another model's columns would not resolve).
          const config = unitConfig(unit.kind, model);
          const next = {
            ...unit,
            config:
              unit.kind === "chart" &&
              unit.config.filters !== undefined &&
              model !== null &&
              unit.config.model_id === model.id
                ? { ...config, filters: unit.config.filters }
                : config,
          };
          updated = next;
          return JSON.stringify(next.config) === JSON.stringify(unit.config)
            ? null
            : { ...layout, units: layout.units.map((item) => (item.id === unit.id ? next : item)) };
        });
        return { ...views.unit(updated!), revision: result.revision };
      }
      case "move_unit": {
        const place = {
          x: optionalNumber(args, "x"),
          y: optionalNumber(args, "y"),
          w: optionalNumber(args, "w"),
          h: optionalNumber(args, "h"),
        };
        if ((place.w ?? 1) <= 0 || (place.h ?? 1) <= 0) fail("w and h must be positive");
        let moved: CanvasUnit | undefined;
        const result = await arrange((stored) => {
          // A moved unit leaves the grid: the canvas keeps every unit where it is shown.
          const layout = placedLayout(stored);
          const unit = unitIn(layout);
          moved = {
            ...unit,
            x: place.x ?? unit.x,
            y: place.y ?? unit.y,
            w: place.w ?? unit.w,
            h: place.h ?? unit.h,
          };
          const next = moved;
          return ["x", "y", "w", "h"].every((key) => next[key as "x"] === unit[key as "x"])
            ? null
            : {
                ...layout,
                mode: "free",
                units: layout.units.map((item) => (item.id === unit.id ? next : item)),
              };
        });
        return { ...views.unit(moved!), revision: result.revision };
      }
      case "remove_unit": {
        const unitId = text(args, "unit_id");
        const result = await arrange((layout) => {
          // Already gone (a retried call) changes nothing.
          if (!layout.units.some((item) => item.id === unitId)) return null;
          const unit = unitIn(layout);
          if (unit.kind === "rule")
            throw new Error("rule_unit: a rule's card goes with its rule; use remove_rule");
          return placedLayout({
            ...layout,
            units: layout.units.filter((item) => item.id !== unit.id),
          });
        });
        return { removed: unitId, revision: result.revision };
      }
      case "arrange_layout": {
        const mode = text(args, "mode") as ArrangeInput["mode"];
        if (!["grid", "free", "auto"].includes(mode)) fail("mode must be grid, free or auto");
        const input: ArrangeInput = {
          mode,
          ...(args.columns === undefined ? {} : { columns: integerArg(args, "columns") }),
          ...(args.gap === undefined ? {} : { gap: optionalNumber(args, "gap")! }),
          ...(args.units === undefined
            ? {}
            : {
                units: list(args, "units").map((item) => {
                  const unit = record(item, "unit");
                  const number = (key: string) => optionalNumber(unit, key);
                  return {
                    unit_id: text(unit, "unit_id"),
                    ...Object.fromEntries(
                      (["span", "order", "x", "y", "w", "h"] as const)
                        .map((key) => [key, number(key)] as const)
                        .filter(([, value]) => value !== undefined),
                    ),
                  };
                }),
              }),
        };
        let arranged: CanvasLayout | undefined;
        const result = await arrange((layout) => {
          try {
            arranged = arrangeLayout(layout, input);
          } catch (error) {
            if (error instanceof ArrangeError) fail(error.message);
            throw error;
          }
          return JSON.stringify(arranged) === JSON.stringify(layout) ? null : arranged;
        });
        return {
          mode: arranged!.mode ?? "grid",
          units: arranged!.units.map(views.unit),
          revision: result.revision,
        };
      }
    }
  }

  return {
    tools: workSessionToolSpecs,
    labels,
    /** Runs one tool call; failures return as tool errors, never throw. */
    async call(
      tool: string,
      input: unknown,
      call: WorkSessionToolCall,
    ): Promise<WorkSessionToolResult> {
      const spec = specs.get(tool as WorkSessionToolId);
      if (spec === undefined)
        return { ok: false, error: { code: "unknown_tool", message: `unknown tool ${tool}` } };
      try {
        const args = input === undefined ? {} : record(input, "input");
        return { ok: true, data: await run(spec.id, args, call) };
      } catch (error) {
        return toolError(error);
      }
    },
  };
}
export type WorkSessionToolCore = ReturnType<typeof createWorkSessionToolCore>;

function createViews(labels: LabelIndex) {
  const field = (modelId: string, fieldId: string) =>
    labels.fieldById(labels.modelById(modelId), fieldId);
  // A unit as the agent names things: models and columns by label, ids only for records and rules.
  const unit = (value: CanvasUnit) => {
    const config = value.config;
    const modelId = typeof config.model_id === "string" ? config.model_id : undefined;
    const header = (key: unknown) =>
      modelId === undefined || typeof key !== "string" ? undefined : labels.header(modelId, key);
    const metric =
      config.metric !== null && typeof config.metric === "object" && !Array.isArray(config.metric)
        ? (config.metric as Record<string, unknown>)
        : undefined;
    const described: Record<string, unknown> =
      value.kind === "rule"
        ? { rule_id: config.rule_id }
        : {
            ...(modelId === undefined ? {} : { model: labels.modelLabel(modelId) }),
            ...(value.kind === "chart"
              ? {
                  chart:
                    config.kind === undefined || config.kind === "bar" ? "breakdown" : config.kind,
                  group_by: header(config.group_by),
                  ...(config.series_by === undefined
                    ? {}
                    : { series_by: header(config.series_by) }),
                  ...(metric === undefined ? {} : { metric: metric.fn }),
                  ...(metric?.field_id === undefined ? {} : { measure: header(metric.field_id) }),
                  ...Object.fromEntries(
                    (["value", "low", "target", "high"] as const)
                      .filter((key) => config[key] !== undefined)
                      .map((key) => [key, header(config[key])]),
                  ),
                }
              : {}),
            ...(value.kind === "note" ? { text: config.text } : {}),
            ...(value.kind === "kpi" && Array.isArray(config.metrics)
              ? {
                  kpis: config.metrics.map((item) => {
                    const kpi = item as { fn?: unknown; field_id?: unknown };
                    return {
                      fn: kpi.fn,
                      ...(kpi.field_id === undefined ? {} : { column: header(kpi.field_id) }),
                    };
                  }),
                }
              : {}),
            ...(value.kind === "graph"
              ? {
                  relation: header(config.field_id),
                  ...(config.record_id === undefined ? {} : { record_id: config.record_id }),
                }
              : {}),
          };
    return {
      unit_id: value.id,
      kind: value.kind,
      ...described,
      x: value.x,
      y: value.y,
      w: value.w,
      h: value.h,
      ...(value.span === undefined ? {} : { span: value.span }),
    };
  };
  const target = (value: WorkTarget) => ({
    model: labels.modelLabel(value.model_id),
    record_id: value.record_id,
    column: labels.header(value.model_id, value.field_id),
  });
  const entry = (value: WorkChange) => {
    const owner = field(value.model_id, value.field_id);
    return {
      ...target(value),
      value: displayWire(labels, owner, value.value),
      baseline: displayWire(labels, owner, value.baseline),
      source: value.source,
      author_kind: value.author_kind,
      ...(value.turn_id === undefined ? {} : { turn_id: value.turn_id }),
      ...(value.rule_id === undefined ? {} : { rule_id: value.rule_id }),
      ...(value.thread_id === undefined ? {} : { thread_id: value.thread_id }),
      ...(value.note === undefined ? {} : { rule_note: value.note }),
      ...(value.replaced === undefined
        ? {}
        : {
            replaced: {
              value: displayWire(labels, owner, value.replaced.value),
              author_kind: value.replaced.author_kind,
            },
          }),
      ...(value.stale === undefined ? {} : { stale: value.stale }),
      ...(value.gone === undefined || value.gone === null ? {} : { gone: value.gone }),
      ...(value.current_value === undefined
        ? {}
        : { current_value: displayWire(labels, owner, value.current_value) }),
    };
  };
  const staged = (values: readonly WorkChange[]) => ({ entries: values.map(entry) });
  const changes = (value: unknown) =>
    Array.isArray(value)
      ? value.map((change: WorkChange) => ({
          ...target(change),
          value: displayWire(labels, field(change.model_id, change.field_id), change.value),
          ...(change.gone ? { gone: change.gone } : {}),
        }))
      : [];
  const proposal = (value: unknown) => {
    if (value === null || typeof value !== "object") return null;
    const stored = value as Record<string, unknown>;
    return { author_kind: stored.author_kind, changes: changes(stored.changes) };
  };
  const anchor = (value: unknown) => {
    if (value === null || typeof value !== "object") return null;
    const stored = value as Record<string, unknown>;
    if (typeof stored.model_id !== "string" || typeof stored.record_id !== "string") return null;
    return {
      model: labels.modelLabel(stored.model_id),
      record_id: stored.record_id,
      ...(typeof stored.field_id === "string"
        ? { column: labels.header(stored.model_id, stored.field_id) }
        : {}),
      ...(typeof stored.gone === "string" ? { gone: stored.gone } : {}),
    };
  };
  const thread = (value: unknown) => {
    if (value === null || typeof value !== "object") return null;
    const stored = value as Record<string, unknown>;
    return {
      anchor: anchor(stored.anchor),
      resolved: stored.resolved === true,
      messages: Array.isArray(stored.messages) ? stored.messages : [],
      proposal: proposal(stored.proposal),
    };
  };
  const touched = (value: { revision: number; entries: WorkChange[]; removed: WorkTarget[] }) => ({
    revision: value.revision,
    ...staged(value.entries),
    removed: value.removed.map(target),
  });
  const ruleView = (id: string, value: unknown) => {
    if (value === null || typeof value !== "object") return null;
    const stored = value as Record<string, unknown>;
    const modelId = String(stored.model_id);
    return {
      rule_id: id,
      model: labels.modelLabel(modelId),
      column: labels.header(modelId, String(stored.field_id)),
      ...(typeof stored.description === "string" ? { description: stored.description } : {}),
      value: stored.value,
      ...(stored.condition === undefined ? {} : { condition: stored.condition }),
      parameters: stored.parameters ?? {},
      author_kind: stored.author_kind,
    };
  };
  return {
    target,
    entry,
    staged,
    thread,
    proposal,
    touched,
    rule: (value: {
      revision: number;
      entries: WorkChange[];
      removed: WorkTarget[];
      rule: unknown;
      overlaps: { rule_id: string; records: number }[];
    }) => ({
      ...touched(value),
      rule:
        value.rule === null
          ? null
          : ruleView(String((value.rule as { id?: unknown }).id ?? ""), value.rule),
      overlaps: value.overlaps,
    }),
    record: (model: DataModel, row: Record<string, unknown>) => ({
      record_id: row.id,
      values: Object.fromEntries(
        model.fields
          .filter((item: DataField) => !item.aliasOf && Object.hasOwn(row, item.name))
          .map((item: DataField) => [
            fieldHeader(item),
            displayDecoded(labels, item, row[item.name]),
          ]),
      ),
    }),
    history: (model: DataModel, value: Record<string, unknown>) => {
      const owner = labels.fieldById(model, String(value.field_id));
      return {
        column: owner === undefined ? value.field_id : fieldHeader(owner),
        value: displayWire(labels, owner, value.value ?? null),
        effective_start: value.effective_start,
        ...(value.effective_end === undefined ? {} : { effective_end: value.effective_end }),
        stage: value.stage,
        change_set_id: value.change_set_id,
        ...(value.actor_id === undefined ? {} : { actor_id: value.actor_id }),
        source_kind: value.source_kind,
        ...(value.withheld === true ? { withheld: true } : {}),
      };
    },
    unit,
    workspace: (
      definition: DataDefinition,
      session: {
        id: string;
        title: string;
        as_of: string;
        revision: number;
        status: string;
        layout: unknown;
        rules: Record<string, unknown>;
        threads: Record<string, unknown>;
      },
    ) => ({
      session: {
        session_id: session.id,
        title: session.title,
        as_of: session.as_of,
        revision: session.revision,
        status: session.status,
      },
      models: definition.models.map((model) => ({
        model: modelLabel(model),
        columns: model.fields
          .filter((item) => item.lifecycle !== "retired" && !item.aliasOf)
          .map((item) => ({
            header: fieldHeader(item),
            type: item.type,
            ...(item.required ? { required: true } : {}),
            ...(item.readOnly ? { read_only: true } : {}),
            ...(item.type === "enum"
              ? {
                  options: labels
                    .options(item)
                    .filter((option) => option.lifecycle !== "retired")
                    .map((option) => (typeof option.label === "string" ? option.label : option.id)),
                }
              : {}),
            ...(typeof item.target_model === "string"
              ? { relates_to: labels.modelLabel(item.target_model) }
              : {}),
          })),
      })),
      ...(() => {
        const parsed = parseLayout(session.layout);
        return parsed.ok
          ? {
              layout_mode: parsed.layout.mode ?? "grid",
              units: placedLayout(parsed.layout).units.map(unit),
            }
          : { units: [], layout_error: parsed.error };
      })(),
      rules: Object.entries(session.rules).map(([id, rule]) => ruleView(id, rule)),
      open_threads: Object.entries(session.threads)
        .filter(
          ([, value]) =>
            (value as { resolved?: unknown } | null)?.resolved !== true &&
            (value as { kind?: unknown } | null)?.kind !== "save_request",
        )
        .map(([id, value]) => ({ thread_id: id, ...thread(value) })),
      // The open request to Save you made, if the person has not answered it.
      save_request: (() => {
        const open = Object.values(session.threads).find(
          (value) =>
            (value as { kind?: unknown } | null)?.kind === "save_request" &&
            (value as { resolved?: unknown }).resolved !== true,
        ) as { reason?: unknown; revision?: unknown } | undefined;
        return open === undefined
          ? null
          : {
              reason: open.reason,
              asked_at_revision: open.revision,
              changed_since: typeof open.revision === "number" && session.revision > open.revision,
            };
      })(),
    }),
  };
}
