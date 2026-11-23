// UUID generator for client-side draft identifiers.
//
// `crypto.randomUUID()` is a hard environment requirement. Do not silently
// mint weak UUID-shaped strings with `Math.random()`; that hides a bad dev host
// or browser environment and can corrupt client-side draft grouping.
//
// Lives at `packages/engines/uuid/` so both `@modules/editable-grid` and
// app code (e.g. HC's PositionsPage bulk-group id minting) can share one
// implementation.
export function safeUuid(): string {
  const c = typeof globalThis !== "undefined" && (globalThis as { crypto?: Crypto }).crypto;
  if (!c || typeof c.randomUUID !== "function") {
    throw new Error("crypto.randomUUID() is required to mint client draft ids");
  }
  return c.randomUUID();
}
