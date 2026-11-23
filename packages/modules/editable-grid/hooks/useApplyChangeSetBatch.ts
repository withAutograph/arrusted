import { useCallback, useRef, useState } from "react";

import {
  isSingleFlightBlocked,
  type ApplyChangeSetPayload,
  type ApplyState,
} from "./useApplyChangeSet";
import { extractAppliedChangeSetId } from "../apply-result";

export type ApplyChangeSetBatchItem = {
  key: string;
  payload: ApplyChangeSetPayload;
};

export type ApplyChangeSetBatchSuccess = {
  key: string;
  payload: ApplyChangeSetPayload;
  appliedChangeSetId: number;
};

export type ApplyChangeSetBatchFailure = {
  key: string;
  payload: ApplyChangeSetPayload;
  error: string;
};

export type ApplyChangeSetBatchResult =
  | {
      ok: true;
      applied: ApplyChangeSetBatchSuccess[];
    }
  | {
      ok: false;
      applied: ApplyChangeSetBatchSuccess[];
      failure: ApplyChangeSetBatchFailure;
    };

export type ApplyChangeSetBatchState = {
  running: boolean;
  applyBatch: (items: readonly ApplyChangeSetBatchItem[]) => Promise<ApplyChangeSetBatchResult>;
};

export function useApplyChangeSetBatch(
  applyClient: Pick<ApplyState, "apply">,
): ApplyChangeSetBatchState {
  const inFlightRef = useRef(false);
  const [running, setRunning] = useState(false);

  const applyBatch = useCallback(
    async (items: readonly ApplyChangeSetBatchItem[]): Promise<ApplyChangeSetBatchResult> => {
      if (items.length === 0) {
        return { ok: true, applied: [] };
      }
      if (inFlightRef.current) {
        return blockedBatchResult(items[0]!);
      }
      inFlightRef.current = true;
      setRunning(true);
      const applied: ApplyChangeSetBatchSuccess[] = [];
      try {
        for (const item of items) {
          let result: unknown;
          try {
            result = await applyClient.apply(item.payload);
          } catch (error) {
            return {
              ok: false,
              applied,
              failure: {
                key: item.key,
                payload: item.payload,
                error: errorMessage(error),
              },
            };
          }
          if (isSingleFlightBlocked(result)) {
            return {
              ok: false,
              applied,
              failure: {
                key: item.key,
                payload: item.payload,
                error: "Another save is already in flight. Wait for it to finish, then retry.",
              },
            };
          }
          const appliedChangeSetId = extractAppliedChangeSetId(result);
          if (appliedChangeSetId == null) {
            return {
              ok: false,
              applied,
              failure: {
                key: item.key,
                payload: item.payload,
                error: "Server response did not include a change_set id.",
              },
            };
          }
          applied.push({
            key: item.key,
            payload: item.payload,
            appliedChangeSetId,
          });
        }
        return { ok: true, applied };
      } finally {
        inFlightRef.current = false;
        setRunning(false);
      }
    },
    [applyClient],
  );

  return { running, applyBatch };
}

function blockedBatchResult(first: ApplyChangeSetBatchItem): ApplyChangeSetBatchResult {
  return {
    ok: false,
    applied: [],
    failure: {
      key: first.key,
      payload: first.payload,
      error: "Another save is already in flight. Wait for it to finish, then retry.",
    },
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === "object") {
    const candidate = error as { message?: unknown };
    if (typeof candidate.message === "string" && candidate.message.length > 0) {
      return candidate.message;
    }
  }
  if (typeof error === "string") return error;
  return "Save failed.";
}
