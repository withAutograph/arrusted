import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "vite-plus/test";
import {
  parseTenantExportManifestForWorker,
  tenantExportArtifactManifestSchema,
  tenantExportWorkerDescriptorSchema,
  tenantExportWorkerInputSchema,
  tenantExportWireFixtureSchema,
} from "../protected-export-contract";

const fixtureInput: unknown = JSON.parse(
  readFileSync(new URL("fixtures/tenant-export-wire-v1.json", import.meta.url), "utf-8"),
);
const fixture = tenantExportWireFixtureSchema.parse(fixtureInput);
const copy = () => structuredClone(fixture);
const first = <T>(items: readonly T[]): T => {
  const value = items[0];
  if (value === undefined) throw new Error("Controlled wire fixture member is missing");
  return value;
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

test("shared wire roundtrips generic metadata without adding authority or business bytes", () => {
  const value = tenantExportWireFixtureSchema.parse(copy());
  const encoded = JSON.stringify(value);
  const decoded: unknown = JSON.parse(encoded);
  expect(tenantExportWireFixtureSchema.parse(decoded)).toEqual(fixture);
  expect(parseTenantExportManifestForWorker(value.worker, value.manifest)).toEqual(value.manifest);
  expect(hash(JSON.stringify(value.manifest))).toBe(value.manifestMember.sha256);
  expect(String(Buffer.byteLength(JSON.stringify(value.manifest)))).toBe(
    value.manifestMember.byteLength,
  );
});

test("empty tenants and empty files remain successful shapes", () => {
  const value = copy();
  value.manifest.files = [];
  value.manifest.rowCount = "0";
  value.manifest.byteLength = "0";
  expect(parseTenantExportManifestForWorker(value.worker, value.manifest).files).toEqual([]);
  const original = tenantExportArtifactManifestSchema.parse(fixture.manifest);
  expect(original.files[1]?.chunks).toEqual([]);
  expect(original.files[1]?.byteLength).toBe("0");
});

test("authorized business bytes are opaque private chunks, including source-like strings", () => {
  const value = copy();
  const privateBytes =
    '{"note":"postgres://ordinary-business.example/path; SELECT password; Bearer memo; cookie; secret"}\n';
  const sha256 = hash(privateBytes);
  const byteLength = String(Buffer.byteLength(privateBytes));
  const file = first(value.manifest.files);
  file.sha256 = sha256;
  file.byteLength = byteLength;
  file.chunks[0] = {
    index: 0,
    byteLength,
    sha256,
    artifactRef: `_protected-operator/artifacts/tenant-export/${value.worker.exportId}/${value.worker.attemptId}/data/${sha256}`,
  };
  value.manifest.byteLength = byteLength;
  expect(parseTenantExportManifestForWorker(value.worker, value.manifest).files[0]?.sha256).toBe(
    sha256,
  );
  expect(
    tenantExportWorkerInputSchema.safeParse({ ...value.worker, rows: privateBytes }).success,
  ).toBe(false);
});

test("decimal counters preserve large exact totals without a volume quota", () => {
  const value = copy();
  const huge = "999999999999999999999999999999";
  value.manifest.files = [first(value.manifest.files)];
  first(value.manifest.files).rowCount = huge;
  first(value.manifest.files).byteLength = huge;
  first(first(value.manifest.files).chunks).byteLength = huge;
  value.manifest.rowCount = huge;
  value.manifest.byteLength = huge;
  expect(tenantExportArtifactManifestSchema.parse(value.manifest).byteLength).toBe(huge);
  value.manifest.rowCount = "00";
  expect(tenantExportArtifactManifestSchema.safeParse(value.manifest).success).toBe(false);
});

test("foreign scope, attempts, reference digests and traversal are rejected", () => {
  for (const mutate of [
    (value: typeof fixture) => {
      value.manifest.scope.customerId = "another-customer";
    },
    (value: typeof fixture) => {
      value.manifest.resource.database = "another_database";
    },
    (value: typeof fixture) => {
      value.manifest.release.id = "another-release";
    },
    (value: typeof fixture) => {
      value.manifest.attemptId = "90000000-0000-4000-8000-000000000009";
    },
    (value: typeof fixture) => {
      first(value.manifest.files).name = "../outside.ndjson";
    },
    (value: typeof fixture) => {
      first(first(value.manifest.files).chunks).artifactRef += "/../outside";
    },
    (value: typeof fixture) => {
      first(first(value.manifest.files).chunks).sha256 = "f".repeat(64);
    },
    (value: typeof fixture) => {
      value.manifest.byteLength = "0";
    },
  ]) {
    const value = copy();
    mutate(value);
    expect(tenantExportWireFixtureSchema.safeParse(value).success).toBe(false);
  }
});

test("worker metadata cannot become a general credential, SQL or command transport", () => {
  for (const addition of [
    { databaseUrl: "postgres://not-a-real-secret.invalid/db" },
    { sql: "select arbitrary" },
    { env: { APP_MIGRATOR_URL: "not-a-real-secret" } },
    { outputPath: "/caller-selected/output" },
    { ownerUserId: "untrusted-owner" },
  ])
    expect(
      tenantExportWorkerInputSchema.safeParse({ ...fixture.worker, ...addition }).success,
    ).toBe(false);
  expect(
    tenantExportWorkerDescriptorSchema.safeParse({
      ...fixture.descriptor,
      subcommand: "protected-generated-app-install",
    }).success,
  ).toBe(false);
  expect(
    tenantExportWorkerDescriptorSchema.safeParse({
      ...fixture.descriptor,
      executablePath: "/opt/../other",
    }).success,
  ).toBe(false);
});

test("invalid counters and foreign release references fail closed without interpreting row content", () => {
  for (const countValue of ["not-a-number", "-1", "1.5", "00"]) {
    const value = copy();
    value.manifest.byteLength = countValue;
    expect(tenantExportArtifactManifestSchema.safeParse(value.manifest).success).toBe(false);
  }
  const value = copy();
  value.worker.release.manifestRef = value.worker.release.manifestRef.replace(
    "/orchard/",
    "/another-app/",
  );
  expect(tenantExportWorkerInputSchema.safeParse(value.worker).success).toBe(false);
  expect(
    tenantExportWorkerDescriptorSchema.parse({
      ...fixture.descriptor,
      id: "reviewed-export-worker-build-2",
    }).id,
  ).toBe("reviewed-export-worker-build-2");
});
