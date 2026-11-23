// Schema change signal per kernel client. A schema revision (for example a
// tenant adding a custom field) calls `invalidateSchema(client)`; every
// mounted `useActiveSchema` on that client refetches, so new
// fields appear without a page reload.

import { useSyncExternalStore } from "react";

import type { KernelClient } from "@contracts";

type SchemaVersion = { version: number; listeners: Set<() => void> };

const versions = new WeakMap<KernelClient, SchemaVersion>();

function entry(client: KernelClient): SchemaVersion {
  let current = versions.get(client);
  if (!current) {
    current = { version: 0, listeners: new Set() };
    versions.set(client, current);
  }
  return current;
}

export function invalidateSchema(client: KernelClient): void {
  // Reads cached before the change must not answer the refetch: evict them
  // (a cached client exposes `clearCache`) before notifying readers.
  (client as KernelClient & { clearCache?: () => void }).clearCache?.();
  const current = entry(client);
  current.version += 1;
  for (const listener of current.listeners) listener();
}

export function useSchemaVersion(client: KernelClient): number {
  return useSyncExternalStore(
    (listener) => {
      const current = entry(client);
      current.listeners.add(listener);
      return () => current.listeners.delete(listener);
    },
    () => entry(client).version,
    () => entry(client).version,
  );
}
