import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import type { Pool } from "pg";
import type { RealmOperatorIdentity } from "../../../../packages/auth/operator-identity";
import type { AuthDatabaseResource } from "../../../../packages/auth/database-resource";
import { issueRealmOperatorLinkProof } from "../../../../packages/auth/operator-identity-link";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
/** Actual compiled file-spool ABI, owned loopback verifier and database. No provider credentials or OIDC replacement. */
export async function checkCompiledMembershipWorker(input: {
  root: string;
  resource: AuthDatabaseResource;
  connection: string;
  owner: Pool;
  identity?: RealmOperatorIdentity;
  revokeSession?: () => Promise<void>;
}): Promise<number> {
  const built = path.join(input.root, "compiled");
  await mkdir(built, { recursive: true });
  const bundle = spawnSync(
    "bun",
    [".config/mise/scripts/repository/build-protected-auth-worker.mjs", built],
    { encoding: "utf8" },
  );
  assert.equal(bundle.status, 0, "native bundle");
  const executable = path.join(built, "auth-worker");
  const compile = spawnSync(
    "bun",
    [
      "build",
      "--compile",
      path.join(built, "protected-installer-worker.js"),
      "--outfile",
      executable,
    ],
    { encoding: "utf8" },
  );
  assert.equal(compile.status, 0, "native compile");
  const keys = generateKeyPairSync("ed25519");
  const jwk = { ...keys.publicKey.export({ format: "jwk" }), kid: "owned-key" };
  let reads = 0;
  const server = createServer((request, response) => {
    assert.equal(request.url, "/_platform/jwks.json");
    assert.equal(request.headers["x-vercel-trusted-oidc-idp-token"], undefined);
    reads++;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture_address");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const nonce = "1".repeat(64);
  const actualIdentity: RealmOperatorIdentity = input.identity ?? {
    version: 1,
    actorId: "normal-user",
    sessionId: "normal-session",
    organizationId: null,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  const issueProof = (identity: RealmOperatorIdentity, selectedNonce: string) =>
    issueRealmOperatorLinkProof({
      identity,
      resource: input.resource,
      challenge: {
        nonce: selectedNonce,
        ownerSessionId: "actual-builder-session",
        bootstrapPlanDigest: "a".repeat(64),
        authResourceId: "owned-auth",
        organizationId: null,
      },
      config: {
        browserOrigin: "https://realm.example",
        builderCallbackOrigin: "https://builder.example",
        builderCallbackPath: "/api/hosted-operator/realm-identity",
        operatorOrigin: "https://operator.example",
      },
      issuer: "https://realm.example",
      keyId: "owned-key",
      privateKey: keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    });
  const proof = issueProof(actualIdentity, nonce);
  let addedChecks = 0;
  let expiredProof: string | undefined;
  let expiredCapture: { capturedAt: string; realmSessionId: string } | undefined;
  const membership = {
    actorId: input.identity?.actorId ?? "normal-user",
    bootstrapPlanDigest: "a".repeat(64),
    identityNonceSha256: digest(nonce),
    identityProof: { reference: "private-proof", sha256: digest(proof) },
    identityVerification: {
      audience: "https://operator.example",
      issuer: "https://realm.example",
      jwksUrl: `${endpoint}/_platform/jwks.json`,
    },
    kind: "create-owned-organization",
    name: "Compiled approved organization",
    organizationId: "compiled-org",
    slug: "compiled-org",
  };
  const authoritativeCapture = {
    capturedAt: new Date().toISOString(),
    realmSessionId: input.identity?.sessionId ?? "normal-session",
  };
  async function run(
    options: {
      remote?: boolean;
      changedActor?: boolean;
      denyFence?: boolean;
      readOnly?: boolean;
      changedName?: boolean;
      captured?: boolean;
      forgedCapture?: boolean;
      expired?: boolean;
      namespaced?: boolean;
      secondOrganization?: boolean;
      wrongOrganization?: boolean;
      wrongKind?: boolean;
      undeclared?: boolean;
      duplicate?: boolean;
      wrongOrder?: boolean;
      mixedPolicy?: boolean;
      foreignCompanion?: boolean;
    } = {},
  ) {
    if (options.namespaced || options.wrongOrder) addedChecks += 1;
    const selectedProof = options.expired ? expiredProof! : proof;
    const selectedCapture = options.expired ? expiredCapture! : authoritativeCapture;
    const spool = path.join(input.root, randomUUID());
    const startup = path.join(spool, "startup");
    for (const name of ["startup", "requests", "responses"])
      await mkdir(path.join(spool, name), { recursive: true, mode: 0o700 });
    const selectedEndpoint = options.remote ? "https://remote.example" : endpoint;
    const selectedMembership = {
      ...membership,
      identityProof: {
        reference: options.expired ? "expired-private-proof" : "private-proof",
        sha256: digest(selectedProof),
      },
      identityNonceSha256: options.expired
        ? digest("2".repeat(64))
        : membership.identityNonceSha256,
      ...(options.changedActor ? { actorId: "sibling-user" } : {}),
      ...(options.changedName ? { name: "Changed intent" } : {}),
      ...(options.captured
        ? {
            organizationId: options.expired ? "expired-captured-org" : "captured-org",
            slug: options.expired ? "expired-captured-org" : "captured-org",
            identityCapture: options.forgedCapture
              ? {
                  ...selectedCapture,
                  capturedAt: new Date(Date.parse(selectedCapture.capturedAt) + 1).toISOString(),
                }
              : selectedCapture,
          }
        : {}),
      identityVerification: {
        ...membership.identityVerification,
        jwksUrl: `${selectedEndpoint}/_platform/jwks.json`,
      },
    };
    const namespaceOrganizations = options.mixedPolicy
      ? ["mixed-policy-org-a", "mixed-policy-org-b"]
      : ["namespaced-org-a", "namespaced-org-b"];
    const memberships = namespaceOrganizations.map((organizationId) => ({
      ...selectedMembership,
      organizationId,
      slug: organizationId,
    }));
    const selectedOrganizationId = options.namespaced
      ? namespaceOrganizations[options.secondOrganization ? 1 : 0]!
      : selectedMembership.organizationId;
    const selectedEffectId = options.namespaced
      ? `auth-membership:${selectedOrganizationId}`
      : "auth-membership";
    const declaredEffects: Array<{ id?: string; effectId?: string; kind: string }> =
      options.namespaced
        ? namespaceOrganizations.map((organizationId) => ({
            id: `auth-membership:${organizationId}`,
            kind: "auth-membership",
          }))
        : [{ effectId: "auth-membership", kind: "auth-membership" }];
    if (options.duplicate) declaredEffects.push({ ...declaredEffects[0]! });
    if (options.wrongOrder || options.mixedPolicy || options.foreignCompanion) {
      const policyId = options.foreignCompanion
        ? "auth-signup-policy:other-org"
        : options.namespaced && !options.mixedPolicy
          ? `auth-signup-policy:${selectedOrganizationId}`
          : "auth-signup-policy";
      const policyEffect = options.namespaced
        ? { id: policyId, kind: "auth-signup-policy" }
        : { effectId: policyId, kind: "auth-signup-policy" };
      if (options.wrongOrder) declaredEffects.unshift(policyEffect);
      else declaredEffects.push(policyEffect);
    }
    const plan = {
      version: 1,
      action: "prepare",
      effects: declaredEffects,
      authMembership: options.namespaced
        ? { kind: "create-owned-organizations", organizations: memberships }
        : selectedMembership,
      ...(options.namespaced
        ? {
            stage: "app",
            normalActorProgram: {
              appId: "fixture-app",
              origin: "https://realm.example",
              organizations: namespaceOrganizations.map((organizationId) => ({ organizationId })),
              appAccess: namespaceOrganizations.map((organizationId) => ({
                organizationId,
                roles: ["ordinary_role"],
              })),
            },
          }
        : {}),
      ...(options.wrongOrder || options.mixedPolicy || options.foreignCompanion
        ? {
            authSignupPolicy: {
              version: 1,
              policyId: "approved-policy",
              authResourceId: "owned-auth",
              appId: "fixture-app",
              origin: "https://realm.example",
              appPath: "/fixture-app",
              organizationId: selectedOrganizationId,
              eligibility: "public",
              membershipRole: "member",
              appRoles: ["ordinary_role"],
            },
          }
        : {}),
      selection: { sessionId: "actual-builder-session" },
      authDatabase: {
        database: input.resource.database,
        migratorRole: input.resource.migratorRole,
        runtimeRole: input.resource.runtimeRole,
        resourceId: "owned-auth",
      },
      neon: { endpoint: input.resource.hostname },
      deploymentBoundary: {
        teamId: "owned-team",
        operator: { projectId: "owned-project", environment: "preview" },
        verification: {
          publicOrigin: "https://realm.example",
          gatewayOrigin: selectedEndpoint,
          jwksUrl: `${selectedEndpoint}/_platform/jwks.json`,
        },
      },
    };
    const planDigest = digest(canonical(plan));
    const context = {
      version: 1,
      operation: { operation_id: randomUUID(), approval_digest: planDigest, fence_generation: 1 },
      app_id: "auth",
      resource: {
        resource_id: "owned-auth",
        environment: input.resource.environment,
        hostname: input.resource.hostname,
        port: input.resource.port,
        database: input.resource.database,
        schema: input.resource.schema,
        migrator_role: input.resource.migratorRole,
        runtime_role: input.resource.runtimeRole,
      },
      release: { id: planDigest, sha256: digest(selectedProof) },
      installer: { id: "auth-owned-organization-v1", sha256: "b".repeat(64) },
      tenant_targets: [],
    };
    const runId = randomUUID();
    for (const [name, value] of Object.entries({
      "context.json": context,
      "direct-database-url.json": input.connection,
      "operator-plan.json": plan,
      "membership-effect.json": {
        version: 1,
        effectId: options.undeclared
          ? "auth-membership:undeclared-org"
          : options.wrongOrganization
            ? `auth-membership:${namespaceOrganizations[options.secondOrganization ? 0 : 1]}`
            : selectedEffectId,
        kind: options.wrongKind ? "auth-signup-policy" : "auth-membership",
      },
      ...(options.namespaced
        ? { "membership-target.json": { organizationId: selectedOrganizationId } }
        : {}),
      "auth-database-resource.json": input.resource,
      "realm-identity-proof.json": { proof: selectedProof },
      "ready.json": { version: 1, run_id: runId, frame_id: 0 },
    }))
      await writeFile(path.join(startup, name), JSON.stringify(value), { mode: 0o600 });
    const frames: string[] = [];
    const child = spawn(
      executable,
      [
        options.readOnly ? "auth-protected-membership-readback" : "auth-protected-membership",
        "--file-spool",
        spool,
        runId,
        "5000",
      ],
      { env: { PATH: process.env.PATH, TMPDIR: spool }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let buffer = "";
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const notice = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (notice.kind !== "protected_installer_frame_ready") continue;
        const frame = JSON.parse(
          readFileSync(path.join(spool, "requests", `${notice.frame_id}.json`), "utf8"),
        );
        frames.push(frame.kind);
        const common = {
          version: 1,
          operation_id: frame.operation_id,
          context_digest: frame.context_digest,
          fence_generation: frame.fence_generation,
        };
        const reply =
          frame.kind === "check_fence"
            ? {
                ...common,
                kind: "fence_current",
                current: !options.denyFence && !options.forgedCapture,
              }
            : frame.kind === "authorize_effect"
              ? {
                  ...common,
                  kind: "effect_authorized",
                  sequence: frame.sequence,
                  effect_id: frame.effect_id,
                  allowed: frame.effect_id === "auth-membership",
                }
              : {
                  ...common,
                  kind: "checkpoint_recorded",
                  sequence: frame.sequence,
                  effect_id: frame.effect_id,
                  recorded: true,
                };
        writeFileSync(
          path.join(spool, "responses", `${notice.frame_id}.json`),
          JSON.stringify(reply),
          { mode: 0o600 },
        );
        writeFileSync(
          path.join(spool, "responses", `${notice.frame_id}.ready`),
          JSON.stringify({ version: 1, run_id: runId, frame_id: notice.frame_id }),
          { mode: 0o600 },
        );
      }
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", resolve);
    });
    const readback =
      options.readOnly && code === 0
        ? JSON.parse(readFileSync(path.join(spool, "readback.json"), "utf8"))
        : undefined;
    if (readback) {
      assert.equal(readback.operation_id, context.operation.operation_id);
      assert.equal(readback.context_digest, digest(JSON.stringify(context)));
      assert.equal(readback.fence_generation, context.operation.fence_generation);
      assert.match(readback.readback_sha256, /^[a-f0-9]{64}$/u);
    }
    return {
      code,
      frames,
      readback,
      failure: stderr.match(/Auth protected installer failed: ([a-z_]+)/u)?.[1],
    };
  }
  try {
    const absent = await run({ readOnly: true });
    assert.equal(absent.code, 0, absent.failure ?? "membership readback failed");
    assert.equal(absent.readback.status, "absent");
    assert.deepEqual(absent.frames, ["check_fence", "check_fence"]);
    assert.equal(
      (
        await input.owner.query("select count(*)::int as count from organization where id=$1", [
          membership.organizationId,
        ])
      ).rows[0].count,
      0,
    );
    const first = await run();
    assert.equal(first.code, 0);
    assert.equal(first.frames.filter((kind) => kind === "authorize_effect").length, 1);
    assert.equal(first.frames.filter((kind) => kind === "check_fence").length, 2);
    assert.equal((await run()).code, 0);
    const applied = await run({ readOnly: true });
    assert.equal(applied.code, 0);
    assert.equal(applied.readback.status, "applied");
    assert.deepEqual(applied.frames, ["check_fence", "check_fence"]);
    assert.notEqual((await run({ readOnly: true, changedName: true })).code, 0);
    const row = (
      await input.owner.query('select "appIds" from organization where id=$1', [
        membership.organizationId,
      ])
    ).rows[0];
    assert.deepEqual(row.appIds, []);
    assert.notEqual((await run({ changedActor: true })).code, 0);
    const denied = await run({ denyFence: true });
    assert.notEqual(denied.code, 0);
    assert.equal(denied.failure, "authority_denied");
    const before = reads;
    const remote = await run({ remote: true });
    assert.notEqual(remote.code, 0);
    assert.equal(remote.failure, "startup_rejected");
    assert.equal(reads, before, "local remote URL rejected before fetch");
    const countOrganizations = async () =>
      Number(
        (await input.owner.query("select count(*)::text as count from organization")).rows[0].count,
      );
    const namespaceBefore = await countOrganizations();
    for (const rejected of [
      { wrongOrganization: true },
      { wrongKind: true },
      { undeclared: true },
      { duplicate: true },
      { wrongOrder: true },
      { mixedPolicy: true, wrongOrder: true },
      { foreignCompanion: true },
    ]) {
      for (const readOnly of [true, false]) {
        const denied = await run({ namespaced: true, readOnly, ...rejected });
        assert.notEqual(denied.code, 0, "invalid selected full effect is denied");
        assert.equal(denied.failure, "startup_rejected");
        assert.deepEqual(
          denied.frames,
          [],
          "invalid org-scoped declaration never requests authority or records a checkpoint",
        );
        assert.equal(
          await countOrganizations(),
          namespaceBefore,
          "invalid effect creates no organization",
        );
      }
    }
    for (const readOnly of [true, false]) {
      const denied = await run({ wrongOrder: true, readOnly });
      assert.notEqual(denied.code, 0, "legacy membership still precedes signup policy");
      assert.equal(denied.failure, "startup_rejected");
      assert.deepEqual(denied.frames, []);
      assert.equal(await countOrganizations(), namespaceBefore);
    }
    const namespaceAbsent = await run({ namespaced: true, readOnly: true });
    assert.equal(namespaceAbsent.code, 0, namespaceAbsent.failure ?? "namespaced absent readback");
    assert.equal(namespaceAbsent.readback.status, "absent");
    assert.equal((await run({ namespaced: true })).code, 0);
    const namespaceApplied = await run({ namespaced: true, readOnly: true });
    assert.equal(
      namespaceApplied.code,
      0,
      namespaceApplied.failure ?? "namespaced applied readback",
    );
    assert.equal(namespaceApplied.readback.status, "applied");
    assert.equal((await run({ namespaced: true, secondOrganization: true })).code, 0);
    const secondApplied = await run({ namespaced: true, secondOrganization: true, readOnly: true });
    assert.equal(secondApplied.code, 0, secondApplied.failure ?? "second selected readback");
    assert.equal(secondApplied.readback.status, "applied");
    assert.equal(
      await countOrganizations(),
      namespaceBefore + 2,
      "each selected approved organization is created once",
    );
    assert.equal(
      (await run({ namespaced: true })).code,
      0,
      "same scoped effect replays without another organization",
    );
    assert.equal(await countOrganizations(), namespaceBefore + 2);
    const mixedBefore = await countOrganizations();
    const mixedAbsent = await run({ namespaced: true, mixedPolicy: true, readOnly: true });
    assert.equal(mixedAbsent.code, 0, mixedAbsent.failure ?? "mixed declared companion readback");
    assert.equal(mixedAbsent.readback.status, "absent");
    assert.equal(
      (await run({ namespaced: true, mixedPolicy: true })).code,
      0,
      "namespaced membership permits its declared bare policy companion",
    );
    const mixedApplied = await run({ namespaced: true, mixedPolicy: true, readOnly: true });
    assert.equal(mixedApplied.code, 0, mixedApplied.failure ?? "mixed companion applied readback");
    assert.equal(mixedApplied.readback.status, "applied");
    assert.equal(await countOrganizations(), mixedBefore + 1);
    const captured = await run({ captured: true });
    assert.equal(captured.code, 0);
    assert.equal(
      captured.frames[0],
      "check_fence",
      "canonical capture checked before accepting capture-time signature",
    );
    assert.equal(captured.frames.filter((kind) => kind === "check_fence").length, 3);
    const forged = await run({ captured: true, forgedCapture: true });
    assert.notEqual(forged.code, 0);
    assert.equal(forged.failure, "authority_denied");
    assert.deepEqual(forged.frames, ["check_fence"]);
    if (input.revokeSession) {
      // Restrict this owned fixture's transport proof lifetime; never change the native session expiry.
      expiredProof = issueProof(
        { ...actualIdentity, expiresAt: new Date(Date.now() + 3000).toISOString() },
        "2".repeat(64),
      );
      expiredCapture = {
        capturedAt: new Date().toISOString(),
        realmSessionId: actualIdentity.sessionId,
      };
      await new Promise((resolve) => setTimeout(resolve, 3500));
      assert.notEqual((await run({ expired: true })).code, 0, "expired raw transport is denied");
      assert.equal(
        (await run({ expired: true, captured: true })).code,
        0,
        "attested capture retains live session authority",
      );
      assert.notEqual((await run({ expired: true, captured: true, forgedCapture: true })).code, 0);
      await input.revokeSession();
      assert.notEqual(
        (await run({ expired: true, captured: true })).code,
        0,
        "native logout closes captured authority",
      );
      assert.notEqual((await run({ expired: true, captured: true, readOnly: true })).code, 0);
      return 21 + addedChecks;
    }
    return 16 + addedChecks;
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
