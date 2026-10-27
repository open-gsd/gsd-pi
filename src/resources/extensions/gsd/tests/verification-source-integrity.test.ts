// Project/App: gsd-pi
// File Purpose: Executable contract for deterministic fail-closed verification source snapshots.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";

import {
  captureMilestoneVerificationSourceRevision,
  captureVerificationSourceSnapshot,
  confirmVerificationSourceSnapshot,
  diagnoseMilestoneVerificationSourceDrift,
  resolveVerificationRepositoryTargets,
  verificationSourceChanged,
  verificationSourceSnapshotOptions,
} from "../verification-source-integrity.js";

const tempDirs = new Set<string>();

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createRepository(name: string): string {
  const cwd = mkdtempSync(join(tmpdir(), `gsd-source-${name}-`));
  tempDirs.add(cwd);
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.email", "test@example.com"]);
  git(cwd, ["config", "user.name", "Test User"]);
  writeFileSync(join(cwd, "tracked.txt"), "base\n");
  git(cwd, ["add", "tracked.txt"]);
  git(cwd, ["commit", "-qm", "base"]);
  return cwd;
}

function capture(
  targets: Array<{ id: string; cwd: string }>,
  options: Parameters<typeof captureVerificationSourceSnapshot>[1] = {},
) {
  const result = captureVerificationSourceSnapshot(targets, options);
  assert.equal(result.ok, true, result.ok ? undefined : result.error);
  return result.snapshot;
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("parent-workspace verification defaults to the orchestration root", () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-source-parent-workspace-"));
  tempDirs.add(base);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  mkdirSync(join(base, "frontend"));
  mkdirSync(join(base, "backend"));

  const resolved = resolveVerificationRepositoryTargets(base, {
    workspace: {
      mode: "parent",
      repositories: {
        frontend: { path: "frontend" },
        backend: { path: "backend" },
      },
    },
  }, null, null);

  assert.deepEqual(resolved.repositories.map((repository) => repository.id), ["project"]);
  assert.equal(resolved.explicitTargetsRequested, false);
});

test("source revision changes for staged, unstaged, and untracked content", () => {
  const cwd = createRepository("changes");
  const base = capture([{ id: "root", cwd }]);

  writeFileSync(join(cwd, "tracked.txt"), "staged\n");
  git(cwd, ["add", "tracked.txt"]);
  const staged = capture([{ id: "root", cwd }]);
  assert.notEqual(staged.aggregateRevision, base.aggregateRevision);

  writeFileSync(join(cwd, "tracked.txt"), "unstaged\n");
  const unstaged = capture([{ id: "root", cwd }]);
  assert.notEqual(unstaged.aggregateRevision, staged.aggregateRevision);

  writeFileSync(join(cwd, "untracked.txt"), "untracked\n");
  const untracked = capture([{ id: "root", cwd }]);
  assert.notEqual(untracked.aggregateRevision, unstaged.aggregateRevision);
});

test("source revision is stable when the verified working tree is committed unchanged", () => {
  const cwd = createRepository("commit-stability");
  writeFileSync(join(cwd, "tracked.txt"), "verified\n");
  writeFileSync(join(cwd, "new-source.txt"), "new source\n");

  const beforeCommit = capture([{ id: "root", cwd }]);
  git(cwd, ["add", "tracked.txt", "new-source.txt"]);
  const staged = capture([{ id: "root", cwd }]);
  git(cwd, ["commit", "-qm", "verified source"]);
  const afterCommit = capture([{ id: "root", cwd }]);

  assert.equal(staged.aggregateRevision, beforeCommit.aggregateRevision);
  assert.equal(afterCommit.aggregateRevision, beforeCommit.aggregateRevision);
});

test("source drift diagnostics identify paths captured by the pre-merge auto-commit", () => {
  const cwd = createRepository("auto-commit-drift");
  writeFileSync(join(cwd, "ad-hoc-helper.ps1"), "Write-Output helper\n");
  git(cwd, ["add", "ad-hoc-helper.ps1"]);
  git(cwd, ["commit", "-qm", "chore: auto-commit before milestone merge"]);

  assert.deepEqual(diagnoseMilestoneVerificationSourceDrift(cwd, undefined), {
    paths: ["ad-hoc-helper.ps1"],
    autoCommitDetected: true,
  });
});

test("candidate snapshots exclude only the generated dossier self-reference", () => {
  const cwd = createRepository("dossier-exclusion");
  const dossierDir = join(cwd, "docs", "dev");
  mkdirSync(dossierDir, { recursive: true });
  const dossierPath = join(dossierDir, "m003-s07-cutover-dossier.json");
  writeFileSync(dossierPath, "first dossier\n");
  const targets = [{ id: "root", cwd }];
  const options = { excludePaths: ["docs/dev/m003-s07-cutover-dossier.json"] };
  const firstCandidate = capture(targets, options);
  const firstDefault = capture(targets);

  writeFileSync(dossierPath, "second dossier\n");

  assert.equal(capture(targets, options).aggregateRevision, firstCandidate.aggregateRevision);
  assert.notEqual(capture(targets).aggregateRevision, firstDefault.aggregateRevision);
});

test("staged deletion has the same source revision after commit", () => {
  const cwd = createRepository("delete-stability");
  rmSync(join(cwd, "tracked.txt"));
  git(cwd, ["add", "tracked.txt"]);

  const stagedDeletion = capture([{ id: "root", cwd }]);
  git(cwd, ["commit", "-qm", "remove source"]);
  const committedDeletion = capture([{ id: "root", cwd }]);

  assert.equal(committedDeletion.aggregateRevision, stagedDeletion.aggregateRevision);
});

test("multi-target proof is deterministic and keyed by target identity", () => {
  const alpha = createRepository("alpha");
  const beta = createRepository("beta");
  writeFileSync(join(beta, "tracked.txt"), "beta\n");

  const forward = capture([{ id: "alpha", cwd: alpha }, { id: "beta", cwd: beta }]);
  const reverse = capture([{ id: "beta", cwd: beta }, { id: "alpha", cwd: alpha }]);

  assert.deepEqual(reverse, forward);
  assert.deepEqual(forward.targets.map((target) => target.targetId), ["alpha", "beta"]);
  assert.notEqual(forward.targets[0]?.revision, forward.targets[1]?.revision);
});

test("capture fails closed when any target cannot produce a Git snapshot", () => {
  const valid = createRepository("valid");
  const invalid = mkdtempSync(join(tmpdir(), "gsd-source-invalid-"));
  tempDirs.add(invalid);

  const result = captureVerificationSourceSnapshot([
    { id: "valid", cwd: valid },
    { id: "invalid", cwd: invalid },
  ]);

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("non-repository target unexpectedly produced a source proof");
  assert.equal(result.targetId, "invalid");
  assert.match(result.error, /git|repository|snapshot/i);
});

test("capture fails closed when a nested submodule has unpublished source changes", () => {
  const upstream = createRepository("submodule-upstream");
  const cwd = createRepository("submodule-parent");
  git(cwd, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", upstream, "vendor/dependency"]);
  git(cwd, ["commit", "-qam", "add dependency"]);
  capture([{ id: "root", cwd }]);

  writeFileSync(join(cwd, "vendor/dependency/tracked.txt"), "unpublished\n");
  const result = captureVerificationSourceSnapshot([{ id: "root", cwd }]);

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("dirty submodule unexpectedly produced publishable source proof");
  assert.equal(result.targetId, "root");
  assert.match(result.error, /dirty|publish|submodule/i);
});

test("pre/post snapshots detect verification-time source drift", () => {
  const cwd = createRepository("drift");
  const before = capture([{ id: "root", cwd }]);
  writeFileSync(join(cwd, "tracked.txt"), "changed during verification\n");
  const after = capture([{ id: "root", cwd }]);

  assert.equal(verificationSourceChanged(before, after), true);
  assert.equal(verificationSourceChanged(after, after), false);
});

test("stability confirmation fails when source mutates between samples", () => {
  const cwd = createRepository("unstable");
  const expected = capture([{ id: "root", cwd }]);
  writeFileSync(join(cwd, "tracked.txt"), "mutated between samples\n");

  const confirmation = confirmVerificationSourceSnapshot([{ id: "root", cwd }], expected);

  assert.equal(confirmation.ok, false);
  if (confirmation.ok) assert.fail("unstable source unexpectedly confirmed");
  assert.equal(confirmation.targetId, "root");
  assert.match(confirmation.error, /changed|stable|snapshot/i);
});

test("workflow state under .gsd does not change the tested source revision", () => {
  const cwd = createRepository("workflow-state");
  mkdirSync(join(cwd, ".gsd"), { recursive: true });
  writeFileSync(join(cwd, ".gsd", "state.json"), "{\"revision\":1}\n");
  git(cwd, ["add", "-f", ".gsd/state.json"]);
  git(cwd, ["commit", "-qm", "workflow state"]);
  const before = capture([{ id: "root", cwd }]);

  writeFileSync(join(cwd, ".gsd", "state.json"), "{\"revision\":2}\n");
  writeFileSync(join(cwd, ".gsd", "projection.md"), "generated\n");
  const after = capture([{ id: "root", cwd }]);

  assert.equal(after.aggregateRevision, before.aggregateRevision);
});

test("tracked bookkeeping under a symlinked .gsd does not change the tested source revision", () => {
  const cwd = createRepository("symlinked-state");
  const stateDir = join(cwd, ".gsd-state", "projects", "abc123");
  mkdirSync(stateDir, { recursive: true });
  symlinkSync(stateDir, join(cwd, ".gsd"), "dir");
  writeFileSync(join(stateDir, "CODEBASE.md"), "# codebase\n");
  git(cwd, ["add", "-f", ".gsd-state/projects/abc123/CODEBASE.md"]);
  git(cwd, ["commit", "-qm", "durable bookkeeping"]);
  const before = capture([{ id: "root", cwd }]);

  writeFileSync(join(cwd, ".gsd", "CODEBASE.md"), "# codebase (regenerated)\n");
  writeFileSync(join(cwd, ".gsd", "S01-T01-VERIFY.json"), "{\"verdict\":\"pass\"}\n");
  const after = capture([{ id: "root", cwd }]);

  assert.equal(after.aggregateRevision, before.aggregateRevision);
});

test("a .gsd symlink resolving to the repository parent still produces a source proof", () => {
  const cwd = createRepository("parent-symlinked-state");
  // `relative()` yields exactly ".." here — without treating that as outside-repo
  // the pathspec would become `:(exclude)..` and git would reject the command.
  symlinkSync(dirname(cwd), join(cwd, ".gsd"), "dir");

  const before = capture([{ id: "root", cwd }]);
  writeFileSync(join(cwd, "tracked.txt"), "changed\n");
  const after = capture([{ id: "root", cwd }]);

  assert.notEqual(after.aggregateRevision, before.aggregateRevision);
});

test("source snapshot ignores tracked receipts/** bookkeeping (#1819)", () => {
  const cwd = createRepository("receipts-exclude");
  writeFileSync(join(cwd, "src.ts"), "export {}\n");
  git(cwd, ["add", "src.ts"]);
  git(cwd, ["commit", "-m", "src"]);
  const before = capture([{ id: "root", cwd }]);

  mkdirSync(join(cwd, "receipts"), { recursive: true });
  writeFileSync(join(cwd, "receipts", "receipts.jsonl"), "{\"call\":1}\n");
  git(cwd, ["add", "receipts/receipts.jsonl"]);
  git(cwd, ["commit", "-m", "receipts"]);

  const after = capture([{ id: "root", cwd }]);
  assert.equal(
    after.aggregateRevision,
    before.aggregateRevision,
    "tracked receipts must not move the source hash",
  );
});

test("verification_source_exclude_paths preference flows into the milestone source revision (#2873)", () => {
  const cwd = createRepository("pref-exclude");
  mkdirSync(join(cwd, "artifacts"), { recursive: true });
  writeFileSync(join(cwd, "artifacts", "battery.bin"), "one\n");
  git(cwd, ["add", "artifacts/battery.bin"]);
  git(cwd, ["commit", "-qm", "heavy non-evidence artifacts"]);

  const preferences = { verification_source_exclude_paths: ["artifacts/**"] };
  const before = captureMilestoneVerificationSourceRevision(cwd, preferences);
  if (!before.ok) throw new Error(before.error);

  writeFileSync(join(cwd, "artifacts", "battery.bin"), "two\n");
  writeFileSync(join(cwd, "artifacts", "extra.bin"), "scratch\n");
  const after = captureMilestoneVerificationSourceRevision(cwd, preferences);
  if (!after.ok) throw new Error(after.error);
  assert.equal(
    after.sourceRevision,
    before.sourceRevision,
    "changes under preference-excluded paths must not move the source revision",
  );

  writeFileSync(join(cwd, "tracked.txt"), "changed\n");
  const changed = captureMilestoneVerificationSourceRevision(cwd, preferences);
  if (!changed.ok) throw new Error(changed.error);
  assert.notEqual(changed.sourceRevision, before.sourceRevision);
});

test("verificationSourceSnapshotOptions derives excludePaths from preferences", () => {
  assert.deepEqual(verificationSourceSnapshotOptions(undefined), {});
  assert.deepEqual(verificationSourceSnapshotOptions({}), {});
  assert.deepEqual(
    verificationSourceSnapshotOptions({ verification_source_exclude_paths: [] }),
    {},
  );
  assert.deepEqual(
    verificationSourceSnapshotOptions({ verification_source_exclude_paths: ["artifacts/**", "docs/"] }),
    { excludePaths: ["artifacts/**", "docs/"] },
  );
  // A blank entry would serialize as a bare `:(exclude)` pathspec — git reads
  // that as "exclude everything", collapsing the hash to an empty tree.
  assert.deepEqual(
    verificationSourceSnapshotOptions({ verification_source_exclude_paths: ["", "  ", "artifacts/**"] }),
    { excludePaths: ["artifacts/**"] },
  );
});

test("#3024: an untracked nested repository is captured as an external reference, not a failure", () => {
  const cwd = createRepository("aggregator-root");
  const nestedAbs = join(cwd, "nested-external");
  mkdirSync(nestedAbs, { recursive: true });
  git(nestedAbs, ["init", "-q"]);
  git(nestedAbs, ["config", "user.email", "nested@example.com"]);
  git(nestedAbs, ["config", "user.name", "Nested"]);
  writeFileSync(join(nestedAbs, "inner.txt"), "inner\n");
  git(nestedAbs, ["add", "inner.txt"]);
  git(nestedAbs, ["commit", "-qm", "inner base"]);

  const result = captureVerificationSourceSnapshot([{ id: "root", cwd }]);
  if (!result.ok) assert.fail(`expected success, got: ${result.error}`);

  const again = captureVerificationSourceSnapshot([{ id: "root", cwd }]);
  if (!again.ok) assert.fail(`expected success, got: ${again.error}`);
  assert.equal(again.snapshot.aggregateRevision, result.snapshot.aggregateRevision, "descriptor is stable across captures");

  // A new commit inside the external repo changes the pinned descriptor.
  writeFileSync(join(nestedAbs, "changed.txt"), "changed\n");
  git(nestedAbs, ["add", "changed.txt"]);
  git(nestedAbs, ["commit", "-qm", "change inside nested repo"]);
  const after = captureVerificationSourceSnapshot([{ id: "root", cwd }]);
  if (!after.ok) assert.fail(`expected success after external churn, got: ${after.error}`);
  assert.notEqual(
    after.snapshot.aggregateRevision,
    result.snapshot.aggregateRevision,
    "the external descriptor tracks the nested HEAD",
  );
});

test("#3024: a tracked submodule keeps the stricter staged/clean accounting", () => {
  const upstream = createRepository("submodule-upstream-3024");
  const cwd = createRepository("submodule-parent-3024");
  git(cwd, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", upstream, "vendor/dependency"]);
  git(cwd, ["commit", "-qam", "register submodule"]);

  const result = captureVerificationSourceSnapshot([{ id: "root", cwd }]);
  if (!result.ok) assert.fail(`expected success, got: ${result.error}`);

  // A commit inside the submodule (HEAD moves past the staged gitlink) still
  // fails closed with the not-staged classification.
  const vendor = join(cwd, "vendor/dependency");
  git(vendor, ["config", "user.email", "nested@example.com"]);
  git(vendor, ["config", "user.name", "Nested"]);
  writeFileSync(join(vendor, "moved.txt"), "moved\n");
  git(vendor, ["add", "moved.txt"]);
  git(vendor, ["commit", "-qm", "move ahead"]);
  const moved = captureVerificationSourceSnapshot([{ id: "root", cwd }]);
  assert.equal(moved.ok, false);
  if (!moved.ok) assert.match(moved.error, /not staged in its parent/);
});
