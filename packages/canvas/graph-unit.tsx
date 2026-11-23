import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { DataDefinition, DataField, DataModel } from "@autograph/generated-app-runtime/data";
import { Button } from "@autograph/components";
import { RelationGraph, type RelationGraphGroup, type RelationGraphItem } from "@modules/org-chart";
import { createLabelIndex, fieldHeader, modelLabel } from "@autograph/work-session-tools/labels";
import { z } from "zod";

import { failureMessage, type CanvasClient, type CanvasRecord } from "./client";
import {
  relationKey,
  relationKeyFilter,
  relationKeyId,
  titleField,
  type RelationKey,
} from "./record-values";
import { useCanvasSelection, type SelectionStore } from "./selection";
import type { UnitSession } from "./use-canvas-session";

/**
 * A graph unit's config: one relation column of a model, and optionally the
 * record to centre on first. Without one, the graph centres on the record
 * the relation names most often among the first 100 records.
 */
export const graphSpecSchema = z.strictObject({
  model_id: z.string().min(1),
  field_id: z.string().min(1),
  record_id: z.string().min(1).optional(),
});
export type GraphSpec = z.infer<typeof graphSpecSchema>;

type ResolvedGraph = { spec: GraphSpec; model: DataModel; relation: DataField; target: DataModel };

/** The spec in a unit's config, resolved, or why it cannot be drawn. */
export function resolveGraphSpec(
  definition: DataDefinition,
  config: unknown,
): { ok: true; graph: ResolvedGraph } | { ok: false; error: string } {
  const parsed = graphSpecSchema.safeParse(config);
  if (!parsed.success) return { ok: false, error: "Its settings are incomplete or not valid." };
  const labels = createLabelIndex(definition);
  const model = labels.modelById(parsed.data.model_id);
  if (model === undefined) return { ok: false, error: "This graph's table is not in this app." };
  const relation = labels.fieldById(model, parsed.data.field_id);
  const target =
    typeof relation?.target_model === "string"
      ? labels.modelById(relation.target_model)
      : undefined;
  if (relation === undefined || relation.type !== "relation" || target === undefined)
    return {
      ok: false,
      error: `The column this graph follows is no longer in ${modelLabel(model)}.`,
    };
  return { ok: true, graph: { spec: parsed.data, model, relation, target } };
}

/** A graph unit's title, by column header: "Person by Manager". */
export function graphUnitTitle(client: CanvasClient, config: unknown): string {
  const resolved = resolveGraphSpec(client.definition, config);
  return resolved.ok
    ? `${modelLabel(resolved.graph.model)} by ${fieldHeader(resolved.graph.relation)}`
    : "Graph";
}

export type GraphUnitProps = {
  client: CanvasClient;
  /** The unit's id in the layout. */
  unitId: string;
  /** The unit's config: a graph spec (see `graphSpecSchema`). */
  config: unknown;
  /** The canvas session (`useCanvasSession`); a new revision re-reads. */
  session: UnitSession;
  selection: SelectionStore;
};

/**
 * The record the graph is centred on, and which side of the relation it is.
 * `key` is the relation key a target record was reached by: what the relation stores for it.
 */
type Centre = { model_id: string; record_id: string; key?: RelationKey };
type Neighbourhood = {
  centre: { name: string };
  left: RelationGraphGroup[];
  right: RelationGraphGroup[];
  /** Each card's record and model, by card id. */
  records: Map<string, Centre>;
};
type Read =
  | { status: "loading" }
  | { status: "empty" }
  | { status: "error"; message: string }
  | { status: "ready"; centre: Centre; view: Neighbourhood };

const PAGE = 100;

/**
 * A graph unit: `RelationGraph` over one relation of a model, on the unit's
 * plain card. The centre record sits in the middle, what its relation names
 * on the left, and the records whose relation names it on the right. Records
 * are named by their name column. Selecting a card centres the graph on it
 * and sets the canvas selection to that record, as a value of the relation,
 * so the canvas can filter other units by it.
 */
export function GraphUnit({ client, unitId, config, session, selection: store }: GraphUnitProps) {
  const { definition } = client;
  const resolved = useMemo(() => resolveGraphSpec(definition, config), [definition, config]);
  const { selection, select, whereFor } = useCanvasSelection(store);
  // The filter other units' selections set on the graph's model, as a stable key.
  const whereKey = JSON.stringify(resolved.ok ? [whereFor(unitId, resolved.graph.model.id)] : []);
  // Navigation belongs to the configuration it happened under; a new one starts fresh.
  const configKey = JSON.stringify(config);
  const [navigated, setNavigated] = useState<{ configKey: string; centre: Centre } | null>(null);
  const centre = navigated?.configKey === configKey ? navigated.centre : null;
  const [read, setRead] = useState<Read>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  const sessionId = session.session?.id ?? null;
  const asOf = session.session?.as_of ?? null;
  const revision = session.revision;
  const generation = session.generation;

  useEffect(() => {
    if (!resolved.ok || sessionId === null || asOf === null) return;
    const { graph } = resolved;
    let live = true;
    const scope = { asOf, work: { sessionId } };
    // Another unit's selection filters the records listed; a record opened by id is always shown.
    const [modelWhere = []] = JSON.parse(whereKey) as ReturnType<typeof whereFor>[];
    const nameOf = (model: DataModel, record: CanvasRecord | undefined) => {
      const field = titleField(model);
      const value = field === undefined ? undefined : record?.[field.name];
      return typeof value === "string" && value.trim() !== ""
        ? value
        : `Unnamed ${modelLabel(model)}`;
    };
    // Relations hold a record id or an external key; each reads by its own key type.
    const byKey = async (model: DataModel, key: RelationKey) =>
      (
        await client.data.list(model.id, { ...scope, where: [relationKeyFilter(key)], limit: 1 })
      )[0];
    const relatedKey = (record: CanvasRecord | undefined) =>
      relationKey(record?.[graph.relation.name]);
    void (async (): Promise<Read> => {
      let at = centre;
      if (at === null) {
        // First open: the configured record, else the one the relation names most.
        if (graph.spec.record_id !== undefined)
          at = { model_id: graph.model.id, record_id: graph.spec.record_id };
        else {
          const rows = await client.data.list(graph.model.id, {
            ...scope,
            where: modelWhere,
            limit: PAGE,
          });
          const counts = new Map<string, { key: RelationKey; count: number }>();
          for (const row of rows) {
            const key = relatedKey(row);
            if (key === null) continue;
            const seen = counts.get(relationKeyId(key));
            counts.set(relationKeyId(key), { key, count: (seen?.count ?? 0) + 1 });
          }
          const top = [...counts.values()].toSorted((a, b) => b.count - a.count)[0];
          const named = top === undefined ? undefined : await byKey(graph.target, top.key);
          if (top !== undefined && named !== undefined)
            at = { model_id: graph.target.id, record_id: named.id, key: top.key };
          else if (rows[0] !== undefined) at = { model_id: graph.model.id, record_id: rows[0].id };
          else return { status: "empty" };
        }
      }
      const centreModel = at.model_id === graph.model.id ? graph.model : graph.target;
      const record = await byKey(centreModel, { type: "record_id", value: at.record_id });
      if (record === undefined) return { status: "empty" };
      const records = new Map<string, Centre>();
      const header = fieldHeader(graph.relation);
      const left: RelationGraphGroup[] = [];
      const right: RelationGraphGroup[] = [];
      if (at.model_id === graph.model.id) {
        const key = relatedKey(record);
        const related = key === null ? undefined : await byKey(graph.target, key);
        if (key !== null && related !== undefined) {
          records.set(`left:${related.id}`, {
            model_id: graph.target.id,
            record_id: related.id,
            key,
          });
          left.push({
            id: "left",
            items: [{ id: related.id, caption: header, primary: nameOf(graph.target, related) }],
          });
        }
      }
      if (at.model_id === graph.target.id) {
        const name = titleField(graph.model);
        // The records whose relation names the centre by its id or by its external key.
        const keys: RelationKey[] = [{ type: "record_id", value: record.id }];
        if (typeof record.externalKey === "string")
          keys.push({ type: "external_key", value: record.externalKey });
        const found = await Promise.all(
          keys.map((key) =>
            client.data.list(graph.model.id, {
              ...scope,
              where: [...modelWhere, { field: graph.relation.name, op: "eq", value: key.value }],
              ...(name === undefined
                ? {}
                : { orderBy: [{ field: name.name, direction: "asc" as const }] }),
              // The kernel's largest page; a full page may have more.
              limit: PAGE,
            }),
          ),
        );
        // On a relation to its own model, a record is named the way it names the centre.
        const ownKey = (row: CanvasRecord, type: RelationKey["type"]): RelationKey | undefined =>
          type === "record_id"
            ? { type, value: row.id }
            : typeof row.externalKey === "string"
              ? { type, value: row.externalKey }
              : undefined;
        const naming = found.flatMap((rows, index) =>
          rows
            .filter((row) => {
              const key = relatedKey(row);
              return key?.type === keys[index]!.type && key.value === keys[index]!.value;
            })
            .map((row) => ({ row, key: ownKey(row, keys[index]!.type) })),
        );
        const more = naming.length > PAGE || found.some((rows) => rows.length >= PAGE);
        const items: RelationGraphItem[] = naming
          .map(({ row, key }) => ({ id: row.id, primary: nameOf(graph.model, row), key }))
          .toSorted((a, b) => a.primary.localeCompare(b.primary))
          .slice(0, PAGE)
          .map(({ key, ...item }) => {
            records.set(`right:${item.id}`, {
              model_id: graph.model.id,
              record_id: item.id,
              ...(key === undefined ? {} : { key }),
            });
            return item;
          });
        if (items.length > 0)
          right.push({
            id: "right",
            items,
            frame: {
              caption: `${header}: ${nameOf(centreModel, record)}${more ? ` (first ${PAGE} shown)` : ""}`,
            },
          });
      }
      return {
        status: "ready",
        centre: at,
        view: {
          centre: { name: nameOf(centreModel, record) },
          left,
          right,
          records,
        },
      };
    })().then(
      (next) => {
        if (live) setRead(next);
      },
      (error: unknown) => {
        if (!live) return;
        setRead({
          status: "error",
          message: failureMessage(error, "The graph could not be read."),
        });
      },
    );
    return () => {
      live = false;
    };
  }, [client, resolved, sessionId, asOf, revision, generation, centre, attempt, whereKey]);

  if (!resolved.ok)
    return <GraphMessage alert>This graph cannot be drawn. {resolved.error}</GraphMessage>;
  const { graph } = resolved;
  if (read.status === "error")
    return (
      <GraphMessage alert>
        <span>This graph could not be read: {read.message}</span>
        <Button intent="secondary" size="xs" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </Button>
      </GraphMessage>
    );
  if (read.status === "empty")
    return <GraphMessage>No {modelLabel(graph.model)} records to show.</GraphMessage>;
  if (read.status === "loading") return <GraphMessage>Loading graph…</GraphMessage>;

  const { view } = read;
  const selected =
    selection?.kind === "nodes" &&
    selection.unit_id === unitId &&
    selection.record_ids.length === 1 &&
    selection.record_ids[0] === read.centre.record_id;

  const onSelect = (item: RelationGraphItem, group: RelationGraphGroup) => {
    const next = view.records.get(`${group.id}:${item.id}`);
    if (next === undefined) return;
    setNavigated({ configKey, centre: next });
    // A record of the relation's target is a value of the relation: one can filter by it.
    select({
      kind: "nodes",
      unit_id: unitId,
      model_id: graph.model.id,
      record_ids: [next.record_id],
      ...(next.model_id === graph.target.id
        ? { field_id: graph.relation.id, ...(next.key === undefined ? {} : { key: next.key }) }
        : {}),
    });
  };

  return (
    <div className="relative flex h-full min-h-[var(--space-0)] flex-col" data-graph-unit={unitId}>
      <div className="flex min-h-[var(--space-0)] flex-1">
        <RelationGraph
          centre={{ primary: view.centre.name }}
          centreKey={`${read.centre.model_id}:${read.centre.record_id}`}
          left={view.left}
          right={view.right}
          onSelect={onSelect}
          fitPaddingPx={32}
        />
      </div>
      {selected ? (
        // Over the graph's top edge (its zoom controls sit at the bottom), not
        // below it: a selection never resizes the graph,
        // which would re-fit (move) every card on each click.
        <div
          data-graph-selected
          className="absolute inset-x-[var(--space-0)] top-[var(--space-0)] z-[1] flex items-center gap-[var(--space-2)] border-b bg-[var(--color-bg-surface)] border-[var(--color-border-subtle)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-caption)] text-[var(--color-text-secondary)]"
        >
          <span>
            Selected:{" "}
            <span className="font-[var(--font-weight-medium)] text-[var(--color-text-primary)]">
              {view.centre.name}
            </span>
          </span>
          <Button intent="ghost" size="xs" onClick={() => select(null)}>
            Clear
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function GraphMessage({ alert = false, children }: { alert?: boolean; children: ReactNode }) {
  return (
    <div
      role={alert ? "alert" : undefined}
      className="flex h-full flex-col items-center justify-center gap-[var(--space-3)] p-[var(--space-6)] text-center text-[length:var(--text-body)] text-[var(--color-text-muted)]"
    >
      {children}
    </div>
  );
}
