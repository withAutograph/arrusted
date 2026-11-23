// A private PostgreSQL cluster with the realm's Auth schema, and the HTTP
// steps of the agent OAuth flow (register, authorize, pick the organization,
// consent, token) as an MCP client and its signed-in user perform them.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashPassword } from "better-auth/crypto";
import { Pool } from "pg";

import { agentResourceIdentifier } from "../agent-grant-policy";
import { createAuth } from "../server";

const password = randomBytes(12).toString("hex");
let scratch = "";
let port = 0;
let started = false;
const pools: Pool[] = [];

function command(name: string, args: string[]) {
  const result = spawnSync(name, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${name} failed: ${result.stderr}`);
}

export async function startCluster() {
  scratch = await mkdtemp(path.join(tmpdir(), "auth-agent-grant-"));
  port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("no port"));
      server.close(() => resolve(address.port));
    });
  });
  await writeFile(path.join(scratch, "pwfile"), password);
  command("initdb", [
    "-D",
    path.join(scratch, "data"),
    "-U",
    "postgres",
    "--auth=scram-sha-256",
    `--pwfile=${path.join(scratch, "pwfile")}`,
    "--no-locale",
    "--encoding=UTF8",
  ]);
  command("pg_ctl", [
    "-D",
    path.join(scratch, "data"),
    "-l",
    path.join(scratch, "pg.log"),
    "-o",
    `-h 127.0.0.1 -p ${port} -k ${scratch}`,
    "-w",
    "start",
  ]);
  started = true;
}

export async function stopCluster() {
  for (const pool of pools) await pool.end().catch(() => {});
  if (started) command("pg_ctl", ["-D", path.join(scratch, "data"), "-m", "fast", "-w", "stop"]);
  if (scratch) await rm(scratch, { recursive: true, force: true });
}

const root = path.resolve(import.meta.dirname, "..");
export const ORIGIN = "http://127.0.0.1:4555";
export const APP = "canvas";
export const RESOURCE = agentResourceIdentifier(ORIGIN, APP);
/** A second enrolled app, granted by org-a only. */
export const APP2 = "ledger";
export const RESOURCE2 = agentResourceIdentifier(ORIGIN, APP2);
export const ISSUER = `${ORIGIN}/api/auth`;
export const USER_PASSWORD = "agent-grant-password";

/** A fresh Auth database with the realm schema, two organizations and two users. */
export async function realm(
  options: { appIds?: readonly string[]; env?: Record<string, string> } = {},
) {
  const name = `realm_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const admin = new Pool({
    connectionString: `postgresql://postgres:${password}@127.0.0.1:${port}/postgres`,
    max: 1,
  });
  await admin.query(`create database ${name}`);
  await admin.end();
  const url = `postgresql://postgres:${password}@127.0.0.1:${port}/${name}`;
  const pool = new Pool({ connectionString: url, max: 6 });
  pools.push(pool);
  await pool.query(await readFile(path.join(root, "schema.sql"), "utf8"));
  await pool.query(
    (await readFile(path.join(root, "provision-organizations.sql"), "utf8")).replace(
      "__CATALOG_APP_IDS__",
      JSON.stringify([APP]),
    ),
  );
  const users = { member: "user-member", other: "user-other" };
  for (const [index, id] of Object.values(users).entries()) {
    await pool.query(
      `insert into "user" ("id","name","email","emailVerified") values ($1,$2,$3,true)`,
      [id, `User ${index}`, `${id}@example.test`],
    );
    await pool.query(
      `insert into "account" ("id","accountId","providerId","userId","password","updatedAt")
       values ($1,$2,'credential',$2,$3,now())`,
      [`account-${id}`, id, await hashPassword(USER_PASSWORD)],
    );
  }
  for (const [id, apps] of [
    ["org-a", [APP, APP2]],
    ["org-b", [APP]],
    ["org-c", ["other-app"]],
  ] as const) {
    await pool.query(
      `insert into "organization" ("id","name","slug","createdAt","appIds") values ($1,$1,$1,now(),$2::jsonb)`,
      [id, JSON.stringify(apps)],
    );
    await pool.query(
      `insert into "member" ("id","organizationId","userId","role","createdAt") values ($1,$2,$3,'member',now())`,
      [`${id}:${users.member}`, id, users.member],
    );
  }
  // The member works in org-a and org-b; org-c does not grant the app.
  // Only org-a also grants the second app.
  for (const organizationId of ["org-a", "org-b"])
    await pool.query(
      `insert into "app_actor_assignment" ("organizationId","actorId","appId","role","active","fence_generation")
       values ($1,$2,$3,'member',true,1)`,
      [organizationId, users.member, APP],
    );
  await pool.query(
    `insert into "app_actor_assignment" ("organizationId","actorId","appId","role","active","fence_generation")
     values ('org-a',$1,$2,'member',true,1)`,
    [users.member, APP2],
  );
  const env = {
    PLATFORM_AUTH_DATABASE_URL: url,
    BETTER_AUTH_URL: ORIGIN,
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    BETTER_AUTH_APP_NAME: "Agent grant test",
    PLATFORM_AUTH_TRUSTED_ORIGINS: ORIGIN,
    ...options.env,
  };
  const auth = createAuth({
    appName: "Agent grant test",
    env,
    databaseOverride: pool,
    agentAppIds: options.appIds ?? [APP, APP2],
  });
  return { pool, auth, users, env };
}

export type Realm = Awaited<ReturnType<typeof realm>>;

/** One HTTP call to the realm's Better Auth handler. */
export async function call(
  r: Realm,
  method: string,
  pathAndQuery: string,
  options: {
    body?: unknown;
    form?: Record<string, string>;
    cookie?: string;
    /** false: no Origin (a server); a string: that browser origin. */
    origin?: boolean | string;
    /** Serve through this handler instead of the realm's own. */
    handler?: (request: Request) => Promise<Response>;
  } = {},
) {
  const headers = new Headers({ accept: "application/json" });
  if (options.cookie) headers.set("cookie", options.cookie);
  if (typeof options.origin === "string") headers.set("origin", options.origin);
  else if (options.origin !== false && method !== "GET") headers.set("origin", ORIGIN);
  let body: BodyInit | undefined;
  if (options.form) {
    headers.set("content-type", "application/x-www-form-urlencoded");
    body = new URLSearchParams(options.form).toString();
  } else if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.body);
  }
  const response = await (options.handler ?? ((request) => r.auth.handler(request)))(
    new Request(`${ORIGIN}${pathAndQuery}`, { method, headers, ...(body ? { body } : {}) }),
  );
  const text = await response.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { response, json, text };
}

export async function signIn(r: Realm, email: string, oauthQuery?: string) {
  const { response, json } = await call(r, "POST", "/api/auth/sign-in/email", {
    body: { email, password: USER_PASSWORD, ...(oauthQuery ? { oauth_query: oauthQuery } : {}) },
  });
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  return { cookie, json, status: response.status };
}

export async function register(r: Realm, body: Record<string, unknown> = {}) {
  return await call(r, "POST", "/api/auth/oauth2/register", {
    origin: false,
    body: {
      client_name: "Test agent",
      redirect_uris: ["http://localhost:33418/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...body,
    },
  });
}

export function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

const signedQuery = (location: string) => new URL(location, ORIGIN).search.slice(1);

/**
 * The full authorization-code flow for `clientId`, as the signed-in user:
 * the organization page picks `organizationId`, the consent page accepts.
 * Returns the token response and the redirect each page received.
 */
export async function authorize(
  r: Realm,
  input: {
    clientId: string;
    cookie: string;
    organizationId: string;
    resource?: string;
    redirectUri?: string;
    /** Stop at the consent page without accepting it. */
    stopAtConsent?: boolean;
    /** Exchange the code without a PKCE verifier. */
    omitVerifier?: boolean;
    /** Return the authorization code without exchanging it. */
    stopBeforeExchange?: boolean;
  },
) {
  const { verifier, challenge } = pkce();
  const redirectUri = input.redirectUri ?? "http://localhost:51234/callback";
  const query = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: redirectUri,
    scope: "work_session offline_access",
    state: randomUUID(),
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: input.resource ?? RESOURCE,
  });
  const start = await call(r, "GET", `/api/auth/oauth2/authorize?${query}`, {
    cookie: input.cookie,
  });
  const organizationPage = String(start.json?.url ?? start.response.headers.get("location"));
  const oauthQuery = signedQuery(organizationPage);
  const context = await call(r, "POST", "/api/auth/agent-grant/context", {
    cookie: input.cookie,
    body: { oauth_query: oauthQuery },
  });
  const pick = await call(r, "POST", "/api/auth/agent-grant/organization", {
    cookie: input.cookie,
    body: { oauth_query: oauthQuery, organizationId: input.organizationId },
  });
  const continued = await call(r, "POST", "/api/auth/oauth2/continue", {
    cookie: input.cookie,
    body: { oauth_query: oauthQuery, postLogin: true },
  });
  const next = String(continued.json?.url ?? "");
  let codeUrl = next;
  if (next.includes("/auth/oauth/consent") && input.stopAtConsent !== true) {
    const consent = await call(r, "POST", "/api/auth/oauth2/consent", {
      cookie: input.cookie,
      body: { accept: true, oauth_query: signedQuery(next) },
    });
    codeUrl = String(consent.json?.url ?? "");
  }
  const code = codeUrl.startsWith(redirectUri) ? new URL(codeUrl).searchParams.get("code") : null;
  const token =
    code && input.stopBeforeExchange !== true
      ? await call(r, "POST", "/api/auth/oauth2/token", {
          origin: false,
          form: {
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            client_id: input.clientId,
            ...(input.omitVerifier === true ? {} : { code_verifier: verifier }),
            resource: input.resource ?? RESOURCE,
          },
        })
      : null;
  return {
    start,
    organizationPage,
    context,
    pick,
    continued,
    next,
    codeUrl,
    code,
    token,
    verifier,
  };
}
