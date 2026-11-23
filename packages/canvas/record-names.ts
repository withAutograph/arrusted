import { useEffect, useMemo, useState } from "react";

import type { DataDefinition } from "@autograph/generated-app-runtime/data";
import { createLabelIndex } from "@autograph/work-session-tools/labels";

import type { CanvasClient } from "./client";
import { threadAnchor } from "./comment-mode";
import {
  recordTitle,
  relationKey,
  relationKeyFilter,
  relationKeyId,
  type RelationKey,
} from "./record-values";
import type { CanvasThread } from "./threads";
import type { CanvasSession } from "./use-canvas-session";

/** A record to name: its model and its key. */
export type RecordRef = readonly [modelId: string, key: RelationKey];

/**
 * The records threads name: what they are anchored to, the records their
 * proposals change and the records those proposed values link to.
 */
export function threadRefs(
  definition: DataDefinition,
  threads: readonly CanvasThread[],
): RecordRef[] {
  return threads.flatMap((thread) => {
    const refs: RecordRef[] = [];
    const anchor = threadAnchor(thread);
    if (anchor.model_id !== undefined && anchor.record_id !== undefined)
      refs.push([anchor.model_id, { type: "record_id", value: anchor.record_id }]);
    for (const change of thread.proposal?.changes ?? []) {
      refs.push([change.model_id, { type: "record_id", value: change.record_id }]);
      const target = definition.models
        .find((model) => model.id === change.model_id)
        ?.fields.find((field) => field.id === change.field_id)?.target_model;
      const key = change.value?.type === "relation" ? relationKey(change.value.value) : null;
      if (typeof target === "string" && key !== null) refs.push([target, key]);
    }
    return refs;
  });
}

/**
 * Names of records by their title column, read over the session, e.g. for
 * the thread popover, the Comments pane and draft cards. With `overlay`
 * false they are read from published data at the session's as-of instead,
 * so a review card is never named by a value the reviewer has only staged.
 * A record the read does not return has no name here.
 */
export function useRecordNames(
  client: CanvasClient,
  session: Pick<CanvasSession, "session" | "generation">,
  refs: readonly RecordRef[],
  { overlay = true }: { overlay?: boolean } = {},
) {
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  /** Keys the last completed read covered: named or not, they are no longer loading. */
  const [settled, setSettled] = useState<ReadonlySet<string>>(new Set());
  const wanted = JSON.stringify([...new Set(refs.map((ref) => JSON.stringify(ref)))].toSorted());
  const sessionId = session.session?.id ?? null;
  const asOf = session.session?.as_of ?? null;
  useEffect(() => {
    if (sessionId === null || asOf === null) return;
    const parsed = (JSON.parse(wanted) as string[]).map(
      (ref) => JSON.parse(ref) as [string, RelationKey],
    );
    if (parsed.length === 0) return;
    let live = true;
    const labels = createLabelIndex(client.definition);
    void Promise.all(
      parsed.map(async ([modelId, key]): Promise<[string, string] | null> => {
        const model = labels.modelById(modelId);
        if (model === undefined) return null;
        try {
          const [found] = await client.data.list(modelId, {
            asOf,
            ...(overlay ? { work: { sessionId } } : {}),
            where: [relationKeyFilter(key)],
            limit: 1,
          });
          return found === undefined
            ? null
            : [`${modelId}:${relationKeyId(key)}`, recordTitle(model, found)];
        } catch {
          return null;
        }
      }),
    ).then((found) => {
      if (!live) return;
      setNames(new Map(found.filter((item) => item !== null)));
      setSettled(new Set(parsed.map(([modelId, key]) => `${modelId}:${relationKeyId(key)}`)));
    });
    return () => {
      live = false;
    };
  }, [client, sessionId, asOf, wanted, overlay, session.generation]);
  return useMemo(
    () =>
      Object.assign(
        (modelId: string, value: string, type: RelationKey["type"] = "record_id") =>
          names.get(`${modelId}:${relationKeyId({ type, value })}`),
        {
          settled: (modelId: string, value: string, type: RelationKey["type"] = "record_id") =>
            settled.has(`${modelId}:${relationKeyId({ type, value })}`),
        },
      ),
    [names, settled],
  );
}
