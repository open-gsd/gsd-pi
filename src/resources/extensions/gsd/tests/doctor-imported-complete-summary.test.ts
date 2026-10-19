// Project/App: gsd-pi
// File Purpose: The milestone SUMMARY doctor finding is honest about imported-complete milestones (#2729).
//
// A milestone the database records as complete without a `milestone.completed`
// event (bulk import, or a database that predates the Domain Operation
// cutover) has no closeout to render a SUMMARY from. The doctor must not call
// such a milestone "stuck in completing-milestone phase" or warn forever.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDatabase, insertMilestone, insertSlice, openDatabase } from "../gsd-db.ts";
import { checkGsdStateHealth } from "../doctor-state-checks.ts";
import type { DoctorIssue } from "../doctor-types.ts";

function makeBase(t: { after(fn: () => void): void }, milestoneStatus: string): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-imported-complete-"));
  t.after(() => {
    try { closeDatabase(); } catch { /* noop */ }
    rmSync(base, { recursive: true, force: true });
  });
  const milestoneDir = join(base, ".gsd", "milestones", "M001");
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(
    join(milestoneDir, "M001-ROADMAP.md"),
    ["# M001: Imported", "", "- [x] **S01: Only slice** `risk:medium` `depends:[]`", ""].join("\n"),
  );
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Imported", status: milestoneStatus });
  insertSlice({
    id: "S01", milestoneId: "M001", title: "Only slice", status: "complete",
    risk: "medium", depends: [], demo: "S01 demo.", sequence: 1,
  });
  // No completion event, no SUMMARY.md — the imported-complete shape.
  return base;
}

test("a database-complete milestone without a completion event is info, not a stuck warning", async (t) => {
  const base = makeBase(t, "complete");
  const issues: DoctorIssue[] = [];
  await checkGsdStateHealth(base, issues, [], { fix: false, shouldFix: () => false });

  const issue = issues.find((candidate) => candidate.code === "all_slices_done_missing_milestone_summary");
  assert.ok(issue, "the missing SUMMARY is still reported");
  assert.equal(issue.severity, "info");
  assert.match(issue.message, /no completion closeout is recorded/);
  assert.match(issue.message, /gsd_summary_save/);
  assert.doesNotMatch(issue.message, /stuck in completing-milestone phase/);
});

test("an all-done milestone that is not complete keeps the stuck-in-completing warning", async (t) => {
  const base = makeBase(t, "active");
  const issues: DoctorIssue[] = [];
  await checkGsdStateHealth(base, issues, [], { fix: false, shouldFix: () => false });

  const issue = issues.find((candidate) => candidate.code === "all_slices_done_missing_milestone_summary");
  assert.ok(issue, "the missing SUMMARY is still reported");
  assert.equal(issue.severity, "warning");
  assert.match(issue.message, /stuck in completing-milestone phase/);
});
