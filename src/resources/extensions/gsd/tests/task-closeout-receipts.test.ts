// Project/App: gsd-pi
// File Purpose: Behavior contract for the Task Closeout Plan receipts
// (ADR-050), on a real git repository and a real SQLite database: the source
// commit settles as Closeout Effect ordinal 1 before a Task publishes, a
// refused commit leaves the Task unpublished with its repair retry stored,
// a restart recognizes an already-made commit, and `slice.complete` refuses
// while a Task of the Slice has no receipt.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { AutoSession } from "../auto/session.ts";
import { runFinalize } from "../auto/finalize.ts";
import {
  isTaskSourceCommitSettled,
  settleTaskSourceCommitEffect,
} from "../auto/task-source-commit.ts";
import { runTurnGitAction } from "../git-service.ts";
import { clearParseCache } from "../files.ts";
import { _clearGsdRootCache, clearPathCache } from "../paths.ts";
import { clearGSDPreferencesCache } from "../preferences.ts";
import {
  _getAdapter,
  closeDatabase,
  openDatabase,
} from "../gsd-db.ts";
import { readStoredUnitRetry } from "../db/unit-dispatch-retries.ts";
import { executeDomainOperation } from "../db/domain-operation.ts";
import { readDomainOperationFence } from "../db/writers/lifecycle-commands.ts";
import {
  adoptOrTransitionLifecycle,
  appendKernelCheckpoint,
} from "../db/writers/lifecycle-commands.ts";
import { TASK_SOURCE_COMMIT_EFFECT } from "../db/writers/closeout.ts";
import { recordTaskTechnicalVerdict } from "../task-verification-domain-operation.ts";
import {
  claimTaskAttempt,
  settleTaskAttempt,
} from "../task-execution-domain-operation.ts";
import {
  prepareTaskCloseout,
  readTaskCloseoutPlan,
  settledTaskSourceCommitReceipt,
} from "../task-closeout.ts";
import {
  publishVerifiedTaskCompletion,
  stageTaskCompletion,
} from "../task-completion-compatibility-adapter.ts";
import { completeSlice } from "../slice-lifecycle-domain-operation.ts";
import { captureVerificationSourceSnapshot } from "../verification-source-integrity.ts";
import { writeUnitRuntimeRecord } from "../unit-runtime.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";
import type { DomainOperationContext } from "../db/domain-operation.ts";

const TASK = { milestoneId: "M001", sliceId: "S01", taskId: "T01" };

const tempDirs = new Set<string>();
const savedHome = process.env.HOME;
const savedGsdHome = process.env.GSD_HOME;
const savedCwd = process.cwd();

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter, "the fixture database must be open");
  return adapter;
}

function row(sql: string): Record<string, unknown> {
  return db().prepare(sql).get() ?? {};
}

function invocation(idempotencyKey: string): ExecutionInvocation {
  return {
    idempotencyKey,
    sourceTransport: "pi-tool",
    actorType: "agent",
    actorId: "task-closeout-receipts-test",
    traceId: `trace/${idempotencyKey}`,
    turnId: `turn/${idempotencyKey}`,
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

function commitCount(cwd: string): number {
  return Number(git(cwd, ["rev-list", "--count", "HEAD"]));
}

function headSha(cwd: string): string {
  return git(cwd, ["rev-parse", "HEAD"]);
}

function isolateHome(label: string): void {
  const home = mkdtempSync(join(tmpdir(), `gsd-task-closeout-${label}-home-`));
  tempDirs.add(home);
  process.env.HOME = home;
  process.env.GSD_HOME = join(home, ".gsd");
  mkdirSync(process.env.GSD_HOME, { recursive: true });
}

function recordPassingHostVerdict(basePath: string, attemptId: string): string {
  const source = captureVerificationSourceSnapshot([{ id: "project", cwd: basePath }]);
  assert.equal(source.ok, true, source.ok ? undefined : source.error);
  recordTaskTechnicalVerdict({
    invocation: invocation(`host-verification:${attemptId}`),
    attemptId,
    testedSourceRevision: source.snapshot.aggregateRevision,
    verdict: "pass",
    rationale: "Host verification passed.",
    evidence: {
      evidenceClass: "command",
      commandOrTool: "node --test",
      workingDirectory: basePath,
      startedAt: "2026-07-15T00:02:00.000Z",
      endedAt: "2026-07-15T00:02:01.000Z",
      exitCode: 0,
      observation: "passed",
      durableOutputRef: `db://host-verification/${attemptId}`,
      environment: { runner: "node-test", platform: "test" },
    },
  });
  return source.snapshot.aggregateRevision;
}

function atFence(
  idempotencyKey: string,
  write: (context: Readonly<DomainOperationContext>) => void,
  event?: { operationType?: string; eventType?: string; entityId?: string; payload?: Record<string, string> },
): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: event?.operationType ?? "test.task-closeout-receipts.fixture",
    idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "agent",
    sourceTransport: "test",
    payload: { idempotencyKey },
  }, (context) => {
    write(context);
    return {
      events: [{
        eventType: event?.eventType ?? "test.task-closeout-receipts.fixture",
        entityType: "task",
        entityId: event?.entityId ?? "M001/S01/T01",
        payload: event?.payload ?? { idempotencyKey },
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

function taskLifecycleStatus(task: { milestoneId: string; sliceId: string; taskId: string }): string | null {
  const found = row(`
    SELECT lifecycle_status FROM workflow_item_lifecycles
    WHERE item_kind = 'task'
      AND milestone_id = '${task.milestoneId}'
      AND slice_id = '${task.sliceId}'
      AND task_id = '${task.taskId}'
  `);
  return found["lifecycle_status"] ? String(found["lifecycle_status"]) : null;
}

function legacyTaskStatus(taskId = "T01"): string {
  return String(row(
    `SELECT status FROM tasks WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = '${taskId}'`,
  ).status);
}

interface Fixture {
  basePath: string;
  attemptId: string;
  testedSourceRevision: string;
}

/**
 * One adopted Task M001/S01/T01 whose Attempt is settled succeeded at the
 * verify stage with a passing host Technical Verdict, in a real git repo with
 * a real SQLite database. The Task's work is an uncommitted change of a
 * tracked file, so the source commit has something to commit. GSD owns the
 * source commit: the fixture preference isolates git worktree-side and keeps
 * the turn action `commit`.
 */
function createTaskFixture(label: string): Fixture {
  const basePath = mkdtempSync(join(tmpdir(), `gsd-task-closeout-${label}-`));
  tempDirs.add(basePath);
  git(basePath, ["init", "-b", "main"]);
  git(basePath, ["config", "user.email", "test@example.com"]);
  git(basePath, ["config", "user.name", "Test User"]);
  writeFileSync(join(basePath, ".gitignore"), ".gsd/\n");
  writeFileSync(join(basePath, "source.ts"), "export const source = 1;\n");
  git(basePath, ["add", "."]);
  git(basePath, ["commit", "-qm", "fixture"]);
  // The Task's work: an uncommitted change of the tracked source file.
  writeFileSync(join(basePath, "source.ts"), "export const source = 2;\n");

  const phaseDir = join(basePath, ".gsd", "phases", "01-test");
  mkdirSync(phaseDir, { recursive: true });
  writeFileSync(join(basePath, ".gsd", "PREFERENCES.md"), "---\ngit:\n  isolation: worktree\n---\n");
  writeFileSync(join(phaseDir, "01-01-PLAN.md"), [
    "# S01: Closeout receipts",
    "",
    "## Tasks",
    "",
    "- [ ] **T01: Publish through receipts** `est:30m`",
    "  - Do: settle the source commit before publication",
    "  - Verify: node --test",
    "",
  ].join("\n"));

  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  db().exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M001', 'Closeout receipts', 'active', '2026-07-15T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, created_at)
    VALUES ('M001', 'S01', 'Receipts', 'active', '2026-07-15T00:00:00.000Z');
    INSERT INTO tasks (
      milestone_id, slice_id, id, title, status, verify, sequence
    ) VALUES (
      'M001', 'S01', 'T01', 'Publish through receipts', 'in_progress', 'node --test', 1
    );
    INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status,
      project_root_realpath
    ) VALUES (
      'worker-1', 'test-host', 1, '2026-07-15T00:00:00.000Z', 'test',
      '2026-07-15T00:00:00.000Z', 'active', '${basePath.replaceAll("'", "''")}'
    );
    INSERT INTO milestone_leases (
      milestone_id, worker_id, fencing_token, acquired_at, expires_at, status
    ) VALUES (
      'M001', 'worker-1', 7, '2026-07-15T00:00:00.000Z',
      '2099-07-15T00:00:00.000Z', 'held'
    );
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES (
      'trace-1', 'turn-1', 'worker-1', 7,
      'M001', 'S01', 'T01', 'execute-task', 'M001/S01/T01',
      'claimed', 1, '2026-07-15T00:00:00.000Z'
    );
  `);
  atFence(`fixture/${label}/adopt`, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "in_progress",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "slice", milestoneId: "M001", sliceId: "S01", lifecycleStatus: "in_progress",
    });
  });
  const dispatchId = Number(row("SELECT id FROM unit_dispatches").id);
  const claim = claimTaskAttempt({
    invocation: invocation(`fixture/${label}/claim`),
    task: TASK,
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: dispatchId,
  });
  stageTaskCompletion({
    invocation: invocation(`fixture/${label}/stage`),
    basePath,
    task: TASK,
    completion: {
      oneLiner: "Implemented the receipt seam",
      narrative: "The executor produced a candidate result for host verification.",
      verification: "Agent reported node --test passed; host verification is still required.",
      deviations: "None.",
      knownIssues: "None.",
      keyFiles: ["source.ts"],
      keyDecisions: [],
      blockerDiscovered: false,
      verificationEvidence: [{
        command: "node --test",
        exitCode: 0,
        verdict: "pass",
        durationMs: 10,
      }],
    },
  });
  const testedSourceRevision = recordPassingHostVerdict(basePath, claim.attemptId);
  return { basePath, attemptId: claim.attemptId, testedSourceRevision };
}

interface PublishInput {
  invocation: ExecutionInvocation;
  basePath: string;
  task: { milestoneId: string; sliceId: string; taskId: string };
  attemptId: string;
}

function publishInput(basePath: string, attemptId: string): PublishInput {
  return {
    invocation: invocation(`publish:${attemptId}`),
    basePath,
    task: TASK,
    attemptId,
  };
}

/** A pre-commit hook that refuses every commit, the deterministic hook refusal. */
function installRefusingHook(basePath: string): void {
  const hook = join(basePath, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\necho 'slot blocked' >&2\nexit 1\n");
  execFileSync("chmod", ["+x", hook]);
}

function removeRefusingHook(basePath: string): void {
  rmSync(join(basePath, ".git", "hooks", "pre-commit"));
}

function settleSourceCommit(basePath: string, unitId = "M001/S01/T01"): Promise<{ settled: boolean }> {
  return settleTaskSourceCommitEffect({
    basePath,
    unitType: "execute-task",
    unitId,
    traceId: "test-trace",
    turnId: "test-turn",
  });
}

interface FinalizeDeps {
  pauseCalls: number;
  stopCalls: number;
  publishCalls: number;
  journal: Array<{ eventType: string; data: Record<string, unknown> }>;
}

function emptyDeps(): FinalizeDeps {
  return { pauseCalls: 0, stopCalls: 0, publishCalls: 0, journal: [] };
}

/**
 * Drive the real finalize phase of the auto loop for the execute-task unit:
 * the publication boundary publishes through the verified pipeline.
 */
async function runTaskFinalize(basePath: string, deps: FinalizeDeps): Promise<unknown> {
  const s = new AutoSession();
  s.active = true;
  s.basePath = basePath;
  s.currentUnit = { type: "execute-task", id: "M001/S01/T01", startedAt: 1 };
  writeUnitRuntimeRecord(basePath, "execute-task", "M001/S01/T01", 1, { phase: "dispatched" });
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: (...args: unknown[]) => void, _timeout?: number, ...args: unknown[]) =>
    originalSetTimeout(handler, 0, ...args)) as typeof setTimeout;
  try {
    return await runFinalize(
      {
        ctx: { ui: { notify() {} } },
        pi: {},
        s,
        deps: {
          clearUnitTimeout() {},
          buildSnapshotOpts() { return {}; },
          stopAuto: async () => { deps.stopCalls++; },
          pauseAuto: async () => { deps.pauseCalls++; },
          checkpointWorkflowDatabase() {},
          updateProgressWidget() {},
          emitJournalEvent: (event: { eventType: string; data: Record<string, unknown> }) => {
            deps.journal.push(event);
          },
          postUnitPreVerification: async () => "continue",
          runPostUnitVerification: async () => "continue",
          postUnitPostVerification: async () => "continue",
        },
        prefs: undefined,
        iteration: 1,
        flowId: "flow-1",
        nextSeq: () => deps.journal.length + 1,
      } as unknown as Parameters<typeof runFinalize>[0],
      {
        unitType: "execute-task",
        unitId: "M001/S01/T01",
        prompt: "",
        finalPrompt: "",
        pauseAfterUatDispatch: false,
        state: {},
        mid: "M001",
        midTitle: "Closeout receipts",
        isRetry: false,
        previousTier: undefined,
      } as unknown as Parameters<typeof runFinalize>[1],
      { consecutiveFinalizeTimeouts: 0 } as unknown as Parameters<typeof runFinalize>[2],
      undefined,
      async () => {
        deps.publishCalls++;
        const attempt = row(`
          SELECT attempt.attempt_id
          FROM workflow_execution_attempts attempt
          JOIN workflow_item_lifecycles lifecycle ON lifecycle.lifecycle_id = attempt.lifecycle_id
          WHERE lifecycle.item_kind = 'task' AND lifecycle.milestone_id = 'M001'
            AND lifecycle.slice_id = 'S01' AND lifecycle.task_id = 'T01'
          ORDER BY attempt.attempt_number DESC LIMIT 1
        `);
        await publishVerifiedTaskCompletion({
          invocation: invocation(`publish:${String(attempt.attempt_id)}`),
          basePath,
          task: TASK,
          attemptId: String(attempt.attempt_id),
        });
      },
    );
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
}

const SLICE_CLOSEOUT = {
  sliceTitle: "Receipts",
  oneLiner: "Completed on receipted Tasks.",
  narrative: "The Slice completed after its Tasks published with their commit receipts.",
  verification: "Host verification passed on the receipted commit.",
  uatContent: "runtime-executable",
  operationalReadiness: "- Health: green",
  deviations: "None.",
  knownLimitations: "None.",
  followUps: "None.",
  provides: [] as string[],
  requires: [] as Array<{ slice: string; provides: string }>,
  affects: [] as string[],
  keyFiles: [] as string[],
  keyDecisions: [] as string[],
  patternsEstablished: [] as string[],
  observabilitySurfaces: [] as string[],
  drillDownPaths: [] as string[],
  requirementsAdvanced: [] as Array<{ id: string; how: string }>,
  requirementsValidated: [] as Array<{ id: string; proof: string }>,
  requirementsSurfaced: [] as string[],
  requirementsInvalidated: [] as Array<{ id: string; what: string }>,
  filesModified: [] as Array<{ path: string; description: string }>,
};

function seedSliceQ8Gate(): void {
  db().prepare(`
    INSERT INTO quality_gates (milestone_id, slice_id, gate_id, scope, task_id, status)
    VALUES ('M001', 'S01', 'Q8', 'slice', '', 'pending')
  `).run();
}

afterEach(() => {
  process.chdir(savedCwd);
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  if (savedGsdHome === undefined) delete process.env.GSD_HOME; else process.env.GSD_HOME = savedGsdHome;
  clearGSDPreferencesCache();
  clearPathCache();
  _clearGsdRootCache();
  clearParseCache();
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("a verified Task publishes only after its source commit settles with a receipt", async () => {
  isolateHome("performed");
  const { basePath, attemptId } = createTaskFixture("performed");
  const commitsBefore = commitCount(basePath);

  const settled = await settleSourceCommit(basePath);

  assert.equal(settled.settled, true, "the source commit effect settles");
  assert.equal(commitCount(basePath), commitsBefore + 1, "the commit ran before publication");
  const receipt = settledTaskSourceCommitReceipt(TASK);
  assert.ok(receipt, "the effect carries a Settlement Receipt");
  assert.equal(receipt?.outcome, "performed", "a created commit performs the effect");
  assert.equal(receipt?.externalRef, headSha(basePath), "the receipt names the commit it settled");

  const published = await publishVerifiedTaskCompletion(publishInput(basePath, attemptId));
  assert.equal(published.status, "committed");
  assert.equal(taskLifecycleStatus(TASK), "completed", "the Task is published");
  assert.equal(legacyTaskStatus(), "complete", "the legacy Task row completed with the publication");

  // The Slice cites the receipt: completing it succeeds now that T01 carries one.
  seedSliceQ8Gate();
  const completion = completeSlice({
    invocation: invocation("slice-complete/receipted"),
    slice: { milestoneId: "M001", sliceId: "S01" },
    closeout: SLICE_CLOSEOUT,
  });
  assert.equal(completion.status, "committed", "the Slice completes over the receipted Task");
  assert.deepEqual(completion.completedTaskIds, ["T01"], "the receipted Task is a completion carrier");
});

test("a refused commit leaves the Task unpublished, stores the repair retry, and releases no dependents", async () => {
  isolateHome("refused");
  const { basePath } = createTaskFixture("refused");
  installRefusingHook(basePath);
  const commitsBefore = commitCount(basePath);

  const deps = emptyDeps();
  const result = await runTaskFinalize(basePath, deps);

  assert.deepEqual(result, { action: "continue" }, "the refused commit re-dispatches the unit");
  assert.equal(deps.publishCalls, 0, "publication never ran: the commit has no receipt");
  assert.equal(commitCount(basePath), commitsBefore, "the refusing hook blocked the commit");

  const receipt = settledTaskSourceCommitReceipt(TASK);
  assert.equal(receipt, null, "a refused commit records no Settlement Receipt");
  const plan = readTaskCloseoutPlan(TASK);
  assert.ok(plan, "the Closeout Plan was prepared before the commit");
  const effect = plan?.effects.find((candidate) => candidate.effectKind === TASK_SOURCE_COMMIT_EFFECT);
  assert.ok(effect && !effect.receipt, "the source-commit effect is unsettled");

  assert.equal(taskLifecycleStatus(TASK), "in_progress", "the Task stays unpublished");
  assert.equal(legacyTaskStatus(), "in_progress", "the legacy Task row stays open");
  assert.equal(
    isTaskSourceCommitSettled(basePath, "M001/S01/T01"),
    false,
    "the legacy post-verification commit still owns this Task",
  );

  const stored = readStoredUnitRetry("execute-task", "M001/S01/T01");
  assert.ok(stored, "the git-commit repair retry is stored on the dispatch row");
  assert.match(stored?.signature ?? "", /^git-commit:1:/, "the retry carries the git-commit signature");
  const retryEvents = deps.journal.filter((event) => event.eventType === "verification-retry");
  assert.equal(retryEvents.length, 1, "the refusal is journaled as a verification-retry");
  assert.equal(deps.pauseCalls, 0, "a bounded refusal repairs instead of pausing");
  assert.equal(deps.stopCalls, 0, "a bounded refusal never stops auto-mode");
});

test("the repair run commits, records the receipt, and publishes the Task", async () => {
  isolateHome("repair");
  const { basePath } = createTaskFixture("repair");
  installRefusingHook(basePath);

  const refusal = await runTaskFinalize(basePath, emptyDeps());
  assert.deepEqual(refusal, { action: "continue" }, "the first run stores the repair retry");
  assert.ok(readStoredUnitRetry("execute-task", "M001/S01/T01"), "the repair retry waits");

  // The repair run: the hook cause is fixed, the loop re-selects the unit and
  // its finalize settles the commit and publishes.
  removeRefusingHook(basePath);
  const deps = emptyDeps();
  const result = await runTaskFinalize(basePath, deps);

  assert.equal(deps.publishCalls, 1, "the repair run published the Task");
  assert.deepEqual(result, { action: "next", data: undefined }, "the repair run completed the unit");
  const receipt = settledTaskSourceCommitReceipt(TASK);
  assert.ok(receipt, "the repair run recorded the receipt");
  assert.equal(receipt?.outcome, "performed", "the repair commit performed the effect");
  assert.equal(taskLifecycleStatus(TASK), "completed", "the Task published after the repair");
  assert.equal(legacyTaskStatus(), "complete", "the legacy Task row completed");
  assert.equal(
    readStoredUnitRetry("execute-task", "M001/S01/T01"),
    null,
    "the settled commit released the repair retry",
  );
});

test("a kill between the commit and its receipt restarts into a recognized receipt, never a second commit", async () => {
  isolateHome("recognized");
  const { basePath, attemptId, testedSourceRevision } = createTaskFixture("recognized");

  // The killed process prepared the plan and made the commit; the receipt
  // never landed.
  prepareTaskCloseout({
    invocation: invocation("killed/prepare"),
    task: TASK,
    attemptId,
    testedSourceRevision,
  });
  runTurnGitAction({
    basePath,
    action: "commit",
    unitType: "execute-task",
    unitId: "M001/S01/T01",
  });
  const commitsAfterKill = commitCount(basePath);
  assert.equal(settledTaskSourceCommitReceipt(TASK), null, "the kill left no receipt");

  // The restart settles the effect from the database facts alone.
  const settled = await settleSourceCommit(basePath);

  assert.equal(settled.settled, true);
  assert.equal(commitCount(basePath), commitsAfterKill, "the restart never commits twice");
  const receipt = settledTaskSourceCommitReceipt(TASK);
  assert.ok(receipt, "the restart recorded the receipt");
  assert.equal(receipt?.outcome, "recognized", "the commit that is already there is recognized");
  assert.equal(receipt?.externalRef, headSha(basePath), "the recognized receipt names the current commit");

  const plans = Number(row("SELECT COUNT(*) AS count FROM workflow_closeout_plans").count);
  assert.equal(plans, 1, "the restart reused the prepared plan");

  const published = await publishVerifiedTaskCompletion(publishInput(basePath, attemptId));
  assert.equal(published.status, "committed");
  assert.equal(taskLifecycleStatus(TASK), "completed", "the Task published on the recognized receipt");
});

test("slice.complete refuses while a terminal Task of the Slice carries no receipt", async () => {
  isolateHome("slice-refusal");
  const { basePath } = createTaskFixture("slice-refusal");

  // T01 publishes through its receipt first, so the Slice has one receipted
  // carrier and one unreceipted one.
  await settleSourceCommit(basePath);
  const published = await publishVerifiedTaskCompletion(publishInput(basePath, ((): string => {
    const attempt = row(`
      SELECT attempt.attempt_id
      FROM workflow_execution_attempts attempt
      JOIN workflow_item_lifecycles lifecycle ON lifecycle.lifecycle_id = attempt.lifecycle_id
      WHERE lifecycle.item_kind = 'task' AND lifecycle.milestone_id = 'M001'
        AND lifecycle.slice_id = 'S01' AND lifecycle.task_id = 'T01'
      ORDER BY attempt.attempt_number DESC LIMIT 1
    `);
    return String(attempt.attempt_id);
  })()));
  assert.equal(published.status, "committed");

  // T02 of the same Slice is terminal in both vocabularies with
  // verdict-backed evidence, but its Closeout Plan's source commit never
  // settled — the shape a side door or an older build leaves behind.
  const t02 = { milestoneId: "M001", sliceId: "S01", taskId: "T02" };
  db().prepare(`
    INSERT INTO tasks (milestone_id, slice_id, id, title, status, verify, sequence)
    VALUES ('M001', 'S01', 'T02', 'Unreceipted sibling', 'in_progress', 'node --test', 2)
  `).run();
  db().prepare(`
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES (
      'trace-2', 'turn-2', 'worker-1', 7,
      'M001', 'S01', 'T02', 'execute-task', 'M001/S01/T02',
      'claimed', 1, '2026-07-15T00:05:00.000Z'
    )
  `).run();
  const t02Dispatch = Number(row("SELECT MAX(id) AS id FROM unit_dispatches").id);
  const t02Attempt = claimTaskAttempt({
    invocation: invocation("fixture/t02/claim"),
    task: t02,
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: t02Dispatch,
  }).attemptId;
  settleTaskAttempt({
    invocation: invocation("fixture/t02/settle"),
    attemptId: t02Attempt,
    outcome: "succeeded",
    failureClass: "none",
    summary: "T02 succeeded at the verify stage.",
    output: {},
  });
  const t02TestedRevision = recordPassingHostVerdict(basePath, t02Attempt);
  prepareTaskCloseout({
    invocation: invocation("fixture/t02/prepare"),
    task: t02,
    attemptId: t02Attempt,
    testedSourceRevision: t02TestedRevision,
  });
  // The side-door publication: the operation and event identity of a real
  // task.completion.publish, without its receipt gate — the shape an older
  // build leaves behind for a verified Task whose commit never settled.
  atFence("fixture/t02/publish", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T02",
      lifecycleStatus: "completed",
    });
    const lifecycleId = String(row(`
      SELECT lifecycle_id FROM workflow_execution_attempts WHERE attempt_id = '${t02Attempt}'
    `).lifecycle_id);
    let previousCheckpointId = String(row(`
      SELECT kernel_checkpoint_id FROM workflow_kernel_checkpoints
      WHERE attempt_id = '${t02Attempt}' AND next_stage = 'verify'
        AND NOT EXISTS (
          SELECT 1 FROM workflow_kernel_checkpoints successor
          WHERE successor.previous_kernel_checkpoint_id = workflow_kernel_checkpoints.kernel_checkpoint_id
        )
    `).kernel_checkpoint_id);
    for (const nextStage of ["route", "closeout", "settled"] as const) {
      const checkpoint = appendKernelCheckpoint(context, {
        lifecycleId,
        attemptId: t02Attempt,
        nextStage,
        previousKernelCheckpointId: previousCheckpointId,
      });
      previousCheckpointId = checkpoint.kernelCheckpointId;
    }
  }, {
    operationType: "task.completion.publish",
    eventType: "task.completion.published",
    entityId: "M001/S01/T02",
    payload: { attemptId: t02Attempt },
  });
  db().prepare(
    `UPDATE tasks SET status = 'complete' WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T02'`,
  ).run();
  assert.equal(settledTaskSourceCommitReceipt(t02), null, "T02 has no receipt");
  assert.equal(taskLifecycleStatus(t02), "completed", "T02 is terminal in the canonical vocabulary");

  seedSliceQ8Gate();
  assert.throws(
    () => completeSlice({
      invocation: invocation("slice-complete/unreceipted"),
      slice: { milestoneId: "M001", sliceId: "S01" },
      closeout: SLICE_CLOSEOUT,
    }),
    (error: Error) => {
      assert.match(error.message, /T02 has no Settlement Receipt for its Closeout Plan source commit/);
      return true;
    },
    "slice.complete refuses while a Task of the Slice has no receipt",
  );
  assert.equal(
    String(row("SELECT status FROM slices WHERE milestone_id = 'M001' AND id = 'S01'").status),
    "active",
    "the Slice stays open",
  );
});
