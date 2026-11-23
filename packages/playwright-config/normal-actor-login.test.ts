import { test as playwrightTest } from "playwright/test";
import { mkdtemp, writeFile, rm, chmod, realpath, mkdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import {
  NormalActorUiLoginError,
  signInNormalActorInContext,
  withNormalActorUiLogin,
} from "./normal-actor-login.js";
import { withNormalActorReadback } from "./normal-actor-readback.js";
import { readProtectedNormalActorFixture } from "./normal-actor-private-fixture.js";
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
const fixture = async () => {
  vi.stubEnv("APP_TEST_PREVIEW_AUTHORITY_FILE", undefined);
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "normal-ui-login-")));
  directories.push(directory);
  const password = "private-fixture-password";
  const email = "private-actor@example.test";
  const baseURL = "https://fixture.example";
  const state = {
    plan: {
      version: 1,
      appId: "invoice",
      environment: "local",
      runtimeId: "owned-runtime",
      database: "app_db",
      authDatabase: "auth_db",
      principal: "app_runtime",
      roles: ["member"],
      tenants: ["tenant"],
      releaseId: "release",
      artifactHash: `sha256:${"a".repeat(64)}`,
    },
    authOrigin: baseURL,
    fixturePassword: password,
  };
  const write = (name: string, value: unknown) =>
    writeFile(path.join(directory, name), JSON.stringify(value), { mode: 0o600 });
  await write("state.json", state);
  await write("identities.json", {
    version: 1,
    appId: "invoice",
    identities: [
      {
        actorId: "actor",
        organizationId: "tenant",
        role: "member",
        email,
        storageState: path.join(directory, "actor.storage.json"),
      },
    ],
  });
  await write("environment.json", {
    APP_TEST_BASE_URL: baseURL,
    BETTER_AUTH_URL: baseURL,
    INVOICE_DATABASE_URL: "postgres://app_runtime:private@127.0.0.1/app_db",
    PLATFORM_AUTH_DATABASE_URL: "postgres://app_runtime_auth:private@127.0.0.1/auth_db",
  });
  const filled = new Map<string, string>();
  let currentURL = baseURL;
  const page = {
    url: () => currentURL,
    close: vi.fn(async () => {}),
    video: () => null,
    context: (): never => context as never,
    goto: vi.fn(async (target: string) => {
      currentURL = new URL(target, baseURL).href;
    }),
    locator: (selector: string) => ({
      count: async () => 1,
      fill: vi.fn(async (value: string) => {
        filled.set(selector, value);
      }),
      click: vi.fn(async () => {}),
    }),
    waitForResponse: vi.fn(async () => ({ status: () => 200 })),
  };
  const context = {
    pages: () => [page],
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => {}),
    request: {
      get: vi.fn(async () => ({
        status: () => 200,
        dispose: vi.fn(async () => {}),
        json: async () => ({
          user: { id: "actor" },
          session: { userId: "actor", activeOrganizationId: "tenant" },
        }),
      })),
    },
  };
  const browser = { newContext: vi.fn(async () => context) };
  const input = {
    appId: "invoice",
    selector: { actorKey: "actor", organizationId: "tenant" },
    baseURL,
    browser: browser as never,
    environment: {
      APP_TEST_IDENTITIES_FILE: path.join(directory, "identities.json"),
      APP_TEST_BASE_URL: baseURL,
      APP_TEST_ENTRY_PATH: "/invoice",
      APP_RUNTIME_STATE_DIR: directory,
    },
    policy: {
      reporter: [
        [fileURLToPath(new URL("./private-preview-reporter.js", import.meta.url))],
      ] as never,
      trace: "off" as const,
      video: "off" as const,
      screenshot: "off" as const,
    },
  };
  const runnerInfo = vi.spyOn(playwrightTest, "info").mockReturnValue({
    config: { reporter: input.policy.reporter },
    project: { use: { trace: input.policy.trace } },
  } as never);
  return {
    input,
    page,
    context,
    browser,
    filled,
    password,
    email,
    state,
    write,
    directory,
    runnerInfo,
  };
};
it("uses fresh UI entry and current session readback without returning credentials", async () => {
  const f = await fixture();
  let invoked = false;
  const result = await withNormalActorUiLogin(f.input, async ({ context, page }) => {
    invoked = true;
    expect(context).toBe(f.context);
    expect(page).toBe(f.page);
  });
  expect(invoked).toBe(true);
  expect(result).toBeUndefined();
  expect(f.browser.newContext).toHaveBeenCalledWith({ baseURL: f.input.baseURL });
  expect(f.page.goto).toHaveBeenCalledWith("/auth/sign-in");
  expect(f.filled.get('input[type="email"]')).toBe(f.email);
  expect(f.filled.get('input[type="password"]')).toBe(f.password);
  expect(f.context.request.get).toHaveBeenCalledWith(
    "https://fixture.example/api/auth/get-session",
    { maxRedirects: 0 },
  );
  expect(f.context.close).toHaveBeenCalledOnce();
  const scope = await readProtectedNormalActorFixture(f.input);
  expect(JSON.stringify(scope)).not.toContain(f.password);
  expect(JSON.stringify(scope)).not.toContain(f.email);
  expect(Object.isFrozen(scope.plan)).toBe(true);
  expect(Object.isFrozen(scope.identity.roles)).toBe(true);
  expect(scope.identity.access).toBe("admitted");
});
it.each(["admitted", "unassigned", undefined] as const)(
  "preserves explicit roleless access and keeps legacy empty roles unassigned (%s)",
  async (access) => {
    const f = await fixture();
    f.state.plan.roles = [];
    await f.write("state.json", f.state);
    await f.write("identities.json", {
      version: 1,
      appId: "invoice",
      identities: [
        {
          actorId: "actor",
          organizationId: "tenant",
          role: null,
          access,
          email: f.email,
          storageState: path.join(f.directory, "actor.storage.json"),
        },
      ],
    });
    const scope = await readProtectedNormalActorFixture(f.input);
    expect(scope.identity.access).toBe(access ?? "unassigned");
    expect(scope.identity.roles).toEqual([]);
    expect(JSON.stringify(scope)).not.toContain(f.password);
    expect(JSON.stringify(scope)).not.toContain(f.email);
  },
);
it("rejects an unknown private access marker without echoing its value", async () => {
  const f = await fixture();
  await f.write("identities.json", {
    version: 1,
    appId: "invoice",
    identities: [
      {
        actorId: "actor",
        organizationId: "tenant",
        role: "member",
        access: f.password,
        email: f.email,
        storageState: path.join(f.directory, "actor.storage.json"),
      },
    ],
  });
  await expect(readProtectedNormalActorFixture(f.input)).rejects.toMatchObject({
    code: "local-fixture-unavailable",
    message: "The current owned local actor fixture is unavailable.",
  });
});
it("keeps an explicit same-origin sign-in override and refuses a cross-origin path", async () => {
  const f = await fixture();
  await withNormalActorUiLogin({ ...f.input, signInPath: "/account/sign-in" }, async () => {});
  expect(f.page.goto).toHaveBeenLastCalledWith("/account/sign-in");
  f.page.goto.mockClear();
  await expect(
    withNormalActorUiLogin({ ...f.input, signInPath: "//foreign.example/sign-in" }, async () => {}),
  ).rejects.toMatchObject({ code: "normal-actor-ui-login-unavailable" });
  expect(f.page.goto).not.toHaveBeenCalled();
});

it.each(["trace", "video", "screenshot", "reporter"])(
  "denies unsafe %s recording before credentials or contexts",
  async (key) => {
    const f = await fixture();
    const policy = { ...f.input.policy, [key]: key === "reporter" ? [["json"]] : "on" };
    f.runnerInfo.mockReturnValue({
      config: { reporter: policy.reporter },
      project: { use: { trace: policy.trace, video: policy.video, screenshot: policy.screenshot } },
    } as never);
    await expect(withNormalActorUiLogin(f.input, async () => {})).rejects.toMatchObject({
      code: "normal-actor-ui-login-unavailable",
    });
    expect(f.browser.newContext).not.toHaveBeenCalled();
    expect(f.filled.size).toBe(0);
  },
);
it("preserves actor/org/origin scope and never leaks private parser or browser errors", async () => {
  const f = await fixture();
  for (const input of [
    { ...f.input, appId: "foreign" },
    { ...f.input, baseURL: "https://foreign.example" },
    { ...f.input, selector: { actorKey: "actor", organizationId: "foreign" } },
  ]) {
    await expect(withNormalActorUiLogin(input, async () => {})).rejects.toMatchObject({
      code: "normal-actor-ui-login-unavailable",
    });
  }
  expect(f.browser.newContext).not.toHaveBeenCalled();
  f.page.goto.mockRejectedValue(new Error(f.email + f.password));
  try {
    await withNormalActorUiLogin(f.input, async () => {});
    throw new Error("must reject");
  } catch (error) {
    expect(String(error)).not.toContain(f.password);
    expect(String(error)).not.toContain(f.email);
  }
  expect(f.context.close).toHaveBeenCalledOnce();
});
it("denies file changes and wrong session identity without restoring cookies", async () => {
  const f = await fixture();
  f.page.goto.mockImplementation(async () => {
    await f.write("state.json", { ...f.state, authOrigin: "https://changed.example" });
  });
  await expect(withNormalActorUiLogin(f.input, async () => {})).rejects.toMatchObject({
    code: "normal-actor-ui-login-unavailable",
  });
  expect(f.filled.size).toBe(0);
  const g = await fixture();
  g.context.request.get.mockResolvedValue({
    status: () => 200,
    dispose: vi.fn(async () => {}),
    json: async () => ({
      user: { id: "foreign" },
      session: { userId: "foreign", activeOrganizationId: "tenant" },
    }),
  });
  await expect(withNormalActorUiLogin(g.input, async () => {})).rejects.toMatchObject({
    code: "normal-actor-ui-login-unavailable",
  });
  expect(g.context.close).toHaveBeenCalledOnce();
});
it("accepts the checked release schema hash format", async () => {
  const f = await fixture();
  const artifactHash = `sha256:${"b".repeat(64)}`;
  await f.write("state.json", { ...f.state, plan: { ...f.state.plan, artifactHash } });
  const scope = await readProtectedNormalActorFixture(f.input);
  expect(scope.plan.artifactHash).toBe(artifactHash);
});

it.each(["a".repeat(64), `sha256:${"a".repeat(63)}`, `sha512:${"a".repeat(64)}`])(
  "rejects a schema hash outside the checked release format",
  async (artifactHash) => {
    const f = await fixture();
    await f.write("state.json", { ...f.state, plan: { ...f.state.plan, artifactHash } });
    await expect(readProtectedNormalActorFixture(f.input)).rejects.toMatchObject({
      code: "local-fixture-unavailable",
    });
  },
);

it("rejects nonprivate runtime custody", async () => {
  const f = await fixture();
  await chmod(path.join(f.directory, "state.json"), 0o644);
  await expect(readProtectedNormalActorFixture(f.input)).rejects.toMatchObject({
    code: "local-fixture-unavailable",
  });
});

it("supports the existing owned shared local context without changing its identities", async () => {
  const f = await fixture();
  const appDirectory = path.join(f.directory, "apps", "invoice");
  await mkdir(appDirectory, { recursive: true, mode: 0o700 });
  for (const file of ["identities.json", "environment.json"]) {
    await rename(path.join(f.directory, file), path.join(appDirectory, file));
  }
  await f.write("state.json", {
    version: 2,
    runtimeId: f.state.plan.runtimeId,
    environment: "local",
    authOrigin: f.state.authOrigin,
    fixturePassword: f.password,
    installations: {
      invoice: {
        plan: { ...f.state.plan, authScope: "context", authPrincipal: "shared_auth_runtime" },
      },
    },
  });
  const scope = await readProtectedNormalActorFixture({
    ...f.input,
    environment: {
      APP_TEST_IDENTITIES_FILE: path.join(appDirectory, "identities.json"),
      APP_TEST_BASE_URL: f.input.baseURL,
      APP_RUNTIME_CONTEXT_DIR: f.directory,
    },
  });
  expect(scope.plan.authScope).toBe("context");
  expect(scope.identity.actorId).toBe("actor");
  expect(JSON.stringify(scope)).not.toContain(f.password);
});

it("keeps only the closed stage from nested protected readback errors", async () => {
  const f = await fixture();
  await expect(
    withNormalActorUiLogin(f.input, async () => {
      await withNormalActorReadback({ ...f.input, appId: "foreign" }, async () => {});
    }),
  ).rejects.toMatchObject({
    code: "normal-actor-ui-login-unavailable",
    message:
      "Normal actor UI login failed; private diagnostics are withheld. [stage: readback-unavailable]",
  });
});
it("treats a caller-constructed stage lookalike as an ordinary callback failure", async () => {
  const f = await fixture();
  const lookalike = new NormalActorUiLoginError("preview-refresh-required");
  lookalike.message =
    "Normal actor UI login failed; private diagnostics are withheld. [stage: preview-refresh-required]";
  await expect(
    withNormalActorUiLogin(f.input, async () => {
      throw lookalike;
    }),
  ).rejects.toMatchObject({
    message:
      "Normal actor UI login failed; private diagnostics are withheld. [stage: protected-operation]",
  });
});
it("redacts assertion failures after login and rejects malformed plan identity", async () => {
  const f = await fixture();
  try {
    await withNormalActorUiLogin(f.input, async () => {
      throw new Error(f.email + f.password);
    });
    throw new Error("must reject");
  } catch (error) {
    expect(String(error)).toContain("[stage: protected-operation]");
    expect(String(error)).not.toContain(f.email);
    expect(String(error)).not.toContain(f.password);
  }
  expect(f.context.close).toHaveBeenCalledOnce();
  const g = await fixture();
  await g.write("state.json", { ...g.state, plan: { ...g.state.plan, version: 2 } });
  await expect(readProtectedNormalActorFixture(g.input)).rejects.toMatchObject({
    code: "local-fixture-unavailable",
  });
});

it.each([null, "another-tenant"])(
  "does not manufacture selected organization %s",
  async (organization) => {
    const f = await fixture();
    f.context.request.get.mockResolvedValue({
      status: () => 200,
      json: async () => ({
        user: { id: "actor" },
        session: { userId: "actor", activeOrganizationId: organization },
      }),
    } as never);
    const operation = vi.fn(async () => {});
    await expect(withNormalActorUiLogin(f.input, operation)).rejects.toMatchObject({
      code: "normal-actor-ui-login-unavailable",
    });
    expect(operation).not.toHaveBeenCalled();
    expect(f.context.close).toHaveBeenCalledOnce();
  },
);

it.each([
  { actor: "unassigned", organization: "tenant", role: null },
  { actor: "different-tenant-actor", organization: "different-tenant", role: "member" },
])(
  "uses the same genuine jar to sign in $actor and preserves the retained form tab",
  async ({ actor, organization, role }) => {
    const f = await fixture();
    await f.write("state.json", {
      ...f.state,
      plan: { ...f.state.plan, tenants: ["tenant", "different-tenant"] },
    });
    await f.write("identities.json", {
      version: 1,
      appId: "invoice",
      identities: [
        {
          actorId: "actor",
          organizationId: "tenant",
          role: "member",
          email: f.email,
          storageState: path.join(f.directory, "actor.storage.json"),
        },
        {
          actorId: actor,
          organizationId: organization,
          role,
          email: "other-private-actor@example.test",
          storageState: path.join(f.directory, "other.storage.json"),
        },
      ],
    });
    await withNormalActorUiLogin(f.input, async ({ context }) => {
      const beforeContextCreations = f.browser.newContext.mock.calls.length;
      const retainedForm = f.page;
      const signInPage = { ...f.page, close: vi.fn(async () => {}) };
      f.context.newPage.mockResolvedValue(signInPage);
      let session: unknown = {
        user: { id: "actor" },
        session: { userId: "actor", activeOrganizationId: "tenant" },
      };
      const signOutButton = {
        click: vi.fn(async () => {
          session = null;
        }),
      };
      await signOutButton.click(); // Model the caller's actual UI action, not a helper cookie patch.
      f.context.request.get.mockImplementation(
        async () =>
          ({
            status: () => 200,
            dispose: vi.fn(async () => {}),
            json: async () => session,
          }) as never,
      );
      const originalLocator = signInPage.locator;
      signInPage.locator = (selector) => {
        const locator = originalLocator(selector);
        if (selector === 'form button[type="submit"]')
          locator.click = vi.fn(async () => {
            session = {
              user: { id: actor },
              session: { userId: actor, activeOrganizationId: organization },
            };
          });
        return locator;
      };
      const result = await signInNormalActorInContext({
        ...f.input,
        context,
        selector: { actorKey: actor, organizationId: organization },
      });
      expect(result).toBeUndefined();
      expect(f.browser.newContext).toHaveBeenCalledTimes(beforeContextCreations);
      expect(f.context.close).not.toHaveBeenCalled();
      expect(retainedForm.close).not.toHaveBeenCalled();
      expect(signInPage.close).toHaveBeenCalledOnce();
      expect(signInPage.goto).toHaveBeenLastCalledWith("/auth/sign-in");
      expect(session).toMatchObject({
        user: { id: actor },
        session: { activeOrganizationId: organization },
      });
      expect(f.filled.get('input[type="password"]')).toBe(f.password);
    });
  },
);

it("requires genuine logout and a protected existing context before filling credentials", async () => {
  const f = await fixture();
  await expect(
    signInNormalActorInContext({ ...f.input, context: f.context as never }),
  ).rejects.toMatchObject({ code: "normal-actor-ui-login-unavailable" });
  expect(f.context.newPage).not.toHaveBeenCalled();
  await withNormalActorUiLogin(f.input, async ({ context }) => {
    const fills = f.filled.size;
    const pages = f.context.newPage.mock.calls.length;
    // Still signed in: never silently overwrite the existing Auth session.
    await expect(signInNormalActorInContext({ ...f.input, context })).rejects.toMatchObject({
      code: "normal-actor-ui-login-unavailable",
    });
    expect(f.context.newPage).toHaveBeenCalledTimes(pages);
    expect(f.filled.size).toBe(fills);
    expect(f.context.close).not.toHaveBeenCalled();
  });
});

it("rejects changed recording policy before touching credentials or existing tabs", async () => {
  const f = await fixture();
  await withNormalActorUiLogin(f.input, async ({ context }) => {
    const calls = f.context.request.get.mock.calls.length;
    f.runnerInfo.mockReturnValue({
      config: { reporter: [["json"]] },
      project: { use: { trace: "on" } },
    } as never);
    await expect(signInNormalActorInContext({ ...f.input, context })).rejects.toMatchObject({
      code: "normal-actor-ui-login-unavailable",
    });
    expect(f.context.request.get).toHaveBeenCalledTimes(calls);
    expect(f.page.close).not.toHaveBeenCalled();
  });
});

it("closes only its sign-in tab and withholds private browser failures", async () => {
  const f = await fixture();
  await withNormalActorUiLogin(f.input, async ({ context }) => {
    f.context.request.get.mockResolvedValue({
      status: () => 200,
      json: async () => null,
      dispose: vi.fn(async () => {}),
    } as never);
    const signInPage = {
      ...f.page,
      close: vi.fn(async () => {}),
      goto: vi.fn(async () => {
        throw new Error(f.email + f.password);
      }),
    };
    f.context.newPage.mockResolvedValue(signInPage);
    try {
      await signInNormalActorInContext({ ...f.input, context });
      throw new Error("must reject");
    } catch (error) {
      expect(String(error)).not.toContain(f.email);
      expect(String(error)).not.toContain(f.password);
    }
    expect(signInPage.close).toHaveBeenCalledOnce();
    expect(f.page.close).not.toHaveBeenCalled();
    expect(f.context.close).not.toHaveBeenCalled();
  });
});

it("rejects recorded caller contexts and wrong post-login actors without touching the retained tab", async () => {
  const f = await fixture();
  await withNormalActorUiLogin(f.input, async ({ context }) => {
    const probeCalls = f.context.request.get.mock.calls.length;
    vi.spyOn(f.page, "video").mockReturnValue({} as never);
    await expect(signInNormalActorInContext({ ...f.input, context })).rejects.toMatchObject({
      code: "normal-actor-ui-login-unavailable",
    });
    expect(f.context.request.get).toHaveBeenCalledTimes(probeCalls);
    vi.spyOn(f.page, "video").mockReturnValue(null);
    const tab = { ...f.page, close: vi.fn(async () => {}) };
    f.context.newPage.mockResolvedValue(tab);
    f.context.request.get.mockResolvedValueOnce({
      status: () => 200,
      json: async () => null,
      dispose: vi.fn(async () => {}),
    } as never);
    f.context.request.get.mockResolvedValue({
      status: () => 200,
      json: async () => ({
        user: { id: "foreign" },
        session: { userId: "foreign", activeOrganizationId: "tenant" },
      }),
      dispose: vi.fn(async () => {}),
    });
    await expect(signInNormalActorInContext({ ...f.input, context })).rejects.toMatchObject({
      code: "normal-actor-ui-login-unavailable",
    });
    expect(tab.close).toHaveBeenCalledOnce();
    expect(f.page.close).not.toHaveBeenCalled();
    expect(f.context.close).not.toHaveBeenCalled();
  });
});
