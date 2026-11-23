import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { Browser, BrowserContext } from "playwright/test";
import { describe, expect, it } from "vitest";
import {
  createNormalActorContext,
  createNormalActorContextManager,
  NormalActorBrowserError,
  readNormalActorManifest,
  selectNormalActor,
  test as actorTest,
  withNormalActorContext,
} from "./normal-actors.js";
import type { NormalActorIdentity, NormalActorManifest } from "./normal-actors.js";

const withManifest = async (run: (manifestPath: string, directory: string) => Promise<void>) => {
  const directory = await mkdtemp(path.join(tmpdir(), "normal-actor-playwright-"));
  try {
    await run(path.join(directory, "identities.json"), directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
const actor = (organizationId: string | null, storageState: string): NormalActorIdentity => ({
  actorKey: "shared-account",
  actorId: "actual-actor",
  organizationId,
  roles: [],
  storageState,
});
const nativeFixtureType = (
  browser: Browser,
  identity: NormalActorIdentity,
): Promise<BrowserContext> =>
  createNormalActorContext(browser, identity, "https://approved.example");

const browserFixture = () => {
  const calls: { storageState: string; baseURL?: string }[] = [];
  const closed: number[] = [];
  return {
    calls,
    closed,
    browser: {
      async newContext(options: { storageState: string; baseURL?: string }) {
        calls.push(options);
        const index = calls.length;
        return {
          close: async () => {
            closed.push(index);
            await Promise.resolve();
          },
        };
      },
    },
  };
};

describe("normal actor Playwright consumer", () => {
  it("consumes the existing runtime-prepared identities without changing session files", async () => {
    await withManifest(async (manifestPath, directory) => {
      const absolute = path.join(directory, "tenant_admin_0.storage.json");
      const relative = "tenant_member_0.storage.json";
      const storage = JSON.stringify({
        cookies: [{ name: "session", value: "actual-session", domain: "localhost", path: "/" }],
        origins: [],
      });
      await writeFile(absolute, storage, { mode: 0o600 });
      await writeFile(path.join(directory, relative), storage, { mode: 0o600 });
      await writeFile(
        manifestPath,
        JSON.stringify({
          version: 1,
          appId: "actual-app",
          identities: [
            {
              actorId: "tenant_admin_0",
              organizationId: "tenant",
              role: "admin",
              email: "tenant.admin.0@example.test",
              storageState: absolute,
            },
            {
              actorId: "tenant_member_0",
              organizationId: "tenant",
              role: "member",
              email: "tenant.member.0@example.test",
              storageState: relative,
            },
            {
              actorId: "tenant_unassigned",
              organizationId: "tenant",
              role: null,
              storageState: relative,
            },
          ],
        }),
        { mode: 0o600 },
      );
      const manifest = await readNormalActorManifest(manifestPath);
      expect(manifest).toEqual({
        version: 1,
        actors: [
          {
            actorKey: "tenant_admin_0",
            actorId: "tenant_admin_0",
            organizationId: "tenant",
            roles: ["admin"],
            storageState: absolute,
          },
          {
            actorKey: "tenant_member_0",
            actorId: "tenant_member_0",
            organizationId: "tenant",
            roles: ["member"],
            storageState: path.join(directory, relative),
          },
          {
            actorKey: "tenant_unassigned",
            actorId: "tenant_unassigned",
            organizationId: "tenant",
            roles: [],
            storageState: path.join(directory, relative),
          },
        ],
      });
      const f = browserFixture();
      const contexts = createNormalActorContextManager(
        f.browser,
        manifest,
        "http://localhost:3000",
      );
      await contexts.open({ actorKey: "tenant_admin_0", organizationId: "tenant" });
      await contexts.open({ actorKey: "tenant_member_0", organizationId: "tenant" });
      expect(f.calls).toEqual([
        { storageState: absolute, baseURL: "http://localhost:3000" },
        { storageState: path.join(directory, relative), baseURL: "http://localhost:3000" },
      ]);
      await contexts.close();
      expect(f.closed).toEqual([1, 2]);
      expect(await readFile(absolute, "utf8")).toBe(storage);
      expect(await readFile(path.join(directory, relative), "utf8")).toBe(storage);
    });
  });

  it("reads the Builder manifest and preserves absolute and relative actual storage files", async () => {
    await withManifest(async (manifestPath, directory) => {
      const absolute = path.join(directory, "first.storage.json");
      const relative = "second.storage.json";
      const storage = JSON.stringify({
        cookies: [
          { name: "session", value: "private-cookie", domain: ".approved.example", path: "/" },
        ],
        origins: [],
      });
      await writeFile(absolute, storage, { mode: 0o600 });
      await writeFile(path.join(directory, relative), storage, { mode: 0o600 });
      await writeFile(
        manifestPath,
        JSON.stringify({
          version: 1,
          actors: [
            actor("org-a", absolute),
            actor("org-b", relative),
            { ...actor(null, relative), actorKey: "unassigned", actorId: "unassigned-actor" },
          ],
        }),
        { mode: 0o600 },
      );
      const manifest = await readNormalActorManifest(manifestPath);
      expect(
        manifest.actors.map((row) => [row.organizationId, row.roles, row.storageState]),
      ).toEqual([
        ["org-a", [], absolute],
        ["org-b", [], path.join(directory, relative)],
        [null, [], path.join(directory, relative)],
      ]);
      expect(await readFile(absolute, "utf8")).toBe(storage);
      expect(await readFile(path.join(directory, relative), "utf8")).toBe(storage);
      const selected = selectNormalActor(manifest, {
        actorKey: "shared-account",
        organizationId: "org-b",
      });
      expect(selected.storageState).toBe(path.join(directory, relative));
    });
  });

  it("selects exactly the actor and organization, including no app assignment and no organization", () => {
    const manifest: NormalActorManifest = {
      version: 1,
      actors: [
        actor("org-a", "/private/a"),
        actor("org-b", "/private/b"),
        actor(null, "/private/no-org"),
      ],
    };
    expect(
      selectNormalActor(manifest, { actorKey: "shared-account", organizationId: "org-b" })
        .storageState,
    ).toBe("/private/b");
    expect(
      selectNormalActor(manifest, { actorKey: "shared-account", organizationId: null }).roles,
    ).toEqual([]);
    expect(() =>
      selectNormalActor(manifest, { actorKey: "shared-account", organizationId: "missing" }),
    ).toThrow("actor_not_found");
    expect(() =>
      selectNormalActor(
        { ...manifest, actors: [manifest.actors[0]!, manifest.actors[0]!] },
        { actorKey: "shared-account", organizationId: "org-a" },
      ),
    ).toThrow("actor_ambiguous");
  });

  it("retains canonical actors and multi-organization selection alongside additive metadata", async () => {
    await withManifest(async (manifestPath) => {
      await writeFile(
        manifestPath,
        JSON.stringify({
          version: 1,
          actors: [actor("org-a", "/private/a"), actor("org-b", "/private/b")],
          identities: [{ futureMetadata: "ignored" }],
          futureMetadata: { revision: 2 },
        }),
        { mode: 0o600 },
      );
      const manifest = await readNormalActorManifest(manifestPath);
      expect(
        selectNormalActor(manifest, { actorKey: "shared-account", organizationId: "org-b" }),
      ).toEqual(actor("org-b", "/private/b"));
    });
  });

  it("normalizes actual runtime identity fields without requiring envelope metadata", async () => {
    await withManifest(async (manifestPath) => {
      const actual = {
        actorId: "actual-actor",
        organizationId: "actual-org",
        role: "member",
        storageState: "/private/actual-session",
        actorKey: "unrelated-metadata",
        roles: ["unrelated-metadata"],
        futureMetadata: { revision: 2 },
      };
      await writeFile(manifestPath, JSON.stringify({ version: 1, identities: [actual] }), {
        mode: 0o600,
      });
      const manifest = await readNormalActorManifest(manifestPath);
      expect(
        selectNormalActor(manifest, {
          actorKey: actual.actorId,
          organizationId: actual.organizationId,
        }),
      ).toEqual({
        actorKey: actual.actorId,
        actorId: actual.actorId,
        organizationId: actual.organizationId,
        roles: [actual.role],
        storageState: actual.storageState,
      });
    });
  });

  it("opens independent contexts from unchanged jar file paths with the actual base URL", async () => {
    const f = browserFixture();
    const manifest: NormalActorManifest = {
      version: 1,
      actors: [
        actor("org-a", "/private/a.storage.json"),
        actor("org-b", "/private/b.storage.json"),
      ],
    };
    const contexts = createNormalActorContextManager(
      f.browser,
      manifest,
      "https://approved.example",
    );
    await contexts.open({ actorKey: "shared-account", organizationId: "org-a" });
    await contexts.open({ actorKey: "shared-account", organizationId: "org-b" });
    expect(f.calls).toEqual([
      { storageState: "/private/a.storage.json", baseURL: "https://approved.example" },
      { storageState: "/private/b.storage.json", baseURL: "https://approved.example" },
    ]);
    await contexts.close();
    expect(f.closed).toEqual([1, 2]);
    await contexts.close();
    expect(f.closed).toEqual([1, 2]);
  });

  it("closes all contexts even when another context's close fails", async () => {
    const closed: string[] = [];
    const browser = {
      async newContext(options: { storageState: string }) {
        return {
          async close() {
            closed.push(options.storageState);
            if (options.storageState === "/private/a") throw new Error("Closing failed");
            await Promise.resolve();
          },
        };
      },
    };
    const manifest: NormalActorManifest = {
      version: 1,
      actors: [actor("org-a", "/private/a"), actor("org-b", "/private/b")],
    };
    const contexts = createNormalActorContextManager(browser, manifest);
    await contexts.open({ actorKey: "shared-account", organizationId: "org-a" });
    await contexts.open({ actorKey: "shared-account", organizationId: "org-b" });
    await expect(contexts.close()).rejects.toThrow("Closing failed");
    expect(closed).toEqual(["/private/a", "/private/b"]);
  });

  it("closes a scoped context after an exceptional product assertion", async () => {
    const f = browserFixture();
    await expect(
      withNormalActorContext(f.browser, actor("org-a", "/private/a"), async () => {
        await Promise.resolve();
        throw new Error("Product assertion failed");
      }),
    ).rejects.toThrow("Product assertion failed");
    expect(f.closed).toEqual([1]);
  });

  it("does not open a context for an absent selector", async () => {
    const f = browserFixture();
    const contexts = createNormalActorContextManager(f.browser, { version: 1, actors: [] });
    await expect(contexts.open({ actorKey: "missing", organizationId: "org" })).rejects.toThrow(
      "actor_not_found",
    );
    expect(f.calls).toEqual([]);
  });

  it("sanitizes private file and browser failures", async () => {
    await withManifest(async (manifestPath) => {
      await writeFile(manifestPath, "private-cookie private-invalid-json", { mode: 0o600 });
      await expect(readNormalActorManifest(manifestPath)).rejects.toThrow("manifest_invalid");
      await expect(readNormalActorManifest(`${manifestPath}.missing`)).rejects.toThrow(
        "manifest_unavailable",
      );
    });
    const browser = {
      async newContext() {
        await Promise.resolve();
        throw new Error("private-cookie /private/session.storage.json");
      },
    };
    try {
      await createNormalActorContext(browser, actor("org", "/private/session.storage.json"));
      throw new Error("Expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(NormalActorBrowserError);
      expect(String(error)).not.toContain("private-cookie");
      expect(String(error)).not.toContain("/private/session");
      expect(error).not.toHaveProperty("cause");
    }
  });

  it.each([
    { version: 1, identities: "invalid" },
    { version: 2, actors: [] },
    { version: 1, actors: [{ ...actor("org", "state"), roles: [null] }] },
    { version: 1, actors: [{ ...actor("org", "state"), organizationId: 1 }] },
  ])("rejects a different manifest contract without manufacturing sessions", async (manifest) => {
    await withManifest(async (manifestPath) => {
      await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
      await expect(readNormalActorManifest(manifestPath)).rejects.toThrow("manifest_invalid");
    });
  });

  it.each([
    { version: 1, appId: "actual", actors: null, identities: [] },
    { version: 1, appId: "actual", identities: [null] },
    {
      version: 1,
      appId: "actual",
      identities: [{ actorId: "actor", organizationId: "org", storageState: "private-cookie" }],
    },
    {
      version: 1,
      appId: "actual",
      identities: [
        { actorId: "actor", organizationId: "org", role: [], storageState: "private-cookie" },
      ],
    },
  ])("rejects damaged runtime manifests with redacted errors", async (manifest) => {
    await withManifest(async (manifestPath) => {
      await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
      await expect(readNormalActorManifest(manifestPath)).rejects.toMatchObject({
        code: "manifest_invalid",
        message: "Normal actor browser setup failed (manifest_invalid).",
      });
    });
  });

  it("exposes the real lazy Playwright fixture and an assignable native Browser API", () => {
    expect(typeof actorTest.extend).toBe("function");
    expect(typeof nativeFixtureType).toBe("function");
  });
});
