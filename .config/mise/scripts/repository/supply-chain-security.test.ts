import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { expect, test } from "vitest";

import {
  containerDiagnostic,
  assertTrivyResult,
  assertGitleaksResult,
  evaluateCargoAudit,
  evaluateGitleaksReport,
  evaluateJavaScriptAudit,
  evaluateOciIndex,
  evaluateTrivyReport,
  javascriptDiagnostic,
  parseBunAuditOutput,
  rustDiagnostic,
  secretDiagnostic,
  trivyArguments,
} from "./supply-chain-security";

const root = path.resolve(import.meta.dirname, "../../../..");
const bunRuntime = spawnSync("which", ["bun"], { encoding: "utf8" }).stdout.trim();
if (!bunRuntime) throw new Error("fixture tests require the pinned Bun runtime");

const policy = {
  version: 1 as const,
  remediated: [{ package: "fixed", minimumVersion: "2.0.0", advisories: [2] }],
  exceptions: [
    {
      package: "tool-only",
      advisory: 3,
      severity: "high" as const,
      runtimeReachable: false as const,
      runtimeReachability: "Not reachable from any production service.",
      compensatingControls: "Only immutable repository-owned input is processed.",
      owner: "Platform",
      expiresAt: "2099-01-01",
      followUpIssue: "A-240",
    },
  ],
};

test("Bun audit output accepts plain JSON", () => {
  expect(
    parseBunAuditOutput(new TextEncoder().encode('{"clean":[{"id":1,"severity":"info"}]}')),
  ).toEqual({ clean: [{ id: 1, severity: "info" }] });
});

test("Bun audit output accepts gzip-compressed JSON with Bun's trailing newline", () => {
  const compressed = gzipSync(new TextEncoder().encode('{"clean":[]}'));
  const output = new Uint8Array(compressed.length + 1);
  output.set(compressed);
  output[compressed.length] = 0x0a;

  expect(parseBunAuditOutput(output)).toEqual({ clean: [] });
});

test("Bun audit output fails closed on malformed gzip", () => {
  expect(() => parseBunAuditOutput(new Uint8Array([0x1f, 0x8b, 0x08]))).toThrow();
});

test("Bun audit output fails closed on malformed JSON", () => {
  expect(() => parseBunAuditOutput(new TextEncoder().encode("not JSON"))).toThrow();
});

test("Bun audit output fails closed on gzip-compressed malformed JSON", () => {
  expect(() => parseBunAuditOutput(gzipSync(new TextEncoder().encode("not JSON")))).toThrow();
});

test("Bun audit output rejects arbitrary trailing bytes and nested gzip", () => {
  const compressed = gzipSync(new TextEncoder().encode('{"clean":[]}'));
  const trailing = new Uint8Array(compressed.length + 4);
  trailing.set(compressed);
  trailing.set(new TextEncoder().encode("EVIL"), compressed.length);

  const hidden = gzipSync(
    new TextEncoder().encode('{"vulnerable":[{"id":99,"severity":"critical"}]}'),
  );
  const nulPadded = new Uint8Array(compressed.length + 1 + hidden.length);
  nulPadded.set(compressed);
  nulPadded[compressed.length] = 0x00;
  nulPadded.set(hidden, compressed.length + 1);

  expect(() => parseBunAuditOutput(trailing)).toThrow();
  expect(() => parseBunAuditOutput(nulPadded)).toThrow("trailing bytes");
  expect(() => parseBunAuditOutput(gzipSync(compressed))).toThrow();
});

test("Bun audit output bounds decompression", () => {
  const oversized = gzipSync(new Uint8Array(16 * 1024 * 1024 + 1));
  for (const output of [oversized, appendNewline(oversized)]) {
    const failure = caught(() => parseBunAuditOutput(output));
    expect(failure).toBeInstanceOf(RangeError);
    expect(failure).toHaveProperty("code", "ERR_BUFFER_TOO_LARGE");
  }

  expect(() => parseBunAuditOutput(new Uint8Array(16 * 1024 * 1024 + 1))).toThrow(
    "exceeds the size limit",
  );
});

test("pinned Bun enforces gzip runtime boundaries", () => {
  const clean = gzipSync(new TextEncoder().encode('{"clean":[]}'));
  const hidden = gzipSync(
    new TextEncoder().encode('{"vulnerable":[{"id":99,"severity":"critical"}]}'),
  );
  const nulPadded = new Uint8Array(clean.length + 1 + hidden.length);
  nulPadded.set(clean);
  nulPadded[clean.length] = 0x00;
  nulPadded.set(hidden, clean.length + 1);

  const oversized = runBunParserFixture(gzipSync(new Uint8Array(16 * 1024 * 1024 + 1)));
  expect(oversized.status).not.toBe(0);
  expect(oversized.stderr).toContain("ERR_BUFFER_TOO_LARGE");

  const unreadSuffix = runBunParserFixture(nulPadded);
  expect(unreadSuffix.status).not.toBe(0);
  expect(unreadSuffix.stderr).toContain("trailing bytes");

  const hiddenMember = new Uint8Array(clean.length + hidden.length);
  hiddenMember.set(clean);
  hiddenMember.set(hidden, clean.length);
  expect(runBunParserFixture(hiddenMember).status).not.toBe(0);
});

test("Bun audit output rejects invalid UTF-8 and unknown severities", () => {
  const prefix = new TextEncoder().encode('{"pkg":[{"id":1,"severity":"h');
  const suffix = new TextEncoder().encode('gh"}]}');
  const invalidUtf8 = new Uint8Array(prefix.length + 1 + suffix.length);
  invalidUtf8.set(prefix);
  invalidUtf8[prefix.length] = 0xff;
  invalidUtf8.set(suffix, prefix.length + 1);

  expect(() => parseBunAuditOutput(invalidUtf8)).toThrow();
  expect(() =>
    parseBunAuditOutput(new TextEncoder().encode('{"pkg":[{"id":1,"severity":"unknown"}]}')),
  ).toThrow();
});

test("gzip audit output preserves brace-expansion remediation and blocking policy", () => {
  const remediated = runDependencyGateFixture(
    { "brace-expansion": [{ id: 1124334, severity: "high" }] },
    { vulnerabilities: { list: [] } },
    { gzipBunAudit: true },
  );
  expect(remediated.status).toBe(0);

  const productionPolicy = JSON.parse(
    readFileSync(path.join(root, ".config/security/advisory-policy.json"), "utf8"),
  ) as Parameters<typeof evaluateJavaScriptAudit>[1];
  const audit = { "brace-expansion": [{ id: 1124334, severity: "high" }] };
  const fixed = evaluateJavaScriptAudit(
    audit,
    productionPolicy,
    new Map([["brace-expansion", ["5.0.8"]]]),
  );
  expect(fixed.remediated).toEqual([
    { advisory: "1124334", package: "brace-expansion", severity: "high" },
  ]);
  expect(fixed.excepted).toEqual([]);

  const vulnerable = evaluateJavaScriptAudit(
    audit,
    productionPolicy,
    new Map([["brace-expansion", ["1.1.16"]]]),
  );
  expect(vulnerable.blocked).toEqual([
    { advisory: "1124334", package: "brace-expansion", severity: "high" },
  ]);

  const blocked = runDependencyGateFixture(
    { vulnerable: [{ id: 99, severity: "critical" }] },
    { vulnerabilities: { list: [] } },
    { gzipBunAudit: true },
  );
  expect(blocked.status).not.toBe(0);
  expect(blocked.stderr).toContain(
    "SUPPLY_CHAIN_JS_VULNERABILITY package=vulnerable advisory=99 severity=critical",
  );
});

test("dependency gate bounds Bun audit stdout before parsing", () => {
  const result = runDependencyGateFixture(
    {},
    { vulnerabilities: { list: [] } },
    { bunAuditByteLength: 16 * 1024 * 1024 + 1 },
  );
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("bun audit --json stdout exceeds the size limit");
  expect(result.stderr).not.toContain("bun audit response exceeds the size limit");
});

test("positive dependency fixture passes and preserves only sanitized identifiers", () => {
  const result = evaluateJavaScriptAudit(
    {
      fixed: [{ id: 2, severity: "critical" }],
      "tool-only": [{ id: 3, severity: "high" }],
      low: [{ id: 4, severity: "low" }],
    },
    policy,
    new Map([
      ["fixed", ["2.0.0"]],
      ["tool-only", ["1.0.0"]],
    ]),
  );
  expect(result.blocked).toEqual([]);
  expect(result.remediated).toEqual([{ advisory: "2", package: "fixed", severity: "critical" }]);
  expect(result.excepted).toEqual([{ advisory: "3", package: "tool-only", severity: "high" }]);
});

test("vulnerable JavaScript dependency fails with the exact diagnostic fields", () => {
  const result = evaluateJavaScriptAudit(
    { vulnerable: [{ id: 99, severity: "critical" }] },
    policy,
    new Map(),
  );
  expect(result.blocked).toEqual([{ advisory: "99", package: "vulnerable", severity: "critical" }]);
  expect(javascriptDiagnostic(result.blocked[0]!)).toBe(
    "SUPPLY_CHAIN_JS_VULNERABILITY package=vulnerable advisory=99 severity=critical",
  );
  const gate = runDependencyGateFixture(
    { vulnerable: [{ id: 99, severity: "critical" }] },
    { vulnerabilities: { list: [] } },
  );
  expect(gate.status).not.toBe(0);
  expect(gate.stderr).toContain(
    "SUPPLY_CHAIN_JS_VULNERABILITY package=vulnerable advisory=99 severity=critical",
  );
});

test("expired exceptions and incomplete exception evidence fail closed", () => {
  expect(() =>
    evaluateJavaScriptAudit(
      { "tool-only": [{ id: 3, severity: "high" }] },
      {
        ...policy,
        exceptions: [{ ...policy.exceptions[0]!, expiresAt: "2020-01-01" }],
      },
      new Map(),
      "2026-07-24",
    ),
  ).toThrow("expired");
});

test("vulnerable Rust crate fails with exact crate and advisory identifiers", () => {
  const findings = evaluateCargoAudit({
    vulnerabilities: {
      list: [{ advisory: { id: "RUSTSEC-2099-0001" }, package: { name: "vulnerable-crate" } }],
    },
  });
  expect(findings).toEqual([
    { advisory: "RUSTSEC-2099-0001", package: "vulnerable-crate", severity: "vulnerable" },
  ]);
  expect(rustDiagnostic(findings[0]!)).toBe(
    "SUPPLY_CHAIN_RUST_VULNERABILITY crate=vulnerable-crate advisory=RUSTSEC-2099-0001",
  );
  const gate = runDependencyGateFixture(
    {},
    {
      vulnerabilities: {
        list: [
          {
            advisory: { id: "RUSTSEC-2099-0001" },
            package: { name: "vulnerable-crate" },
          },
        ],
      },
    },
  );
  expect(gate.status).not.toBe(0);
  expect(gate.stderr).toContain(
    "SUPPLY_CHAIN_RUST_VULNERABILITY crate=vulnerable-crate advisory=RUSTSEC-2099-0001",
  );
});

test("vulnerable container fails with exact image-safe advisory identifiers", async () => {
  const findings = evaluateTrivyReport({
    Results: [
      {
        Target: "must-not-be-published",
        Vulnerabilities: [
          { VulnerabilityID: "CVE-2099-0001", PkgName: "openssl", Severity: "HIGH" },
        ],
      },
    ],
  });
  expect(findings).toEqual([{ advisory: "CVE-2099-0001", package: "openssl", severity: "high" }]);
  expect(containerDiagnostic({ ...findings[0]!, image: "vulnerable-fixture" })).toBe(
    "SUPPLY_CHAIN_CONTAINER_VULNERABILITY image=vulnerable-fixture advisory=CVE-2099-0001 package=openssl severity=high",
  );
  expect(() => assertTrivyResult(1, [], "vulnerable-fixture")).toThrow(
    "exit 1 produced no blocking findings",
  );
  const arguments_ = trivyArguments("fixture.oci", "report.json");
  expect(arguments_).not.toContain("--ignore-unfixed");
  expect(arguments_).toContain("HIGH,CRITICAL");
  expect(arguments_[arguments_.indexOf("--input") + 1]).toBe("fixture.oci");
  expect(() => evaluateTrivyReport({ Results: [{ Vulnerabilities: "schema drift" }] })).toThrow(
    "vulnerability list is invalid",
  );

  const directory = await fixtureDirectory("container-fixture-");
  try {
    const digest = `sha256:${"a".repeat(64)}`;
    const archiveSource = path.join(directory, "archive");
    const bin = path.join(directory, "bin");
    await mkdir(archiveSource);
    await mkdir(bin);
    await writeFile(
      path.join(archiveSource, "index.json"),
      JSON.stringify({ schemaVersion: 2, manifests: [{ digest }] }),
    );
    expect(
      spawnSync("tar", [
        "-cf",
        path.join(directory, "vulnerable-fixture.oci.tar"),
        "-C",
        archiveSource,
        "index.json",
      ]).status,
    ).toBe(0);
    const commit = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).stdout.trim();
    await writeFile(
      path.join(directory, "images.lock.json"),
      JSON.stringify({
        commit,
        sourceDirty: false,
        sourceKind: "git-archive",
        images: [{ digest, name: "vulnerable-fixture" }],
      }),
    );
    writeExecutable(
      path.join(bin, "trivy"),
      `#!/bin/sh
output=
input=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --input) input="$2"; shift 2 ;;
    --output) output="$2"; shift 2 ;;
    *) shift ;;
  esac
done
test -f "$input/index.json" || exit 2
printf '%s\\n' '{"Results":[{"Vulnerabilities":[{"VulnerabilityID":"CVE-2099-0001","PkgName":"openssl","Severity":"HIGH"}]}]}' >"$output"
exit 1
`,
    );
    const gate = spawnSync(
      bunRuntime,
      [
        ".config/mise/scripts/repository/supply-chain-security.ts",
        "images",
        "--manifest",
        path.join(directory, "images.lock.json"),
      ],
      { cwd: root, encoding: "utf8", env: fixtureEnvironment(bin) },
    );
    expect(gate.status).not.toBe(0);
    expect(gate.stderr).toContain(
      "SUPPLY_CHAIN_CONTAINER_VULNERABILITY image=vulnerable-fixture advisory=CVE-2099-0001 package=openssl severity=high",
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("OCI archive index must cryptographically match the scanned artifact digest", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  evaluateOciIndex({ schemaVersion: 2, manifests: [{ digest }] }, digest);
  expect(() =>
    evaluateOciIndex(
      { schemaVersion: 2, manifests: [{ digest: `sha256:${"b".repeat(64)}` }] },
      digest,
    ),
  ).toThrow(`OCI archive digest mismatch: expected ${digest}`);
});

test("committed-tree secret scan catches a secret introduced before HEAD", async () => {
  const fixtureRoot = path.join(root, ".scratch");
  await mkdir(fixtureRoot, { recursive: true });
  const directory = await mkdtemp(path.join(fixtureRoot, "secret-fixture-"));
  try {
    // A nested fixture repository cannot run this repository's global HK hooks.
    const git = (args: string[]) =>
      spawnSync("git", args, {
        cwd: directory,
        encoding: "utf8",
        env: { ...process.env, HK: "0" },
      });
    expect(git(["init", "-q"]).status).toBe(0);
    expect(git(["config", "user.email", "fixture@example.invalid"]).status).toBe(0);
    expect(git(["config", "user.name", "Supply Chain Fixture"]).status).toBe(0);
    expect(git(["config", "commit.gpgsign", "false"]).status).toBe(0);
    const privateKey = path.join(directory, "fixture_key");
    expect(
      spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", privateKey]).status,
    ).toBe(0);
    expect(git(["add", "fixture_key"]).status).toBe(0);
    const secretCommit = git(["commit", "-qm", "committed secret fixture"]);
    expect(secretCommit.status, secretCommit.stderr).toBe(0);
    await writeFile(path.join(directory, "later.txt"), "clean later commit\n");
    expect(git(["add", "later.txt"]).status).toBe(0);
    expect(git(["commit", "-qm", "later clean commit"]).status).toBe(0);
    const tree = path.join(directory, "tree");
    const archive = path.join(directory, "tree.tar");
    await mkdir(tree);
    expect(git(["archive", "--format=tar", `--output=${archive}`, "HEAD"]).status).toBe(0);
    expect(spawnSync("tar", ["-xf", archive, "-C", tree]).status).toBe(0);
    const report = path.join(directory, "gitleaks.json");
    const scan = spawnSync(
      "gitleaks",
      ["dir", "--no-banner", "--redact", "--report-format", "json", "--report-path", report, tree],
      { encoding: "utf8" },
    );
    expect(scan.status).toBe(1);
    const detectors = evaluateGitleaksReport(JSON.parse(await readFile(report, "utf8")));
    assertGitleaksResult(scan.status!, detectors);
    expect(() => assertGitleaksResult(1, [])).toThrow("exit 1 produced no secret findings");
    expect(detectors).toContain("private-key");
    expect(secretDiagnostic("private-key")).toBe("SUPPLY_CHAIN_SECRET detector=private-key");
  } finally {
    await rm(directory, { recursive: true });
  }
});

function runDependencyGateFixture(
  bunAudit: unknown,
  cargoAudit: unknown,
  options: { bunAuditByteLength?: number; gzipBunAudit?: boolean } = {},
): { status: number | null; stderr: string } {
  const scratch = path.join(root, ".scratch");
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(path.join(scratch, "gate-bin-"));
  try {
    const cargoList =
      typeof cargoAudit === "object" &&
      cargoAudit !== null &&
      "vulnerabilities" in cargoAudit &&
      typeof cargoAudit.vulnerabilities === "object" &&
      cargoAudit.vulnerabilities !== null &&
      "list" in cargoAudit.vulnerabilities &&
      Array.isArray(cargoAudit.vulnerabilities.list)
        ? cargoAudit.vulnerabilities.list
        : [];
    const bunAuditJson = new TextEncoder().encode(JSON.stringify(bunAudit));
    const bunAuditOutput = options.gzipBunAudit
      ? appendNewline(gzipSync(bunAuditJson))
      : appendNewline(bunAuditJson);
    const bunAuditFixture = path.join(directory, "bun-audit-output");
    writeFileSync(bunAuditFixture, bunAuditOutput);
    const bunAuditCommand =
      options.bunAuditByteLength === undefined
        ? `/bin/cat "$BUN_AUDIT_FIXTURE"`
        : `exec /usr/bin/head -c ${options.bunAuditByteLength} /dev/zero`;
    writeExecutable(
      path.join(directory, "bun"),
      `#!/bin/sh
case "$1" in
  install) exit 0 ;;
  audit) ${bunAuditCommand}; exit ${isEmptyRecord(bunAudit) ? 0 : 1} ;;
  *) exit 2 ;;
esac
`,
    );
    writeExecutable(
      path.join(directory, "cargo"),
      `#!/bin/sh
printf '%s\\n' '${JSON.stringify(cargoAudit)}'
exit ${cargoList.length === 0 ? 0 : 1}
`,
    );
    const gate = spawnSync(
      bunRuntime,
      [".config/mise/scripts/repository/supply-chain-security.ts", "dependencies"],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...fixtureEnvironment(directory), BUN_AUDIT_FIXTURE: bunAuditFixture },
      },
    );
    return { status: gate.status, stderr: gate.stderr };
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function runBunParserFixture(input: Uint8Array): {
  status: number | null;
  stderr: string;
} {
  const result = spawnSync(
    bunRuntime,
    [
      "--eval",
      `import { readFileSync } from "node:fs";
import { parseBunAuditOutput } from "./.config/mise/scripts/repository/supply-chain-security.ts";
parseBunAuditOutput(readFileSync(0));`,
    ],
    { cwd: root, encoding: "utf8", input },
  );
  if (result.error) throw result.error;
  return { status: result.status, stderr: result.stderr };
}

async function fixtureDirectory(prefix: string): Promise<string> {
  const fixtureRoot = path.join(root, ".scratch");
  await mkdir(fixtureRoot, { recursive: true });
  return mkdtemp(path.join(fixtureRoot, prefix));
}

function fixtureEnvironment(bin: string): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
}

function writeExecutable(filename: string, contents: string): void {
  writeFileSync(filename, contents);
  chmodSync(filename, 0o700);
}

function appendNewline(input: Uint8Array): Uint8Array {
  const output = new Uint8Array(input.length + 1);
  output.set(input);
  output[input.length] = 0x0a;
  return output;
}

function isEmptyRecord(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

function caught(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error("expected operation to fail");
}
