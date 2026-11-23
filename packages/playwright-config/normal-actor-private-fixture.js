import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { readNormalActorManifest, selectNormalActor } from "./normal-actors.js";

export class NormalActorFixtureError extends Error {
  constructor() {
    super("The current owned local actor fixture is unavailable.");
    this.name = "NormalActorFixtureError";
    this.code = "local-fixture-unavailable";
  }
}
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function canonicalDirectory(directory) {
  if (!path.isAbsolute(directory) || path.normalize(directory) !== directory) throw 0;
  const expected = path.join(await realpath(path.dirname(directory)), path.basename(directory));
  if ((await realpath(directory)) !== expected) throw 0;
  return expected;
}
async function readPrivate(file) {
  if (!path.isAbsolute(file) || (await realpath(file)) !== file) throw 0;
  const directory = await lstat(path.dirname(file));
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    (directory.mode & 0o077) !== 0 ||
    (process.getuid && directory.uid !== process.getuid())
  )
    throw 0;
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw 0;
    const bytes = await handle.readFile();
    return { value: JSON.parse(bytes.toString("utf8")), digest: hash(bytes) };
  } finally {
    await handle.close();
  }
}
/** Internal in-process scope. Credentials never become the public actor manifest. */
export async function readProtectedNormalActorFixture(input) {
  try {
    const environment = input.environment ?? process.env;
    const manifest = input.manifestPath ?? environment.APP_TEST_IDENTITIES_FILE;
    if (!manifest) throw 0;
    const directory = await canonicalDirectory(path.dirname(manifest));
    const file = path.join(directory, path.basename(manifest));
    const identities = await readPrivate(file);
    const raw = identities.value;
    if (
      !object(raw) ||
      raw.version !== 1 ||
      !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(raw.appId) ||
      !Array.isArray(raw.identities)
    )
      throw 0;
    if (input.appId !== undefined && input.appId !== raw.appId) throw 0;
    const context = environment.APP_TEST_RUNTIME_CONTEXT_DIR ?? environment.APP_RUNTIME_CONTEXT_DIR;
    const local = environment.APP_TEST_RUNTIME_STATE_DIR ?? environment.APP_RUNTIME_STATE_DIR;
    if (context !== undefined && local !== undefined) throw 0;
    const stateDirectory = await canonicalDirectory(context ?? local ?? directory);
    const expectedDirectory =
      context !== undefined ? path.join(stateDirectory, "apps", raw.appId) : stateDirectory;
    if (directory !== expectedDirectory) throw 0;
    const stateFile = path.join(stateDirectory, "state.json");
    const environmentFile = path.join(directory, "environment.json");
    const saved = await readPrivate(stateFile);
    const runtime = await readPrivate(environmentFile);
    const state = saved.value;
    const plan = context !== undefined ? state.installations?.[raw.appId]?.plan : state.plan;
    const names = ["database", "authDatabase", "principal"];
    const strings = (values) =>
      Array.isArray(values) &&
      values.every((value) => typeof value === "string" && value.length > 0) &&
      new Set(values).size === values.length;
    if (
      !object(plan) ||
      plan.version !== 1 ||
      plan.appId !== raw.appId ||
      plan.environment !== "local" ||
      typeof plan.runtimeId !== "string" ||
      plan.runtimeId.length === 0 ||
      !names.every(
        (name) => typeof plan[name] === "string" && /^[a-z_][a-z0-9_]*$/u.test(plan[name]),
      ) ||
      !strings(plan.tenants) ||
      !strings(plan.roles) ||
      typeof plan.releaseId !== "string" ||
      typeof plan.artifactHash !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(plan.artifactHash) ||
      (plan.authPrincipal !== undefined && !/^[a-z_][a-z0-9_]*$/u.test(plan.authPrincipal)) ||
      (plan.authScope !== undefined && plan.authScope !== "context") ||
      (context !== undefined &&
        (plan.authScope !== "context" ||
          state.version !== 2 ||
          state.environment !== "local" ||
          state.runtimeId !== plan.runtimeId))
    )
      throw 0;
    const baseURL = input.baseURL ?? environment.APP_TEST_BASE_URL;
    if (
      !baseURL ||
      new URL(baseURL).origin !== baseURL ||
      state.authOrigin !== baseURL ||
      runtime.value.APP_TEST_BASE_URL !== baseURL ||
      runtime.value.BETTER_AUTH_URL !== baseURL
    )
      throw 0;
    const identity = selectNormalActor(await readNormalActorManifest(file), input.selector);
    const matches = raw.identities.filter(
      (actor) =>
        actor.actorId === identity.actorId && actor.organizationId === identity.organizationId,
    );
    if (
      matches.length !== 1 ||
      !plan.tenants.includes(identity.organizationId) ||
      identity.roles.some((role) => !new Set(plan.roles).has(role))
    )
      throw 0;
    const actor = matches[0];
    const selectedRoles = actor.role === null ? [] : [actor.role];
    if (
      JSON.stringify(identity.roles) !== JSON.stringify(selectedRoles) ||
      (actor.access !== undefined && !["admitted", "unassigned"].includes(actor.access)) ||
      identity.storageState !== path.resolve(directory, actor.storageState)
    )
      throw 0;
    if (
      typeof actor.email !== "string" ||
      !actor.email.includes("@") ||
      typeof state.fixturePassword !== "string" ||
      state.fixturePassword.length === 0
    )
      throw 0;
    const appRuntimeUrl =
      runtime.value[`${raw.appId.toUpperCase().replaceAll("-", "_")}_DATABASE_URL`];
    const authRuntimeUrl = runtime.value.PLATFORM_AUTH_DATABASE_URL;
    if (typeof appRuntimeUrl !== "string" || typeof authRuntimeUrl !== "string") throw 0;
    const assertCurrent = async () => {
      try {
        await Promise.all(
          [
            [file, identities.digest],
            [stateFile, saved.digest],
            [environmentFile, runtime.digest],
          ].map(async ([target, digest]) => {
            if ((await readPrivate(target)).digest !== digest) throw 0;
          }),
        );
      } catch {
        throw new NormalActorFixtureError();
      }
    };
    await assertCurrent();
    return Object.freeze({
      plan: Object.freeze({
        ...plan,
        roles: Object.freeze([...plan.roles]),
        tenants: Object.freeze([...plan.tenants]),
      }),
      identity: Object.freeze({
        ...identity,
        roles: Object.freeze([...identity.roles]),
        role: actor.role,
        access: actor.access ?? (actor.role === null ? "unassigned" : "admitted"),
      }),
      appRuntimeUrl,
      authRuntimeUrl,
      assertCurrent,
      // This closure only fills the owned current Auth origin; it returns no credential value.
      async fillLoginFields(page) {
        await assertCurrent();
        if (new URL(page.url()).origin !== baseURL) throw new NormalActorFixtureError();
        const email = page.locator('input[type="email"]');
        const password = page.locator('input[type="password"]');
        if ((await email.count()) !== 1 || (await password.count()) !== 1)
          throw new NormalActorFixtureError();
        await email.fill(actor.email);
        await password.fill(state.fixturePassword);
        await assertCurrent();
      },
    });
  } catch {
    throw new NormalActorFixtureError();
  }
}
