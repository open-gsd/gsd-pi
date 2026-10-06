// Project/App: gsd-pi
// File Purpose: Behavior tests for the pause routing (ADR-046): a machine_fixable
// pause records the Recovery Classifier's route on its pause row, and a human
// pause opens a workflow_blockers row for the paused item whose resolution the
// pause resolution closes.

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pauseAuto } from "../auto.ts";
import { autoSession } from "../auto-runtime-state.ts";
import { classifyFailure } from "../recovery-classification.ts";
import {
  _getAdapter,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../gsd-db.ts";
import { clearPausedSession, readPausedSessionMetadata } from "../interrupted-session.ts";
import { readOpenAutoPauseBlockerId } from "../db/writers/auto-pauses.ts";

const TS = "2026-10-05T00:00:00.000Z";

function makeProject(t: TestContext, options: { milestoneLifecycle?: boolean } = {}): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-pause-blocker-")));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "in-progress" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Task", status: "pending" });
  if (options.milestoneLifecycle) seedMilestoneLifecycle(base);
  autoSession.reset();
  t.after(() => {
    autoSession.reset();
    try { closeDatabase(); } catch { /* already closed */ }
    rmSync(base, { recursive: true, force: true });
  });
  return base;
}

/** The lifecycle row a paused milestone item needs for its workflow_blockers row. */
function seedMilestoneLifecycle(base: string): void {
  const db = _getAdapter()!;
  db.prepare(
    `UPDATE project_authority SET revision = 1, updated_at = :ts WHERE singleton = 1`,
  ).run({ ":ts": TS });
  db.prepare(
    `INSERT INTO workflow_operations (
       operation_id, project_id, operation_type, idempotency_key,
       expected_revision, resulting_revision, expected_authority_epoch, resulting_authority_epoch,
       actor_type, source_transport, request_hash, created_at
     ) VALUES ('op1', (SELECT project_id FROM project_authority WHERE singleton = 1),
               'lifecycle.adopt', 'ik-op1', 0, 1, 0, 0, 'agent', 'internal', 'hash', :ts)`,
  ).run({ ":ts": TS });
  db.prepare(
    `INSERT INTO workflow_item_lifecycles (
       lifecycle_id, project_id, item_kind, milestone_id, slice_id, task_id,
       lifecycle_status, state_version, created_at, updated_at,
       last_operation_id, last_project_revision, last_authority_epoch
     ) VALUES ('lc-m001', (SELECT project_id FROM project_authority WHERE singleton = 1),
               'milestone', 'M001', NULL, NULL, 'in_progress', 1, :ts, :ts, 'op1', 1, 0)`,
  ).run({ ":ts": TS });
  void base;
}

function activateSession(base: string): void {
  autoSession.active = true;
  autoSession.basePath = base;
  autoSession.originalBasePath = base;
  autoSession.currentMilestoneId = "M001";
  autoSession.currentUnit = { type: "plan-slice", id: "M001/S01", startedAt: Date.now() };
  process.chdir(base);
}

function openPauseRows(): Array<Record<string, unknown>> {
  return _getAdapter()!.prepare(`SELECT * FROM auto_pauses WHERE closed_at IS NULL`).all() as Array<Record<string, unknown>>;
}

function blockerRows(): Array<Record<string, unknown>> {
  return _getAdapter()!.prepare(`SELECT * FROM workflow_blockers ORDER BY opened_at`).all() as Array<Record<string, unknown>>;
}

test("a machine_fixable pause records the Recovery Classifier's route on its pause row", async (t) => {
  const base = makeProject(t);
  activateSession(base);

  const message = "Verification drift detected between assessment and artifact";
  await pauseAuto(undefined, undefined, "machine_fixable", { message, category: "unknown" });

  const rows = openPauseRows();
  assert.equal(rows.length, 1);
  // pauseAuto classifies with the active unit's identity, so the reason carries
  // the unit suffix.
  const expected = classifyFailure({ error: message, unitType: "plan-slice", unitId: "M001/S01" });
  assert.equal(expected.failureKind, "verification-drift");
  assert.equal(expected.action, "escalate");
  const reason = String(rows[0]["pause_reason"]);
  assert.ok(
    reason.startsWith(`recovery:verification-drift/escalate | ${expected.reason}`),
    `the pause row records the classified route, got: ${reason}`,
  );
  assert.ok(reason.includes(expected.remediation), "the classifier's remediation is on the pause row");
  assert.equal(blockerRows().length, 0, "a machine_fixable pause opens no human blocker row");
});

test("a human pause opens a workflow_blockers row for the paused item and links it to the pause row", async (t) => {
  const base = makeProject(t, { milestoneLifecycle: true });
  activateSession(base);

  await pauseAuto(undefined, undefined, "ambiguous_intent", {
    message: "Two valid routes for the slice scope",
    category: "unknown",
  });

  const rows = blockerRows();
  assert.equal(rows.length, 1, "the human pause opens one blocker row");
  assert.equal(rows[0]["blocker_kind"], "ambiguous_intent");
  assert.equal(rows[0]["blocker_status"], "open");
  assert.equal(rows[0]["resolution_owner"], "user");
  assert.equal(rows[0]["lifecycle_id"], "lc-m001");
  assert.match(String(rows[0]["description"]), /Two valid routes/);
  assert.match(String(rows[0]["requested_action"]), /\/gsd auto/);

  const pauseRow = openPauseRows()[0];
  assert.equal(pauseRow["blocker_id"], rows[0]["blocker_id"], "the pause row links its blocker");
  assert.equal(
    pauseRow["pause_reason"],
    "Two valid routes for the slice scope",
    "a human pause records its own reason, not a classifier route",
  );
  assert.equal(readOpenAutoPauseBlockerId(), rows[0]["blocker_id"]);
});

test("a human pause of an item without a lifecycle row records the pause row alone", async (t) => {
  const base = makeProject(t);
  activateSession(base);

  await pauseAuto(undefined, undefined, "subjective_uat");

  assert.equal(openPauseRows().length, 1);
  assert.equal(blockerRows().length, 0, "no lifecycle row means no blocker row");
});

test("a user_request pause opens no blocker row", async (t) => {
  const base = makeProject(t, { milestoneLifecycle: true });
  activateSession(base);

  await pauseAuto(undefined, undefined, "user_request");

  assert.equal(openPauseRows().length, 1);
  assert.equal(blockerRows().length, 0);
});

test("the resolution of the pause resolves its blocker row", async (t) => {
  const base = makeProject(t, { milestoneLifecycle: true });
  activateSession(base);
  await pauseAuto(undefined, undefined, "consent", { message: "Needs approval to publish", category: "unknown" });
  const blockerId = String(blockerRows()[0]["blocker_id"]);

  clearPausedSession();

  const rows = blockerRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]["blocker_status"], "resolved");
  assert.equal(rows[0]["blocker_id"], blockerId);
  assert.ok(rows[0]["resolved_at"], "the resolution timestamp is set");
  assert.equal(readPausedSessionMetadata(base), null, "the pause itself is closed");
});

test("a newer pause resolves the blocker of the pause it replaces", async (t) => {
  const base = makeProject(t, { milestoneLifecycle: true });
  activateSession(base);
  await pauseAuto(undefined, undefined, "user_limit", { message: "Cost limit", category: "unknown" });
  const firstBlockerId = String(blockerRows()[0]["blocker_id"]);

  autoSession.active = true;
  await pauseAuto(undefined, undefined, "missing_access", { message: "Credential missing", category: "unknown" });

  const rows = blockerRows();
  assert.equal(rows.length, 2);
  const first = rows.find((row) => row["blocker_id"] === firstBlockerId);
  assert.equal(first?.["blocker_status"], "resolved", "the replaced pause's blocker is resolved");
  assert.match(String(first?.["resolution"]), /newer pause/);
  assert.equal(rows.find((row) => row["blocker_id"] !== firstBlockerId)?.["blocker_status"], "open");
  const pauseRow = openPauseRows()[0];
  assert.equal(pauseRow["blocker_id"], rows.find((row) => row["blocker_id"] !== firstBlockerId)?.["blocker_id"]);
});
