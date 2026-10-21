import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { appendCapture, markCaptureExecuted, markCaptureResolved } from "../captures.ts";
import { resolveExpectedArtifactPath, verifyExpectedArtifact } from "../auto-recovery.ts";
import { drainLogs } from "../workflow-logger.ts";

function makeProject(t: { after: (fn: () => void) => void }): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-sidecar-artifact-"));
  t.after(() => {
    drainLogs();
    rmSync(base, { recursive: true, force: true });
  });
  return base;
}

test("triage-captures verification passes when CAPTURES.md is absent", (t) => {
  const base = makeProject(t);
  drainLogs();

  assert.equal(
    verifyExpectedArtifact("triage-captures", "M001/S01/triage", base),
    true,
  );
  assert.deepEqual(drainLogs(), []);
});

test("triage-captures verification passes when no pending captures remain", (t) => {
  const base = makeProject(t);
  const captureId = appendCapture(base, "Already handled.");
  markCaptureResolved(base, captureId, "note", "acknowledged", "No action needed");
  markCaptureExecuted(base, captureId);
  drainLogs();

  assert.equal(
    verifyExpectedArtifact("triage-captures", "M001/S01/triage", base),
    true,
  );
  assert.deepEqual(drainLogs(), []);
});

test("triage-captures verification fails while pending captures remain", (t) => {
  const base = makeProject(t);
  appendCapture(base, "Still needs triage.");
  drainLogs();

  assert.equal(
    verifyExpectedArtifact("triage-captures", "M001/S01/triage", base),
    false,
  );
  const logs = drainLogs();
  assert.equal(logs.length, 1);
  assert.match(logs[0].message, /1 pending capture\(s\) remain in CAPTURES\.md/);
});

test("quick-task verification passes when the capture is marked executed", (t) => {
  const base = makeProject(t);
  const captureId = appendCapture(base, "Fix a tiny typo.");
  markCaptureResolved(base, captureId, "quick-task", "fixed inline", "Small isolated change");
  markCaptureExecuted(base, captureId);
  drainLogs();

  assert.equal(
    verifyExpectedArtifact("quick-task", `M001/${captureId}`, base),
    true,
  );
  assert.deepEqual(drainLogs(), []);
});

test("quick-task verification fails when the capture is not marked executed", (t) => {
  const base = makeProject(t);
  const captureId = appendCapture(base, "Fix a tiny typo.");
  markCaptureResolved(base, captureId, "quick-task", "fixed inline", "Small isolated change");
  drainLogs();

  assert.equal(
    verifyExpectedArtifact("quick-task", `M001/${captureId}`, base),
    false,
  );
  const logs = drainLogs();
  assert.equal(logs.length, 1);
  assert.match(logs[0].message, new RegExp(`capture ${captureId} not found or not marked executed`));
});

test("sidecar unit path resolver documents CAPTURES.md state verification", (t) => {
  const base = makeProject(t);

  assert.equal(
    resolveExpectedArtifactPath("triage-captures", "M001/S01/triage", base),
    null,
  );
  assert.equal(
    resolveExpectedArtifactPath("quick-task", "M001/CAP-12345678", base),
    null,
  );
});

test("unknown artifact contract warning distinguishes missing contracts from missing dirs", (t) => {
  const base = makeProject(t);
  drainLogs();

  assert.equal(
    verifyExpectedArtifact("unknown-unit", "M001/S01", base),
    false,
  );
  const logs = drainLogs();
  assert.equal(logs.length, 1);
  assert.match(logs[0].message, /no artifact contract registered for this unit type/);
});
