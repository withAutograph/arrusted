// The chat frame's sign-in: stored per canvas resource, person and
// organization; each frame bound to the identity it paired as and never
// adopting another's; a refresh naming someone else signs it out; pairing
// again clears the frame first; and loading the viewer never sticks on
// Loading: an unreachable server is a retryable failure, a refused sign-in
// returns to the sign-in panel.
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { DataDefinition } from "@autograph/generated-app-runtime/data";

import { createCanvasHttpClient } from "../client";
import { createFrameSession, FrameOfflineError, type FrameIdentity } from "../mcp-app/client";
import type { CanvasFrameConfig } from "../mcp-app/config";
import { loadViewer } from "../mcp-app/viewer";

const config = {
  resource: "https://apps.test/comp-canvas/api/canvas",
  canvasUrl: "https://apps.test/comp-canvas/api/canvas",
  tokenEndpoint: "https://apps.test/api/auth/oauth2/token",
  deviceEndpoint: "https://apps.test/api/auth/device/code",
  clientId: "autograph-canvas",
} as unknown as CanvasFrameConfig;

const ada: FrameIdentity = { personId: "user-ada", organizationId: "org-a" };
const ben: FrameIdentity = { personId: "user-ben", organizationId: "org-b" };
const adaInB: FrameIdentity = { personId: "user-ada", organizationId: "org-b" };

const jwt = (identity: FrameIdentity, n: number) =>
  [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(
      JSON.stringify({ sub: identity.personId, org: identity.organizationId, n }),
    ).toString("base64url"),
    "sig",
  ].join(".");
const subOf = (token: string | null) =>
  token === null
    ? null
    : (JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as {
        sub: string;
        org: string;
      });

/**
 * One fake authorization server: device codes approved as someone, refresh
 * tokens that rotate. `offline` makes the token endpoint unreachable;
 * `answerAs` makes a refresh answer for another identity.
 */
function fakeServer() {
  const devices = new Map<string, FrameIdentity | null>();
  const refreshTokens = new Map<string, FrameIdentity>();
  let issued = 0;
  const state = {
    offline: false,
    answerAs: null as FrameIdentity | null,
    viewer: 200 as 200 | 401 | "offline",
    refreshes: [] as string[],
    /** Hold the next token-endpoint call until `release`; `held` resolves once it waits. */
    hold: null as { release: Promise<void>; held: () => void } | null,
  };
  const tokens = (identity: FrameIdentity) => {
    issued += 1;
    const refresh = `refresh-${issued}`;
    refreshTokens.set(refresh, identity);
    return { access_token: jwt(identity, issued), refresh_token: refresh, expires_in: 900 };
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const send = async (url: string, init: RequestInit) => {
    if (url === config.canvasUrl) {
      if (state.viewer === "offline") throw new TypeError("fetch failed");
      return state.viewer === 401
        ? json({ ok: false, error: { code: "auth_required", message: "Sign in again." } }, 401)
        : json({ ok: true, value: { canApprove: false, authors: true } });
    }
    const form = new URLSearchParams(String(init.body));
    if (url === config.deviceEndpoint) {
      const code = `device-${devices.size + 1}`;
      devices.set(code, null);
      return json({ device_code: code, user_code: `CODE${devices.size}`, interval: 0 });
    }
    if (state.offline) throw new TypeError("fetch failed");
    if (state.hold !== null) {
      const { release, held } = state.hold;
      state.hold = null;
      held();
      await release;
    }
    if (form.get("grant_type") === "refresh_token") {
      const token = form.get("refresh_token")!;
      state.refreshes.push(token);
      const identity = refreshTokens.get(token);
      refreshTokens.delete(token);
      if (identity === undefined) return json({ error: "invalid_grant" }, 400);
      return json(tokens(state.answerAs ?? identity));
    }
    const identity = devices.get(form.get("device_code")!);
    if (identity === null || identity === undefined)
      return json({ error: "authorization_pending" }, 400);
    devices.delete(form.get("device_code")!);
    return json(tokens(identity));
  };
  return {
    state,
    send,
    /** Defer the next token-endpoint answer: `held` once it waits, `release` to answer. */
    defer() {
      let release!: () => void;
      let held!: () => void;
      const waiting = new Promise<void>((resolve) => (held = resolve));
      state.hold = { release: new Promise<void>((resolve) => (release = resolve)), held };
      return { held: waiting, release: () => release() };
    },
    /** The person approves the latest device code as `identity`. */
    approve(identity: FrameIdentity) {
      const code = [...devices.keys()].at(-1)!;
      devices.set(code, identity);
    },
  };
}

/** A frame of this origin, paired as `identity`. */
async function pairedFrame(server: ReturnType<typeof fakeServer>, identity: FrameIdentity) {
  const frame = createFrameSession(config, server.send);
  const pairing = await frame.pair();
  server.approve(identity);
  expect(await pairing.done).toBe(true);
  return frame;
}

/** Make the frame's access token due, so its next call refreshes. */
const expire = () => {
  const now = Date.now;
  Date.now = () => now() + 20 * 60_000;
  return () => {
    Date.now = now;
  };
};

let store: Map<string, string>;
beforeEach(() => {
  store = new Map();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
});
afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("the chat frame's sign-in", () => {
  test("stores each sign-in under its resource, person and organization", async () => {
    const server = fakeServer();
    await pairedFrame(server, ada);
    await pairedFrame(server, adaInB);
    const keys = [...store.keys()].toSorted();
    expect(keys).toEqual([
      `autograph-canvas:${config.resource}`,
      `autograph-canvas:${config.resource}:user-ada:org-a`,
      `autograph-canvas:${config.resource}:user-ada:org-b`,
    ]);
    // The resource's own key names who paired last, and holds no token.
    expect(JSON.parse(store.get(`autograph-canvas:${config.resource}`)!)).toEqual(adaInB);
  });

  test("two frames pairing as different people or organizations never adopt each other's identity", async () => {
    const server = fakeServer();
    const first = await pairedFrame(server, ada);
    const second = await pairedFrame(server, ben);
    const third = await pairedFrame(server, adaInB);
    expect(first.identity()).toEqual(ada);
    expect(second.identity()).toEqual(ben);
    expect(third.identity()).toEqual(adaInB);
    // Each refreshes its own stored sign-in and keeps working as itself.
    const restore = expire();
    try {
      expect(subOf(await first.bearer.token())).toMatchObject({ sub: "user-ada", org: "org-a" });
      expect(subOf(await second.bearer.token())).toMatchObject({ sub: "user-ben", org: "org-b" });
      expect(subOf(await third.bearer.token())).toMatchObject({ sub: "user-ada", org: "org-b" });
    } finally {
      restore();
    }
    // One signing out leaves the others signed in as themselves.
    second.signOut();
    expect(second.identity()).toBeNull();
    expect(first.hasStoredSignIn()).toBe(true);
    expect(third.hasStoredSignIn()).toBe(true);
    // A frame opened now works as the identity this origin paired as last.
    const opened = createFrameSession(config, server.send);
    expect(opened.identity()).toEqual(adaInB);
  });

  test("a refresh naming anyone else signs the frame out instead of switching it", async () => {
    const server = fakeServer();
    const frame = await pairedFrame(server, ada);
    const heard: boolean[] = [];
    frame.onChange((signedIn) => heard.push(signedIn));
    server.state.answerAs = ben;
    const restore = expire();
    try {
      expect(await frame.bearer.token()).toBeNull();
    } finally {
      restore();
    }
    expect(heard).toEqual([false]);
    expect(frame.identity()).toBeNull();
    expect(frame.hasStoredSignIn()).toBe(false);
    // Nothing of Ben's was kept.
    expect([...store.keys()].some((key) => key.includes("user-ben"))).toBe(false);
  });

  test("pairing again clears the frame before the new sign-in lands", async () => {
    const server = fakeServer();
    const frame = await pairedFrame(server, ada);
    const heard: boolean[] = [];
    frame.onChange((signedIn) => heard.push(signedIn));
    const pairing = await frame.pair();
    // Signed out at once: no token, no identity, while the new code is pending.
    expect(heard).toEqual([false]);
    expect(frame.identity()).toBeNull();
    server.approve(ben);
    expect(await pairing.done).toBe(true);
    expect(heard).toEqual([false, true]);
    expect(frame.identity()).toEqual(ben);
    expect(subOf(await frame.bearer.token())).toMatchObject({ sub: "user-ben" });
  });
});

describe("loading the viewer", () => {
  test("an unreachable token endpoint is a retryable failure; the sign-in stands", async () => {
    const server = fakeServer();
    await pairedFrame(server, ada);
    // The frame opens in a new chat: no access token yet, and the server is down.
    const frame = createFrameSession(config, server.send);
    server.state.offline = true;
    await expect(frame.bearer.token()).rejects.toBeInstanceOf(FrameOfflineError);
    expect(await loadViewer(config, frame, server.send)).toEqual({
      kind: "failed",
      message: "The canvas could not reach its server.",
    });
    expect(frame.hasStoredSignIn()).toBe(true);
    // Try again once it is back: the canvas loads.
    server.state.offline = false;
    expect(await loadViewer(config, frame, server.send)).toMatchObject({
      kind: "viewer",
      viewer: { canApprove: false, authors: true },
    });
  });

  test("an unreachable canvas API is a retryable failure", async () => {
    const server = fakeServer();
    const frame = await pairedFrame(server, ada);
    server.state.viewer = "offline";
    expect((await loadViewer(config, frame, server.send)).kind).toBe("failed");
    expect(frame.identity()).toEqual(ada);
  });

  test("a refused refresh or a refused token returns to the sign-in panel", async () => {
    const server = fakeServer();
    await pairedFrame(server, ada);
    const frame = createFrameSession(config, server.send);
    const heard: boolean[] = [];
    frame.onChange((signedIn) => heard.push(signedIn));
    // The stored refresh token was revoked.
    const key = `autograph-canvas:${config.resource}:user-ada:org-a`;
    store.set(key, JSON.stringify({ ...ada, refreshToken: "revoked" }));
    expect(await loadViewer(config, frame, server.send)).toEqual({ kind: "signed-out" });
    expect(heard).toEqual([false]);
    // And the canvas API refusing a token signs out too.
    const other = await pairedFrame(server, ben);
    server.state.viewer = 401;
    expect(await loadViewer(config, other, server.send)).toEqual({ kind: "signed-out" });
    expect(other.identity()).toBeNull();
  });
});

describe("late answers after the frame's auth moved on", () => {
  test("a refresh answered after sign-out signs nothing back in", async () => {
    const server = fakeServer();
    const frame = await pairedFrame(server, ada);
    const heard: boolean[] = [];
    frame.onChange((signedIn) => heard.push(signedIn));
    const restore = expire();
    try {
      const deferred = server.defer();
      const pending = frame.bearer.token();
      await deferred.held;
      frame.signOut();
      deferred.release();
      expect(await pending).toBeNull();
      expect(await frame.bearer.token()).toBeNull();
    } finally {
      restore();
    }
    expect(frame.identity()).toBeNull();
    expect(heard.includes(true)).toBe(false);
    // Nothing of Ada's is stored again by the late answer.
    expect([...store.keys()].some((key) => key.includes("user-ada"))).toBe(false);
  });

  test("a refresh answered after pairing again as someone else never hands out the old identity", async () => {
    const server = fakeServer();
    const frame = await pairedFrame(server, ada);
    const restore = expire();
    try {
      const deferred = server.defer();
      const pending = frame.bearer.token();
      await deferred.held;
      // The person pairs this frame again, as Ben, while Ada's refresh is out.
      const pairing = await frame.pair();
      server.approve(ben);
      const done = pairing.done;
      deferred.release();
      expect(await pending).toBeNull();
      expect(await done).toBe(true);
      expect(frame.identity()).toEqual(ben);
      expect(subOf(await frame.bearer.token())).toMatchObject({ sub: "user-ben", org: "org-b" });
    } finally {
      restore();
    }
    // Ada's rotated refresh token is kept for her other frames, not this one.
    const adaKey = `autograph-canvas:${config.resource}:user-ada:org-a`;
    const stored = JSON.parse(store.get(adaKey)!) as { refreshToken: string };
    expect(server.state.refreshes).toContain("refresh-1");
    expect(stored.refreshToken).not.toBe("refresh-1");
    const other = createFrameSession(config, server.send);
    expect(other.identity()).toEqual(ben);
  });

  test("a device poll answered after sign-out ends the pairing signed out", async () => {
    const server = fakeServer();
    const frame = createFrameSession(config, server.send);
    const heard: boolean[] = [];
    frame.onChange((signedIn) => heard.push(signedIn));
    const deferred = server.defer();
    const pairing = await frame.pair();
    server.approve(ada);
    await deferred.held;
    frame.signOut();
    deferred.release();
    expect(await pairing.done).toBe(false);
    expect(frame.identity()).toBeNull();
    expect(await frame.bearer.token()).toBeNull();
    expect(heard.includes(true)).toBe(false);
  });

  test("a mutation waiting on Ada's refresh is never sent as Ben, who paired meanwhile", async () => {
    const server = fakeServer();
    const frame = await pairedFrame(server, ada);
    const sentAs: (string | null)[] = [];
    const client = createCanvasHttpClient(
      { url: config.canvasUrl, bearer: frame.bearer },
      { formatVersion: 1, schemaVersion: "v1", models: [] } as unknown as DataDefinition,
      {
        canApprove: false,
        authors: false,
        fetch: async (url, init) => {
          const authorization = new Headers(init.headers).get("authorization");
          sentAs.push(authorization === null ? null : String(subOf(authorization.slice(7))?.sub));
          return await server.send(url, init);
        },
      },
    );
    const restore = expire();
    try {
      const deferred = server.defer();
      // Ada stages; her token is being refreshed.
      const mutation = client.session
        .request({
          operation: "stage",
          session_id: "s",
          changes: [],
        } as never)
        .then(
          () => "sent",
          () => "refused",
        );
      await deferred.held;
      // Ben finishes pairing this frame before Ada's refresh answers.
      const pairing = await frame.pair();
      server.approve(ben);
      expect(await pairing.done).toBe(true);
      deferred.release();
      expect(await mutation).toBe("refused");
      expect(sentAs).toEqual([]);
      expect(frame.identity()).toEqual(ben);
    } finally {
      restore();
    }
  });

  test("a late 401 for the old identity's token leaves the new sign-in standing", async () => {
    const server = fakeServer();
    const frame = await pairedFrame(server, ada);
    const adaToken = await frame.bearer.token();
    const pairing = await frame.pair();
    server.approve(ben);
    expect(await pairing.done).toBe(true);
    frame.bearer.refused(adaToken!);
    expect(frame.identity()).toEqual(ben);
    // A refusal of the token it holds signs it out.
    frame.bearer.refused((await frame.bearer.token())!);
    expect(frame.identity()).toBeNull();
  });
});
