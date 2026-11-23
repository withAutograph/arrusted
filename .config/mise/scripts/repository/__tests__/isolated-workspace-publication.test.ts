import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyInPlacePublication, createPlan, materializeIsolatedWorkspace, PublicationInterrupted,
  PublicationRefused, recoverPendingPublication, simulatedGithubDraftPullRequest, snapshotPath,
  type Replacement,
} from "../isolated-workspace-publication";

const roots: string[] = [];
const command = (root: string, args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "isolated-publication-")); roots.push(root);
  command(root, ["init", "-q"]); command(root, ["config", "user.email", "proof@example.invalid"]); command(root, ["config", "user.name", "Proof"]);
  writeFileSync(join(root, "touched.txt"), "before\n"); writeFileSync(join(root, "untouched.txt"), "clean\n");
  command(root, ["add", "."]); command(root, ["commit", "-qm", "base"]);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const replacement = (path: string, value: string): Replacement => ({ path, snapshot: { exists: true, kind: "file", mode: 0o640, bytes: Buffer.from(value).toString("base64") } });

describe("isolated workspace publication", () => {
  it("materializes new-local and existing-local through one immutable worktree pipeline", () => {
    const root = fixture(); const revision = command(root, ["rev-parse", "HEAD"]);
    for (const kind of ["new-local", "existing-local"] as const) {
      const workspace = materializeIsolatedWorkspace({ kind, root, revision });
      expect(command(workspace, ["rev-parse", "HEAD"])).toBe(revision);
      expect(command(workspace, ["status", "--porcelain"])).toBe("");
      command(root, ["worktree", "remove", "--force", workspace]);
    }
  });

  it("rejects stale bases and dirty overlap while preserving unrelated bytes", () => {
    const root = fixture(); const plan = createPlan(root, [replacement("touched.txt", "after\n")]);
    command(root, ["commit", "--allow-empty", "-qm", "new base"]);
    expect(() => applyInPlacePublication(root, plan)).toThrow("stale publication base");
    const fresh = createPlan(root, [replacement("touched.txt", "after\n")]);
    writeFileSync(join(root, "touched.txt"), "human edit\n");
    expect(() => applyInPlacePublication(root, fresh)).toThrow("target status changed");
    writeFileSync(join(root, "touched.txt"), "before\n"); writeFileSync(join(root, "untouched.txt"), "unrelated edit\n");
    const unrelated = createPlan(root, [replacement("touched.txt", "after\n")]);
    applyInPlacePublication(root, unrelated);
    expect(readFileSync(join(root, "touched.txt"), "utf8")).toBe("after\n");
    expect(readFileSync(join(root, "untouched.txt"), "utf8")).toBe("unrelated edit\n");
  });

  it("recovers exact typed state after every durable transition", () => {
    for (const transition of ["prepared", "applying", "replaced:touched.txt", "replaced:link", "completed"]) {
      const root = fixture(); symlinkSync("touched.txt", join(root, "link"));
      const plan = createPlan(root, [replacement("touched.txt", "after\n"), replacement("link", "replacement\n")]);
      const before = { file: snapshotPath(root, "touched.txt"), link: snapshotPath(root, "link") };
      expect(() => applyInPlacePublication(root, plan, (event) => { if (event === transition) throw new PublicationInterrupted(event); })).toThrow(PublicationInterrupted);
      recoverPendingPublication(root);
      if (transition === "completed") {
        expect(snapshotPath(root, "touched.txt")).toEqual(plan.replacements[0]!.snapshot);
        expect(snapshotPath(root, "link")).toEqual(plan.replacements[1]!.snapshot);
      } else {
        expect(snapshotPath(root, "touched.txt")).toEqual(before.file);
        expect(snapshotPath(root, "link")).toEqual(before.link);
      }
    }
  });

  it("preserves modes and refuses unsupported metadata or concurrent writers", () => {
    const root = fixture(); chmodSync(join(root, "touched.txt"), 0o751);
    const plan = createPlan(root, [replacement("touched.txt", "after\n")]); applyInPlacePublication(root, plan);
    expect(lstatSync(join(root, "touched.txt")).mode & 0o777).toBe(0o640);
    expect(() => createPlan(root, [{ path: ".", snapshot: { exists: false } }])).toThrow(PublicationRefused);
    const concurrent = createPlan(root, [replacement("untouched.txt", "new\n")]);
    mkdirSync(join(root, ".git", "isolated-workspace-publication", "target.lock"), { recursive: true });
    expect(() => applyInPlacePublication(root, concurrent)).toThrow("another writer cannot be excluded");
  });

  it("simulates a GitHub draft payload without a repository, branch, or pull request operation", () => {
    const root = fixture(); const plan = createPlan(root, [replacement("touched.txt", "after\n")]);
    expect(simulatedGithubDraftPullRequest({ repository: "example/template", revision: plan.baseSha }, plan)).toMatchObject({ draft: true, operations: [], baseRevision: plan.baseSha });
  });
});
