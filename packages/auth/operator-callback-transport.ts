/** One bounded callback operation includes both normal-session authorize and capture. */
export const OPERATOR_CALLBACK_BUDGET_MS = 60_000;

export function createOperatorCallbackDeadline() {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException("Operator callback deadline exceeded", "TimeoutError"));
  }, OPERATOR_CALLBACK_BUDGET_MS);
  return { signal: controller.signal, close: () => clearTimeout(timer) };
}

export type OperatorCallbackOutcome =
  | "started"
  | "acknowledged"
  | "sender-rejected"
  | "transport-failure"
  | "http-rejected"
  | "invalid-acknowledgement"
  | "timeout";
export type OperatorCallbackPhase =
  | "sender-validation"
  | "authorize"
  | "capture"
  | "identity-handoff";

/** Closed transport facts only: never copy exceptions, endpoints, identities or credential payloads. */
export function reportOperatorCallback(
  transport: "browser-session" | "identity-handoff",
  phase: OperatorCallbackPhase,
  outcome: OperatorCallbackOutcome,
) {
  try {
    console.info("[auth:operator-callback]", {
      transport,
      phase,
      outcome,
      transportTimeout: outcome === "timeout",
    });
  } catch {
    // Advisory diagnostics never change credential release or callback outcomes.
  }
}
