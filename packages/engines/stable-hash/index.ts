// FNV-1a (32-bit) string hashing for deterministic, non-cryptographic ids.
// 0x811c9dc5 is the standard FNV-1a 32-bit offset basis and 0x01000193 the
// FNV 32-bit prime; 0x9e3779b9 (the golden-ratio constant) is an alternate
// seed used to widen `stableHashBase36` to two independent 32-bit lanes.
// These hashes key generated identifiers and idempotency suffixes — they are
// collision-tolerant conveniences, not integrity guarantees; the kernel-side
// replay guard is the real duplicate protection.

export const FNV1A_OFFSET_BASIS = 0x811c9dc5;
export const FNV1A_PRIME = 0x01000193;
export const GOLDEN_RATIO_SEED = 0x9e3779b9;

export function fnv1aBase36(value: string, seed: number = FNV1A_OFFSET_BASIS): string {
  let hash = seed;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, FNV1A_PRIME) >>> 0;
  }
  return hash.toString(36).padStart(7, "0");
}

// Two independent 32-bit lanes (different seeds) joined for a wider keyspace.
export function stableHashBase36(value: string): string {
  return `${fnv1aBase36(value, FNV1A_OFFSET_BASIS)}${fnv1aBase36(value, GOLDEN_RATIO_SEED)}`;
}
