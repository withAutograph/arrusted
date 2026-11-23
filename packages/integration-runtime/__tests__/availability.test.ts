import { expect, it, vi } from "vitest";
import { readIntegrationAvailability } from "../availability";
import type { SupportedIntegrationAvailability } from "../availability";
import { AppIntegrationHostError } from "../app-host";

const fixture = () => {
  const assertAuthorized = vi.fn(async () => {});
  const implementation: SupportedIntegrationAvailability = {
    kind: "supported",
    readBinding: vi.fn(async () => null),
    isAuthorityFailure: (error) =>
      error instanceof AppIntegrationHostError && error.code === "forbidden",
  };
  return { assertAuthorized, implementation };
};

it("does not call an adapter for deferred or absent implementation", async () => {
  const f = fixture();
  expect(await readIntegrationAvailability({ assertAuthorized: f.assertAuthorized })).toEqual({
    status: "unavailable",
  });
  const deferred = { kind: "deferred" as const, readBinding: f.implementation.readBinding };
  expect(
    await readIntegrationAvailability({
      assertAuthorized: f.assertAuthorized,
      implementation: deferred,
    }),
  ).toEqual({ status: "unavailable" });
  expect(f.assertAuthorized).toHaveBeenCalledTimes(2);
  expect(f.implementation.readBinding).not.toHaveBeenCalled();
});
it("only a successful supported authorized no-binding read is not configured", async () => {
  const f = fixture();
  const calls: string[] = [];
  f.assertAuthorized.mockImplementation(async () => {
    calls.push("authorize");
  });
  f.implementation.readBinding = vi.fn(async () => {
    calls.push("read");
    return null;
  });
  expect(await readIntegrationAvailability(f)).toEqual({ status: "not_configured" });
  expect(f.assertAuthorized).toHaveBeenCalledTimes(2);
  expect(f.implementation.readBinding).toHaveBeenCalledTimes(1);
  expect(calls).toEqual(["authorize", "read", "authorize"]);
});
it("does not manufacture or expose a configured binding", async () => {
  const f = fixture();
  const binding = {
    id: "binding",
    connectionId: "connection",
    appId: "review",
    routingId: "routing",
    lifecycle: "pending" as const,
    revision: 1,
  };
  f.implementation.readBinding = vi.fn(async () => binding);
  expect(await readIntegrationAvailability(f)).toEqual({ status: "configured" });
  expect(binding.lifecycle).toBe("pending");
});
it("a read failure is unavailable rather than not configured and discloses no raw error", async () => {
  const f = fixture();
  f.implementation.readBinding = vi.fn(async () => {
    throw new Error("private database detail");
  });
  expect(await readIntegrationAvailability(f)).toEqual({ status: "unavailable" });
  expect(f.assertAuthorized).toHaveBeenCalledTimes(2);
});
it("initial authority failure denies even when integration implementation is deferred", async () => {
  const f = fixture();
  const denied = new AppIntegrationHostError("forbidden");
  f.assertAuthorized.mockRejectedValueOnce(denied);
  await expect(
    readIntegrationAvailability({ ...f, implementation: { kind: "deferred" } }),
  ).rejects.toBe(denied);
  expect(f.implementation.readBinding).not.toHaveBeenCalled();
});
it("authority failure from the installed reader remains a denial", async () => {
  const f = fixture();
  const denied = new AppIntegrationHostError("forbidden");
  f.implementation.readBinding = vi.fn(async () => {
    throw denied;
  });
  await expect(readIntegrationAvailability(f)).rejects.toBe(denied);
});
it.each([false, true])(
  "revocation after a successful or failed read denies (failed=%s)",
  async (failed) => {
    const f = fixture();
    const denied = new AppIntegrationHostError("forbidden");
    f.implementation.readBinding = vi.fn(async () => {
      f.assertAuthorized.mockRejectedValueOnce(denied);
      if (failed) throw new Error("read failed");
      return null;
    });
    await expect(readIntegrationAvailability(f)).rejects.toBe(denied);
  },
);

it.each([
  undefined,
  {},
  false,
  { id: "binding" },
  {
    id: "binding",
    connectionId: "connection",
    appId: "review",
    routingId: "routing",
    lifecycle: "unknown",
    revision: 1,
  },
  {
    id: "binding",
    connectionId: "connection",
    appId: "review",
    routingId: "routing",
    lifecycle: "active",
    revision: 0,
  },
  {
    id: "",
    connectionId: "connection",
    appId: "review",
    routingId: "routing",
    lifecycle: "active",
    revision: 1,
  },
])("malformed adapter output is unavailable (%j)", async (value) => {
  const f = fixture();
  // Runtime ports may receive malformed JavaScript/network output despite the TypeScript contract.
  f.implementation.readBinding = vi.fn(
    async () => value as Awaited<ReturnType<SupportedIntegrationAvailability["readBinding"]>>,
  );
  expect(await readIntegrationAvailability(f)).toEqual({ status: "unavailable" });
  expect(f.assertAuthorized).toHaveBeenCalledTimes(2);
});

it.each(["pending", "active", "suspending", "removed"] as const)(
  "a valid retained %s binding reports only configuration metadata",
  async (lifecycle) => {
    const f = fixture();
    f.implementation.readBinding = vi.fn(async () => ({
      id: "binding",
      connectionId: "connection",
      appId: "review",
      routingId: "routing",
      lifecycle,
      revision: 1,
    }));
    expect(await readIntegrationAvailability(f)).toEqual({ status: "configured" });
  },
);
