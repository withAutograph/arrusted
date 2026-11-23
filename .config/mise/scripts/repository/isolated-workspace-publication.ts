import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

export type PathSnapshot =
  | { exists: false }
  | { exists: true; kind: "file"; mode: number; bytes: string }
  | { exists: true; kind: "symlink"; mode: number; target: string };

export type Replacement = { path: string; snapshot: PathSnapshot };
export type PublicationPlan = {
  baseSha: string;
  expectedStatus: string;
  expectedPaths: Record<string, PathSnapshot>;
  replacements: readonly Replacement[];
};
type Journal = {
  version: 1;
  id: string;
  phase: "prepared" | "applying" | "completed";
  plan: PublicationPlan;
  snapshots: Record<string, PathSnapshot>;
  stageDirectory: string;
  applied: string[];
};

export class PublicationRefused extends Error {}
export class PublicationInterrupted extends Error {}

const git = (root: string, args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

function safePath(root: string, value: string): string {
  if (!value || value.startsWith("/") || value.split("/").some((part) => part === "..")) {
    throw new PublicationRefused(`unsafe publication path: ${value}`);
  }
  const destination = resolve(root, value);
  if (relative(root, destination).startsWith("..")) throw new PublicationRefused(`path escaped target: ${value}`);
  return destination;
}

function fsyncFile(path: string): void {
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function atomicJson(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fsyncFile(temporary);
  renameSync(temporary, path);
  fsyncDirectory(dirname(path));
}

export function snapshotPath(root: string, value: string): PathSnapshot {
  const path = safePath(root, value);
  try {
    const stat = lstatSync(path);
    const mode = stat.mode & 0o7777;
    if (stat.isFile()) return { exists: true, kind: "file", mode, bytes: readFileSync(path).toString("base64") };
    if (stat.isSymbolicLink()) return { exists: true, kind: "symlink", mode, target: readlinkSync(path) };
    throw new PublicationRefused(`metadata cannot be preserved for ${value}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
    throw error;
  }
}

function equalSnapshot(left: PathSnapshot, right: PathSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function replaceAtomically(root: string, value: string, snapshot: PathSnapshot): void {
  const destination = safePath(root, value);
  mkdirSync(dirname(destination), { recursive: true });
  if (!snapshot.exists) {
    try { unlinkSync(destination); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    fsyncDirectory(dirname(destination));
    return;
  }
  const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.stage`);
  if (snapshot.kind === "file") {
    writeFileSync(temporary, Buffer.from(snapshot.bytes, "base64"), { mode: snapshot.mode });
    chmodSync(temporary, snapshot.mode);
  } else {
    symlinkSync(snapshot.target, temporary);
  }
  fsyncFile(temporary);
  renameSync(temporary, destination);
  fsyncDirectory(dirname(destination));
}

function journalDirectory(root: string): string {
  const gitDirectory = git(root, ["rev-parse", "--git-dir"]);
  const directory = join(resolve(root, gitDirectory), "isolated-workspace-publication");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function status(root: string): string { return git(root, ["status", "--porcelain=v1", "-z"]); }

function validatePlan(root: string, plan: PublicationPlan): void {
  if (git(root, ["rev-parse", "HEAD"]) !== plan.baseSha) throw new PublicationRefused("stale publication base");
  if (status(root) !== plan.expectedStatus) throw new PublicationRefused("target status changed");
  const unique = new Set<string>();
  for (const replacement of plan.replacements) {
    safePath(root, replacement.path);
    if (unique.has(replacement.path)) throw new PublicationRefused(`duplicate publication path: ${replacement.path}`);
    unique.add(replacement.path);
    if (!equalSnapshot(snapshotPath(root, replacement.path), plan.expectedPaths[replacement.path]!)) {
      throw new PublicationRefused(`target file changed: ${replacement.path}`);
    }
  }
}

function withTargetLock<T>(root: string, run: () => T): T {
  const lock = join(journalDirectory(root), "target.lock");
  try { mkdirSync(lock, { mode: 0o700 }); } catch { throw new PublicationRefused("another writer cannot be excluded"); }
  try { return run(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

export function recoverPendingPublication(root: string): void {
  const directory = journalDirectory(root);
  for (const entry of ["journal.json"]) {
    const path = join(directory, entry);
    try {
      const journal = JSON.parse(readFileSync(path, "utf8")) as Journal;
      if (journal.phase === "completed") { rmSync(path, { force: true }); continue; }
      for (const replacement of journal.plan.replacements) replaceAtomically(root, replacement.path, journal.snapshots[replacement.path]!);
      atomicJson(path, { ...journal, phase: "completed" });
      rmSync(journal.stageDirectory, { force: true, recursive: true });
      rmSync(path, { force: true });
      fsyncDirectory(directory);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

export function applyInPlacePublication(
  root: string,
  plan: PublicationPlan,
  interruptAfter?: (transition: string) => void,
): void {
  withTargetLock(root, () => {
    recoverPendingPublication(root);
    validatePlan(root, plan);
    const snapshots = Object.fromEntries(plan.replacements.map(({ path }) => [path, snapshotPath(root, path)]));
    const journalPath = join(journalDirectory(root), "journal.json");
    const id = randomUUID();
    const stageDirectory = join(journalDirectory(root), `${id}.stage`);
    mkdirSync(stageDirectory, { recursive: true, mode: 0o700 });
    atomicJson(join(stageDirectory, "snapshots.json"), snapshots);
    atomicJson(join(stageDirectory, "replacements.json"), plan.replacements);
    let journal: Journal = { version: 1, id, phase: "prepared", plan, snapshots, stageDirectory, applied: [] };
    atomicJson(journalPath, journal);
    interruptAfter?.("prepared");
    journal = { ...journal, phase: "applying" };
    atomicJson(journalPath, journal);
    interruptAfter?.("applying");
    for (const replacement of plan.replacements) {
      // Staged replacements are durable before same-directory atomic replacement.
      replaceAtomically(root, replacement.path, replacement.snapshot);
      journal = { ...journal, applied: [...journal.applied, replacement.path] };
      atomicJson(journalPath, journal);
      interruptAfter?.(`replaced:${replacement.path}`);
    }
    journal = { ...journal, phase: "completed" };
    atomicJson(journalPath, journal);
    interruptAfter?.("completed");
    rmSync(stageDirectory, { force: true, recursive: true });
    rmSync(journalPath, { force: true });
    fsyncDirectory(journalDirectory(root));
  });
}

export function createPlan(root: string, replacements: readonly Replacement[]): PublicationPlan {
  return {
    baseSha: git(root, ["rev-parse", "HEAD"]),
    expectedStatus: status(root),
    expectedPaths: Object.fromEntries(replacements.map(({ path }) => [path, snapshotPath(root, path)])),
    replacements,
  };
}

export type LocalSource = { kind: "new-local" | "existing-local"; root: string; revision: string };
export function materializeIsolatedWorkspace(source: LocalSource, destinationParent = tmpdir()): string {
  const revision = git(source.root, ["rev-parse", `${source.revision}^{commit}`]);
  const workspace = mkdtempSync(join(destinationParent, "isolated-workspace-"));
  rmSync(workspace, { recursive: true, force: true });
  git(source.root, ["worktree", "add", "--detach", workspace, revision]);
  return workspace;
}

export function simulatedGithubDraftPullRequest(source: { repository: string; revision: string }, plan: PublicationPlan) {
  return {
    kind: "github-draft-pull-request" as const,
    draft: true,
    repository: source.repository,
    baseRevision: source.revision,
    changeSet: plan.replacements.map(({ path, snapshot }) => ({ path, snapshot })),
    operations: [] as const,
  };
}

if (import.meta.main) process.stdout.write("Run `mise run repository:publication-proof` for the isolated-workspace publication proof.\n");
