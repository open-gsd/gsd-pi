import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { _getAdapter, closeDatabase, getAllMilestones, insertMilestone, isDbAvailable, openDatabase } from "../gsd-db.ts";
import { openProjectDbIfPresent } from "../auto-start.ts";
import { emitWorktreeMerged } from "../worktree-telemetry.ts";

test.afterEach(() => {
  if (isDbAvailable()) closeDatabase();
});

test("startup database open treats merge JSONL as projection-only", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-merged-reconcile-"));
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Merged Milestone", status: "active" });

    emitWorktreeMerged(base, "M001", { reason: "milestone-complete", conflict: false });
    const before = getAllMilestones();
    closeDatabase();

    await openProjectDbIfPresent(base);

    assert.deepEqual(getAllMilestones(), before);
    // The first open binds the database to this checkout, adopts its rows
    // and advances the Authority Epoch. No other
    // Domain Operation runs.
    assert.deepEqual(
      _getAdapter()!.prepare("SELECT operation_type FROM workflow_operations ORDER BY resulting_revision").all()
        .map((row) => row["operation_type"]),
      ["lifecycle.backfill", "authority.cutover"],
    );
    assert.equal(_getAdapter()!.prepare("SELECT project_root_realpath FROM project_authority").get()?.["project_root_realpath"], realpathSync(base));
  } finally {
    if (isDbAvailable()) closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("bootstrap has no PROJECT.md → canonical milestone reconciliation path", () => {
  // Structural refusal guard: bootstrap must never promote PROJECT.md
  // "Milestone Sequence" checkboxes into canonical DB authority. The exported
  // no-op stub `reconcileProjectMilestonesFromDisk` was deleted; this test
  // fails if anyone reintroduces a disk-reconciliation path in auto-start.ts.
  // The behavioral proof (startup performs zero authority writes with a
  // PROJECT.md present) lives in implicit-import-startup-authority.test.ts.
  const source = readFileSync(resolve(import.meta.dirname, "..", "auto-start.ts"), "utf-8");
  assert.equal(
    source.includes("reconcileProjectMilestonesFromDisk"),
    false,
    "auto-start.ts must not reintroduce a PROJECT.md milestone reconciliation export",
  );
  assert.equal(
    /PROJECT\.md|Milestone Sequence/.test(source),
    false,
    "bootstrap must not parse PROJECT.md milestone sequences into canonical authority",
  );
});