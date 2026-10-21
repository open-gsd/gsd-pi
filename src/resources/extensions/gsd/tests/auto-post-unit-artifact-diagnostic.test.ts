import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  _describeArtifactVerificationFailureForTest,
  maybeWriteParallelResearchCostSpikeBlocker,
} from "../auto-post-unit.ts";
import { resolveExpectedArtifactPath } from "../auto-recovery.ts";
import { _clearGsdRootCache, clearPathCache } from "../paths.ts";

test("missing execute-task artifact includes completion contract and completion-tool hint", () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-artifact-diag-"));
  const taskDir = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
  mkdirSync(taskDir, { recursive: true });

  const msg = _describeArtifactVerificationFailureForTest("execute-task", "M001/S01/T01", base);
  assert.match(msg, /was not found on disk after unit execution/);
  assert.match(msg, /Task T01 marked \[x\].*summary written/i);
  assert.match(msg, /No completion tool call detected \(`gsd_task_complete`\/alias\)/);
});

test("missing execute-task artifact skips completion-tool hint when completion tool call is present", () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-artifact-diag-"));
  const taskDir = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
  mkdirSync(taskDir, { recursive: true });

  const msg = _describeArtifactVerificationFailureForTest(
    "execute-task",
    "M001/S01/T01",
    base,
    [{ content: [{ type: "toolCall", name: "gsd_task_complete" }] }],
  );
  assert.match(msg, /was not found on disk after unit execution/);
  assert.doesNotMatch(msg, /No completion tool call detected \(`gsd_task_complete`\/alias\)/);
});

test("missing run-uat artifact names gsd_uat_result_save (#1781 O-4)", () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-artifact-diag-uat-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });

  const msg = _describeArtifactVerificationFailureForTest("run-uat", "M001/S01", base);
  assert.match(msg, /ASSESSMENT\.md was not found on disk after unit execution/);
  assert.match(msg, /gsd_uat_result_save/);
});

test("missing validate-milestone artifact names gsd_validate_milestone (#1781 O-4)", () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-artifact-diag-validate-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });

  const msg = _describeArtifactVerificationFailureForTest("validate-milestone", "M001", base);
  assert.match(msg, /was not found on disk after unit execution/);
  assert.match(msg, /gsd_validate_milestone/);
});

test("parallel research cost spike writes durable PARALLEL-BLOCKER", () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-parallel-cost-blocker-"));
  try {
    mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
    const blocker = maybeWriteParallelResearchCostSpikeBlocker(
      "research-slice",
      "M001/parallel-research",
      base,
      3.73,
      1.02,
    );

    const expected = resolveExpectedArtifactPath("research-slice", "M001/parallel-research", base);
    assert.match(blocker ?? "", /M001-PARALLEL-BLOCKER\.md/);
    assert.ok(expected);
    assert.equal(existsSync(expected!), true);
    assert.match(readFileSync(expected!, "utf-8"), /cost spike detected \(3\.73 vs avg 1\.02\)/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ── #1238: symlinked project root must not produce a ../ path walk ────────────
//
// On WSL (and any layout where the project root is reached through a symlink),
// artifact resolution canonicalizes through gsdRoot (realpathSync), so the
// resolved artifact path lives under the REAL root while `basePath` is still the
// symlink. Before the fix, relative(symlinkBase, realArtifactPath) walked up out
// of the symlink (../../…/home/…) and the diagnostic reported that broken path as
// "not found on disk". Normalizing basePath to its real path first keeps the
// displayed path anchored at the real .gsd root.

test("symlinked project root yields a clean .gsd-relative artifact path, not a ../ walk (#1238)", () => {
  const realRoot = realpathSync(mkdtempSync(join(tmpdir(), "gsd-symlink-real-")));
  const linkParent = realpathSync(mkdtempSync(join(tmpdir(), "gsd-symlink-link-")));
  const linkRoot = join(linkParent, "project");
  try {
    // Content-bearing legacy milestone dir so plan-milestone resolves the
    // canonical (realpath) ROADMAP path under realRoot/.gsd/milestones/M001/.
    const milestoneDir = join(realRoot, ".gsd", "milestones", "M001");
    mkdirSync(milestoneDir, { recursive: true });
    writeFileSync(join(milestoneDir, "M001-CONTEXT.md"), "# context\n");
    // The ROADMAP intentionally does not exist — this hits the "not found on
    // disk" branch, the exact symptom in #1238.
    symlinkSync(realRoot, linkRoot);

    _clearGsdRootCache();
    clearPathCache();

    const msg = _describeArtifactVerificationFailureForTest("plan-milestone", "M001", linkRoot);

    assert.match(msg, /was not found on disk after unit execution/);
    // The displayed path must be anchored at the real .gsd root, not a broken
    // parent-walk out of the symlinked base.
    assert.doesNotMatch(msg, /\.\.[/\\]/, "must not contain a ../ walk out of the symlinked base");
    assert.match(
      msg,
      /\.gsd[/\\]milestones[/\\]M001[/\\]M001-ROADMAP\.md/,
      "must show the clean .gsd-relative ROADMAP path",
    );
  } finally {
    _clearGsdRootCache();
    clearPathCache();
    rmSync(linkParent, { recursive: true, force: true });
    rmSync(realRoot, { recursive: true, force: true });
  }
});
