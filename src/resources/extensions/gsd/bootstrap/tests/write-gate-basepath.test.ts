// gsd-pi write-gate bootstrap — regression test for required basePath (commit A3)
//
// Verifies that the gate writers and loadWriteGateSnapshot are pinned to the
// basePath argument and do not silently fall back to process.cwd(). The
// underlying bug: both defaulted `basePath = process.cwd()`, so a write in
// cwd-A followed by a chdir to cwd-B and a load (which also defaulted to
// process.cwd(), now cwd-B) missed the stored state entirely — the
// depth-verification state became invisible across cwd boundaries.
// Gate state is rows of the project database, so each project here has one.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  markDepthVerified,
  loadWriteGateSnapshot,
  shouldBlockContextArtifactSaveInSnapshot,
  clearDiscussionFlowState,
} from "../write-gate.js";
import { _getAdapter, closeDatabase, openDatabase } from "../../gsd-db.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** A project with a workflow database that is not open. */
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wg-basepath-test-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  openDatabase(join(dir, ".gsd", "gsd.db"));
  closeDatabase();
  return dir;
}

function verifiedMilestoneRows(): unknown[] {
  return _getAdapter()!.prepare(
    "SELECT gate_id FROM write_gate_state WHERE gate_kind = 'depth_verified' ORDER BY gate_id",
  ).all().map((row) => row["gate_id"]);
}

// Save and restore process.cwd() across tests to avoid cross-test pollution.
let originalCwd: string;
before(() => {
  originalCwd = process.cwd();
});
after(() => {
  if (process.cwd() !== originalCwd) {
    process.chdir(originalCwd);
  }
});

// ─── Scenario: write with basePath=A, chdir, load with basePath=A ───────────
//
// This is the exact failure mode from the bug: the write used process.cwd() and
// the load used process.cwd(), and they resolved to different directories after
// a chdir.  With the fix, both calls receive an explicit basePath so cwd changes
// have no effect.

describe("write-gate basePath regression", () => {
  let baseDirA: string;
  let baseDirB: string;

  before(() => {
    baseDirA = makeTempDir();
    baseDirB = makeTempDir();
  });

  after(() => {
    // Restore cwd before cleanup to avoid issues on Windows.
    process.chdir(originalCwd);
    closeDatabase();
    rmSync(baseDirA, { recursive: true, force: true });
    rmSync(baseDirB, { recursive: true, force: true });
  });

  test("gate state written to basePath=A is readable after chdir to basePath=B", () => {
    // The session works in baseDirA: its database is the open one.
    openDatabase(join(baseDirA, ".gsd", "gsd.db"));
    clearDiscussionFlowState(baseDirA);
    clearDiscussionFlowState(baseDirB);

    // Act: store a milestone as depth-verified for baseDirA.
    markDepthVerified("M001", baseDirA);

    // Confirm the row was written to the database of baseDirA.
    assert.deepEqual(verifiedMilestoneRows(), ["M001"], "the gate row is in the database of baseDirA");

    // Simulate what happens when cwd changes to a different project root.
    process.chdir(baseDirB);
    assert.notEqual(process.cwd(), baseDirA, "cwd should differ from baseDirA after chdir");

    // Load snapshot using the explicit baseDirA — must see the stored state.
    const snapshot = loadWriteGateSnapshot(baseDirA);
    assert.ok(
      snapshot.verifiedDepthMilestones.includes("M001"),
      "loadWriteGateSnapshot(baseDirA) must return the stored milestone despite cwd being baseDirB",
    );

    // Loading with baseDirB must NOT see the state from baseDirA.
    const snapshotB = loadWriteGateSnapshot(baseDirB);
    assert.ok(
      !snapshotB.verifiedDepthMilestones.includes("M001"),
      "loadWriteGateSnapshot(baseDirB) must not bleed state from baseDirA",
    );
  });

  test("worktree basePath reads depth verification from the project database", (t) => {
    const projectRoot = makeTempDir();
    const worktreePath = join(projectRoot, ".gsd-worktrees", "M020");
    t.after(() => {
      closeDatabase();
      rmSync(projectRoot, { recursive: true, force: true });
    });

    openDatabase(join(projectRoot, ".gsd", "gsd.db"));
    clearDiscussionFlowState(projectRoot);
    clearDiscussionFlowState(worktreePath);

    // Simulate MCP routing: verification recorded at project root.
    markDepthVerified("M020", projectRoot);

    // Worktree has a local .gsd projection but no database of its own.
    mkdirSync(join(worktreePath, ".gsd", "runtime"), { recursive: true });

    const snapshotFromWorktree = loadWriteGateSnapshot(worktreePath);
    assert.ok(
      snapshotFromWorktree.verifiedDepthMilestones.includes("M020"),
      "loadWriteGateSnapshot(worktree) must inherit project-root verification",
    );

    const guard = shouldBlockContextArtifactSaveInSnapshot(
      snapshotFromWorktree,
      "CONTEXT",
      "M020",
      null,
    );
    assert.equal(guard.block, false, "CONTEXT save must unblock once project-root gate is verified");
  });
});
