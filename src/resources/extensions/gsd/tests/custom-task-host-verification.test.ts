// Project/App: gsd-pi
// File Purpose: Real-database integration contract for custom-engine Task host verification.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { publishVerifiedTaskExecution } from "../auto/task-execution-cutover.js";
import {
  requestCustomTaskHumanReviewFromUi,
  resolvePendingCustomTaskHumanReview,
  runCustomEngineHostVerification,
  type HostVerificationEvidence,
} from "../auto/custom-task-host-verification.js";
import {
  composeVerificationInputPayload,
  type VerificationRead,
} from "../auto/workflow-custom-engine-verify-outcome.js";
import { recordNonAdvancingOutcome } from "../auto-liveness-backstop.js";
import { runCustomVerificationWithEvidence } from "../custom-verification.js";
import { resolveTaskRecoveryResumeBasePath } from "../bootstrap/dynamic-tools.js";
import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.js";
import { publishVerifiedTaskCompletion, stageTaskCompletion } from "../task-completion-compatibility-adapter.js";
import { claimTaskAttempt, readLatestTaskAttempt } from "../task-execution-domain-operation.js";
import { resumeTaskRecovery } from "../task-recovery-domain-operation.js";
import { readTaskTechnicalVerdict, recordTaskTechnicalVerdict } from "../task-verification-domain-operation.js";
import { captureVerificationSourceSnapshot } from "../verification-source-integrity.js";

const tempDirs = new Set<string>();

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function row(sql: string): Record<string, unknown> {
  return db().prepare(sql).get() ?? {};
}

function invocation(key: string) {
  return {
    idempotencyKey: key,
    sourceTransport: "internal" as const,
    actorType: "agent",
    actorId: "custom-engine-test",
  };
}

const humanResponseIdentity = {
  actorId: "session-1",
  workerId: "worker-1",
  traceId: "review-trace-1",
  turnId: "review-turn-1",
};

function createFixture(): { basePath: string; attemptId: string } {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-custom-host-verification-"));
  tempDirs.add(basePath);
  execFileSync("git", ["init", "-q"], { cwd: basePath });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: basePath });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: basePath });
  writeFileSync(join(basePath, "tracked.ts"), "export const verified = true;\n");
  execFileSync("git", ["add", "tracked.ts"], { cwd: basePath });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: basePath });

  const phaseDir = join(basePath, ".gsd", "phases", "01-custom");
  mkdirSync(phaseDir, { recursive: true });
  writeFileSync(join(phaseDir, "01-01-PLAN.md"), [
    "# S01: Custom engine",
    "",
    "## Tasks",
    "",
    "- [ ] **T01: Verify custom execution** `est:30m`",
    "  - Do: Complete through the custom engine",
    "  - Verify: custom policy",
    "",
  ].join("\n"));

  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  db().exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M001', 'Custom engine', 'active', '2026-07-12T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, created_at)
    VALUES ('M001', 'S01', 'Host verification', 'active', '2026-07-12T00:00:00.000Z');
    INSERT INTO tasks (milestone_id, slice_id, id, title, status, verify, sequence)
    VALUES ('M001', 'S01', 'T01', 'Verify custom execution', 'in_progress', 'custom policy', 1);
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
      'trace-1', 'turn-1', 'worker-1', 7,
      'M001', 'S01', 'T01', 'execute-task', 'M001/S01/T01',
      'claimed', 1, '2026-07-12T00:00:00.000Z'
    );
  `);
  const claim = claimTaskAttempt({
    invocation: invocation("custom/claim"),
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: Number(row("SELECT id FROM unit_dispatches").id),
  });
  return { basePath, attemptId: claim.attemptId };
}

async function stage(basePath: string, key = "custom/stage"): Promise<void> {
  await stageTaskCompletion({
    invocation: invocation(key),
    basePath,
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    completion: {
      oneLiner: "Custom execution completed",
      narrative: "Candidate Result awaits host verification.",
      verification: "Custom policy owns verification.",
      deviations: "None.",
      knownIssues: "None.",
      keyFiles: ["tracked.ts"],
      keyDecisions: ["Persist host verdict before publication."],
      blockerDiscovered: false,
      verificationEvidence: [],
    },
  });
}

function insertRetryDispatch(attemptNumber: number): number {
  db().prepare(`
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES (
      :trace_id, :turn_id, 'worker-1', 7,
      'M001', 'S01', 'T01', 'execute-task', 'M001/S01/T01',
      'claimed', :attempt_n, :started_at
    )
  `).run({
    ":trace_id": `trace-${attemptNumber}`,
    ":turn_id": `turn-${attemptNumber}`,
    ":attempt_n": attemptNumber,
    ":started_at": `2026-07-12T00:0${attemptNumber}:00.000Z`,
  });
  return Number(row("SELECT MAX(id) AS id FROM unit_dispatches").id);
}

function claimRetry(priorAttemptId: string, attemptNumber: number): string {
  return claimTaskAttempt({
    invocation: invocation(`custom/claim/${attemptNumber}`),
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: insertRetryDispatch(attemptNumber),
    retryOfAttemptId: priorAttemptId,
  }).attemptId;
}

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("custom execute-task persists host verdict and source proof before publication", async () => {
  const { basePath, attemptId } = createFixture();
  await stage(basePath);
  let policyCalls = 0;

  const verified = await runCustomEngineHostVerification({
    unitType: "execute-task",
    basePath,
    unitId: "M001/S01/T01",
    verifyPolicy: async () => { policyCalls++; return "continue"; },
  });
  await publishVerifiedTaskExecution({
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    workerId: "worker-1",
    traceId: "trace-1",
    turnId: "turn-1",
    basePath,
  }, { readLatestTaskAttempt, publishVerifiedTaskCompletion });

  const verdict = readTaskTechnicalVerdict(attemptId);
  assert.equal(verified, "continue");
  assert.equal(policyCalls, 1);
  assert.equal(verdict?.verdict, "pass");
  assert.match(verdict?.testedSourceRevision ?? "", /^sha256:/);
  assert.equal(row("SELECT observation FROM workflow_verification_evidence").observation, "passed");
  assert.equal(row("SELECT status FROM tasks WHERE id = 'T01'").status, "complete");
  assert.equal(readLatestTaskAttempt({ milestoneId: "M001", sliceId: "S01", taskId: "T01" })?.nextStage, "settled");
});

test("custom execute-task invalidates a stale passing verdict and replays result-causal drift recovery", async () => {
  const { basePath, attemptId } = createFixture();
  await stage(basePath);
  assert.equal(await runCustomEngineHostVerification({
    unitType: "execute-task",
    basePath,
    unitId: "M001/S01/T01",
    verifyPolicy: async () => "continue",
  }), "continue");
  writeFileSync(join(basePath, "tracked.ts"), "export const verified = false;\n");

  const replayed = await runCustomEngineHostVerification({
    unitType: "execute-task",
    basePath,
    unitId: "M001/S01/T01",
    verifyPolicy: async () => { throw new Error("stored verdict must not rerun policy"); },
  });

  assert.equal(replayed, "retry");
  assert.equal(readTaskTechnicalVerdict(attemptId)?.verdict, "inconclusive");
  assert.deepEqual(db().prepare(`
    SELECT verdict, supersedes_verdict_id
    FROM workflow_technical_verdicts ORDER BY project_revision
  `).all(), [
    { verdict: "pass", supersedes_verdict_id: null },
    {
      verdict: "inconclusive",
      supersedes_verdict_id: db().prepare(`
        SELECT verdict_id FROM workflow_technical_verdicts WHERE verdict = 'pass'
      `).get()?.["verdict_id"],
    },
  ]);
  assert.deepEqual(row(`
    SELECT observation.result_id, observation.failure_kind, action.action
    FROM workflow_failure_observations observation
    JOIN workflow_recovery_actions action
      ON action.failure_observation_id = observation.failure_observation_id
  `), {
    result_id: readLatestTaskAttempt({ milestoneId: "M001", sliceId: "S01", taskId: "T01" })?.resultId,
    failure_kind: "verification-drift",
    action: "remediate",
  });

  assert.equal(await runCustomEngineHostVerification({
    unitType: "execute-task",
    basePath,
    unitId: "M001/S01/T01",
    verifyPolicy: async () => { throw new Error("stored drift recovery must not rerun policy"); },
  }), "retry");
  assert.equal(Number(row("SELECT COUNT(*) AS count FROM workflow_technical_verdicts").count), 2);
  assert.equal(Number(row("SELECT COUNT(*) AS count FROM workflow_failure_observations").count), 1);
});

test("custom execute-task routes a policy exception as an inconclusive durable failure", async () => {
  const { basePath, attemptId } = createFixture();
  await stage(basePath);

  const outcome = await runCustomEngineHostVerification({
    unitType: "execute-task",
    basePath,
    unitId: "M001/S01/T01",
    verifyPolicy: async () => { throw new Error("verification runner unavailable"); },
  });

  assert.equal(outcome, "retry");
  assert.equal(readTaskTechnicalVerdict(attemptId)?.verdict, "inconclusive");
  assert.match(String(row("SELECT rationale FROM workflow_technical_verdicts").rationale), /runner unavailable/);
  assert.equal(row("SELECT action FROM workflow_recovery_actions").action, "remediate");
});

test("#1674: host verification evidence keeps distinct policy errors and stored verdicts distinct", async () => {
  // ADR-047 §3: paths that return without a policy verdict (or after catching a
  // policy error) must report the inputs they read, or the loop's fallback
  // signature hashes only the disposition and two different host failures share
  // one signature.
  const first = createFixture();
  await stage(first.basePath);
  const firstEvidence: HostVerificationEvidence[] = [];
  assert.equal(await runCustomEngineHostVerification({
    unitType: "execute-task",
    basePath: first.basePath,
    unitId: "M001/S01/T01",
    verifyPolicy: async () => { throw new Error("runner A unavailable"); },
    recordHostEvidence: (evidence) => firstEvidence.push(evidence),
  }), "retry");
  assert.equal(await runCustomEngineHostVerification({
    unitType: "execute-task",
    basePath: first.basePath,
    unitId: "M001/S01/T01",
    verifyPolicy: async () => { throw new Error("stored verdict must not rerun policy"); },
    recordHostEvidence: (evidence) => firstEvidence.push(evidence),
  }), "retry");

  assert.equal(firstEvidence.length, 2);
  assert.equal(firstEvidence[0]?.path, "policy-error");
  assert.equal(firstEvidence[0]?.attemptId, undefined);
  assert.equal(firstEvidence[0]?.verdict, undefined);
  assert.match(firstEvidence[0]?.errorMessage ?? "", /runner A unavailable/);
  assert.equal(firstEvidence[0]?.recovery?.owner, "agent");
  assert.equal(firstEvidence[0]?.recovery?.action, "remediate");
  assert.equal(firstEvidence[1]?.path, "stored-verdict-failed");
  assert.equal(
    firstEvidence[1]?.verdict?.verdictId,
    readTaskTechnicalVerdict(first.attemptId)?.verdictId,
    "the stored-verdict path must carry the verdict identity it read",
  );

  closeDatabase();
  const second = createFixture();
  await stage(second.basePath);
  const secondEvidence: HostVerificationEvidence[] = [];
  assert.equal(await runCustomEngineHostVerification({
    unitType: "execute-task",
    basePath: second.basePath,
    unitId: "M001/S01/T01",
    verifyPolicy: async () => { throw new Error("runner B unavailable"); },
    recordHostEvidence: (evidence) => secondEvidence.push(evidence),
  }), "retry");

  assert.match(secondEvidence[0]?.errorMessage ?? "", /runner B unavailable/);
  assert.notEqual(
    JSON.stringify({ outcome: "retry", hostEvidence: firstEvidence[0] }),
    JSON.stringify({ outcome: "retry", hostEvidence: secondEvidence[0] }),
    "two distinct host failures with the same disposition must not share a signature payload",
  );
});

test("#1674: identical fresh policy errors trip at two without minted identifiers", async () => {
  const { basePath, attemptId: firstAttemptId } = createFixture();
  let attemptId = firstAttemptId;

  const runPolicyError = async (message: string): Promise<{
    payload: string;
    recorded: ReturnType<typeof recordNonAdvancingOutcome>;
  }> => {
    await stage(basePath, `custom/policy-error/${attemptId}`);
    const reads: VerificationRead[] = [];
    const outcome = await runCustomEngineHostVerification({
      unitType: "execute-task",
      basePath,
      unitId: "M001/S01/T01",
      verifyPolicy: async () => { throw new Error(message); },
      recordHostEvidence: (evidence) => reads.push({ source: "host", evidence }),
    });
    const payload = composeVerificationInputPayload({ outcome, reads });
    return {
      payload,
      recorded: recordNonAdvancingOutcome({
        scopeId: basePath,
        guardId: "custom-engine-verify",
        unitType: "execute-task",
        unitId: "M001/S01/T01",
        inputPayload: payload,
      }),
    };
  };

  const first = await runPolicyError("verification runner unavailable");
  attemptId = claimRetry(attemptId, 2);
  const second = await runPolicyError("verification runner unavailable");
  attemptId = claimRetry(attemptId, 3);
  const changed = await runPolicyError("verification runner returned malformed output");

  assert.equal(first.payload, second.payload, "fresh retries with identical inputs must hash identically");
  assert.equal(first.recorded.tripped, false);
  assert.equal(second.recorded.tripped, true, "identical fresh failures must trip at occurrence two");
  assert.notEqual(changed.payload, second.payload, "a changed policy error must change the payload");
  assert.equal(changed.recorded.tripped, false);
});

test("#1674: identical missing-repository failures trip at two", async () => {
  const { basePath, attemptId: firstAttemptId } = createFixture();
  db().prepare(`
    UPDATE tasks SET target_repositories = :targets
    WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
  `).run({ ":targets": JSON.stringify(["missing-repository"]) });
  let attemptId = firstAttemptId;

  const runMissingRepository = async (): Promise<{
    payload: string;
    recorded: ReturnType<typeof recordNonAdvancingOutcome>;
  }> => {
    await stage(basePath, `custom/missing-repository/${attemptId}`);
    const reads: VerificationRead[] = [];
    const outcome = await runCustomEngineHostVerification({
      unitType: "execute-task",
      basePath,
      unitId: "M001/S01/T01",
      verifyPolicy: async () => { throw new Error("missing repositories must bypass policy"); },
      recordHostEvidence: (evidence) => reads.push({ source: "host", evidence }),
    });
    const payload = composeVerificationInputPayload({ outcome, reads });
    return {
      payload,
      recorded: recordNonAdvancingOutcome({
        scopeId: basePath,
        guardId: "custom-engine-verify",
        unitType: "execute-task",
        unitId: "M001/S01/T01",
        inputPayload: payload,
      }),
    };
  };

  const first = await runMissingRepository();
  attemptId = claimRetry(attemptId, 2);
  const second = await runMissingRepository();

  assert.equal(first.payload, second.payload);
  assert.equal(first.recorded.tripped, false);
  assert.equal(second.recorded.tripped, true);
});

test("#1674: post-policy failures include the selected recovery route", async () => {
  const { basePath, attemptId: firstAttemptId } = createFixture();
  writeFileSync(join(basePath, "DEFINITION.yaml"), [
    "version: 1",
    "name: post-policy-route",
    "steps:",
    "  - id: step-1",
    "    name: step-1",
    "    prompt: Do step-1",
    "    produces: output.md",
    "    verify:",
    "      policy: content-heuristic",
    "      pattern: '^ok'",
    "",
  ].join("\n"));
  writeFileSync(join(basePath, "output.md"), "not-ok\n");
  let attemptId = firstAttemptId;

  const runPolicyFailure = async (): Promise<{
    payload: string;
    route: HostVerificationEvidence["recovery"];
    recorded: ReturnType<typeof recordNonAdvancingOutcome>;
  }> => {
    await stage(basePath, `custom/post-policy/${attemptId}`);
    const reads: VerificationRead[] = [];
    const outcome = await runCustomEngineHostVerification({
      unitType: "execute-task",
      basePath,
      unitId: "M001/S01/T01",
      verifyPolicy: async () => {
        const result = runCustomVerificationWithEvidence(basePath, "step-1");
        reads.push({ source: "policy", evidence: result.inputPayload });
        return result.outcome;
      },
      recordHostEvidence: (evidence) => reads.push({ source: "host", evidence }),
    });
    const payload = composeVerificationInputPayload({ outcome, reads });
    const hostRead = reads.at(-1);
    assert.ok(hostRead?.source === "host");
    assert.equal(hostRead.evidence.path, "post-policy-failed");
    return {
      payload,
      route: hostRead.evidence.recovery,
      recorded: recordNonAdvancingOutcome({
        scopeId: basePath,
        guardId: "custom-engine-verify",
        unitType: "execute-task",
        unitId: "M001/S01/T01",
        inputPayload: payload,
      }),
    };
  };

  const first = await runPolicyFailure();
  attemptId = claimRetry(attemptId, 2);
  const second = await runPolicyFailure();
  attemptId = claimRetry(attemptId, 3);
  const exhausted = await runPolicyFailure();

  assert.deepEqual(first.route, { owner: "agent", action: "remediate", status: "committed" });
  assert.equal(first.payload, second.payload, "the same policy read and route must hash identically");
  assert.equal(second.recorded.tripped, true);
  assert.deepEqual(exhausted.route, { owner: "agent", action: "abort", status: "committed" });
  assert.notEqual(exhausted.payload, second.payload, "a different selected route must change the payload");
  assert.equal(exhausted.recorded.tripped, false);
});

test("#1674: host verification evidence names both revisions on stored-pass source drift", async () => {
  const { basePath, attemptId } = createFixture();
  await stage(basePath);
  assert.equal(await runCustomEngineHostVerification({
    unitType: "execute-task",
    basePath,
    unitId: "M001/S01/T01",
    verifyPolicy: async () => "continue",
  }), "continue");
  const passedRevision = readTaskTechnicalVerdict(attemptId)?.testedSourceRevision;
  writeFileSync(join(basePath, "tracked.ts"), "export const verified = false;\n");

  const evidence: HostVerificationEvidence[] = [];
  assert.equal(await runCustomEngineHostVerification({
    unitType: "execute-task",
    basePath,
    unitId: "M001/S01/T01",
    verifyPolicy: async () => { throw new Error("stored verdict must not rerun policy"); },
    recordHostEvidence: (recorded) => evidence.push(recorded),
  }), "retry");

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.path, "stored-pass-source-drift");
  assert.equal(evidence[0]?.verdict?.verdictId, readTaskTechnicalVerdict(attemptId)?.supersedesVerdictId);
  assert.equal(evidence[0]?.failureKind, "verification-drift");
  assert.equal(evidence[0]?.sourceRevisionBefore, passedRevision);
  assert.match(evidence[0]?.sourceRevisionAfter ?? "", /^sha256:/);
  assert.notEqual(
    evidence[0]?.sourceRevisionAfter,
    evidence[0]?.sourceRevisionBefore,
    "source drift evidence must carry the revisions that decided the route",
  );
});

/** A frozen definition whose step defers to human review, read by production verification. */
function writeHumanReviewDefinition(basePath: string): void {
  writeFileSync(join(basePath, "DEFINITION.yaml"), [
    "version: 1",
    "name: host-verification",
    "steps:",
    "  - id: step-1",
    "    name: step-1",
    "    prompt: Do step-1",
    "    produces: out.md",
    "    verify:",
    "      policy: human-review",
    "",
  ].join("\n"));
}

test("#1674: a human-review resolution composes a different signature than the policy failure", async () => {
  // ADR-047 §3: the resolution turn reads the policy AND then the host's
  // decision on the now-resolved blocker. Keeping the first write hashed only
  // the stale policy read, so "the policy paused for review" and "review
  // resolved it and the host rerouted" shared one signature and tripped the
  // wedge falsely at occurrence two. Every read here comes from production —
  // real content verification for the policy read, the real host boundary for
  // the host reads, the real composer for the payload.
  const { basePath } = createFixture();
  await stage(basePath);
  writeHumanReviewDefinition(basePath);

  const reads: VerificationRead[] = [];
  const paused = await runCustomEngineHostVerification({
    unitType: "execute-task",
    basePath,
    unitId: "M001/S01/T01",
    humanReviewPolicy: true,
    verifyPolicy: async () => {
      const policyEvidence = runCustomVerificationWithEvidence(basePath, "step-1");
      reads.push({ source: "policy", evidence: policyEvidence.inputPayload });
      return policyEvidence.outcome;
    },
    recordHostEvidence: (evidence) => reads.push({ source: "host", evidence }),
  });
  assert.equal(paused, "pause");
  const policyFailurePayload = composeVerificationInputPayload({ outcome: paused, reads });
  const freshHumanReviewRead = reads[1];
  assert.ok(freshHumanReviewRead?.source === "host");
  assert.equal(freshHumanReviewRead.evidence.attemptId, undefined);
  assert.equal(freshHumanReviewRead.evidence.verdict, undefined);

  assert.equal(await resolvePendingCustomTaskHumanReview({
    unitId: "M001/S01/T01",
    responseIdentity: humanResponseIdentity,
    requestReview: async () => "approve",
  }), "resolved");

  const rerouted = await runCustomEngineHostVerification({
    unitType: "execute-task",
    basePath,
    unitId: "M001/S01/T01",
    humanReviewPolicy: true,
    verifyPolicy: async () => { throw new Error("resolved review must not rerun policy"); },
    recordHostEvidence: (evidence) => reads.push({ source: "host", evidence }),
  });
  assert.equal(rerouted, "retry");
  const resolvedPayload = composeVerificationInputPayload({ outcome: rerouted, reads });

  const finalRead = reads.at(-1);
  assert.equal(reads[0]?.source, "policy");
  assert.equal(finalRead?.source, "host");
  assert.ok(finalRead?.source === "host");
  assert.equal(
    finalRead.evidence.path,
    "stored-verdict-blocker-failed",
    "the resolution turn's final read must be the host decision on the resolved blocker",
  );
  assert.equal(finalRead.evidence.blocker?.blockerStatus, "resolved");
  assert.notEqual(
    resolvedPayload,
    policyFailurePayload,
    "a resolved human review must not share the policy failure's signature payload",
  );
  assert.notEqual(
    resolvedPayload,
    reads[0]?.evidence,
    "the composed payload must not collapse back to the first policy read",
  );
});

test("#1674: post-policy source drift carries both revisions into distinct evidence", async () => {
  // ADR-047 §3: this path decides on the revision the policy ran against and the
  // revision found afterwards, so both must reach the signature — it emitted no
  // evidence at all before, leaving the disposition as the whole signature.
  const driftEvidence = async (contentAfterPolicy: string): Promise<HostVerificationEvidence[]> => {
    const { basePath } = createFixture();
    await stage(basePath);
    const evidence: HostVerificationEvidence[] = [];
    assert.equal(await runCustomEngineHostVerification({
      unitType: "execute-task",
      basePath,
      unitId: "M001/S01/T01",
      verifyPolicy: async () => {
        // The policy's own work changes the verification source mid-flight.
        writeFileSync(join(basePath, "tracked.ts"), contentAfterPolicy);
        return "continue";
      },
      recordHostEvidence: (recorded) => evidence.push(recorded),
    }), "retry");
    return evidence;
  };

  const first = await driftEvidence("export const verified = 1;\n");
  assert.equal(first.length, 1, "the post-policy source-drift decision must report the inputs it read");
  assert.equal(first[0]?.path, "post-policy-source-drift");
  assert.equal(first[0]?.attemptId, undefined);
  assert.equal(first[0]?.verdict, undefined);
  assert.match(first[0]?.sourceRevisionBefore ?? "", /^sha256:/);
  assert.match(first[0]?.sourceRevisionAfter ?? "", /^sha256:/);
  assert.notEqual(
    first[0]?.sourceRevisionAfter,
    first[0]?.sourceRevisionBefore,
    "drift evidence must name both revisions that decided the route",
  );

  closeDatabase();
  const second = await driftEvidence("export const verified = 2;\n");
  assert.equal(second[0]?.path, "post-policy-source-drift");
  assert.notEqual(
    second[0]?.sourceRevisionAfter,
    first[0]?.sourceRevisionAfter,
    "drifting to a different revision is a different read and must not share evidence",
  );
});

test("custom execute-task routes an unproven pause as an agent-fixable durable failure", async () => {
  const { basePath, attemptId } = createFixture();
  await stage(basePath);

  const outcome = await runCustomEngineHostVerification({
    unitType: "execute-task",
    basePath,
    unitId: "M001/S01/T01",
    verifyPolicy: async () => "pause",
  });

  assert.equal(outcome, "retry");
  assert.equal(readTaskTechnicalVerdict(attemptId)?.verdict, "fail");
  assert.equal(row("SELECT action FROM workflow_recovery_actions").action, "remediate");
});

test("custom execute-task routes resolved human review through a fresh verified Attempt", async () => {
  const { basePath, attemptId } = createFixture();
  await stage(basePath);

  const paused = await runCustomEngineHostVerification({
    unitType: "execute-task",
    basePath,
    unitId: "M001/S01/T01",
    humanReviewPolicy: true,
    verifyPolicy: async () => "pause",
  });

  assert.equal(paused, "pause");
  assert.equal(readTaskTechnicalVerdict(attemptId)?.verdict, "inconclusive");
  assert.deepEqual(row(`
    SELECT blocker.blocker_id, blocker.blocker_kind, blocker.blocker_status,
           action.action, checkpoint.checkpoint_kind
    FROM workflow_blockers blocker
    JOIN workflow_recovery_actions action ON action.blocker_id = blocker.blocker_id
    JOIN workflow_work_checkpoints checkpoint
      ON checkpoint.operation_id = blocker.opened_operation_id
  `), {
    blocker_id: row("SELECT blocker_id FROM workflow_blockers").blocker_id,
    blocker_kind: "subjective_uat",
    blocker_status: "open",
    action: "clarify",
    checkpoint_kind: "pause",
  });

  assert.equal(await runCustomEngineHostVerification({
    unitType: "execute-task",
    basePath,
    unitId: "M001/S01/T01",
    humanReviewPolicy: true,
    verifyPolicy: async () => { throw new Error("open durable blocker must replay without policy execution"); },
  }), "pause");
  assert.equal(Number(row("SELECT COUNT(*) AS count FROM workflow_technical_verdicts").count), 1);
  assert.equal(Number(row("SELECT COUNT(*) AS count FROM workflow_blockers").count), 1);
  assert.equal(Number(row("SELECT COUNT(*) AS count FROM workflow_recovery_actions").count), 1);

  let reviewPrompt = "";
  let reviewOptions: string[] = [];
  assert.equal(await resolvePendingCustomTaskHumanReview({
    unitId: "M001/S01/T01",
    responseIdentity: humanResponseIdentity,
    requestReview: input => requestCustomTaskHumanReviewFromUi({
      select: async (title, options) => {
        reviewPrompt = title;
        reviewOptions = options;
        return "approve";
      },
    }, input),
  }), "resolved");
  assert.match(reviewPrompt, /Recommendation: approve only when/);
  assert.match(reviewPrompt, /because your explicit judgment/);
  assert.match(reviewOptions[0] ?? "", /Recommended/);

  assert.equal(await runCustomEngineHostVerification({
    unitType: "execute-task",
    basePath,
    unitId: "M001/S01/T01",
    humanReviewPolicy: true,
    verifyPolicy: async () => { throw new Error("resolved durable blocker must replay without policy execution"); },
  }), "retry");
  assert.equal(readTaskTechnicalVerdict(attemptId)?.verdict, "inconclusive");
  assert.equal(Number(row("SELECT COUNT(*) AS count FROM workflow_technical_verdicts").count), 1);
  assert.equal(row("SELECT blocker_status FROM workflow_blockers").blocker_status, "resolved");
  assert.deepEqual(
    db().prepare("SELECT action FROM workflow_recovery_actions ORDER BY project_revision").all(),
    [{ action: "clarify" }, { action: "remediate" }],
  );
  assert.deepEqual(row(`
    SELECT actor_id, trace_id, turn_id
    FROM workflow_operations
    WHERE operation_type = 'task.blocker.resolve'
  `), {
    actor_id: "session-1",
    trace_id: "review-trace-1",
    turn_id: "review-turn-1",
  });
  assert.match(
    String(row(`
      SELECT evidence_summary
      FROM workflow_work_checkpoints
      WHERE checkpoint_kind = 'answer'
    `).evidence_summary),
    /worker-1.*review-trace-1.*review-turn-1/,
  );
  const suggestedNextAction = String(row(`
    SELECT suggested_next_action
    FROM workflow_work_checkpoints
    WHERE checkpoint_kind = 'answer'
  `).suggested_next_action);
  assert.match(suggestedNextAction, /agent recovery/i);
  assert.match(suggestedNextAction, /fresh successor Task Attempt/i);
  assert.doesNotMatch(suggestedNextAction, /publish the verified Task/i);
  assert.deepEqual(
    db().prepare("SELECT checkpoint_kind FROM workflow_work_checkpoints ORDER BY sequence").all(),
    [{ checkpoint_kind: "pause" }, { checkpoint_kind: "answer" }, { checkpoint_kind: "correction" }],
  );

  const successorAttemptId = claimRetry(attemptId, 2);
  await stage(basePath, "custom/stage/2");
  assert.equal(await runCustomEngineHostVerification({
    unitType: "execute-task",
    basePath,
    unitId: "M001/S01/T01",
    humanReviewPolicy: true,
    verifyPolicy: async () => "pause",
  }), "continue");
  assert.equal(readTaskTechnicalVerdict(successorAttemptId)?.verdict, "pass");
  assert.deepEqual(db().prepare(`
    SELECT
      json_extract(environment_json, '$.humanReviewApproval.predecessorAttemptId') AS predecessor_attempt_id,
      json_extract(environment_json, '$.humanReviewApproval.blockerId') AS blocker_id,
      json_extract(environment_json, '$.humanReviewApproval.approvalOperationId') AS approval_operation_id
    FROM workflow_verification_evidence
    WHERE attempt_id = :attempt_id
  `).get({ ":attempt_id": successorAttemptId }), {
    predecessor_attempt_id: attemptId,
    blocker_id: row("SELECT blocker_id FROM workflow_blockers").blocker_id,
    approval_operation_id: row("SELECT resolved_operation_id FROM workflow_blockers").resolved_operation_id,
  });
  assert.equal(row(`
    SELECT retry_of_attempt_id
    FROM workflow_execution_attempts
    ORDER BY attempt_number DESC
    LIMIT 1
  `).retry_of_attempt_id, attemptId);

  await publishVerifiedTaskExecution({
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    workerId: "worker-1",
    traceId: "trace-1",
    turnId: "turn-1",
    basePath,
  }, { readLatestTaskAttempt, publishVerifiedTaskCompletion });

  assert.equal(row("SELECT status FROM tasks WHERE id = 'T01'").status, "complete");
  assert.equal(readLatestTaskAttempt({ milestoneId: "M001", sliceId: "S01", taskId: "T01" })?.nextStage, "settled");
});

test("resolved human-review reroute replays across restart before successor claim", async () => {
  const { basePath, attemptId } = createFixture();
  await stage(basePath);
  assert.equal(await runCustomEngineHostVerification({
    unitType: "execute-task",
    basePath,
    unitId: "M001/S01/T01",
    humanReviewPolicy: true,
    verifyPolicy: async () => "pause",
  }), "pause");
  assert.equal(await resolvePendingCustomTaskHumanReview({
    unitId: "M001/S01/T01",
    responseIdentity: humanResponseIdentity,
    requestReview: async () => "approve",
  }), "resolved");
  assert.equal(await runCustomEngineHostVerification({
    unitType: "execute-task",
    basePath,
    unitId: "M001/S01/T01",
    humanReviewPolicy: true,
    verifyPolicy: async () => { throw new Error("resolved review must not rerun policy"); },
  }), "retry");

  closeDatabase();
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  assert.equal(readTaskTechnicalVerdict(attemptId)?.verdict, "inconclusive");
  assert.equal(await runCustomEngineHostVerification({
    unitType: "execute-task",
    basePath,
    unitId: "M001/S01/T01",
    humanReviewPolicy: false,
    verifyPolicy: async () => { throw new Error("reroute replay must not rerun policy"); },
  }), "retry");
  assert.equal(Number(row("SELECT COUNT(*) AS count FROM workflow_recovery_actions").count), 2);

  const successorAttemptId = claimRetry(attemptId, 2);
  await stage(basePath, "custom/stage/restart-successor");
  closeDatabase();
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  assert.equal(await runCustomEngineHostVerification({
    unitType: "execute-task",
    basePath,
    unitId: "M001/S01/T01",
    humanReviewPolicy: true,
    verifyPolicy: async () => "pause",
  }), "continue");
  assert.equal(readTaskTechnicalVerdict(successorAttemptId)?.verdict, "pass");
});

test("resolved human approval is not reused when successor source changed", async () => {
  const { basePath, attemptId } = createFixture();
  await stage(basePath);
  assert.equal(await runCustomEngineHostVerification({
    unitType: "execute-task",
    basePath,
    unitId: "M001/S01/T01",
    humanReviewPolicy: true,
    verifyPolicy: async () => "pause",
  }), "pause");
  assert.equal(await resolvePendingCustomTaskHumanReview({
    unitId: "M001/S01/T01",
    responseIdentity: humanResponseIdentity,
    requestReview: async () => "approve",
  }), "resolved");
  assert.equal(await runCustomEngineHostVerification({
    unitType: "execute-task",
    basePath,
    unitId: "M001/S01/T01",
    humanReviewPolicy: true,
    verifyPolicy: async () => { throw new Error("resolved review must route before retry"); },
  }), "retry");

  const successorAttemptId = claimRetry(attemptId, 2);
  writeFileSync(join(basePath, "tracked.ts"), "export const verified = false;\n");
  await stage(basePath, "custom/stage/changed-successor");
  assert.equal(await runCustomEngineHostVerification({
    unitType: "execute-task",
    basePath,
    unitId: "M001/S01/T01",
    humanReviewPolicy: true,
    verifyPolicy: async () => "pause",
  }), "pause");
  assert.equal(readTaskTechnicalVerdict(successorAttemptId)?.verdict, "inconclusive");
  assert.deepEqual(
    db().prepare("SELECT blocker_status FROM workflow_blockers ORDER BY opened_project_revision").all(),
    [{ blocker_status: "resolved" }, { blocker_status: "open" }],
  );
});

test("human-review verdict recreates its subjective blocker after a routing crash", async () => {
  const { basePath, attemptId } = createFixture();
  await stage(basePath);
  const source = captureVerificationSourceSnapshot([{ id: "project", cwd: basePath }]);
  assert.equal(source.ok, true);
  assert.ok(source.ok);
  const now = new Date().toISOString();
  recordTaskTechnicalVerdict({
    invocation: invocation("custom/human-review/verdict-only"),
    attemptId,
    testedSourceRevision: source.snapshot.aggregateRevision,
    verdict: "inconclusive",
    rationale: "Custom-engine host verification is awaiting the configured human review.",
    evidence: {
      evidenceClass: "command",
      commandOrTool: "custom-engine-policy.verify",
      workingDirectory: basePath,
      startedAt: now,
      endedAt: now,
      exitCode: 1,
      observation: "inconclusive",
      durableOutputRef: `db://host-verification/${attemptId}`,
      environment: {
        verificationPolicy: "custom-engine-human-review",
        targetSourceRevisions: { project: source.snapshot.targets[0]?.revision ?? "missing" },
      },
    },
  });
  assert.equal(Number(row("SELECT COUNT(*) AS count FROM workflow_recovery_actions").count), 0);

  assert.equal(await runCustomEngineHostVerification({
    unitType: "execute-task",
    basePath,
    unitId: "M001/S01/T01",
    humanReviewPolicy: false,
    verifyPolicy: async () => { throw new Error("durable human verdict must not rerun policy"); },
  }), "pause");
  assert.deepEqual(row(`
    SELECT observation.recovery_owner, action.action, blocker.blocker_kind, blocker.blocker_status
    FROM workflow_failure_observations observation
    JOIN workflow_recovery_actions action
      ON action.failure_observation_id = observation.failure_observation_id
    JOIN workflow_blockers blocker ON blocker.blocker_id = action.blocker_id
  `), {
    recovery_owner: "user",
    action: "clarify",
    blocker_kind: "subjective_uat",
    blocker_status: "open",
  });
});

test("persisted subjective blocker governs when the current policy no longer requests review", async () => {
  const { basePath } = createFixture();
  await stage(basePath);
  assert.equal(await runCustomEngineHostVerification({
    unitType: "execute-task",
    basePath,
    unitId: "M001/S01/T01",
    humanReviewPolicy: true,
    verifyPolicy: async () => "pause",
  }), "pause");

  assert.equal(await runCustomEngineHostVerification({
    unitType: "execute-task",
    basePath,
    unitId: "M001/S01/T01",
    humanReviewPolicy: false,
    verifyPolicy: async () => { throw new Error("persisted blocker must bypass current policy"); },
  }), "pause");
  assert.equal(Number(row("SELECT COUNT(*) AS count FROM workflow_recovery_actions").count), 1);
});

test("source drift after human approval creates durable agent recovery", async () => {
  const { basePath, attemptId } = createFixture();
  await stage(basePath);
  assert.equal(await runCustomEngineHostVerification({
    unitType: "execute-task",
    basePath,
    unitId: "M001/S01/T01",
    humanReviewPolicy: true,
    verifyPolicy: async () => "pause",
  }), "pause");
  assert.equal(await resolvePendingCustomTaskHumanReview({
    unitId: "M001/S01/T01",
    responseIdentity: humanResponseIdentity,
    requestReview: async () => "approve",
  }), "resolved");
  writeFileSync(join(basePath, "tracked.ts"), "export const verified = false;\n");

  assert.equal(await runCustomEngineHostVerification({
    unitType: "execute-task",
    basePath,
    unitId: "M001/S01/T01",
    humanReviewPolicy: false,
    verifyPolicy: async () => { throw new Error("resolved review drift must not rerun policy"); },
  }), "retry");
  assert.equal(readTaskTechnicalVerdict(attemptId)?.verdict, "inconclusive");
  assert.deepEqual(db().prepare(`
    SELECT observation.failure_kind, observation.recovery_owner, action.action
    FROM workflow_failure_observations observation
    JOIN workflow_recovery_actions action
      ON action.failure_observation_id = observation.failure_observation_id
    ORDER BY observation.project_revision
  `).all(), [
    { failure_kind: "verification-failed", recovery_owner: "user", action: "clarify" },
    { failure_kind: "verification-drift", recovery_owner: "agent", action: "remediate" },
  ]);
  assert.equal(await runCustomEngineHostVerification({
    unitType: "execute-task",
    basePath,
    unitId: "M001/S01/T01",
    humanReviewPolicy: true,
    verifyPolicy: async () => { throw new Error("durable drift recovery must replay"); },
  }), "retry");
});

test("custom policy retry records a failed verdict and prevents publication", async () => {
  const { basePath, attemptId } = createFixture();
  await stage(basePath);

  const verified = await runCustomEngineHostVerification({
    unitType: "execute-task",
    basePath,
    unitId: "M001/S01/T01",
    verifyPolicy: async () => "retry",
  });

  assert.equal(verified, "retry");
  assert.equal(readTaskTechnicalVerdict(attemptId)?.verdict, "fail");
  assert.equal(readLatestTaskAttempt({ milestoneId: "M001", sliceId: "S01", taskId: "T01" })?.nextStage, "route");
  assert.deepEqual(row(`
    SELECT observation.result_id, action.action
    FROM workflow_failure_observations observation
    JOIN workflow_recovery_actions action
      ON action.failure_observation_id = observation.failure_observation_id
  `), {
    result_id: readLatestTaskAttempt({ milestoneId: "M001", sliceId: "S01", taskId: "T01" })?.resultId,
    action: "remediate",
  });

  const replayed = await runCustomEngineHostVerification({
    unitType: "execute-task",
    basePath,
    unitId: "M001/S01/T01",
    verifyPolicy: async () => { throw new Error("persisted verdict must replay without policy execution"); },
  });
  assert.equal(replayed, "retry");
  assert.equal(Number(row("SELECT COUNT(*) AS count FROM workflow_failure_observations").count), 1);
  assert.equal(Number(row("SELECT COUNT(*) AS count FROM workflow_recovery_actions").count), 1);

  const retryAttemptId = claimRetry(attemptId, 2);
  assert.deepEqual(db().prepare(`
    SELECT attempt_number, retry_of_attempt_id
    FROM workflow_execution_attempts WHERE attempt_id = :attempt_id
  `).get({ ":attempt_id": retryAttemptId }), { attempt_number: 2, retry_of_attempt_id: attemptId });
  await assert.rejects(publishVerifiedTaskExecution({
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    workerId: "worker-1",
    traceId: "trace-1",
    turnId: "turn-1",
    basePath,
  }, { readLatestTaskAttempt, publishVerifiedTaskCompletion }), /verify stage|succeeded Attempt/i);
  assert.equal(row("SELECT status FROM tasks WHERE id = 'T01'").status, "in_progress");
});

test("custom verification aborts after durable remediation budget exhaustion", async () => {
  const { basePath, attemptId: firstAttemptId } = createFixture();
  let attemptId = firstAttemptId;

  for (const attemptNumber of [1, 2, 3]) {
    await stage(basePath, `custom/stage/${attemptNumber}`);
    const outcome = await runCustomEngineHostVerification({
      unitType: "execute-task",
      basePath,
      unitId: "M001/S01/T01",
      verifyPolicy: async () => "retry",
    });

    assert.equal(outcome, attemptNumber < 3 ? "retry" : "abort");
    if (attemptNumber < 3) attemptId = claimRetry(attemptId, attemptNumber + 1);
  }

  assert.deepEqual(db().prepare(`
    SELECT action FROM workflow_recovery_actions ORDER BY project_revision
  `).all(), [
    { action: "remediate" },
    { action: "remediate" },
    { action: "abort" },
  ]);

  const recoveryActionId = String(row(`
    SELECT recovery_action_id FROM workflow_recovery_actions
    WHERE action = 'abort'
  `).recovery_action_id);
  const recoveryWorktree = join(basePath, ".gsd-worktrees", "M001");
  const unrelatedWorktree = join(basePath, ".gsd-worktrees", "M002");
  for (const worktree of [recoveryWorktree, unrelatedWorktree]) {
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, ".git"), "gitdir: /tmp/fake-git-dir\n");
  }
  assert.equal(
    resolveTaskRecoveryResumeBasePath({ cwd: basePath }, recoveryActionId),
    recoveryWorktree,
  );
  resumeTaskRecovery({
    invocation: invocation("custom/recovery/resume"),
    recoveryActionId,
    repairSummary: "Repaired the verification defect.",
    evidence: { test: "passed" },
  });
  assert.equal(await runCustomEngineHostVerification({
    unitType: "execute-task",
    basePath,
    unitId: "M001/S01/T01",
    verifyPolicy: async () => { throw new Error("persisted verdict must replay"); },
  }), "retry");
});
