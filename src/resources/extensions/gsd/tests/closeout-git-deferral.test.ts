// Project/App: gsd-pi
// File Purpose: Tests closeout git action deferral policy for auto-mode units.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { postUnitPreVerification, shouldDeferCloseoutGitAction, type PostUnitContext } from "../auto-post-unit.ts";
import { AutoSession } from "../auto/session.ts";
import {
  _getAdapter,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  insertVerificationEvidence,
  openDatabase,
} from "../gsd-db.ts";
import {
  recordToolCall,
  recordToolResult,
  resetEvidence,
  saveEvidenceToDisk,
} from "../safety/evidence-collector.ts";
import {
  claimTaskAttempt,
  readLatestTaskAttempt,
  settleTaskAttempt,
} from "../task-execution-domain-operation.ts";
import { readTaskRecoveryRoute } from "../task-recovery-domain-operation.ts";
import { recaptureVerifiedSourceAfterDeferredCloseout } from "../auto/verified-source-recapture.ts";
import { captureVerificationSourceSnapshot } from "../verification-source-integrity.ts";
import {
  readTaskTechnicalVerdict,
  recordTaskTechnicalVerdict,
} from "../task-verification-domain-operation.ts";
import { cleanup, git, makeTempRepo } from "./test-utils.ts";

function settleCanonicalTaskForHostVerification(basePath: string): void {
  const db = _getAdapter();
  assert.ok(db, "DB should be open before claiming canonical task authority");
  const now = "2026-07-12T00:00:00.000Z";
  db.prepare(`
    INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status,
      project_root_realpath
    ) VALUES ('evidence-worker', 'test-host', 1, ?, 'test', ?, 'active', ?)
  `).run(now, now, basePath);
  db.prepare(`
    INSERT INTO milestone_leases (
      milestone_id, worker_id, fencing_token, acquired_at, expires_at, status
    ) VALUES ('M001', 'evidence-worker', 7, ?, '2099-07-12T00:00:00.000Z', 'held')
  `).run(now);
  const dispatch = db.prepare(`
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES (
      'evidence-trace', 'evidence-turn', 'evidence-worker', 7,
      'M001', 'S01', 'T01', 'execute-task', 'M001/S01/T01',
      'claimed', 1, ?
    )
  `).run(now) as { lastInsertRowid: number | bigint };
  const claim = claimTaskAttempt({
    invocation: {
      idempotencyKey: "fixture:evidence-xref:claim",
      sourceTransport: "internal",
      actorType: "agent",
      actorId: "evidence-worker",
    },
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    workerId: "evidence-worker",
    milestoneLeaseToken: 7,
    coordinationDispatchId: Number(dispatch.lastInsertRowid),
  });
  settleTaskAttempt({
    invocation: {
      idempotencyKey: "fixture:evidence-xref:settle",
      sourceTransport: "internal",
      actorType: "agent",
      actorId: "evidence-worker",
    },
    attemptId: claim.attemptId,
    outcome: "succeeded",
    failureClass: "none",
    summary: "Executor result is ready for host evidence verification.",
    output: { verification: "npm test" },
  });
}

test("execute-task defers closeout git action until verification passes", () => {
  assert.equal(shouldDeferCloseoutGitAction("execute-task"), true);
});

test("non execute-task units keep pre-verification closeout git action", () => {
  assert.equal(shouldDeferCloseoutGitAction("plan-slice"), false);
  assert.equal(shouldDeferCloseoutGitAction("complete-slice"), false);
});

test("blocking evidence-xref routes recovery and clears evidence before pausing", async () => {
  const base = makeTempRepo("gsd-evidence-xref-commit-before-pause-");

  try {
    writeFileSync(join(base, ".gitignore"), ".gsd/\n");
    git(base, "add", ".gitignore");
    git(base, "commit", "-m", "chore: ignore gsd runtime");

    openDatabase(":memory:");
    insertMilestone({ id: "M001", title: "Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "active" });
    insertTask({
      id: "T01",
      sliceId: "S01",
      milestoneId: "M001",
      title: "Add app entrypoint",
      status: "complete",
      oneLiner: "Added app entrypoint",
      keyFiles: ["app.js"],
      planning: {
        description: "Create app entrypoint",
        estimate: "small",
        files: ["app.js"],
        verify: "npm test",
        inputs: [],
        expectedOutput: ["app.js"],
        observabilityImpact: "none",
      },
    });
    insertVerificationEvidence({
      taskId: "T01",
      sliceId: "S01",
      milestoneId: "M001",
      command: "npm test",
      exitCode: 0,
      verdict: "passed",
      durationMs: 10,
    });
    settleCanonicalTaskForHostVerification(base);

    writeFileSync(join(base, "app.js"), "console.log('ready');\n");
    resetEvidence();
    recordToolCall("call-1", "bash", { command: "npm test" });
    recordToolResult("call-1", "bash", "Command exited with code 1\nfailed\n", true);
    saveEvidenceToDisk(base, "M001", "S01", "T01");

    const s = new AutoSession();
    s.active = true;
    s.basePath = base;
    s.currentUnit = { type: "execute-task", id: "M001/S01/T01", startedAt: Date.now() };

    let pauseCalled = false;
    const notifications: string[] = [];
    const pctx: PostUnitContext = {
      s,
      ctx: {
        ui: { notify: (message: string) => notifications.push(message) },
      } as unknown as PostUnitContext["ctx"],
      pi: {} as PostUnitContext["pi"],
      buildSnapshotOpts: () => ({}),
      lockBase: () => base,
      stopAuto: async () => {},
      pauseAuto: async () => {
        pauseCalled = true;
        assert.equal(git(base, "status", "--short"), "", "task work must be committed before pauseAuto runs");
      },
      updateProgressWidget: () => {},
    };

    const result = await postUnitPreVerification(pctx, {
      skipSettleDelay: true,
      skipWorktreeSync: true,
    });

    // #1641 / #1642 / #1649: the blocking branch now settles/routes the Attempt
    // and returns the dedicated "evidence-xref-blocked" signal so finalize never
    // enters the verified-task publication boundary.
    assert.equal(result, "evidence-xref-blocked");
    assert.equal(pauseCalled, true);
    assert.ok(
      notifications.some((message) => message.includes("claimed passing verification")),
      `expected evidence-xref notification, got: ${notifications.join("\n")}`,
    );

    const commitMessage = git(base, "log", "-1", "--pretty=%B");
    assert.match(commitMessage, /^feat: Added app entrypoint/m);
    assert.match(commitMessage, /GSD-Task: S01\/T01/);

    const attempt = readLatestTaskAttempt({
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
    });
    assert.equal(attempt?.nextStage, "route");
    const recovery = attempt ? readTaskRecoveryRoute(attempt.attemptId) : null;
    assert.equal(recovery?.action, "remediate");
    assert.ok(recovery?.recoveryActionId, "blocking mismatch must mint a recovery action");
    assert.equal(
      existsSync(join(base, ".gsd", "safety", "evidence-M001-S01-T01.json")),
      false,
      "blocking mismatch must clear persisted evidence before pausing",
    );
  } finally {
    resetEvidence();
    closeDatabase();
    cleanup(base);
  }
});

test("deferred closeout source recapture invalidates a stale passing verdict", () => {
  const base = makeTempRepo("gsd-source-recapture-");
  try {
    writeFileSync(join(base, ".gitignore"), ".gsd/\n");
    writeFileSync(join(base, "tracked.txt"), "verified\n");
    git(base, "add", ".gitignore", "tracked.txt");
    git(base, "commit", "-m", "fixture");

    openDatabase(":memory:");
    insertMilestone({ id: "M001", title: "Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "active" });
    insertTask({
      id: "T01",
      sliceId: "S01",
      milestoneId: "M001",
      title: "Add app entrypoint",
      status: "in_progress",
    });
    settleCanonicalTaskForHostVerification(base);
    const attempt = readLatestTaskAttempt({ milestoneId: "M001", sliceId: "S01", taskId: "T01" });
    assert.ok(attempt);
    const source = captureVerificationSourceSnapshot([{ id: "root", cwd: base }]);
    assert.equal(source.ok, true, source.ok ? undefined : source.error);
    recordTaskTechnicalVerdict({
      invocation: {
        idempotencyKey: "fixture:source-recapture:verdict",
        sourceTransport: "internal",
        actorType: "agent",
      },
      attemptId: attempt.attemptId,
      testedSourceRevision: source.snapshot.aggregateRevision,
      verdict: "pass",
      rationale: "Host verification passed before deferred closeout git.",
      evidence: {
        evidenceClass: "command",
        commandOrTool: "npm test",
        workingDirectory: base,
        startedAt: "2026-07-12T00:02:00.000Z",
        endedAt: "2026-07-12T00:02:01.000Z",
        exitCode: 0,
        observation: "passed",
        durableOutputRef: "db://host-verification/attempt-1",
        environment: { runner: "node-test", platform: "test" },
      },
    });

    writeFileSync(join(base, "tracked.txt"), "rewritten by pre-commit hook\n");
    assert.equal(recaptureVerifiedSourceAfterDeferredCloseout({
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      basePath: base,
    }), "retry");
    assert.equal(readTaskTechnicalVerdict(attempt.attemptId)?.verdict, "inconclusive");
  } finally {
    closeDatabase();
    cleanup(base);
  }
});
