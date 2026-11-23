// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

import type { KernelClient } from "@contracts";

import { createCachedKernelClient, invalidateSchema, useActiveSchema } from "../index";

type TestSchema = { version: string; custom_fields?: Array<{ field_id: string }> };

describe("useActiveSchema", () => {
  it("unwraps the tenant active revision rather than reading the base schema", async () => {
    const requestedPaths: string[] = [];
    const client: KernelClient = {
      getJson: async <T,>(path: string) => {
        requestedPaths.push(path);
        return {
          schema_revision_id: 7,
          schema: { version: "tenant-active" },
        } as T;
      },
      postJson: async <T,>() => ({}) as T,
    };

    const { result } = renderHook(() => useActiveSchema<{ version: string }>(client));

    await waitFor(() => expect(result.current.schema).toEqual({ version: "tenant-active" }));
    expect(requestedPaths).toEqual(["/api/schema/active"]);
    expect(result.current.error).toBeNull();
  });

  it("reports an error, without reading the base schema, when the active schema cannot be read", async () => {
    const requestedPaths: string[] = [];
    const client: KernelClient = {
      getJson: async (path: string) => {
        requestedPaths.push(path);
        throw new Error("offline");
      },
      postJson: async <T,>() => ({}) as T,
    };

    const { result } = renderHook(() => useActiveSchema<{ version: string }>(client));

    await waitFor(() => expect(result.current.error).toEqual(new Error("offline")));
    expect(result.current.schema).toBeNull();
    expect(requestedPaths).toEqual(["/api/schema/active"]);
  });

  it("clears the error when a later read recovers", async () => {
    let reachable = false;
    const client: KernelClient = {
      getJson: async <T,>() => {
        if (reachable) return { schema_revision_id: 3, schema: { version: "active" } } as T;
        throw new Error("offline");
      },
      postJson: async <T,>() => ({}) as T,
    };

    const { result } = renderHook(() => useActiveSchema<{ version: string }>(client));
    await waitFor(() => expect(result.current.error).toEqual(new Error("offline")));

    reachable = true;
    act(() => invalidateSchema(client));
    await waitFor(() => expect(result.current.schema).toEqual({ version: "active" }));
    expect(result.current.error).toBeNull();
  });

  it("shows a tenant custom field after a revision, which the base schema never has", async () => {
    // Shaped like the HC server: `/api/schema` is the compiled base schema;
    // `/api/schema/active` is the effective schema, which a revision changes.
    let activeRevision = 1;
    const base: TestSchema = { version: "base" };
    const client: KernelClient = {
      getJson: async <T,>(path: string) => {
        if (path === "/api/schema") return base as T;
        if (path === "/api/schema/active") {
          return {
            schema_revision_id: activeRevision,
            schema:
              activeRevision === 1
                ? { version: "active-1" }
                : { version: "active-2", custom_fields: [{ field_id: "cf_cost_center" }] },
          } as T;
        }
        throw new Error(`unexpected ${path}`);
      },
      postJson: async <T,>() => ({}) as T,
    };

    const { result } = renderHook(() => useActiveSchema<TestSchema>(client));
    await waitFor(() => expect(result.current.schema?.version).toBe("active-1"));

    activeRevision = 2;
    act(() => invalidateSchema(client));
    await waitFor(() =>
      expect(result.current.schema?.custom_fields).toEqual([{ field_id: "cf_cost_center" }]),
    );
    expect(await client.getJson<TestSchema>("/api/schema")).not.toHaveProperty("custom_fields");
  });

  it("refetches past a cached read when the schema is invalidated", async () => {
    let revision = 1;
    const client = createCachedKernelClient(
      {
        getJson: async <T,>() =>
          ({ schema_revision_id: revision, schema: { version: `active-${revision}` } }) as T,
        postJson: async <T,>() => ({}) as T,
      },
      { readTtlMs: 60_000 },
    );

    const { result } = renderHook(() => useActiveSchema<{ version: string }>(client));
    await waitFor(() => expect(result.current.schema).toEqual({ version: "active-1" }));

    revision = 2;
    act(() => invalidateSchema(client));
    await waitFor(() => expect(result.current.schema).toEqual({ version: "active-2" }));
  });
});
