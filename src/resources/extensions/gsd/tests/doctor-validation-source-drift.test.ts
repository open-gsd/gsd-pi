// Project/App: gsd-pi
// File Purpose: Doctor guidance for the pre-merge auto-commit source-revision wedge.

import assert from "node:assert/strict";
import test from "node:test";

import { createValidationSourceDriftDoctorIssue } from "../doctor-engine-checks.ts";
import { formatDoctorReport } from "../doctor-format.ts";
import type { DoctorReport } from "../doctor-types.ts";

test("doctor classifies validation source drift as fixable with cleanup and revalidation guidance", () => {
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

  assert.equal(issue.fixable, true);
  assert.match(issue.message, /expected sha256:current; tested sha256:validated/);
  const formatted = formatDoctorReport(report);
  assert.match(formatted, /1 fixable/);
  assert.match(formatted, /ad-hoc-helper\.ps1/);
  assert.match(formatted, /git reset --mixed HEAD\^/);
  assert.match(formatted, /validate-milestone <id>/);
});
