// Project/App: gsd-pi
// File Purpose: Behavioral contract for deterministic DB-only Milestone closeout readiness.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import type { DomainOperationContext, DomainOperationResult } from "../db/domain-operation.ts";
import { readMilestoneCloseoutReadiness } from "../db/milestone-closeout-readiness.ts";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
} from "../db/writers/lifecycle-commands.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";
import {
  validateMilestone,
  type ValidateMilestoneReceipt,
} from "../milestone-validation-domain-operation.ts";
import {
  _getAdapter,
  closeDatabase,
  executeDomainOperation,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../gsd-db.ts";
import { resolveMilestoneValidationVerdict } from "../milestone-validation-verdict.ts";

const tempDirs = new Set<string>();
const CREATED_AT = "2026-07-14T12:00:00.000Z";

interface ValidationBundle {
  criterionIds: string[];
  verdictIds: string[];
  evidenceIds: string[];
  humanAcceptanceIds: string[];
}

interface Fixture {
  milestoneLifecycleId: string;
  taskLifecycleId: string;
}

function invocation(idempotencyKey: string): ExecutionInvocation {
  return {
    idempotencyKey,
    sourceTransport: "internal",
    actorType: "agent",
    actorId: "readiness-test",
  };
}

function execute(
  operationType: string,
  write: (context: Readonly<DomainOperationContext>) => void = () => {},
  actor: { actorType: string; actorId?: string } = { actorType: "test" },
  event?: { eventType: string; payload: Record<string, string> },
): DomainOperationResult {
  const fence = readDomainOperationFence();
  return executeDomainOperation({
    operationType,
    idempotencyKey: `test/${operationType}/${fence.revision}`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: actor.actorType,
    ...(actor.actorId ? { actorId: actor.actorId } : {}),
    sourceTransport: "test",
    payload: { operationType, revision: fence.revision },
  }, (context) => {
    write(context);
    return {
      events: [{
        eventType: event?.eventType ?? operationType,
        entityType: "milestone",
        entityId: "M001",
        payload: event?.payload ?? { operationType },
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: `test/${operationType}/${context.resultingRevision}`,
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}

function makeFixture(): Fixture {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-closeout-readiness-"));
  tempDirs.add(basePath);
  assert.equal(openDatabase(join(basePath, "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Closeout", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "complete" });

  let milestoneLifecycleId = "";
  let taskLifecycleId = "";
  execute("test.fixture.adopt", (context) => {
    milestoneLifecycleId = adoptOrTransitionLifecycle(context, {
      itemKind: "milestone",
      milestoneId: "M001",
      lifecycleStatus: "ready",
    }).lifecycleId;
    adoptOrTransitionLifecycle(context, {
      itemKind: "slice",
      milestoneId: "M001",
      sliceId: "S01",
      lifecycleStatus: "completed",
    });
    taskLifecycleId = adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      lifecycleStatus: "completed",
    }).lifecycleId;
  });
  return { milestoneLifecycleId, taskLifecycleId };
}

function recordCanonicalValidation(
  verdict: "pass" | "fail" | "inconclusive" = "pass",
  testedSourceRevision = "source-a",
): ValidateMilestoneReceipt {
  const runId = readDomainOperationFence().revision;
  let observation: "passed" | "failed" | "inconclusive" = "inconclusive";
  if (verdict === "pass") observation = "passed";
  else if (verdict === "fail") observation = "failed";
  return validateMilestone({
    invocation: invocation(`canonical/${runId}/validate`),
    milestoneId: "M001",
    testedSourceRevision,
    policyId: "test-policy",
    policyVersion: "1",
    verdict,
    rationale: `Validation recorded ${verdict}.`,
    outcome: "succeeded",
    failureClass: "none",
    summary: "Focused proof completed.",
    output: { testedSourceRevision },
    criteria: [{
      criterionKey: "focused-proof",
      evidenceClass: "command",
      description: "Focused proof must pass",
      verdict,
      rationale: `Focused proof recorded ${verdict}.`,
      evidence: [{
        evidenceClass: "command",
        commandOrTool: "node --test focused.test.ts",
        workingDirectory: ".",
        startedAt: CREATED_AT,
        endedAt: CREATED_AT,
        exitCode: verdict === "fail" ? 1 : 0,
        observation,
        durableOutputRef: `db://focused-proof/${runId}`,
        environment: { runner: "node-test" },
      }],
    }],
  });
}

function bundleFrom(receipt: ValidateMilestoneReceipt): ValidationBundle {
  return {
    criterionIds: receipt.verdicts.map((verdict) => verdict.criterionId),
    verdictIds: receipt.verdicts.map((verdict) => verdict.verdictId),
    evidenceIds: receipt.verdicts.flatMap((verdict) => verdict.evidenceIds),
    humanAcceptanceIds: [],
  };
}

function recordSyntheticValidation(input: {
  operationType?: string;
  overallVerdict?: string;
  receipt: ValidateMilestoneReceipt;
  bundle?: ValidationBundle;
  attemptId?: string;
  resultId?: string;
}): DomainOperationResult {
  const operationType = input.operationType ?? "milestone.validate";
  const overallVerdict = input.overallVerdict ?? input.receipt.verdict;
  const bundle = input.bundle ?? bundleFrom(input.receipt);
  const eventPayload = {
    milestoneId: "M001",
    lifecycleId: input.receipt.lifecycleId,
    attemptId: input.attemptId ?? input.receipt.attemptId,
    resultId: input.resultId ?? input.receipt.resultId,
    overallVerdict,
    testedSourceRevision: input.receipt.testedSourceRevision,
    policyId: "test-policy",
    policyVersion: "1",
    ...bundle,
  };
  assert.deepEqual(
    Object.entries(eventPayload).filter(([, value]) => value === undefined),
    [],
    "synthetic validation payload must be complete",
  );
  const fence = readDomainOperationFence();
  return executeDomainOperation({
    operationType,
    idempotencyKey: `synthetic/${operationType}/${fence.revision}`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { milestoneId: "M001", overallVerdict, revision: fence.revision },
  }, () => ({
    events: [{
      eventType: "milestone.validation.recorded",
      entityType: "milestone",
      entityId: "M001",
      payload: eventPayload,
      destinations: ["test"],
    }],
    projections: [{
      projectionKey: `synthetic/validation/${fence.revision + 1}`,
      projectionKind: "milestone-validation",
      rendererVersion: "1",
    }],
  }));
}

function prepareNewerAttempt(): string {
  const runId = readDomainOperationFence().revision;
  const attemptId = `attempt-newer-${runId}`;
  const lifecycleId = String(_getAdapter()!.prepare(`
    SELECT lifecycle_id FROM workflow_item_lifecycles
    WHERE item_kind = 'milestone' AND milestone_id = 'M001'
  `).get()?.["lifecycle_id"]);
  execute("test.validation-attempt.claim", (context) => {
    const adapter = _getAdapter()!;
    const prior = adapter.prepare(`
      SELECT attempt_id, attempt_number
      FROM workflow_execution_attempts
      WHERE lifecycle_id = :lifecycle_id
      ORDER BY attempt_number DESC
      LIMIT 1
    `).get({ ":lifecycle_id": lifecycleId });
    adapter.prepare(`
      INSERT INTO workflow_execution_attempts (
        attempt_id, project_id, lifecycle_id, attempt_number, retry_of_attempt_id,
        attempt_state, claimed_at, claim_operation_id,
        claim_project_revision, claim_authority_epoch
      ) VALUES (
        :attempt_id, :project_id, :lifecycle_id, :attempt_number, :retry_of_attempt_id,
        'claimed', :claimed_at, :operation_id, :project_revision, :authority_epoch
      )
    `).run({
      ":attempt_id": attemptId,
      ":project_id": context.projectId,
      ":lifecycle_id": lifecycleId,
      ":attempt_number": Number(prior?.["attempt_number"] ?? 0) + 1,
      ":retry_of_attempt_id": prior?.["attempt_id"] ?? null,
      ":claimed_at": CREATED_AT,
      ":operation_id": context.operationId,
      ":project_revision": context.resultingRevision,
      ":authority_epoch": context.resultingAuthorityEpoch,
    });
  });
  return attemptId;
}

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("readiness requires the exact canonical validation receipt, source, and descendant revision", () => {
  const { taskLifecycleId } = makeFixture();
  const recorded = recordCanonicalValidation();

  const ready = readMilestoneCloseoutReadiness({
    milestoneId: "M001",
    sourceRevision: "source-a",
  });
  assert.equal(ready.ready, true);
  if (ready.ready) {
    assert.equal(ready.validationEventId, recorded.eventIds[0]);
    assert.equal(ready.validationRevision, recorded.resultingRevision);
  }

  const wrongSource = readMilestoneCloseoutReadiness({
    milestoneId: "M001",
    sourceRevision: "source-b",
  });
  assert.equal(wrongSource.ready, false);
  if (!wrongSource.ready) {
    assert.deepEqual(wrongSource.blockers, [{
      kind: "validation-source-revision-mismatch",
      expectedSourceRevision: "source-b",
      testedSourceRevision: "source-a",
    }]);
  }

  execute("task.reopen", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      lifecycleStatus: "ready",
    });
    assert.equal(taskLifecycleId.length > 0, true);
  });
  const stale = readMilestoneCloseoutReadiness({ milestoneId: "M001" });
  assert.equal(stale.ready, false);
  if (!stale.ready) {
    assert.deepEqual(stale.blockers, [{
      kind: "validation-stale",
      validationRevision: recorded.resultingRevision,
      descendantRevision: recorded.resultingRevision + 1,
    }]);
  }
});

test("readiness ignores a forged validation event from a non-canonical operation", () => {
  makeFixture();
  const recorded = recordCanonicalValidation();
  recordSyntheticValidation({
    operationType: "test.forged-validation",
    overallVerdict: "fail",
    receipt: recorded,
  });

  const readiness = readMilestoneCloseoutReadiness({ milestoneId: "M001" });
  assert.equal(readiness.ready, true);
  if (readiness.ready) assert.equal(readiness.validationEventId, recorded.eventIds[0]);
});

test("readiness rejects receipt IDs that are not the exact proof set from its operation", () => {
  makeFixture();
  const recorded = recordCanonicalValidation();
  recordSyntheticValidation({
    receipt: recorded,
    bundle: {
      criterionIds: [...bundleFrom(recorded).criterionIds, "extra-criterion"],
      verdictIds: [...bundleFrom(recorded).verdictIds, "extra-verdict"],
      evidenceIds: [...bundleFrom(recorded).evidenceIds, "extra-evidence"],
      humanAcceptanceIds: ["extra-acceptance"],
    },
  });

  const readiness = readMilestoneCloseoutReadiness({ milestoneId: "M001" });
  assert.equal(readiness.ready, false);
  if (!readiness.ready) {
    assert.deepEqual(readiness.blockers, [{
      kind: "validation-receipt-invalid",
      fields: ["criterionIds", "verdictIds", "evidenceIds", "humanAcceptanceIds"],
    }]);
  }
});

test("readiness rejects a receipt bound to the wrong Attempt and Result", () => {
  makeFixture();
  const recorded = recordCanonicalValidation();
  recordSyntheticValidation({
    receipt: recorded,
    attemptId: "attempt-other",
    resultId: "result-other",
  });

  const readiness = readMilestoneCloseoutReadiness({ milestoneId: "M001" });
  assert.equal(readiness.ready, false);
  if (!readiness.ready) {
    assert.deepEqual(readiness.blockers, [{
      kind: "validation-receipt-invalid",
      fields: ["criterionIds", "attemptId", "resultId", "verdictIds", "evidenceIds"],
    }]);
  }
});

test("readiness blocks a newer active Milestone Attempt", () => {
  makeFixture();
  const recorded = recordCanonicalValidation();
  const attemptId = prepareNewerAttempt();

  const readiness = readMilestoneCloseoutReadiness({ milestoneId: "M001" });
  assert.equal(readiness.ready, false);
  if (!readiness.ready) {
    assert.deepEqual(readiness.blockers, [{
      kind: "validation-attempt-newer",
      attemptId,
      attemptState: "claimed",
      attemptRevision: recorded.resultingRevision + 1,
    }]);
  }
});

test("readiness blocks a newer settled Milestone Attempt without a later validation", () => {
  makeFixture();
  const recorded = recordCanonicalValidation();
  const attemptId = prepareNewerAttempt();
  const settled = execute("attempt.settle", (context) => {
    const adapter = _getAdapter()!;
    adapter.prepare(`
      UPDATE workflow_execution_attempts
      SET attempt_state = 'settled', settle_outcome = 'succeeded',
          ended_at = :ended_at, settle_operation_id = :operation_id,
          settle_project_revision = :project_revision,
          settle_authority_epoch = :authority_epoch
      WHERE attempt_id = :attempt_id
    `).run({
      ":attempt_id": attemptId,
      ":ended_at": CREATED_AT,
      ":operation_id": context.operationId,
      ":project_revision": context.resultingRevision,
      ":authority_epoch": context.resultingAuthorityEpoch,
    });
    const lifecycleId = String(adapter.prepare(`
      SELECT lifecycle_id FROM workflow_execution_attempts WHERE attempt_id = :attempt_id
    `).get({ ":attempt_id": attemptId })?.["lifecycle_id"]);
    adapter.prepare(`
      INSERT INTO workflow_attempt_results (
        result_id, project_id, lifecycle_id, attempt_id, outcome,
        created_at, operation_id, project_revision, authority_epoch
      ) VALUES (
        :result_id, :project_id, :lifecycle_id, :attempt_id, 'succeeded',
        :created_at, :operation_id, :project_revision, :authority_epoch
      )
    `).run({
      ":result_id": `result-${attemptId}`,
      ":project_id": context.projectId,
      ":lifecycle_id": lifecycleId,
      ":attempt_id": attemptId,
      ":created_at": CREATED_AT,
      ":operation_id": context.operationId,
      ":project_revision": context.resultingRevision,
      ":authority_epoch": context.resultingAuthorityEpoch,
    });
  });

  const readiness = readMilestoneCloseoutReadiness({ milestoneId: "M001" });
  assert.equal(readiness.ready, false);
  if (!readiness.ready) {
    assert.deepEqual(readiness.blockers, [{
      kind: "validation-attempt-newer",
      attemptId,
      attemptState: "settled",
      attemptRevision: settled.resultingRevision,
    }]);
  }
});

test("closeout readiness selects canonical validation without changing the public legacy verdict", async () => {
  makeFixture();
  const canonical = recordCanonicalValidation("pass");
  assert.equal(await resolveMilestoneValidationVerdict(".", "M001"), undefined);

  const readiness = readMilestoneCloseoutReadiness({ milestoneId: "M001" });
  assert.equal(readiness.ready, true);
  if (readiness.ready) assert.equal(readiness.validationRevision, canonical.resultingRevision);
});

test("readiness accepts an earlier genuine human acceptance that is still current", () => {
  const { milestoneLifecycleId } = makeFixture();
  const db = _getAdapter()!;
  execute("test.subjective.prepare", (context) => {
    db.prepare(`
      INSERT INTO workflow_acceptance_criteria (
        criterion_id, criterion_key, project_id, lifecycle_id,
        criterion_kind, evidence_class, required, description, created_at,
        operation_id, project_revision, authority_epoch
      ) VALUES (
        'criterion-subjective', 'subjective-flow', :project_id, :lifecycle_id,
        'subjective_uat', 'human', 1, 'The guided flow feels acceptable', :created_at,
        :operation_id, :project_revision, :authority_epoch
      )
    `).run({
      ":project_id": context.projectId,
      ":lifecycle_id": milestoneLifecycleId,
      ":created_at": CREATED_AT,
      ":operation_id": context.operationId,
      ":project_revision": context.resultingRevision,
      ":authority_epoch": context.resultingAuthorityEpoch,
    });
    db.prepare(`
      INSERT INTO workflow_open_questions (
        question_id, project_id, lifecycle_id, question_text, question_status,
        state_version, created_at, updated_at,
        created_operation_id, created_project_revision, created_authority_epoch,
        last_operation_id, last_project_revision, last_authority_epoch
      ) VALUES (
        'question-uat', :project_id, :lifecycle_id, 'Does this experience feel right?',
        'open', 0, :created_at, :created_at,
        :operation_id, :project_revision, :authority_epoch,
        :operation_id, :project_revision, :authority_epoch
      )
    `).run({
      ":project_id": context.projectId,
      ":lifecycle_id": milestoneLifecycleId,
      ":created_at": CREATED_AT,
      ":operation_id": context.operationId,
      ":project_revision": context.resultingRevision,
      ":authority_epoch": context.resultingAuthorityEpoch,
    });
  });
  let interactionRevision = 0;
  execute("test.subjective.interaction", (context) => {
    interactionRevision = context.resultingRevision;
    db.prepare(`
      INSERT INTO workflow_interactions (
        interaction_id, project_id, question_id, sequence, interaction_kind,
        presentation_state, focused_prompt, requires_answer, option_count,
        recommendation_text, recommendation_rationale, recommendation_evidence,
        recommendation_confidence, recommendation_uncertainty, revisit_condition,
        presented_at, operation_id, project_revision, authority_epoch
      ) VALUES (
        'interaction-uat', :project_id, 'question-uat', 1, 'subjective-uat',
        'prepared', 'Does this feel acceptable?', 1, 0,
        'Accept if the guided flow feels natural', 'Objective checks already passed',
        'technical verdicts', 0.8, '', '', :presented_at,
        :operation_id, :project_revision, :authority_epoch
      )
    `).run({
      ":project_id": context.projectId,
      ":presented_at": CREATED_AT,
      ":operation_id": context.operationId,
      ":project_revision": context.resultingRevision,
      ":authority_epoch": context.resultingAuthorityEpoch,
    });
    db.prepare(`
      UPDATE workflow_interactions
      SET presentation_state = 'presented'
      WHERE interaction_id = 'interaction-uat'
    `).run();
  });
  execute("milestone.subjective-uat.answer", (context) => {
    db.prepare(`
      INSERT INTO workflow_answers (
        answer_id, project_id, question_id, interaction_id, response_kind,
        verbatim_response, normalized_interpretation, interpretation_confidence,
        answer_disposition, observed_project_revision, created_at,
        operation_id, project_revision, authority_epoch
      ) VALUES (
        'answer-uat', :project_id, 'question-uat', 'interaction-uat', 'answer',
        'Yes, this feels natural.', 'accepted_subjective_experience', 0.9,
        'accepted', :observed_revision, :created_at,
        :operation_id, :project_revision, :authority_epoch
      )
    `).run({
      ":project_id": context.projectId,
      ":observed_revision": interactionRevision,
      ":created_at": CREATED_AT,
      ":operation_id": context.operationId,
      ":project_revision": context.resultingRevision,
      ":authority_epoch": context.resultingAuthorityEpoch,
    });
    db.prepare(`
      UPDATE workflow_open_questions
      SET question_status = 'answered', accepted_answer_id = 'answer-uat',
          state_version = 1, updated_at = '2026-07-14T12:01:00.000Z',
          last_operation_id = :operation_id,
          last_project_revision = :project_revision,
          last_authority_epoch = :authority_epoch
      WHERE question_id = 'question-uat'
    `).run({
      ":operation_id": context.operationId,
      ":project_revision": context.resultingRevision,
      ":authority_epoch": context.resultingAuthorityEpoch,
    });
    db.prepare(`
      INSERT INTO workflow_human_acceptances (
        human_acceptance_id, project_id, criterion_id, lifecycle_id,
        answer_id, question_id, interaction_id, disposition, actor_id, rationale,
        created_at, operation_id, project_revision, authority_epoch
      ) VALUES (
        'acceptance-uat', :project_id, 'criterion-subjective', :lifecycle_id,
        'answer-uat', 'question-uat', 'interaction-uat', 'accepted', 'developer',
        'The guided flow meets the subjective criterion', :created_at,
        :operation_id, :project_revision, :authority_epoch
      )
    `).run({
      ":project_id": context.projectId,
      ":lifecycle_id": milestoneLifecycleId,
      ":created_at": CREATED_AT,
      ":operation_id": context.operationId,
      ":project_revision": context.resultingRevision,
      ":authority_epoch": context.resultingAuthorityEpoch,
    });
  }, { actorType: "user", actorId: "developer" }, {
    eventType: "milestone.subjective-uat.answered",
    payload: {
      humanAcceptanceId: "acceptance-uat",
      testedSourceRevision: "source-a",
    },
  });
  const answerEvent = db.prepare(`
    SELECT event_type, payload_json FROM workflow_domain_events
    WHERE operation_id = (
      SELECT operation_id FROM workflow_human_acceptances
      WHERE human_acceptance_id = 'acceptance-uat'
    )
  `).get();
  assert.deepEqual(answerEvent, {
    event_type: "milestone.subjective-uat.answered",
    payload_json: JSON.stringify({
      humanAcceptanceId: "acceptance-uat",
      testedSourceRevision: "source-a",
    }),
  });
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count
    FROM workflow_human_acceptances acceptance
    JOIN workflow_domain_events answered
      ON answered.operation_id = acceptance.operation_id
     AND answered.event_type = 'milestone.subjective-uat.answered'
     AND json_extract(answered.payload_json, '$.humanAcceptanceId') = acceptance.human_acceptance_id
     AND json_extract(answered.payload_json, '$.testedSourceRevision') = 'source-a'
    WHERE acceptance.human_acceptance_id = 'acceptance-uat'
  `).get()?.["count"], 1, "fixture acceptance must have a source-bound answer event");

  let resultId = "";
  execute("attempt.settle", (context) => {
    db.prepare(`
      INSERT INTO workflow_execution_attempts (
        attempt_id, project_id, lifecycle_id, attempt_number, attempt_state,
        claimed_at, ended_at, claim_operation_id, claim_project_revision,
        claim_authority_epoch, settle_operation_id, settle_project_revision,
        settle_authority_epoch, settle_outcome
      ) VALUES (
        'attempt-subjective', :project_id, :lifecycle_id, 1, 'settled',
        :created_at, :created_at, :operation_id, :project_revision,
        :authority_epoch, :operation_id, :project_revision, :authority_epoch, 'succeeded'
      )
    `).run({
      ":project_id": context.projectId,
      ":lifecycle_id": milestoneLifecycleId,
      ":created_at": CREATED_AT,
      ":operation_id": context.operationId,
      ":project_revision": context.resultingRevision,
      ":authority_epoch": context.resultingAuthorityEpoch,
    });
    resultId = "result-subjective";
    db.prepare(`
      INSERT INTO workflow_attempt_results (
        result_id, project_id, lifecycle_id, attempt_id, outcome,
        created_at, operation_id, project_revision, authority_epoch
      ) VALUES (
        :result_id, :project_id, :lifecycle_id, 'attempt-subjective', 'succeeded',
        :created_at, :operation_id, :project_revision, :authority_epoch
      )
    `).run({
      ":result_id": resultId,
      ":project_id": context.projectId,
      ":lifecycle_id": milestoneLifecycleId,
      ":created_at": CREATED_AT,
      ":operation_id": context.operationId,
      ":project_revision": context.resultingRevision,
      ":authority_epoch": context.resultingAuthorityEpoch,
    });
  });
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "milestone.validate",
    idempotencyKey: "subjective/validation",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "agent",
    sourceTransport: "internal",
    payload: { milestoneId: "M001", acceptanceId: "acceptance-uat" },
  }, () => ({
    events: [{
      eventType: "milestone.validation.recorded",
      entityType: "milestone",
      entityId: "M001",
      payload: {
        milestoneId: "M001",
        lifecycleId: milestoneLifecycleId,
        attemptId: "attempt-subjective",
        resultId,
        overallVerdict: "pass",
        testedSourceRevision: "source-a",
        policyId: "test-policy",
        policyVersion: "1",
        criterionIds: ["criterion-subjective"],
        verdictIds: [],
        evidenceIds: [],
        humanAcceptanceIds: ["acceptance-uat"],
      },
      destinations: ["test"],
    }],
    projections: [{
      projectionKey: "subjective/validation",
      projectionKind: "milestone-validation",
      rendererVersion: "1",
    }],
  }));

  const readiness = readMilestoneCloseoutReadiness({ milestoneId: "M001" });
  assert.equal(
    readiness.ready,
    true,
    readiness.ready ? undefined : JSON.stringify(readiness.blockers),
  );
});
