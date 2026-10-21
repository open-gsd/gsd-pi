// Project/App: gsd-pi
// File Purpose: Regression for #1222 — a re-import must not silently downgrade
// a completed flat-phase task back to pending when its SUMMARY.md attests the
// completion. gsd_task_complete succeeds and writes TID-SUMMARY.md, but a stale
// plan checkbox re-imported into the DB would revert the task to pending,
// hard-stopping auto-mode on its "state did not advance" guard.

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { openDatabase, closeDatabase, getAllMilestones, getMilestoneSlices, getSliceTasks, repairTaskCompletionFromSummary } from "../gsd-db.ts";
import { migrateHierarchyToDb } from "../md-importer.ts";
import { invalidateStateCache } from "../state.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(__dirname, "__fixtures__", "flat-phase");
// The flat-phase fixture parses to M001/S01/T01 (phase 01, plan 01, task T01).
const PHASE_DIR = join(".gsd", "phases", "01-foundation");
const SUMMARY_REL = join(PHASE_DIR, "T01-SUMMARY.md");

const tmpDirs: string[] = [];
afterEach(() => {
  closeDatabase();
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  tmpDirs.length = 0;
});

function copyFixture(): string {
  const base = mkdtempSync(join(tmpdir(), `gsd-lostupdate-${randomUUID()}`));
  cpSync(FIXTURE_ROOT, base, { recursive: true });
  tmpDirs.push(base);
  return base;
}

function taskStatus(base: string): string | undefined {
  return t01Row()?.status;
}

function t01Row() {
  const ms = getAllMilestones();
  if (ms.length === 0) return undefined;
  const slices = getMilestoneSlices(ms[0]!.id);
  if (slices.length === 0) return undefined;
  const tasks = getSliceTasks(ms[0]!.id, slices[0]!.id);
  return tasks.find((t) => t.id === "T01");
}

function t01Ids() {
  const ms = getAllMilestones();
  const slices = getMilestoneSlices(ms[0]!.id);
  return { milestoneId: ms[0]!.id, sliceId: slices[0]!.id };
}

test("re-import keeps a flat-phase task complete when its SUMMARY.md is present (#1222)", () => {
  const base = copyFixture();
  // The fixture plan leaves T01 unchecked ([ ]). Simulate a completed task: the
  // durable SUMMARY.md exists even though the plan checkbox is stale-unchecked.
  writeFileSync(join(base, SUMMARY_REL), "# T01 SUMMARY\n\nDone.\n");

  openDatabase(join(base, ".gsd", "gsd.db"));
  migrateHierarchyToDb(base);
  invalidateStateCache();

  assert.equal(
    taskStatus(base),
    "complete",
    "task with SUMMARY.md on disk must import as complete, not revert to pending",
  );
});

test("re-import leaves an unchecked flat-phase task pending when no SUMMARY.md exists (#1222)", () => {
  const base = copyFixture();
  // No SUMMARY.md — the unchecked checkbox is the authoritative signal.

  openDatabase(join(base, ".gsd", "gsd.db"));
  migrateHierarchyToDb(base);
  invalidateStateCache();

  assert.equal(
    taskStatus(base),
    "pending",
    "unchecked task without a SUMMARY.md must stay pending",
  );
});

test("re-import keeps a flat-phase task complete even when an auxiliary tasks/ subdir exists (#1222)", () => {
  const base = copyFixture();
  // Flat-phase may keep a tasks/ subdir for gate artifacts (e.g. T01-VERIFY.json)
  // while gsd_task_complete still writes TID-SUMMARY.md at the phase root. The
  // tasks/ subdir must NOT shadow that real summary and downgrade the task.
  mkdirSync(join(base, PHASE_DIR, "tasks"), { recursive: true });
  writeFileSync(join(base, PHASE_DIR, "tasks", "T01-VERIFY.json"), "{}\n");
  writeFileSync(join(base, SUMMARY_REL), "# T01 SUMMARY\n\nDone.\n");

  openDatabase(join(base, ".gsd", "gsd.db"));
  migrateHierarchyToDb(base);
  invalidateStateCache();

  assert.equal(
    taskStatus(base),
    "complete",
    "a phase-root SUMMARY.md must win even when a tasks/ subdir exists (no shadowing)",
  );
});

test("re-import preserves execution metadata and completed_at of an attested-complete task (#1222)", () => {
  const base = copyFixture();
  // T01 is completed on disk (SUMMARY present) but its plan checkbox is stale-unchecked.
  writeFileSync(join(base, SUMMARY_REL), "# T01 SUMMARY\n\nDone.\n");

  openDatabase(join(base, ".gsd", "gsd.db"));
  migrateHierarchyToDb(base);
  invalidateStateCache();

  // Simulate the row gsd_task_complete leaves behind: real execution prose plus
  // a completion timestamp from when the task actually finished.
  const OLD_COMPLETED_AT = "2026-07-01T00:00:00.000Z";
  const REAL_ONE_LINER = "Implemented the widget frobnicator end-to-end";
  const REAL_SUMMARY = "# T01 full summary\n\nEverything about how T01 was done.";
  const REAL_VERIFICATION = "all 12 checks passed";
  const { milestoneId, sliceId } = t01Ids();
  repairTaskCompletionFromSummary({
    milestoneId,
    sliceId,
    taskId: "T01",
    oneLiner: REAL_ONE_LINER,
    verificationResult: REAL_VERIFICATION,
    completedAt: OLD_COMPLETED_AT,
    fullSummaryMd: REAL_SUMMARY,
  });
  invalidateStateCache();

  const before = t01Row()!;
  assert.equal(before.status, "complete", "precondition: T01 is complete");
  assert.equal(before.one_liner, REAL_ONE_LINER, "precondition: one_liner set");
  assert.equal(before.completed_at, OLD_COMPLETED_AT, "precondition: completed_at set");

  // The pre-dispatch reconcile re-imports the whole tree (plan checkbox still [ ]).
  migrateHierarchyToDb(base);
  invalidateStateCache();

  const after = t01Row()!;
  assert.equal(after.status, "complete", "status must survive re-import");
  assert.equal(after.one_liner, REAL_ONE_LINER, "one_liner must survive re-import");
  assert.equal(after.full_summary_md, REAL_SUMMARY, "full_summary_md must survive re-import");
  assert.equal(after.verification_result, REAL_VERIFICATION, "verification_result must survive re-import");
  assert.equal(after.completed_at, OLD_COMPLETED_AT, "completed_at must not be refreshed by re-import");
});

test("removing the SUMMARY.md without a DB reopen leaves the complete row in place (T021)", () => {
  const base = copyFixture();
  writeFileSync(join(base, SUMMARY_REL), "# T01 SUMMARY\n\nDone.\n");

  openDatabase(join(base, ".gsd", "gsd.db"));
  migrateHierarchyToDb(base);
  invalidateStateCache();
  assert.equal(taskStatus(base), "complete", "precondition: task imports complete with SUMMARY present");

  // Simulate the durable completion row gsd_task_complete leaves behind.
  const { milestoneId, sliceId } = t01Ids();
  repairTaskCompletionFromSummary({
    milestoneId,
    sliceId,
    taskId: "T01",
    oneLiner: "Implemented the widget frobnicator end-to-end",
    verificationResult: "all 12 checks passed",
    completedAt: "2026-07-01T00:00:00.000Z",
    fullSummaryMd: "# T01 full summary\n\nEverything about how T01 was done.",
  });
  invalidateStateCache();
  const before = t01Row()!;
  assert.equal(before.status, "complete", "precondition: T01 is complete");
  assert.equal(before.completed_at, "2026-07-01T00:00:00.000Z", "precondition: completed_at set");

  // T021: deleting the SUMMARY projection is not a status write. Unscoped
  // re-import must not treat the missing file as authority over the DB row.
  // reopen-task updates the DB itself; it does not rely on this import path.
  unlinkSync(join(base, SUMMARY_REL));
  migrateHierarchyToDb(base);
  invalidateStateCache();
  const after = t01Row()!;
  assert.equal(
    after.status,
    "complete",
    "unscoped re-import must not overwrite existing DB status when SUMMARY is gone",
  );
  assert.equal(after.completed_at, "2026-07-01T00:00:00.000Z", "completion metadata survives");
  assert.equal(after.one_liner, "Implemented the widget frobnicator end-to-end");
});
