import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const opaqueId = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/[\p{Cc}]/u.test(value));
const sqlName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u);
const maxFrameBytes = 1024 * 1024;

/** Rust `ProtectedInstallContext` version 1, preserving serde's field order for its digest. */
export const protectedInstallContextSchema = z
  .strictObject({
    version: z.literal(1),
    operation: z.strictObject({
      operation_id: opaqueId,
      approval_digest: hash,
      fence_generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    }),
    app_id: z.string().regex(/^[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?$/u),
    resource: z.strictObject({
      resource_id: opaqueId,
      environment: z.enum(["local", "preview", "production"]),
      hostname: z
        .string()
        .min(1)
        .max(253)
        .regex(/^[a-z0-9.-]+$/u),
      port: z.number().int().min(1).max(65535),
      database: sqlName,
      schema: z.literal("public"),
      migrator_role: sqlName,
      runtime_role: sqlName,
      provider_project_id: opaqueId.optional(),
      provider_branch_id: opaqueId.optional(),
    }),
    release: z.strictObject({ id: opaqueId, sha256: hash }),
    installer: z.strictObject({ id: opaqueId, sha256: hash }),
    tenant_targets: z.array(opaqueId),
  })
  .superRefine((context, ctx) => {
    if (
      context.resource.runtime_role === context.resource.migrator_role ||
      context.resource.database === "postgres" ||
      context.resource.database === "neondb" ||
      (context.app_id === "auth"
        ? context.tenant_targets.length !== 0
        : context.tenant_targets.length === 0) ||
      new Set(context.tenant_targets).size !== context.tenant_targets.length ||
      (context.resource.environment !== "local" &&
        (!context.resource.provider_project_id || !context.resource.provider_branch_id)) ||
      (context.resource.environment === "local" &&
        context.resource.hostname !== "localhost" &&
        !isLoopback(context.resource.hostname))
    )
      ctx.addIssue({ code: "custom", message: "Invalid protected installer context" });
  });

export type ProtectedInstallContext = z.infer<typeof protectedInstallContextSchema>;
export const resourceBootstrapContextSchema = z
  .strictObject({
    kind: z.literal("neon_resource_bootstrap"),
    version: z.literal(1),
    operation: z.strictObject({
      operation_id: opaqueId,
      approval_digest: hash,
      fence_generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    }),
    app_id: z.string().regex(/^[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?$/u),
    resource: z
      .strictObject({
        scope: z.enum(["app_database", "auth_database"]),
        resource_id: opaqueId,
        environment: z.enum(["local", "preview", "production"]),
        hostname: z
          .string()
          .min(1)
          .max(253)
          .regex(/^[a-z0-9.-]+$/u),
        port: z.number().int().min(1).max(65535),
        database: sqlName,
        migrator_role: sqlName,
        runtime_role: sqlName,
        maintenance_database: sqlName,
        bootstrap_role: sqlName,
        provider_project_id: opaqueId.optional(),
        provider_branch_id: opaqueId.optional(),
        provider_endpoint_id: opaqueId.optional(),
        credentials_sha256: hash,
      })
      .refine(
        (resource) =>
          resource.migrator_role !== resource.runtime_role &&
          resource.database !== resource.maintenance_database &&
          !["postgres", "neondb"].includes(resource.database) &&
          [resource.migrator_role, resource.runtime_role].every(
            (role) => role !== resource.bootstrap_role,
          ) &&
          (resource.environment === "local"
            ? resource.hostname === "127.0.0.1" &&
              resource.provider_project_id === undefined &&
              resource.provider_branch_id === undefined &&
              resource.provider_endpoint_id === undefined
            : resource.hostname.endsWith(".neon.tech") &&
              resource.provider_project_id !== undefined &&
              resource.provider_branch_id !== undefined &&
              resource.provider_endpoint_id !== undefined),
      ),
    release: z.strictObject({ id: opaqueId, sha256: hash }),
    installer: z.strictObject({ id: opaqueId, sha256: hash }),
    tenant_targets: z.tuple([]),
  })
  .superRefine((context, ctx) => {
    if (
      (context.resource.scope === "auth_database" && context.app_id !== "auth") ||
      (context.resource.scope === "app_database" && context.app_id === "auth")
    )
      ctx.addIssue({
        code: "custom",
        message: "Resource scope does not match its fixed app identity",
      });
  });

export type ResourceBootstrapContext = z.infer<typeof resourceBootstrapContextSchema>;

export const resourceBootstrapCredentialsSchema = z.strictObject({
  migratorPassword: z
    .string()
    .min(32)
    .max(512)
    .refine((value) => !/[\0\r\n]/u.test(value)),
  runtimePassword: z
    .string()
    .min(32)
    .max(512)
    .refine((value) => !/[\0\r\n]/u.test(value)),
});
export type ResourceBootstrapCredentials = z.infer<typeof resourceBootstrapCredentialsSchema>;

type AuthorityContext = {
  operation: { operation_id: string; approval_digest: string; fence_generation: number };
  app_id: string;
  resource: { resource_id: string };
  release: { id: string; sha256: string };
  installer: { id: string; sha256: string };
  tenant_targets: string[];
};
export type ProtectedInstallerFailureCode =
  | "startup_rejected"
  | "authority_denied"
  | "effect_failed"
  | "readback_unknown"
  | "protocol_failure"
  | "cancelled"
  | "timeout";
export const authStartupStageSchema = z.enum([
  "spool_open",
  "startup_plan_parse",
  "context_binding",
  "approved_plan_binding",
  "schema_options",
  "schema_replan",
  "migrator_preflight",
]);
export type AuthStartupStage = z.infer<typeof authStartupStageSchema>;
export const authStartupDomainCodeSchema = z.enum([
  "invalid_new_empty_auth_proposal",
  "invalid_auth_worker_startup",
  "auth_resource_mismatch",
  "auth_worker_context_mismatch",
  "auth_operator_plan_mismatch",
  "invalid_auth_schema_plan",
  "auth_schema_plan_mismatch",
  "migration_contention",
  "new_empty_public_namespace_occupied",
  "verified_schema_drift",
  "incomplete_schema_reconciliation_required",
  "incomplete_effect_plan_changed",
  "unowned_schema_history",
  "invalid_schema_history_tables",
  "exposed_schema_history",
  "configured_schema_mismatch",
  "schema_reconciliation_incomplete",
  "auth_configuration_error",
]);
export type AuthStartupDomainCode = z.infer<typeof authStartupDomainCodeSchema>;
export type AuthStartupFailure = {
  stage: AuthStartupStage;
  domain_code?: AuthStartupDomainCode;
};

/** Advisory metadata never changes admission or terminal lifecycle publication. */
const projectAuthStartupFailure = (value: unknown): AuthStartupFailure | undefined => {
  try {
    const stageValue: unknown = Object.getOwnPropertyDescriptor(value, "stage")?.value;
    const stage = authStartupStageSchema.safeParse(stageValue);
    if (!stage.success) return undefined;
    const codeValue: unknown = Object.getOwnPropertyDescriptor(value, "domain_code")?.value;
    const code = authStartupDomainCodeSchema.safeParse(codeValue);
    return { stage: stage.data, ...(code.success ? { domain_code: code.data } : {}) };
  } catch {
    return undefined;
  }
};
export type ProtectedEffectReceipt =
  | { state: "applied" | "no_change"; readback_sha256: string }
  | { state: "unknown" };

const markerSchema = z.strictObject({
  version: z.literal(1),
  run_id: opaqueId,
  frame_id: z.number().int().nonnegative(),
});
const authorizationReplySchema = z.strictObject({
  kind: z.literal("effect_authorized"),
  version: z.literal(1),
  operation_id: opaqueId,
  context_digest: hash,
  fence_generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  effect_id: opaqueId,
  allowed: z.boolean(),
});
const fenceReplySchema = z.strictObject({
  kind: z.literal("fence_current"),
  version: z.literal(1),
  operation_id: opaqueId,
  context_digest: hash,
  fence_generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  current: z.boolean(),
});
const checkpointReplySchema = z.strictObject({
  kind: z.literal("checkpoint_recorded"),
  version: z.literal(1),
  operation_id: opaqueId,
  context_digest: hash,
  fence_generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  effect_id: opaqueId,
  recorded: z.boolean(),
});
const receiptSchema = z.union([
  z.strictObject({ state: z.enum(["applied", "no_change"]), readback_sha256: hash }),
  z.strictObject({ state: z.literal("unknown") }),
]);

type PendingEffect = { sequence: number; effectId: string; tenantId: string | null };
type Notice = {
  kind: "protected_installer_frame_ready" | "protected_installer_lifecycle_ready";
  version: 1;
  run_id: string;
  frame_id: number;
};

/** Shared Node transport for source-owned fixed protected workers. It stores no journal. */
export class ProtectedInstallerSpoolSession<
  TContext extends AuthorityContext = ProtectedInstallContext,
> {
  readonly lifecycle: ProtectedInstallerLifecycle;
  private _context: TContext | undefined;
  private _contextDigest = "";
  private _databaseUrl = "";
  private contextBytes: Buffer | undefined;
  private databaseBytes: Buffer | undefined;
  private frameId = 0;
  private sequence = 0;
  private pending: PendingEffect | undefined;
  private initialized = false;
  private closed = false;
  private failed = false;

  constructor(
    private readonly options: {
      spoolDirectory: string;
      runId: string;
      timeoutMs: number;
      notices?: NodeJS.WritableStream;
      /** Optional strict context decoder for fixed non-schema resource workers. */
      contextSchema?: z.ZodType<TContext>;
      /** Optional closed serializer matching the context producer's frozen wire order. */
      canonicalizeContext?: (context: TContext) => string;
    },
  ) {
    if (
      !/^[A-Za-z0-9_-]{1,128}$/u.test(options.runId) ||
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs <= 0
    )
      throw new Error("protected_installer_protocol_failed");
    this.lifecycle = new ProtectedInstallerLifecycle(
      options.spoolDirectory,
      options.runId,
      options.notices ?? process.stdout,
    );
  }

  open(): this {
    if (this.initialized || this.closed) throw new Error("protected_installer_protocol_failed");
    const startup = path.join(this.options.spoolDirectory, "startup");
    const ready = readSpoolJson(path.join(startup, "ready.json"), markerSchema);
    if (ready.run_id !== this.options.runId || ready.frame_id !== 0)
      throw new Error("protected_installer_protocol_failed");
    this.contextBytes = readSpoolBuffer(path.join(startup, "context.json"));
    this.databaseBytes = readSpoolBuffer(path.join(startup, "direct-database-url.json"));
    try {
      const contextSchema =
        this.options.contextSchema ??
        (protectedInstallContextSchema as unknown as z.ZodType<TContext>);
      this._context = freezeContext(
        contextSchema.parse(JSON.parse(this.contextBytes.toString("utf8"))),
      );
      const databaseUrl: unknown = JSON.parse(this.databaseBytes.toString("utf8"));
      if (
        typeof databaseUrl !== "string" ||
        databaseUrl.length === 0 ||
        /[\r\n]/u.test(databaseUrl)
      )
        throw new Error("protected_installer_database_binding_invalid");
      this._databaseUrl = databaseUrl;
      this._contextDigest = digestHex(
        Buffer.from(
          this.options.canonicalizeContext
            ? this.options.canonicalizeContext(this._context)
            : canonicalContext(this._context as unknown as ProtectedInstallContext),
        ),
      );
      this.initialized = true;
      removeStartupFile(path.join(startup, "context.json"));
      removeStartupFile(path.join(startup, "direct-database-url.json"));
      removeStartupFile(path.join(startup, "ready.json"));
      return this;
    } catch (error) {
      this.close();
      throw error;
    }
  }

  get context(): TContext {
    if (!this._context || this.closed) throw new Error("protected_installer_protocol_failed");
    return this._context;
  }

  get contextDigest(): string {
    if (!this.initialized || this.closed) throw new Error("protected_installer_protocol_failed");
    return this._contextDigest;
  }

  /** Secret direct binding is private process state and must never enter frames or logs. */
  get databaseUrl(): string {
    if (!this.initialized || this.closed) throw new Error("protected_installer_protocol_failed");
    return this._databaseUrl;
  }

  readStartupFile(name: string): Buffer {
    if (!this.initialized || this.closed || path.basename(name) !== name || !name.endsWith(".json"))
      throw new Error("protected_installer_protocol_failed");
    return readSpoolBuffer(path.join(this.options.spoolDirectory, "startup", name));
  }

  removeStartupFile(name: string): void {
    if (path.basename(name) !== name || !name.endsWith(".json"))
      throw new Error("protected_installer_protocol_failed");
    removeStartupFile(path.join(this.options.spoolDirectory, "startup", name));
  }

  /** Read the actual owner approval and lease fence without authorizing an effect or recording a receipt. */
  async assertCurrent(): Promise<void> {
    if (!this.initialized || this.closed || this.failed)
      throw new Error("protected_installer_protocol_failed");
    const context = this.context;
    try {
      const reply = fenceReplySchema.parse(
        await this.exchange({
          kind: "check_fence",
          version: 1,
          operation_id: context.operation.operation_id,
          approval_digest: context.operation.approval_digest,
          context_digest: this.contextDigest,
          fence_generation: context.operation.fence_generation,
          app_id: context.app_id,
          resource_id: context.resource.resource_id,
          release_id: context.release.id,
          installer_id: context.installer.id,
          installer_sha256: context.installer.sha256,
          tenant_id: null,
        }),
      );
      if (
        reply.operation_id !== context.operation.operation_id ||
        reply.context_digest !== this.contextDigest ||
        reply.fence_generation !== context.operation.fence_generation
      )
        throw new Error("protected_installer_protocol_failed");
      if (!reply.current) throw new Error("protected_installer_authority_denied");
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }

  async authorize(effectId: string, tenantId: string | null): Promise<number> {
    if (
      !this.initialized ||
      this.closed ||
      this.failed ||
      this.pending ||
      !opaqueId.safeParse(effectId).success ||
      (tenantId !== null && !this.context.tenant_targets.includes(tenantId))
    )
      throw new Error("protected_installer_protocol_failed");
    const sequence = this.sequence + 1;
    const context = this.context;
    const request = {
      kind: "authorize_effect",
      version: 1,
      operation_id: context.operation.operation_id,
      approval_digest: context.operation.approval_digest,
      context_digest: this.contextDigest,
      fence_generation: context.operation.fence_generation,
      sequence,
      effect_id: effectId,
      app_id: context.app_id,
      resource_id: context.resource.resource_id,
      release_id: context.release.id,
      installer_id: context.installer.id,
      installer_sha256: context.installer.sha256,
      tenant_id: tenantId,
    };
    try {
      const reply = authorizationReplySchema.parse(await this.exchange(request));
      this.assertReply(reply, sequence, effectId);
      if (!reply.allowed) throw new Error("protected_installer_authority_denied");
      this.sequence = sequence;
      this.pending = { sequence, effectId, tenantId };
      return sequence;
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }

  async checkpoint(
    sequence: number,
    effectId: string,
    tenantId: string | null,
    receiptInput: ProtectedEffectReceipt,
  ): Promise<void> {
    const pending = this.pending;
    if (
      !pending ||
      pending.sequence !== sequence ||
      pending.effectId !== effectId ||
      pending.tenantId !== tenantId ||
      !this.initialized ||
      this.closed ||
      this.failed
    )
      throw new Error("protected_installer_protocol_failed");
    const receipt = receiptSchema.parse(receiptInput);
    const context = this.context;
    const request = {
      kind: "checkpoint_effect",
      version: 1,
      operation_id: context.operation.operation_id,
      context_digest: this.contextDigest,
      fence_generation: context.operation.fence_generation,
      sequence,
      effect_id: effectId,
      resource_id: context.resource.resource_id,
      tenant_id: tenantId,
      receipt,
    };
    try {
      const reply = checkpointReplySchema.parse(await this.exchange(request));
      this.assertReply(reply, sequence, effectId);
      if (!reply.recorded) throw new Error("protected_installer_checkpoint_unconfirmed");
      this.pending = undefined;
      if (receipt.state === "unknown") {
        this.failed = true;
        throw new Error("protected_installer_readback_unknown");
      }
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    const startup = path.join(this.options.spoolDirectory, "startup");
    removeSpoolFile(path.join(startup, "context.json"));
    removeSpoolFile(path.join(startup, "direct-database-url.json"));
    removeSpoolFile(path.join(startup, "ready.json"));
    this.contextBytes?.fill(0);
    this.databaseBytes?.fill(0);
    this._databaseUrl = "";
    this._contextDigest = "";
    this._context = undefined;
    this.pending = undefined;
    this.closed = true;
  }

  private assertReply(
    reply: {
      operation_id: string;
      context_digest: string;
      fence_generation: number;
      sequence: number;
      effect_id: string;
    },
    sequence: number,
    effectId: string,
  ): void {
    if (
      reply.operation_id !== this.context.operation.operation_id ||
      reply.context_digest !== this.contextDigest ||
      reply.fence_generation !== this.context.operation.fence_generation ||
      reply.sequence !== sequence ||
      reply.effect_id !== effectId
    )
      throw new Error("protected_installer_protocol_failed");
  }

  private async exchange(value: unknown): Promise<unknown> {
    this.frameId += 1;
    const frameId = this.frameId;
    const requests = path.join(this.options.spoolDirectory, "requests");
    const responses = path.join(this.options.spoolDirectory, "responses");
    mkdirSync(requests, { recursive: true });
    mkdirSync(responses, { recursive: true });
    publishSpoolJson(path.join(requests, `${frameId}.json`), value);
    publishSpoolJson(path.join(requests, `${frameId}.ready`), {
      version: 1,
      run_id: this.options.runId,
      frame_id: frameId,
    });
    emitNotice(this.options.notices ?? process.stdout, {
      kind: "protected_installer_frame_ready",
      version: 1,
      run_id: this.options.runId,
      frame_id: frameId,
    });
    const readyPath = path.join(responses, `${frameId}.ready`);
    const responsePath = path.join(responses, `${frameId}.json`);
    const deadline = Date.now() + this.options.timeoutMs;
    while (Date.now() < deadline) {
      if (pathExists(readyPath)) {
        const marker = readSpoolJson(readyPath, markerSchema);
        if (marker.run_id !== this.options.runId || marker.frame_id !== frameId)
          throw new Error("protected_installer_protocol_failed");
        const response = readSpoolJson(responsePath, z.unknown());
        removeSpoolFile(readyPath);
        removeSpoolFile(responsePath);
        return response;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("protected_installer_protocol_timeout");
  }
}

/** Separate startup contract for the trusted Neon SQL resource bootstrap worker. */
export class ResourceBootstrapSpoolSession extends ProtectedInstallerSpoolSession<ResourceBootstrapContext> {
  private readonly startupDirectory: string;
  constructor(options: {
    spoolDirectory: string;
    runId: string;
    timeoutMs: number;
    notices?: NodeJS.WritableStream;
  }) {
    super({
      ...options,
      contextSchema: resourceBootstrapContextSchema,
      canonicalizeContext: canonicalResourceBootstrapContext,
    });
    this.startupDirectory = path.join(options.spoolDirectory, "startup");
  }

  override open(): this {
    try {
      return super.open();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  override close(): void {
    let cleanupFailed = false;
    for (const name of [
      "resource-credentials.json",
      "context.json",
      "direct-database-url.json",
      "ready.json",
    ]) {
      try {
        removeStartupFile(path.join(this.startupDirectory, name));
      } catch {
        cleanupFailed = true;
      }
    }
    super.close();
    if (cleanupFailed) throw new Error("protected_installer_protocol_failed");
  }
}

export class ProtectedInstallerLifecycle {
  private frame = 0;
  private startedFact = false;
  private terminal = false;
  private poisoned = false;

  constructor(
    private readonly spool: string,
    private readonly runId: string,
    private readonly notices: NodeJS.WritableStream,
  ) {
    mkdirSync(path.join(spool, "lifecycle"), { recursive: true });
  }

  started(): void {
    if (this.startedFact || this.terminal || this.poisoned)
      throw new Error("protected_installer_protocol_failed");
    this.publish("worker_started");
    this.startedFact = true;
  }

  succeeded(): void {
    if (!this.startedFact || this.terminal || this.poisoned)
      throw new Error("protected_installer_protocol_failed");
    this.publish("worker_succeeded");
  }

  failed(failureCode: ProtectedInstallerFailureCode, authStartup?: AuthStartupFailure): void {
    if (this.terminal || this.poisoned) throw new Error("protected_installer_protocol_failed");
    this.publish("worker_failed", failureCode, authStartup);
  }

  private publish(
    kind: "worker_started" | "worker_succeeded" | "worker_failed",
    failureCode?: ProtectedInstallerFailureCode,
    authStartup?: AuthStartupFailure,
  ): void {
    if (this.terminal || this.poisoned || (kind === "worker_succeeded" && !this.startedFact))
      throw new Error("protected_installer_protocol_failed");
    const frameId = this.frame + 1;
    const factPath = path.join(this.spool, "lifecycle", `${frameId}.json`);
    const readyPath = path.join(this.spool, "lifecycle", `${frameId}.ready`);
    const startupFailure =
      !this.startedFact && failureCode === "startup_rejected"
        ? projectAuthStartupFailure(authStartup)
        : undefined;
    publishSpoolJson(factPath, {
      version: 1,
      run_id: this.runId,
      kind,
      ...(failureCode ? { failure_code: failureCode } : {}),
      ...(startupFailure ? { auth_startup: startupFailure } : {}),
    });
    try {
      publishSpoolJson(readyPath, {
        version: 1,
        run_id: this.runId,
        frame_id: frameId,
      });
    } catch {
      removeSpoolFile(factPath);
      if (pathExists(factPath)) this.poisoned = true;
      throw new Error("protected_installer_protocol_failed");
    }
    this.frame = frameId;
    if (kind !== "worker_started") this.terminal = true;
    emitNotice(this.notices, {
      kind: "protected_installer_lifecycle_ready",
      version: 1,
      run_id: this.runId,
      frame_id: frameId,
    });
  }
}

function canonicalContext(context: ProtectedInstallContext): string {
  const resource = {
    resource_id: context.resource.resource_id,
    environment: context.resource.environment,
    hostname: context.resource.hostname,
    port: context.resource.port,
    database: context.resource.database,
    schema: context.resource.schema,
    migrator_role: context.resource.migrator_role,
    runtime_role: context.resource.runtime_role,
    ...(context.resource.provider_project_id
      ? { provider_project_id: context.resource.provider_project_id }
      : {}),
    ...(context.resource.provider_branch_id
      ? { provider_branch_id: context.resource.provider_branch_id }
      : {}),
  };
  return JSON.stringify({
    version: context.version,
    operation: {
      operation_id: context.operation.operation_id,
      approval_digest: context.operation.approval_digest,
      fence_generation: context.operation.fence_generation,
    },
    app_id: context.app_id,
    resource,
    release: { id: context.release.id, sha256: context.release.sha256 },
    installer: { id: context.installer.id, sha256: context.installer.sha256 },
    tenant_targets: context.tenant_targets,
  });
}

function canonicalResourceBootstrapContext(context: ResourceBootstrapContext): string {
  const resource = {
    scope: context.resource.scope,
    resource_id: context.resource.resource_id,
    environment: context.resource.environment,
    hostname: context.resource.hostname,
    port: context.resource.port,
    database: context.resource.database,
    migrator_role: context.resource.migrator_role,
    runtime_role: context.resource.runtime_role,
    maintenance_database: context.resource.maintenance_database,
    bootstrap_role: context.resource.bootstrap_role,
    ...(context.resource.provider_project_id
      ? { provider_project_id: context.resource.provider_project_id }
      : {}),
    ...(context.resource.provider_branch_id
      ? { provider_branch_id: context.resource.provider_branch_id }
      : {}),
    ...(context.resource.provider_endpoint_id
      ? { provider_endpoint_id: context.resource.provider_endpoint_id }
      : {}),
    credentials_sha256: context.resource.credentials_sha256,
  };
  return JSON.stringify({
    kind: context.kind,
    version: context.version,
    operation: {
      operation_id: context.operation.operation_id,
      approval_digest: context.operation.approval_digest,
      fence_generation: context.operation.fence_generation,
    },
    app_id: context.app_id,
    resource,
    release: { id: context.release.id, sha256: context.release.sha256 },
    installer: { id: context.installer.id, sha256: context.installer.sha256 },
    tenant_targets: context.tenant_targets,
  });
}

/** Digest used by the Builder host before it durably binds the worker context. */
export function digestResourceBootstrapContext(input: unknown): string {
  const context = resourceBootstrapContextSchema.parse(input);
  return digestHex(Buffer.from(canonicalResourceBootstrapContext(context)));
}

/** Digest of the exact secret bundle that the host must persist before starting the worker. */
export function digestResourceBootstrapCredentials(input: unknown): string {
  const credentials = resourceBootstrapCredentialsSchema.parse(input);
  return digestHex(
    Buffer.from(
      JSON.stringify({
        migratorPassword: credentials.migratorPassword,
        runtimePassword: credentials.runtimePassword,
      }),
    ),
  );
}

function freezeContext<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeContext(child);
  }
  return value;
}

function readSpoolBuffer(file: string): Buffer {
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maxFrameBytes)
    throw new Error("protected_installer_protocol_failed");
  return readFileSync(file);
}

function readSpoolJson<T>(file: string, schema: z.ZodType<T>): T {
  return schema.parse(JSON.parse(readSpoolBuffer(file).toString("utf8")));
}

function publishSpoolJson(file: string, value: unknown): void {
  const directory = path.dirname(file);
  const temp = path.join(directory, `.${path.basename(file)}.${process.pid}.tmp`);
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > maxFrameBytes) throw new Error("protected_installer_protocol_failed");
  mkdirSync(directory, { recursive: true });
  const descriptor = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    linkSync(temp, file);
  } finally {
    unlinkSync(temp);
  }
}

function removeSpoolFile(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    /* private-spool cleanup is best effort */
  }
}

function removeStartupFile(file: string): void {
  try {
    unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error("protected_installer_protocol_failed");
  }
}

function pathExists(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

function emitNotice(stream: NodeJS.WritableStream, value: Notice): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

function digestHex(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isLoopback(hostname: string): boolean {
  return hostname.startsWith("127.") || hostname === "::1" || hostname === "[::1]";
}
