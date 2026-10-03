// Project/App: gsd-pi
// File Purpose: Doctor contract for a leftover T##-REOPEN.json from a build
// that kept the reopen reason in a file: reported as info, removed by --fix.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../gsd-db.ts";
import { checkGsdStateHealth } from "../doctor-state-checks.ts";
import type { DoctorIssue } from "../doctor-types.ts";

function makeBase(t: { after: (fn: () => void) => void }): { base: string; reopenFile: string } {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-reopen-file-"));
  t.after(() => {
    try { closeDatabase(); } catch { /* noop */ }
    rmSync(base, { recursive: true, force: true });
  });
  const milestoneDir = join(base, ".gsd", "milestones", "M001");
  const tasksDir = join(milestoneDir, "slices", "S01", "tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(
    join(milestoneDir, "M001-ROADMAP.md"),
    ["# M001: Reopen File", "", "- [ ] **S01: First slice** `risk:medium` `depends:[]`", ""].join("\n"),
  );
  const reopenFile = join(tasksDir, "T01-REOPEN.json");
  writeFileSync(reopenFile, JSON.stringify({
    version: 1, milestoneId: "M001", sliceId: "S01", taskId: "T01",
    reason: "old diagnosis", createdAt: "2026-07-13T00:00:00.000Z",
  }));

  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Reopen File", status: "active" });
  insertSlice({
    id: "S01", milestoneId: "M001", title: "First slice", status: "pending",
    risk: "medium", depends: [], demo: "S01 demo.", sequence: 1,
  });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "First task", status: "pending" });
  return { base, reopenFile };
}

test("doctor reports a leftover T##-REOPEN.json as info naming the Task and leaves it in place", async (t) => {
  const { base, reopenFile } = makeBase(t);
  const issues: DoctorIssue[] = [];
  const fixesApplied: string[] = [];
  await checkGsdStateHealth(base, issues, fixesApplied, { fix: false, shouldFix: () => false });

  const reported = issues.filter((i) => i.code === "orphan_reopen_reason_file");
  assert.equal(reported.length, 1);
  assert.equal(reported[0].severity, "info");
  assert.equal(reported[0].unitId, "M001/S01/T01");
  assert.match(reported[0].message, /M001\/S01\/T01/);
  assert.equal(reported[0].fixable, true);
  assert.equal(existsSync(reopenFile), true);
  assert.deepEqual(fixesApplied, []);
});

test("doctor --fix removes a leftover T##-REOPEN.json", async (t) => {
  const { base, reopenFile } = makeBase(t);
  const issues: DoctorIssue[] = [];
  const fixesApplied: string[] = [];
  await checkGsdStateHealth(base, issues, fixesApplied, { fix: true, shouldFix: () => true });

  assert.equal(issues.filter((i) => i.code === "orphan_reopen_reason_file").length, 1);
  assert.equal(existsSync(reopenFile), false);
  assert.equal(fixesApplied.filter((fixed) => fixed.includes("T01-REOPEN.json")).length, 1);
});
