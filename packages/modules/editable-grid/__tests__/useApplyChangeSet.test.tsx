import { useEffect } from "react";
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";

import type { ApplyChangeSet, KernelClient } from "@contracts";

import { useApplyChangeSet } from "../hooks/useApplyChangeSet";

describe("useApplyChangeSet", () => {
  it("preserves caller-supplied idempotency keys", async () => {
    const posted: unknown[] = [];
    const client: KernelClient = {
      getJson: (async () => []) as KernelClient["getJson"],
      postJson: (async (_path: string, payload: unknown) => {
        posted.push(payload);
        return { id: 1, schema_revision_id: "1" };
      }) as KernelClient["postJson"],
    };
    const payload: ApplyChangeSet = {
      app_id: "hc",
      customer_id: "demo",
      source_kind: "data_import",
      source_ref: "run-1",
      idempotency_key: "hc-csv-import:run-1:employee_update:mainline",
      change_type_id: "employee_update",
      mode: "mainline",
      writes: [],
    };

    function Harness() {
      const { apply } = useApplyChangeSet(client);
      useEffect(() => {
        void apply(payload);
      }, [apply]);
      return null;
    }

    render(<Harness />);

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({
      idempotency_key: "hc-csv-import:run-1:employee_update:mainline",
    });
  });

  it("generates an idempotency key when callers omit one", async () => {
    const posted: unknown[] = [];
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
    const client: KernelClient = {
      getJson: (async () => []) as KernelClient["getJson"],
      postJson: (async (_path: string, payload: unknown) => {
        posted.push(payload);
        return { id: 1, schema_revision_id: "1" };
      }) as KernelClient["postJson"],
    };
    const payload: ApplyChangeSet = {
      app_id: "hc",
      customer_id: "demo",
      source_kind: "ui",
      change_type_id: "employee_update",
      mode: "mainline",
      writes: [],
    };

    function Harness() {
      const { apply } = useApplyChangeSet(client);
      useEffect(() => {
        void apply(payload);
      }, [apply]);
      return null;
    }

    render(<Harness />);

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({
      idempotency_key: "00000000-0000-4000-8000-000000000001",
    });
  });
});
