// The person's canvas token inside the frame: the device sign-in (RFC 8628),
// the refresh token kept in localStorage per canvas resource, person and
// organization, refreshes serialized with the Web Locks API, and a failed
// refresh returning to the sign-in panel. Each frame is bound to the identity
// it paired as (or, opening, the one this origin last paired as) and never
// adopts another: a token for someone else signs it out. Tokens and codes
// stay in this frame: never in a tool result or model context.
import type { CanvasBearer } from "../client";

import type { CanvasFrameConfig } from "./config";

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/** Refresh a little before expiry, so a call never carries a token about to lapse. */
const EARLY_MS = 60_000;
/** The longest the frame polls one device sign-in. */
const POLL_LIMIT_MS = 10 * 60_000;

/** Who a frame works as: the person and the organization they picked. */
export type FrameIdentity = { personId: string; organizationId: string };
type Stored = FrameIdentity & { refreshToken: string };
type TokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
  error_description?: unknown;
};

/** The token endpoint could not be reached: the sign-in may still stand; retry. */
export class FrameOfflineError extends Error {
  constructor() {
    super("The canvas could not reach its server.");
    this.name = "FrameOfflineError";
  }
}

/** A started device sign-in: what the panel shows and how it finishes. */
export type CanvasPairing = {
  userCode: string;
  verificationUrl: string;
  /** Resolves once the person approved (true) or the sign-in ended (false). */
  done: Promise<boolean>;
  cancel(): void;
};

const claimsOf = (token: string): Record<string, unknown> => {
  try {
    const payload = token.split(".")[1] ?? "";
    const json = atob(payload.replace(/-/gu, "+").replace(/_/gu, "/"));
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
};

/** The identity an access token names, or null without one. */
const identityOf = (token: string): FrameIdentity | null => {
  const claims = claimsOf(token);
  return typeof claims.sub === "string" &&
    claims.sub !== "" &&
    typeof claims.org === "string" &&
    claims.org !== ""
    ? { personId: claims.sub, organizationId: claims.org }
    : null;
};
const sameIdentity = (a: FrameIdentity, b: FrameIdentity) =>
  a.personId === b.personId && a.organizationId === b.organizationId;

/** Storage that may be missing or throw (a sandboxed frame, cleared site data). */
const storage = {
  read<T>(key: string, valid: (value: Partial<T> | null) => boolean): T | null {
    try {
      const value = JSON.parse(globalThis.localStorage.getItem(key) ?? "null") as T | null;
      return valid(value as Partial<T> | null) ? value : null;
    } catch {
      return null;
    }
  },
  write(key: string, value: unknown) {
    try {
      if (value === null) globalThis.localStorage.removeItem(key);
      else globalThis.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Without storage the frame signs in again next time.
    }
  },
};
const isIdentity = (value: Partial<FrameIdentity> | null) =>
  typeof value?.personId === "string" && typeof value.organizationId === "string";

/** Run `task` holding the frame origin's lock for `key` (Web Locks), or directly without it. */
async function locked<T>(key: string, task: () => Promise<T>): Promise<T> {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  if (locks === undefined) return await task();
  return (await locks.request(key, task)) as T;
}

const delay = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });

/**
 * The frame's sign-in state for one canvas resource. `bearer` is what the
 * HTTP canvas client uses; `onChange` hears sign-in and sign-out. Stored
 * sign-ins are keyed by resource, person and organization; the resource's
 * own key names only the identity this origin last paired as.
 */
export function createFrameSession(
  config: CanvasFrameConfig,
  send: (url: string, init: RequestInit) => Promise<Response> = (url, init) =>
    globalThis.fetch(url, init),
) {
  const lastKey = `autograph-canvas:${config.resource}`;
  const keyOf = (identity: FrameIdentity) =>
    `${lastKey}:${encodeURIComponent(identity.personId)}:${encodeURIComponent(identity.organizationId)}`;
  const readStored = (identity: FrameIdentity) =>
    storage.read<Stored>(
      keyOf(identity),
      (value) => typeof value?.refreshToken === "string" && isIdentity(value),
    );
  /** The identity this frame works as; it changes only by pairing. */
  let bound: FrameIdentity | null = (() => {
    const last = storage.read<FrameIdentity>(lastKey, isIdentity);
    return last !== null && readStored(last) !== null
      ? { personId: last.personId, organizationId: last.organizationId }
      : null;
  })();
  let access: { token: string; expiresAt: number } | null = null;
  /**
   * The auth generation: bumped by sign-out and by a pairing's start and
   * finish. Every async step (a refresh, a device poll) captures it and, if
   * it changed meanwhile, commits nothing to this frame: a late answer never
   * signs the frame back in or hands out the identity it left.
   */
  let generation = 0;
  const listeners = new Set<(signedIn: boolean) => void>();
  const notify = (signedIn: boolean) => {
    for (const listener of [...listeners]) listener(signedIn);
  };

  const post = async (url: string, form: Record<string, string>): Promise<TokenResponse> => {
    const response = await send(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams(form).toString(),
      credentials: "omit",
      cache: "no-store",
    });
    return (await response.json().catch(() => ({}))) as TokenResponse;
  };

  /**
   * Keep a token response for `expected` (the bound identity; any, when
   * pairing), begun at generation `since`: the access token in memory, the
   * refresh token stored under its identity. Null when the response holds no
   * tokens, names someone else, or the frame's auth moved on since: then a
   * rotated refresh token is still stored for the frames still signed in as
   * that identity (its key still holds the token it rotated), but this frame
   * keeps nothing.
   */
  const keep = (
    response: TokenResponse,
    expected: FrameIdentity | null,
    since: number,
    rotated?: string,
  ): FrameIdentity | null => {
    if (typeof response.access_token !== "string" || typeof response.refresh_token !== "string")
      return null;
    const identity = identityOf(response.access_token);
    if (identity === null || (expected !== null && !sameIdentity(identity, expected))) return null;
    const stored = { ...identity, refreshToken: response.refresh_token };
    if (since !== generation) {
      if (rotated !== undefined && readStored(identity)?.refreshToken === rotated)
        storage.write(keyOf(identity), stored);
      return null;
    }
    const seconds = typeof response.expires_in === "number" ? response.expires_in : 900;
    access = { token: response.access_token, expiresAt: Date.now() + seconds * 1000 };
    storage.write(keyOf(identity), stored);
    return identity;
  };

  /** The access token, while it is current and names the bound identity. */
  const current = (): string | null => {
    if (access === null || bound === null || access.expiresAt - EARLY_MS <= Date.now()) return null;
    const identity = identityOf(access.token);
    return identity !== null && sameIdentity(identity, bound) ? access.token : null;
  };

  /** Forget this frame's sign-in (its stored token too) and show the sign-in panel. */
  const signOut = () => {
    const identity = bound;
    generation += 1;
    access = null;
    bound = null;
    if (identity !== null) {
      storage.write(keyOf(identity), null);
      const last = storage.read<FrameIdentity>(lastKey, isIdentity);
      if (last !== null && sameIdentity(last, identity)) storage.write(lastKey, null);
    }
    notify(false);
  };

  /**
   * Refresh once for the bound identity, serialized across every frame of
   * this origin. `stale` when the frame's auth moved on meanwhile.
   */
  const refresh = async (identity: FrameIdentity, since: number) =>
    await locked(keyOf(identity), async (): Promise<string | null | "stale"> => {
      if (since !== generation) return "stale";
      // Another frame may have rotated it meanwhile: use what is stored now.
      const stored = readStored(identity);
      if (stored === null) return null;
      const fresh = current();
      if (fresh !== null) return fresh;
      const response = await post(config.tokenEndpoint, {
        grant_type: "refresh_token",
        refresh_token: stored.refreshToken,
        client_id: config.clientId,
      }).catch(() => {
        throw new FrameOfflineError();
      });
      if (since !== generation) {
        keep(response, identity, since, stored.refreshToken);
        return "stale";
      }
      // A refused refresh, or a token for anyone else: signed out, never switched.
      return keep(response, identity, since) === null ? null : current();
    });

  const bearer: CanvasBearer = {
    /**
     * The access token for the bound identity, never another's; null when
     * signed out, or when the frame signed out or paired again while this
     * call waited; FrameOfflineError when unreachable.
     */
    token: async () => {
      const fresh = current();
      if (fresh !== null) return fresh;
      const identity = bound;
      if (identity === null) {
        signOut();
        return null;
      }
      const since = generation;
      const token = await refresh(identity, since);
      // Signed out or paired again meanwhile: the caller's work was captured
      // as someone the frame no longer is, so it gets no token at all.
      if (token === "stale" || since !== generation) return null;
      if (token === null) signOut();
      return token;
    },
    // Only a refusal of the token the frame holds signs it out: a late 401 for
    // a token from before a sign-out or a pairing changes nothing.
    refused: (token) => {
      if (token !== undefined && access?.token !== token) return;
      signOut();
    },
  };

  return {
    bearer,
    /** Who this frame works as, or null before it pairs. */
    identity: (): FrameIdentity | null => (bound === null ? null : { ...bound }),
    /** Whether this frame has a stored sign-in (it may still fail to refresh). */
    hasStoredSignIn: () => bound !== null && readStored(bound) !== null,
    onChange(listener: (signedIn: boolean) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    signOut,
    /**
     * Start a device sign-in; poll until it is approved, denied or expires.
     * The frame's canvas state is cleared first: until the new sign-in lands,
     * it works as no one.
     */
    async pair(): Promise<CanvasPairing> {
      generation += 1;
      const since = generation;
      if (access !== null || bound !== null) {
        access = null;
        bound = null;
        notify(false);
      }
      const started = (await post(config.deviceEndpoint, {
        client_id: config.clientId,
        scope: "canvas offline_access",
        resource: config.resource,
      })) as Record<string, unknown>;
      if (typeof started.device_code !== "string" || typeof started.user_code !== "string")
        throw new Error(
          typeof started.error_description === "string"
            ? started.error_description
            : "Sign-in could not start.",
        );
      const deviceCode = started.device_code;
      const controller = new AbortController();
      let interval = (typeof started.interval === "number" ? started.interval : 5) * 1000;
      const deadline = Date.now() + POLL_LIMIT_MS;
      const done = (async () => {
        // Superseded by a sign-out or another pairing: this one ends.
        const live = () => !controller.signal.aborted && since === generation;
        while (live() && Date.now() < deadline) {
          await delay(interval, controller.signal);
          if (!live()) return false;
          const response = await post(config.tokenEndpoint, {
            grant_type: DEVICE_GRANT,
            device_code: deviceCode,
            client_id: config.clientId,
          }).catch(() => ({}) as TokenResponse);
          if (!live()) return false;
          const identity = keep(response, null, since);
          if (identity !== null) {
            // The frame works as whoever approved; new frames open as them too.
            generation += 1;
            bound = identity;
            storage.write(lastKey, identity);
            notify(true);
            return true;
          }
          if (response.error === "slow_down") interval += 5000;
          else if (response.error !== "authorization_pending" && response.error !== undefined)
            return false;
        }
        return false;
      })();
      return {
        userCode: started.user_code,
        verificationUrl:
          typeof started.verification_uri_complete === "string"
            ? started.verification_uri_complete
            : `${config.deviceEndpoint}`,
        done,
        cancel: () => controller.abort(),
      };
    },
  };
}

export type FrameSession = ReturnType<typeof createFrameSession>;
