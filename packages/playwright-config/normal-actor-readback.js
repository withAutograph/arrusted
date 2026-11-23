import path from "node:path";
import { Pool } from "pg";
import { createPostgresDataContext } from "@autograph/generated-app-runtime/postgres";
import {
  readPostgresAppActorAccess,
  readPostgresAppActorBinding,
} from "@autograph/generated-app-runtime/actor-binding";
import { verifyCheckedRelease } from "@autograph/generated-app-runtime/release-verification";
import { readProtectedNormalActorFixture } from "./normal-actor-private-fixture.js";

import diagnostics from "./private-browser-diagnostics.cjs";

const { markPrivateBrowserError, readbackDiagnosticMessage } = diagnostics;

const errorCodes = new WeakMap();
const supportedErrors = new Set([
  "runtime_unavailable",
  "actor_not_authorized",
  "scope_closed",
  "release_unavailable",
  "readback_unavailable",
]);
/** Never retain database URLs, records, credentials or raw query/assertion diagnostics. */
export class NormalActorReadbackError extends Error {
  constructor(code) {
    const selected = supportedErrors.has(code) ? code : "readback_unavailable";
    super(readbackDiagnosticMessage(selected));
    this.name = "NormalActorReadbackError";
    this.code = selected;
    errorCodes.set(this, selected);
  }
}
const fail = (code) => new NormalActorReadbackError(code);
const connection = (raw, database, principal) => {
  const url = new URL(raw);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    decodeURIComponent(url.pathname.slice(1)) !== database ||
    decodeURIComponent(url.username) !== principal ||
    !url.password ||
    url.hash ||
    [...url.searchParams.keys()].some((key) => key !== "sslmode")
  )
    throw fail("runtime_unavailable");
  return url;
};
const inspectRole = async (pool, database, principal, marker) => {
  const result = await pool.query(`select current_user as principal, session_user as login,
    current_database() as database, r.rolsuper, r.rolcreatedb, r.rolcreaterole,
    r.rolreplication, r.rolbypassrls,
    shobj_description(r.oid, 'pg_authid') as role_marker,
    shobj_description((select oid from pg_database where datname=current_database()), 'pg_database') as database_marker
    from pg_roles r where r.rolname=current_user`);
  const role = result.rows[0];
  if (
    result.rows.length !== 1 ||
    role.principal !== principal ||
    role.login !== principal ||
    role.database !== database ||
    role.role_marker !== marker ||
    role.database_marker !== marker ||
    [
      role.rolsuper,
      role.rolcreatedb,
      role.rolcreaterole,
      role.rolreplication,
      role.rolbypassrls,
    ].some((value) => value !== false)
  ) {
    throw fail("runtime_unavailable");
  }
};

/** Independent restricted database reads for the selected existing local fixture; no SQL or pool escapes. */
export async function withNormalActorReadback(input, readback) {
  let app;
  let auth;
  let active = true;
  let failure;
  try {
    const fixture = await readProtectedNormalActorFixture(input);
    const { plan, identity } = fixture;
    const roleless =
      plan.roles.length === 0 &&
      identity.roles.length === 0 &&
      identity.role === null &&
      identity.access === "admitted";
    const named =
      identity.roles.length === 1 &&
      plan.roles.includes(identity.roles[0]) &&
      identity.access !== "unassigned";
    if (
      plan.appId !== input.appId ||
      plan.environment !== "local" ||
      identity.organizationId === null ||
      (!roleless && !named) ||
      !plan.tenants.includes(identity.organizationId)
    ) {
      throw fail("actor_not_authorized");
    }
    const role = roleless ? null : identity.roles[0];
    const authPrincipal = plan.authPrincipal ?? `${plan.principal}_auth`;
    const appUrl = connection(fixture.appRuntimeUrl, plan.database, plan.principal);
    const authUrl = connection(fixture.authRuntimeUrl, plan.authDatabase, authPrincipal);
    if (appUrl.host !== authUrl.host) throw fail("runtime_unavailable");
    app = new Pool({ connectionString: appUrl.toString(), max: 2 });
    auth = new Pool({ connectionString: authUrl.toString(), max: 1 });
    app.on("error", () => {});
    auth.on("error", () => {});
    const appMarker = `app-validation:${plan.runtimeId}:${plan.appId}`;
    const authMarker =
      plan.authScope === "context"
        ? `app-validation-context:${plan.environment}:${plan.runtimeId}`
        : appMarker;
    const current = async () => {
      if (!active) throw fail("scope_closed");
      await fixture.assertCurrent();
      await inspectRole(app, plan.database, plan.principal, appMarker);
      await inspectRole(auth, plan.authDatabase, authPrincipal, authMarker);
      const privileges = await auth.query(`select
        has_table_privilege(current_user, 'public.app_actor_assignment', 'INSERT,UPDATE,DELETE,TRUNCATE') as assignment_writable,
        has_table_privilege(current_user, 'public.app_signup_policy', 'INSERT,UPDATE,DELETE,TRUNCATE') as policy_writable`);
      if (
        privileges.rows.length !== 1 ||
        privileges.rows[0].assignment_writable !== false ||
        privileges.rows[0].policy_writable !== false
      )
        throw fail("runtime_unavailable");
      const scope = {
        pool: app,
        actorId: identity.actorId,
        appId: plan.appId,
        organizationId: identity.organizationId,
      };
      let binding;
      if (roleless) {
        const admissionPrivileges = await auth.query(`select
          (has_table_privilege(current_user, 'public.app_actor_access', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            or has_any_column_privilege(current_user, 'public.app_actor_access', 'INSERT,UPDATE,REFERENCES')) as admission_writable`);
        if (
          admissionPrivileges.rows.length !== 1 ||
          admissionPrivileges.rows[0].admission_writable !== false
        )
          throw fail("runtime_unavailable");
        const admission = await auth.query(
          `select a.roles,a."fenceGeneration" from public.app_actor_access a join public.member m
          on m."organizationId"=a."organizationId" and m."userId"=a."actorId"
          where a."appId"=$1 and a."organizationId"=$2 and a."actorId"=$3
            and a."workspaceId"=$4 and a.active and a.roles='[]'::jsonb`,
          [plan.appId, identity.organizationId, identity.actorId, authMarker],
        );
        const grant = admission.rows[0];
        const generation = Number(grant?.fenceGeneration);
        if (
          admission.rows.length !== 1 ||
          !Array.isArray(grant?.roles) ||
          grant.roles.length !== 0 ||
          !Number.isSafeInteger(generation) ||
          generation <= 0
        )
          throw fail("actor_not_authorized");
        binding = await readPostgresAppActorAccess(scope);
        if (binding?.fenceGeneration !== generation) throw fail("actor_not_authorized");
      } else {
        const assignment = await auth.query(
          `select a.role from public.app_actor_assignment a join public.member m
          on m."organizationId"=a."organizationId" and m."userId"=a."actorId"
          where a."appId"=$1 and a."organizationId"=$2 and a."actorId"=$3 and a.role=$4 and a.active`,
          [plan.appId, identity.organizationId, identity.actorId, role],
        );
        if (assignment.rows.length !== 1 || assignment.rows[0].role !== role)
          throw fail("actor_not_authorized");
        binding = await readPostgresAppActorBinding({ ...scope, role });
      }
      if (!binding?.active || binding.fenceGeneration <= 0) throw fail("actor_not_authorized");
      await fixture.assertCurrent();
      return binding;
    };
    const binding = await current();
    const appRoot = path.resolve(input.appRoot ?? process.cwd());
    const verifyRelease = () => {
      const release = verifyCheckedRelease(
        path.join(appRoot, "schema", "release", plan.releaseId),
        path.join(appRoot, "schema", `${plan.appId}.cue`),
      );
      if (
        release.app !== plan.appId ||
        release.schema_version !== plan.releaseId ||
        release.hashes.schema !== plan.artifactHash
      )
        throw fail("release_unavailable");
    };
    const authorize = async () => {
      const actual = await current();
      if (actual.fenceGeneration !== binding.fenceGeneration) throw fail("actor_not_authorized");
    };
    const context = createPostgresDataContext({
      pool: app,
      appId: plan.appId,
      actorId: identity.actorId,
      customerId: identity.organizationId,
      actorBinding: { role, fenceGeneration: binding.fenceGeneration },
      sourceKind: "human",
      readOnly: true,
      authorize,
      verifyRelease,
    });
    const verifyInstalledRelease = async (session) => {
      const installed = await session.call("kernel_read_active_schema_revision", {});
      if (installed?.schema?.version !== plan.releaseId) throw fail("release_unavailable");
    };
    const view = Object.freeze({
      scope: context.scope,
      authorize,
      transaction: async (run) => {
        await authorize();
        return await context.transaction(
          async (session) =>
            await run(
              Object.freeze({
                actorId: session.actorId,
                sourceKind: session.sourceKind,
                call: async (operation, payload) => {
                  await authorize();
                  await verifyInstalledRelease(session);
                  const result = await session.call(operation, payload);
                  await verifyInstalledRelease(session);
                  await authorize();
                  return result;
                },
              }),
            ),
        );
      },
    });
    await context.transaction(verifyInstalledRelease);
    await readback(view);
    await authorize();
  } catch (error) {
    failure = fail(errorCodes.get(error) ?? "readback_unavailable");
  } finally {
    active = false;
    const close = async (pool) => {
      await pool?.end();
    };
    const closed = await Promise.allSettled([close(app), close(auth)]);
    if (failure === undefined && closed.some((result) => result.status === "rejected"))
      failure = fail("readback_unavailable");
  }
  if (failure !== undefined) {
    const code = failure.code;
    const stage = code === "readback_unavailable" ? code : `readback_${code}`;
    markPrivateBrowserError(failure, stage.replaceAll("_", "-"));
    throw failure;
  }
}
