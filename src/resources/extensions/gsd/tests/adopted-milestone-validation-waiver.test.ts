// Project/App: gsd-pi
// File Purpose: Contract for canonical adopted Milestone validation waivers.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { DISPATCH_RULES, type DispatchContext } from "../auto-dispatch.ts";
import { checkCloseoutConsistencyGate } from "../closeout-consistency-gate.ts";
import { isCompletedMilestoneTerminal } from "../milestone-closeout.ts";
import {
  _setDomainOperationFaultForTest,
  type DomainOperationContext,
} from "../db/domain-operation.ts";
import { readMilestoneCloseoutAuthorization } from "../db/milestone-closeout-readiness.ts";
import { adoptOrTransitionLifecycle } from "../db/writers/lifecycle-commands.ts";
import {
  _getAdapter,
  closeDatabase,
  executeDomainOperation,
  getLatestAssessmentByScope,
  insertAssessment,
  insertGateRow,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
  readDomainOperationFence,
  upsertQualityGate,
} from "../gsd-db.ts";
import { openWorkflowDatabase } from "../db-workspace.ts";
import { handleCompleteMilestone } from "../tools/complete-milestone.ts";
import { handleValidateMilestone } from "../tools/validate-milestone.ts";
import { deriveStateFromDb } from "../state.ts";

const tempDirs = new Set<string>();

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function row(sql: string): Record<string, unknown> {
  return db().prepare(sql).get() ?? {};
}

function executeAtFence(
  operationType: string,
  write: (context: Readonly<DomainOperationContext>) => void,
): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType,
    idempotencyKey: `fixture/${operationType}/${fence.revision}`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { operationType },
  }, (context) => {
    write(context);
    return {
      events: [{
        eventType: operationType,
        entityType: "milestone",
        entityId: "M001",
        payload: { operationType },
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: `fixture/${operationType}/${context.resultingRevision}`,
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}

function makeFixture(): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-adopted-validation-waiver-"));
  tempDirs.add(basePath);
  const milestoneDir = join(basePath, ".gsd", "milestones", "M001");
  const sliceDir = join(milestoneDir, "slices", "S01");
  mkdirSync(sliceDir, { recursive: true });
  writeFileSync(join(basePath, ".gitignore"), ".gsd/\n");
  writeFileSync(join(basePath, "source.ts"), "export const source = 'waiver';\n");
  writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "# Summary\n");
  execFileSync("git", ["init"], { cwd: basePath, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: basePath });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: basePath });
  execFileSync("git", ["add", ".gitignore", "source.ts"], { cwd: basePath });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: basePath, stdio: "ignore" });

  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Waived validation", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Done", status: "complete" });
  insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", title: "Done", status: "complete" });
  executeAtFence("test.fixture.adopt", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone",
      milestoneId: "M001",
      lifecycleStatus: "ready",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "slice",
      milestoneId: "M001",
      sliceId: "S01",
      lifecycleStatus: "completed",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      lifecycleStatus: "completed",
    });
  });
  return basePath;
}

function dispatchContext(basePath: string): DispatchContext {
  return {
    basePath,
    mid: "M001",
    midTitle: "Waived validation",
    state: {
      phase: "validating-milestone",
      activeMilestone: { id: "M001", title: "Waived validation" },
      activeSlice: null,
      activeTask: null,
      recentDecisions: [],
      blockers: [],
      nextAction: "",
      registry: [{ id: "M001", title: "Waived validation", status: "active" }],
      requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 },
      progress: { milestones: { done: 0, total: 1 } },
    },
    prefs: { phases: { skip_milestone_validation: true } },
  };
}

async function recordPassingValidation(basePath: string, idempotencyKey: string): Promise<void> {
  const result = await handleValidateMilestone({
    milestoneId: "M001",
    verdict: "pass",
    remediationRound: 0,
    successCriteriaChecklist: "- [x] Complete",
    sliceDeliveryAudit: "Delivered",
    crossSliceIntegration: "Passed",
    requirementCoverage: "Covered",
    verdictRationale: "Everything passes.",
  }, basePath, {
    invocation: {
      idempotencyKey,
      sourceTransport: "internal",
      actorType: "agent",
    },
    skipBrowserEvidenceGate: true,
  });
  assert.ok(!("error" in result), "canonical passing validation should be recorded");
}

afterEach(() => {
  _setDomainOperationFaultForTest(null);
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("adopted validation skip records a canonical waiver without fabricating PASS", async () => {
  const basePath = makeFixture();
  const rule = DISPATCH_RULES.find((candidate) =>
    candidate.name === "validating-milestone → validate-milestone"
  );
  assert.ok(rule);

  const result = await rule.match(dispatchContext(basePath));

  assert.equal(result?.action, "dispatch");
  if (result?.action !== "dispatch") assert.fail("waiver should continue through completion guards");
  assert.equal(result.unitType, "complete-milestone");
  assert.equal(result.unitId, "M001");
  assert.equal(getLatestAssessmentByScope("M001", "milestone-validation"), null);
  assert.equal((await deriveStateFromDb(basePath)).phase, "validating-milestone");
  assert.equal(row(`SELECT COUNT(*) AS count FROM workflow_waivers`).count, 1);
  assert.equal(row(`SELECT COUNT(*) AS count FROM workflow_operations WHERE operation_type = 'milestone.validation.waive'`).count, 1);
  assert.equal(row(`SELECT COUNT(*) AS count FROM workflow_domain_events WHERE event_type = 'milestone.validation.waived'`).count, 1);
  const validationPath = join(basePath, ".gsd", "milestones", "M001", "M001-VALIDATION.md");
  assert.equal(existsSync(validationPath), true);
  assert.doesNotMatch(readFileSync(validationPath, "utf-8"), /verdict:\s*pass/i);
  const projection = String(row(`
    SELECT payload_json FROM workflow_domain_events
    WHERE event_type = 'milestone.validation.waived'
  `).payload_json);
  assert.match(projection, /"reason":"preference"/);
  assert.deepEqual(readMilestoneCloseoutAuthorization({ milestoneId: "M001" }), {
    authorized: true,
    kind: "waived",
    eventId: String(row(`SELECT event_id FROM workflow_domain_events WHERE event_type = 'milestone.validation.waived'`).event_id),
    revision: Number(row(`SELECT project_revision FROM workflow_domain_events WHERE event_type = 'milestone.validation.waived'`).project_revision),
    testedSourceRevision: JSON.parse(projection).testedSourceRevision,
    waiverId: String(row(`SELECT waiver_id FROM workflow_waivers WHERE waiver_status = 'active'`).waiver_id),
  });
});

test("adopted waiver replay is exact and projection loss cannot block closeout", async () => {
  const basePath = makeFixture();
  const rule = DISPATCH_RULES.find((candidate) =>
    candidate.name === "validating-milestone → validate-milestone"
  );
  assert.ok(rule);
  const context = dispatchContext(basePath);

  assert.equal((await rule.match(context))?.action, "dispatch");
  assert.equal((await rule.match(context))?.action, "dispatch");
  assert.equal(row(`SELECT COUNT(*) AS count FROM workflow_waivers`).count, 1);
  assert.equal(row(`SELECT COUNT(*) AS count FROM workflow_operations WHERE operation_type = 'milestone.validation.waive'`).count, 1);
  const validationPath = join(basePath, ".gsd", "milestones", "M001", "M001-VALIDATION.md");
  const summaryPath = join(basePath, ".gsd", "milestones", "M001", "slices", "S01", "S01-SUMMARY.md");
  unlinkSync(validationPath);
  unlinkSync(summaryPath);

  const completed = await handleCompleteMilestone({
    milestoneId: "M001",
    title: "Waived validation",
    oneLiner: "Completed under a canonical waiver.",
    narrative: "Validation was omitted by recorded policy.",
    verificationPassed: true,
  }, basePath, {
    idempotencyKey: "test/milestone.complete/waived",
    sourceTransport: "internal",
    actorType: "agent",
  });

  assert.ok(!("error" in completed), "canonical waiver should authorize completion");
});

test("waiver persistence is atomic when the Domain Operation faults", async () => {
  const basePath = makeFixture();
  const rule = DISPATCH_RULES.find((candidate) =>
    candidate.name === "validating-milestone → validate-milestone"
  );
  assert.ok(rule);
  _setDomainOperationFaultForTest("after-mutation");

  await assert.rejects(() => rule.match(dispatchContext(basePath)), /domain operation fault: after-mutation/);

  assert.equal(row(`SELECT COUNT(*) AS count FROM workflow_waivers`).count, 0);
  assert.equal(row(`SELECT COUNT(*) AS count FROM workflow_operations WHERE operation_type = 'milestone.validation.waive'`).count, 0);
  assert.equal(row(`SELECT COUNT(*) AS count FROM workflow_domain_events WHERE event_type = 'milestone.validation.waived'`).count, 0);
  assert.equal(existsSync(join(basePath, ".gsd", "milestones", "M001", "M001-VALIDATION.md")), false);
});

test("descendant work after a waiver makes the canonical authorization stale", async () => {
  const basePath = makeFixture();
  const rule = DISPATCH_RULES.find((candidate) =>
    candidate.name === "validating-milestone → validate-milestone"
  );
  assert.ok(rule);
  assert.equal((await rule.match(dispatchContext(basePath)))?.action, "dispatch");

  insertSlice({ id: "S02", milestoneId: "M001", title: "Late work", status: "pending" });
  executeAtFence("test.fixture.descendant-change", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "slice",
      milestoneId: "M001",
      sliceId: "S02",
      lifecycleStatus: "ready",
    });
  });

  const authorization = readMilestoneCloseoutAuthorization({ milestoneId: "M001" });
  assert.equal(authorization.authorized, false);
  if (!authorization.authorized) {
    assert.equal(authorization.blockers[0]?.kind, "validation-stale");
  }
});

test("waiver authorization is source-bound and rejects unproven active rows", async () => {
  const basePath = makeFixture();
  const rule = DISPATCH_RULES.find((candidate) =>
    candidate.name === "validating-milestone → validate-milestone"
  );
  assert.ok(rule);
  assert.equal((await rule.match(dispatchContext(basePath)))?.action, "dispatch");

  const wrongSource = readMilestoneCloseoutAuthorization({
    milestoneId: "M001",
    sourceRevision: "sha256:different-source",
  });
  assert.equal(wrongSource.authorized, false);
  if (!wrongSource.authorized) {
    assert.equal(wrongSource.blockers[0]?.kind, "validation-source-revision-mismatch");
  }

  db().prepare(`
    INSERT INTO workflow_waivers (
      waiver_id, project_id, lifecycle_id, requirement_id, blocker_id,
      waiver_status, scope, rationale, granted_by_actor_type,
      granted_by_actor_id, granted_at,
      operation_id, project_revision, authority_epoch
    )
    SELECT
      'forged-waiver', authority.project_id, lifecycle.lifecycle_id, NULL, NULL,
      'active', 'milestone-validation', 'forged compatibility row', 'policy',
      NULL, operation.created_at,
      operation.operation_id, operation.resulting_revision, operation.resulting_authority_epoch
    FROM project_authority authority
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.project_id = authority.project_id
     AND lifecycle.item_kind = 'milestone'
     AND lifecycle.milestone_id = 'M001'
    JOIN workflow_operations operation
      ON operation.operation_type = 'test.fixture.adopt'
    WHERE authority.singleton = 1
  `).run();

  const forged = readMilestoneCloseoutAuthorization({ milestoneId: "M001" });
  assert.equal(forged.authorized, false);
  if (!forged.authorized) {
    assert.equal(forged.blockers[0]?.kind, "validation-receipt-invalid");
  }
});

test("a newer failing canonical validation blocks instead of resurrecting an older waiver", async () => {
  const basePath = makeFixture();
  const rule = DISPATCH_RULES.find((candidate) =>
    candidate.name === "validating-milestone → validate-milestone"
  );
  assert.ok(rule);
  assert.equal((await rule.match(dispatchContext(basePath)))?.action, "dispatch");

  const validation = await handleValidateMilestone({
    milestoneId: "M001",
    verdict: "needs-remediation",
    remediationRound: 1,
    successCriteriaChecklist: "- [ ] Regression remains",
    sliceDeliveryAudit: "A regression was found.",
    crossSliceIntegration: "Failed",
    requirementCoverage: "Incomplete",
    verdictRationale: "The newer canonical validation failed.",
    remediationPlan: "Repair and revalidate.",
  }, basePath, {
    invocation: {
      idempotencyKey: "test/milestone.validate/newer-failure",
      sourceTransport: "internal",
      actorType: "agent",
    },
    skipBrowserEvidenceGate: true,
  });
  assert.ok(!("error" in validation));

  const authorization = readMilestoneCloseoutAuthorization({ milestoneId: "M001" });
  assert.equal(authorization.authorized, false);
  if (!authorization.authorized) {
    assert.equal(authorization.blockers[0]?.kind, "validation-not-pass");
  }
});

test("forged legacy PASS cannot authorize adopted closeout recovery", () => {
  const basePath = makeFixture();
  insertAssessment({
    path: join(basePath, ".gsd", "milestones", "M001", "M001-VALIDATION.md"),
    milestoneId: "M001",
    status: "pass",
    scope: "milestone-validation",
    fullContent: "---\nverdict: pass\n---\n",
  });

  const result = checkCloseoutConsistencyGate("M001", {
    allowOpenMilestone: true,
    allowPassThroughValidation: true,
    artifactBasePath: basePath,
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "validation-not-pass");
  assert.equal(row(`SELECT COUNT(*) AS count FROM workflow_waivers`).count, 0);
});

test("legacy skipped status cannot bypass adopted canonical authorization", () => {
  makeFixture();
  db().prepare(`UPDATE milestones SET status = 'skipped' WHERE id = 'M001'`).run();

  const result = checkCloseoutConsistencyGate("M001");

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "validation-not-pass");
});

test("closeout consistency snapshots the repo when .gsd links to an external store", async () => {
  const savedCwd = process.cwd();
  const basePath = makeFixture();
  const storeRoot = mkdtempSync(join(tmpdir(), "gsd-adopted-validation-store-"));
  tempDirs.add(storeRoot);

  try {
    closeDatabase();

    const externalGsd = join(storeRoot, "project");
    renameSync(join(basePath, ".gsd"), externalGsd);
    symlinkSync(externalGsd, join(basePath, ".gsd"), process.platform === "win32" ? "junction" : "dir");
    assert.equal(openWorkflowDatabase(basePath).ok, true);

    process.chdir(basePath);
    await recordPassingValidation(basePath, "test/milestone.validate/symlinked-store");
    assert.deepEqual(checkCloseoutConsistencyGate("M001", { allowOpenMilestone: true }), { ok: true });
  } finally {
    process.chdir(savedCwd);
  }
});

test("adopted legacy skipped status is not terminal while canonical lifecycle remains open", async () => {
  const basePath = makeFixture();
  db().prepare(`UPDATE milestones SET status = 'skipped' WHERE id = 'M001'`).run();

  assert.equal(await isCompletedMilestoneTerminal(basePath, "M001"), false);
});

test("adopted legacy completion is not terminal when current source cannot be captured", async () => {
  const basePath = makeFixture();
  db().prepare(`UPDATE milestones SET status = 'complete' WHERE id = 'M001'`).run();
  rmSync(join(basePath, ".git"), { recursive: true, force: true });

  assert.equal(await isCompletedMilestoneTerminal(basePath, "M001"), false);
});

test("canonical cancelled lifecycle is terminal without validation authorization", async () => {
  const basePath = makeFixture();
  executeAtFence("test.fixture.cancel-milestone", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone",
      milestoneId: "M001",
      lifecycleStatus: "cancelled",
    });
  });
  db().prepare(`UPDATE milestones SET status = 'skipped' WHERE id = 'M001'`).run();

  assert.equal(await isCompletedMilestoneTerminal(basePath, "M001"), true);
});

test("canonical waiver closes validation-owned gates only with milestone completion", async () => {
  const basePath = makeFixture();
  insertGateRow({
    milestoneId: "M001",
    sliceId: "S01",
    gateId: "MV01",
    scope: "milestone",
    status: "pending",
  });
  const rule = DISPATCH_RULES.find((candidate) =>
    candidate.name === "validating-milestone → validate-milestone"
  );
  assert.ok(rule);
  assert.equal((await rule.match(dispatchContext(basePath)))?.action, "dispatch");

  assert.deepEqual(checkCloseoutConsistencyGate("M001", { allowOpenMilestone: true }), { ok: true });
  assert.deepEqual(
    row(`SELECT status, verdict FROM quality_gates WHERE milestone_id = 'M001' AND gate_id = 'MV01'`),
    { status: "pending", verdict: "" },
  );

  const completed = await handleCompleteMilestone({
    milestoneId: "M001",
    title: "Waived validation",
    oneLiner: "Completed under a canonical waiver.",
    narrative: "Validation was omitted by recorded policy.",
    verificationPassed: true,
  }, basePath, {
    idempotencyKey: "test/milestone.complete/waived-gates",
    sourceTransport: "internal",
    actorType: "agent",
  });
  assert.ok(!("error" in completed));
  assert.deepEqual(
    row(`SELECT status, verdict FROM quality_gates WHERE milestone_id = 'M001' AND gate_id = 'MV01'`),
    { status: "complete", verdict: "omitted" },
  );
});

test("canonical passing validation cannot settle a pending task gate from Markdown projections", async () => {
  const basePath = makeFixture();
  const taskDir = join(basePath, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(
    join(taskDir, "T01-SUMMARY.md"),
    "# Task Summary\n\n## Failure Modes\n\nProjected evidence only.\n",
  );
  insertGateRow({
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T01",
    gateId: "Q5",
    scope: "task",
    status: "pending",
  });
  await recordPassingValidation(basePath, "test/milestone.validate/pending-task-gate");
  upsertQualityGate({
    milestoneId: "M001",
    sliceId: "S01",
    gateId: "MV01",
    scope: "milestone",
    taskId: "",
    status: "pending",
    verdict: "",
    rationale: "",
    findings: "",
    evaluatedAt: "",
  });
  const gateRunsBefore = row(`SELECT COUNT(*) AS count FROM gate_runs`).count;

  const consistency = checkCloseoutConsistencyGate("M001", {
    allowOpenMilestone: true,
    artifactBasePath: basePath,
  });
  assert.equal(consistency.ok, false);
  if (!consistency.ok) assert.equal(consistency.reason, "quality-gate-pending");
  assert.deepEqual(
    row(`SELECT status, verdict FROM quality_gates WHERE milestone_id = 'M001' AND gate_id = 'Q5'`),
    { status: "pending", verdict: "" },
  );
  assert.deepEqual(
    row(`SELECT status, verdict FROM quality_gates WHERE milestone_id = 'M001' AND gate_id = 'MV01'`),
    { status: "pending", verdict: "" },
  );
  assert.equal(row(`SELECT COUNT(*) AS count FROM gate_runs`).count, gateRunsBefore);
});

test("source changes after a waiver keep state validating and leave validation gates pending", async () => {
  const basePath = makeFixture();
  insertGateRow({
    milestoneId: "M001",
    sliceId: "S01",
    gateId: "MV01",
    scope: "milestone",
    status: "pending",
  });
  const rule = DISPATCH_RULES.find((candidate) =>
    candidate.name === "validating-milestone → validate-milestone"
  );
  assert.ok(rule);
  assert.equal((await rule.match(dispatchContext(basePath)))?.action, "dispatch");

  writeFileSync(join(basePath, "source.ts"), "export const source = 'changed-after-waiver';\n");
  execFileSync("git", ["add", "source.ts"], { cwd: basePath });
  execFileSync("git", ["commit", "-m", "change source"], { cwd: basePath, stdio: "ignore" });

  const state = await deriveStateFromDb(basePath);
  assert.equal(state.phase, "validating-milestone");
  const consistency = checkCloseoutConsistencyGate("M001", {
    allowOpenMilestone: true,
    artifactBasePath: basePath,
  });
  assert.equal(consistency.ok, false);
  if (!consistency.ok) {
    assert.equal(consistency.reason, "validation-source-revision-mismatch");
  }
  assert.deepEqual(
    row(`SELECT status, verdict FROM quality_gates WHERE milestone_id = 'M001' AND gate_id = 'MV01'`),
    { status: "pending", verdict: "" },
  );
});

test("source changes after a passing validation do not cut state derivation over to canonical authority", async () => {
  const basePath = makeFixture();
  await recordPassingValidation(basePath, "test/milestone.validate/stale-pass");

  writeFileSync(join(basePath, "source.ts"), "export const source = 'changed-after-pass';\n");
  execFileSync("git", ["add", "source.ts"], { cwd: basePath });
  execFileSync("git", ["commit", "-m", "change validated source"], { cwd: basePath, stdio: "ignore" });

  const state = await deriveStateFromDb(basePath);
  assert.equal(state.phase, "completing-milestone");
});

test("a newer canonical waiver reconciles completed validation gates from pass to omitted", async () => {
  const basePath = makeFixture();
  await recordPassingValidation(basePath, "test/milestone.validate/before-waiver");
  const rule = DISPATCH_RULES.find((candidate) =>
    candidate.name === "validating-milestone → validate-milestone"
  );
  assert.ok(rule);
  assert.equal((await rule.match(dispatchContext(basePath)))?.action, "dispatch");

  assert.deepEqual(checkCloseoutConsistencyGate("M001", {
    allowOpenMilestone: true,
    artifactBasePath: basePath,
  }), { ok: true });
  const authorization = readMilestoneCloseoutAuthorization({ milestoneId: "M001" });
  assert.equal(authorization.authorized, true);
  assert.ok(authorization.authorized);
  assert.equal(row(`
    SELECT verdict FROM quality_gates
    WHERE milestone_id = 'M001' AND gate_id = 'MV01'
  `).verdict, "pass");

  const completed = await handleCompleteMilestone({
    milestoneId: "M001",
    title: "Waived validation",
    oneLiner: "Completed under a newer canonical waiver.",
    narrative: "Gate reconciliation committed with milestone completion.",
    verificationPassed: true,
  }, basePath, {
    idempotencyKey: "test/milestone.complete/newer-waiver",
    sourceTransport: "internal",
    actorType: "agent",
  });
  assert.ok(!("error" in completed));
  const gate = row(`
    SELECT status, verdict, rationale FROM quality_gates
    WHERE milestone_id = 'M001' AND gate_id = 'MV01'
  `);
  assert.equal(gate.status, "complete");
  assert.equal(gate.verdict, "omitted");
  assert.match(String(gate.rationale), new RegExp(authorization.eventId));
  assert.match(String(gate.rationale), new RegExp(`revision ${authorization.revision}`));
  const gateRunCount = row(`SELECT COUNT(*) AS count FROM gate_runs`).count;
  assert.deepEqual(checkCloseoutConsistencyGate("M001", {
    allowOpenMilestone: true,
    artifactBasePath: basePath,
  }), { ok: true });
  assert.equal(row(`SELECT COUNT(*) AS count FROM gate_runs`).count, gateRunCount);
});

test("a newer passing validation supersedes a waiver without intermediate gate mutation", async () => {
  const basePath = makeFixture();
  insertGateRow({
    milestoneId: "M001",
    sliceId: "S01",
    gateId: "MV01",
    scope: "milestone",
    status: "pending",
  });
  const rule = DISPATCH_RULES.find((candidate) =>
    candidate.name === "validating-milestone → validate-milestone"
  );
  assert.ok(rule);
  assert.equal((await rule.match(dispatchContext(basePath)))?.action, "dispatch");
  assert.deepEqual(checkCloseoutConsistencyGate("M001", {
    allowOpenMilestone: true,
    artifactBasePath: basePath,
  }), { ok: true });
  assert.deepEqual(
    row(`SELECT status, verdict FROM quality_gates WHERE milestone_id = 'M001' AND gate_id = 'MV01'`),
    { status: "pending", verdict: "" },
  );

  await recordPassingValidation(basePath, "test/milestone.validate/after-waiver");
  assert.deepEqual(checkCloseoutConsistencyGate("M001", {
    allowOpenMilestone: true,
    artifactBasePath: basePath,
  }), { ok: true });
  const authorization = readMilestoneCloseoutAuthorization({ milestoneId: "M001" });
  assert.equal(authorization.authorized, true);
  assert.ok(authorization.authorized);
  const completed = await handleCompleteMilestone({
    milestoneId: "M001",
    title: "Validated milestone",
    oneLiner: "Completed under the newer passing validation.",
    narrative: "The passing validation superseded the earlier waiver.",
    verificationPassed: true,
  }, basePath, {
    idempotencyKey: "test/milestone.complete/validation-after-waiver",
    sourceTransport: "internal",
    actorType: "agent",
  });
  assert.ok(!("error" in completed));
  const gate = row(`
    SELECT status, verdict, rationale FROM quality_gates
    WHERE milestone_id = 'M001' AND gate_id = 'MV01'
  `);
  assert.equal(gate.status, "complete");
  assert.equal(gate.verdict, "pass");
  assert.match(String(gate.rationale), new RegExp(authorization.eventId));
  assert.match(String(gate.rationale), new RegExp(`revision ${authorization.revision}`));
});

test("adopted validation without invocation identity fails before any write", async () => {
  const basePath = makeFixture();

  const result = await handleValidateMilestone({
    milestoneId: "M001",
    verdict: "pass",
    remediationRound: 0,
    successCriteriaChecklist: "- [x] Complete",
    sliceDeliveryAudit: "Delivered",
    crossSliceIntegration: "Passed",
    requirementCoverage: "Covered",
    verdictRationale: "Everything passes.",
  }, basePath);

  assert.deepEqual(result, {
    error: "adopted Milestone validation requires canonical invocation identity",
  });
  assert.equal(row(`SELECT COUNT(*) AS count FROM assessments`).count, 0);
  assert.equal(row(`SELECT COUNT(*) AS count FROM workflow_operations WHERE operation_type = 'milestone.validate'`).count, 0);
});
