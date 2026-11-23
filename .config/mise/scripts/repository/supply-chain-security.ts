import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const reportRoot = path.join(root, ".scratch", "security");
const policyPath = path.join(root, ".config", "security", "advisory-policy.json");
const blockingSeverities = new Set(["critical", "high"]);
// Audit JSON is metadata; this generous envelope bounds decompression amplification.
const maxBunAuditOutputBytes = 16 * 1024 * 1024;

type BunAdvisory = {
  id: number;
  severity: string;
};
type BunAudit = Record<string, BunAdvisory[]>;
type Policy = {
  version: 1;
  remediated: Array<{ package: string; minimumVersion: string; advisories: number[] }>;
  exceptions: Array<{
    package: string;
    advisory: number;
    severity: "high";
    runtimeReachable: false;
    runtimeReachability: string;
    compensatingControls: string;
    owner: string;
    expiresAt: string;
    followUpIssue: string;
  }>;
};
type Finding = { advisory: string; package: string; severity: string };

export function parseBunAuditOutput(output: Uint8Array): BunAudit {
  // Bun may pass through gzip registry bytes when response encoding metadata is absent.
  let decoded = output;
  if (output[0] === 0x1f && output[1] === 0x8b) {
    try {
      decoded = gunzipBunAuditOutput(output);
    } catch (error) {
      if (output.at(-1) !== 0x0a) throw error;
      decoded = gunzipBunAuditOutput(output.subarray(0, -1));
    }
  }
  if (decoded.byteLength > maxBunAuditOutputBytes) {
    throw new Error("bun audit response exceeds the size limit");
  }

  const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded));
  if (!isRecord(parsed)) throw new Error("bun audit response must be an object");
  const severities = new Set(["info", "low", "moderate", "high", "critical"]);
  for (const [packageName, advisories] of Object.entries(parsed)) {
    if (!packageName || !Array.isArray(advisories)) {
      throw new Error("bun audit response package entry is invalid");
    }
    for (const advisory of advisories) {
      if (
        !isRecord(advisory) ||
        typeof advisory.id !== "number" ||
        !Number.isSafeInteger(advisory.id) ||
        advisory.id <= 0 ||
        typeof advisory.severity !== "string" ||
        !severities.has(advisory.severity)
      ) {
        throw new Error("bun audit response advisory is invalid");
      }
    }
  }
  return parsed as BunAudit;
}

function gunzipBunAuditOutput(output: Uint8Array): Uint8Array {
  // Node declarations do not model Bun's `info: true` runtime result shape.
  const result: unknown = gunzipSync(output, {
    info: true,
    maxOutputLength: maxBunAuditOutputBytes,
  });
  if (
    !isRecord(result) ||
    !(result.buffer instanceof Uint8Array) ||
    !isRecord(result.engine) ||
    typeof result.engine.bytesWritten !== "number"
  ) {
    throw new Error("bun audit gzip decoder did not return consumption metadata");
  }
  if (result.engine.bytesWritten !== output.byteLength) {
    throw new Error("bun audit gzip response contains trailing bytes");
  }
  return result.buffer;
}

if (import.meta.main) {
  await mkdir(reportRoot, { recursive: true });
  const command = process.argv[2];
  if (command === "dependencies") await dependencyGate();
  else if (command === "secrets") await secretGate(root);
  else if (command === "images") await imageGate(requiredOption("--manifest"));
  else {
    throw new Error("usage: supply-chain-security.ts dependencies|secrets|images");
  }
}

export function evaluateJavaScriptAudit(
  audit: BunAudit,
  policy: Policy,
  resolvedVersions: ReadonlyMap<string, readonly string[]>,
  today = new Date().toISOString().slice(0, 10),
): { accepted: Finding[]; blocked: Finding[]; excepted: Finding[]; remediated: Finding[] } {
  validatePolicy(policy, today);
  const accepted: Finding[] = [];
  const blocked: Finding[] = [];
  const excepted: Finding[] = [];
  const remediated: Finding[] = [];
  for (const [packageName, advisories] of Object.entries(audit)) {
    for (const advisory of advisories) {
      const finding = {
        advisory: String(advisory.id),
        package: packageName,
        severity: advisory.severity.toLowerCase(),
      };
      if (!blockingSeverities.has(finding.severity)) {
        accepted.push(finding);
        continue;
      }
      const fixed = policy.remediated.find(
        (entry) => entry.package === packageName && entry.advisories.includes(advisory.id),
      );
      if (fixed) {
        const versions = resolvedVersions.get(packageName) ?? [];
        if (
          versions.length > 0 &&
          versions.every((version) => compareVersions(version, fixed.minimumVersion) >= 0)
        ) {
          remediated.push(finding);
          continue;
        }
      }
      const exception = policy.exceptions.find(
        (entry) =>
          entry.package === packageName &&
          entry.advisory === advisory.id &&
          entry.severity === finding.severity,
      );
      if (exception) excepted.push(finding);
      else blocked.push(finding);
    }
  }
  return { accepted, blocked, excepted, remediated };
}

export function evaluateCargoAudit(payload: unknown): Finding[] {
  if (!isRecord(payload) || !isRecord(payload.vulnerabilities)) {
    throw new Error("cargo audit report is invalid");
  }
  const list = payload.vulnerabilities.list;
  if (!Array.isArray(list)) throw new Error("cargo audit vulnerability list is invalid");
  return list.map((entry) => {
    if (!isRecord(entry) || !isRecord(entry.advisory) || !isRecord(entry.package)) {
      throw new Error("cargo audit vulnerability entry is invalid");
    }
    const advisory = requiredString(entry.advisory.id, "Rust advisory id");
    const packageName = requiredString(entry.package.name, "Rust package name");
    return { advisory, package: packageName, severity: "vulnerable" };
  });
}

export function evaluateTrivyReport(payload: unknown): Finding[] {
  if (!isRecord(payload) || !Array.isArray(payload.Results)) {
    throw new Error("Trivy report is invalid");
  }
  const findings: Finding[] = [];
  for (const result of payload.Results) {
    if (!isRecord(result)) throw new Error("Trivy result entry is invalid");
    if (result.Vulnerabilities === undefined || result.Vulnerabilities === null) continue;
    if (!Array.isArray(result.Vulnerabilities)) {
      throw new Error("Trivy vulnerability list is invalid");
    }
    for (const vulnerability of result.Vulnerabilities) {
      if (!isRecord(vulnerability)) throw new Error("Trivy vulnerability entry is invalid");
      const severity = requiredString(vulnerability.Severity, "Trivy severity").toLowerCase();
      if (!blockingSeverities.has(severity)) continue;
      findings.push({
        advisory: requiredString(vulnerability.VulnerabilityID, "Trivy advisory id"),
        package: requiredString(vulnerability.PkgName, "Trivy package name"),
        severity,
      });
    }
  }
  return findings;
}

export function evaluateOciIndex(payload: unknown, expectedDigest: string): void {
  if (
    !isRecord(payload) ||
    payload.schemaVersion !== 2 ||
    !Array.isArray(payload.manifests) ||
    payload.manifests.length !== 1 ||
    !isRecord(payload.manifests[0])
  ) {
    throw new Error("OCI archive index is invalid");
  }
  const actualDigest = requiredDigest(payload.manifests[0].digest);
  if (actualDigest !== requiredDigest(expectedDigest)) {
    throw new Error(
      `OCI archive digest mismatch: expected ${expectedDigest}, found ${actualDigest}`,
    );
  }
}

export function assertTrivyResult(exit: number, findings: readonly Finding[], image: string): void {
  if (exit !== 0 && exit !== 1) throw new Error(`Trivy failed for ${image} with exit ${exit}`);
  if (exit === 1 && findings.length === 0) {
    throw new Error(`Trivy failed closed for ${image}: exit 1 produced no blocking findings`);
  }
  if (exit === 0 && findings.length > 0) {
    throw new Error(`Trivy failed closed for ${image}: blocking findings produced exit 0`);
  }
}

export function trivyArguments(archive: string, output: string): string[] {
  return [
    "trivy",
    "image",
    "--input",
    archive,
    "--format",
    "json",
    "--output",
    output,
    "--severity",
    "HIGH,CRITICAL",
    "--exit-code",
    "1",
    "--scanners",
    "vuln",
  ];
}

export function evaluateGitleaksReport(payload: unknown): string[] {
  if (!Array.isArray(payload)) throw new Error("gitleaks report is invalid");
  return payload.map((finding) => {
    if (!isRecord(finding)) throw new Error("gitleaks finding is invalid");
    return requiredString(finding.RuleID, "gitleaks rule id");
  });
}

export function assertGitleaksResult(exit: number, detectors: readonly string[]): void {
  if (exit !== 0 && exit !== 1) throw new Error(`gitleaks failed with exit ${exit}`);
  if (exit === 1 && detectors.length === 0) {
    throw new Error("gitleaks failed closed: exit 1 produced no secret findings");
  }
  if (exit === 0 && detectors.length > 0) {
    throw new Error("gitleaks failed closed: secret findings produced exit 0");
  }
}

export function javascriptDiagnostic(finding: Finding): string {
  return `SUPPLY_CHAIN_JS_VULNERABILITY package=${finding.package} advisory=${finding.advisory} severity=${finding.severity}`;
}

export function rustDiagnostic(finding: Finding): string {
  return `SUPPLY_CHAIN_RUST_VULNERABILITY crate=${finding.package} advisory=${finding.advisory}`;
}

export function containerDiagnostic(finding: Finding & { image: string }): string {
  return `SUPPLY_CHAIN_CONTAINER_VULNERABILITY image=${finding.image} advisory=${finding.advisory} package=${finding.package} severity=${finding.severity}`;
}

export function secretDiagnostic(detector: string): string {
  return `SUPPLY_CHAIN_SECRET detector=${detector}`;
}

async function dependencyGate(): Promise<void> {
  await assertExactManifestPins();
  await run(["bun", "install", "--frozen-lockfile"]);
  const bunAuditPath = path.join(reportRoot, "bun-audit.raw.json");
  const bunResult = await run(["bun", "audit", "--json"], {
    allowFailure: true,
    maxStdoutBytes: maxBunAuditOutputBytes,
    stdoutPath: bunAuditPath,
  });
  if (bunResult !== 0 && bunResult !== 1)
    throw new Error(`bun audit failed with exit ${bunResult}`);
  const audit = parseBunAuditOutput(await readFile(bunAuditPath));
  const policy = JSON.parse(await readFile(policyPath, "utf8")) as Policy;
  const evaluation = evaluateJavaScriptAudit(audit, policy, await lockedVersions());
  await rm(bunAuditPath, { force: true });
  await writeReport("javascript-dependencies.json", {
    version: 1,
    findings: evaluation.accepted,
    remediated: evaluation.remediated,
    exceptions: evaluation.excepted.map((finding) => {
      const exception = policy.exceptions.find(
        (entry) => entry.package === finding.package && String(entry.advisory) === finding.advisory,
      );
      if (!exception) throw new Error("evaluated advisory exception is missing");
      return {
        ...finding,
        expiresAt: exception.expiresAt,
        followUpIssue: exception.followUpIssue,
        owner: exception.owner,
        runtimeReachable: exception.runtimeReachable,
      };
    }),
  });
  for (const finding of evaluation.blocked) {
    console.error(javascriptDiagnostic(finding));
  }
  if (evaluation.blocked.length > 0) process.exitCode = 1;

  const cargoPath = path.join(reportRoot, "cargo-audit.raw.json");
  const cargoResult = await run(["cargo", "audit", "--json"], {
    allowFailure: true,
    stdoutPath: cargoPath,
  });
  if (cargoResult !== 0 && cargoResult !== 1) {
    throw new Error(`cargo audit failed with exit ${cargoResult}`);
  }
  const cargoFindings = evaluateCargoAudit(JSON.parse(await readFile(cargoPath, "utf8")));
  await rm(cargoPath, { force: true });
  await writeReport("rust-dependencies.json", { version: 1, findings: cargoFindings });
  for (const finding of cargoFindings) {
    console.error(rustDiagnostic(finding));
  }
  if (cargoFindings.length > 0) process.exitCode = 1;
  if (process.exitCode) throw new Error("dependency security gate failed");
}

async function secretGate(source: string): Promise<void> {
  const rawPath = path.join(reportRoot, "gitleaks.raw.json");
  const extraction = await mkdtemp(path.join(reportRoot, "committed-tree-"));
  let detectors: string[];
  try {
    const archive = path.join(extraction, "tree.tar");
    const tree = path.join(extraction, "tree");
    await mkdir(tree);
    await run(["git", "archive", "--format=tar", `--output=${archive}`, "HEAD"], { cwd: source });
    await run(["tar", "-xf", archive, "-C", tree]);
    const result = await run(
      [
        "gitleaks",
        "dir",
        "--no-banner",
        "--redact",
        "--report-format",
        "json",
        "--report-path",
        rawPath,
        tree,
      ],
      { allowFailure: true },
    );
    detectors = evaluateGitleaksReport(JSON.parse(await readFile(rawPath, "utf8")));
    assertGitleaksResult(result, detectors);
  } finally {
    await rm(rawPath, { force: true });
    await rm(extraction, { force: true, recursive: true });
  }
  await writeReport("secrets.json", {
    version: 1,
    findings: detectors.map((detector) => ({ detector })),
  });
  for (const detector of detectors) {
    console.error(secretDiagnostic(detector));
  }
  if (detectors.length > 0) throw new Error("repository secret security gate failed");
}

async function imageGate(manifestPath: string): Promise<void> {
  const manifest = JSON.parse(await readFile(path.resolve(root, manifestPath), "utf8"));
  if (!isRecord(manifest) || !Array.isArray(manifest.images)) {
    throw new Error("OCI image lock is invalid");
  }
  if (manifest.images.length === 0) throw new Error("OCI image lock has no service artifacts");
  const commit = requiredCommit(manifest.commit);
  const head = (await git(["rev-parse", "HEAD"])).trim();
  if (commit !== head)
    throw new Error("OCI image lock commit does not match exact checked-out HEAD");
  if (manifest.sourceDirty !== false || manifest.sourceKind !== "git-archive") {
    throw new Error("OCI image lock must come from a clean immutable git archive");
  }
  const allFindings: Array<Finding & { image: string }> = [];
  const imageNames = new Set<string>();
  for (const image of manifest.images) {
    if (!isRecord(image)) throw new Error("OCI image lock entry is invalid");
    const name = requiredString(image.name, "OCI image name");
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(name) || imageNames.has(name)) {
      throw new Error(`OCI image name is invalid or duplicated: ${name}`);
    }
    imageNames.add(name);
    const digest = requiredDigest(image.digest);
    const archive = path.join(path.dirname(path.resolve(root, manifestPath)), `${name}.oci.tar`);
    evaluateOciIndex(JSON.parse(await capture(["tar", "-xOf", archive, "index.json"])), digest);
    const rawPath = path.join(reportRoot, `trivy-${name}.raw.json`);
    const extraction = await mkdtemp(path.join(reportRoot, `trivy-${name}-`));
    try {
      await run(["tar", "-xf", archive, "-C", extraction]);
      const result = await run(trivyArguments(extraction, rawPath), { allowFailure: true });
      if (result !== 0 && result !== 1) assertTrivyResult(result, [], name);
      const findings = evaluateTrivyReport(JSON.parse(await readFile(rawPath, "utf8")));
      assertTrivyResult(result, findings, name);
      allFindings.push(...findings.map((finding) => ({ ...finding, image: name })));
    } finally {
      await rm(rawPath, { force: true });
      await rm(extraction, { force: true, recursive: true });
    }
  }
  await writeReport("containers.json", { version: 1, findings: allFindings });
  for (const finding of allFindings) {
    console.error(containerDiagnostic(finding));
  }
  if (allFindings.length > 0) throw new Error("container security gate failed");
}

async function assertExactManifestPins(): Promise<void> {
  const glob = new Bun.Glob("**/package.json");
  const failures: string[] = [];
  for await (const relative of glob.scan({ cwd: root })) {
    if (relative.startsWith("node_modules/") || relative.includes("/node_modules/")) continue;
    const payload: unknown = JSON.parse(await readFile(path.join(root, relative), "utf8"));
    if (!isRecord(payload)) throw new Error(`${relative} is not a JSON object`);
    for (const section of [
      "catalog",
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "overrides",
      "resolutions",
    ] as const) {
      const dependencies = payload[section];
      if (!isRecord(dependencies)) continue;
      for (const [name, value] of Object.entries(dependencies)) {
        if (
          typeof value !== "string" ||
          (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(value) &&
            !value.startsWith("workspace:") &&
            value !== "catalog:" &&
            !/^npm:(?:@[^/]+\/)?[^@]+@[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(value))
        ) {
          failures.push(`${relative}:${section}:${name}=${String(value)}`);
        }
      }
    }
  }
  if (failures.length > 0) {
    for (const failure of failures) console.error(`SUPPLY_CHAIN_UNPINNED_DEPENDENCY ${failure}`);
    throw new Error("dependency manifests must use exact versions");
  }
}

async function lockedVersions(): Promise<Map<string, string[]>> {
  const lock = await readFile(path.join(root, "bun.lock"), "utf8");
  const result = new Map<string, string[]>();
  for (const match of lock.matchAll(
    /^\s+"[^"]+": \["((?:@[^/"]+\/)?[^@"\s]+)@([0-9]+\.[0-9]+\.[0-9]+)[^"]*"/gmu,
  )) {
    const packageName = match[1]!;
    const version = match[2]!;
    const versions = result.get(packageName) ?? [];
    if (!versions.includes(version)) versions.push(version);
    result.set(packageName, versions);
  }
  return result;
}

function validatePolicy(policy: Policy, today: string): void {
  if (policy.version !== 1) throw new Error("advisory policy version is invalid");
  const seen = new Set<string>();
  for (const exception of policy.exceptions) {
    const key = `${exception.package}:${exception.advisory}`;
    if (seen.has(key)) throw new Error(`duplicate advisory exception ${key}`);
    seen.add(key);
    if (
      exception.severity !== "high" ||
      exception.runtimeReachable !== false ||
      exception.runtimeReachability.length < 20 ||
      exception.compensatingControls.length < 20 ||
      !exception.owner ||
      !/^A-[0-9]+$/u.test(exception.followUpIssue)
    ) {
      throw new Error(`advisory exception ${key} is incomplete`);
    }
    const parsedExpiry = new Date(`${exception.expiresAt}T00:00:00.000Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/u.test(exception.expiresAt) ||
      Number.isNaN(parsedExpiry.valueOf()) ||
      parsedExpiry.toISOString().slice(0, 10) !== exception.expiresAt
    ) {
      throw new Error(`advisory exception ${key} has an invalid expiry`);
    }
    if (exception.expiresAt < today) throw new Error(`advisory exception ${key} expired`);
  }
}

async function writeReport(name: string, payload: unknown): Promise<void> {
  await writeFile(path.join(reportRoot, name), `${JSON.stringify(payload, null, 2)}\n`, {
    mode: 0o600,
  });
}

async function run(
  command: string[],
  options: {
    allowFailure?: boolean;
    cwd?: string;
    env?: Record<string, string>;
    maxStdoutBytes?: number;
    stdoutPath?: string;
  } = {},
): Promise<number> {
  if (options.maxStdoutBytes !== undefined && !options.stdoutPath) {
    throw new Error("maxStdoutBytes requires stdoutPath");
  }
  const child = Bun.spawn(command, {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...options.env },
    stderr: "inherit",
    stdout: options.stdoutPath ? "pipe" : "inherit",
  });
  const captured =
    options.stdoutPath && child.stdout
      ? options.maxStdoutBytes === undefined
        ? new Response(child.stdout).arrayBuffer().then((output) => new Uint8Array(output))
        : readBoundedStdout(
            child.stdout,
            options.maxStdoutBytes,
            () => child.kill(),
            command.join(" "),
          )
      : Promise.resolve<Uint8Array | null>(null);
  let exit: number;
  let output: Uint8Array | null;
  try {
    [exit, output] = await Promise.all([child.exited, captured]);
  } catch (error) {
    child.kill();
    await child.exited;
    throw error;
  }
  if (options.stdoutPath && output) await writeFile(options.stdoutPath, output);
  if (exit !== 0 && !options.allowFailure) throw new Error(`${command.join(" ")} failed`);
  return exit;
}

async function readBoundedStdout(
  stdout: ReadableStream<Uint8Array>,
  maxBytes: number,
  terminate: () => void,
  command: string,
): Promise<Uint8Array> {
  const reader = stdout.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        terminate();
        throw new Error(`${command} stdout exceeds the size limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function capture(command: string[]): Promise<string> {
  const child = Bun.spawn(command, { cwd: root, stderr: "inherit", stdout: "pipe" });
  const output = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) throw new Error(`${command.join(" ")} failed`);
  return output;
}

async function git(args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd: root, stderr: "inherit", stdout: "pipe" });
  const output = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return output;
}

function requiredOption(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function optionalOption(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value?.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function requiredCommit(value: unknown): string {
  const commit = requiredString(value, "commit");
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error("commit must be a full Git SHA");
  return commit;
}

function requiredDigest(value: unknown): string {
  const digest = requiredString(value, "artifact digest");
  if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) throw new Error("artifact digest is invalid");
  return digest;
}

function requiredString(value: unknown, description: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${description} is invalid`);
  return value;
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return 0;
}

async function sha256File(filename: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(filename))
    .digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
