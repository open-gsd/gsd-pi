// Project/App: gsd-pi
// File Purpose: Capstone convergence proof for the adopted Milestone lifecycle.

import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, test } from "node:test";

import {
  _setDomainOperationFaultForTest,
  type DomainOperationContext,
} from "../db/domain-operation.ts";
import { grantSliceCancellationWaiver } from "../db/writers/slice-lifecycle.ts";
import { adoptOrTransitionLifecycle } from "../db/writers/lifecycle-commands.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";
import { clearParseCache } from "../files.ts";
import {
  _getAdapter,
  closeDatabase,
  executeDomainOperation,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
  readDomainOperationFence,
} from "../gsd-db.ts";
import {
  completeMilestone,
  reopenMilestone,
  type MilestoneCompletionCloseout,
} from "../milestone-lifecycle-domain-operation.ts";
import { clearPathCache } from "../paths.ts";
import {
  grantTaskWaiver,
  recordTaskRequirementDisposition,
} from "../task-recovery-domain-operation.ts";
import {
  handleValidateMilestone,
  type ValidateMilestoneParams,
} from "../tools/validate-milestone.ts";
import { captureVerificationSourceSnapshot } from "../verification-source-integrity.ts";

interface CapstoneFixture {
  root: string;
  dbPath: string;
  sourceRevision: string;
  waiverIds: string[];
}

interface ChildResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface WorkerOutcome {
  receipt?: Record<string, unknown>;
  error?: { code: string; message: string };
}

type ContentionWorker = ChildProcessByStdio<null, Readable, Readable>;

const tempDirs = new Set<string>();

const validationParams: ValidateMilestoneParams = {
  milestoneId: "M001",
  verdict: "pass",
  remediationRound: 0,
  successCriteriaChecklist: "- [x] Complete",
  sliceDeliveryAudit: "| S01 | delivered |\n| S02 | waived |",
  crossSliceIntegration: "Passed",
  requirementCoverage: "Covered",
  verificationClasses: "| Class | Evidence | Verdict |\n| --- | --- | --- |\n| Contract | focused test | PASS |",
  verdictRationale: "All current database evidence passes.",
};

const closeout: MilestoneCompletionCloseout = {
  title: "Milestone lifecycle capstone",
  oneLiner: "The adopted Milestone lifecycle converged from database facts.",
  narrative: "Validation, completion, and full-redo reopen remained atomic and replay-safe.",
  successCriteriaResults: "All success criteria passed.",
  definitionOfDoneResults: "All completion conditions passed.",
  requirementOutcomes: "Current cancellation Waivers authorize intentional omissions.",
  keyDecisions: ["The database is authoritative"],
  keyFiles: ["src/resources/extensions/gsd/milestone-lifecycle-domain-operation.ts"],
  lessonsLearned: ["Readable projections never authorize lifecycle state"],
  followUps: "None.",
  deviations: "None.",
};

const WORKER_SCRIPT = `
  import { existsSync, writeFileSync } from "node:fs";

  const [databaseHref, lifecycleHref, dbPath, readyPath, attemptPath, releasePath, requestJson] = process.argv.slice(-7);
  const [{ openDatabase, closeDatabase }, { completeMilestone }] = await Promise.all([
    import(databaseHref),
    import(lifecycleHref),
  ]);
  if (!openDatabase(dbPath)) throw new Error("contention worker could not open the workflow database");
  writeFileSync(readyPath, String(process.pid), "utf8");
  while (!existsSync(releasePath)) await new Promise((resolve) => setTimeout(resolve, 2));
  writeFileSync(attemptPath, String(process.pid), "utf8");

  const outcome = {};
  try {
    outcome.receipt = completeMilestone(JSON.parse(requestJson));
  } catch (error) {
    outcome.error = {
      code: String(error?.code ?? "UNKNOWN"),
      message: String(error?.message ?? error),
    };
  } finally {
    closeDatabase();
  }
  process.stdout.write("MILESTONE_OUTCOME=" + JSON.stringify(outcome) + "\\n");
`;

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter, "capstone database must be open");
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
    sourceTransport: "internal",
    actorType: "agent",
    actorId: "milestone-capstone-test",
    traceId: `trace/${idempotencyKey}`,
    turnId: `turn/${idempotencyKey}`,
  };
}

function executeAtFence(
  operationType: string,
  idempotencyKey: string,
  write: (context: Readonly<DomainOperationContext>) => void,
  event?: () => {
    eventType: string;
    entityType: string;
    entityId: string;
    payload: Record<string, string>;
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
    const emitted = event?.() ?? {
      eventType: operationType,
      entityType: "milestone",
      entityId: "M001",
      payload: { idempotencyKey },
    };
    return {
      events: [{
        ...emitted,
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

function lifecycleId(itemKind: "slice" | "task", sliceId: string, taskId?: string): string {
  const taskClause = taskId === undefined ? "task_id IS NULL" : `task_id = '${taskId}'`;
  return String(row(`
    SELECT lifecycle_id FROM workflow_item_lifecycles
    WHERE item_kind = '${itemKind}' AND milestone_id = 'M001'
      AND slice_id = '${sliceId}' AND ${taskClause}
  `).lifecycle_id);
}

function currentSourceRevision(root: string): string {
  const source = captureVerificationSourceSnapshot([{ id: "project", cwd: root }]);
  if (!source.ok) throw new Error(source.error);
  return source.snapshot.aggregateRevision;
}

function createFixture(): CapstoneFixture {
  const root = mkdtempSync(join(tmpdir(), "gsd-milestone-capstone-"));
  tempDirs.add(root);
  mkdirSync(join(root, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(join(root, ".gsd", "milestones", "M001", "M001-CONTEXT.md"), "# M001\n");
  writeFileSync(join(root, "source.ts"), "export const source = 'capstone-r1';\n");
  runGit(root, ["init"]);
  runGit(root, ["config", "user.email", "test@example.com"]);
  runGit(root, ["config", "user.name", "Test"]);
  runGit(root, ["add", "source.ts"]);
  runGit(root, ["commit", "-m", "fixture r1"]);

  const dbPath = join(root, ".gsd", "gsd.db");
  assert.equal(openDatabase(dbPath), true);
  insertMilestone({ id: "M001", title: "Milestone lifecycle capstone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Delivered Slice", status: "complete" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "complete" });
  insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", status: "skipped" });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Omitted Slice", status: "skipped" });
  insertTask({ id: "T03", sliceId: "S02", milestoneId: "M001", status: "skipped" });
  db().exec(`
    INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status,
      project_root_realpath
    ) VALUES (
      'capstone-worker', 'test-host', 1, '2026-07-14T00:00:00.000Z', 'test',
      '2026-07-14T00:00:00.000Z', 'active', '/tmp/project'
    );
    INSERT INTO milestone_leases (
      milestone_id, worker_id, fencing_token, acquired_at, expires_at, status
    ) VALUES (
      'M001', 'capstone-worker', 7, '2026-07-14T00:00:00.000Z',
      '2099-07-14T00:00:00.000Z', 'held'
    );
    INSERT INTO requirements (id, class, status, description) VALUES
      ('REQ-T02-CANCEL', 'quality-attribute', 'active', 'T02 omission remains explicit');
  `);
  executeAtFence("test.milestone-capstone.seed", "fixture/milestone-capstone/seed", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "ready",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "slice", milestoneId: "M001", sliceId: "S01", lifecycleStatus: "completed",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01",
      lifecycleStatus: "completed",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T02",
      lifecycleStatus: "cancelled",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "slice", milestoneId: "M001", sliceId: "S02", lifecycleStatus: "cancelled",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S02", taskId: "T03",
      lifecycleStatus: "cancelled",
    });
  });

  let sliceWaiverId = "";
  executeAtFence("slice.cancel", "fixture/milestone-capstone/slice-waiver", (context) => {
    sliceWaiverId = grantSliceCancellationWaiver(context, {
      lifecycleId: lifecycleId("slice", "S02"),
      milestoneId: "M001",
      sliceId: "S02",
      rationale: "S02 is intentionally omitted from this Milestone.",
      grantedByActorType: "policy",
    }).waiverId;
  }, () => ({
    eventType: "slice.cancelled",
    entityType: "slice",
    entityId: "M001/S02",
    payload: {
      sliceLifecycleId: lifecycleId("slice", "S02"),
      waiverId: sliceWaiverId,
    },
  }));
  const taskWaiver = grantTaskWaiver({
    invocation: invocation("fixture/milestone-capstone/task-waiver"),
    lifecycleId: lifecycleId("task", "S01", "T02"),
    requirementId: "REQ-T02-CANCEL",
    scope: "M001/S01/T02 cancellation",
    rationale: "T02 is intentionally omitted.",
    grantedByActorType: "policy",
  });
  recordTaskRequirementDisposition({
    invocation: invocation("fixture/milestone-capstone/task-disposition"),
    requirementId: "REQ-T02-CANCEL",
    disposition: "waived",
    waiverId: taskWaiver.waiverId,
    rationale: "The current Waiver authorizes T02 omission.",
  });

  return {
    root,
    dbPath,
    sourceRevision: currentSourceRevision(root),
    waiverIds: [sliceWaiverId, taskWaiver.waiverId],
  };
}

function runGit(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

async function validate(root: string, key: string) {
  const result = await handleValidateMilestone(validationParams, root, {
    invocation: invocation(key),
    skipBrowserEvidenceGate: true,
  });
  assert.ok(!("error" in result), `validation failed: ${"error" in result ? result.error : ""}`);
  return result;
}

function completionRequest(key: string, sourceRevision: string) {
  return {
    invocation: invocation(key),
    milestoneId: "M001",
    sourceRevision,
    closeout,
    audit: {
      actorName: "milestone-capstone",
      triggerReason: "Current validation and terminal descendants",
    },
  };
}

function reopenRequest(key: string) {
  return {
    invocation: invocation(key),
    milestoneId: "M001",
    reason: "A verified regression requires a full Milestone redo.",
    audit: {
      actorName: "milestone-capstone",
      triggerReason: "Verified post-completion regression",
    },
  };
}

function canonicalSnapshot(): Record<string, unknown> {
  return {
    authority: rows("SELECT * FROM project_authority ORDER BY singleton"),
    milestones: rows("SELECT * FROM milestones ORDER BY id"),
    slices: rows("SELECT * FROM slices ORDER BY milestone_id, id"),
    tasks: rows("SELECT * FROM tasks ORDER BY milestone_id, slice_id, id"),
    operations: rows("SELECT * FROM workflow_operations ORDER BY resulting_revision"),
    lifecycles: rows("SELECT * FROM workflow_item_lifecycles ORDER BY item_kind, milestone_id, slice_id, task_id"),
    attempts: rows("SELECT * FROM workflow_execution_attempts ORDER BY lifecycle_id, attempt_number"),
    results: rows("SELECT * FROM workflow_attempt_results ORDER BY lifecycle_id, created_at"),
    criteria: rows("SELECT * FROM workflow_acceptance_criteria ORDER BY lifecycle_id, created_at"),
    verdicts: rows("SELECT * FROM workflow_technical_verdicts ORDER BY lifecycle_id, created_at"),
    evidence: rows("SELECT * FROM workflow_verification_evidence ORDER BY lifecycle_id, created_at"),
    waivers: rows("SELECT * FROM workflow_waivers ORDER BY project_revision, waiver_id"),
    dispositions: rows("SELECT * FROM workflow_requirement_dispositions ORDER BY project_revision"),
    events: rows("SELECT * FROM workflow_domain_events ORDER BY project_revision, event_index"),
    outbox: rows("SELECT * FROM workflow_outbox ORDER BY outbox_id"),
    projections: rows("SELECT * FROM workflow_projection_work ORDER BY source_project_revision, projection_key"),
  };
}

function immutableVerificationHistory(): Record<string, unknown> {
  return {
    attempts: rows("SELECT * FROM workflow_execution_attempts ORDER BY lifecycle_id, attempt_number"),
    results: rows("SELECT * FROM workflow_attempt_results ORDER BY lifecycle_id, created_at"),
    criteria: rows("SELECT * FROM workflow_acceptance_criteria ORDER BY lifecycle_id, created_at"),
    verdicts: rows("SELECT * FROM workflow_technical_verdicts ORDER BY lifecycle_id, created_at"),
    evidence: rows("SELECT * FROM workflow_verification_evidence ORDER BY lifecycle_id, created_at"),
  };
}

async function proveFaultAndLostResponse(
  fixture: CapstoneFixture,
  operationType: string,
  run: () => unknown | Promise<unknown>,
  isReplay: (result: unknown) => boolean,
): Promise<void> {
  const before = canonicalSnapshot();
  _setDomainOperationFaultForTest("after-projections");
  await assert.rejects(async () => run(), /domain operation fault: after-projections/i);
  _setDomainOperationFaultForTest(null);
  assert.deepEqual(canonicalSnapshot(), before, `${operationType} must leave zero precommit residue`);

  _setDomainOperationFaultForTest("after-commit");
  await assert.rejects(async () => run(), /domain operation fault: after-commit/i);
  _setDomainOperationFaultForTest(null);
  const committedLineage = canonicalSnapshot();

  closeDatabase();
  clearPathCache();
  clearParseCache();
  assert.equal(openDatabase(fixture.dbPath), true);
  const replayed = await run();

  assert.equal(isReplay(replayed), true, `${operationType} must report an exact replay`);
  assert.equal(row(`
    SELECT COUNT(*) AS count FROM workflow_operations
    WHERE operation_type = '${operationType}'
  `).count, 1);
  assert.deepEqual(canonicalSnapshot(), committedLineage, `${operationType} replay must add no lineage`);
}

function spawnWorker(
  fixture: CapstoneFixture,
  readyPath: string,
  attemptPath: string,
  releasePath: string,
  request: ReturnType<typeof completionRequest>,
): ContentionWorker {
  const resolver = join(process.cwd(), "src/resources/extensions/gsd/tests/resolve-ts.mjs");
  const databaseHref = pathToFileURL(
    join(process.cwd(), "src/resources/extensions/gsd/gsd-db.ts"),
  ).href;
  const lifecycleHref = pathToFileURL(
    join(process.cwd(), "src/resources/extensions/gsd/milestone-lifecycle-domain-operation.ts"),
  ).href;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawn(process.execPath, [
    "--import",
    resolver,
    "--experimental-strip-types",
    "--input-type=module",
    "--eval",
    WORKER_SCRIPT,
    databaseHref,
    lifecycleHref,
    fixture.dbPath,
    readyPath,
    attemptPath,
    releasePath,
    JSON.stringify(request),
  ], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForFiles(paths: string[], children: ContentionWorker[]): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!paths.every(existsSync)) {
    const exited = children.find((child) => child.exitCode !== null);
    assert.equal(exited, undefined, "a contention worker exited before the release fence");
    assert.ok(Date.now() < deadline, "contention workers did not reach the release fence");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function collectChild(child: ContentionWorker): Promise<ChildResult> {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function parseOutcome(result: ChildResult): WorkerOutcome {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const line = result.stdout.split("\n").find((entry) => entry.startsWith("MILESTONE_OUTCOME="));
  assert.ok(line, `contention worker did not return an outcome: ${result.stdout}`);
  return JSON.parse(line.slice("MILESTONE_OUTCOME=".length)) as WorkerOutcome;
}

async function runContention(sameKey: boolean): Promise<WorkerOutcome[]> {
  const fixture = createFixture();
  await validate(fixture.root, `capstone/contention/${sameKey ? "same" : "different"}/validate`);
  const readyPaths = [join(fixture.root, "worker-1-ready"), join(fixture.root, "worker-2-ready")];
  const attemptPaths = [join(fixture.root, "worker-1-attempt"), join(fixture.root, "worker-2-attempt")];
  const releasePath = join(fixture.root, "workers-release");
  const firstKey = `capstone/contention/${sameKey ? "same" : "different"}/complete`;
  const requests = [
    completionRequest(firstKey, fixture.sourceRevision),
    completionRequest(sameKey ? firstKey : `${firstKey}/competitor`, fixture.sourceRevision),
  ];
  const children = readyPaths.map((readyPath, index) =>
    spawnWorker(fixture, readyPath, attemptPaths[index]!, releasePath, requests[index]!));
  const results = children.map(collectChild);
  let lockHeld = false;
  try {
    await waitForFiles(readyPaths, children);
    db().exec("BEGIN IMMEDIATE");
    lockHeld = true;
    writeFileSync(releasePath, "go\n");
    await waitForFiles(attemptPaths, children);
    await new Promise((resolve) => setTimeout(resolve, 50));
    db().exec("COMMIT");
    lockHeld = false;
    return (await Promise.all(results)).map(parseOutcome);
  } finally {
    if (lockHeld) db().exec("ROLLBACK");
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    await Promise.allSettled(results);
  }
}

afterEach(() => {
  _setDomainOperationFaultForTest(null);
  clearPathCache();
  clearParseCache();
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("deep hierarchy rejects stale source, then completes and fully reopens from current DB facts", { concurrency: false }, async () => {
  const fixture = createFixture();
  await validate(fixture.root, "capstone/deep/validate-r1");
  const beforeStaleCompletion = canonicalSnapshot();

  writeFileSync(join(fixture.root, "source.ts"), "export const source = 'capstone-r2';\n");
  runGit(fixture.root, ["add", "source.ts"]);
  runGit(fixture.root, ["commit", "-m", "fixture r2"]);
  const revisedSource = currentSourceRevision(fixture.root);
  assert.notEqual(revisedSource, fixture.sourceRevision);
  assert.throws(
    () => completeMilestone(completionRequest("capstone/deep/stale-complete", revisedSource)),
    /source|stale|validation/i,
  );
  assert.deepEqual(canonicalSnapshot(), beforeStaleCompletion, "stale completion must leave zero residue");

  await validate(fixture.root, "capstone/deep/validate-r2");
  const descendantsBefore = {
    slices: rows("SELECT * FROM slices ORDER BY id"),
    tasks: rows("SELECT * FROM tasks ORDER BY slice_id, id"),
    lifecycles: rows(`
      SELECT * FROM workflow_item_lifecycles
      WHERE item_kind IN ('slice', 'task')
      ORDER BY item_kind, slice_id, task_id
    `),
  };
  const completed = completeMilestone(completionRequest("capstone/deep/complete", revisedSource));
  assert.equal(completed.status, "committed");
  assert.deepEqual(completed.waiverIds.sort(), [...fixture.waiverIds].sort());
  assert.deepEqual({
    slices: rows("SELECT * FROM slices ORDER BY id"),
    tasks: rows("SELECT * FROM tasks ORDER BY slice_id, id"),
    lifecycles: rows(`
      SELECT * FROM workflow_item_lifecycles
      WHERE item_kind IN ('slice', 'task')
      ORDER BY item_kind, slice_id, task_id
    `),
  }, descendantsBefore, "completion must verify descendants without rewriting them");

  const historyBeforeReopen = immutableVerificationHistory();
  const reopened = reopenMilestone(reopenRequest("capstone/deep/reopen"));
  assert.equal(reopened.status, "committed");
  assert.deepEqual(immutableVerificationHistory(), historyBeforeReopen);
  assert.deepEqual(rows("SELECT id, status FROM milestones"), [{ id: "M001", status: "active" }]);
  assert.deepEqual(rows("SELECT id, status FROM slices ORDER BY id"), [
    { id: "S01", status: "in_progress" },
    { id: "S02", status: "in_progress" },
  ]);
  assert.deepEqual(rows("SELECT id, status FROM tasks ORDER BY id"), [
    { id: "T01", status: "pending" },
    { id: "T02", status: "pending" },
    { id: "T03", status: "pending" },
  ]);
  assert.equal(row(`
    SELECT COUNT(*) AS count FROM workflow_item_lifecycles
    WHERE milestone_id = 'M001' AND lifecycle_status <> 'ready'
  `).count, 0);
  assert.equal(row(`
    SELECT COUNT(*) AS count FROM workflow_waivers
    WHERE waiver_id IN ('${fixture.waiverIds.join("','")}') AND waiver_status = 'revoked'
  `).count, fixture.waiverIds.length);
});

test("validation rolls back late faults and replays after a lost response and DB restart", { concurrency: false }, async () => {
  const fixture = createFixture();
  const key = "capstone/fault/validate";
  await proveFaultAndLostResponse(
    fixture,
    "milestone.validate",
    () => handleValidateMilestone(validationParams, fixture.root, {
      invocation: invocation(key),
      skipBrowserEvidenceGate: true,
    }),
    (result) => Boolean((result as { duplicate?: boolean }).duplicate),
  );
});

test("completion rolls back late faults and replays after a lost response and DB restart", { concurrency: false }, async () => {
  const fixture = createFixture();
  await validate(fixture.root, "capstone/fault/complete/validate");
  const request = completionRequest("capstone/fault/complete", fixture.sourceRevision);
  await proveFaultAndLostResponse(
    fixture,
    "milestone.complete",
    () => completeMilestone(request),
    (result) => (result as { status?: string }).status === "replayed",
  );
});

test("reopen rolls back late faults and replays after a lost response and DB restart", { concurrency: false }, async () => {
  const fixture = createFixture();
  await validate(fixture.root, "capstone/fault/reopen/validate");
  completeMilestone(completionRequest("capstone/fault/reopen/complete", fixture.sourceRevision));
  const request = reopenRequest("capstone/fault/reopen");
  await proveFaultAndLostResponse(
    fixture,
    "milestone.reopen",
    () => reopenMilestone(request),
    (result) => (result as { status?: string }).status === "replayed",
  );
});

test("same-key multiprocess completion commits once and returns one replay-equivalent receipt", { concurrency: false }, async () => {
  const outcomes = await runContention(true);
  const committed = outcomes.find((outcome) => outcome.receipt?.status === "committed")?.receipt;
  const replayed = outcomes.find((outcome) => outcome.receipt?.status === "replayed")?.receipt;
  assert.ok(committed);
  assert.ok(replayed);
  assert.deepEqual(replayed, { ...committed, status: "replayed" });
  assert.equal(row("SELECT COUNT(*) AS count FROM workflow_operations WHERE operation_type = 'milestone.complete'").count, 1);
  assert.equal(row("SELECT COUNT(*) AS count FROM workflow_domain_events WHERE event_type = 'milestone.completed'").count, 1);
});

test("different-key multiprocess completion allows one winner and one typed rejection", { concurrency: false }, async () => {
  const outcomes = await runContention(false);
  assert.equal(outcomes.filter((outcome) => outcome.receipt?.status === "committed").length, 1);
  const rejected = outcomes.filter((outcome) => outcome.error);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]?.error?.code, "GSD_REVISION_CONFLICT");
  assert.equal(row("SELECT COUNT(*) AS count FROM workflow_operations WHERE operation_type = 'milestone.complete'").count, 1);
  assert.equal(row("SELECT COUNT(*) AS count FROM workflow_domain_events WHERE event_type = 'milestone.completed'").count, 1);
});
