// Project/App: gsd-pi
// File Purpose: The prepare subjective-UAT tool text must carry the full answer binding (issue #2296).

import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, test } from "node:test";

import { executeDomainOperation } from "../db/domain-operation.ts";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
} from "../db/writers/lifecycle-commands.ts";
import {
  _getAdapter,
  closeDatabase,
  insertMilestone,
  openDatabase,
} from "../gsd-db.ts";
import {
  executeAnswerMilestoneSubjectiveUat,
  executePrepareMilestoneSubjectiveUat,
} from "../tools/workflow-tool-executors.ts";
import {
  internalExecutionInvocation,
  type ExecutionInvocation,
} from "../execution-invocation.ts";
import { normalizeRealPath } from "../paths.ts";

let basePath: string | undefined;

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function textOf(result: { content: Array<{ type: "text"; text: string }> }): string {
  return result.content.map((part) => part.text).join("\n");
}

function prepareExecutorInput() {
  return {
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

function setup(): string {
  basePath = join(tmpdir(), `gsd-uat-text-binding-${randomUUID()}`);
  mkdirSync(join(basePath, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(normalizeRealPath(basePath), ".gsd", "gsd.db")), true);
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
  return basePath;
}

function parseBindingFromText(text: string) {
  const criterionId = /criterionId: (\S+)/.exec(text)?.[1];
  const questionId = /questionId: (\S+)/.exec(text)?.[1];
  const interactionId = /interactionId: (\S+)/.exec(text)?.[1];
  const testedSourceRevision = /testedSourceRevision: (.+)/.exec(text)?.[1]?.trim();
  const options = text.split("\n")
    .filter((line) => line.includes("optionId:"))
    .map((line) => ({
      optionId: /optionId: (\S+)/.exec(line)![1]!,
      disposition: /disposition: (\w+)/.exec(line)![1]!,
      label: /label: "(.*)"/.exec(line)![1]!,
    }));
  return { criterionId, questionId, interactionId, testedSourceRevision, options };
}

afterEach(() => {
  closeDatabase();
  if (basePath) rmSync(basePath, { recursive: true, force: true });
  basePath = undefined;
});

test("prepare subjective UAT renders the full answer binding into the tool text", async () => {
  const base = setup();
  const result = await executePrepareMilestoneSubjectiveUat(
    prepareExecutorInput(),
    base,
    internalExecutionInvocation("test/uat-text/prepare/1"),
  );
  assert.notEqual(result.isError, true);

  const text = textOf(result);
  const details = result.details as {
    criterionId: string;
    questionId: string;
    interactionId: string;
    testedSourceRevision: string;
    options: Array<{ optionId: string; label: string }>;
  };

  assert.ok(
    text.startsWith("Prepared subjective UAT for M001: Does the guided flow feel natural and clear?"),
  );
  assert.ok(text.includes(details.criterionId), "text must include criterionId");
  assert.ok(text.includes(details.questionId), "text must include questionId");
  assert.ok(text.includes(details.interactionId), "text must include interactionId");
  assert.ok(text.includes(details.testedSourceRevision), "text must include testedSourceRevision");
  assert.equal(details.options.length, 2);
  for (const option of details.options) {
    assert.ok(text.includes(option.optionId), `text must include optionId ${option.optionId}`);
    assert.ok(
      text.includes(`"${option.label}"`),
      `label must be rendered verbatim inside delimiters: ${option.label}`,
    );
  }
});

test("a valid subjective UAT answer can be constructed from the prepare text alone", async () => {
  const base = setup();
  const prepared = await executePrepareMilestoneSubjectiveUat(
    prepareExecutorInput(),
    base,
    internalExecutionInvocation("test/uat-text/prepare/roundtrip"),
  );
  assert.notEqual(prepared.isError, true);

  // Parse the binding out of the TEXT channel only — no peeking at details.
  const binding = parseBindingFromText(textOf(prepared));
  assert.ok(binding.criterionId, "text must yield criterionId");
  assert.ok(binding.questionId, "text must yield questionId");
  assert.ok(binding.interactionId, "text must yield interactionId");
  assert.ok(binding.testedSourceRevision, "text must yield testedSourceRevision");
  assert.equal(binding.options.length, 2, "text must yield both options");
  const accepted = binding.options.find((option) => option.disposition === "accepted");
  assert.ok(accepted, "text must identify which option accepts");

  const answerInvocation: ExecutionInvocation = {
    idempotencyKey: "test/uat-text/answer/roundtrip",
    sourceTransport: "internal",
    actorType: "user",
    actorId: "test-user",
  };
  const answered = await executeAnswerMilestoneSubjectiveUat({
    criterionId: binding.criterionId!,
    questionId: binding.questionId!,
    interactionId: binding.interactionId!,
    selectedOptionId: accepted.optionId,
    verbatimResponse: accepted.label,
    rationale: "The user explicitly accepted the guided experience.",
    testedSourceRevision: binding.testedSourceRevision!,
  }, base, answerInvocation);
  assert.notEqual(answered.isError, true, `answer must be accepted from text alone: ${textOf(answered)}`);
  assert.match(textOf(answered), /accepted/);

  assert.deepEqual(db().prepare(`
    SELECT question_status FROM workflow_open_questions
    WHERE question_id = :question_id
  `).get({ ":question_id": binding.questionId }), { question_status: "answered" });
  assert.equal(Number(db().prepare(
    "SELECT COUNT(*) AS count FROM workflow_human_acceptances",
  ).get()?.["count"]), 1, "the answer must record the human acceptance so validate can pass");
});

test("a rejected subjective UAT answer can be constructed from the prepare text alone", async () => {
  const base = setup();
  const prepared = await executePrepareMilestoneSubjectiveUat(
    prepareExecutorInput(),
    base,
    internalExecutionInvocation("test/uat-text/prepare/reject-roundtrip"),
  );
  assert.notEqual(prepared.isError, true);

  // Parse the binding out of the TEXT channel only — no peeking at details.
  const binding = parseBindingFromText(textOf(prepared));
  assert.ok(binding.criterionId, "text must yield criterionId");
  assert.ok(binding.questionId, "text must yield questionId");
  assert.ok(binding.interactionId, "text must yield interactionId");
  assert.ok(binding.testedSourceRevision, "text must yield testedSourceRevision");
  const rejected = binding.options.find((option) => option.disposition === "rejected");
  assert.ok(rejected, "text must identify which option rejects");

  const answerInvocation: ExecutionInvocation = {
    idempotencyKey: "test/uat-text/answer/reject-roundtrip",
    sourceTransport: "internal",
    actorType: "user",
    actorId: "test-user",
  };
  const answered = await executeAnswerMilestoneSubjectiveUat({
    criterionId: binding.criterionId!,
    questionId: binding.questionId!,
    interactionId: binding.interactionId!,
    selectedOptionId: rejected.optionId,
    verbatimResponse: rejected.label,
    rationale: "The user rejected the experience pending another revision.",
    testedSourceRevision: binding.testedSourceRevision!,
  }, base, answerInvocation);
  assert.notEqual(answered.isError, true, `answer must be accepted from text alone: ${textOf(answered)}`);
  assert.match(textOf(answered), /rejected/);
  assert.equal(answered.details.disposition, "rejected");

  assert.deepEqual(db().prepare(`
    SELECT disposition FROM workflow_human_acceptances
    WHERE criterion_id = :criterion_id
  `).get({ ":criterion_id": binding.criterionId }), { disposition: "rejected" });
  assert.deepEqual(db().prepare(`
    SELECT question_status FROM workflow_open_questions
    WHERE question_id = :question_id
  `).get({ ":question_id": binding.questionId }), { question_status: "answered" });
});

test("prepare subjective UAT error paths keep their existing text", async () => {
  const missingBase = join(tmpdir(), `gsd-uat-text-missing-${randomUUID()}`);
  const unavailable = await executePrepareMilestoneSubjectiveUat(
    prepareExecutorInput(),
    missingBase,
    internalExecutionInvocation("test/uat-text/prepare/db-unavailable"),
  );
  assert.equal(unavailable.isError, true);
  assert.equal(
    textOf(unavailable),
    "Error: GSD database is not available. Cannot prepare subjective UAT.",
  );
  assert.deepEqual(unavailable.details, {
    operation: "prepare_milestone_subjective_uat",
    error: "db_unavailable",
  });

  const base = setup();
  const failed = await executePrepareMilestoneSubjectiveUat({
    ...prepareExecutorInput(),
    milestoneId: "M404",
  }, base, internalExecutionInvocation("test/uat-text/prepare/no-lifecycle"));
  assert.equal(failed.isError, true);
  assert.ok(textOf(failed).startsWith("Error preparing subjective UAT:"));
  assert.equal(String(failed.details.error).length > 0, true);
  assert.equal(failed.details.operation, "prepare_milestone_subjective_uat");
});
