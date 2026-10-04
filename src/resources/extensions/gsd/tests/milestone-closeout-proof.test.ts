// Project/App: gsd-pi
// File Purpose: Tests for the shared milestone closeout proof surface.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  closeDatabase,
  insertAssessment,
  insertMilestone,
  insertSlice,
  openDatabase,
} from "../gsd-db.js";
import { proveMilestoneCloseout } from "../milestone-closeout-proof.js";

const tmpDirs: string[] = [];

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-closeout-proof-"));
  tmpDirs.push(base);
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  try { closeDatabase(); } catch { /* noop */ }
  openDatabase(join(base, ".gsd", "gsd.db"));
  return base;
}

function insertValidationPass(): void {
  insertAssessment({
    path: "milestones/M001/M001-VALIDATION.md",
    milestoneId: "M001",
    status: "pass",
    scope: "milestone-validation",
    fullContent: "verdict: pass",
  });
}

function writeSummary(base: string, status: string): void {
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "M001-SUMMARY.md"),
    `---\nstatus: ${status}\n---\n\n# Summary\n`,
    "utf-8",
  );
}

test.after(() => {
  try { closeDatabase(); } catch { /* noop */ }
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("proveMilestoneCloseout accepts closed DB state", () => {
  const base = makeBase();
  insertMilestone({ id: "M001", title: "Done", status: "complete" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Done Slice", status: "complete" });
  insertValidationPass();

  const result = proveMilestoneCloseout("M001", {
    artifactBasePath: base,
  });

  assert.deepEqual(result, { ok: true });
});

test("proveMilestoneCloseout can prove readiness before DB milestone is closed", () => {
  const base = makeBase();
  insertMilestone({ id: "M001", title: "Ready", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Done Slice", status: "complete" });
  insertValidationPass();

  const result = proveMilestoneCloseout("M001", {
    allowOpenMilestone: true,
    artifactBasePath: base,
  });

  assert.deepEqual(result, { ok: true });
});

test("proveMilestoneCloseout takes the outcome from the database, not from the SUMMARY file", () => {
  const base = makeBase();
  insertMilestone({ id: "M001", title: "Done", status: "complete" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Done Slice", status: "complete" });
  insertValidationPass();
  writeSummary(base, "failed");

  const result = proveMilestoneCloseout("M001", {
    artifactBasePath: base,
  });

  assert.deepEqual(result, { ok: true });
});
