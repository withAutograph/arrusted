// useApplyChangeSet — apply orchestration over the kernel's `/api/apply`.
//
// Owns: idempotency-key reuse across retries, single-flight fence (a second
// call while one is in flight is rejected with a typed sentinel so the host
// can distinguish from real errors), error normalization to the substrate
// `ErrorEnvelope` shape.
//
// Does NOT own: reload after success — the host supplies a callback so it
// can tie reload to whatever data shape it manages (modules' `useRecordReads`
// is one option but apps may compose differently).

import { useCallback, useRef, useState } from "react";

import type { ApplyChangeSet, AppliedChangeSet, ErrorEnvelope, KernelClient } from "@contracts";
import { safeUuid } from "@engines/uuid/index";

export const APPLY_SINGLE_FLIGHT_BLOCKED: unique symbol = Symbol("APPLY_SINGLE_FLIGHT_BLOCKED");

export function isSingleFlightBlocked(value: unknown): value is typeof APPLY_SINGLE_FLIGHT_BLOCKED {
  return value === APPLY_SINGLE_FLIGHT_BLOCKED;
}

export type ApplyState = {
  submitting: boolean;
  error: ErrorEnvelope | null;
  // Stable across identical retries; changed payloads get a fresh key.
  // Cleared on success. Hosts may also provide a deterministic key for
  // durable workflows that must survive refresh outside this hook instance.
  idempotencyKey: string | null;
  apply: (
    payload: ApplyChangeSetPayload,
  ) => Promise<AppliedChangeSet | typeof APPLY_SINGLE_FLIGHT_BLOCKED>;
  resetError: () => void;
};

export type ApplyChangeSetPayload = Omit<ApplyChangeSet, "idempotency_key"> &
  Partial<Pick<ApplyChangeSet, "idempotency_key">>;

export function useApplyChangeSet(client: KernelClient | undefined): ApplyState {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ErrorEnvelope | null>(null);
  const idempotencyKeyRef = useRef<string | null>(null);
  const payloadFingerprintRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);

  const apply = useCallback(
    async (
      payload: ApplyChangeSetPayload,
    ): Promise<AppliedChangeSet | typeof APPLY_SINGLE_FLIGHT_BLOCKED> => {
      if (inFlightRef.current) return APPLY_SINGLE_FLIGHT_BLOCKED;
      inFlightRef.current = true;
      setSubmitting(true);
      setError(null);

      try {
        if (!client) throw new Error("A kernel client is required to apply a change set.");
        const callerIdempotencyKey = payload.idempotency_key ?? null;
        let idempotencyKey = callerIdempotencyKey;
        if (!idempotencyKey) {
          const payloadFingerprint = stableStringify(payload);
          if (!idempotencyKeyRef.current || payloadFingerprintRef.current !== payloadFingerprint) {
            // `safeUuid` requires `crypto.randomUUID()` so idempotency key
            // generation fails loud in unsupported browser environments.
            idempotencyKeyRef.current = safeUuid();
            payloadFingerprintRef.current = payloadFingerprint;
          }
          idempotencyKey = idempotencyKeyRef.current;
        }
        const fullPayload: ApplyChangeSet = {
          ...payload,
          idempotency_key: idempotencyKey,
        };

        const result = await client.postJson<AppliedChangeSet>("/api/apply", fullPayload);
        if (!callerIdempotencyKey) {
          idempotencyKeyRef.current = null; // success → fresh key for next batch
          payloadFingerprintRef.current = null;
        }
        return result;
      } catch (e) {
        const envelope = normalizeError(e);
        setError(envelope);
        throw envelope;
      } finally {
        inFlightRef.current = false;
        setSubmitting(false);
      }
    },
    [client],
  );

  const resetError = useCallback(() => setError(null), []);

  return {
    submitting,
    error,
    idempotencyKey: idempotencyKeyRef.current,
    apply,
    resetError,
  };
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortJson((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function normalizeError(raw: unknown): ErrorEnvelope {
  if (raw && typeof raw === "object" && "code" in raw && "message" in raw) {
    return raw as ErrorEnvelope;
  }
  // Native Error instances (network failures, TypeErrors thrown by the
  // KernelClient) have non-enumerable `message` / `stack`, so a plain
  // JSON.stringify yields "{}" — the user would see an empty error in
  // the UI. Branch on Error first so its message survives; plain object
  // payloads are still stringified for diagnostics.
  let message: string;
  if (raw instanceof Error) {
    message = raw.message || raw.name || "Error";
  } else if (typeof raw === "object" && raw !== null) {
    message = JSON.stringify(raw);
  } else {
    message = String(raw);
  }
  return {
    code: "client_error",
    message,
    details: [],
  };
}
