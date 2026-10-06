// gsd-pi + The closeout refusal is a row on the unit's newest dispatch (P18d)
//
// A unit that deliberately declines closeout (#2046) writes its
// `*VERIFICATION-FAILED` report. The report on disk is the agent's channel and
// a render for the operator; the refusal a decision reads is the dispatch row.
// These tests prove the row replaces the file: deleting the report after the
// refusal is recorded changes nothing, and a verification gate that clears the
// retry state of the unit releases the refusal.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  closeDatabase,
  insertMilestone,
  insertSlice,
  openDatabase,
} from "../gsd-db.ts";
import { registerAutoWorker } from "../db/auto-workers.ts";
import { claimMilestoneLease } from "../db/milestone-leases.ts";
import { markCompleted, recordDispatchClaim } from "../db/unit-dispatches.ts";
import {
  readStoredCloseoutRefusal,
  releaseUnitRetry,
  releaseVerificationRetry,
  storeCloseoutRefusal,
  storeUnitRetry,
} from "../db/unit-dispatch-retries.ts";

interface Project {
  claim: (unitType: string, unitId: string) => number;
  base: string;
}

function openProject(t: { after: (fn: () => void) => void }): Project {
  const base = mkdtempSync(join(tmpdir(), "gsd-closeout-refusal-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  t.after(() => {
    try { closeDatabase(); } catch { /* noop */ }
    rmSync(base, { recursive: true, force: true });
  });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice" });
  const workerId = registerAutoWorker({ projectRootRealpath: base });
  const lease = claimMilestoneLease(workerId, "M001");
  if (!lease.ok) throw new Error("expected test lease");
  return {
    base,
    claim: (unitType, unitId) => {
      const claim = recordDispatchClaim({
        traceId: "trace",
        workerId,
        milestoneLeaseToken: lease.token,
        milestoneId: "M001",
        sliceId: "S01",
        unitType,
        unitId,
      });
      if (!claim.ok) throw new Error(`expected dispatch claim: ${claim.error}`);
      return claim.dispatchId;
    },
  };
}

test("the refusal a decision reads is the dispatch row: the report file is a render", (t) => {
  const project = openProject(t);
  project.claim("execute-task", "M001/S01/T01");

  const markerRelPath = join(".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01", "T01-VERIFICATION-FAILED.md");
  const markerAbsPath = join(project.base, markerRelPath);
  mkdirSync(join(project.base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01"), { recursive: true });
  writeFileSync(markerAbsPath, "# Verification failed\n", "utf-8");

  storeCloseoutRefusal("execute-task", "M001/S01/T01", markerRelPath);
  assert.equal(readStoredCloseoutRefusal("execute-task", "M001/S01/T01"), markerRelPath);

  // Deleting the report changes nothing: the row is the refusal.
  rmSync(markerAbsPath);
  assert.equal(readStoredCloseoutRefusal("execute-task", "M001/S01/T01"), markerRelPath);

  // A unit with no refusal row keeps the retry default.
  assert.equal(readStoredCloseoutRefusal("execute-task", "M001/S01/T99"), null);
});

test("the refusal rides on the newest dispatch row of the unit", (t) => {
  const project = openProject(t);
  const first = project.claim("execute-task", "M001/S01/T01");
  markCompleted(first);
  project.claim("execute-task", "M001/S01/T01");

  storeCloseoutRefusal("execute-task", "M001/S01/T01", ".gsd/reports/T01-VERIFICATION-FAILED.md");
  assert.equal(readStoredCloseoutRefusal("execute-task", "M001/S01/T01"), ".gsd/reports/T01-VERIFICATION-FAILED.md");
});

test("a verification gate that clears the retry state releases the refusal", (t) => {
  const project = openProject(t);
  project.claim("execute-task", "M001/S01/T01");

  storeCloseoutRefusal("execute-task", "M001/S01/T01", ".gsd/reports/T01-VERIFICATION-FAILED.md");
  releaseVerificationRetry("execute-task", "M001/S01/T01");
  assert.equal(readStoredCloseoutRefusal("execute-task", "M001/S01/T01"), null, "a passing close-out clears the refusal");
});

test("a plain verification retry after the refusal replaces it on the dispatch", (t) => {
  const project = openProject(t);
  project.claim("execute-task", "M001/S01/T01");

  storeCloseoutRefusal("execute-task", "M001/S01/T01", ".gsd/reports/T01-VERIFICATION-FAILED.md");
  storeUnitRetry("execute-task", {
    unitId: "M001/S01/T01",
    failureContext: "Artifact verification failed: SUMMARY was not found on disk",
    attempt: 1,
  });
  assert.equal(readStoredCloseoutRefusal("execute-task", "M001/S01/T01"), null, "the newest close-out state wins");

  releaseUnitRetry("execute-task", "M001/S01/T01");
  assert.equal(readStoredCloseoutRefusal("execute-task", "M001/S01/T01"), null);
});
