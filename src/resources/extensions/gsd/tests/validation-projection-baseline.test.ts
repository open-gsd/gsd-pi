// Project/App: gsd-pi
// File Purpose: Every GSD writer of the milestone VALIDATION file records the projection baseline.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { removeProjectionFileSync } from "../atomic-write.ts";
import { DISPATCH_RULES } from "../auto-dispatch.ts";
import { checkCloseoutConsistencyGate } from "../closeout-consistency-gate.ts";
import {
  closeDatabase,
  deleteAssessmentByScope,
  insertAssessment,
  insertMilestone,
  insertSlice,
  openDatabase,
} from "../gsd-db.ts";
import { renderMilestoneValidation } from "../markdown-renderer.ts";
import { preserveProjectionChangesBeforeDispatch } from "../projection-worker.ts";
import { observeExternalMarkdownEdits } from "../state-reconciliation/drift/external-markdown-edit.ts";

let base = "";

afterEach(() => {
  closeDatabase();
  rmSync(base, { recursive: true, force: true });
});

/**
 * A milestone whose validation was rendered and then invalidated the way
 * gsd_reassess_roadmap does it: the row and the file are removed, the baseline
 * of the removed file stays in the marker.
 */
function makeInvalidatedValidation(): string {
  base = mkdtempSync(join(tmpdir(), "gsd-validation-baseline-"));
  const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
  mkdirSync(sliceDir, { recursive: true });
  writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "# S01 Summary\n");
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Validation", status: "active", depends_on: [] });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Done", status: "complete", risk: "low", depends: [], demo: "", sequence: 1 });

  const validationPath = join(base, ".gsd", "milestones", "M001", "M001-VALIDATION.md");
  insertAssessment({
    path: validationPath,
    milestoneId: "M001",
    status: "needs-remediation",
    scope: "milestone-validation",
    fullContent: "---\nverdict: needs-remediation\n---\n\n# M001 Validation\n",
  });
  assert.equal(renderMilestoneValidation(base, "M001"), true);
  deleteAssessmentByScope("M001", "milestone-validation");
  removeProjectionFileSync(validationPath);
  return validationPath;
}

async function assertNotAnExternalEdit(validationPath: string): Promise<void> {
  assert.deepEqual(
    observeExternalMarkdownEdits(base, true).filter((record) => record.projectionPath.endsWith("VALIDATION.md")),
    [],
    "the file that GSD wrote is not an external edit",
  );
  const written = readFileSync(validationPath, "utf-8");
  assert.deepEqual((await preserveProjectionChangesBeforeDispatch(base)).held, []);
  assert.equal(existsSync(validationPath), true, "the file is not moved to quarantine");
  assert.equal(readFileSync(validationPath, "utf-8"), written);
}

test("the skipped validation written after an invalidated validation is not an external edit", async () => {
  const validationPath = makeInvalidatedValidation();
  const rule = DISPATCH_RULES.find((candidate) => candidate.name === "validating-milestone → validate-milestone");
  assert.ok(rule, "validate-milestone rule is registered");

  const action = await rule.match({
    state: { phase: "validating-milestone" },
    mid: "M001",
    midTitle: "Validation",
    basePath: base,
    prefs: { phases: { skip_milestone_validation: true } },
  } as any);

  assert.deepEqual(action, { action: "skip" });
  assert.match(readFileSync(validationPath, "utf-8"), /skip_validation_reason: preference/);
  await assertNotAnExternalEdit(validationPath);
});

test("the closeout pass-through validation written after an invalidated validation is not an external edit", async () => {
  const validationPath = makeInvalidatedValidation();

  checkCloseoutConsistencyGate("M001", {
    allowOpenMilestone: true,
    allowPassThroughValidation: true,
    artifactBasePath: base,
  });

  assert.match(readFileSync(validationPath, "utf-8"), /skip_validation_reason: closeout-recovery/);
  await assertNotAnExternalEdit(validationPath);
});
