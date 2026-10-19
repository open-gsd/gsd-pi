// Project/App: gsd-pi
// File Purpose: Behavior tests for the workflow_remediation_links dispatch rule
// (ADR-046): a linked Remediation Task is selected by the advance/dispatch
// rules while its target Task has work.

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DISPATCH_RULES } from "../auto-dispatch.ts";
import { selectOpenRemediationTasks } from "../db/workflow-remediation-links.ts";
import {
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
  _getAdapter,
} from "../gsd-db.ts";
import type { GSDState } from "../types.ts";

const RULE_NAME = "executing → remediation-task (linked Remediation Task)";
const TS = "2026-10-05T00:00:00.000Z";
const HASH = "sha256:" + "0".repeat(64);

function makeProject(t: TestContext): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-remediation-dispatch-")));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "in-progress" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Broken task", status: "complete" });
  insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Fix the broken deliverable", status: "pending" });
  t.after(() => {
    try { closeDatabase(); } catch { /* already closed */ }
    rmSync(base, { recursive: true, force: true });
  });
  return base;
}

/**
 * The canonical rows one remediation link stands on: the authority, the
 * operations, the task lifecycles, the failed attempt and its result, the
 * criterion, the failing verdict with its evidence, and the link itself.
 */
function seedRemediationLink(base: string, opts: { routeKind?: string; targetLifecycleStatus?: string } = {}): void {
  const db = _getAdapter()!;
  const routeKind = opts.routeKind ?? "remediation";
  const targetStatus = opts.targetLifecycleStatus ?? "ready";
  // openDatabase bootstraps the authority row with a derived project id.
  db.prepare(
    `INSERT INTO project_authority (singleton, project_id, project_root_realpath, revision, authority_epoch, created_at, updated_at)
     VALUES (1, 'p1', :root, 3, 0, :ts, :ts)
     ON CONFLICT (singleton) DO UPDATE SET project_root_realpath = :root, updated_at = :ts`,
  ).run({ ":root": base, ":ts": TS });
  const authority = db.prepare(`SELECT project_id FROM project_authority WHERE singleton = 1`).get() as { project_id: string };
  const projectId = String(authority.project_id);
  for (const [op, expected, resulting, opType] of [
    ["op1", 0, 1, "test"],
    ["op2", 1, 2, "attempt.settle"],
    ["op3", 2, 3, "test"],
  ] as const) {
    db.prepare(
      `INSERT INTO workflow_operations (
         operation_id, project_id, operation_type, idempotency_key,
         expected_revision, resulting_revision, expected_authority_epoch, resulting_authority_epoch,
         actor_type, source_transport, request_hash, created_at
       ) VALUES (:op, :project_id, :op_type, :ik, :expected, :resulting, 0, 0, 'agent', 'test', 'hash', :ts)`,
    ).run({ ":op": op, ":project_id": projectId, ":op_type": opType, ":ik": `ik-${op}`, ":expected": expected, ":resulting": resulting, ":ts": TS });
  }
  db.prepare(
    `INSERT INTO workflow_item_lifecycles (
       lifecycle_id, project_id, item_kind, milestone_id, slice_id, task_id,
       lifecycle_status, state_version, created_at, updated_at,
       last_operation_id, last_project_revision, last_authority_epoch
     ) VALUES
       ('lc-src', :project_id, 'task', 'M001', 'S01', 'T01', 'completed', 1, :ts, :ts, 'op1', 1, 0),
       ('lc-tgt', :project_id, 'task', 'M001', 'S01', 'T02', :target_status, 1, :ts, :ts, 'op1', 1, 0)`,
  ).run({ ":ts": TS, ":project_id": projectId, ":target_status": targetStatus });
  db.prepare(
    `INSERT INTO workflow_execution_attempts (
       attempt_id, project_id, lifecycle_id, attempt_number, attempt_state,
       claimed_at, started_at, ended_at,
       claim_operation_id, claim_project_revision, claim_authority_epoch,
       settle_operation_id, settle_project_revision, settle_authority_epoch,
       settle_outcome
     ) VALUES ('a1', :project_id, 'lc-src', 1, 'settled', :ts, :ts, :ts, 'op1', 1, 0, 'op2', 2, 0, 'failed')`,
  ).run({ ":ts": TS, ":project_id": projectId });
  db.prepare(
    `INSERT INTO workflow_attempt_results (
       result_id, project_id, lifecycle_id, attempt_id, outcome, failure_class,
       summary, created_at, operation_id, project_revision, authority_epoch
     ) VALUES ('r1', :project_id, 'lc-src', 'a1', 'failed', 'verification-failed',
               'host verification failed', :ts, 'op2', 2, 0)`,
  ).run({ ":ts": TS, ":project_id": projectId });
  db.prepare(
    `INSERT INTO workflow_acceptance_criteria (
       criterion_id, criterion_key, project_id, lifecycle_id, criterion_kind,
       evidence_class, required, description, created_at,
       operation_id, project_revision, authority_epoch
     ) VALUES ('c1', 'tests-pass', :project_id, 'lc-src', 'technical', 'command', 1,
               'Host verification passes', :ts, 'op1', 1, 0)`,
  ).run({ ":ts": TS, ":project_id": projectId });
  db.prepare(
    `INSERT INTO workflow_technical_verdicts (
       verdict_id, project_id, criterion_id, lifecycle_id, attempt_id,
       tested_source_revision, verdict, policy_id, policy_version, rationale,
       created_at, operation_id, project_revision, authority_epoch
     ) VALUES ('v1', :project_id, 'c1', 'lc-src', 'a1', 'src-rev-1', 'fail',
               'default', '1', 'host verification failed', :ts, 'op3', 3, 0)`,
  ).run({ ":ts": TS, ":project_id": projectId });
  db.prepare(
    `INSERT INTO workflow_verification_evidence (
       evidence_id, project_id, verdict_id, criterion_id, lifecycle_id, attempt_id,
       evidence_class, command_or_tool, working_directory, started_at, ended_at,
       exit_code, observation, source_revision, observed_project_revision,
       content_hash, durable_output_ref, environment_json,
       created_at, operation_id, project_revision, authority_epoch
     ) VALUES ('e1', :project_id, 'v1', 'c1', 'lc-src', 'a1', 'command', 'npm test', :root,
               :ts, :ts, 1, 'failed', 'src-rev-1', 2, :hash, 'db://evidence/e1',
               '{"runner":"node-test"}', :ts, 'op3', 3, 0)`,
  ).run({ ":root": base, ":ts": TS, ":hash": HASH, ":project_id": projectId });
  db.prepare(
    `INSERT INTO workflow_remediation_links (
       remediation_link_id, project_id, source_lifecycle_id, technical_verdict_id,
       route_kind, remediation_fingerprint, required_outcome, target_lifecycle_id,
       created_at, operation_id, project_revision, authority_epoch
     ) VALUES ('rl1', :project_id, 'lc-src', 'v1', :route_kind, 'fingerprint-1',
               'the deliverable satisfies the failed criterion', :target, :ts, 'op3', 3, 0)`,
  ).run({ ":route_kind": routeKind, ":target": routeKind === "rework" ? "lc-src" : "lc-tgt", ":ts": TS, ":project_id": projectId });
}

function executingState(): GSDState {
  return {
    phase: "executing",
    activeMilestone: { id: "M001", title: "Milestone" },
    activeSlice: { id: "S01", title: "Slice" },
    activeTask: null,
    registry: [],
    blockers: [],
  } as unknown as GSDState;
}

function remediationRule() {
  const rule = DISPATCH_RULES.find((candidate) => candidate.name === RULE_NAME);
  if (!rule) throw new Error(`dispatch rule not found: ${RULE_NAME}`);
  return rule;
}

test("the dispatch rule selects the linked Remediation Task of the milestone", async (t) => {
  const base = makeProject(t);
  seedRemediationLink(base);

  const action = await remediationRule().match({
    basePath: base,
    mid: "M001",
    midTitle: "Milestone",
    state: executingState(),
    prefs: undefined,
  });

  assert.ok(action && action.action === "dispatch", "the rule dispatches");
  if (action.action === "dispatch") {
    assert.equal(action.unitType, "execute-task");
    assert.equal(action.unitId, "M001/S01/T02");
    assert.match(action.prompt, /Fix the broken deliverable/);
  }
  const links = selectOpenRemediationTasks("M001");
  assert.equal(links.length, 1);
  assert.equal(links[0]?.taskId, "T02");
  assert.equal(links[0]?.requiredOutcome, "the deliverable satisfies the failed criterion");
});

test("a rework link does not select a Remediation Task", async (t) => {
  const base = makeProject(t);
  seedRemediationLink(base, { routeKind: "rework" });

  const action = await remediationRule().match({
    basePath: base,
    mid: "M001",
    midTitle: "Milestone",
    state: executingState(),
    prefs: undefined,
  });

  assert.equal(action, null);
  assert.deepEqual(selectOpenRemediationTasks("M001"), []);
});

test("a Remediation Task that completed after the link is not selected again", async (t) => {
  // The schema refuses a link whose target has no actionable work.
  const refusedProject = makeProject(t);
  assert.throws(
    () => seedRemediationLink(refusedProject, { targetLifecycleStatus: "completed" }),
    /remediation must target actionable task work/,
  );

  // A target that completes after the link exists stops being selected.
  const base = makeProject(t);
  seedRemediationLink(base);
  _getAdapter()!.prepare(`UPDATE tasks SET status = 'complete' WHERE id = 'T02'`).run();

  const action = await remediationRule().match({
    basePath: base,
    mid: "M001",
    midTitle: "Milestone",
    state: executingState(),
    prefs: undefined,
  });

  assert.equal(action, null);
  assert.deepEqual(selectOpenRemediationTasks("M001"), []);
});

test("a milestone without links dispatches nothing through the rule", async (t) => {
  const base = makeProject(t);

  const action = await remediationRule().match({
    basePath: base,
    mid: "M001",
    midTitle: "Milestone",
    state: executingState(),
    prefs: undefined,
  });

  assert.equal(action, null);
});

test("the oldest open link is selected first", (t) => {
  const base = makeProject(t);
  seedRemediationLink(base);
  const db = _getAdapter()!;
  insertTask({ id: "T03", sliceId: "S01", milestoneId: "M001", title: "Second repair", status: "pending" });
  const projectId = String((db.prepare(`SELECT project_id FROM project_authority WHERE singleton = 1`).get() as { project_id: string }).project_id);
  db.prepare(
    `INSERT INTO workflow_item_lifecycles (
       lifecycle_id, project_id, item_kind, milestone_id, slice_id, task_id,
       lifecycle_status, state_version, created_at, updated_at,
       last_operation_id, last_project_revision, last_authority_epoch
     ) VALUES ('lc-tgt-2', :project_id, 'task', 'M001', 'S01', 'T03', 'ready', 1, :ts, :ts, 'op1', 1, 0)`,
  ).run({ ":ts": TS, ":project_id": projectId });
  db.prepare(
    `INSERT INTO workflow_remediation_links (
       remediation_link_id, project_id, source_lifecycle_id, technical_verdict_id,
       route_kind, remediation_fingerprint, required_outcome, target_lifecycle_id,
       created_at, operation_id, project_revision, authority_epoch
     ) VALUES ('rl0', :project_id, 'lc-src', 'v1', 'remediation', 'fingerprint-0',
               'earlier repair', 'lc-tgt-2', '2026-10-04T00:00:00.000Z', 'op3', 3, 0)`,
  ).run({ ":project_id": projectId });

  const links = selectOpenRemediationTasks("M001");

  assert.deepEqual(links.map((link) => link.taskId), ["T03", "T02"], "the oldest link comes first");
});
