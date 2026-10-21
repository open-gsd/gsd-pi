// Project/App: gsd-pi
// File Purpose: Canonical subjective-UAT question, answer, provenance, replay, and rollback contracts.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  _setDomainOperationFaultForTest,
  executeDomainOperation,
} from "../db/domain-operation.ts";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
} from "../db/writers/lifecycle-commands.ts";
import {
  answerMilestoneSubjectiveUat,
  prepareMilestoneSubjectiveUat,
} from "../milestone-subjective-uat-domain-operation.ts";
import {
  _getAdapter,
  closeDatabase,
  insertMilestone,
  openDatabase,
} from "../gsd-db.ts";

let basePath: string | undefined;

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function count(table: string): number {
  const row = db().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
  return Number(row?.["count"] ?? 0);
}

function agentInvocation(idempotencyKey: string) {
  return {
    idempotencyKey,
    sourceTransport: "internal" as const,
    actorType: "agent",
    actorId: "validation-agent",
  };
}

function userInvocation(idempotencyKey: string) {
  return {
    idempotencyKey,
    sourceTransport: "internal" as const,
    actorType: "user",
    actorId: "developer",
  };
}

function setup(): void {
  basePath = mkdtempSync(join(tmpdir(), "gsd-milestone-subjective-uat-"));
  assert.equal(openDatabase(join(basePath, "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Subjective UAT", status: "active" });
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.milestone.adopt",
    idempotencyKey: "fixture/milestone/adopt",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { milestoneId: "M001" },
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone",
      milestoneId: "M001",
      lifecycleStatus: "ready",
    });
    return {
      events: [{
        eventType: "test.milestone.adopted",
        entityType: "milestone",
        entityId: "M001",
        payload: { milestoneId: "M001" },
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: "test/milestone/m001",
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}

function transitionMilestone(
  lifecycleStatus: "in_progress" | "paused",
  idempotencyKey: string,
): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.milestone.transition",
    idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { lifecycleStatus },
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone",
      milestoneId: "M001",
      lifecycleStatus,
    });
    return {
      events: [{
        eventType: "test.milestone.transitioned",
        entityType: "milestone",
        entityId: "M001",
        payload: { lifecycleStatus },
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: `test/milestone/m001/${lifecycleStatus}`,
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}

function prepareInput(idempotencyKey = "subjective/prepare/1") {
  return {
    invocation: agentInvocation(idempotencyKey),
    milestoneId: "M001",
    criterionKey: "guided-flow",
    description: "The guided flow feels natural and clear.",
    focusedPrompt: "Does the guided flow feel natural and clear?",
    recommendedDisposition: "accepted" as const,
    recommendationRationale: "Automated checks passed and the guided path is complete.",
    recommendationEvidence: "Current technical validation receipt.",
    recommendationConfidence: 0.8,
    testedSourceRevision: "source-a",
  };
}

afterEach(() => {
  _setDomainOperationFaultForTest(null);
  closeDatabase();
  if (basePath) rmSync(basePath, { recursive: true, force: true });
  basePath = undefined;
});

test("subjective UAT prepares one bound recommended question and replays its exact receipt", () => {
  setup();
  const prepared = prepareMilestoneSubjectiveUat(prepareInput());
  const replayed = prepareMilestoneSubjectiveUat(prepareInput());

  assert.equal(prepared.status, "committed");
  assert.equal(replayed.status, "replayed");
  assert.equal(replayed.criterionId, prepared.criterionId);
  assert.equal(replayed.questionId, prepared.questionId);
  assert.equal(replayed.interactionId, prepared.interactionId);
  assert.deepEqual(replayed.options, prepared.options);
  assert.deepEqual(prepared.options.map((option) => [option.disposition, option.recommended]), [
    ["accepted", true],
    ["rejected", false],
  ]);
  assert.match(prepared.options[0]!.label, /Recommended/);
  assert.deepEqual(db().prepare(`
    SELECT question_status, accepted_answer_id FROM workflow_open_questions
    WHERE question_id = :question_id
  `).get({ ":question_id": prepared.questionId }), {
    question_status: "open",
    accepted_answer_id: null,
  });
  assert.deepEqual(db().prepare(`
    SELECT interaction_kind, presentation_state, recommended_option_id
    FROM workflow_interactions WHERE interaction_id = :interaction_id
  `).get({ ":interaction_id": prepared.interactionId }), {
    interaction_kind: "subjective-uat",
    presentation_state: "presented",
    recommended_option_id: prepared.options[0]!.optionId,
  });
  assert.equal(count("workflow_human_acceptances"), 0, "asking must never synthesize acceptance");

  assert.throws(
    () => prepareMilestoneSubjectiveUat(prepareInput("subjective/prepare/duplicate-open")),
    /already has an open question/i,
  );
  assert.equal(count("workflow_open_questions"), 1);

  assert.throws(() => prepareMilestoneSubjectiveUat({
    ...prepareInput(),
    description: "Changed payload",
  }), /idempotency/i);
});

test("subjective UAT atomically links the actual selected answer to a user acceptance", () => {
  setup();
  const prepared = prepareMilestoneSubjectiveUat(prepareInput());
  const acceptedOption = prepared.options.find((option) => option.disposition === "accepted")!;
  const answered = answerMilestoneSubjectiveUat({
    invocation: userInvocation("subjective/answer/1"),
    criterionId: prepared.criterionId,
    questionId: prepared.questionId,
    interactionId: prepared.interactionId,
    selectedOptionId: acceptedOption.optionId,
    verbatimResponse: acceptedOption.label,
    rationale: "The user explicitly accepted the guided experience.",
    testedSourceRevision: "source-a",
  });
  const replayed = answerMilestoneSubjectiveUat({
    invocation: userInvocation("subjective/answer/1"),
    criterionId: prepared.criterionId,
    questionId: prepared.questionId,
    interactionId: prepared.interactionId,
    selectedOptionId: acceptedOption.optionId,
    verbatimResponse: acceptedOption.label,
    rationale: "The user explicitly accepted the guided experience.",
    testedSourceRevision: "source-a",
  });

  assert.equal(answered.disposition, "accepted");
  assert.equal(replayed.status, "replayed");
  assert.equal(replayed.answerId, answered.answerId);
  assert.equal(replayed.humanAcceptanceId, answered.humanAcceptanceId);
  assert.deepEqual(db().prepare(`
    SELECT question_status, accepted_answer_id FROM workflow_open_questions
    WHERE question_id = :question_id
  `).get({ ":question_id": prepared.questionId }), {
    question_status: "answered",
    accepted_answer_id: answered.answerId,
  });
  assert.deepEqual(db().prepare(`
    SELECT answer_id, question_id, interaction_id, disposition, actor_id
    FROM workflow_human_acceptances WHERE human_acceptance_id = :acceptance_id
  `).get({ ":acceptance_id": answered.humanAcceptanceId }), {
    answer_id: answered.answerId,
    question_id: prepared.questionId,
    interaction_id: prepared.interactionId,
    disposition: "accepted",
    actor_id: "developer",
  });

  assert.throws(() => answerMilestoneSubjectiveUat({
    invocation: userInvocation("subjective/answer/1"),
    criterionId: prepared.criterionId,
    questionId: prepared.questionId,
    interactionId: prepared.interactionId,
    selectedOptionId: acceptedOption.optionId,
    verbatimResponse: acceptedOption.label,
    rationale: "Changed replay payload must conflict.",
    testedSourceRevision: "source-a",
  }), /idempotency/i);
  assert.equal(count("workflow_answers"), 1);
  assert.equal(count("workflow_human_acceptances"), 1);
});

test("subjective UAT withdraws a stale open question before preparing the current source", () => {
  setup();
  const stale = prepareMilestoneSubjectiveUat(prepareInput());

  const current = prepareMilestoneSubjectiveUat({
    ...prepareInput("subjective/prepare/source-b"),
    testedSourceRevision: "source-b",
  });

  assert.deepEqual(current.withdrawnQuestionIds, [stale.questionId]);
  assert.deepEqual(db().prepare(`
    SELECT question_id, question_status FROM workflow_open_questions
    ORDER BY created_project_revision
  `).all(), [
    { question_id: stale.questionId, question_status: "withdrawn" },
    { question_id: current.questionId, question_status: "open" },
  ]);
  assert.equal(current.criterionId, stale.criterionId);
});

test("subjective UAT preparation and answers require an active Milestone lifecycle", () => {
  setup();
  transitionMilestone("in_progress", "fixture/milestone/in-progress");
  const prepared = prepareMilestoneSubjectiveUat(prepareInput());
  const acceptedOption = prepared.options.find((option) => option.disposition === "accepted")!;
  transitionMilestone("paused", "fixture/milestone/paused");

  assert.throws(() => prepareMilestoneSubjectiveUat(
    prepareInput("subjective/prepare/paused"),
  ), /ready or in_progress lifecycle.*paused/i);
  assert.throws(() => answerMilestoneSubjectiveUat({
    invocation: userInvocation("subjective/answer/paused"),
    criterionId: prepared.criterionId,
    questionId: prepared.questionId,
    interactionId: prepared.interactionId,
    selectedOptionId: acceptedOption.optionId,
    verbatimResponse: acceptedOption.label,
    rationale: "A paused Milestone cannot accept subjective UAT.",
    testedSourceRevision: "source-a",
  }), /ready or in_progress lifecycle.*paused/i);

  assert.equal(count("workflow_open_questions"), 1);
  assert.equal(count("workflow_answers"), 0);
  assert.equal(count("workflow_human_acceptances"), 0);
});

test("subjective UAT answer timestamps remain later than a future question timestamp", (t) => {
  setup();
  const futureTime = Date.parse("2099-01-01T00:00:00.000Z");
  t.mock.timers.enable({ apis: ["Date"], now: futureTime });
  t.after(() => t.mock.timers.reset());
  const prepared = prepareMilestoneSubjectiveUat(prepareInput());
  t.mock.timers.reset();
  const acceptedOption = prepared.options.find((option) => option.disposition === "accepted")!;

  const answered = answerMilestoneSubjectiveUat({
    invocation: userInvocation("subjective/answer/future-question"),
    criterionId: prepared.criterionId,
    questionId: prepared.questionId,
    interactionId: prepared.interactionId,
    selectedOptionId: acceptedOption.optionId,
    verbatimResponse: acceptedOption.label,
    rationale: "The user's acceptance must be ordered after the question.",
    testedSourceRevision: "source-a",
  });
  const row = db().prepare(`
    SELECT answer.created_at AS answer_created_at,
           question.created_at AS question_created_at
    FROM workflow_answers answer
    JOIN workflow_open_questions question ON question.question_id = answer.question_id
    WHERE answer.answer_id = :answer_id
  `).get({ ":answer_id": answered.answerId });

  assert.ok(Date.parse(String(row?.["answer_created_at"])) > futureTime);
  assert.equal(Date.parse(String(row?.["question_created_at"])), futureTime);
});

test("subjective UAT rejects agent identity and mismatched bindings without residue", () => {
  setup();
  const prepared = prepareMilestoneSubjectiveUat(prepareInput());
  const acceptedOption = prepared.options.find((option) => option.disposition === "accepted")!;
  const answer = {
    invocation: agentInvocation("subjective/answer/agent"),
    criterionId: prepared.criterionId,
    questionId: prepared.questionId,
    interactionId: prepared.interactionId,
    selectedOptionId: acceptedOption.optionId,
    verbatimResponse: acceptedOption.label,
    rationale: "An agent must not claim the user accepted this.",
    testedSourceRevision: "source-a",
  };
  assert.throws(() => answerMilestoneSubjectiveUat(answer), /user actor/i);
  assert.equal(count("workflow_answers"), 0);
  assert.equal(count("workflow_human_acceptances"), 0);

  assert.throws(() => answerMilestoneSubjectiveUat({
    ...answer,
    invocation: userInvocation("subjective/answer/mismatch"),
    questionId: "missing-question",
  }), /prepared subjective-UAT binding/i);
  assert.equal(count("workflow_answers"), 0);
  assert.equal(count("workflow_human_acceptances"), 0);

  assert.throws(() => answerMilestoneSubjectiveUat({
    ...answer,
    invocation: userInvocation("subjective/answer/free-text"),
    verbatimResponse: "I am not sure; please change the navigation first.",
  }), /actual selected option response/i);
  assert.equal(count("workflow_answers"), 0, "free text must remain unanswered until clarified");
  assert.equal(count("workflow_human_acceptances"), 0);
});

test("subjective UAT rejects an answer observed against a different source revision", () => {
  setup();
  const prepared = prepareMilestoneSubjectiveUat(prepareInput());
  const accepted = prepared.options.find((option) => option.disposition === "accepted")!;

  assert.throws(() => answerMilestoneSubjectiveUat({
    invocation: userInvocation("subjective/answer/source-drift"),
    criterionId: prepared.criterionId,
    questionId: prepared.questionId,
    interactionId: prepared.interactionId,
    selectedOptionId: accepted.optionId,
    verbatimResponse: accepted.label,
    rationale: "The source changed before the answer was recorded.",
    testedSourceRevision: "source-b",
  }), /source revision/i);
  assert.equal(count("workflow_answers"), 0);
  assert.equal(count("workflow_human_acceptances"), 0);
});

test("subjective UAT supersedes current answers and changed criteria without overwriting history", () => {
  setup();
  const first = prepareMilestoneSubjectiveUat(prepareInput());
  const accepted = first.options.find((option) => option.disposition === "accepted")!;
  const firstAnswer = answerMilestoneSubjectiveUat({
    invocation: userInvocation("subjective/answer/first"),
    criterionId: first.criterionId,
    questionId: first.questionId,
    interactionId: first.interactionId,
    selectedOptionId: accepted.optionId,
    verbatimResponse: accepted.label,
    rationale: "The initial experience felt natural.",
    testedSourceRevision: "source-a",
  });

  const second = prepareMilestoneSubjectiveUat(prepareInput("subjective/prepare/2"));
  assert.equal(second.criterionId, first.criterionId, "unchanged criterion keeps its immutable identity");
  const rejected = second.options.find((option) => option.disposition === "rejected")!;
  const secondAnswer = answerMilestoneSubjectiveUat({
    invocation: userInvocation("subjective/answer/second"),
    criterionId: second.criterionId,
    questionId: second.questionId,
    interactionId: second.interactionId,
    selectedOptionId: rejected.optionId,
    verbatimResponse: rejected.label,
    rationale: "A later review found the revised flow confusing.",
    testedSourceRevision: "source-a",
  });
  assert.equal(secondAnswer.disposition, "rejected");
  assert.equal(secondAnswer.supersedesHumanAcceptanceId, firstAnswer.humanAcceptanceId);
  assert.equal(count("workflow_human_acceptances"), 2);

  const changed = prepareMilestoneSubjectiveUat({
    ...prepareInput("subjective/prepare/3"),
    description: "The guided flow feels natural, clear, and responsive.",
  });
  assert.notEqual(changed.criterionId, first.criterionId);
  assert.equal(
    db().prepare(`
      SELECT supersedes_criterion_id FROM workflow_acceptance_criteria
      WHERE criterion_id = :criterion_id
    `).get({ ":criterion_id": changed.criterionId })?.["supersedes_criterion_id"],
    first.criterionId,
  );
});

test("subjective UAT cannot answer a question for a superseded criterion", () => {
  setup();
  const original = prepareMilestoneSubjectiveUat(prepareInput());
  const acceptedOption = original.options.find((option) => option.disposition === "accepted")!;
  const changed = prepareMilestoneSubjectiveUat({
    ...prepareInput("subjective/prepare/changed-open"),
    description: "The guided flow feels natural, clear, and responsive.",
  });
  assert.notEqual(changed.criterionId, original.criterionId);
  assert.deepEqual(changed.withdrawnQuestionIds, [original.questionId]);
  assert.equal(db().prepare(`
    SELECT question_status FROM workflow_open_questions
    WHERE question_id = :question_id
  `).get({ ":question_id": original.questionId })?.["question_status"], "withdrawn");

  assert.throws(() => answerMilestoneSubjectiveUat({
    invocation: userInvocation("subjective/answer/superseded"),
    criterionId: original.criterionId,
    questionId: original.questionId,
    interactionId: original.interactionId,
    selectedOptionId: acceptedOption.optionId,
    verbatimResponse: acceptedOption.label,
    rationale: "A superseded criterion cannot receive fresh acceptance.",
    testedSourceRevision: "source-a",
  }), /current prepared subjective-UAT binding/i);
  assert.equal(count("workflow_answers"), 0);
  assert.equal(count("workflow_human_acceptances"), 0);
});

test("subjective UAT preparation rolls back every new fact when its Domain Operation fails", () => {
  setup();
  _setDomainOperationFaultForTest("after-mutation");

  assert.throws(
    () => prepareMilestoneSubjectiveUat(prepareInput("subjective/prepare/fault")),
    /domain operation fault: after-mutation/i,
  );

  assert.equal(count("workflow_acceptance_criteria"), 0);
  assert.equal(count("workflow_open_questions"), 0);
  assert.equal(count("workflow_interactions"), 0);
  assert.equal(count("workflow_interaction_options"), 0);
  assert.equal(count("workflow_human_acceptances"), 0);
});

test("subjective UAT answer rolls back every fact when its Domain Operation fails", () => {
  setup();
  const prepared = prepareMilestoneSubjectiveUat(prepareInput());
  const rejectedOption = prepared.options.find((option) => option.disposition === "rejected")!;
  _setDomainOperationFaultForTest("after-mutation");

  assert.throws(() => answerMilestoneSubjectiveUat({
    invocation: userInvocation("subjective/answer/fault"),
    criterionId: prepared.criterionId,
    questionId: prepared.questionId,
    interactionId: prepared.interactionId,
    selectedOptionId: rejectedOption.optionId,
    verbatimResponse: rejectedOption.label,
    rationale: "The user explicitly rejected the guided experience.",
    testedSourceRevision: "source-a",
  }), /domain operation fault: after-mutation/i);

  assert.equal(count("workflow_answers"), 0);
  assert.equal(count("workflow_human_acceptances"), 0);
  assert.deepEqual(db().prepare(`
    SELECT question_status, accepted_answer_id FROM workflow_open_questions
    WHERE question_id = :question_id
  `).get({ ":question_id": prepared.questionId }), {
    question_status: "open",
    accepted_answer_id: null,
  });
});

test("subjective UAT replay fails loud when its stored receipt is corrupt", () => {
  setup();
  const input = prepareInput("subjective/prepare/corrupt-replay");
  const prepared = prepareMilestoneSubjectiveUat(input);
  db().exec("DROP TRIGGER trg_workflow_domain_events_immutable_update");
  db().prepare(`
    UPDATE workflow_domain_events SET payload_json = '{"milestoneId":"M001"}'
    WHERE operation_id = :operation_id
  `).run({ ":operation_id": prepared.operationId });

  assert.throws(
    () => prepareMilestoneSubjectiveUat(input),
    /subjective UAT receipt.*invalid|corrupt/i,
  );
});

test("subjective UAT replay rejects shape-valid option binding corruption", () => {
  setup();
  const input = prepareInput("subjective/prepare/corrupt-option-binding");
  const prepared = prepareMilestoneSubjectiveUat(input);
  const row = db().prepare(`
    SELECT payload_json FROM workflow_domain_events
    WHERE operation_id = :operation_id
  `).get({ ":operation_id": prepared.operationId }) as { payload_json: string };
  const payload = JSON.parse(row.payload_json) as {
    acceptedOptionId: string;
    rejectedOptionId: string;
  };
  [payload.acceptedOptionId, payload.rejectedOptionId] = [
    payload.rejectedOptionId,
    payload.acceptedOptionId,
  ];
  db().exec("DROP TRIGGER trg_workflow_domain_events_immutable_update");
  db().prepare(`
    UPDATE workflow_domain_events SET payload_json = :payload_json
    WHERE operation_id = :operation_id
  `).run({
    ":operation_id": prepared.operationId,
    ":payload_json": JSON.stringify(payload),
  });

  assert.throws(
    () => prepareMilestoneSubjectiveUat(input),
    /subjective UAT receipt.*options.*invalid|corrupt/i,
  );
});
