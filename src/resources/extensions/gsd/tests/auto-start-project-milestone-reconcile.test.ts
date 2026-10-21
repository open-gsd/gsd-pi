import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { _getAdapter, closeDatabase, getAllMilestones, insertMilestone, isDbAvailable, openDatabase } from "../gsd-db.ts";
import { openProjectDbIfPresent, reconcileMergedMilestonesFromJournal } from "../auto-start.ts";
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
    assert.equal(Number(_getAdapter()!.prepare("SELECT total_changes() AS count").get()?.["count"]), 0);
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
test("#1236: bootstrap merged-milestone reconciliation degrades to a warning instead of aborting when the DB is degraded", () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-merged-reconcile-degraded-"));
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Merged Milestone", status: "active" });

    emitWorktreeMerged(base, "M001", { reason: "milestone-complete", conflict: false });

    // Simulate a degraded DB: the connection stays "available" (isDbAvailable()
    // remains true because the handle is non-null), but the milestones table is
    // gone, so the reconciler's DB access throws partway through bootstrap.
    _getAdapter()!.exec("DROP TABLE milestones");
    assert.equal(isDbAvailable(), true);

    // Regression (#1236): this reconciler was previously unguarded, so a
    // degraded-DB failure threw and aborted the rest of `/gsd auto` bootstrap.
    // It must now catch, warn, and return 0. Reaching the assertion proves it
    // did not throw.
    const closed = reconcileMergedMilestonesFromJournal(base);
    assert.equal(closed, 0);
  } finally {
    if (isDbAvailable()) closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});
