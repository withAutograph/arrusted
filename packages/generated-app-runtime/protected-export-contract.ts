import { z } from "zod";

// Shared worker wire v1. Builder's separate plan/journal schemas own approval
// authority. Parsing worker metadata never authorizes an export or a download.
const id = z.string().min(1);
const uuid = z.uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const count = z.string().regex(/^(?:0|[1-9][0-9]*)$/u);
const decimalTotal = (values: string[]) =>
  values.every((value) => /^(?:0|[1-9][0-9]*)$/u.test(value))
    ? values.reduce((sum, value) => sum + BigInt(value), 0n)
    : undefined;
const index = z.number().int().nonnegative().refine(Number.isSafeInteger);
const uuidPart = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const artifactPattern = new RegExp(
  `^_protected-operator/artifacts/tenant-export/(${uuidPart})/(${uuidPart})/(data|manifest)/([a-f0-9]{64})$`,
  "u",
);
export const tenantExportArtifactReferenceSchema = z.string().regex(artifactPattern);
const emptyDigest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export const tenantExportScopeSchema = z.strictObject({ appId: id, customerId: id });
export const tenantExportResourceSchema = z
  .strictObject({
    projectId: id,
    branchId: id,
    resourceId: id,
    environment: z.enum(["local", "preview", "production"]),
    hostname: id.refine((value) => !/[\s/\\]/u.test(value) && !value.includes("://")),
    port: z.number().int().min(1).max(65_535),
    database: id,
    schema: z.literal("public"),
    migratorRole: id,
    runtimeRole: id,
  })

  .refine((value) => value.migratorRole !== value.runtimeRole);
export const tenantExportReleaseSchema = z.strictObject({
  id,
  artifactHash: digest,
  manifestRef: z
    .string()
    .regex(/^_protected-operator\/artifacts\/generated-release\/[a-z][a-z0-9-]*\/[a-f0-9]{64}$/u),
  manifestSha256: digest,
});
export const tenantExportWorkerDescriptorSchema = z.strictObject({
  id,
  operationScope: z.literal("generated-app-data-export-v1"),
  executablePath: id.refine(
    (value) =>
      value.startsWith("/") &&
      !/[\\\p{Cc}]/u.test(value) &&
      !value.split("/").some((part) => part === ".." || part === "."),
  ),
  sha256: digest,
  subcommand: z.literal("protected-generated-app-export"),
});

export const tenantExportWorkerInputSchema = z
  .strictObject({
    version: z.literal(1),
    kind: z.literal("tenant-export-worker"),
    exportId: uuid,
    attemptId: uuid,
    snapshotId: uuid,
    planDigest: digest,
    scope: tenantExportScopeSchema,
    resource: tenantExportResourceSchema,
    release: tenantExportReleaseSchema,
    selection: z.literal("public-app-customer-tables-v1"),
    format: z.literal("ndjson"),
  })

  .refine((value) => value.release.manifestRef.split("/")[3] === value.scope.appId, {
    message: "Export release belongs to another app",
  });
// Only the trusted executor later supplies the app-migrator connection in its
// command-scoped environment. It is absent from JSON, argv and this contract.
export type TenantExportWorkerInput = z.infer<typeof tenantExportWorkerInputSchema>;

const chunkSchema = z.strictObject({
  index,
  byteLength: count,
  sha256: digest,
  artifactRef: tenantExportArtifactReferenceSchema,
});
export const tenantExportDataMemberSchema = z
  .strictObject({
    kind: z.literal("data"),
    name: z.string().regex(/^table-[0-9]+\.ndjson$/u),
    table: z.strictObject({ schema: z.literal("public"), name: id }),
    rowCount: count,
    byteLength: count,
    sha256: digest,
    chunks: z.array(chunkSchema),
  })

  .superRefine((value, ctx) => {
    if (value.chunks.some((chunk, position) => chunk.index !== position))
      ctx.addIssue({ code: "custom", message: "Export chunk order is invalid" });
    if (
      decimalTotal(value.chunks.map((chunk) => chunk.byteLength)) !==
      decimalTotal([value.byteLength])
    )
      ctx.addIssue({ code: "custom", message: "Export member byte count differs" });
    if (value.byteLength === "0" && value.sha256 !== emptyDigest)
      ctx.addIssue({ code: "custom", message: "Empty export member digest differs" });
    for (const chunk of value.chunks) {
      const parts = artifactPattern.exec(chunk.artifactRef);
      if (chunk.byteLength === "0" && chunk.sha256 !== emptyDigest)
        ctx.addIssue({ code: "custom", message: "Empty export chunk digest differs" });
      if (parts?.[3] !== "data" || parts[4] !== chunk.sha256)
        ctx.addIssue({ code: "custom", message: "Export chunk reference differs" });
    }
  });
export const tenantExportManifestMemberSchema = z
  .strictObject({
    kind: z.literal("manifest"),
    name: z.literal("manifest.json"),
    byteLength: count,
    sha256: digest,
    artifactRef: tenantExportArtifactReferenceSchema,
  })

  .refine((value) => {
    const parts = artifactPattern.exec(value.artifactRef);
    return parts?.[3] === "manifest" && parts[4] === value.sha256;
  });

export const tenantExportArtifactManifestSchema = z
  .strictObject({
    version: z.literal(1),
    kind: z.literal("tenant-export"),
    exportId: uuid,
    attemptId: uuid,
    snapshotId: uuid,
    planDigest: digest,
    scope: tenantExportScopeSchema,
    resource: tenantExportResourceSchema,
    release: tenantExportReleaseSchema,
    format: z.literal("ndjson"),
    files: z.array(tenantExportDataMemberSchema),
    rowCount: count,
    byteLength: count,
  })

  .superRefine((value, ctx) => {
    if (value.release.manifestRef.split("/")[3] !== value.scope.appId)
      ctx.addIssue({ code: "custom", message: "Export release belongs to another app" });
    if (new Set(value.files.map((file) => file.name)).size !== value.files.length)
      ctx.addIssue({ code: "custom", message: "Export member identity repeats" });
    for (const key of ["rowCount", "byteLength"] as const)
      if (decimalTotal(value.files.map((file) => file[key])) !== decimalTotal([value[key]]))
        ctx.addIssue({ code: "custom", message: "Export manifest count differs" });
    for (const file of value.files)
      for (const chunk of file.chunks) {
        const parts = artifactPattern.exec(chunk.artifactRef);
        if (parts?.[1] !== value.exportId || parts[2] !== value.attemptId)
          ctx.addIssue({ code: "custom", message: "Export member belongs to another attempt" });
      }
  });
export type TenantExportArtifactManifest = z.infer<typeof tenantExportArtifactManifestSchema>;

const sameFields = (
  left: Record<string, string | number>,
  right: Record<string, string | number>,
) => Object.keys(left).every((key) => left[key] === right[key]);
/** Correlation only; fresh owner, setup and export approval checks belong to the operator. */
export const parseTenantExportManifestForWorker = (
  input: TenantExportWorkerInput,
  output: TenantExportArtifactManifest,
) => {
  const worker = tenantExportWorkerInputSchema.parse(input);
  const manifest = tenantExportArtifactManifestSchema.parse(output);
  if (
    (["exportId", "attemptId", "snapshotId", "planDigest"] as const).some(
      (key) => worker[key] !== manifest[key],
    ) ||
    !sameFields(worker.scope, manifest.scope) ||
    !sameFields(worker.resource, manifest.resource) ||
    !sameFields(worker.release, manifest.release)
  )
    throw new Error("tenant_export_scope_mismatch");
  return manifest;
};

/** Versioned cross-repository wire fixture, never an effect authorization. */
export const tenantExportWireFixtureSchema = z
  .strictObject({
    descriptor: tenantExportWorkerDescriptorSchema,
    worker: tenantExportWorkerInputSchema,
    manifest: tenantExportArtifactManifestSchema,
    manifestMember: tenantExportManifestMemberSchema,
  })

  .superRefine((value, ctx) => {
    try {
      parseTenantExportManifestForWorker(value.worker, value.manifest);
    } catch {
      ctx.addIssue({ code: "custom", message: "Export wire scope differs" });
    }
    const parts = artifactPattern.exec(value.manifestMember.artifactRef);
    if (parts?.[1] !== value.worker.exportId || parts[2] !== value.worker.attemptId)
      ctx.addIssue({ code: "custom", message: "Export manifest belongs to another attempt" });
  });

export type TenantExportScope = z.infer<typeof tenantExportScopeSchema>;
export type TenantExportResource = z.infer<typeof tenantExportResourceSchema>;
export type TenantExportRelease = z.infer<typeof tenantExportReleaseSchema>;
export type TenantExportWorkerDescriptor = z.infer<typeof tenantExportWorkerDescriptorSchema>;
export type TenantExportDataMember = z.infer<typeof tenantExportDataMemberSchema>;
export type TenantExportManifestMember = z.infer<typeof tenantExportManifestMemberSchema>;
export type TenantExportWireFixture = z.infer<typeof tenantExportWireFixtureSchema>;
