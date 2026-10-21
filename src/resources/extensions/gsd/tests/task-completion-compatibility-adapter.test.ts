// Project/App: gsd-pi
// File Purpose: Executable contract for staged Task completion and verified legacy publication.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  _setDomainOperationFaultForTest,
  executeDomainOperation,
} from "../db/domain-operation.js";
import { _setManagedMutationBoundaryForTest } from "../atomic-write.js";
import { clearParseCache } from "../files.js";
import {
  _getAdapter,
  closeDatabase,
  insertArtifact,
  openDatabase,
} from "../gsd-db.js";
import { stripProjectionStamp } from "../markdown-renderer.js";
import { clearPathCache } from "../paths.js";
import {
  claimTaskAttempt,
  readLatestTaskAttempt,
  settleTaskAttempt,
} from "../task-execution-domain-operation.js";
import { reopenTask } from "../task-lifecycle-domain-operation.js";
import {
  recordFailureAndSelectRecovery,
  resumeTaskRecovery,
} from "../task-recovery-domain-operation.js";
import { resolveTaskCompletionAuthority } from "../task-completion-compatibility-adapter.js";
import { recordTaskTechnicalVerdict } from "../task-verification-domain-operation.js";
import { captureVerificationSourceSnapshot } from "../verification-source-integrity.js";
import {
  appendKernelCheckpoint,
  readDomainOperationFence,
} from "../db/writers/lifecycle-commands.js";
import { checkEngineHealth } from "../doctor-engine-checks.js";
import type { DoctorIssue } from "../doctor-types.js";
import type { ExecutionInvocation } from "../execution-invocation.js";
import {
  describeArtifactDbDriftBlocker,
  detectArtifactDbDrift,
  repairArtifactDbDrift,
} from "../state-reconciliation/drift/artifact-db.js";
import type { GSDState } from "../types.js";

interface TaskIdentity {
  milestoneId: string;
  sliceId: string;
  taskId: string;
}

interface StageTaskCompletionInput {
  invocation: ExecutionInvocation;
  basePath: string;
  task: TaskIdentity;
  completion: {
    oneLiner: string;
    narrative: string;
    verification: string;
    deviations: string;
    knownIssues: string;
    failureModes?: string;
    loadProfile?: string;
    negativeTests?: string;
    keyFiles: string[];
    keyDecisions: string[];
    blockerDiscovered: boolean;
    verificationEvidence: Array<{
      command: string;
      exitCode: number;
      verdict: string;
      durationMs: number;
    }>;
  };
}

interface PublishVerifiedTaskCompletionInput {
  invocation: ExecutionInvocation;
  basePath: string;
  task: TaskIdentity;
  attemptId: string;
}

interface StagedTaskCompletionReceipt {
  status: "committed" | "replayed";
  attemptId: string;
  resultId: string;
  summaryPath: string;
  nextStage: "verify" | "route";
}

interface PublishedTaskCompletionReceipt {
  status: "committed" | "replayed";
  attemptId: string;
  summaryPath: string;
}

interface TaskCompletionCompatibilityAdapter {
  stageTaskCompletion(input: StageTaskCompletionInput): Promise<StagedTaskCompletionReceipt>;
  publishVerifiedTaskCompletion(input: PublishVerifiedTaskCompletionInput): Promise<PublishedTaskCompletionReceipt>;
}

const TASK: TaskIdentity = { milestoneId: "M001", sliceId: "S01", taskId: "T01" };
const DOSSIER_HASH = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const CAPSTONE_HASH = "sha256:2222222222222222222222222222222222222222222222222222222222222222";
const tempDirs = new Set<string>();

async function subject(): Promise<TaskCompletionCompatibilityAdapter> {
  return import("../task-completion-compatibility-adapter.js") as Promise<TaskCompletionCompatibilityAdapter>;
}

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function row(sql: string): Record<string, unknown> {
  return db().prepare(sql).get() ?? {};
}

function rows(sql: string): Record<string, unknown>[] {
  return db().prepare(sql).all().map((entry) => ({ ...entry }));
}

function count(table: string): number {
  return Number(row(`SELECT COUNT(*) AS count FROM ${table}`).count ?? 0);
}

function invocation(key: string): ExecutionInvocation {
  return {
    idempotencyKey: key,
    sourceTransport: "pi-tool",
    actorType: "agent",
    actorId: "task-completion-test",
    traceId: key,
    turnId: "turn-task-completion",
  };
}

function recordPassingHostVerdict(basePath: string, attemptId: string): void {
  const source = captureVerificationSourceSnapshot([{ id: "project", cwd: basePath }]);
  assert.equal(source.ok, true, source.ok ? undefined : source.error);
  recordTaskTechnicalVerdict({
    invocation: invocation(`pi:host-verification:${attemptId}`),
    attemptId,
    testedSourceRevision: source.snapshot.aggregateRevision,
    verdict: "pass",
    rationale: "Host verification passed.",
    evidence: {
      evidenceClass: "command",
      commandOrTool: "node --test",
      workingDirectory: basePath,
      startedAt: "2026-07-12T00:02:00.000Z",
      endedAt: "2026-07-12T00:02:01.000Z",
      exitCode: 0,
      observation: "passed",
      durableOutputRef: `db://host-verification/${attemptId}`,
      environment: { runner: "node-test", platform: "test" },
    },
  });
}

function recordFailingHostVerdict(basePath: string, attemptId: string): void {
  recordTaskTechnicalVerdict({
    invocation: invocation(`pi:host-verification-failed:${attemptId}`),
    attemptId,
    testedSourceRevision: "git:test-source-revision",
    verdict: "fail",
    rationale: "Host verification failed.",
    evidence: {
      evidenceClass: "command",
      commandOrTool: "node --test",
      workingDirectory: basePath,
      startedAt: "2026-07-12T00:02:00.000Z",
      endedAt: "2026-07-12T00:02:01.000Z",
      exitCode: 1,
      observation: "failed",
      durableOutputRef: `db://host-verification/${attemptId}`,
      environment: { runner: "node-test", platform: "test" },
    },
  });
}

function activateExactMergedClosure(basePath: string): string {
  const dossierDir = join(basePath, "docs", "dev");
  mkdirSync(dossierDir, { recursive: true });
  writeFileSync(join(dossierDir, "m003-s07-cutover-dossier.json"), JSON.stringify({
    milestoneId: TASK.milestoneId,
    sliceId: TASK.sliceId,
    canonicalClosure: {
      blockedEntities: [`${TASK.milestoneId}/${TASK.sliceId}/${TASK.taskId}`],
      requiredEvidence: {
        automatedUatVerdict: "pass",
        durableVerdictReceipt: "required",
        sourceBinding: "exact_merged_revision",
      },
    },
    hashes: {
      dossierHash: DOSSIER_HASH,
      capstoneEvidenceHash: CAPSTONE_HASH,
    },
  }, null, 2));
  execFileSync("git", ["add", "docs/dev/m003-s07-cutover-dossier.json"], { cwd: basePath });
  execFileSync("git", ["commit", "-qm", "exact merge fixture"], { cwd: basePath });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: basePath, encoding: "utf8" }).trim();
}

function recordExactMergedUatVerdict(basePath: string, attemptId: string, mergeCommit: string): void {
  const evidenceId = "exact-merged-uat";
  const runId = "uat:M001:S01:attempt-2";
  const source = captureVerificationSourceSnapshot([{ id: "project", cwd: basePath }]);
  assert.equal(source.ok, true, source.ok ? undefined : source.error);
  const environment = {
    dossierHash: DOSSIER_HASH,
    capstoneEvidenceHash: CAPSTONE_HASH,
    authorityBaseline: "4/4",
    localMergeCommit: mergeCommit,
    sourceContentRevision: source.snapshot.aggregateRevision,
  };
  const assessment = [
    "---",
    "sliceId: S01",
    "uatType: runtime-executable",
    "verdict: PASS",
    "attempt: 2",
    `runId: ${runId}`,
    "---",
    "",
    `gsd_uat_exec:${evidenceId}`,
    mergeCommit,
    source.snapshot.aggregateRevision,
    DOSSIER_HASH,
    CAPSTONE_HASH,
    "",
  ].join("\n");
  const execDir = join(basePath, ".gsd", "exec");
  mkdirSync(execDir, { recursive: true });
  writeFileSync(join(execDir, `${evidenceId}.meta.json`), JSON.stringify({
    id: evidenceId,
    exit_code: 0,
    signal: null,
    timed_out: false,
    aborted: false,
    metadata: {
      kind: "uat_exec",
      milestoneId: TASK.milestoneId,
      sliceId: TASK.sliceId,
      checkId: "exact-merge-capstone",
      intent: "uat-runtime-check",
    },
  }));
  db().prepare(`
    INSERT INTO assessments (
      path, milestone_id, slice_id, status, scope, full_content, created_at
    ) VALUES (
      '.gsd/phases/01-test/01-01-ASSESSMENT.md', 'M001', 'S01',
      'pass', 'run-uat', :full_content, '2026-07-12T00:03:00.000Z'
    )
  `).run({ ":full_content": assessment });
  db().prepare(`
    INSERT INTO quality_gates (
      milestone_id, slice_id, gate_id, scope, task_id,
      status, verdict, rationale, findings, evaluated_at
    ) VALUES (
      'M001', 'S01', 'UAT', 'slice', '', 'complete', 'pass',
      'Exact-merged UAT passed.', :findings, '2026-07-12T00:03:00.000Z'
    )
  `).run({ ":findings": assessment });
  db().prepare(`
    INSERT INTO gate_runs (
      trace_id, turn_id, gate_id, gate_type, unit_type, unit_id,
      milestone_id, slice_id, outcome, failure_class, rationale,
      findings, attempt, max_attempts, retryable, evaluated_at
    ) VALUES (
      'uat:M001:S01', :run_id, 'UAT', 'uat', 'run-uat', 'run-uat:M001/S01',
      'M001', 'S01', 'pass', 'none', 'Exact-merged UAT passed.',
      :findings, 2, 2, 0, '2026-07-12T00:03:00.000Z'
    )
  `).run({ ":run_id": runId, ":findings": assessment });
  recordTaskTechnicalVerdict({
    invocation: invocation(`pi:exact-merged-verification:${attemptId}`),
    attemptId,
    testedSourceRevision: source.snapshot.aggregateRevision,
    verdict: "pass",
    rationale: "Exact-merged UAT passed.",
    evidence: {
      evidenceClass: "command",
      commandOrTool: "gsd_uat_exec",
      workingDirectory: basePath,
      startedAt: "2026-07-12T00:02:00.000Z",
      endedAt: "2026-07-12T00:02:01.000Z",
      exitCode: 0,
      observation: "passed",
      durableOutputRef: evidenceId,
      environment,
    },
  });
}

function createFixture(): { basePath: string; planPath: string; attemptId: string } {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-task-completion-adapter-"));
  tempDirs.add(basePath);
  execFileSync("git", ["init", "-q"], { cwd: basePath });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: basePath });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: basePath });
  writeFileSync(join(basePath, "tracked.txt"), "verified\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: basePath });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: basePath });
  const phaseDir = join(basePath, ".gsd", "phases", "01-test");
  mkdirSync(phaseDir, { recursive: true });
  const planPath = join(phaseDir, "01-01-PLAN.md");
  writeFileSync(planPath, [
    "# S01: Compatibility adapter",
    "",
    "## Tasks",
    "",
    "- [ ] **T01: Stage completion** `est:30m`",
    "  - Do: Keep legacy status open until host verification",
    "  - Verify: npm test",
    "",
  ].join("\n"));

  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  db().exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M001', 'Compatibility adapter', 'active', '2026-07-12T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, created_at)
    VALUES ('M001', 'S01', 'Completion seam', 'active', '2026-07-12T00:00:00.000Z');
    INSERT INTO tasks (
      milestone_id, slice_id, id, title, status, verify, sequence
    ) VALUES (
      'M001', 'S01', 'T01', 'Stage completion', 'in_progress', 'npm test', 1
    );
    INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status,
      project_root_realpath
    ) VALUES (
      'worker-1', 'test-host', 1, '2026-07-12T00:00:00.000Z', 'test',
      '2026-07-12T00:00:00.000Z', 'active', '${basePath.replaceAll("'", "''")}'
    );
    INSERT INTO milestone_leases (
      milestone_id, worker_id, fencing_token, acquired_at, expires_at, status
    ) VALUES (
      'M001', 'worker-1', 7, '2026-07-12T00:00:00.000Z',
      '2099-07-12T00:00:00.000Z', 'held'
    );
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES (
      'trace-dispatch-1', 'turn-dispatch-1', 'worker-1', 7,
      'M001', 'S01', 'T01', 'execute-task', 'M001/S01/T01',
      'claimed', 1, '2026-07-12T00:00:00.000Z'
    );
  `);
  const dispatchId = Number(row("SELECT id FROM unit_dispatches").id);
  const claim = claimTaskAttempt({
    invocation: invocation("task-completion/claim"),
    task: TASK,
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: dispatchId,
  });
  return { basePath, planPath, attemptId: claim.attemptId };
}

function stageInput(basePath: string): StageTaskCompletionInput {
  return {
    invocation: invocation("task-completion/stage"),
    basePath,
    task: TASK,
    completion: {
      oneLiner: "Implemented the compatibility seam",
      narrative: "The executor produced a candidate result for host verification.",
      verification: "Agent reported npm test passed; host verification is still required.",
      deviations: "None.",
      knownIssues: "None.",
      keyFiles: ["src/task.ts"],
      keyDecisions: ["Keep dependency unlock behind host verification."],
      blockerDiscovered: false,
      verificationEvidence: [{
        command: "npm test",
        exitCode: 0,
        verdict: "pass",
        durationMs: 25,
      }],
    },
  };
}

function seedTaskQualityGates(...taskIds: string[]): void {
  const insert = db().prepare(`
    INSERT INTO quality_gates (
      milestone_id, slice_id, gate_id, scope, task_id, status
    ) VALUES ('M001', 'S01', :gate_id, 'task', :task_id, 'pending')
  `);
  for (const taskId of taskIds) {
    for (const gateId of ["Q5", "Q6", "Q7"]) {
      insert.run({ ":gate_id": gateId, ":task_id": taskId });
    }
  }
}

function publishInput(basePath: string, attemptId: string): PublishVerifiedTaskCompletionInput {
  return {
    invocation: invocation("task-completion/publish"),
    basePath,
    task: TASK,
    attemptId,
  };
}

function taskState(): Record<string, unknown> {
  return row(`
    SELECT status, completed_at, one_liner, narrative, full_summary_md
    FROM tasks WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
  `);
}

function reconciliationState(): GSDState {
  return {
    activeMilestone: { id: "M001", title: "Compatibility adapter" },
    activeSlice: null,
    activeTask: null,
    phase: "executing",
    recentDecisions: [],
    blockers: [],
    nextAction: "Verify task",
    registry: [],
    requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 },
    progress: { milestones: { done: 0, total: 1 } },
  };
}

async function taskSummaryDivergence(basePath: string, taskId = "T01"): Promise<{
  doctorDivergence: boolean;
  reconciliationDivergence: boolean;
}> {
  const issues: DoctorIssue[] = [];
  await checkEngineHealth(basePath, issues, []);
  const doctorDivergence = issues.some((issue) =>
    issue.code === "artifact_db_status_divergence" && issue.unitId === `M001/S01/${taskId}`
  );

  const state = reconciliationState();
  const drifts = detectArtifactDbDrift(state, { basePath, state });
  const reconciliationDivergence = drifts.some((drift) =>
    drift.kind === "artifact-db-status-divergence" && drift.taskId === taskId
  );
  return { doctorDivergence, reconciliationDivergence };
}

async function assertStagedSummaryIsCurrent(basePath: string): Promise<void> {
  assert.deepEqual(
    await taskSummaryDivergence(basePath),
    { doctorDivergence: false, reconciliationDivergence: false },
    "doctor and reconciliation must accept a canonical staged Task SUMMARY",
  );
}

function settlementState(): Record<string, unknown> {
  return {
    authority: row("SELECT revision, authority_epoch FROM project_authority"),
    task: row(`
      SELECT status, completed_at, one_liner, narrative, verification_result,
             blocker_discovered, deviations, known_issues, key_files,
             key_decisions, full_summary_md
      FROM tasks WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
    `),
    evidence: rows("SELECT * FROM verification_evidence ORDER BY id"),
    attempts: rows("SELECT * FROM workflow_execution_attempts ORDER BY attempt_number"),
    results: rows("SELECT * FROM workflow_attempt_results ORDER BY created_at"),
    operations: rows("SELECT * FROM workflow_operations ORDER BY resulting_revision"),
    events: rows("SELECT * FROM workflow_domain_events ORDER BY project_revision, event_index"),
    outbox: rows("SELECT * FROM workflow_outbox ORDER BY outbox_id"),
    projections: rows("SELECT * FROM workflow_projection_work ORDER BY source_project_revision"),
    dispatches: rows("SELECT * FROM unit_dispatches ORDER BY id"),
    checkpoints: rows("SELECT * FROM workflow_kernel_checkpoints ORDER BY sequence"),
  };
}

afterEach(() => {
  _setDomainOperationFaultForTest(null);
  _setManagedMutationBoundaryForTest(null);
  closeDatabase();
  clearPathCache();
  clearParseCache();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("staging settles the canonical Attempt but leaves legacy completion and its checkbox pending", async () => {
  const { stageTaskCompletion } = await subject();
  const { basePath, planPath, attemptId } = createFixture();

  const staged = await stageTaskCompletion(stageInput(basePath));

  assert.equal(staged.status, "committed");
  assert.equal(staged.attemptId, attemptId);
  assert.deepEqual(row(`
    SELECT attempt_id, outcome, operation_id
    FROM workflow_attempt_results
  `), {
    attempt_id: attemptId,
    outcome: "succeeded",
    operation_id: row("SELECT settle_operation_id FROM workflow_execution_attempts").settle_operation_id,
  });
  const stagedTask = taskState();
  assert.equal(stagedTask.status, "in_progress");
  assert.equal(stagedTask.completed_at, null);
  assert.equal(stagedTask.one_liner, "Implemented the compatibility seam");
  assert.equal(stagedTask.narrative, "The executor produced a candidate result for host verification.");
  assert.match(String(stagedTask.full_summary_md), /Implemented the compatibility seam/);
  assert.equal(existsSync(staged.summaryPath), true);
  assert.match(readFileSync(staged.summaryPath, "utf8"), /host verification is still required/i);
  assert.match(readFileSync(planPath, "utf8"), /\[ \][^\n]*\*\*T01/);
  assert.equal(count("verification_evidence"), 1);
});

test("#1677: a canonical staged Task SUMMARY is current while awaiting host verification", async () => {
  const { stageTaskCompletion } = await subject();
  const { basePath } = createFixture();

  const staged = await stageTaskCompletion(stageInput(basePath));

  assert.equal(staged.nextStage, "verify");
  assert.deepEqual(
    row("SELECT status, completed_at FROM tasks WHERE id = 'T01'"),
    { status: "in_progress", completed_at: null },
  );
  const artifactContent = String(row(
    "SELECT full_content FROM artifacts WHERE artifact_type = 'SUMMARY' AND task_id = 'T01'",
  ).full_content);
  const taskContent = String(row(
    "SELECT full_summary_md FROM tasks WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'",
  ).full_summary_md);
  assert.equal(readFileSync(staged.summaryPath, "utf8"), artifactContent);
  assert.equal(stripProjectionStamp(artifactContent), stripProjectionStamp(taskContent));
  await assertStagedSummaryIsCurrent(basePath);
});

function registerFailClosedSummaryMutation(
  name: string,
  mutate: (basePath: string, summaryPath: string) => string | void,
): void {
  test(`#1677: ${name} remains fail-closed`, async () => {
    const { stageTaskCompletion } = await subject();
    const { basePath } = createFixture();
    const staged = await stageTaskCompletion(stageInput(basePath));
    const expectedTaskId = mutate(basePath, staged.summaryPath) ?? "T01";

    assert.deepEqual(
      await taskSummaryDivergence(basePath, expectedTaskId),
      { doctorDivergence: true, reconciliationDivergence: true },
    );
  });
}

registerFailClosedSummaryMutation("mismatched artifact identity", () => {
  db().prepare(`
    UPDATE artifacts SET task_id = 'T99'
    WHERE artifact_type = 'SUMMARY' AND task_id = 'T01'
  `).run();
  return "T99";
});

registerFailClosedSummaryMutation("non-canonical artifact path", (basePath, summaryPath) => {
  const alternatePath = join(basePath, ".gsd", "phases", "01-test", "T01-ALT-SUMMARY.md");
  writeFileSync(alternatePath, readFileSync(summaryPath, "utf8"));
  db().prepare(`
    UPDATE artifacts SET path = :path
    WHERE artifact_type = 'SUMMARY' AND task_id = 'T01'
  `).run({ ":path": alternatePath });
});

registerFailClosedSummaryMutation("disk and artifact byte mismatch", (_basePath, summaryPath) => {
  writeFileSync(summaryPath, `${readFileSync(summaryPath, "utf8")}disk-only mutation\n`);
});

registerFailClosedSummaryMutation("artifact and Task summary mismatch", () => {
  db().prepare(`
    UPDATE tasks SET full_summary_md = full_summary_md || '\nDB-only mutation\n'
    WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
  `).run();
});

test("#1677: an in-progress Task SUMMARY without an Attempt remains fail-closed", async () => {
  const { stageTaskCompletion } = await subject();
  const { basePath } = createFixture();
  const staged = await stageTaskCompletion(stageInput(basePath));
  const summaryPath = staged.summaryPath.replace("T01-SUMMARY.md", "T02-SUMMARY.md");
  assert.notEqual(summaryPath, staged.summaryPath);
  const taskSummary = "# T02 Summary\n\nNo Attempt exists for this projection.\n";
  const artifactContent = `${taskSummary}<!-- gsd:state-version=1:1 -->\n`;
  db().prepare(`
    INSERT INTO tasks (
      milestone_id, slice_id, id, title, status, full_summary_md, sequence
    ) VALUES (
      'M001', 'S01', 'T02', 'Missing Attempt', 'in_progress', :summary, 2
    )
  `).run({ ":summary": taskSummary });
  writeFileSync(summaryPath, artifactContent);
  insertArtifact({
    path: summaryPath,
    artifact_type: "SUMMARY",
    milestone_id: "M001",
    slice_id: "S01",
    task_id: "T02",
    full_content: artifactContent,
  });

  assert.deepEqual(
    await taskSummaryDivergence(basePath, "T02"),
    { doctorDivergence: true, reconciliationDivergence: true },
  );
});

test("#1677: a newer running Attempt keeps an older successful staged SUMMARY fail-closed", async () => {
  const { stageTaskCompletion } = await subject();
  const { basePath, attemptId } = createFixture();
  await stageTaskCompletion(stageInput(basePath));
  db().prepare(`
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES (
      'trace-dispatch-2', 'turn-dispatch-2', 'worker-1', 7,
      'M001', 'S01', 'T01', 'execute-task', 'M001/S01/T01',
      'claimed', 2, '2026-07-12T00:10:00.000Z'
    )
  `).run();
  const dispatchId = Number(row("SELECT MAX(id) AS id FROM unit_dispatches").id);
  const retry = claimTaskAttempt({
    invocation: invocation("task-completion/retry-claim"),
    task: TASK,
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: dispatchId,
    retryOfAttemptId: attemptId,
  });
  assert.equal(retry.attemptNumber, 2);

  assert.deepEqual(
    await taskSummaryDivergence(basePath),
    { doctorDivergence: true, reconciliationDivergence: true },
  );
});

test("#1677: a verify-stage SUMMARY remains current after a passing verdict until publication", async () => {
  const { stageTaskCompletion } = await subject();
  const { basePath, attemptId } = createFixture();
  await stageTaskCompletion(stageInput(basePath));
  recordPassingHostVerdict(basePath, attemptId);

  const attempt = readLatestTaskAttempt(TASK);
  assert.equal(attempt?.nextStage, "verify");
  await assertStagedSummaryIsCurrent(basePath);
});

test("#1677: an unreadable canonical Task SUMMARY remains fail-closed", async () => {
  const { stageTaskCompletion } = await subject();
  const { basePath } = createFixture();
  const staged = await stageTaskCompletion(stageInput(basePath));
  unlinkSync(staged.summaryPath);
  mkdirSync(staged.summaryPath);

  assert.deepEqual(
    await taskSummaryDivergence(basePath),
    { doctorDivergence: true, reconciliationDivergence: true },
    "diagnostics must report divergence when canonical content cannot be read",
  );
});

test("#1677: a canonical staged Task SUMMARY remains current on a host-verification recovery route", async () => {
  const { stageTaskCompletion } = await subject();
  const { basePath, attemptId } = createFixture();
  await stageTaskCompletion(stageInput(basePath));

  recordFailingHostVerdict(basePath, attemptId);

  const attempt = readLatestTaskAttempt(TASK);
  assert.equal(attempt?.state, "settled");
  assert.equal(attempt?.outcome, "succeeded");
  assert.equal(attempt?.nextStage, "route");
  await assertStagedSummaryIsCurrent(basePath);
});

test("#1771: a stale SUMMARY artifact row with no file on a pending task does not wedge", async () => {
  const { stageTaskCompletion } = await subject();
  const { basePath } = createFixture();
  const staged = await stageTaskCompletion(stageInput(basePath));

  // The clean-finalize aftermath from #1771: the task is back to pending and
  // the SUMMARY file is gone, but the artifact bookkeeping row survives.
  db().prepare(`
    UPDATE tasks SET status = 'pending', full_summary_md = ''
    WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
  `).run();
  unlinkSync(staged.summaryPath);

  assert.deepEqual(
    await taskSummaryDivergence(basePath),
    { doctorDivergence: false, reconciliationDivergence: false },
    "dead artifact bookkeeping on a pending task must not wedge drift detection",
  );
});

test("#1983: a reopened Task SUMMARY with no Attempt lineage does not wedge", async () => {
  const { basePath } = createFixture();
  const summaryPath = join(basePath, ".gsd", "phases", "01-test", "T02-SUMMARY.md");
  db().prepare(`
    INSERT INTO tasks (
      milestone_id, slice_id, id, title, status, completed_at, sequence
    ) VALUES (
      'M001', 'S01', 'T02', 'Failed completion', 'complete',
      '2026-07-12T00:01:00.000Z', 2
    )
  `).run();
  insertArtifact({
    path: summaryPath,
    artifact_type: "SUMMARY",
    milestone_id: "M001",
    slice_id: "S01",
    task_id: "T02",
    full_content: "# T02 Summary\n",
  });

  reopenTask({
    invocation: invocation("task-completion/reopen-without-attempt"),
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T02" },
    reason: "completion failed before it could mint an Attempt",
  });

  assert.equal(Number(row(`
    SELECT COUNT(*) AS count
    FROM workflow_execution_attempts attempt
    JOIN workflow_item_lifecycles lifecycle ON lifecycle.lifecycle_id = attempt.lifecycle_id
    WHERE lifecycle.task_id = 'T02'
  `).count), 0, "reopen must not fabricate an Attempt");
  assert.deepEqual(
    await taskSummaryDivergence(basePath, "T02"),
    { doctorDivergence: false, reconciliationDivergence: false },
    "the current task.reopened event proves the missing-file row is dead bookkeeping",
  );
});

test("#1983: an unreopened pending Task SUMMARY with no Attempt lineage stays fail-closed", async () => {
  const { basePath } = createFixture();
  const summaryPath = join(basePath, ".gsd", "phases", "01-test", "T02-SUMMARY.md");
  db().prepare(`
    INSERT INTO tasks (
      milestone_id, slice_id, id, title, status, sequence
    ) VALUES (
      'M001', 'S01', 'T02', 'Unproven summary', 'pending', 2
    )
  `).run();
  insertArtifact({
    path: summaryPath,
    artifact_type: "SUMMARY",
    milestone_id: "M001",
    slice_id: "S01",
    task_id: "T02",
    full_content: "# T02 Summary\n",
  });

  assert.deepEqual(
    await taskSummaryDivergence(basePath, "T02"),
    { doctorDivergence: false, reconciliationDivergence: true },
    "doctor ignores absent artifact files, while reconciliation keeps unproven rows fail-closed",
  );
});

test("#1763: staging from a milestone worktree dual-writes the SUMMARY to the project root", async () => {
  const { stageTaskCompletion } = await subject();
  const { basePath } = createFixture();
  const worktreePath = join(basePath, ".gsd-worktrees", "M001");
  mkdirSync(worktreePath, { recursive: true });

  const staged = await stageTaskCompletion(stageInput(worktreePath));

  const { resolveTaskFile } = await import("../paths.js");
  const rootSummary = resolveTaskFile(basePath, "M001", "S01", "T01", "SUMMARY");
  assert.ok(rootSummary, "project-root SUMMARY path resolves");
  assert.equal(existsSync(rootSummary), true, "the canonical copy survives at the project root");
  assert.equal(
    readFileSync(rootSummary, "utf8"),
    readFileSync(staged.summaryPath, "utf8"),
    "the project-root copy is byte-identical to the worktree-local render",
  );
});

test("#1763: verified publication from a milestone worktree restores both SUMMARY projections", async () => {
  const { publishVerifiedTaskCompletion, stageTaskCompletion } = await subject();
  const { basePath, planPath, attemptId } = createFixture();
  writeFileSync(join(basePath, ".git", "info", "exclude"), ".gsd-worktrees/\n");
  const worktreePath = join(basePath, ".gsd-worktrees", "M001");
  const worktreePhaseDir = join(worktreePath, ".gsd", "phases", "01-test");
  mkdirSync(worktreePhaseDir, { recursive: true });
  writeFileSync(join(worktreePhaseDir, "01-01-PLAN.md"), readFileSync(planPath, "utf8"));
  const staged = await stageTaskCompletion(stageInput(worktreePath));

  const { resolveTaskFile } = await import("../paths.js");
  const rootSummary = resolveTaskFile(basePath, "M001", "S01", "T01", "SUMMARY");
  assert.ok(rootSummary, "project-root SUMMARY path resolves");
  unlinkSync(rootSummary);
  unlinkSync(staged.summaryPath);
  recordPassingHostVerdict(basePath, attemptId);

  const published = await publishVerifiedTaskCompletion(publishInput(worktreePath, attemptId));

  assert.equal(existsSync(rootSummary), true, "publication restores the canonical copy");
  assert.equal(existsSync(published.summaryPath), true, "publication restores the worktree copy");
  assert.equal(
    readFileSync(rootSummary, "utf8"),
    readFileSync(published.summaryPath, "utf8"),
    "the project-root and worktree copies are byte-identical",
  );
});

test("#1677: inside a worktree the classifier falls back to the project-root copy", async () => {
  const { stageTaskCompletion } = await subject();
  const { basePath } = createFixture();
  await stageTaskCompletion(stageInput(basePath));

  const worktreePath = join(basePath, ".gsd-worktrees", "M001");
  mkdirSync(worktreePath, { recursive: true });
  const artifact = row(
    "SELECT path, full_content FROM artifacts WHERE artifact_type = 'SUMMARY' AND task_id = 'T01'",
  );
  const taskRow = row("SELECT status, full_summary_md FROM tasks WHERE id = 'T01'");
  const { isCanonicalStagedTaskSummaryProjection } = await import(
    "../task-summary-projection-classification.js"
  );
  assert.equal(
    isCanonicalStagedTaskSummaryProjection(worktreePath, {
      path: String(artifact.path),
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      fullContent: String(artifact.full_content),
    }, {
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      status: String(taskRow.status),
      fullSummaryMd: String(taskRow.full_summary_md),
    }),
    true,
    "the project-root canonical copy exempts the staged projection inside the worktree",
  );
});

test("#1726: a blockerDiscovered failure leaves no staged SUMMARY and no wedge", async () => {
  const { stageTaskCompletion } = await subject();
  const { basePath } = createFixture();
  const input = stageInput(basePath);
  input.completion.blockerDiscovered = true;

  const staged = await stageTaskCompletion(input);

  const attempt = readLatestTaskAttempt(TASK);
  assert.equal(staged.nextStage, "route");
  assert.equal(attempt?.state, "settled");
  assert.equal(attempt?.outcome, "failed");
  assert.equal(
    row("SELECT full_summary_md FROM tasks WHERE id = 'T01'").full_summary_md,
    "",
    "the staged summary is cleared at settle time",
  );
  assert.equal(
    Number(row("SELECT COUNT(*) AS count FROM artifacts WHERE artifact_type = 'SUMMARY'").count),
    0,
    "no SUMMARY artifact is projected for a failed Attempt",
  );
  assert.equal(
    Number(row("SELECT COUNT(*) AS count FROM workflow_operations WHERE operation_type = 'attempt.route'").count),
    0,
    "recording a blocker only settles the Attempt; recovery routing belongs to unit closeout",
  );
  assert.deepEqual(
    await taskSummaryDivergence(basePath),
    { doctorDivergence: false, reconciliationDivergence: false },
    "a blockerDiscovered failure must not leave a staged SUMMARY that wedges drift detection",
  );
  const { renderTaskSummary } = await import("../markdown-renderer.js");
  assert.equal(
    await renderTaskSummary(basePath, "M001", "S01", "T01"),
    false,
    "the renderer refuses re-projection",
  );
});

test("#1726: an interrupted retry quarantines its abandoned staged SUMMARY without a blocker", async () => {
  const { stageTaskCompletion } = await subject();
  const { basePath, attemptId } = createFixture();
  const staged = await stageTaskCompletion(stageInput(basePath));
  db().prepare(`
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES (
      'trace-dispatch-2', 'turn-dispatch-2', 'worker-1', 7,
      'M001', 'S01', 'T01', 'execute-task', 'M001/S01/T01',
      'claimed', 2, '2026-07-12T00:10:00.000Z'
    )
  `).run();
  const retry = claimTaskAttempt({
    invocation: invocation("task-completion/interrupted-retry-claim"),
    task: TASK,
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: Number(row("SELECT MAX(id) AS id FROM unit_dispatches").id),
    retryOfAttemptId: attemptId,
  });

  settleTaskAttempt({
    invocation: invocation("task-completion/interrupted-retry-settle"),
    attemptId: retry.attemptId,
    outcome: "interrupted",
    failureClass: "operator-cancelled",
    summary: "The retry was cancelled",
    output: { cancelled: true },
  });

  assert.equal(row("SELECT full_summary_md FROM tasks WHERE id = 'T01'").full_summary_md, "");
  assert.equal(count("artifacts"), 0, "settlement removes the stale artifact row atomically");
  assert.equal(existsSync(staged.summaryPath), true, "the abandoned disk projection awaits quarantine");
  const { renderTaskSummary } = await import("../markdown-renderer.js");
  assert.equal(await renderTaskSummary(basePath, "M001", "S01", "T01"), false);

  const state = reconciliationState();
  const drift = detectArtifactDbDrift(state, { basePath, state }).find((record) =>
    record.kind === "artifact-db-status-divergence" && record.taskId === "T01"
  );
  assert.ok(drift && drift.kind === "artifact-db-status-divergence");
  const noncanonicalPath = join(basePath, ".gsd", "phases", "01-test", "T01-ALT-SUMMARY.md");
  writeFileSync(noncanonicalPath, readFileSync(staged.summaryPath));
  assert.match(
    describeArtifactDbDriftBlocker({ ...drift, artifactPath: noncanonicalPath }, { basePath, state }) ?? "",
    /Artifact\/DB status drift/,
    "noncanonical cancellation artifacts remain fail-closed",
  );
  unlinkSync(noncanonicalPath);
  assert.equal(
    describeArtifactDbDriftBlocker(drift, { basePath, state }),
    null,
    "abandoned staging is auto-repairable",
  );
  await repairArtifactDbDrift(drift, { basePath, state });

  assert.equal(existsSync(staged.summaryPath), false);
  const quarantineRoot = join(basePath, ".gsd", "quarantine", "projections");
  const quarantined = readdirSync(quarantineRoot, { recursive: true })
    .map(String)
    .find((path) => path.endsWith("T01-SUMMARY.md"));
  assert.ok(quarantined, "the abandoned projection is preserved in quarantine");
  assert.deepEqual(
    await taskSummaryDivergence(basePath),
    { doctorDivergence: false, reconciliationDivergence: false },
  );
});

test("staging normalizes a pending legacy Task and clears its stale completion timestamp", async () => {
  const { stageTaskCompletion } = await subject();
  const { basePath } = createFixture();
  db().prepare(`
    UPDATE tasks
    SET status = 'pending', completed_at = '2026-07-12T00:05:00.000Z'
    WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
  `).run();

  const staged = await stageTaskCompletion(stageInput(basePath));

  assert.equal(staged.status, "committed");
  assert.deepEqual(
    row("SELECT status, completed_at FROM tasks WHERE id = 'T01'"),
    { status: "in_progress", completed_at: null },
  );
  assert.equal(existsSync(staged.summaryPath), true);
  assert.match(readFileSync(staged.summaryPath, "utf8"), /Implemented the compatibility seam/);
});

for (const fault of [
  "after-operation",
  "after-mutation",
  "after-events",
  "after-outbox",
  "after-projections",
  "before-cas",
] as const) {
  test(`stage ${fault} fault restores the exact pre-settlement snapshot`, async () => {
    const { stageTaskCompletion } = await subject();
    const { basePath } = createFixture();
    db().prepare(`
      UPDATE tasks
      SET status = 'pending', completed_at = '2026-07-12T00:05:00.000Z'
      WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
    `).run();
    const before = settlementState();
    _setDomainOperationFaultForTest(fault);

    await assert.rejects(
      stageTaskCompletion(stageInput(basePath)),
      new RegExp(`domain operation fault: ${fault}`, "i"),
    );

    assert.deepEqual(settlementState(), before);
  });
}

test("changed stage replay payload conflicts without restaging Task metadata or evidence", async () => {
  const { stageTaskCompletion } = await subject();
  const { basePath } = createFixture();
  await stageTaskCompletion(stageInput(basePath));
  const before = settlementState();
  const changed = stageInput(basePath);
  changed.completion.narrative = "A different candidate narrative must not overwrite committed staging.";
  changed.completion.verificationEvidence = [{
    command: "npm run changed-verification",
    exitCode: 0,
    verdict: "pass",
    durationMs: 50,
  }];

  await assert.rejects(stageTaskCompletion(changed), /idempotency|payload|request|conflict/i);

  assert.deepEqual(settlementState(), before);
});

test("a summary projection failure leaves the immutable Result and staged legacy state intact for replay repair", async () => {
  const { stageTaskCompletion } = await subject();
  const { basePath, attemptId } = createFixture();
  _setManagedMutationBoundaryForTest((boundary, target) => {
    if (boundary === "before-write" && target.endsWith("SUMMARY.md")) {
      throw new Error("simulated summary projection failure");
    }
  });

  await assert.rejects(stageTaskCompletion(stageInput(basePath)), /projection|summary/i);

  assert.deepEqual(row("SELECT attempt_state, settle_outcome FROM workflow_execution_attempts"), {
    attempt_state: "settled",
    settle_outcome: "succeeded",
  });
  assert.deepEqual(row("SELECT attempt_id, outcome FROM workflow_attempt_results"), {
    attempt_id: attemptId,
    outcome: "succeeded",
  });
  assert.equal(taskState().status, "in_progress");
  assert.equal(taskState().completed_at, null);
  assert.equal(count("workflow_attempt_results"), 1);
  assert.equal(count("verification_evidence"), 1);

  _setManagedMutationBoundaryForTest(null);
  const replayed = await stageTaskCompletion(stageInput(basePath));
  assert.equal(replayed.status, "replayed");
  assert.equal(replayed.attemptId, attemptId);
  assert.equal(existsSync(replayed.summaryPath), true);
  assert.equal(count("workflow_attempt_results"), 1);
  assert.equal(count("verification_evidence"), 1);
  assert.equal(taskState().status, "in_progress");
});

test("staging does not rewrite the unchanged PLAN projection", async () => {
  const { stageTaskCompletion } = await subject();
  const { basePath, planPath } = createFixture();
  writeFileSync(planPath, "# user-owned staging sentinel\n");
  _setManagedMutationBoundaryForTest((boundary, target) => {
    if (boundary === "before-write" && target === planPath) {
      throw new Error("PLAN projection must not run while staging");
    }
  });

  const staged = await stageTaskCompletion(stageInput(basePath));

  assert.equal(staged.nextStage, "verify");
  assert.equal(existsSync(staged.summaryPath), true);
  assert.equal(readFileSync(planPath, "utf8"), "# user-owned staging sentinel\n");
});

test("a newly committed settlement rejects an already-closed legacy Task", async () => {
  const { stageTaskCompletion } = await subject();
  const { basePath } = createFixture();
  db().prepare(`
    UPDATE tasks SET status = 'complete', completed_at = '2026-07-12T00:10:00.000Z'
    WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
  `).run();

  await assert.rejects(stageTaskCompletion(stageInput(basePath)), /closed|complete|replay/i);

  assert.equal(count("workflow_attempt_results"), 0);
  assert.equal(row("SELECT attempt_state FROM workflow_execution_attempts").attempt_state, "running");
});

test("verified publication alone completes the legacy Task and checks its projection", async () => {
  const { publishVerifiedTaskCompletion, stageTaskCompletion } = await subject();
  const { basePath, planPath, attemptId } = createFixture();
  const staged = await stageTaskCompletion(stageInput(basePath));
  recordPassingHostVerdict(basePath, attemptId);

  const published = await publishVerifiedTaskCompletion(publishInput(basePath, attemptId));

  assert.equal(published.status, "committed");
  assert.equal(published.attemptId, attemptId);
  assert.equal(published.summaryPath, staged.summaryPath);
  assert.equal(taskState().status, "complete");
  assert.match(String(taskState().completed_at), /\S/);
  assert.match(readFileSync(planPath, "utf8"), /\[x\][^\n]*\*\*T01/);
  assert.equal(count("workflow_attempt_results"), 1);
  assert.equal(row("SELECT outcome FROM workflow_attempt_results").outcome, "succeeded");
  assert.equal(
    row("SELECT lifecycle_status FROM workflow_item_lifecycles").lifecycle_status,
    "completed",
  );
  assert.deepEqual(
    db().prepare(`
      SELECT sequence, next_stage
      FROM workflow_kernel_checkpoints
      ORDER BY sequence
    `).all(),
    [
      { sequence: 1, next_stage: "execute" },
      { sequence: 2, next_stage: "verify" },
      { sequence: 3, next_stage: "route" },
      { sequence: 4, next_stage: "closeout" },
      { sequence: 5, next_stage: "settled" },
    ],
  );
});

test("ordinary verification and milestone validation cannot bypass exact-merged UAT closure", async () => {
  const { publishVerifiedTaskCompletion, stageTaskCompletion } = await subject();
  const { basePath, attemptId } = createFixture();
  activateExactMergedClosure(basePath);
  await stageTaskCompletion(stageInput(basePath));
  recordPassingHostVerdict(basePath, attemptId);
  db().prepare(`
    INSERT INTO assessments (
      path, milestone_id, status, scope, full_content, created_at
    ) VALUES (
      '.gsd/milestones/M001/M001-VALIDATION.md', 'M001', 'pass',
      'milestone-validation', 'Milestone validation passed.', '2026-07-12T00:03:00.000Z'
    )
  `).run();

  await assert.rejects(
    publishVerifiedTaskCompletion(publishInput(basePath, attemptId)),
    /exact-merged|gsd_uat_exec|closure dossier/i,
  );

  assert.equal(taskState().status, "in_progress");
  assert.equal(row("SELECT lifecycle_status FROM workflow_item_lifecycles").lifecycle_status, "in_progress");
});

test("exact-merged UAT evidence authorizes dossier task publication", async () => {
  const { publishVerifiedTaskCompletion, stageTaskCompletion } = await subject();
  const { basePath, attemptId } = createFixture();
  const mergeCommit = activateExactMergedClosure(basePath);
  await stageTaskCompletion(stageInput(basePath));
  recordExactMergedUatVerdict(basePath, attemptId, mergeCommit);

  const published = await publishVerifiedTaskCompletion(publishInput(basePath, attemptId));

  assert.equal(published.status, "committed");
  assert.equal(taskState().status, "complete");
  assert.equal(row("SELECT lifecycle_status FROM workflow_item_lifecycles").lifecycle_status, "completed");
});

test("verified publication atomically closes only its task gates from durable Attempt evidence", async () => {
  const { publishVerifiedTaskCompletion, stageTaskCompletion } = await subject();
  const { basePath, attemptId } = createFixture();
  db().prepare(`
    INSERT INTO tasks (milestone_id, slice_id, id, title, status, verify, sequence)
    VALUES ('M001', 'S01', 'T02', 'Sibling task', 'pending', 'npm test', 2)
  `).run();
  seedTaskQualityGates("T01", "T02");
  const completion = stageInput(basePath);
  completion.completion.failureModes = "  Dependency loss returns a retryable error.  ";
  completion.completion.loadProfile = "";
  completion.completion.negativeTests = "Malformed input and timeout paths are covered.";

  await stageTaskCompletion(completion);
  const durableOutput = JSON.parse(String(
    row("SELECT output_json FROM workflow_attempt_results").output_json,
  )) as Record<string, unknown>;
  assert.equal(durableOutput.failureModes, "  Dependency loss returns a retryable error.  ");
  assert.equal(durableOutput.loadProfile, "");
  assert.equal(durableOutput.negativeTests, "Malformed input and timeout paths are covered.");
  recordPassingHostVerdict(basePath, attemptId);

  const published = await publishVerifiedTaskCompletion(publishInput(basePath, attemptId));

  assert.equal(published.status, "committed");
  assert.deepEqual(rows(`
    SELECT gate_id, status, verdict, findings
    FROM quality_gates
    WHERE task_id = 'T01'
    ORDER BY gate_id
  `), [
    {
      gate_id: "Q5",
      status: "complete",
      verdict: "pass",
      findings: "Dependency loss returns a retryable error.",
    },
    { gate_id: "Q6", status: "complete", verdict: "omitted", findings: "" },
    {
      gate_id: "Q7",
      status: "complete",
      verdict: "pass",
      findings: "Malformed input and timeout paths are covered.",
    },
  ]);
  assert.deepEqual(
    rows(`SELECT gate_id, status FROM quality_gates WHERE task_id = 'T02' ORDER BY gate_id`),
    [
      { gate_id: "Q5", status: "pending" },
      { gate_id: "Q6", status: "pending" },
      { gate_id: "Q7", status: "pending" },
    ],
  );
  assert.equal(count("gate_runs"), 3);
  const beforeReplay = {
    gates: rows("SELECT * FROM quality_gates ORDER BY task_id, gate_id"),
    gateRuns: rows("SELECT * FROM gate_runs ORDER BY id"),
  };

  const replayed = await publishVerifiedTaskCompletion(publishInput(basePath, attemptId));
  assert.equal(replayed.status, "replayed");
  assert.deepEqual({
    gates: rows("SELECT * FROM quality_gates ORDER BY task_id, gate_id"),
    gateRuns: rows("SELECT * FROM gate_runs ORDER BY id"),
  }, beforeReplay);
});

for (const mutation of ["tracked", "untracked"] as const) {
  test(`verified publication rejects ${mutation} source mutation after host verification`, async () => {
    const { publishVerifiedTaskCompletion, stageTaskCompletion } = await subject();
    const { basePath, attemptId } = createFixture();
    await stageTaskCompletion(stageInput(basePath));
    recordPassingHostVerdict(basePath, attemptId);
    const path = mutation === "tracked" ? "tracked.txt" : "untracked.txt";
    writeFileSync(join(basePath, path), "changed after verification\n");

    await assert.rejects(
      publishVerifiedTaskCompletion(publishInput(basePath, attemptId)),
      /source|revision|verification/i,
    );

    assert.equal(taskState().status, "in_progress");
    assert.equal(row("SELECT lifecycle_status FROM workflow_item_lifecycles").lifecycle_status, "in_progress");
  });
}

test("verified publication rejects a passing verdict when verify is no longer the current Kernel head", async () => {
  const { publishVerifiedTaskCompletion, stageTaskCompletion } = await subject();
  const { basePath, attemptId } = createFixture();
  await stageTaskCompletion(stageInput(basePath));
  recordPassingHostVerdict(basePath, attemptId);
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.route-after-verification",
    idempotencyKey: "test/task-completion/route-after-verification",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { attemptId },
  }, (context) => {
    const scope = row(`
      SELECT attempt.lifecycle_id, checkpoint.kernel_checkpoint_id
      FROM workflow_execution_attempts attempt
      JOIN workflow_kernel_checkpoints checkpoint
        ON checkpoint.attempt_id = attempt.attempt_id
      WHERE attempt.attempt_id = '${attemptId.replaceAll("'", "''")}'
        AND checkpoint.next_stage = 'verify'
    `);
    appendKernelCheckpoint(context, {
      lifecycleId: String(scope.lifecycle_id),
      attemptId,
      nextStage: "route",
      previousKernelCheckpointId: String(scope.kernel_checkpoint_id),
    });
    return {
      events: [{
        eventType: "test.route-after-verification",
        entityType: "task",
        entityId: "M001/S01/T01",
        payload: { attemptId },
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: "test/task-completion/route-after-verification",
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });

  await assert.rejects(
    publishVerifiedTaskCompletion(publishInput(basePath, attemptId)),
    /verify|verdict|evidence|publish/i,
  );
  assert.equal(taskState().status, "in_progress");
  assert.equal(row("SELECT lifecycle_status FROM workflow_item_lifecycles").lifecycle_status, "in_progress");
});

test("a failed host verdict cannot be replaced with pass or published", async () => {
  const { publishVerifiedTaskCompletion, stageTaskCompletion } = await subject();
  const { basePath, attemptId } = createFixture();
  await stageTaskCompletion(stageInput(basePath));
  recordFailingHostVerdict(basePath, attemptId);

  assert.throws(
    () => recordPassingHostVerdict(basePath, attemptId),
    /already|one|verdict|verified|verify stage/i,
  );
  await assert.rejects(
    publishVerifiedTaskCompletion(publishInput(basePath, attemptId)),
    /verify|verdict|evidence|publish/i,
  );
  assert.equal(taskState().status, "in_progress");
  assert.equal(taskState().completed_at, null);
  assert.equal(row("SELECT lifecycle_status FROM workflow_item_lifecycles").lifecycle_status, "in_progress");
  assert.equal(count("workflow_technical_verdicts"), 1);
  assert.equal(row("SELECT verdict FROM workflow_technical_verdicts").verdict, "fail");
});

test("superseding the host criterion invalidates its old passing verdict for publication", async () => {
  const { publishVerifiedTaskCompletion, stageTaskCompletion } = await subject();
  const { basePath, attemptId } = createFixture();
  await stageTaskCompletion(stageInput(basePath));
  recordPassingHostVerdict(basePath, attemptId);
  const criterionId = String(row(`
    SELECT criterion_id FROM workflow_acceptance_criteria
    WHERE criterion_key = 'host-technical-verification'
  `).criterion_id);
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.supersede-host-criterion",
    idempotencyKey: "test/task-completion/supersede-host-criterion",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { attemptId, criterionId },
  }, (context) => {
    db().prepare(`
      INSERT INTO workflow_acceptance_criteria (
        criterion_id, criterion_key, project_id, lifecycle_id, requirement_id,
        criterion_kind, evidence_class, required, description,
        supersedes_criterion_id, created_at, operation_id,
        project_revision, authority_epoch
      )
      SELECT
        'host-technical-verification-v2', criterion_key, project_id, lifecycle_id,
        requirement_id, criterion_kind, evidence_class, required,
        'Updated host-owned technical verification policy.', criterion_id,
        '2026-07-12T00:03:00.000Z', :operation_id, :project_revision, :authority_epoch
      FROM workflow_acceptance_criteria
      WHERE criterion_id = :criterion_id
    `).run({
      ":operation_id": context.operationId,
      ":project_revision": context.resultingRevision,
      ":authority_epoch": context.resultingAuthorityEpoch,
      ":criterion_id": criterionId,
    });
    return {
      events: [{
        eventType: "test.host-criterion.superseded",
        entityType: "task",
        entityId: "M001/S01/T01",
        payload: { attemptId, criterionId },
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: "test/task-completion/host-criterion-v2",
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });

  await assert.rejects(
    publishVerifiedTaskCompletion(publishInput(basePath, attemptId)),
    /verify|verdict|evidence|publish/i,
  );
  assert.equal(taskState().status, "in_progress");
  assert.equal(taskState().completed_at, null);
  assert.equal(row("SELECT lifecycle_status FROM workflow_item_lifecycles").lifecycle_status, "in_progress");
});

test("a publish fault rolls canonical closeout and legacy completion back together", async () => {
  const { publishVerifiedTaskCompletion, stageTaskCompletion } = await subject();
  const { basePath, attemptId } = createFixture();
  seedTaskQualityGates("T01");
  await stageTaskCompletion(stageInput(basePath));
  recordPassingHostVerdict(basePath, attemptId);
  _setDomainOperationFaultForTest("after-mutation");

  await assert.rejects(
    publishVerifiedTaskCompletion(publishInput(basePath, attemptId)),
    /domain operation fault/i,
  );

  assert.equal(taskState().status, "in_progress");
  assert.equal(taskState().completed_at, null);
  assert.equal(
    row("SELECT lifecycle_status FROM workflow_item_lifecycles").lifecycle_status,
    "in_progress",
  );
  assert.deepEqual(
    db().prepare("SELECT sequence, next_stage FROM workflow_kernel_checkpoints ORDER BY sequence").all()
      .map((checkpoint) => ({ ...checkpoint })),
    [
      { sequence: 1, next_stage: "execute" },
      { sequence: 2, next_stage: "verify" },
    ],
  );
  assert.deepEqual(
    rows("SELECT gate_id, status FROM quality_gates ORDER BY gate_id"),
    [
      { gate_id: "Q5", status: "pending" },
      { gate_id: "Q6", status: "pending" },
      { gate_id: "Q7", status: "pending" },
    ],
  );
  assert.equal(count("gate_runs"), 0);

  _setDomainOperationFaultForTest(null);
  const published = await publishVerifiedTaskCompletion(publishInput(basePath, attemptId));
  assert.equal(published.status, "committed");
  assert.equal(taskState().status, "complete");
  assert.equal(count("gate_runs"), 3);
});

test("exact stage and publication replay repair projections without duplicate facts", async () => {
  const { publishVerifiedTaskCompletion, stageTaskCompletion } = await subject();
  const { basePath, planPath, attemptId } = createFixture();
  const staged = await stageTaskCompletion(stageInput(basePath));
  recordPassingHostVerdict(basePath, attemptId);
  const published = await publishVerifiedTaskCompletion(publishInput(basePath, attemptId));
  const beforeReplay = {
    revision: row("SELECT revision FROM project_authority").revision,
    operations: count("workflow_operations"),
    results: count("workflow_attempt_results"),
    evidence: count("verification_evidence"),
    task: taskState(),
    summary: readFileSync(staged.summaryPath, "utf8"),
    plan: readFileSync(planPath, "utf8"),
  };
  unlinkSync(staged.summaryPath);
  unlinkSync(planPath);

  const stagedReplay = await stageTaskCompletion(stageInput(basePath));
  const publishedReplay = await publishVerifiedTaskCompletion(publishInput(basePath, attemptId));

  assert.deepEqual(stagedReplay, { ...staged, status: "replayed" });
  assert.deepEqual(publishedReplay, { ...published, status: "replayed" });
  assert.deepEqual({
    revision: row("SELECT revision FROM project_authority").revision,
    operations: count("workflow_operations"),
    results: count("workflow_attempt_results"),
    evidence: count("verification_evidence"),
    task: taskState(),
    summary: readFileSync(staged.summaryPath, "utf8"),
    plan: readFileSync(planPath, "utf8"),
  }, beforeReplay);
});

test("auto publication replays a committed Task completion after PLAN projection failure", async () => {
  const { publishVerifiedTaskCompletion, stageTaskCompletion } = await subject();
  const { publishVerifiedTaskExecution } = await import("../auto/task-execution-cutover.js");
  const { basePath, planPath, attemptId } = createFixture();
  await stageTaskCompletion(stageInput(basePath));
  recordPassingHostVerdict(basePath, attemptId);
  _setManagedMutationBoundaryForTest((boundary, target) => {
    if (boundary === "before-write" && target.endsWith("PLAN.md")) {
      throw new Error("simulated PLAN projection failure");
    }
  });
  const input = {
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    workerId: "worker-1",
    traceId: "trace-1",
    turnId: "turn-1",
    basePath,
  };
  const dependencies = { readLatestTaskAttempt, publishVerifiedTaskCompletion };

  await assert.rejects(
    publishVerifiedTaskExecution(input, dependencies),
    /PLAN projection failed/i,
  );
  assert.equal(taskState().status, "complete");
  assert.equal(
    readLatestTaskAttempt(TASK)?.nextStage,
    "settled",
    "the publication operation committed before the projection failed",
  );
  assert.match(readFileSync(planPath, "utf8"), /\[ \][^\n]*\*\*T01/);
  const beforeReplay = {
    revision: row("SELECT revision FROM project_authority").revision,
    operations: count("workflow_operations"),
    checkpoints: count("workflow_kernel_checkpoints"),
  };

  _setManagedMutationBoundaryForTest(null);
  await publishVerifiedTaskExecution(input, dependencies);

  assert.match(readFileSync(planPath, "utf8"), /\[x\][^\n]*\*\*T01/i);
  assert.deepEqual({
    revision: row("SELECT revision FROM project_authority").revision,
    operations: count("workflow_operations"),
    checkpoints: count("workflow_kernel_checkpoints"),
  }, beforeReplay);
});

test("#1973: attempt-gate rejection names the settled outcome and recovery lever; blocker reports bypass the gate", () => {
  const { attemptId } = createFixture();
  const settlement = settleTaskAttempt({
    invocation: invocation("task-completion/settle-provider-failure"),
    attemptId,
    outcome: "failed",
    failureClass: "provider",
    summary: "Provider error: : Request timed out.",
    output: {},
  });
  const routed = recordFailureAndSelectRecovery({
    invocation: invocation("task-completion/route-provider-failure"),
    attemptId,
    resultId: settlement.resultId,
    owner: "agent",
    classification: { failureKind: "fatal" },
    summary: "supervisor tore down the attempt on a provider timeout",
    evidence: { source: "agent-end-recovery" },
    rationale: "provider error classified as terminal",
  });

  assert.throws(
    () => resolveTaskCompletionAuthority(TASK),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.match(message, /no running Attempt/);
      assert.ok(message.includes(attemptId), "gate error must name the settled Attempt");
      assert.match(message, /outcome=failed/);
      assert.match(message, /failureClass=provider/);
      assert.ok(
        message.includes(routed.recoveryActionId),
        "gate error must surface the recorded recovery action id",
      );
      return true;
    },
  );

  assert.equal(
    resolveTaskCompletionAuthority(TASK, undefined, { blockerReport: true }),
    "legacy",
    "blockerDiscovered reports must route to the legacy durable write instead of dead-ending on the gate",
  );
});

test("settled remediate recovery resumes through a fresh verified completion", async () => {
  const { publishVerifiedTaskCompletion, stageTaskCompletion } = await subject();
  const { basePath, attemptId } = createFixture();
  const settlement = await stageTaskCompletion(stageInput(basePath));
  recordFailingHostVerdict(basePath, attemptId);
  const routed = recordFailureAndSelectRecovery({
    invocation: invocation("task-completion/route-remediation"),
    attemptId,
    resultId: settlement.resultId,
    owner: "agent",
    classification: { failureKind: "verification-failed" },
    summary: "Host verification needs remediation after the implementation completed.",
    evidence: { command: "node --test", exitCode: 1, verdict: "FAIL" },
    rationale: "Apply and verify the remediation before continuing.",
  });
  assert.equal(routed.action, "remediate");

  assert.throws(
    () => resolveTaskCompletionAuthority(TASK),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.match(message, /no running Attempt/);
      assert.ok(message.includes(routed.recoveryActionId));
      assert.match(message, /\(remediate\).*gsd_task_recovery_resume/i);
      return true;
    },
  );

  resumeTaskRecovery({
    invocation: invocation("task-completion/resume-remediation"),
    recoveryActionId: routed.recoveryActionId,
    repairSummary: "Applied the host-verification remediation and confirmed the source is ready.",
    evidence: { command: "node --test", exitCode: 0, verdict: "PASS" },
  });
  assert.throws(
    () => resolveTaskCompletionAuthority(TASK),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.match(message, /already authorizes its successor/i);
      assert.match(message, /rerun `\/gsd auto`/i);
      assert.doesNotMatch(message, /call gsd_task_recovery_resume/i);
      return true;
    },
  );

  db().prepare(`
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES (
      'trace-dispatch-2', 'turn-dispatch-2', 'worker-1', 7,
      'M001', 'S01', 'T01', 'execute-task', 'M001/S01/T01',
      'claimed', 2, '2026-07-12T00:10:00.000Z'
    )
  `).run();
  const successor = claimTaskAttempt({
    invocation: invocation("task-completion/remediation-successor-claim"),
    task: TASK,
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: Number(row("SELECT MAX(id) AS id FROM unit_dispatches").id),
    retryOfAttemptId: attemptId,
  });
  const retryInput = stageInput(basePath);
  retryInput.invocation = invocation("task-completion/remediation-successor-stage");
  await stageTaskCompletion(retryInput);
  recordPassingHostVerdict(basePath, successor.attemptId);
  const published = await publishVerifiedTaskCompletion({
    ...publishInput(basePath, successor.attemptId),
    invocation: invocation("task-completion/remediation-successor-publish"),
  });

  assert.equal(published.status, "committed");
  assert.equal(taskState().status, "complete");
});
