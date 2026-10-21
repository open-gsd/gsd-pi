// Project/App: gsd-pi
// File Purpose: Canonical blocker completion receipts name the recorded recovery action (#2267).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

process.env.GSD_WORKFLOW_EXECUTORS_MODULE = fileURLToPath(
  new URL("../tools/workflow-tool-executors.ts", import.meta.url),
);

import {
  _getAdapter,
  closeDatabase,
  openDatabase,
} from "../gsd-db.ts";
import {
  claimTaskAttempt,
} from "../task-execution-domain-operation.ts";
import {
  readTaskRecoveryRoute,
  recordFailureAndSelectRecovery,
} from "../task-recovery-domain-operation.ts";
import { executeTaskComplete } from "../tools/workflow-tool-executors.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";

const tempDirs = new Set<string>();

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function row(sql: string): Record<string, unknown> {
  return db().prepare(sql).get() ?? {};
}

function invocation(key: string): ExecutionInvocation {
  return {
    idempotencyKey: key,
    sourceTransport: "pi-tool",
    actorType: "agent",
    traceId: key,
  };
}

function completionParams(): Record<string, unknown> {
  return {
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T01",
    oneLiner: "Staged the executor result",
    narrative: "The executor result is ready for independent host verification.",
    verification: "Executor reports the focused test passed.",
    deviations: "None.",
    knownIssues: "None.",
    keyFiles: ["src/task.ts"],
    keyDecisions: ["Host verification owns completion."],
    blockerDiscovered: false,
    verificationEvidence: [{
      command: "npm test",
      exitCode: 0,
      verdict: "pass",
      durationMs: 10,
    }],
  };
}

function createBase(): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-blocker-route-2267-"));
  tempDirs.add(basePath);
  const phaseDir = join(basePath, ".gsd", "phases", "01-test");
  mkdirSync(phaseDir, { recursive: true });
  writeFileSync(join(phaseDir, "01-01-PLAN.md"), [
    "# S01: Completion identity",
    "",
    "## Tasks",
    "",
    "- [ ] **T01: Stage result** `est:10m`",
    "  - Do: Stage executor output",
    "  - Verify: npm test",
    "",
  ].join("\n"));
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  db().exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M001', 'Completion identity', 'active', '2026-07-12T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, created_at)
    VALUES ('M001', 'S01', 'Completion seam', 'active', '2026-07-12T00:00:00.000Z');
    INSERT INTO tasks (milestone_id, slice_id, id, title, status, verify, sequence)
    VALUES ('M001', 'S01', 'T01', 'Stage result', 'in_progress', 'npm test', 1);
  `);
  return basePath;
}

function claimCanonicalAttempt(basePath: string): string {
  db().exec(`
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
      'trace-claim', 'turn-claim', 'worker-1', 7,
      'M001', 'S01', 'T01', 'execute-task', 'M001/S01/T01',
      'claimed', 1, '2026-07-12T00:00:00.000Z'
    );
  `);
  const claim = claimTaskAttempt({
    invocation: invocation("fixture/claim"),
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: Number(row("SELECT id FROM unit_dispatches").id),
  });
  return claim.attemptId;
}

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("a canonical blocker receipt names the recorded recovery action and the resume call", async () => {
  const basePath = createBase();
  const attemptId = claimCanonicalAttempt(basePath);
  const blockerInvocation = invocation("pi:gsd_task_complete:blocker-call");
  const first = await executeTaskComplete({
    ...completionParams(),
    blockerDiscovered: true,
  } as never, basePath, blockerInvocation);
  assert.equal((first.details as Record<string, unknown>).nextStage, "route");

  // The supervisor routes the settled blocker failure with the same durable
  // operation production uses (attempt.route); the surviving worker's retry
  // then replays the completion receipt with the action now on record.
  const routed = recordFailureAndSelectRecovery({
    invocation: invocation("fixture/route-blocker"),
    attemptId,
    resultId: String((first.details as Record<string, unknown>).resultId),
    owner: "agent",
    classification: { failureKind: "fatal" },
    summary: "A blocker was discovered.",
    evidence: { source: "executor" },
    rationale: "Route the recorded blocker.",
  });
  assert.ok(routed.recoveryActionId);

  const replay = await executeTaskComplete({
    ...completionParams(),
    blockerDiscovered: true,
  } as never, basePath, blockerInvocation);

  const details = replay.details as Record<string, unknown>;
  assert.equal(typeof details.recoveryActionId, "string");
  assert.ok((details.recoveryActionId as string).length > 0);
  assert.equal(details.recoveryActionId, routed.recoveryActionId);
  assert.equal(details.action, routed.action);
  assert.equal(details.resumeEligible, true);
  assert.equal(readTaskRecoveryRoute(attemptId)?.recoveryActionId, details.recoveryActionId);
  const text = String(replay.content[0]?.text);
  assert.ok(
    text.includes(`Recovery action ${routed.recoveryActionId} (${routed.action}) is eligible for resume`),
    `notification must name the recovery action: ${text}`,
  );
  assert.ok(
    text.includes(`call gsd_task_recovery_resume with recoveryActionId "${routed.recoveryActionId}"`),
    `notification must name the sanctioned resume call: ${text}`,
  );
});

test("a canonical blocker receipt with no recorded recovery action keeps the plain routing notice", async () => {
  const basePath = createBase();
  claimCanonicalAttempt(basePath);

  const result = await executeTaskComplete({
    ...completionParams(),
    blockerDiscovered: true,
  } as never, basePath, invocation("pi:gsd_task_complete:blocker-call"));

  assert.equal(result.isError, undefined);
  const details = result.details as Record<string, unknown>;
  assert.equal(details.nextStage, "route");
  assert.equal("recoveryActionId" in details, false);
  assert.equal(
    String(result.content[0]?.text),
    "Recorded blocker for task T01; awaiting recovery routing.",
  );
});

test("a canonical non-blocker completion stays on the verification notice without recovery fields", async () => {
  const basePath = createBase();
  claimCanonicalAttempt(basePath);

  const result = await executeTaskComplete(
    completionParams() as never,
    basePath,
    invocation("pi:gsd_task_complete:verify-call"),
  );

  assert.equal(result.isError, undefined);
  const details = result.details as Record<string, unknown>;
  assert.equal(details.nextStage, "verify");
  assert.equal("recoveryActionId" in details, false);
  assert.equal("action" in details, false);
  assert.equal(
    String(result.content[0]?.text),
    "Staged task T01; awaiting host verification before completion.",
  );
});
