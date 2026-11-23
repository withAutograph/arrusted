// useActiveSchema — the tenant's active effective schema: the app base plus
// the tenant overlay (custom fields, enum additions, lookups), read from
// `/api/schema/active`. Every app page reads its schema this way; the
// compiled base schema alone never shows tenant changes. It loads at mount
// and again after `invalidateSchema(client)`, which a schema revision calls.
//
// Accepts the client by injection and returns the raw `TSchema` payload;
// conversion happens app-side. A fresh effect per client or schema version
// cancels the in-flight read so a stale response cannot overwrite a newer one.

import { useEffect, useState } from "react";

import type { ActiveSchemaRevision, KernelClient } from "@contracts";

import { useSchemaVersion } from "./schema-version";

export type UseSchemaResult<TSchema> = {
  schema: TSchema | null;
  error: unknown;
};

export function useActiveSchema<TSchema>(client: KernelClient): UseSchemaResult<TSchema> {
  const [schema, setSchema] = useState<TSchema | null>(null);
  const [error, setError] = useState<unknown | null>(null);
  const version = useSchemaVersion(client);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const payload = await client.getJson<ActiveSchemaRevision>("/api/schema/active");
        if (!cancelled) {
          setSchema(payload.schema as TSchema);
          setError(null);
        }
      } catch (caught) {
        if (!cancelled) setError(caught);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, version]);
  return { schema, error };
}
