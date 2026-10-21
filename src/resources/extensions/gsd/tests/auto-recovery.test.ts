// Project/App: gsd-pi
// File Purpose: Tests auto-mode artifact verification and recovery behavior.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import { verifyExpectedArtifact, hasImplementationArtifacts, resolveExpectedArtifactPath, diagnoseExpectedArtifact, diagnoseWorktreeIntegrityFailure, buildLoopRemediationSteps, writeBlockerPlaceholder, refreshRecoveryDbForArtifact, writeReactiveExecuteBlocker } from "../auto-recovery.ts";
import { resolveMilestoneFile } from "../paths.ts";
import { _getAdapter, openDatabase, closeDatabase, insertMilestone, insertSlice, insertGateRow, insertTask, insertAssessment, getMilestone, getMilestoneCommitAttributionShas, getPlanMilestoneRecoveryBlock, getTask, getSlice, saveGateResult, updateMilestoneStatus } from "../gsd-db.ts";
import { claimTaskAttempt, settleTaskAttempt } from "../task-execution-domain-operation.ts";
import { recordFailureAndSelectRecovery } from "../task-recovery-domain-operation.ts";
import { internalExecutionInvocation } from "../execution-invocation.ts";
import { readEvents } from "../workflow-events.ts";
import { executeDomainOperation } from "../db/domain-operation.ts";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
  type CanonicalLifecycleStatus,
  type LifecycleIdentity,
} from "../db/writers/lifecycle-commands.ts";
import { clearParseCache } from "../files.ts";
import { invalidateAllCaches } from "../cache.ts";
import { deriveState, invalidateStateCache } from "../state.ts";
import { writeIntegrationBranch } from "../git-service.ts";
import { loadSyncMapping } from "../../github-sync/mapping.ts";
import {
  _resetConfigCache,
  _setGhCloseOverridesForTest,
} from "../../github-sync/sync.ts";
import {
  _resetGhCache,
  _setGhAvailableForTest,
  _setGhRateLimitOkForTest,
} from "../../github-sync/cli.ts";

const tmpDirs: string[] = [];

function makeTmpBase(): string {
  const base = join(tmpdir(), `gsd-test-${randomUUID()}`);
  // Create .gsd/milestones/M001/slices/S01/tasks/ structure
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  closeDatabase();
  try { rmSync(base, { recursive: true, force: true }); } catch { /* */ }
}

/**
 * Open a DB under `base` and seed milestone M001 with the given slice rows.
 * Slice state is DB-authoritative (ADR-017), so verification fixtures that
 * exercise artifact/path resolution still need the rows to exist.
 */
function seedMilestoneSlices(base: string, slices: Array<{ id: string; status: string }>): void {
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
  for (const slice of slices) {
    insertSlice({
      milestoneId: "M001",
      id: slice.id,
      title: `${slice.id} Slice`,
      status: slice.status,
      risk: "low",
      depends: [],
    });
  }
}

function makeTmpProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "auto-recovery-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  openDatabase(join(dir, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
  insertSlice({
    milestoneId: "M001",
    id: "S01",
    title: "Test Slice",
    status: "pending",
    risk: "low",
    depends: [],
  });
  insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q3", scope: "slice" });
  tmpDirs.push(dir);
  return dir;
}

function seedCanonicalTaskAttempt(
  outcome?: "succeeded" | "failed",
): { attemptId: string; resultId: string | undefined } {
  const db = _getAdapter();
  assert.ok(db);
  db.exec(`
    INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status,
      project_root_realpath
    ) VALUES (
      'recovery-worker', 'test-host', 1, '2026-07-13T00:00:00.000Z', 'test',
      '2026-07-13T00:00:00.000Z', 'active', '/tmp/project'
    );
    INSERT INTO milestone_leases (
      milestone_id, worker_id, fencing_token, acquired_at, expires_at, status
    ) VALUES (
      'M001', 'recovery-worker', 7, '2026-07-13T00:00:00.000Z',
      '2099-07-13T00:00:00.000Z', 'held'
    );
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES (
      'trace-recovery', 'turn-recovery', 'recovery-worker', 7,
      'M001', 'S01', 'T01', 'execute-task', 'M001/S01/T01',
      'claimed', 1, '2026-07-13T00:00:00.000Z'
    );
  `);
  const dispatch = db.prepare("SELECT id FROM unit_dispatches WHERE trace_id = 'trace-recovery'").get();
  const claim = claimTaskAttempt({
    invocation: internalExecutionInvocation("test:artifact-recovery:claim"),
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    workerId: "recovery-worker",
    milestoneLeaseToken: 7,
    coordinationDispatchId: Number(dispatch?.["id"]),
  });
  let resultId: string | undefined;
  if (outcome) {
    resultId = settleTaskAttempt({
      invocation: internalExecutionInvocation(`test:artifact-recovery:settle:${outcome}`),
      attemptId: claim.attemptId,
      outcome,
      failureClass: outcome === "succeeded" ? "none" : "executor-failed",
      summary: `executor ${outcome}`,
      output: {},
    }).resultId;
  }
  return { attemptId: claim.attemptId, resultId };
}

function runGit(base: string, args: string[]): void {
  execFileSync("git", args, { cwd: base, stdio: ["ignore", "pipe", "pipe"] });
}

function makeCompleteMilestoneRecoveryProject(): string {
  const base = mkdtempSync(join(tmpdir(), "auto-recovery-adopted-complete-ms-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  tmpDirs.push(base);
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({
    milestoneId: "M001",
    id: "S01",
    title: "Done Slice",
    status: "complete",
    risk: "low",
    depends: [],
  });
  insertTask({
    milestoneId: "M001",
    sliceId: "S01",
    id: "T01",
    title: "Done Task",
    status: "complete",
  });
  insertAssessment({
    path: ".gsd/milestones/M001/M001-VALIDATION.md",
    milestoneId: "M001",
    status: "pass",
    scope: "milestone-validation",
    fullContent: "---\nverdict: pass\n---\n",
  });
  writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-SUMMARY.md"), "# Complete-looking projection\n");
  writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-VALIDATION.md"), "---\nverdict: pass\n---\n");
  runGit(base, ["init", "-b", "main"]);
  runGit(base, ["config", "user.email", "test@example.com"]);
  runGit(base, ["config", "user.name", "Test User"]);
  writeFileSync(join(base, "README.md"), "# base\n");
  runGit(base, ["add", "README.md"]);
  runGit(base, ["commit", "-m", "init"]);
  runGit(base, ["checkout", "-b", "milestone/M001"]);
  writeFileSync(join(base, "feature.ts"), "export const shipped = true;\n");
  runGit(base, ["add", "feature.ts"]);
  runGit(base, ["commit", "-m", "feat: implementation evidence"]);
  return base;
}

function completeAdoptedMilestoneReceipt(receiptShape: "full" | "projection-only"): string {
  const completedAt = "2026-07-14T12:00:00.000Z";
  const fence = readDomainOperationFence();
  const operation = executeDomainOperation({
    operationType: "milestone.complete",
    idempotencyKey: "test:auto-recovery:milestone-complete",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { milestoneId: "M001" },
  }, (context) => {
    updateMilestoneStatus("M001", "complete", completedAt);
    const lifecycle = adoptOrTransitionLifecycle(context, {
      itemKind: "milestone",
      milestoneId: "M001",
      lifecycleStatus: "completed",
      adoptedFromStatus: "completed",
    });
    return {
      events: [{
        eventType: "milestone.completed",
        entityType: "milestone",
        entityId: "M001",
        payload: {
          milestoneLifecycleId: lifecycle.lifecycleId,
          completedAt,
          ...(receiptShape === "full" ? {
            validationEventId: "validation-event-M001",
            validationRevision: 1,
            completedSliceIds: ["S01"],
            cancelledSliceIds: [],
            completedTaskIds: ["T01"],
            cancelledTaskIds: [],
            waiverIds: [],
            dispositionIds: [],
          } : {}),
          closeout: {
            title: "Milestone",
            oneLiner: "Complete",
            narrative: "Completed through a durable receipt.",
            successCriteriaResults: "Passed.",
            definitionOfDoneResults: "Passed.",
            requirementOutcomes: "Passed.",
            keyDecisions: [],
            keyFiles: [],
            lessonsLearned: [],
            followUps: "",
            deviations: "",
          },
        },
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: "lifecycle/m001",
        projectionKind: "milestone-lifecycle",
        rendererVersion: "1",
      }],
    };
  });
  return operation.operationId;
}

function completeAdoptedMilestoneWithReceipt(): string {
  return completeAdoptedMilestoneReceipt("full");
}

function completeAdoptedMilestoneWithMalformedReceipt(): string {
  return completeAdoptedMilestoneReceipt("projection-only");
}

function milestoneLifecycleHead(): {
  lifecycleStatus: string;
  lastOperationId: string;
} {
  const row = _getAdapter()!.prepare(`
    SELECT lifecycle_status, last_operation_id
    FROM workflow_item_lifecycles
    WHERE item_kind = 'milestone' AND milestone_id = 'M001'
      AND slice_id IS NULL AND task_id IS NULL
  `).get();
  assert.ok(row, "canonical Milestone lifecycle fixture must exist");
  return {
    lifecycleStatus: String(row["lifecycle_status"]),
    lastOperationId: String(row["last_operation_id"]),
  };
}

afterEach(() => {
  closeDatabase();
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }
  tmpDirs.length = 0;
});

test("resolveExpectedArtifactPath returns correct path for execute-task", () => {
  const base = makeTmpBase();
  try {
    const result = resolveExpectedArtifactPath("execute-task", "M001/S01/T01", base);
    assert.ok(result);
    assert.ok(result!.includes("tasks"));
    assert.ok(result!.includes("SUMMARY"));
  } finally {
    cleanup(base);
  }
});

test("resolveExpectedArtifactPath returns correct path for complete-slice", () => {
  const base = makeTmpBase();
  try {
    const result = resolveExpectedArtifactPath("complete-slice", "M001/S01", base);
    assert.ok(result);
    assert.ok(result!.includes("SUMMARY"));
  } finally {
    cleanup(base);
  }
});

test("resolveExpectedArtifactPath returns correct path for plan-slice", () => {
  const base = makeTmpBase();
  try {
    const result = resolveExpectedArtifactPath("plan-slice", "M001/S01", base);
    assert.ok(result);
    assert.ok(result!.includes("PLAN"));
  } finally {
    cleanup(base);
  }
});

test("plan-slice artifact resolution handles lowercase unit IDs against uppercase paths", () => {
  const base = makeTmpBase();
  try {
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    const tasksDir = join(sliceDir, "tasks");
    writeFileSync(join(sliceDir, "S01-PLAN.md"), [
      "# S01: Test Slice",
      "",
      "## Tasks",
      "",
      "- [ ] **T01: Implement feature** `est:1h`",
    ].join("\n"));
    writeFileSync(join(tasksDir, "T01-PLAN.md"), "# T01 Plan");

    const artifactPath = resolveExpectedArtifactPath("plan-slice", "m001/s01", base);
    assert.ok(
      artifactPath?.endsWith(".gsd/milestones/M001/slices/S01/S01-PLAN.md"),
      "lowercase unit IDs should resolve to the existing uppercase artifact path",
    );

    const diagnostic = diagnoseExpectedArtifact("plan-slice", "m001/s01", base);
    assert.ok(
      diagnostic?.includes(".gsd/milestones/M001/slices/S01/S01-PLAN.md"),
      "diagnostic should report the existing uppercase artifact path",
    );
    assert.ok(
      diagnostic?.includes("task plans"),
      "diagnostic should mention task plans because slice plan alone is insufficient",
    );

    assert.equal(
      verifyExpectedArtifact("plan-slice", "m001/s01", base),
      true,
      "verification should pass when the uppercase slice plan and task plans exist",
    );
  } finally {
    cleanup(base);
  }
});

test("plan-slice verification accepts artifacts rendered in the live milestone worktree", () => {
  const base = makeTmpBase();
  try {
    const rootSlicePlan = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md");
    rmSync(rootSlicePlan, { force: true });

    const worktree = join(base, ".gsd", "worktrees", "M001");
    const worktreeSliceDir = join(worktree, ".gsd", "milestones", "M001", "slices", "S01");
    const worktreeTasksDir = join(worktreeSliceDir, "tasks");
    mkdirSync(worktreeTasksDir, { recursive: true });
    writeFileSync(join(worktree, ".git"), "gitdir: ../../../../.git/worktrees/M001\n", "utf-8");
    writeFileSync(join(worktreeSliceDir, "S01-PLAN.md"), [
      "# S01: Test Slice",
      "",
      "## Tasks",
      "",
      "- [ ] **T01: Implement feature** `est:1h`",
    ].join("\n"));
    writeFileSync(join(worktreeTasksDir, "T01-PLAN.md"), "# T01 Plan");

    assert.equal(
      verifyExpectedArtifact("plan-slice", "M001/S01", base),
      true,
      "verification should use the live worktree projection when project-root markdown is stale",
    );
  } finally {
    cleanup(base);
  }
});

test("complete-slice verification accepts artifacts rendered in the project root while a live worktree exists", () => {
  const base = makeTmpBase();
  try {
    const milestoneDir = join(base, ".gsd", "milestones", "M001");
    const sliceDir = join(milestoneDir, "slices", "S01");
    writeFileSync(join(milestoneDir, "M001-ROADMAP.md"), [
      "# M001: Test",
      "",
      "## Slices",
      "",
      "- [x] **S01: Test Slice** `risk:low` `depends:[]`",
      "  > After this: done",
    ].join("\n"));
    writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "# S01 Summary\nDone.");
    writeFileSync(join(sliceDir, "S01-UAT.md"), "# S01 UAT\nPass.");
    seedMilestoneSlices(base, [{ id: "S01", status: "complete" }]);

    const worktree = join(base, ".gsd", "worktrees", "M001");
    mkdirSync(join(worktree, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
    writeFileSync(join(worktree, ".git"), "gitdir: ../../../../.git/worktrees/M001\n", "utf-8");

    assert.equal(
      verifyExpectedArtifact("complete-slice", "M001/S01", base),
      true,
      "verification should accept project-root slice summary/UAT artifacts when the live worktree projection is stale",
    );
  } finally {
    cleanup(base);
  }
});

test("validate-milestone verification accepts project-root VALIDATION while a live worktree exists", () => {
  const base = makeTmpBase();
  try {
    const milestoneDir = join(base, ".gsd", "milestones", "M001");
    writeFileSync(join(milestoneDir, "M001-VALIDATION.md"), "---\nverdict: pass\n---\n# Validation\nPass.");

    const worktree = join(base, ".gsd", "worktrees", "M001");
    mkdirSync(join(worktree, ".gsd", "milestones", "M001"), { recursive: true });
    writeFileSync(join(worktree, ".git"), "gitdir: ../../../../.git/worktrees/M001\n", "utf-8");

    assert.equal(
      verifyExpectedArtifact("validate-milestone", "M001", base),
      true,
      "verification should accept project-root validation artifacts when the live worktree projection is stale",
    );
  } finally {
    cleanup(base);
  }
});

test("resolveExpectedArtifactPath returns null for unknown type", () => {
  const base = makeTmpBase();
  try {
    const result = resolveExpectedArtifactPath("unknown-type", "M001", base);
    assert.equal(result, null);
  } finally {
    cleanup(base);
  }
});

test("diagnoseWorktreeIntegrityFailure reports missing GSD worktree paths only", () => {
  const missingWorktreePath = join(tmpdir(), `gsd-test-${randomUUID()}`, ".gsd", "worktrees", "M001-S01");
  assert.equal(
    diagnoseWorktreeIntegrityFailure(join(tmpdir(), `gsd-test-${randomUUID()}`)),
    null,
    "non-GSD paths should keep falling through to artifact recovery",
  );
  assert.equal(
    diagnoseWorktreeIntegrityFailure(missingWorktreePath),
    `Worktree integrity failure: ${missingWorktreePath} does not exist. Repair or recreate the worktree before retrying.`,
    "missing GSD worktree paths should fail terminally before artifact retry",
  );
});

test("resolveExpectedArtifactPath returns correct path for all milestone-level types", () => {
  const base = makeTmpBase();
  try {
    const planResult = resolveExpectedArtifactPath("plan-milestone", "M001", base);
    assert.ok(planResult);
    assert.ok(planResult!.includes("ROADMAP"));

    const completeResult = resolveExpectedArtifactPath("complete-milestone", "M001", base);
    assert.ok(completeResult);
    assert.ok(completeResult!.includes("SUMMARY"));
  } finally {
    cleanup(base);
  }
});

test("resolveExpectedArtifactPath returns correct path for all slice-level types", () => {
  const base = makeTmpBase();
  try {
    const researchResult = resolveExpectedArtifactPath("research-slice", "M001/S01", base);
    assert.ok(researchResult);
    assert.ok(researchResult!.includes("RESEARCH"));

    const assessResult = resolveExpectedArtifactPath("reassess-roadmap", "M001/S01", base);
    assert.ok(assessResult);
    assert.ok(assessResult!.includes("ASSESSMENT"));

    const uatResult = resolveExpectedArtifactPath("run-uat", "M001/S01", base);
    assert.ok(uatResult);
    assert.ok(uatResult!.includes("ASSESSMENT"));
  } finally {
    cleanup(base);
  }
});

test("refreshRecoveryDbForArtifact reports unsupported unit recovery as read-only (#1662)", () => {
  const units = [
    ["research-slice", "M001/S01"],
    ["validate-milestone", "M001"],
    ["plan-milestone", "M001"],
    ["complete-slice", "M001/S01"],
    ["run-uat", "M001/S01"],
  ] as const;

  for (const [unitType, unitId] of units) {
    assert.deepEqual(
      refreshRecoveryDbForArtifact(unitType, unitId, process.cwd()),
      {
        ok: true,
        advanced: false,
        reason: `${unitType}-attempt-read-only-verified`,
        message: `artifact verified on disk for ${unitType} ${unitId} (no DB write)`,
      },
    );
  }
});

test("refreshRecoveryDbForArtifact treats missing execute-task DB rows as fatal mismatches", () => {
  makeTmpProject();

  const result = refreshRecoveryDbForArtifact("execute-task", "M001/S01/T01", process.cwd());

  assert.deepEqual(result, {
    ok: false,
    fatal: true,
    reason: "execute-task-artifact-db-missing",
    message: "Stuck recovery found execute-task M001/S01/T01 artifacts, but no matching DB task row exists.",
  });
});

test("refreshRecoveryDbForArtifact does not report execute-task recovery success without a DB", () => {
  closeDatabase();
  assert.deepEqual(
    refreshRecoveryDbForArtifact("execute-task", "M001/S01/T01", process.cwd()),
    {
      ok: false,
      fatal: false,
      reason: "execute-task-attempt-db-unavailable",
      message: "Stuck recovery cannot confirm canonical Task Attempt readiness for execute-task M001/S01/T01 because the workflow DB is unavailable.",
    },
  );
});

test("refreshRecoveryDbForArtifact rejects a Task row without an actionable Attempt Result", () => {
  const dir = makeTmpProject();
  insertTask({
    milestoneId: "M001",
    sliceId: "S01",
    id: "T01",
    title: "Stuck Task",
    status: "pending",
  });
  const sliceDir = join(dir, ".gsd", "milestones", "M001", "slices", "S01");
  mkdirSync(sliceDir, { recursive: true });
  writeFileSync(join(sliceDir, "S01-PLAN.md"), [
    "# S01 Plan",
    "",
    "- [ ] **T01: Implement feature** `est:1h`",
    "",
  ].join("\n"));

  const result = refreshRecoveryDbForArtifact("execute-task", "M001/S01/T01", dir);

  assert.deepEqual(result, {
    ok: false,
    fatal: true,
    reason: "execute-task-attempt-not-actionable",
    message: "Stuck recovery found execute-task M001/S01/T01 artifacts, but its latest canonical Task Attempt has no actionable verify or route Result.",
  });
  assert.equal(getTask("M001", "S01", "T01")?.status, "pending");
  const planContent = readFileSync(join(sliceDir, "S01-PLAN.md"), "utf-8");
  assert.ok(planContent.includes("[ ] **T01:"), "projection must remain non-authoritative");
  const events = readEvents(join(dir, ".gsd", "event-log.jsonl"));
  assert.equal(events.some((event) => event.cmd === "complete-task"), false);
});

test("refreshRecoveryDbForArtifact does not mistake an unreadable projection for canonical recovery", () => {
  const dir = makeTmpProject();
  insertTask({
    milestoneId: "M001",
    sliceId: "S01",
    id: "T01",
    title: "Stuck Task",
    status: "pending",
  });
  const sliceDir = join(dir, ".gsd", "milestones", "M001", "slices", "S01");
  mkdirSync(sliceDir, { recursive: true });
  // Make the expected plan path a directory so the best-effort checkbox
  // rewrite (readFileSync) throws EISDIR after the DB row is already promoted.
  mkdirSync(join(sliceDir, "S01-PLAN.md"), { recursive: true });

  const result = refreshRecoveryDbForArtifact("execute-task", "M001/S01/T01", dir);

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "execute-task-attempt-not-actionable");
  assert.equal(getTask("M001", "S01", "T01")?.status, "pending");
  const events = readEvents(join(dir, ".gsd", "event-log.jsonl"));
  assert.equal(events.some((event) => event.cmd === "complete-task"), false);
});

test("refreshRecoveryDbForArtifact accepts canonical verify and route Result heads", () => {
  const first = makeTmpProject();
  insertTask({ milestoneId: "M001", sliceId: "S01", id: "T01", title: "Task", status: "pending" });
  seedCanonicalTaskAttempt("succeeded");
  assert.equal(
    verifyExpectedArtifact("execute-task", "M001/S01/T01", first),
    true,
    "a succeeded Result at verify is sufficient without SUMMARY or PLAN projections",
  );
  // #1622: acceptance is read-only — the task row is never written here, so the
  // result must say so instead of passing for a DB refresh.
  assert.deepEqual(
    refreshRecoveryDbForArtifact("execute-task", "M001/S01/T01", first),
    {
      ok: true,
      advanced: false,
      reason: "execute-task-attempt-read-only-verified",
      message: "canonical Task Attempt verified at the verify stage (no DB write)",
    },
  );
  assert.equal(getTask("M001", "S01", "T01")?.status, "pending", "recovery must not advance the task row");

  closeDatabase();
  const second = makeTmpProject();
  insertTask({ milestoneId: "M001", sliceId: "S01", id: "T01", title: "Task", status: "complete" });
  seedCanonicalTaskAttempt("failed");
  assert.equal(
    verifyExpectedArtifact("execute-task", "M001/S01/T01", second),
    true,
    "a failed Result at route remains actionable for canonical recovery",
  );
  assert.deepEqual(
    refreshRecoveryDbForArtifact("execute-task", "M001/S01/T01", second),
    {
      ok: true,
      advanced: false,
      reason: "execute-task-attempt-read-only-verified",
      message: "canonical Task Attempt verified at the route stage (no DB write)",
    },
  );
});

test("refreshRecoveryDbForArtifact refuses execute-task recovery after a terminal agent abort (#1622)", () => {
  const dir = makeTmpProject();
  insertTask({ milestoneId: "M001", sliceId: "S01", id: "T01", title: "Task", status: "pending" });
  const attempt = seedCanonicalTaskAttempt("failed");
  assert.ok(attempt.resultId);
  const route = recordFailureAndSelectRecovery({
    invocation: internalExecutionInvocation("test:artifact-recovery:route:abort"),
    attemptId: attempt.attemptId,
    resultId: attempt.resultId!,
    owner: "agent",
    classification: { failureKind: "fatal" },
    summary: "host verification never committed",
    evidence: { unitType: "execute-task", unitId: "M001/S01/T01" },
    rationale: "Terminal agent-owned abort",
  });
  assert.equal(route.action, "abort");

  // The artifact still verifies (the Attempt is parked at the route stage), so
  // without the guard stuck recovery reports success and re-dispatches into an
  // instant `task-recovery-abort` break.
  assert.equal(verifyExpectedArtifact("execute-task", "M001/S01/T01", dir), true);

  const result = refreshRecoveryDbForArtifact("execute-task", "M001/S01/T01", dir);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.fatal, true);
  assert.equal(result.reason, "execute-task-recovery-aborted");
  assert.ok(result.message.includes(route.recoveryActionId));
  assert.ok(result.message.includes(`/gsd recover ${route.recoveryActionId}`));
});

test("refreshRecoveryDbForArtifact closes complete-milestone DB row when artifacts exist but DB is stale (#5568)", async () => {
  const base = mkdtempSync(join(tmpdir(), "auto-recovery-complete-ms-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  tmpDirs.push(base);
  insertMilestone({ id: "M001", title: "Stale completion", status: "active" });
  insertSlice({
    milestoneId: "M001",
    id: "S01",
    title: "Done Slice",
    status: "complete",
    risk: "low",
    depends: [],
  });
  insertSlice({
    milestoneId: "M001",
    id: "S02",
    title: "Done Slice",
    status: "complete",
    risk: "low",
    depends: [],
  });
  insertTask({
    milestoneId: "M001",
    sliceId: "S01",
    id: "T01",
    title: "Done Task",
    status: "complete",
  });
  insertTask({
    milestoneId: "M001",
    sliceId: "S02",
    id: "T02",
    title: "Done Task 2",
    status: "complete",
  });
  insertAssessment({
    path: ".gsd/milestones/M001/M001-VALIDATION.md",
    milestoneId: "M001",
    status: "pass",
    scope: "milestone-validation",
    fullContent: "---\nverdict: pass\n---\n",
  });
  const milestoneDir = join(base, ".gsd", "milestones", "M001");
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(join(milestoneDir, "M001-SUMMARY.md"), "# Milestone Summary\n");
  writeFileSync(join(milestoneDir, "M001-VALIDATION.md"), "---\nverdict: pass\n---\n");
  runGit(base, ["init", "-b", "main"]);
  runGit(base, ["config", "user.email", "test@example.com"]);
  runGit(base, ["config", "user.name", "Test User"]);
  runGit(base, ["checkout", "-b", "milestone/M001"]);
  writeFileSync(join(base, "feature.ts"), "export const shipped = true;\n");
  runGit(base, ["add", "feature.ts"]);
  runGit(base, ["commit", "-m", "feat: implementation evidence"]);
  writeFileSync(join(base, ".gsd", "integration-branch"), "main\n");
  writeFileSync(
    join(base, ".gsd", "PREFERENCES.md"),
    ["---", "version: 1", "github:", "  enabled: true", "  repo: owner/repo", "---"].join("\n"),
    "utf-8",
  );
  writeFileSync(
    join(base, ".gsd", "github-sync.json"),
    JSON.stringify({
      version: 1,
      repo: "owner/repo",
      milestones: {
        M001: {
          issueNumber: 42,
          ghMilestoneNumber: 7,
          lastSyncedAt: "2025-01-01T00:00:00Z",
          state: "open",
        },
      },
      slices: {},
      tasks: {},
    }, null, 2),
    "utf-8",
  );

  _resetGhCache();
  _resetConfigCache();
  _setGhAvailableForTest(true);
  _setGhRateLimitOkForTest(true);
  _setGhCloseOverridesForTest({
    closeIssue: () => ({ ok: true }),
    closeMilestone: () => ({ ok: true }),
  });

  const result = refreshRecoveryDbForArtifact("complete-milestone", "M001", base);

  assert.deepEqual(result, { ok: true });
  assert.equal(getMilestone("M001")?.status, "complete");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const mapping = loadSyncMapping(base);
  assert.equal(mapping?.milestones.M001?.state, "closed");

  _setGhCloseOverridesForTest(null);
  _setGhAvailableForTest(null);
  _setGhRateLimitOkForTest(null);
  _resetGhCache();
  _resetConfigCache();
});

test("adopted Milestone recovery cannot promote complete-looking artifacts into authority", () => {
  const base = makeCompleteMilestoneRecoveryProject();
  adoptCanonicalHistory({ itemKind: "milestone", milestoneId: "M001" }, "ready");
  const revisionBefore = readDomainOperationFence().revision;

  const result = refreshRecoveryDbForArtifact("complete-milestone", "M001", base);

  assert.equal(result.ok, false, "artifact-only recovery must fail closed after canonical adoption");
  if (!result.ok) {
    assert.equal(result.fatal, true);
    assert.match(`${result.reason} ${result.message}`, /adopt|canonical|receipt/i);
  }
  assert.equal(getMilestone("M001")?.status, "active");
  assert.equal(milestoneLifecycleHead().lifecycleStatus, "ready");
  assert.equal(readDomainOperationFence().revision, revisionBefore, "failed recovery must not advance authority");
});

test("adopted Milestone recovery fails loudly when legacy completion sabotages a ready canonical head", () => {
  const base = makeCompleteMilestoneRecoveryProject();
  adoptCanonicalHistory({ itemKind: "milestone", milestoneId: "M001" }, "ready");
  _getAdapter()!.prepare(`
    UPDATE milestones
    SET status = 'complete', completed_at = '2026-07-14T12:00:00.000Z'
    WHERE id = 'M001'
  `).run();
  const revisionBefore = readDomainOperationFence().revision;

  const result = refreshRecoveryDbForArtifact("complete-milestone", "M001", base);

  assert.equal(result.ok, false, "legacy closed state cannot hide a nonterminal canonical head");
  if (!result.ok) {
    assert.equal(result.fatal, true);
    assert.match(`${result.reason} ${result.message}`, /canonical|receipt|mismatch/i);
  }
  assert.equal(getMilestone("M001")?.status, "complete", "failed recovery must not rewrite the sabotaged legacy head");
  assert.equal(readDomainOperationFence().revision, revisionBefore);
  assert.equal(milestoneLifecycleHead().lifecycleStatus, "ready");
});

test("adopted Milestone recovery accepts a matching current completion receipt without new authority", () => {
  const base = makeCompleteMilestoneRecoveryProject();
  const completionOperationId = completeAdoptedMilestoneWithReceipt();
  const revisionBefore = readDomainOperationFence().revision;

  const result = refreshRecoveryDbForArtifact("complete-milestone", "M001", base);

  assert.deepEqual(result, { ok: true });
  assert.equal(getMilestone("M001")?.status, "complete");
  assert.equal(readDomainOperationFence().revision, revisionBefore, "receipt observation must not create another operation");
  assert.equal(milestoneLifecycleHead().lastOperationId, completionOperationId);
});

test("adopted Milestone recovery verifies the lifecycle head and receipt in one write-fenced snapshot", () => {
  const base = makeCompleteMilestoneRecoveryProject();
  completeAdoptedMilestoneWithReceipt();
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: {
      prototype: { prepare(sql: string): unknown; exec(sql: string): void };
    };
  };
  const originalPrepare = DatabaseSync.prototype.prepare;
  const originalExec = DatabaseSync.prototype.exec;
  const immediateOwners = new WeakSet<object>();
  let receiptReadInsideImmediate = false;

  DatabaseSync.prototype.exec = function (sql: string): void {
    if (/^BEGIN IMMEDIATE\b/i.test(sql.trim())) immediateOwners.add(this);
    try {
      originalExec.call(this, sql);
    } finally {
      if (/^(?:COMMIT|ROLLBACK)\b/i.test(sql.trim())) immediateOwners.delete(this);
    }
  };

  DatabaseSync.prototype.prepare = function (sql: string): unknown {
    if (/SELECT payload_json FROM workflow_domain_events/.test(sql)) {
      receiptReadInsideImmediate = immediateOwners.has(this);
    }
    return originalPrepare.call(this, sql);
  };

  try {
    const result = refreshRecoveryDbForArtifact("complete-milestone", "M001", base);
    assert.deepEqual(result, { ok: true });
  } finally {
    DatabaseSync.prototype.prepare = originalPrepare;
    DatabaseSync.prototype.exec = originalExec;
  }

  assert.equal(receiptReadInsideImmediate, true, "receipt must be read under the same write fence as the lifecycle head");
  assert.equal(milestoneLifecycleHead().lifecycleStatus, "completed");
});

test("adopted Milestone recovery rejects a skipped legacy shadow for canonical completion", () => {
  const base = makeCompleteMilestoneRecoveryProject();
  completeAdoptedMilestoneWithReceipt();
  _getAdapter()!.prepare(`
    UPDATE milestones
    SET status = 'skipped'
    WHERE id = 'M001'
  `).run();
  const revisionBefore = readDomainOperationFence().revision;
  const lifecycleBefore = milestoneLifecycleHead();
  const legacyBefore = getMilestone("M001");
  assert.ok(legacyBefore);

  const result = refreshRecoveryDbForArtifact("complete-milestone", "M001", base);

  assert.equal(result.ok, false, "cancelled legacy meaning must not match canonical completion");
  if (!result.ok) {
    assert.equal(result.fatal, true);
    assert.match(`${result.reason} ${result.message}`, /mismatch|canonical|legacy/i);
  }
  assert.equal(readDomainOperationFence().revision, revisionBefore);
  assert.deepEqual(milestoneLifecycleHead(), lifecycleBefore);
  assert.equal(getMilestone("M001")?.status, legacyBefore.status);
  assert.equal(getMilestone("M001")?.completed_at, legacyBefore.completed_at);
});

test("adopted Milestone recovery rejects a current projection-shaped but incomplete receipt", () => {
  const base = makeCompleteMilestoneRecoveryProject();
  completeAdoptedMilestoneWithMalformedReceipt();
  const revisionBefore = readDomainOperationFence().revision;
  const lifecycleBefore = milestoneLifecycleHead();
  const legacyBefore = getMilestone("M001");
  assert.ok(legacyBefore);

  const result = refreshRecoveryDbForArtifact("complete-milestone", "M001", base);

  assert.equal(result.ok, false, "a partial projection payload is not a canonical completion receipt");
  if (!result.ok) {
    assert.equal(result.fatal, true);
    assert.match(`${result.reason} ${result.message}`, /receipt|corrupt|invalid/i);
  }
  assert.equal(readDomainOperationFence().revision, revisionBefore);
  assert.deepEqual(milestoneLifecycleHead(), lifecycleBefore);
  assert.equal(getMilestone("M001")?.status, legacyBefore.status);
  assert.equal(getMilestone("M001")?.completed_at, legacyBefore.completed_at);
});

test("refreshRecoveryDbForArtifact fails closed for complete-milestone without implementation evidence", () => {
  const base = mkdtempSync(join(tmpdir(), "auto-recovery-complete-ms-no-impl-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  tmpDirs.push(base);
  insertMilestone({ id: "M001", title: "Stale completion", status: "active" });
  insertSlice({
    milestoneId: "M001",
    id: "S01",
    title: "Done Slice",
    status: "complete",
    risk: "low",
    depends: [],
  });
  insertTask({
    milestoneId: "M001",
    sliceId: "S01",
    id: "T01",
    title: "Done Task",
    status: "complete",
  });
  insertAssessment({
    path: ".gsd/milestones/M001/M001-VALIDATION.md",
    milestoneId: "M001",
    status: "pass",
    scope: "milestone-validation",
    fullContent: "---\nverdict: pass\n---\n",
  });
  const milestoneDir = join(base, ".gsd", "milestones", "M001");
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(join(milestoneDir, "M001-SUMMARY.md"), "# Milestone Summary\n");
  writeFileSync(join(milestoneDir, "M001-VALIDATION.md"), "---\nverdict: pass\n---\n");
  runGit(base, ["init", "-b", "main"]);
  runGit(base, ["config", "user.email", "test@example.com"]);
  runGit(base, ["config", "user.name", "Test User"]);
  runGit(base, ["add", ".gsd"]);
  runGit(base, ["commit", "-m", "chore: gsd artifacts only"]);

  const result = refreshRecoveryDbForArtifact("complete-milestone", "M001", base);

  assert.deepEqual(result, {
    ok: false,
    fatal: true,
    reason: "complete-milestone-implementation-missing",
    message: "Stuck recovery found complete-milestone M001 artifacts, but implementation evidence is not present.",
  });
  assert.equal(getMilestone("M001")?.status, "active");
});

// ─── diagnoseExpectedArtifact ─────────────────────────────────────────────

test("diagnoseExpectedArtifact returns description for known types", () => {
  const base = makeTmpBase();
  try {
    const research = diagnoseExpectedArtifact("research-milestone", "M001", base);
    assert.ok(research);
    assert.ok(research!.includes("research"));

    const plan = diagnoseExpectedArtifact("plan-slice", "M001/S01", base);
    assert.ok(plan);
    assert.ok(plan!.includes("plan"));

    const task = diagnoseExpectedArtifact("execute-task", "M001/S01/T01", base);
    assert.ok(task);
    assert.ok(task!.includes("T01"));
  } finally {
    cleanup(base);
  }
});

test("diagnoseExpectedArtifact returns null for unknown type", () => {
  const base = makeTmpBase();
  try {
    assert.equal(diagnoseExpectedArtifact("unknown", "M001", base), null);
  } finally {
    cleanup(base);
  }
});

// ─── buildLoopRemediationSteps ────────────────────────────────────────────

test("buildLoopRemediationSteps returns steps for execute-task", () => {
  const base = makeTmpBase();
  try {
    const steps = buildLoopRemediationSteps("execute-task", "M001/S01/T01", base);
    assert.ok(steps);
    assert.ok(steps!.includes("gsd undo-task M001/S01/T01"));
  } finally {
    cleanup(base);
  }
});

test("buildLoopRemediationSteps returns steps for plan-slice", () => {
  const base = makeTmpBase();
  try {
    const steps = buildLoopRemediationSteps("plan-slice", "M001/S01", base);
    assert.ok(steps);
    assert.ok(steps!.includes("PLAN"));
    assert.ok(steps!.includes("gsd recover"));
  } finally {
    cleanup(base);
  }
});

test("buildLoopRemediationSteps returns steps for complete-slice", () => {
  const base = makeTmpBase();
  try {
    const steps = buildLoopRemediationSteps("complete-slice", "M001/S01", base);
    assert.ok(steps);
    assert.ok(steps!.includes("gsd reset-slice M001/S01"));
  } finally {
    cleanup(base);
  }
});

test("buildLoopRemediationSteps returns null for unknown type", () => {
  const base = makeTmpBase();
  try {
    assert.equal(buildLoopRemediationSteps("unknown", "M001", base), null);
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact accepts DB-complete slice when roadmap projection is stale", () => {
  const base = makeTmpBase();
  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
    insertSlice({
      milestoneId: "M001",
      id: "S01",
      title: "Test Slice",
      status: "complete",
      risk: "low",
      depends: [],
    });

    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
      "# M001: Test Milestone\n\n## Slices\n\n- [ ] **S01: Test Slice** `risk:low` `depends:[]`\n",
      "utf-8",
    );
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-SUMMARY.md"),
      "# S01 Summary\n\nDone.\n",
      "utf-8",
    );
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-UAT.md"),
      "# S01 UAT\n\nPassed.\n",
      "utf-8",
    );

    assert.equal(
      verifyExpectedArtifact("complete-slice", "M001/S01", base),
      true,
      "DB completion plus SUMMARY/UAT should prevent a retry even when ROADMAP is a stale projection",
    );
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

// ─── verifyExpectedArtifact: plan-slice empty scaffold regression (#699) ──

test("verifyExpectedArtifact rejects plan-slice with empty scaffold", () => {
  const base = makeTmpBase();
  try {
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    mkdirSync(sliceDir, { recursive: true });
    writeFileSync(join(sliceDir, "S01-PLAN.md"), "# S01: Test Slice\n\n## Tasks\n\n");
    assert.strictEqual(
      verifyExpectedArtifact("plan-slice", "M001/S01", base),
      false,
      "Empty scaffold should not be treated as completed artifact",
    );
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact accepts plan-slice with actual tasks", () => {
  const base = makeTmpBase();
  try {
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    const tasksDir = join(sliceDir, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(sliceDir, "S01-PLAN.md"), [
      "# S01: Test Slice",
      "",
      "## Tasks",
      "",
      "- [ ] **T01: Implement feature** `est:2h`",
      "- [ ] **T02: Write tests** `est:1h`",
    ].join("\n"));
    writeFileSync(join(tasksDir, "T01-PLAN.md"), "# T01 Plan");
    writeFileSync(join(tasksDir, "T02-PLAN.md"), "# T02 Plan");
    assert.strictEqual(
      verifyExpectedArtifact("plan-slice", "M001/S01", base),
      true,
      "Plan with task entries should be treated as completed artifact",
    );
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact accepts plan-slice with completed tasks", () => {
  const base = makeTmpBase();
  try {
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    const tasksDir = join(sliceDir, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(sliceDir, "S01-PLAN.md"), [
      "# S01: Test Slice",
      "",
      "## Tasks",
      "",
      "- [x] **T01: Implement feature** `est:2h`",
      "- [ ] **T02: Write tests** `est:1h`",
    ].join("\n"));
    writeFileSync(join(tasksDir, "T01-PLAN.md"), "# T01 Plan");
    writeFileSync(join(tasksDir, "T02-PLAN.md"), "# T02 Plan");
    assert.strictEqual(
      verifyExpectedArtifact("plan-slice", "M001/S01", base),
      true,
      "Plan with completed task entries should be treated as completed artifact",
    );
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact treats complete-slice as satisfied when summary, UAT, and the DB slice row are complete", () => {
  const base = makeTmpBase();
  try {
    const milestoneDir = join(base, ".gsd", "milestones", "M001");
    const sliceDir = join(milestoneDir, "slices", "S01");
    mkdirSync(sliceDir, { recursive: true });
    writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "# Summary\nDone.\n");
    writeFileSync(join(sliceDir, "S01-UAT.md"), "# UAT\nPassed.\n");
    seedMilestoneSlices(base, [{ id: "S01", status: "complete" }]);

    assert.equal(
      verifyExpectedArtifact("complete-slice", "M001/S01", base),
      true,
      "complete-slice should verify when expected artifact and state mutation are already satisfied",
    );
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact rejects complete-slice when the DB slice row is unreadable, even with a checked roadmap", () => {
  const base = makeTmpBase();
  try {
    const milestoneDir = join(base, ".gsd", "milestones", "M001");
    const sliceDir = join(milestoneDir, "slices", "S01");
    mkdirSync(sliceDir, { recursive: true });
    // A checked roadmap projection must never stand in for the DB slice row:
    // slice completion is DB-authoritative (ADR-017) and fails closed.
    writeFileSync(join(milestoneDir, "M001-ROADMAP.md"), [
      "# M001: Test Milestone",
      "",
      "## Slices",
      "",
      "- [x] **S01: First slice** `risk:low`",
      "",
      "## Boundary Map",
      "",
      "- S01 → terminal",
      "  - Produces: done",
      "  - Consumes: nothing",
    ].join("\n"));
    writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "# Summary\nDone.\n");
    writeFileSync(join(sliceDir, "S01-UAT.md"), "# UAT\nPassed.\n");

    assert.equal(
      verifyExpectedArtifact("complete-slice", "M001/S01", base),
      false,
      "complete-slice should remain unsatisfied when the DB cannot confirm the slice is complete",
    );
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact rejects run-uat when ASSESSMENT has no verdict", () => {
  const base = makeTmpBase();
  try {
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    writeFileSync(join(sliceDir, "S01-ASSESSMENT.md"), "# Reassessment\n\nNo canonical verdict field.\n");

    assert.equal(
      verifyExpectedArtifact("run-uat", "M001/S01", base),
      false,
      "run-uat should not verify from a pre-existing ASSESSMENT without verdict",
    );
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact accepts run-uat when ASSESSMENT has verdict", () => {
  const base = makeTmpBase();
  try {
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    writeFileSync(join(sliceDir, "S01-ASSESSMENT.md"), [
      "---",
      "verdict: pass",
      "---",
      "",
      "# UAT Assessment",
    ].join("\n"));

    assert.equal(
      verifyExpectedArtifact("run-uat", "M001/S01", base),
      true,
      "run-uat should verify when ASSESSMENT contains a canonical verdict",
    );
  } finally {
    cleanup(base);
  }
});


// ─── verifyExpectedArtifact: plan-slice task plan check (#739) ────────────

test("verifyExpectedArtifact plan-slice passes when all task plan files exist", () => {
  const base = makeTmpBase();
  try {
    const tasksDir = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
    const planPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md");
    const planContent = [
      "# S01: Test Slice",
      "",
      "## Tasks",
      "",
      "- [ ] **T01: First task** `est:1h`",
      "- [ ] **T02: Second task** `est:2h`",
    ].join("\n");
    writeFileSync(planPath, planContent);
    writeFileSync(join(tasksDir, "T01-PLAN.md"), "# T01 Plan\n\nDo the thing.");
    writeFileSync(join(tasksDir, "T02-PLAN.md"), "# T02 Plan\n\nDo the other thing.");

    const result = verifyExpectedArtifact("plan-slice", "M001/S01", base);
    assert.equal(result, true, "should pass when all task plan files exist");
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact plan-slice fails when a task plan file is missing (#739)", () => {
  const base = makeTmpBase();
  try {
    const tasksDir = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
    const planPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md");
    const planContent = [
      "# S01: Test Slice",
      "",
      "## Tasks",
      "",
      "- [ ] **T01: First task** `est:1h`",
      "- [ ] **T02: Second task** `est:2h`",
    ].join("\n");
    writeFileSync(planPath, planContent);
    // Only write T01-PLAN.md — T02 is missing
    writeFileSync(join(tasksDir, "T01-PLAN.md"), "# T01 Plan\n\nDo the thing.");

    const result = verifyExpectedArtifact("plan-slice", "M001/S01", base);
    assert.equal(result, false, "should fail when T02-PLAN.md is missing");
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact accepts flat-phase plan-slice with embedded tasks and no task plan files", () => {
  const base = join(tmpdir(), `gsd-test-${randomUUID()}`);
  try {
    const phaseDir = join(base, ".gsd", "phases", "01-test");
    mkdirSync(join(phaseDir, "tasks"), { recursive: true });
    writeFileSync(join(phaseDir, "01-01-PLAN.md"), [
      "# S01: Test Slice",
      "",
      "<tasks>",
      "- [ ] **T01**: Implement feature _(1h)_",
      "  - Files: `src/index.ts`",
      "  - Verify: pnpm test",
      "- [ ] **T02**: Write tests _(1h)_",
      "</tasks>",
    ].join("\n"));

    const result = verifyExpectedArtifact("plan-slice", "M001/S01", base);
    assert.equal(result, true, "flat-phase embedded tasks should not require tasks/T##-PLAN.md files");
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact plan-slice still verifies per-task files for legacy ## Tasks plan with a stray empty <tasks> block", () => {
  const base = makeTmpBase();
  try {
    const tasksDir = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
    const planPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md");
    // Legacy layout: real tasks live in a "## Tasks" section with separate
    // per-task PLAN files, but the plan also carries an empty <tasks></tasks>
    // block. The empty block must NOT flip the plan into flat-phase mode and
    // skip the per-task artifact checks.
    const planContent = [
      "# S01: Test Slice",
      "",
      "<tasks>",
      "</tasks>",
      "",
      "## Tasks",
      "",
      "- [ ] **T01: First task** `est:1h`",
      "- [ ] **T02: Second task** `est:2h`",
    ].join("\n");
    writeFileSync(planPath, planContent);
    // Only T01-PLAN.md exists; T02's artifact is missing.
    writeFileSync(join(tasksDir, "T01-PLAN.md"), "# T01 Plan\n\nDo the thing.");

    const result = verifyExpectedArtifact("plan-slice", "M001/S01", base);
    assert.equal(result, false, "a stray <tasks> block must not skip per-task file verification for a legacy ## Tasks plan");
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact plan-slice fails for plan with no tasks (#699)", () => {
  const base = makeTmpBase();
  try {
    const planPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md");
    const planContent = [
      "# S01: Test Slice",
      "",
      "## Goal",
      "",
      "Just some documentation updates, no tasks.",
    ].join("\n");
    writeFileSync(planPath, planContent);

    const result = verifyExpectedArtifact("plan-slice", "M001/S01", base);
    assert.equal(result, false, "should fail when plan has no task entries (empty scaffold, #699)");
  } finally {
    cleanup(base);
  }
});

// ─── verifyExpectedArtifact: heading-style plan tasks (#1691) ─────────────

test("verifyExpectedArtifact accepts plan-slice with heading-style tasks (### T01 --)", () => {
  const base = makeTmpBase();
  try {
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    const tasksDir = join(sliceDir, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(sliceDir, "S01-PLAN.md"), [
      "# S01: Test Slice",
      "",
      "## Tasks",
      "",
      "### T01 -- Implement feature",
      "",
      "Feature description.",
      "",
      "### T02 -- Write tests",
      "",
      "Test description.",
    ].join("\n"));
    writeFileSync(join(tasksDir, "T01-PLAN.md"), "# T01 Plan");
    writeFileSync(join(tasksDir, "T02-PLAN.md"), "# T02 Plan");
    assert.strictEqual(
      verifyExpectedArtifact("plan-slice", "M001/S01", base),
      true,
      "Heading-style plan with task entries should be treated as completed artifact",
    );
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact accepts plan-slice with colon-style heading tasks (### T01:)", () => {
  const base = makeTmpBase();
  try {
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    const tasksDir = join(sliceDir, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(sliceDir, "S01-PLAN.md"), [
      "# S01: Test Slice",
      "",
      "## Tasks",
      "",
      "### T01: Implement feature",
      "",
      "Feature description.",
    ].join("\n"));
    writeFileSync(join(tasksDir, "T01-PLAN.md"), "# T01 Plan");
    assert.strictEqual(
      verifyExpectedArtifact("plan-slice", "M001/S01", base),
      true,
      "Colon heading-style plan should be treated as completed artifact",
    );
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact execute-task requires checked checkbox or DB status for heading-style plan entry (#1691, #3607)", () => {
  const base = makeTmpBase();
  try {
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    const tasksDir = join(sliceDir, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(sliceDir, "S01-PLAN.md"), [
      "# S01: Test Slice",
      "",
      "## Tasks",
      "",
      "### T01 -- Implement feature",
      "",
      "Feature description.",
    ].join("\n"));
    writeFileSync(join(tasksDir, "T01-SUMMARY.md"), "# T01 Summary\n\nDone.");
    // Without DB or checked checkbox, heading-style plans cannot verify
    // execute-task completion (summary file alone is insufficient, #3607)
    assert.strictEqual(
      verifyExpectedArtifact("execute-task", "M001/S01/T01", base),
      false,
      "execute-task requires DB status or checked checkbox, not just heading + summary (#3607)",
    );
  } finally {
    cleanup(base);
  }
});


// ─── hasImplementationArtifacts (#1703) ───────────────────────────────────

import { execFileSync } from "node:child_process";

function makeGitBase(): string {
  const base = join(tmpdir(), `gsd-test-git-${randomUUID()}`);
  mkdirSync(base, { recursive: true });
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["config", "gc.auto", "0"], { cwd: base, stdio: "ignore" });
  // Create initial commit so HEAD exists
  writeFileSync(join(base, ".gitkeep"), "");
  execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: base, stdio: "ignore" });
  return base;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function withLoggedGitCommands<T>(base: string, action: () => T): { result: T; commands: string[] } {
  const realGit = execFileSync("which", ["git"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim().split(/\r?\n/)[0];
  if (!realGit) throw new Error("Unable to resolve git executable for invocation logging test");
  const binDir = join(base, ".git-wrapper-bin");
  const logFile = join(base, "git-invocations.log");
  mkdirSync(binDir, { recursive: true });
  const wrapper = join(binDir, "git");
  writeFileSync(
    wrapper,
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$1" >> ${shellQuote(logFile)}`,
      `exec ${shellQuote(realGit)} "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(wrapper, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = originalPath ? `${binDir}:${originalPath}` : binDir;
  try {
    const result = action();
    const commands = existsSync(logFile)
      ? readFileSync(logFile, "utf-8").split(/\r?\n/).filter(Boolean)
      : [];
    return { result, commands };
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
}

test("hasImplementationArtifacts returns false when only .gsd/ files committed (#1703)", () => {
  const base = makeGitBase();
  try {
    // Create a feature branch and commit only .gsd/ files
    execFileSync("git", ["checkout", "-b", "feat/test-milestone"], { cwd: base, stdio: "ignore" });
    mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
    writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "# Roadmap");
    writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-SUMMARY.md"), "# Summary");
    execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "chore: add plan files"], { cwd: base, stdio: "ignore" });

    const result = hasImplementationArtifacts(base);
    assert.equal(result, "absent", "should return absent when only .gsd/ files were committed");
  } finally {
    cleanup(base);
  }
});

test("hasImplementationArtifacts returns true when implementation files committed (#1703)", () => {
  const base = makeGitBase();
  try {
    // Create a feature branch with both .gsd/ and implementation files
    execFileSync("git", ["checkout", "-b", "feat/test-impl"], { cwd: base, stdio: "ignore" });
    mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
    writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "# Roadmap");
    mkdirSync(join(base, "src"), { recursive: true });
    writeFileSync(join(base, "src", "feature.ts"), "export function feature() {}");
    execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feat: add feature"], { cwd: base, stdio: "ignore" });

    const result = hasImplementationArtifacts(base);
    assert.equal(result, "present", "should return present when implementation files are present");
  } finally {
    cleanup(base);
  }
});

test("hasImplementationArtifacts finds milestone implementation commits after retry resumes on main (#4699)", () => {
  const base = makeGitBase();
  try {
    mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
    writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "# Roadmap");
    execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "chore: auto-commit after plan-milestone\n\nGSD-Unit: M001"], { cwd: base, stdio: "ignore" });

    mkdirSync(join(base, "src"), { recursive: true });
    mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
    writeFileSync(join(base, "src", "feature.ts"), "export function feature() {}");
    writeFileSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-SUMMARY.md"), "# Summary");
    execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feat: add milestone feature\n\nGSD-Task: S01/T01"], { cwd: base, stdio: "ignore" });

    const result = hasImplementationArtifacts(base, "M001");
    assert.equal(result, "present", "main self-diff retry should find production execute-task commits");
  } finally {
    cleanup(base);
  }
});

test("hasImplementationArtifacts rejects milestone-scoped main history with only .gsd commits (#4699)", () => {
  const base = makeGitBase();
  try {
    mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
    writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "# Roadmap");
    writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-SUMMARY.md"), "# Summary");
    execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "chore: auto-commit after complete-milestone\n\nGSD-Unit: M001"], { cwd: base, stdio: "ignore" });

    const result = hasImplementationArtifacts(base, "M001");
    assert.equal(result, "absent", "milestone-scoped fallback must not treat .gsd-only commits as implementation");
  } finally {
    cleanup(base);
  }
});

test("hasImplementationArtifacts finds integration implementation-only commits when milestone branch diff is .gsd-only", () => {
  const base = makeGitBase();
  try {
    mkdirSync(join(base, "src"), { recursive: true });
    writeFileSync(join(base, "src", "feature.ts"), "export function feature() {}\n");
    execFileSync("git", ["add", "src/feature.ts"], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feat: add milestone feature\n\nGSD-Task: S01/T01"], { cwd: base, stdio: "ignore" });

    mkdirSync(join(base, ".gsd"), { recursive: true });
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone One", status: "active" });
    insertSlice({
      id: "S01",
      milestoneId: "M001",
      title: "Slice One",
      status: "complete",
      risk: "low",
      depends: [],
    });
    insertTask({
      id: "T01",
      sliceId: "S01",
      milestoneId: "M001",
      title: "Task One",
      status: "complete",
    });

    execFileSync("git", ["checkout", "-b", "milestone/M001"], { cwd: base, stdio: "ignore" });
    writeIntegrationBranch(base, "M001", "main");
    // ADR-045: writeIntegrationBranch no longer creates milestones/<MID>/ as a
    // side effect (META is now flat at .gsd/<MID>-META.json), so scaffold the
    // legacy summary dir explicitly.
    mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
    writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-SUMMARY.md"), "# Milestone Summary\nDone.");
    execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "chore: auto-commit after complete-milestone\n\nGSD-Unit: M001"], { cwd: base, stdio: "ignore" });

    const result = hasImplementationArtifacts(base, "M001");
    assert.equal(
      result,
      "present",
      ".gsd-only milestone closeout diffs should still honor implementation commits already on the integration branch",
    );
  } finally {
    cleanup(base);
  }
});

test("hasImplementationArtifacts ignores corrupted milestone/* integration metadata", () => {
  const base = makeGitBase();
  try {
    mkdirSync(join(base, "src"), { recursive: true });
    writeFileSync(join(base, "src", "feature.ts"), "export function feature() {}\n");
    execFileSync("git", ["add", "src/feature.ts"], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feat: add milestone feature\n\nGSD-Task: S01/T01"], { cwd: base, stdio: "ignore" });

    mkdirSync(join(base, ".gsd"), { recursive: true });
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone One", status: "active" });
    insertSlice({
      id: "S01",
      milestoneId: "M001",
      title: "Slice One",
      status: "complete",
      risk: "low",
      depends: [],
    });
    insertTask({
      id: "T01",
      sliceId: "S01",
      milestoneId: "M001",
      title: "Task One",
      status: "complete",
    });

    execFileSync("git", ["checkout", "-b", "milestone/M001"], { cwd: base, stdio: "ignore" });
    mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
    writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-SUMMARY.md"), "# Milestone Summary\nDone.");
    execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "chore: auto-commit after complete-milestone\n\nGSD-Unit: M001"], { cwd: base, stdio: "ignore" });

    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "M001-META.json"),
      JSON.stringify({ integrationBranch: "milestone/M001" }, null, 2) + "\n",
    );

    const result = hasImplementationArtifacts(base, "M001");
    assert.equal(result, "present", "corrupted milestone integration metadata should fall back to main branch for artifact detection");
  } finally {
    cleanup(base);
  }
});

test("hasImplementationArtifacts backfills untagged main implementation commits from completed task file hints", () => {
  const base = makeGitBase();
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone One", status: "active" });
    insertSlice({
      id: "S01",
      milestoneId: "M001",
      title: "Slice One",
      status: "complete",
      risk: "low",
      depends: [],
    });
    insertTask({
      id: "T01",
      sliceId: "S01",
      milestoneId: "M001",
      title: "Task One",
      status: "complete",
      keyFiles: ["index.html", "style.css", "app.js"],
      planning: { files: ["index.html", "style.css", "app.js"] },
    });

    writeFileSync(join(base, "index.html"), "<main></main>\n");
    writeFileSync(join(base, "style.css"), "main { display: block; }\n");
    writeFileSync(join(base, "app.js"), "document.body.dataset.ready = 'true';\n");
    execFileSync("git", ["add", "index.html", "style.css", "app.js"], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feat: add to-do app with CRUD and localStorage persistence"], { cwd: base, stdio: "ignore" });
    const commitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: base, encoding: "utf-8" }).trim();

    const result = hasImplementationArtifacts(base, "M001");
    assert.equal(
      result,
      "present",
      "completed task file hints should repair prior untagged implementation commits on main",
    );
    assert.deepEqual(getMilestoneCommitAttributionShas("M001"), [commitSha]);
  } finally {
    cleanup(base);
  }
});

test("hasImplementationArtifacts does not backfill untagged commits before milestone creation", () => {
  const base = makeGitBase();
  try {
    writeFileSync(join(base, "app.js"), "document.body.dataset.ready = 'old';\n");
    execFileSync("git", ["add", "app.js"], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feat: old app work"], {
      cwd: base,
      stdio: "ignore",
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
      },
    });

    mkdirSync(join(base, ".gsd"), { recursive: true });
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone One", status: "active" });
    insertSlice({
      id: "S01",
      milestoneId: "M001",
      title: "Slice One",
      status: "complete",
      risk: "low",
      depends: [],
    });
    insertTask({
      id: "T01",
      sliceId: "S01",
      milestoneId: "M001",
      title: "Task One",
      status: "complete",
      keyFiles: ["app.js"],
      planning: { files: ["app.js"] },
    });

    const result = hasImplementationArtifacts(base, "M001");
    assert.equal(
      result,
      "unknown",
      "integration self-diff should remain unknown when pre-milestone commits cannot be attributed",
    );
    assert.deepEqual(getMilestoneCommitAttributionShas("M001"), []);
  } finally {
    cleanup(base);
  }
});

test("hasImplementationArtifacts does not backfill unrelated untagged implementation commits", () => {
  const base = makeGitBase();
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone One", status: "active" });
    insertSlice({
      id: "S01",
      milestoneId: "M001",
      title: "Slice One",
      status: "complete",
      risk: "low",
      depends: [],
    });
    insertTask({
      id: "T01",
      sliceId: "S01",
      milestoneId: "M001",
      title: "Task One",
      status: "complete",
      keyFiles: ["src/expected.ts"],
      planning: { files: ["src/expected.ts"] },
    });

    mkdirSync(join(base, "src"), { recursive: true });
    writeFileSync(join(base, "src", "unrelated.ts"), "export const unrelated = true;\n");
    execFileSync("git", ["add", "src/unrelated.ts"], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feat: unrelated work"], { cwd: base, stdio: "ignore" });

    const result = hasImplementationArtifacts(base, "M001");
    assert.equal(
      result,
      "unknown",
      "integration self-diff should remain unknown when unrelated untagged commits cannot be attributed",
    );
    assert.deepEqual(getMilestoneCommitAttributionShas("M001"), []);
  } finally {
    cleanup(base);
  }
});

test("hasImplementationArtifacts treats empty non-integration branch diff as absent (#4699)", () => {
  const base = makeGitBase();
  try {
    execFileSync("git", ["checkout", "-b", "feat/empty-milestone"], { cwd: base, stdio: "ignore" });

    const result = hasImplementationArtifacts(base, "M001");
    assert.equal(result, "absent", "empty milestone branch diffs should not use main retry fallback");
  } finally {
    cleanup(base);
  }
});

test("hasImplementationArtifacts returns unknown for empty integration self-diff without milestone evidence (#5071)", () => {
  const base = makeGitBase();
  try {
    const result = hasImplementationArtifacts(base, "M001");
    assert.equal(
      result,
      "unknown",
      "integration self-diff retries without milestone evidence must fail open instead of blocking closeout",
    );
  } finally {
    cleanup(base);
  }
});

test("hasImplementationArtifacts uses milestone path history instead of rolling depth (#4699)", () => {
  const base = makeGitBase();
  try {
    execFileSync("git", ["checkout", "-b", "milestone/M001"], { cwd: base, stdio: "ignore" });
    mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
    mkdirSync(join(base, "src"), { recursive: true });
    writeFileSync(join(base, "src", "feature.ts"), "export function feature() {}");
    writeFileSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-SUMMARY.md"), "# Summary");
    execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feat: old milestone implementation\n\nGSD-Task: S01/T01"], { cwd: base, stdio: "ignore" });

    mkdirSync(join(base, "docs"), { recursive: true });
    for (let i = 0; i < 25; i++) {
      writeFileSync(join(base, "docs", `note-${i}.md`), `# Note ${i}\n`);
      execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", `docs: filler ${i}`], { cwd: base, stdio: "ignore" });
    }

    const result = hasImplementationArtifacts(base, "M001");
    assert.equal(result, "present", "milestone evidence should not age out beyond the old rolling-depth fallback");
  } finally {
    cleanup(base);
  }
});

test("hasImplementationArtifacts finds implementation commits when .gsd/ is gitignored (#5033)", () => {
  const base = makeGitBase();
  try {
    // Simulate external/untracked .gsd/ via .git/info/exclude — milestone
    // planning artifacts never enter git, but real implementation files do.
    writeFileSync(join(base, ".git", "info", "exclude"), ".gsd/\n");
    mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-SUMMARY.md"),
      "# Summary",
    );

    mkdirSync(join(base, "benchmarks", "M001"), { recursive: true });
    writeFileSync(join(base, "benchmarks", "M001", "manifest.yaml"), "cases: []\n");

    execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
    execFileSync(
      "git",
      ["commit", "-m", "feat: materialize M001 evidence\n\nGSD-Task: S01/T01"],
      { cwd: base, stdio: "ignore" },
    );

    const result = hasImplementationArtifacts(base, "M001");
    assert.equal(
      result,
      "present",
      "milestone-tagged commit binding must work when .gsd/ is gitignored",
    );
  } finally {
    cleanup(base);
  }
});

test("hasImplementationArtifacts scans GSD-tagged history without per-commit diff-tree forks (#892)", { skip: process.platform === "win32" }, () => {
  const base = makeGitBase();
  try {
    writeFileSync(join(base, ".git", "info", "exclude"), ".gsd/\n");
    mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-SUMMARY.md"),
      "# Summary",
    );

    mkdirSync(join(base, "src"), { recursive: true });
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(base, "src", `feature-${i}.ts`), `export const feature${i} = true;\n`);
      execFileSync("git", ["add", "src"], { cwd: base, stdio: "ignore" });
      execFileSync(
        "git",
        ["commit", "-m", `feat: materialize M001 evidence ${i}\n\nGSD-Task: S01/T01`],
        { cwd: base, stdio: "ignore" },
      );
    }

    const { result, commands } = withLoggedGitCommands(base, () => hasImplementationArtifacts(base, "M001"));
    assert.equal(result, "present", "milestone-tagged commits should still prove implementation evidence");
    assert.ok(commands.includes("log"), "milestone evidence fallback should scan history with git log");
    assert.equal(commands.filter((command) => command === "diff-tree").length, 0);
  } finally {
    cleanup(base);
  }
});

test("hasImplementationArtifacts backfill scans commit records without per-commit diff-tree forks (#892)", { skip: process.platform === "win32" }, () => {
  const base = makeGitBase();
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone One", status: "active" });
    insertSlice({
      id: "S01",
      milestoneId: "M001",
      title: "Slice One",
      status: "complete",
      risk: "low",
      depends: [],
    });
    insertTask({
      id: "T01",
      sliceId: "S01",
      milestoneId: "M001",
      title: "Task One",
      status: "complete",
      keyFiles: ["src/expected-0.ts", "src/expected-1.ts"],
      planning: { files: ["src/expected-0.ts", "src/expected-1.ts"] },
    });

    mkdirSync(join(base, "src"), { recursive: true });
    for (let i = 0; i < 2; i++) {
      writeFileSync(join(base, "src", `expected-${i}.ts`), `export const expected${i} = true;\n`);
      execFileSync("git", ["add", "src"], { cwd: base, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", `feat: untagged implementation ${i}`], { cwd: base, stdio: "ignore" });
    }

    const { result, commands } = withLoggedGitCommands(base, () => hasImplementationArtifacts(base, "M001"));
    assert.equal(result, "present", "completed task file hints should still backfill untagged commits");
    assert.equal(getMilestoneCommitAttributionShas("M001").length, 2);
    assert.ok(commands.includes("log"), "backfill should scan commit records with git log");
    assert.equal(commands.filter((command) => command === "diff-tree").length, 0);
  } finally {
    cleanup(base);
  }
});

test("hasImplementationArtifacts binds GSD-Task trailer to milestone via DB state when .gsd/ is gitignored", () => {
  const base = makeGitBase();
  try {
    writeFileSync(join(base, ".git", "info", "exclude"), ".gsd/\n");
    mkdirSync(join(base, ".gsd"), { recursive: true });
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone One", status: "active" });
    insertSlice({
      id: "S01",
      milestoneId: "M001",
      title: "Slice One",
      status: "complete",
      risk: "low",
      depends: [],
    });
    insertTask({
      id: "T01",
      sliceId: "S01",
      milestoneId: "M001",
      title: "Task One",
      status: "complete",
    });

    mkdirSync(join(base, "src"), { recursive: true });
    writeFileSync(join(base, "src", "feature.ts"), "export function feature() {}\n");
    execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
    execFileSync(
      "git",
      ["commit", "-m", "feat: add feature\n\nGSD-Task: S01/T01"],
      { cwd: base, stdio: "ignore" },
    );

    const result = hasImplementationArtifacts(base, "M001");
    assert.equal(
      result,
      "present",
      "DB task ownership should bind S01/T01 implementation commits to M001 without explicit M001 text",
    );
  } finally {
    cleanup(base);
  }
});

test("hasImplementationArtifacts returns unknown when GSD-Task trailer cannot be bound to milestone ownership evidence", () => {
  const base = makeGitBase();
  try {
    writeFileSync(join(base, ".git", "info", "exclude"), ".gsd/\n");
    mkdirSync(join(base, ".gsd"), { recursive: true });
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone One", status: "active" });
    insertMilestone({ id: "M002", title: "Milestone Two", status: "active" });
    insertSlice({
      id: "S01",
      milestoneId: "M002",
      title: "Slice One",
      status: "complete",
      risk: "low",
      depends: [],
    });
    insertTask({
      id: "T01",
      sliceId: "S01",
      milestoneId: "M002",
      title: "Task One",
      status: "complete",
    });

    mkdirSync(join(base, "src"), { recursive: true });
    writeFileSync(join(base, "src", "feature.ts"), "export function feature() {}\n");
    execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
    execFileSync(
      "git",
      ["commit", "-m", "feat: add sibling feature\n\nGSD-Task: S01/T01"],
      { cwd: base, stdio: "ignore" },
    );

    const result = hasImplementationArtifacts(base, "M001");
    assert.equal(
      result,
      "unknown",
      "integration self-diff should not conclude absent when S01/T01 cannot be bound to M001",
    );
  } finally {
    cleanup(base);
  }
});

test("hasImplementationArtifacts ignores malformed milestone IDs in commit-message fallback", () => {
  const base = makeGitBase();
  try {
    writeFileSync(join(base, ".git", "info", "exclude"), ".gsd/\n");
    mkdirSync(join(base, "src"), { recursive: true });
    writeFileSync(join(base, "src", "feature.ts"), "export function feature() {}\n");

    execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
    execFileSync(
      "git",
      ["commit", "-m", "feat: materialize M001(foo evidence\n\nGSD-Task: S01/T01"],
      { cwd: base, stdio: "ignore" },
    );

    const result = hasImplementationArtifacts(base, "M001(");
    assert.equal(
      result,
      "unknown",
      "malformed milestone IDs must not force an absent classification when ownership cannot be proven",
    );
  } finally {
    cleanup(base);
  }
});

test("hasImplementationArtifacts returns true on non-git directory (fail-open)", () => {
  const base = join(tmpdir(), `gsd-test-nogit-${randomUUID()}`);
  mkdirSync(base, { recursive: true });
  try {
    const result = hasImplementationArtifacts(base);
    assert.equal(result, "unknown", "should return unknown (fail-open) in non-git directory");
  } finally {
    cleanup(base);
  }
});

// ─── verifyExpectedArtifact: complete-milestone requires impl artifacts (#1703) ──

test("verifyExpectedArtifact complete-milestone fails with only .gsd/ files (#1703)", () => {
  const base = makeGitBase();
  try {
    // Create feature branch with only .gsd/ files
    execFileSync("git", ["checkout", "-b", "feat/ms-only-gsd"], { cwd: base, stdio: "ignore" });
    mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
    writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-SUMMARY.md"), "# Milestone Summary\nDone.");
    execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "chore: milestone plan files"], { cwd: base, stdio: "ignore" });

    const result = verifyExpectedArtifact("complete-milestone", "M001", base);
    assert.equal(result, false, "complete-milestone should fail verification when only .gsd/ files present");
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact complete-milestone passes with impl files (#1703)", () => {
  const base = makeGitBase();
  try {
    // Create feature branch with implementation files AND milestone summary
    execFileSync("git", ["checkout", "-b", "feat/ms-with-impl"], { cwd: base, stdio: "ignore" });
    mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
    writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-SUMMARY.md"), "# Milestone Summary\nDone.");
    mkdirSync(join(base, "src"), { recursive: true });
    writeFileSync(join(base, "src", "app.ts"), "console.log('hello');");
    execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feat: implementation"], { cwd: base, stdio: "ignore" });

    // Closeout is DB-authoritative (ADR-017): the closeout proof must clear
    // before implementation evidence is consulted at all. The invariant under
    // test is still "real implementation files are honored" — this fixture
    // simply had no DB to prove closeout against.
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone One", status: "complete" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Done Slice", status: "complete" });
    insertAssessment({
      path: "milestones/M001/M001-VALIDATION.md",
      milestoneId: "M001",
      status: "pass",
      scope: "milestone-validation",
      fullContent: "verdict: pass",
    });

    const result = verifyExpectedArtifact("complete-milestone", "M001", base);
    assert.equal(result, true, "complete-milestone should pass verification with implementation files");
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact complete-milestone passes on main retry with milestone implementation commits (#4699)", () => {
  const base = makeGitBase();
  try {
    mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
    writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-SUMMARY.md"), "# Milestone Summary\nDone.");
    mkdirSync(join(base, "src"), { recursive: true });
    mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
    writeFileSync(join(base, "src", "app.ts"), "console.log('hello');");
    writeFileSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-SUMMARY.md"), "# Summary");
    execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feat: implementation already on main\n\nGSD-Task: S01/T01"], { cwd: base, stdio: "ignore" });

    // Closeout is DB-authoritative (ADR-017) — seed the closed milestone so the
    // proof clears and the assertion still isolates its real subject: a
    // self-diff between HEAD and main must not by itself fail verification.
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone One", status: "complete" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Done Slice", status: "complete" });
    insertAssessment({
      path: "milestones/M001/M001-VALIDATION.md",
      milestoneId: "M001",
      status: "pass",
      scope: "milestone-validation",
      fullContent: "verdict: pass",
    });

    const result = verifyExpectedArtifact("complete-milestone", "M001", base);
    assert.equal(result, true, "complete-milestone should not fail solely because HEAD vs main is a self-diff");
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact complete-milestone fails when DB milestone is not complete (#4658)", () => {
  const base = makeGitBase();
  try {
    execFileSync("git", ["checkout", "-b", "feat/ms-db-active"], { cwd: base, stdio: "ignore" });
    mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
    writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-SUMMARY.md"), "# Milestone Summary\nverification FAILED — not complete.");
    mkdirSync(join(base, "src"), { recursive: true });
    writeFileSync(join(base, "src", "app.ts"), "console.log('hello');");
    execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feat: implementation with failed summary"], { cwd: base, stdio: "ignore" });

    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone One", status: "active" });

    const result = verifyExpectedArtifact("complete-milestone", "M001", base);
    assert.equal(result, false, "complete-milestone must fail when DB status is not complete");
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact complete-milestone passes when DB milestone is complete (#4658)", () => {
  const base = makeGitBase();
  try {
    execFileSync("git", ["checkout", "-b", "feat/ms-db-complete"], { cwd: base, stdio: "ignore" });
    mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
    writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-SUMMARY.md"), "# Milestone Summary\nDone.");
    mkdirSync(join(base, "src"), { recursive: true });
    writeFileSync(join(base, "src", "app.ts"), "console.log('hello');");
    execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feat: implementation complete"], { cwd: base, stdio: "ignore" });

    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone One", status: "complete" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Done Slice", status: "complete" });
    insertAssessment({
      path: "milestones/M001/M001-VALIDATION.md",
      milestoneId: "M001",
      status: "pass",
      scope: "milestone-validation",
      fullContent: "verdict: pass",
    });

    const result = verifyExpectedArtifact("complete-milestone", "M001", base);
    assert.equal(result, true, "complete-milestone should pass when DB status is complete");
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact complete-milestone rejects success SUMMARY when DB milestone is still open (#4658)", () => {
  const base = makeGitBase();
  try {
    execFileSync("git", ["checkout", "-b", "feat/ms-db-lag-success"], { cwd: base, stdio: "ignore" });
    mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "M001-SUMMARY.md"),
      [
        "---",
        "id: M001",
        "status: complete",
        "---",
        "",
        "# M001: Success",
      ].join("\n"),
    );
    mkdirSync(join(base, "src"), { recursive: true });
    writeFileSync(join(base, "src", "app.ts"), "console.log('hello');");
    execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feat: implementation with stale db"], { cwd: base, stdio: "ignore" });

    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone One", status: "active" });

    const result = verifyExpectedArtifact("complete-milestone", "M001", base);
    assert.equal(result, false, "success SUMMARY must not overrule an open DB milestone");
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact checks pending gate-evaluate artifacts without ESM require failures", () => {
  const base = makeTmpProject();

  const verified = verifyExpectedArtifact("gate-evaluate", "M001/S01/gates+Q3", base);

  assert.equal(verified, false, "pending gates should keep gate-evaluate unverified");
});

test("verifyExpectedArtifact fails closed for gate-evaluate when the DB is unavailable", () => {
  const base = makeTmpProject();
  closeDatabase();

  const verified = verifyExpectedArtifact("gate-evaluate", "M001/S01/gates+Q3", base);

  assert.equal(verified, false, "gate-evaluate must verify against the DB-backed gate rows");
});

test("verifyExpectedArtifact ignores complete-slice gates in stale gate-evaluate unit ids", () => {
  const base = makeTmpProject();
  insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q4", scope: "slice" });
  insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q8", scope: "slice" });
  saveGateResult({ milestoneId: "M001", sliceId: "S01", gateId: "Q3", verdict: "pass", rationale: "OK", findings: "" });
  saveGateResult({ milestoneId: "M001", sliceId: "S01", gateId: "Q4", verdict: "pass", rationale: "OK", findings: "" });

  const verified = verifyExpectedArtifact("gate-evaluate", "M001/S01/gates+Q3,Q4,Q8", base);

  assert.equal(verified, true, "pending Q8 belongs to complete-slice and must not keep gate-evaluate unverified");
});

// ─── #4414 regressions ────────────────────────────────────────────────────────

test("#4414: writeBlockerPlaceholder invalidates path cache so dispatch guard sees file", () => {
  const base = makeTmpBase();
  try {
    // Prime the readdir cache by resolving a DIFFERENT file first — this
    // mirrors the stuck-loop condition where the dispatch guard cached an
    // empty directory listing before the placeholder was written.
    invalidateAllCaches();
    assert.equal(
      resolveMilestoneFile(base, "M001", "RESEARCH"),
      null,
      "no RESEARCH file yet",
    );

    const result = writeBlockerPlaceholder(
      "research-milestone",
      "M001",
      base,
      "verification retries exhausted",
    );
    assert.ok(result, "placeholder path returned");

    // After writeBlockerPlaceholder, the dispatch guard must see the new file
    // immediately — otherwise the rule re-fires (#4414, 7× re-dispatch).
    const postResolve = resolveMilestoneFile(base, "M001", "RESEARCH");
    assert.ok(
      postResolve,
      "resolveMilestoneFile finds the placeholder post-write (cache invalidated)",
    );
  } finally {
    cleanup(base);
  }
});

test("#4414: parallel-research sentinel path does not collide with RESEARCH suffix", () => {
  const base = makeTmpBase();
  try {
    // Write only the parallel-research blocker (sentinel).
    const sentinel = resolveExpectedArtifactPath(
      "research-slice",
      "M001/parallel-research",
      base,
    );
    assert.ok(sentinel, "sentinel path resolves for parallel-research");
    writeFileSync(sentinel!, "# blocker\n", "utf-8");

    // Critical: the sentinel filename must NOT be matched by the legacy regex
    // used when callers look up milestone-level RESEARCH. Otherwise the
    // dispatch guard for research-milestone would short-circuit falsely.
    const milestoneResearch = resolveMilestoneFile(base, "M001", "RESEARCH");
    assert.equal(
      milestoneResearch,
      null,
      "sentinel must not be mistaken for M001-RESEARCH.md via legacy pattern match",
    );
  } finally {
    cleanup(base);
  }
});

test("#4068: verifyExpectedArtifact parallel-research treats PARALLEL-BLOCKER as terminal completion", () => {
  // Regression: when a parallel-research unit times out and the timeout-recovery
  // machinery writes a PARALLEL-BLOCKER placeholder, verifyExpectedArtifact must
  // return true so the dispatch loop can advance.  Previously it only returned
  // true when every slice had a RESEARCH file — meaning a timeout always left
  // verifyExpectedArtifact returning false, the unit was never cleared from
  // unitDispatchCount, and the dispatch rule re-fired on the next iteration
  // (infinite loop, issue #4068 / #4355).
  const base = makeTmpBase();
  try {
    // Write a minimal roadmap
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
      [
        "# M001: Timeout Test",
        "",
        "## Slices",
        "",
        "- [ ] **S01: Alpha** `risk:low` `depends:[]`",
        "- [ ] **S02: Beta** `risk:low` `depends:[]`",
        "",
      ].join("\n"),
      "utf-8",
    );

    // No RESEARCH files written — subagents timed out
    clearParseCache();
    invalidateAllCaches();

    // Simulate timeout-recovery writing the PARALLEL-BLOCKER placeholder
    const blockerPath = resolveExpectedArtifactPath("research-slice", "M001/parallel-research", base);
    assert.ok(blockerPath, "PARALLEL-BLOCKER path must resolve for parallel-research unit");
    writeFileSync(blockerPath!, "# BLOCKER — timeout recovery\n\n**Reason**: hard timeout.\n", "utf-8");

    clearParseCache();
    invalidateAllCaches();

    // After blocker is written, verifyExpectedArtifact must return true
    // so the dispatch loop treats this unit as complete and moves on.
    assert.equal(
      verifyExpectedArtifact("research-slice", "M001/parallel-research", base),
      true,
      "#4068: PARALLEL-BLOCKER on disk must satisfy verifyExpectedArtifact so the loop does not re-dispatch",
    );
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact treats REACTIVE-BLOCKER as diagnostic only", () => {
  const base = makeTmpBase();
  try {
    const blockerPath = resolveExpectedArtifactPath("reactive-execute", "M001/S01/reactive+T01,T02", base);
    assert.ok(blockerPath, "reactive blocker path resolves");
    writeFileSync(blockerPath!, "# BLOCKER\n", "utf-8");

    assert.equal(
      verifyExpectedArtifact("reactive-execute", "M001/S01/reactive+T01,T02", base),
      false,
      "REACTIVE-BLOCKER cannot replace canonical batch completion evidence",
    );
  } finally {
    cleanup(base);
  }
});

test("writeReactiveExecuteBlocker never derives Task completion or cancellation from summaries", () => {
  const base = makeTmpBase();
  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending" });
    insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", title: "One", status: "pending" });
    insertTask({ id: "T02", milestoneId: "M001", sliceId: "S01", title: "Two", status: "pending" });
    insertTask({ id: "T03", milestoneId: "M001", sliceId: "S01", title: "Three", status: "complete" });
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-SUMMARY.md"),
      "# T01 Summary\n",
      "utf-8",
    );
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T03-SUMMARY.md"),
      "# T03 Summary\n",
      "utf-8",
    );

    const recovery = writeReactiveExecuteBlocker(
      "M001/S01/reactive+T01,T02,T03",
      base,
      "verification retries exhausted",
    );

    assert.ok(recovery, "recovery should run with DB available");
    assert.deepEqual(recovery!.completedTaskIds, []);
    assert.deepEqual(recovery!.skippedTaskIds, []);
    assert.deepEqual(recovery!.unchangedTaskIds, ["T01", "T02", "T03"]);
    assert.equal(getTask("M001", "S01", "T01")?.status, "pending");
    assert.equal(getTask("M001", "S01", "T02")?.status, "pending");
    assert.equal(getTask("M001", "S01", "T03")?.status, "complete");
    assert.ok(existsSync(recovery!.blockerPath), "reactive blocker should be written");
    const blocker = readFileSync(recovery!.blockerPath, "utf-8");
    assert.match(blocker, /Summary present\*\*: T01, T03/);
    assert.match(blocker, /Summary missing\*\*: T02/);

    const events = readEvents(join(base, ".gsd", "event-log.jsonl"));
    assert.equal(events.some((e) => e.trigger_reason === "reactive-execute-blocker-recovery"), false);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("#1088: writeReactiveExecuteBlocker preserves deferred batch task statuses", () => {
  const base = makeTmpBase();
  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending" });
    insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", title: "One", status: "deferred" });
    insertTask({ id: "T02", milestoneId: "M001", sliceId: "S01", title: "Two", status: "deferred" });
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-SUMMARY.md"),
      "# T01 Summary\n",
      "utf-8",
    );

    const recovery = writeReactiveExecuteBlocker(
      "M001/S01/reactive+T01,T02",
      base,
      "verification retries exhausted",
    );

    assert.ok(recovery, "recovery should run with DB available");
    assert.deepEqual(recovery!.completedTaskIds, []);
    assert.deepEqual(recovery!.skippedTaskIds, []);
    assert.deepEqual(recovery!.unchangedTaskIds, ["T01", "T02"]);
    assert.equal(getTask("M001", "S01", "T01")?.status, "deferred");
    assert.equal(getTask("M001", "S01", "T02")?.status, "deferred");

    const events = readEvents(join(base, ".gsd", "event-log.jsonl"));
    assert.equal(events.some((e) => e.params.taskId === "T01" || e.params.taskId === "T02"), false);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("#1343: writeReactiveExecuteBlocker uses slice-qualified summaries in flat-phase (no cross-slice collision)", () => {
  const base = join(tmpdir(), `gsd-test-${randomUUID()}`);
  try {
    // Flat-phase layout: slices S01 and S02 share the phase dir and reuse task
    // id T03. Only the sibling slice S01 produced a summary.
    const phaseDir = join(base, ".gsd", "phases", "01-test");
    mkdirSync(phaseDir, { recursive: true });
    writeFileSync(join(phaseDir, "01-01-PLAN.md"), "# S01: First\n", "utf-8");
    writeFileSync(join(phaseDir, "01-02-PLAN.md"), "# S02: Second\n", "utf-8");
    writeFileSync(join(phaseDir, "S01-T03-SUMMARY.md"), "# S01 T03 Summary\n", "utf-8");

    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "First", status: "pending" });
    insertSlice({ id: "S02", milestoneId: "M001", title: "Second", status: "pending" });
    insertTask({ id: "T03", milestoneId: "M001", sliceId: "S02", title: "Shared id", status: "pending" });

    const recovery = writeReactiveExecuteBlocker(
      "M001/S02/reactive+T03",
      base,
      "verification retries exhausted",
    );

    assert.ok(recovery, "recovery should run with DB available");
    // S02 never wrote S02-T03-SUMMARY.md; the sibling S01-T03-SUMMARY.md must
    // not change S02/T03's canonical state.
    assert.deepEqual(recovery!.completedTaskIds, []);
    assert.deepEqual(recovery!.skippedTaskIds, []);
    assert.deepEqual(recovery!.unchangedTaskIds, ["T03"]);
    assert.equal(getTask("M001", "S02", "T03")?.status, "pending");
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

// ─── T05: fail-closed adopted-history guard ──────────────────────────────────

function adoptCanonicalHistory(
  identity: LifecycleIdentity,
  lifecycleStatus: CanonicalLifecycleStatus,
): void {
  const entityId = [identity.milestoneId, identity.sliceId, identity.taskId]
    .filter(Boolean)
    .join("/");
  const operationType = `test.blocker-placeholder.${identity.itemKind}-adopted`;
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType,
    idempotencyKey: `${operationType}:${entityId}`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { entityId },
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      ...identity,
      lifecycleStatus,
      adoptedFromStatus: lifecycleStatus,
    });
    return {
      events: [{
        eventType: operationType,
        entityType: identity.itemKind,
        entityId,
        payload: {},
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: `test/blocker-placeholder/${identity.itemKind}-adopted`,
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}

test("writeBlockerPlaceholder fails closed instead of fabricating slice completion for adopted canonical history", () => {
  const base = makeTmpBase();
  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending" });
    adoptCanonicalHistory(
      { itemKind: "slice", milestoneId: "M001", sliceId: "S01" },
      "in_progress",
    );

    const result = writeBlockerPlaceholder(
      "complete-slice",
      "M001/S01",
      base,
      "verification retries exhausted",
    );

    assert.ok(result, "diagnostic placeholder path is still returned");
    assert.equal(
      getSlice("M001", "S01")?.status,
      "pending",
      "adopted slice must not be fabricated to complete",
    );
    const events = readEvents(join(base, ".gsd", "event-log.jsonl"));
    assert.equal(
      events.some((e) => e.trigger_reason === "blocker-placeholder-recovery"),
      false,
      "no blocker-placeholder-recovery event for an adopted slice",
    );
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("writeBlockerPlaceholder never fabricates Slice completion from a diagnostic artifact", () => {
  const base = makeTmpBase();
  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending" });

    const result = writeBlockerPlaceholder(
      "complete-slice",
      "M001/S01",
      base,
      "verification retries exhausted",
    );

    assert.ok(result, "diagnostic placeholder path is still returned");
    assert.equal(getSlice("M001", "S01")?.status, "pending");
    const events = readEvents(join(base, ".gsd", "event-log.jsonl"));
    assert.equal(
      events.some((event) => event.trigger_reason === "blocker-placeholder-recovery"),
      false,
      "a recovery diagnostic must never become completion authority",
    );
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("writeBlockerPlaceholder fails closed instead of inserting an S00-blocker slice for an adopted canonical milestone", () => {
  const base = makeTmpBase();
  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone", status: "active" });
    adoptCanonicalHistory({ itemKind: "milestone", milestoneId: "M001" }, "ready");

    const result = writeBlockerPlaceholder(
      "plan-milestone",
      "M001",
      base,
      "verification retries exhausted",
    );

    assert.ok(result, "diagnostic placeholder path is still returned");
    assert.equal(
      getSlice("M001", "S00-blocker"),
      null,
      "adopted milestone must not get a fabricated S00-blocker slice",
    );
    assert.match(
      getPlanMilestoneRecoveryBlock("M001")?.reason ?? "",
      /verification retries exhausted/,
      "adopted milestone planning failures still need a durable blocker",
    );
    const events = readEvents(join(base, ".gsd", "event-log.jsonl"));
    assert.equal(
      events.some((e) => e.trigger_reason === "blocker-placeholder-recovery"),
      false,
      "no blocker-placeholder-recovery event for an adopted milestone",
    );
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("#4414: verifyExpectedArtifact parallel-research succeeds when all research-ready slices have RESEARCH", () => {
  const base = makeTmpBase();
  try {
    mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S02", "tasks"), { recursive: true });
    mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S03", "tasks"), { recursive: true });
    seedMilestoneSlices(base, [
      { id: "S01", status: "pending" },
      { id: "S02", status: "pending" },
      { id: "S03", status: "pending" },
    ]);

    // Minimal roadmap with three slices
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
      [
        "# M001: Regression",
        "",
        "## Slices",
        "",
        "- [ ] **S01: Alpha** `risk:low` `depends:[]`",
        "- [ ] **S02: Beta** `risk:low` `depends:[]`",
        "- [ ] **S03: Gamma** `risk:low` `depends:[]`",
        "",
      ].join("\n"),
      "utf-8",
    );

    // Only 2 of 3 have RESEARCH — should fail verification
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-RESEARCH.md"),
      "# research",
      "utf-8",
    );
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "slices", "S02", "S02-RESEARCH.md"),
      "# research",
      "utf-8",
    );

    clearParseCache();
    invalidateAllCaches();
    assert.equal(
      verifyExpectedArtifact("research-slice", "M001/parallel-research", base),
      false,
      "missing S03 RESEARCH → verification fails",
    );

    // All three RESEARCH present → verification passes
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "slices", "S03", "S03-RESEARCH.md"),
      "# research",
      "utf-8",
    );
    clearParseCache();
    invalidateAllCaches();
    assert.equal(
      verifyExpectedArtifact("research-slice", "M001/parallel-research", base),
      true,
      "all slices have RESEARCH → verification passes",
    );
  } finally {
    cleanup(base);
  }
});

test("parallel-research verification accepts canonical project artifacts from a worktree base", () => {
  const base = makeTmpBase();
  const previousProjectRoot = process.env.GSD_PROJECT_ROOT;
  delete process.env.GSD_PROJECT_ROOT;
  try {
    const milestoneDir = join(base, ".gsd", "milestones", "M001");
    mkdirSync(join(milestoneDir, "slices", "S02", "tasks"), { recursive: true });
    mkdirSync(join(milestoneDir, "slices", "S03", "tasks"), { recursive: true });
    seedMilestoneSlices(base, [
      { id: "S01", status: "pending" },
      { id: "S02", status: "pending" },
      { id: "S03", status: "pending" },
    ]);

    writeFileSync(
      join(milestoneDir, "M001-ROADMAP.md"),
      [
        "# M001: Regression",
        "",
        "## Slices",
        "",
        "- [ ] **S01: Alpha** `risk:low` `depends:[]`",
        "- [ ] **S02: Beta** `risk:low` `depends:[]`",
        "- [ ] **S03: Gamma** `risk:low` `depends:[]`",
        "",
      ].join("\n"),
      "utf-8",
    );
    writeFileSync(join(milestoneDir, "M001-RESEARCH.md"), "# milestone research\n", "utf-8");
    writeFileSync(join(milestoneDir, "slices", "S02", "S02-RESEARCH.md"), "# research\n", "utf-8");
    writeFileSync(join(milestoneDir, "slices", "S03", "S03-RESEARCH.md"), "# research\n", "utf-8");

    const worktree = join(base, ".gsd", "worktrees", "M001");
    mkdirSync(join(worktree, ".gsd", "milestones", "M001"), { recursive: true });
    writeFileSync(join(worktree, ".git"), "gitdir: ../../../../.git/worktrees/M001\n", "utf-8");

    clearParseCache();
    invalidateAllCaches();
    assert.equal(
      verifyExpectedArtifact("research-slice", "M001/parallel-research", worktree),
      true,
      "worktree verification should use the same canonical artifacts as dispatch",
    );
  } finally {
    if (previousProjectRoot !== undefined) process.env.GSD_PROJECT_ROOT = previousProjectRoot;
    cleanup(base);
  }
});
