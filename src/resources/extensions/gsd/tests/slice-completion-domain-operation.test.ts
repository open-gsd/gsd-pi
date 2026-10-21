// Project/App: gsd-pi
// File Purpose: Executable contracts for evidence-backed atomic Slice completion.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  _getAdapter,
  closeDatabase,
  executeDomainOperation,
  openDatabase,
  readDomainOperationFence,
} from "../gsd-db.ts";
import type { DomainOperationContext } from "../db/domain-operation.ts";
import {
  adoptOrTransitionLifecycle,
  appendKernelCheckpoint,
} from "../db/writers/lifecycle-commands.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";
import * as sliceLifecycle from "../slice-lifecycle-domain-operation.ts";
import {
  claimTaskAttempt,
  settleTaskAttempt,
} from "../task-execution-domain-operation.ts";
import { recordTaskTechnicalVerdict } from "../task-verification-domain-operation.ts";
import {
  grantTaskWaiver,
  recordTaskRequirementDisposition,
  reopenTask,
} from "../task-recovery-domain-operation.ts";

const tempDirs = new Set<string>();

interface CompletionCloseout {
  sliceTitle: string;
  oneLiner: string;
  narrative: string;
  verification: string;
  uatContent: string;
  operationalReadiness: string;
  deviations: string;
  knownLimitations: string;
  followUps: string;
  provides: string[];
  requires: Array<{ slice: string; provides: string }>;
  affects: string[];
  keyFiles: string[];
  keyDecisions: string[];
  patternsEstablished: string[];
  observabilitySurfaces: string[];
  drillDownPaths: string[];
  requirementsAdvanced: Array<{ id: string; how: string }>;
  requirementsValidated: Array<{ id: string; proof: string }>;
  requirementsSurfaced: string[];
  requirementsInvalidated: Array<{ id: string; what: string }>;
  filesModified: Array<{ path: string; description: string }>;
}

interface CompletionInput {
  invocation: ExecutionInvocation;
  slice: { milestoneId: string; sliceId: string };
  closeout: CompletionCloseout;
}

type CompletionReceipt = Record<string, unknown> & { status: "committed" | "replayed" };

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function rows(sql: string): Array<Record<string, unknown>> {
  return db().prepare(sql).all();
}

function row(sql: string): Record<string, unknown> {
  return db().prepare(sql).get() ?? {};
}

function invocation(idempotencyKey: string): ExecutionInvocation {
  return {
    idempotencyKey,
    sourceTransport: "pi-tool",
    actorType: "agent",
    actorId: "slice-completion-test",
    traceId: `trace/${idempotencyKey}`,
    turnId: `turn/${idempotencyKey}`,
  };
}

function closeout(overrides: Partial<CompletionCloseout> = {}): CompletionCloseout {
  return {
    sliceTitle: "Evidence-backed completion",
    oneLiner: "Published one verified Slice completion.",
    narrative: "The Slice completed through durable database facts.",
    verification: "Focused executable checks passed.",
    uatContent: "## UAT Type\n\n- UAT mode: runtime-executable\n\n## Checks\n\n- Run the focused tests.",
    operationalReadiness: "- Health signal: focused verification remains green",
    deviations: "None.",
    knownLimitations: "None.",
    followUps: "None.",
    provides: ["Evidence-backed Slice completion"],
    requires: [{ slice: "S00", provides: "Lifecycle foundation" }],
    affects: ["S02"],
    keyFiles: ["src/resources/extensions/gsd/slice-lifecycle-domain-operation.ts"],
    keyDecisions: ["Database evidence is authoritative"],
    patternsEstablished: ["One operation owns one Slice cascade"],
    observabilitySurfaces: ["workflow_domain_events"],
    drillDownPaths: ["db://workflow_operations/slice.complete"],
    requirementsAdvanced: [{ id: "REQ-1", how: "Slice completion is atomic" }],
    requirementsValidated: [{ id: "REQ-2", proof: "Task Technical Verdict passed" }],
    requirementsSurfaced: [],
    requirementsInvalidated: [],
    filesModified: [{
      path: "src/resources/extensions/gsd/db/writers/slice-lifecycle.ts",
      description: "Own the completion cascade",
    }],
    ...overrides,
  };
}

function completeSlice(input: CompletionInput): CompletionReceipt {
  const complete = (sliceLifecycle as unknown as {
    completeSlice?: (request: CompletionInput) => CompletionReceipt;
  }).completeSlice;
  assert.equal(typeof complete, "function", "Slice lifecycle module must expose the completion Domain Operation");
  return complete!(input);
}

function executeAtFence(
  operationType: string,
  idempotencyKey: string,
  write: (context: Readonly<DomainOperationContext>) => void,
  event: {
    eventType: string;
    entityType: string;
    entityId: string;
    payload: Record<string, string>;
  } = {
    eventType: operationType,
    entityType: "slice",
    entityId: "M001/S01",
    payload: { idempotencyKey },
  },
): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType,
    idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { operationType, idempotencyKey },
  }, (context) => {
    write(context);
    return {
      events: [{
        ...event,
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: `test/${idempotencyKey}`.toLowerCase(),
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}

function insertClaimedDispatch(taskId: string): number {
  db().prepare(`
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES (
      :trace_id, :turn_id, 'worker-1', 7,
      'M001', 'S01', :task_id, 'execute-task', :unit_id,
      'claimed', 1, '2026-07-14T00:00:00.000Z'
    )
  `).run({
    ":trace_id": `trace/${taskId}`,
    ":turn_id": `turn/${taskId}`,
    ":task_id": taskId,
    ":unit_id": `M001/S01/${taskId}`,
  });
  return Number(row("SELECT MAX(id) AS id FROM unit_dispatches").id);
}

function makeBase(): void {
  const base = mkdtempSync(join(tmpdir(), "gsd-slice-completion-domain-"));
  tempDirs.add(base);
  assert.equal(openDatabase(join(base, "gsd.db")), true);
  db().exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M001', 'Slice lifecycle', 'planned', '2026-07-14T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, created_at)
    VALUES ('M001', 'S01', 'Completion', 'pending', '2026-07-14T00:00:00.000Z');
    INSERT INTO tasks (milestone_id, slice_id, id, title, status, sequence)
    VALUES
      ('M001', 'S01', 'T01', 'Verified child', 'pending', 1),
      ('M001', 'S01', 'T02', 'Intentionally cancelled child', 'pending', 2);
    INSERT INTO requirements (id, class, status, description)
    VALUES ('R-CANCEL-T02', 'quality-attribute', 'active', 'T02 omission is authorized');
    INSERT INTO quality_gates (milestone_id, slice_id, gate_id, scope, task_id, status)
    VALUES ('M001', 'S01', 'Q8', 'slice', '', 'pending');
    INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status,
      project_root_realpath
    ) VALUES (
      'worker-1', 'test-host', 1, '2026-07-14T00:00:00.000Z', 'test',
      '2026-07-14T00:00:00.000Z', 'active', '/tmp/project'
    );
    INSERT INTO milestone_leases (
      milestone_id, worker_id, fencing_token, acquired_at, expires_at, status
    ) VALUES (
      'M001', 'worker-1', 7, '2026-07-14T00:00:00.000Z',
      '2099-07-14T00:00:00.000Z', 'held'
    );
  `);
  executeAtFence("test.slice-completion.ready", "fixture/slice-completion/ready", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "ready",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "slice", milestoneId: "M001", sliceId: "S01", lifecycleStatus: "ready",
    });
    for (const taskId of ["T01", "T02"]) {
      adoptOrTransitionLifecycle(context, {
        itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId, lifecycleStatus: "ready",
      });
    }
  });
}

function claimTask(taskId = "T01"): string {
  return claimTaskAttempt({
    invocation: invocation(`fixture/${taskId}/claim`),
    task: { milestoneId: "M001", sliceId: "S01", taskId },
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: insertClaimedDispatch(taskId),
  }).attemptId;
}

function finishTaskWithOptionalEvidence(includeVerdict: boolean, authorizeCancellation = true): void {
  const attemptId = claimTask();
  settleTaskAttempt({
    invocation: invocation("fixture/T01/settle"),
    attemptId,
    outcome: "succeeded",
    failureClass: "none",
    summary: "Task implementation succeeded.",
    output: { artifact: "immutable-task-history" },
  });
  if (includeVerdict) {
    recordTaskTechnicalVerdict({
      invocation: invocation("fixture/T01/verify"),
      attemptId,
      testedSourceRevision: "git:fixture-source-revision",
      verdict: "pass",
      rationale: "Focused verification passed.",
      evidence: {
        evidenceClass: "command",
        commandOrTool: "node --test slice-completion-domain-operation.test.ts",
        workingDirectory: "/tmp/project",
        startedAt: "2026-07-14T00:01:00.000Z",
        endedAt: "2026-07-14T00:01:01.000Z",
        exitCode: 0,
        observation: "passed",
        durableOutputRef: "db://fixture/T01/verification",
        environment: { runner: "node-test", fixture: "slice-completion" },
      },
    });
  }
  executeAtFence("task.completion.publish", "fixture/slice-completion/terminal", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01", lifecycleStatus: "completed",
    });
    const lifecycleId = String(row(`
      SELECT lifecycle_id FROM workflow_execution_attempts WHERE attempt_id = '${attemptId}'
    `).lifecycle_id);
    let previousCheckpointId = String(row(`
      SELECT kernel_checkpoint_id FROM workflow_kernel_checkpoints
      WHERE attempt_id = '${attemptId}' AND next_stage = 'verify'
        AND NOT EXISTS (
          SELECT 1 FROM workflow_kernel_checkpoints successor
          WHERE successor.previous_kernel_checkpoint_id = workflow_kernel_checkpoints.kernel_checkpoint_id
        )
    `).kernel_checkpoint_id);
    for (const nextStage of ["route", "closeout", "settled"] as const) {
      previousCheckpointId = appendKernelCheckpoint(context, {
        lifecycleId,
        attemptId,
        nextStage,
        previousKernelCheckpointId: previousCheckpointId,
      }).kernelCheckpointId;
    }
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T02", lifecycleStatus: "cancelled",
    });
    db().prepare(`
      UPDATE tasks SET status = 'complete', completed_at = '2026-07-14T00:02:00.000Z'
      WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
    `).run();
    db().prepare(`
      UPDATE tasks SET status = 'skipped', completed_at = NULL
      WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T02'
    `).run();
  }, {
    eventType: "task.completion.published",
    entityType: "task",
    entityId: "M001/S01/T01",
    payload: { attemptId },
  });
  if (authorizeCancellation) {
    const lifecycleId = String(row(`
      SELECT lifecycle_id FROM workflow_item_lifecycles
      WHERE item_kind = 'task' AND milestone_id = 'M001'
        AND slice_id = 'S01' AND task_id = 'T02'
    `).lifecycle_id);
    const waiver = grantTaskWaiver({
      invocation: invocation("fixture/T02/waiver"),
      lifecycleId,
      requirementId: "R-CANCEL-T02",
      scope: "M001/S01/T02 cancellation",
      rationale: "T02 is intentionally omitted from this Slice completion.",
      grantedByActorType: "policy",
    });
    recordTaskRequirementDisposition({
      invocation: invocation("fixture/T02/disposition"),
      requirementId: "R-CANCEL-T02",
      disposition: "waived",
      waiverId: waiver.waiverId,
      rationale: "The current Task Waiver authorizes the cancelled child.",
    });
  }
}

function taskHistorySnapshot(): Record<string, unknown> {
  const lifecycleId = String(row(`
    SELECT lifecycle_id FROM workflow_item_lifecycles
    WHERE item_kind = 'task' AND milestone_id = 'M001'
      AND slice_id = 'S01' AND task_id = 'T01'
  `).lifecycle_id);
  return {
    lifecycle: rows(`SELECT * FROM workflow_item_lifecycles WHERE lifecycle_id = '${lifecycleId}'`),
    attempts: rows(`SELECT * FROM workflow_execution_attempts WHERE lifecycle_id = '${lifecycleId}' ORDER BY attempt_number`),
    results: rows(`SELECT * FROM workflow_attempt_results WHERE lifecycle_id = '${lifecycleId}' ORDER BY created_at`),
    criteria: rows(`SELECT * FROM workflow_acceptance_criteria WHERE lifecycle_id = '${lifecycleId}' ORDER BY created_at`),
    verdicts: rows(`SELECT * FROM workflow_technical_verdicts WHERE lifecycle_id = '${lifecycleId}' ORDER BY created_at`),
    evidence: rows(`SELECT * FROM workflow_verification_evidence WHERE lifecycle_id = '${lifecycleId}' ORDER BY created_at`),
    kernelCheckpoints: rows(`SELECT * FROM workflow_kernel_checkpoints WHERE lifecycle_id = '${lifecycleId}' ORDER BY sequence`),
    workCheckpoints: rows(`SELECT * FROM workflow_work_checkpoints WHERE lifecycle_id = '${lifecycleId}' ORDER BY project_revision`),
    dispatches: rows("SELECT * FROM unit_dispatches WHERE task_id = 'T01' ORDER BY id"),
  };
}

function durableSnapshot(): Record<string, unknown> {
  return {
    authority: rows("SELECT * FROM project_authority"),
    milestones: rows("SELECT * FROM milestones ORDER BY id"),
    slices: rows("SELECT * FROM slices ORDER BY milestone_id, id"),
    tasks: rows("SELECT * FROM tasks ORDER BY milestone_id, slice_id, id"),
    gates: rows("SELECT * FROM quality_gates ORDER BY milestone_id, slice_id, gate_id, task_id"),
    gateRuns: rows("SELECT * FROM gate_runs ORDER BY id"),
    operations: rows("SELECT * FROM workflow_operations ORDER BY resulting_revision"),
    lifecycles: rows("SELECT * FROM workflow_item_lifecycles ORDER BY item_kind, task_id"),
    attempts: rows("SELECT * FROM workflow_execution_attempts ORDER BY lifecycle_id, attempt_number"),
    results: rows("SELECT * FROM workflow_attempt_results ORDER BY lifecycle_id, created_at"),
    criteria: rows("SELECT * FROM workflow_acceptance_criteria ORDER BY lifecycle_id, created_at"),
    verdicts: rows("SELECT * FROM workflow_technical_verdicts ORDER BY lifecycle_id, created_at"),
    evidence: rows("SELECT * FROM workflow_verification_evidence ORDER BY lifecycle_id, created_at"),
    waivers: rows("SELECT * FROM workflow_waivers ORDER BY project_revision"),
    dispositions: rows("SELECT * FROM workflow_requirement_dispositions ORDER BY project_revision"),
    kernelCheckpoints: rows("SELECT * FROM workflow_kernel_checkpoints ORDER BY lifecycle_id, sequence"),
    workCheckpoints: rows("SELECT * FROM workflow_work_checkpoints ORDER BY project_revision"),
    events: rows("SELECT * FROM workflow_domain_events ORDER BY project_revision, event_index"),
    outbox: rows("SELECT * FROM workflow_outbox ORDER BY outbox_id"),
    projections: rows("SELECT * FROM workflow_projection_work ORDER BY source_project_revision"),
    dispatches: rows("SELECT * FROM unit_dispatches ORDER BY id"),
  };
}

function validInput(idempotencyKey: string): CompletionInput {
  return {
    invocation: invocation(idempotencyKey),
    slice: { milestoneId: "M001", sliceId: "S01" },
    closeout: closeout(),
  };
}

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("Slice completion atomically publishes normalized closeout, Q8, lifecycle, and projection work", () => {
  makeBase();
  finishTaskWithOptionalEvidence(true);
  const historyBefore = taskHistorySnapshot();
  const beforeRevision = Number(row("SELECT revision FROM project_authority").revision);
  const input = validInput("slice-complete/direct/success");

  const result = completeSlice(input);

  assert.equal(result.status, "committed");
  const proofs = result.proofs as Array<{ testedSourceRevision?: string }>;
  assert.equal(proofs[0]?.testedSourceRevision, "git:fixture-source-revision");
  assert.equal(Number(row("SELECT revision FROM project_authority").revision), beforeRevision + 1);
  assert.deepEqual(row(`
    SELECT slice.status AS legacy_status, slice.completed_at,
           lifecycle.lifecycle_status AS canonical_status
    FROM slices slice
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.item_kind = 'slice'
     AND lifecycle.milestone_id = slice.milestone_id
     AND lifecycle.slice_id = slice.id
    WHERE slice.milestone_id = 'M001' AND slice.id = 'S01'
  `), {
    legacy_status: "complete",
    completed_at: result.completedAt,
    canonical_status: "completed",
  });
  assert.match(String(result.completedAt), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual(row(`
    SELECT status, verdict, rationale, findings
    FROM quality_gates
    WHERE milestone_id = 'M001' AND slice_id = 'S01' AND gate_id = 'Q8' AND task_id = ''
  `), {
    status: "complete",
    verdict: "pass",
    rationale: "Operational Readiness section populated in slice summary",
    findings: input.closeout.operationalReadiness,
  });
  assert.equal(Number(row("SELECT COUNT(*) AS count FROM gate_runs WHERE gate_id = 'Q8'").count), 1);
  const event = row(`
    SELECT event_type, entity_type, entity_id, payload_json
    FROM workflow_domain_events WHERE operation_id = '${String(result.operationId)}'
  `);
  assert.equal(event.event_type, "slice.completed");
  assert.equal(event.entity_type, "slice");
  assert.equal(event.entity_id, "M001/S01");
  const eventPayload = JSON.parse(String(event.payload_json)) as { closeout: unknown; completedAt: unknown };
  assert.deepEqual(eventPayload.closeout, input.closeout);
  assert.equal(eventPayload.completedAt, result.completedAt);
  assert.deepEqual(row(`
    SELECT projection_key, projection_kind
    FROM workflow_projection_work WHERE enqueue_operation_id = '${String(result.operationId)}'
  `), {
    projection_key: "lifecycle/m001/s01",
    projection_kind: "slice-lifecycle",
  });
  assert.deepEqual(taskHistorySnapshot(), historyBefore, "Slice completion must preserve child execution evidence");
});

test("ready can transition directly to completed only for a Slice completion", () => {
  makeBase();
  const beforeRejectedTransitions = durableSnapshot();

  assert.throws(() => executeAtFence(
    "test.task-ready-complete",
    "fixture/reject-task-ready-complete",
    (context) => adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      lifecycleStatus: "completed",
    }),
  ), /invalid (?:workflow )?lifecycle transition/i);
  assert.throws(() => executeAtFence(
    "test.milestone-ready-complete",
    "fixture/reject-milestone-ready-complete",
    (context) => adoptOrTransitionLifecycle(context, {
      itemKind: "milestone",
      milestoneId: "M001",
      lifecycleStatus: "completed",
    }),
  ), /invalid (?:workflow )?lifecycle transition/i);
  assert.deepEqual(
    durableSnapshot(),
    beforeRejectedTransitions,
    "rejected Task and Milestone transitions must leave exact zero residue",
  );

  finishTaskWithOptionalEvidence(true);
  const result = completeSlice(validInput("slice-complete/ready-to-completed"));
  assert.equal(result.status, "committed");
  assert.equal(row(`
    SELECT lifecycle_status FROM workflow_item_lifecycles
    WHERE item_kind = 'slice' AND milestone_id = 'M001' AND slice_id = 'S01'
  `).lifecycle_status, "completed");
});

test("Slice completion rejects a completed child without a current PASS Technical Verdict and evidence", () => {
  makeBase();
  finishTaskWithOptionalEvidence(false);
  const before = durableSnapshot();

  assert.throws(
    () => completeSlice(validInput("slice-complete/missing-evidence")),
    /technical verdict|verification evidence|verified|evidence/i,
  );
  assert.deepEqual(durableSnapshot(), before, "missing-evidence rejection must leave exact zero residue");
});

test("Slice completion rejects a cancelled child without a current authorized Waiver disposition", () => {
  makeBase();
  finishTaskWithOptionalEvidence(true, false);
  const before = durableSnapshot();

  assert.throws(
    () => completeSlice(validInput("slice-complete/unwaived-cancelled-child")),
    /waiver|authorized|omission/i,
  );
  assert.deepEqual(durableSnapshot(), before, "unwaived-child rejection must leave exact zero residue");
});

test("Slice completion self-heals a missing Q8 gate (#1679)", () => {
  makeBase();
  finishTaskWithOptionalEvidence(true);
  db().prepare(`
    DELETE FROM quality_gates
    WHERE milestone_id = 'M001' AND slice_id = 'S01' AND gate_id = 'Q8'
  `).run();

  const result = completeSlice(validInput("slice-complete/missing-q8"));

  assert.equal(result.status, "committed");
  const q8 = db().prepare(`
    SELECT status FROM quality_gates
    WHERE milestone_id = 'M001' AND slice_id = 'S01' AND gate_id = 'Q8'
  `).all() as Array<Record<string, unknown>>;
  assert.equal(q8.length, 1, "exactly one Q8 row after self-heal");
  assert.equal(String(q8[0]!["status"]), "complete");
});

test("Slice completion rejects pending and running descendants without durable residue", () => {
  makeBase();
  const pendingBefore = durableSnapshot();
  assert.throws(
    () => completeSlice(validInput("slice-complete/pending-descendant")),
    /not terminal|incomplete|pending/i,
  );
  assert.deepEqual(durableSnapshot(), pendingBefore, "pending-descendant rejection must leave exact zero residue");

  const attemptId = claimTask();
  assert.ok(attemptId);
  db().prepare(`
    UPDATE tasks SET status = 'in_progress'
    WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
  `).run();
  const runningBefore = durableSnapshot();
  assert.throws(
    () => completeSlice(validInput("slice-complete/running-descendant")),
    /running attempt|running descendant/i,
  );
  assert.deepEqual(durableSnapshot(), runningBefore, "running-descendant rejection must leave exact zero residue");
});

test("Slice completion ignores a running Attempt after its owning lease is released", () => {
  makeBase();
  const orphanedAttemptId = claimTask("T02");
  finishTaskWithOptionalEvidence(true);
  db().prepare(`UPDATE milestone_leases SET status = 'released' WHERE milestone_id = 'M001'`).run();

  const result = completeSlice(validInput("slice-complete/released-lease-attempt"));

  assert.equal(result.status, "committed");
  assert.deepEqual(row(`
    SELECT attempt_state, ended_at
    FROM workflow_execution_attempts WHERE attempt_id = '${orphanedAttemptId}'
  `), { attempt_state: "running", ended_at: null });
});

test("Task reopen ignores a running Attempt after its owning lease is released", () => {
  makeBase();
  const orphanedAttemptId = claimTask("T02");
  finishTaskWithOptionalEvidence(true);
  db().prepare(`UPDATE milestone_leases SET status = 'released' WHERE milestone_id = 'M001'`).run();

  const result = reopenTask({
    invocation: invocation("task-reopen/released-lease-attempt"),
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T02" },
    reason: "The previously omitted work is required again.",
  });

  assert.equal(result.canonicalStatus, "ready");
  assert.equal(result.legacyStatus, "pending");
  assert.deepEqual(row(`
    SELECT attempt_state, ended_at
    FROM workflow_execution_attempts WHERE attempt_id = '${orphanedAttemptId}'
  `), { attempt_state: "running", ended_at: null });
});

test("Slice completion rejects a deep canonical and legacy mismatch with exact zero residue", () => {
  makeBase();
  finishTaskWithOptionalEvidence(true);
  db().prepare(`
    UPDATE tasks SET status = 'pending', completed_at = NULL
    WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
  `).run();
  const before = durableSnapshot();

  assert.throws(
    () => completeSlice(validInput("slice-complete/mismatch")),
    /canonical|legacy|shadow|mismatch/i,
  );
  assert.deepEqual(durableSnapshot(), before, "mismatch rejection must leave exact zero residue");
});

test("Slice completion replays its durable receipt and conflicts on changed closeout facts", () => {
  makeBase();
  finishTaskWithOptionalEvidence(true);
  const input = validInput("slice-complete/direct/replay");

  const committed = completeSlice(input);
  const afterCommit = durableSnapshot();
  const replayed = completeSlice(input);

  assert.equal(committed.status, "committed");
  assert.equal(replayed.status, "replayed");
  assert.deepEqual({ ...replayed, status: "committed" }, committed);
  assert.deepEqual(durableSnapshot(), afterCommit, "exact retry must not duplicate completion lineage or Q8");

  assert.throws(() => completeSlice({
    ...input,
    closeout: closeout({ narrative: "Conflicting normalized closeout under the same identity." }),
  }), /idempotency conflict/i);
  assert.deepEqual(durableSnapshot(), afterCommit, "changed idempotency reuse must leave exact zero residue");
});

test("Slice reopen repairs a historically missing Q8 gate for the next completion", () => {
  makeBase();
  finishTaskWithOptionalEvidence(true);
  completeSlice(validInput("slice-complete/before-missing-q8-reopen"));
  db().prepare(`
    DELETE FROM quality_gates
    WHERE milestone_id = 'M001' AND slice_id = 'S01' AND gate_id = 'Q8'
  `).run();

  const reopened = sliceLifecycle.reopenSlice({
    invocation: invocation("slice-reopen/repair-missing-q8"),
    slice: { milestoneId: "M001", sliceId: "S01" },
    reason: "Redo the Slice from historical state.",
  });

  assert.equal(reopened.status, "committed");
  assert.deepEqual(row(`
    SELECT status, verdict, rationale, findings, evaluated_at
    FROM quality_gates
    WHERE milestone_id = 'M001' AND slice_id = 'S01' AND gate_id = 'Q8'
  `), {
    status: "pending",
    verdict: "",
    rationale: "",
    findings: "",
    evaluated_at: null,
  });
});
