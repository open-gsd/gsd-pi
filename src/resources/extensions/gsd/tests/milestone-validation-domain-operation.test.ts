// Project/App: gsd-pi
// File Purpose: RED contracts for durable Milestone validation and DB-only completion readiness.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";

import type { DomainOperationContext } from "../db/domain-operation.ts";
import { adoptOrTransitionLifecycle } from "../db/writers/lifecycle-commands.ts";
import { readMilestoneCloseoutReadiness } from "../db/milestone-closeout-readiness.ts";
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
import { clearPathCache } from "../paths.ts";
import { handleCompleteMilestone } from "../tools/complete-milestone.ts";
import {
  handleValidateMilestone,
  type ValidateMilestoneOptions,
  type ValidateMilestoneParams,
} from "../tools/validate-milestone.ts";
import { captureVerificationSourceSnapshot } from "../verification-source-integrity.ts";
import {
  answerMilestoneSubjectiveUat,
  prepareMilestoneSubjectiveUat,
} from "../milestone-subjective-uat-domain-operation.ts";

const tempDirs = new Set<string>();

type ValidationOptionsWithInvocation = ValidateMilestoneOptions & {
  invocation: ExecutionInvocation;
};

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
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
    actorId: "milestone-validation-test",
    traceId: `trace/${idempotencyKey}`,
    turnId: `turn/${idempotencyKey}`,
  };
}

function executeAtFence(
  operationType: string,
  idempotencyKey: string,
  write: (context: Readonly<DomainOperationContext>) => void = () => {},
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
        eventType: operationType,
        entityType: "milestone",
        entityId: "M001",
        payload: { idempotencyKey },
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

function makeBase(plannedUat = "", adopted = true, adoptDescendants = adopted): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-milestone-validation-domain-"));
  tempDirs.add(basePath);
  const milestoneDir = join(basePath, ".gsd", "milestones", "M001");
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(join(milestoneDir, "M001-CONTEXT.md"), "# M001\n");
  writeFileSync(join(basePath, "source.ts"), "export const source = 'validated';\n");
  execFileSync("git", ["init"], { cwd: basePath, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: basePath });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: basePath });
  execFileSync("git", ["add", "source.ts"], { cwd: basePath });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: basePath, stdio: "ignore" });

  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  insertMilestone({
    id: "M001",
    title: "Milestone validation",
    status: "active",
    planning: { verificationUat: plannedUat },
  });
  insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "complete" });
  if (adopted) executeAtFence("test.milestone.fixture", "fixture/milestone/adopt", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone",
      milestoneId: "M001",
      lifecycleStatus: "ready",
    });
    if (adoptDescendants) {
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
    }
  });
  return basePath;
}

const validValidation: ValidateMilestoneParams = {
  milestoneId: "M001",
  verdict: "pass",
  remediationRound: 0,
  successCriteriaChecklist: "- [x] Complete",
  sliceDeliveryAudit: "| S01 | delivered |",
  crossSliceIntegration: "Passed",
  requirementCoverage: "Covered",
  verificationClasses: "| Class | Evidence | Verdict |\n| --- | --- | --- |\n| Contract | focused test | PASS |",
  verdictRationale: "All current database evidence passes.",
};

function validationOptions(idempotencyKey: string): ValidationOptionsWithInvocation {
  return {
    invocation: invocation(idempotencyKey),
    skipBrowserEvidenceGate: true,
  };
}

async function validate(
  basePath: string,
  idempotencyKey: string,
  overrides: Partial<ValidateMilestoneParams> = {},
) {
  return handleValidateMilestone(
    { ...validValidation, ...overrides },
    basePath,
    validationOptions(idempotencyKey),
  );
}

async function complete(basePath: string) {
  return handleCompleteMilestone({
    milestoneId: "M001",
    title: "Milestone validation",
    oneLiner: "Validated closeout",
    narrative: "The Milestone is ready to close.",
    verificationPassed: true,
  }, basePath, invocation("milestone-complete/public"));
}

function sourceRevision(basePath: string): string {
  const source = captureVerificationSourceSnapshot([{ id: "project", cwd: basePath }]);
  if (!source.ok) throw new Error(source.error);
  return source.snapshot.aggregateRevision;
}

afterEach(() => {
  clearPathCache();
  clearParseCache();
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("Milestone validation commits one immutable receipt and exact replay adds no lineage", async () => {
  const basePath = makeBase();
  const key = "milestone-validate/public/replay";
  const operationsBefore = row("SELECT COUNT(*) AS count FROM workflow_operations").count;

  const committed = await handleValidateMilestone(
    validValidation,
    basePath,
    { ...validationOptions(key), uokGatesEnabled: true },
  );
  assert.ok(!("error" in committed), "initial validation should commit");
  const compatibilityCounts = {
    assessments: row("SELECT COUNT(*) AS count FROM assessments").count,
    gates: row("SELECT COUNT(*) AS count FROM quality_gates").count,
  };
  const compatibilityRows = {
    assessment: db().prepare(`
      SELECT status, full_content, created_at FROM assessments
      WHERE scope = 'milestone-validation'
    `).get(),
    gates: db().prepare(`
      SELECT gate_id, verdict, evaluated_at FROM quality_gates
      WHERE milestone_id = 'M001' ORDER BY gate_id
    `).all(),
    gateRuns: row("SELECT COUNT(*) AS count FROM gate_runs").count,
  };
  writeFileSync(committed.validationPath, "projection repair sentinel\n");
  writeFileSync(join(basePath, "source.ts"), "export const source = 'drifted after validation';\n");
  const replayed = await handleValidateMilestone(
    validValidation,
    basePath,
    { ...validationOptions(key), uokGatesEnabled: true },
  );

  assert.ok(!("error" in replayed), "exact retry should replay");
  assert.match(
    readFileSync(committed.validationPath, "utf8"),
    /^---\nverdict: pass/m,
    "exact Domain Operation replay should repair the readable projection",
  );
  assert.equal(row("SELECT COUNT(*) AS count FROM assessments").count, compatibilityCounts.assessments);
  assert.equal(row("SELECT COUNT(*) AS count FROM quality_gates").count, compatibilityCounts.gates);
  assert.deepEqual(db().prepare(`
    SELECT status, full_content, created_at FROM assessments
    WHERE scope = 'milestone-validation'
  `).get(), compatibilityRows.assessment);
  assert.deepEqual(db().prepare(`
    SELECT gate_id, verdict, evaluated_at FROM quality_gates
    WHERE milestone_id = 'M001' ORDER BY gate_id
  `).all(), compatibilityRows.gates);
  assert.equal(
    row("SELECT COUNT(*) AS count FROM gate_runs").count,
    compatibilityRows.gateRuns,
    "exact replay must not append UOK gate lineage",
  );
  assert.equal(row(`
    SELECT COUNT(*) AS count FROM workflow_operations
    WHERE operation_type = 'milestone.validate' AND idempotency_key = '${key}'
  `).count, 1, "exact retry must retain one immutable operation receipt");
  assert.equal(row(`
    SELECT COUNT(*) AS count FROM workflow_domain_events event
    JOIN workflow_operations operation ON operation.operation_id = event.operation_id
    WHERE operation.operation_type = 'milestone.validate'
      AND operation.idempotency_key = '${key}'
  `).count, 1, "exact retry must retain one validation event");
  assert.equal(
    row("SELECT COUNT(*) AS count FROM workflow_operations").count,
    Number(operationsBefore) + 1,
    "one accepted public command must create exactly one Domain Operation",
  );
});

test("unadopted validation keeps legacy compatibility even with transport identity", async () => {
  const basePath = makeBase("", false);
  const result = await handleValidateMilestone(
    validValidation,
    basePath,
    validationOptions("milestone-validate/public/unadopted"),
  );

  assert.ok(!("error" in result));
  assert.equal(result.operationId, undefined);
  assert.equal(row(`SELECT COUNT(*) AS count FROM workflow_operations WHERE operation_type = 'milestone.validate'`).count, 0);
  assert.equal(row(`SELECT COUNT(*) AS count FROM assessments WHERE scope = 'milestone-validation'`).count, 1);
  assert.match(readFileSync(result.validationPath, "utf8"), /verdict: pass/);
});

test("historical validation replay cannot replace the current compatibility projection", async () => {
  const basePath = makeBase();
  const firstKey = "milestone-validate/public/historical-first";
  const first = await validate(basePath, firstKey);
  assert.ok(!("error" in first));
  const second = await validate(basePath, "milestone-validate/public/historical-second", {
    verdict: "needs-attention",
    verdictRationale: "The current validation needs more objective evidence.",
  });
  assert.ok(!("error" in second));
  const currentProjection = readFileSync(second.validationPath, "utf8");
  const currentAssessment = row(`
    SELECT status, full_content, created_at FROM assessments
    WHERE scope = 'milestone-validation'
  `);

  const replay = await validate(basePath, firstKey);

  assert.ok(!("error" in replay));
  assert.equal(replay.duplicate, true);
  assert.equal(replay.current, false);
  assert.equal(replay.superseded, true);
  assert.equal(replay.stale, true);
  assert.equal(readFileSync(second.validationPath, "utf8"), currentProjection);
  assert.deepEqual(row(`
    SELECT status, full_content, created_at FROM assessments
    WHERE scope = 'milestone-validation'
  `), currentAssessment);
});

test("Milestone validation binds current user acceptance and is immediately closeout-ready", async () => {
  const basePath = makeBase();
  const prepared = prepareMilestoneSubjectiveUat({
    invocation: invocation("milestone-validate/subjective/prepare"),
    milestoneId: "M001",
    criterionKey: "guided-flow",
    description: "The guided flow feels natural and clear.",
    focusedPrompt: "Does the guided flow feel natural and clear?",
    recommendedDisposition: "accepted",
    recommendationRationale: "Automated checks passed and the guided path is complete.",
    recommendationEvidence: "Current technical validation receipt.",
    testedSourceRevision: sourceRevision(basePath),
  });
  const accepted = prepared.options.find((option) => option.disposition === "accepted");
  assert.ok(accepted);
  const answer = answerMilestoneSubjectiveUat({
    invocation: {
      ...invocation("milestone-validate/subjective/answer"),
      actorType: "user",
      actorId: "developer",
    },
    criterionId: prepared.criterionId,
    questionId: prepared.questionId,
    interactionId: prepared.interactionId,
    selectedOptionId: accepted.optionId,
    verbatimResponse: accepted.label,
    rationale: "The user explicitly accepted the guided experience.",
    testedSourceRevision: sourceRevision(basePath),
  });

  const result = await validate(basePath, "milestone-validate/public/subjective");

  assert.ok(!("error" in result), "validation should include the current user acceptance");
  const payload = JSON.parse(String(row(`
    SELECT payload_json FROM workflow_domain_events
    WHERE event_type = 'milestone.validation.recorded'
    ORDER BY project_revision DESC LIMIT 1
  `).payload_json)) as Record<string, unknown>;
  assert.deepEqual(payload["humanAcceptanceIds"], [answer.humanAcceptanceId]);
  assert.ok((payload["criterionIds"] as string[]).includes(prepared.criterionId));
  assert.deepEqual(readMilestoneCloseoutReadiness({ milestoneId: "M001" }), {
    ready: true,
    validationEventId: result.operationId ? String(row(`
      SELECT event_id FROM workflow_domain_events
      WHERE operation_id = '${result.operationId}'
        AND event_type = 'milestone.validation.recorded'
    `).event_id) : "",
    validationRevision: result.resultingRevision,
  });
});

test("Milestone validation rejects an older acceptance while a newer UAT question is open", async () => {
  const basePath = makeBase();
  const testedSourceRevision = sourceRevision(basePath);
  const first = prepareMilestoneSubjectiveUat({
    invocation: invocation("milestone-validate/subjective/open/prepare-1"),
    milestoneId: "M001",
    criterionKey: "guided-flow",
    description: "The guided flow feels natural and clear.",
    focusedPrompt: "Does the guided flow feel natural and clear?",
    recommendedDisposition: "accepted",
    recommendationRationale: "Automated checks passed.",
    recommendationEvidence: "Current technical validation receipt.",
    testedSourceRevision,
  });
  const accepted = first.options.find((option) => option.disposition === "accepted")!;
  answerMilestoneSubjectiveUat({
    invocation: {
      ...invocation("milestone-validate/subjective/open/answer-1"),
      actorType: "user",
      actorId: "developer",
    },
    criterionId: first.criterionId,
    questionId: first.questionId,
    interactionId: first.interactionId,
    selectedOptionId: accepted.optionId,
    verbatimResponse: accepted.label,
    rationale: "The user accepted the first review.",
    testedSourceRevision,
  });
  prepareMilestoneSubjectiveUat({
    invocation: invocation("milestone-validate/subjective/open/prepare-2"),
    milestoneId: "M001",
    criterionKey: "guided-flow",
    description: "The guided flow feels natural and clear.",
    focusedPrompt: "Does the guided flow still feel natural and clear?",
    recommendedDisposition: "accepted",
    recommendationRationale: "A fresh review is required.",
    recommendationEvidence: "Current technical validation receipt.",
    testedSourceRevision,
  });

  await assert.rejects(
    () => validate(basePath, "milestone-validate/public/open-subjective"),
    /accepted subjective UAT criterion/i,
  );
});

test("Milestone validation rejects subjective acceptance from an older source", async () => {
  const basePath = makeBase();
  const testedSourceRevision = sourceRevision(basePath);
  const prepared = prepareMilestoneSubjectiveUat({
    invocation: invocation("milestone-validate/subjective/source/prepare"),
    milestoneId: "M001",
    criterionKey: "guided-flow",
    description: "The guided flow feels natural and clear.",
    focusedPrompt: "Does the guided flow feel natural and clear?",
    recommendedDisposition: "accepted",
    recommendationRationale: "Automated checks passed.",
    recommendationEvidence: "Current technical validation receipt.",
    testedSourceRevision,
  });
  const accepted = prepared.options.find((option) => option.disposition === "accepted")!;
  answerMilestoneSubjectiveUat({
    invocation: {
      ...invocation("milestone-validate/subjective/source/answer"),
      actorType: "user",
      actorId: "developer",
    },
    criterionId: prepared.criterionId,
    questionId: prepared.questionId,
    interactionId: prepared.interactionId,
    selectedOptionId: accepted.optionId,
    verbatimResponse: accepted.label,
    rationale: "The user accepted the reviewed source.",
    testedSourceRevision,
  });
  writeFileSync(join(basePath, "source.ts"), "export const source = 'changed before validation';\n");

  await assert.rejects(
    () => validate(basePath, "milestone-validate/public/stale-subjective"),
    /accepted subjective UAT criterion/i,
  );
});

test("Milestone validation rejects changed facts under the same execution identity", async () => {
  const basePath = makeBase();
  const key = "milestone-validate/public/conflict";
  await validate(basePath, key);

  await assert.rejects(
    () => validate(basePath, key, {
      verdict: "needs-attention",
      verdictRationale: "Conflicting facts under the same key.",
    }),
    /idempotency conflict/i,
  );
});

test("Milestone validation repairs evidence-backed legacy descendant authority before closeout", async () => {
  const basePath = makeBase("", true, false);
  executeAtFence("test.task.fixture", "fixture/task/adopt-ready", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      lifecycleStatus: "ready",
    });
  });
  const completedAt = "2026-01-02T03:04:05.000Z";
  const adapter = _getAdapter();
  assert.ok(adapter);
  adapter.prepare(`
    UPDATE slices
    SET completed_at = :completed_at, full_summary_md = :summary
    WHERE milestone_id = 'M001' AND id = 'S01'
  `).run({
    ":completed_at": completedAt,
    ":summary": "# S01 Summary\n\nVerified legacy Slice completion.\n",
  });
  adapter.prepare(`
    UPDATE tasks
    SET completed_at = :completed_at,
        verification_result = 'passed',
        full_summary_md = :summary
    WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
  `).run({
    ":completed_at": completedAt,
    ":summary": "# T01 Summary\n\nVerified legacy Task completion.\n",
  });

  const validated = await validate(basePath, "milestone-validate/public/shadow-repair");
  assert.ok(!("error" in validated), "validation should repair durable legacy authority");
  assert.deepEqual(adapter.prepare(`
    SELECT item_kind, lifecycle_status
    FROM workflow_item_lifecycles
    WHERE milestone_id = 'M001' AND item_kind IN ('task', 'slice')
    ORDER BY item_kind
  `).all(), [
    { item_kind: "slice", lifecycle_status: "completed" },
    { item_kind: "task", lifecycle_status: "completed" },
  ]);
  assert.equal(Number(row(`
    SELECT COUNT(*) AS count
    FROM workflow_operations
    WHERE operation_type = 'lifecycle.shadow.repair'
  `).count), 3);

  const completed = await complete(basePath);
  assert.ok(!("error" in completed), "the post-repair validation receipt should authorize closeout");
  assert.equal(completed.milestoneId, "M001");
  assert.equal(row("SELECT status FROM milestones WHERE id = 'M001'").status, "complete");
});

test("Milestone validation refuses legacy descendant repair without durable evidence", async () => {
  const basePath = makeBase("", true, false);

  const result = await validate(basePath, "milestone-validate/public/shadow-unresolved");

  assert.ok("error" in result, "unsupported legacy authority must block validation");
  assert.match(result.error, /unresolved canonical lifecycle shadows/i);
  assert.match(result.error, /M001\/S01\/T01/);
  assert.match(result.error, /M001\/S01/);
  assert.equal(Number(row(`
    SELECT COUNT(*) AS count
    FROM workflow_operations
    WHERE operation_type IN ('lifecycle.shadow.repair', 'milestone.validate')
  `).count), 0);
});

test("Milestone completion rejects a file-only passing validation", async () => {
  const basePath = makeBase();
  writeFileSync(
    join(basePath, ".gsd", "milestones", "M001", "M001-VALIDATION.md"),
    "---\nverdict: pass\n---\n# File-only validation\n",
  );

  const result = await complete(basePath);

  assert.ok("error" in result, "a projection must not authorize completion");
  assert.match(result.error, /validation|database|evidence/i);
});

test("adopted Milestone completion fails closed without canonical invocation identity", async () => {
  const basePath = makeBase();
  const result = await handleCompleteMilestone({
    milestoneId: "M001",
    title: "Milestone validation",
    oneLiner: "Validated closeout",
    narrative: "The Milestone is ready to close.",
    verificationPassed: true,
  }, basePath);

  assert.ok("error" in result);
  assert.match(result.error, /canonical invocation identity/i);
});

test("Milestone completion rejects passing validation made stale by a descendant lifecycle change", async () => {
  const basePath = makeBase();
  const validated = await validate(basePath, "milestone-validate/public/stale");
  assert.ok(!("error" in validated), "validation fixture should commit");
  executeAtFence("task.reopen", "fixture/task/newer-revision", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      lifecycleStatus: "ready",
    });
  });

  const result = await complete(basePath);

  assert.ok("error" in result, "stale validation must not authorize completion");
  assert.match(result.error, /stale|revision|current|source/i);
});

test("Milestone completion rejects passing validation after source changes", async () => {
  const basePath = makeBase();
  const validated = await validate(basePath, "milestone-validate/public/source-stale");
  assert.ok(!("error" in validated), "validation fixture should commit");
  writeFileSync(join(basePath, "source.ts"), "export const source = 'changed after validation';\n");

  const result = await complete(basePath);

  assert.ok("error" in result, "validation for an older source must not authorize completion");
  assert.match(result.error, /source|revision|current|stale/i);
});

test("Milestone completion rejects newer failed DB evidence despite a passing validation file", async () => {
  const basePath = makeBase();
  const passing = await validate(basePath, "milestone-validate/public/pass-before-failure");
  assert.ok(!("error" in passing), "passing validation fixture should commit");
  const failed = await validate(basePath, "milestone-validate/public/newer-failure", {
    verdict: "needs-attention",
    verdictRationale: "The latest database evidence does not pass.",
  });
  assert.ok(!("error" in failed), "newer failed validation fixture should commit");
  writeFileSync(
    join(basePath, ".gsd", "milestones", "M001", "M001-VALIDATION.md"),
    "---\nverdict: pass\n---\n# Stale passing projection\n",
  );

  const result = await complete(basePath);

  assert.ok("error" in result, "newer failed database evidence must block completion");
  assert.match(result.error, /needs-attention|validation|evidence/i);
});

test("planned UAT cannot pass from prose without a current database UAT fact", async () => {
  const basePath = makeBase("Run the browser acceptance journey.");

  const result = await validate(basePath, "milestone-validate/public/missing-uat", {
    verificationClasses:
      "| Class | Evidence | Verdict |\n| --- | --- | --- |\n| UAT | Not run | PASS |",
  });

  assert.ok("error" in result, "required UAT must be backed by current database evidence");
  assert.match(result.error, /UAT|evidence|database|current/i);
  assert.equal(row(`
    SELECT COUNT(*) AS count FROM workflow_operations
    WHERE operation_type = 'milestone.validate'
  `).count, 0, "rejected UAT must leave no validation operation");
});

test("adopted validation rejects file-only browser evidence inferred from Slice requirements", async () => {
  const basePath = makeBase();
  db().prepare(`
    UPDATE slices
    SET demo = 'Open the browser and verify the guided journey.'
    WHERE id = 'S01'
  `).run();
  const assessmentPath = join(
    basePath,
    ".gsd",
    "milestones",
    "M001",
    "slices",
    "S01",
    "S01-ASSESSMENT.md",
  );
  mkdirSync(dirname(assessmentPath), { recursive: true });
  writeFileSync(
    assessmentPath,
    "# Assessment\n\nBrowser journey clicked through successfully with assertions.\n",
  );

  const result = await validate(basePath, "milestone-validate/public/file-browser", {
    verificationClasses:
      "| Class | Evidence | Verdict |\n| --- | --- | --- |\n| UAT | persisted assessment | PASS |",
  });

  assert.ok("error" in result, "file-only browser prose must not authorize canonical validation");
  assert.match(result.error, /UAT|structured|database|evidence/i);
  assert.equal(row(`
    SELECT COUNT(*) AS count FROM workflow_operations
    WHERE operation_type = 'milestone.validate'
  `).count, 0);
});

test("planned UAT passes only with source-bound structured browser evidence", async () => {
  const basePath = makeBase("Run the browser acceptance journey.");
  const params = {
    ...validValidation,
    verificationClasses:
      "| Class | Evidence | Verdict |\n| --- | --- | --- |\n| UAT | Browser journey | PASS |",
    verificationEvidence: [{
      verificationClass: "UAT",
      evidenceClass: "browser",
      commandOrTool: "browser acceptance journey",
      workingDirectory: basePath,
      startedAt: "2026-07-14T10:00:00.000Z",
      endedAt: "2026-07-14T10:01:00.000Z",
      testedSourceRevision: sourceRevision(basePath),
      observation: "passed",
      durableOutputRef: "artifact://browser/acceptance-journey",
      environment: { runner: "browser", route: "/acceptance" },
      rationale: "The user-visible acceptance journey passed.",
    }],
  } as ValidateMilestoneParams & {
    verificationEvidence: Array<Record<string, unknown>>;
  };

  const result = await handleValidateMilestone(
    params,
    basePath,
    { invocation: invocation("milestone-validate/public/structured-uat") },
  );

  assert.ok(!("error" in result), `unexpected validation error: ${"error" in result ? result.error : ""}`);
  assert.equal(result.verdict, "pass", "current structured browser evidence must satisfy the browser gate");
  assert.equal(JSON.parse(String(row(`
    SELECT payload_json FROM workflow_domain_events
    WHERE event_type = 'milestone.validation.recorded'
  `).payload_json)).overallVerdict, "pass");
  assert.deepEqual(db().prepare(`
    SELECT criterion.criterion_key, criterion.evidence_class, verdict.verdict, evidence.observation
    FROM workflow_acceptance_criteria criterion
    JOIN workflow_technical_verdicts verdict ON verdict.criterion_id = criterion.criterion_id
    JOIN workflow_verification_evidence evidence ON evidence.verdict_id = verdict.verdict_id
    WHERE criterion.criterion_key = 'milestone-validation:uat'
  `).get(), {
    criterion_key: "milestone-validation:uat",
    evidence_class: "browser",
    verdict: "pass",
    observation: "passed",
  });
});

test("browser-required Slice rejects unscoped UAT evidence", async () => {
  const basePath = makeBase();
  db().prepare(`UPDATE slices SET demo = 'Open the browser and verify the guided journey.' WHERE id = 'S01'`).run();
  const evidence = {
    verificationClass: "UAT" as const,
    evidenceClass: "browser" as const,
    commandOrTool: "browser acceptance journey",
    workingDirectory: basePath,
    startedAt: "2026-07-14T10:00:00.000Z",
    endedAt: "2026-07-14T10:01:00.000Z",
    testedSourceRevision: sourceRevision(basePath),
    observation: "passed" as const,
    durableOutputRef: "artifact://browser/acceptance-journey",
    environment: { runner: "browser", route: "/acceptance" },
    rationale: "The user-visible acceptance journey passed.",
  };
  const verificationClasses =
    "| Class | Evidence | Verdict |\n| --- | --- | --- |\n| UAT | Browser journey | PASS |";

  const unbound = await handleValidateMilestone({
    ...validValidation,
    verificationClasses,
    verificationEvidence: [evidence],
  }, basePath, { invocation: invocation("milestone-validate/public/unbound-browser") });
  assert.ok("error" in unbound);
  assert.match(unbound.error, /UAT|browser|required Slice|bound/i);
});

test("browser-required Slice accepts source-bound UAT evidence scoped to that Slice", async () => {
  const boundBasePath = makeBase();
  db().prepare(`UPDATE slices SET demo = 'Open the browser and verify the guided journey.' WHERE id = 'S01'`).run();
  const evidence = {
    verificationClass: "UAT" as const,
    evidenceClass: "browser" as const,
    commandOrTool: "browser acceptance journey",
    workingDirectory: boundBasePath,
    startedAt: "2026-07-14T10:00:00.000Z",
    endedAt: "2026-07-14T10:01:00.000Z",
    testedSourceRevision: sourceRevision(boundBasePath),
    observation: "passed" as const,
    durableOutputRef: "artifact://browser/acceptance-journey",
    environment: { runner: "browser", route: "/acceptance" },
    rationale: "The user-visible acceptance journey passed.",
    sliceId: "S01",
  };
  const bound = await handleValidateMilestone({
    ...validValidation,
    verificationClasses:
      "| Class | Evidence | Verdict |\n| --- | --- | --- |\n| UAT | Browser journey | PASS |",
    verificationEvidence: [evidence],
  }, boundBasePath, { invocation: invocation("milestone-validate/public/bound-browser") });
  assert.ok(!("error" in bound));
  assert.equal(bound.verdict, "pass");
});

test("planned UAT rejects structured evidence from an older source revision", async () => {
  const basePath = makeBase("Run the browser acceptance journey.");

  const result = await handleValidateMilestone({
    ...validValidation,
    verificationClasses:
      "| Class | Evidence | Verdict |\n| --- | --- | --- |\n| UAT | Browser journey | PASS |",
    verificationEvidence: [{
      verificationClass: "UAT",
      evidenceClass: "browser",
      commandOrTool: "browser acceptance journey",
      workingDirectory: basePath,
      startedAt: "2026-07-14T10:00:00.000Z",
      endedAt: "2026-07-14T10:01:00.000Z",
      testedSourceRevision: "sha256:stale-source",
      observation: "passed",
      durableOutputRef: "artifact://browser/acceptance-journey",
      environment: { runner: "browser", route: "/acceptance" },
      rationale: "The user-visible acceptance journey passed.",
    }],
  }, basePath, validationOptions("milestone-validate/public/stale-structured-uat"));

  assert.ok("error" in result, "evidence from another source revision must fail closed");
  assert.match(result.error, /source|revision|current/i);
  assert.equal(row(`
    SELECT COUNT(*) AS count FROM workflow_operations
    WHERE operation_type = 'milestone.validate'
  `).count, 0, "stale evidence must not create a canonical validation receipt");
});
