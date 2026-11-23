import { describe, expect, it, vi } from "vitest";
import { createHttpKernelClient, csvWorkspaceRequestDate, KernelFailure } from "../server";
import type { ApplyChangeSet } from "../../contracts/index";

describe("canonical HTTP transport", () => {
  it("keeps dry-run distinct from the one apply and preserves its exact payload", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ change_set: { id: 7, schema_revision_id: "9" } }),
    );
    const client = createHttpKernelClient(fetch);
    const apply = {
      app_id: "hc",
      customer_id: "tenant",
      actor_id: "actor",
      idempotency_key: "same-key",
    } as ApplyChangeSet;
    expect(await client.validateChangeSetDryRun(apply)).toEqual({ alreadyApplied: true });
    expect(fetch.mock.calls[0]).toEqual([
      "/api/apply?dry_run=true",
      expect.objectContaining({ method: "POST", body: JSON.stringify(apply) }),
    ]);
    await client.applyChangeSet(apply);
    expect(fetch.mock.calls[1]).toEqual([
      "/api/apply",
      expect.objectContaining({ body: JSON.stringify(apply) }),
    ]);
  });
  it.each([-1, 41])("normalizes canonical dry-run receipt %s", async (id) => {
    const client = createHttpKernelClient(async () => Response.json({ change_set: { id } }));
    expect(await client.validateChangeSetDryRun({} as ApplyChangeSet)).toEqual({
      alreadyApplied: id > 0,
    });
  });
  it.each([0, null, 1.5])("rejects malformed dry-run receipt %s", async (id) => {
    const client = createHttpKernelClient(async () => Response.json({ change_set: { id } }));
    await expect(client.validateChangeSetDryRun({} as ApplyChangeSet)).rejects.toThrow();
  });
  it("only definitive canonical rejections become KernelFailure", async () => {
    for (const status of [422, 503]) {
      const client = createHttpKernelClient(async () =>
        Response.json({ code: "failed", message: "Failed" }, { status }),
      );
      const failure = await client.applyChangeSet({} as ApplyChangeSet).catch((error) => error);
      expect(failure instanceof KernelFailure).toBe(status === 422);
    }
  });
  it("rejects missing and impossible run dates", () => {
    for (const date of ["", "2026-02-30", "2026-13-01", "yesterday"])
      expect(() =>
        csvWorkspaceRequestDate(new Request(`https://example.test?as_of=${date}`)),
      ).toThrow();
    expect(csvWorkspaceRequestDate(new Request("https://example.test?as_of=2026-09-07"))).toBe(
      "2026-09-07",
    );
  });
});
