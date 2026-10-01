// Project/App: gsd-pi
// File Purpose: Doctor guidance for the validation source-revision drift issue.

import assert from "node:assert/strict";
import test from "node:test";

import { createValidationSourceDriftDoctorIssue } from "../doctor-engine-checks.ts";
import { doctorFixHint } from "../guidance.ts";
import { formatDoctorReport } from "../doctor-format.ts";
import type { DoctorReport } from "../doctor-types.ts";

// The checker (reportMilestoneValidationSourceDrift) only inspects closed
// milestones, while /gsd validate-milestone requires a ready or in_progress
// lifecycle — the old "run /gsd validate-milestone, then /gsd auto" advice and
// fixable:true were unexecutable by construction (#2439).
test("doctor reports closed-milestone validation source drift as non-fixable without unexecutable advice", () => {
  const issue = createValidationSourceDriftDoctorIssue(
    "M001",
    { expectedSourceRevision: "sha256:current", testedSourceRevision: "sha256:validated" },
    { paths: ["ad-hoc-helper.ps1"], autoCommitDetected: true },
  );
  const report: DoctorReport = {
    ok: false,
    basePath: "/repo",
    fixesApplied: [],
    issues: [issue],
  };

  assert.equal(issue.fixable, false);
  assert.match(issue.message, /expected sha256:current; tested sha256:validated/);
  assert.doesNotMatch(issue.message, /run `\/gsd validate-milestone M001`/);
  assert.match(issue.message, /closed/);
  assert.match(issue.message, /unreachable/);
  assert.match(issue.message, /ready or in_progress lifecycle/);
  assert.match(issue.message, /no re-pin path/);
  const formatted = formatDoctorReport(report);
  assert.match(formatted, /0 fixable/);
  assert.match(formatted, /ad-hoc-helper\.ps1/);
  assert.match(formatted, /git reset --mixed HEAD\^/);
  assert.doesNotMatch(formatted, /run `\/gsd validate-milestone/);
});

test("clean-tree drift keeps the inspection fallback and the same non-fixable closed-milestone wording", () => {
  const issue = createValidationSourceDriftDoctorIssue(
    "M013",
    { expectedSourceRevision: "sha256:current", testedSourceRevision: "sha256:validated" },
    { paths: [], autoCommitDetected: false },
  );

  assert.equal(issue.fixable, false);
  assert.match(issue.message, /Inspect `git status` and the latest commit/);
  assert.match(issue.message, /Restore or remove unintended working-tree changes/);
  assert.doesNotMatch(issue.message, /run `\/gsd validate-milestone M013`/);
});

test("the guidance hint for validation source drift prescribes no validate-milestone rerun", () => {
  const hint = doctorFixHint("validation_source_revision_mismatch");
  assert.ok(hint, "hint must exist");
  assert.doesNotMatch(hint!, /re-run `\/gsd validate-milestone/);
  assert.match(hint!, /unreachable/);
});
