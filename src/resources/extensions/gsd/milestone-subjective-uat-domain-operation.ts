// Project/App: gsd-pi
// File Purpose: Durable Milestone subjective-UAT question and answer operations.

import {
  executeDomainOperation,
  type DomainJsonValue,
  type DomainOperationResult,
} from "./db/domain-operation.js";
import { getDb } from "./db/engine.js";
import { readDomainOperationFence } from "./db/writers/lifecycle-commands.js";
import {
  answerMilestoneSubjectiveUatQuestion,
  prepareMilestoneSubjectiveUatQuestion,
  resolveSubjectiveUatSupersedeTarget,
  type AnsweredMilestoneSubjectiveUat,
  type PreparedMilestoneSubjectiveUat,
} from "./db/writers/milestone-subjective-uat.js";
import type { ExecutionInvocation } from "./execution-invocation.js";

export interface PrepareMilestoneSubjectiveUatInput {
  invocation: ExecutionInvocation;
  milestoneId: string;
  /**
   * Key of the criterion to prepare. Required unless {@link supersedesCriterionId}
   * is given, in which case the replacement inherits the superseded criterion's
   * key (and requirementId) and a passed key must match it (#2341).
   */
  criterionKey?: string;
  description: string;
  focusedPrompt: string;
  recommendedDisposition: "accepted" | "rejected";
  recommendationRationale: string;
  recommendationEvidence: string;
  testedSourceRevision: string;
  recommendationConfidence?: number;
  requirementId?: string;
  required?: boolean;
  supersedesCriterionId?: string;
}

export interface AnswerMilestoneSubjectiveUatInput {
  invocation: ExecutionInvocation;
  criterionId: string;
  questionId: string;
  interactionId: string;
  selectedOptionId: string;
  verbatimResponse: string;
  rationale: string;
  testedSourceRevision: string;
}

interface OperationReceipt {
  status: "committed" | "replayed";
  operationId: string;
  resultingRevision: number;
  resultingAuthorityEpoch: number;
  eventIds: string[];
  outboxIds: number[];
  projectionWorkIds: string[];
}

export interface PrepareMilestoneSubjectiveUatReceipt
  extends OperationReceipt, PreparedMilestoneSubjectiveUat {}

export interface AnswerMilestoneSubjectiveUatReceipt
  extends OperationReceipt, AnsweredMilestoneSubjectiveUat {}

export function hasPendingMilestoneSubjectiveUat(milestoneId: string): boolean {
  const row = getDb().prepare(`
    SELECT 1
    FROM workflow_open_questions question
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.lifecycle_id = question.lifecycle_id
     AND lifecycle.project_id = question.project_id
    JOIN workflow_interactions interaction
      ON interaction.question_id = question.question_id
     AND interaction.project_id = question.project_id
     AND interaction.interaction_kind = 'subjective-uat'
    WHERE lifecycle.item_kind = 'milestone'
      AND lifecycle.milestone_id = :milestone_id
      AND lifecycle.slice_id IS NULL
      AND lifecycle.task_id IS NULL
      AND question.question_status = 'open'
    LIMIT 1
  `).get({ ":milestone_id": milestoneId });
  return row !== undefined;
}

export interface OpenMilestoneSubjectiveUat {
  milestoneId: string;
  criterionId: string;
  questionId: string;
  interactionId: string;
  focusedPrompt: string;
  recommendation: string;
  testedSourceRevision: string;
  accepted: { optionId: string; label: string };
  rejected: { optionId: string; label: string };
}

/**
 * Every prepared subjective UAT question that waits for a person: the binding
 * the answer Domain Operation needs, read for the host answer command.
 */
export function listOpenMilestoneSubjectiveUat(): OpenMilestoneSubjectiveUat[] {
  const rows = getDb().prepare(`
    SELECT lifecycle.milestone_id,
           json_extract(event.payload_json, '$.criterionId') AS criterion_id,
           question.question_id, interaction.interaction_id,
           interaction.focused_prompt, interaction.recommendation_text,
           json_extract(event.payload_json, '$.testedSourceRevision') AS tested_source_revision,
           accepted.option_id AS accepted_option_id, accepted.label AS accepted_label,
           rejected.option_id AS rejected_option_id, rejected.label AS rejected_label
    FROM workflow_domain_events event
    JOIN workflow_open_questions question
      ON question.question_id = json_extract(event.payload_json, '$.questionId')
     AND question.project_id = event.project_id
    JOIN workflow_interactions interaction
      ON interaction.interaction_id = json_extract(event.payload_json, '$.interactionId')
     AND interaction.question_id = question.question_id
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.lifecycle_id = question.lifecycle_id
     AND lifecycle.project_id = question.project_id
    JOIN workflow_interaction_options accepted
      ON accepted.interaction_id = interaction.interaction_id
     AND accepted.option_id = json_extract(event.payload_json, '$.acceptedOptionId')
    JOIN workflow_interaction_options rejected
      ON rejected.interaction_id = interaction.interaction_id
     AND rejected.option_id = json_extract(event.payload_json, '$.rejectedOptionId')
    WHERE event.event_type = 'milestone.subjective-uat.prepared'
      AND question.question_status = 'open'
      AND interaction.interaction_kind = 'subjective-uat'
      AND interaction.presentation_state = 'presented'
    ORDER BY lifecycle.milestone_id, question.question_id
  `).all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    milestoneId: String(row["milestone_id"]),
    criterionId: String(row["criterion_id"]),
    questionId: String(row["question_id"]),
    interactionId: String(row["interaction_id"]),
    focusedPrompt: String(row["focused_prompt"]),
    recommendation: String(row["recommendation_text"]),
    testedSourceRevision: String(row["tested_source_revision"]),
    accepted: { optionId: String(row["accepted_option_id"]), label: String(row["accepted_label"]) },
    rejected: { optionId: String(row["rejected_option_id"]), label: String(row["rejected_label"]) },
  }));
}

function requireNonBlank(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${field} must not be blank`);
  return normalized;
}

function operationReceipt(operation: DomainOperationResult): OperationReceipt {
  return {
    status: operation.status,
    operationId: operation.operationId,
    resultingRevision: operation.resultingRevision,
    resultingAuthorityEpoch: operation.resultingAuthorityEpoch,
    eventIds: operation.eventIds,
    outboxIds: operation.outboxIds,
    projectionWorkIds: operation.projectionWorkIds,
  };
}

function storedPayload(operationId: string, eventType: string): Record<string, unknown> {
  const row = getDb().prepare(`
    SELECT payload_json FROM workflow_domain_events
    WHERE operation_id = :operation_id AND event_type = :event_type
  `).get({
    ":operation_id": operationId,
    ":event_type": eventType,
  }) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`Subjective UAT receipt is missing ${eventType}`);
  const payload = JSON.parse(String(row["payload_json"])) as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`Subjective UAT receipt ${eventType} payload is invalid`);
  }
  return payload as Record<string, unknown>;
}

function receiptString(
  payload: Record<string, unknown>,
  field: string,
  eventType: string,
): string {
  const value = payload[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Subjective UAT receipt ${eventType} ${field} is invalid`);
  }
  return value;
}

function receiptStringArray(
  payload: Record<string, unknown>,
  field: string,
  eventType: string,
): string[] {
  const value = payload[field];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry)) {
    throw new Error(`Subjective UAT receipt ${eventType} ${field} is invalid`);
  }
  return value;
}

function storedPreparation(operationId: string): PreparedMilestoneSubjectiveUat {
  const eventType = "milestone.subjective-uat.prepared";
  const payload = storedPayload(operationId, eventType);
  const options = payload["options"];
  if (!Array.isArray(options) || options.length !== 2 || options.some((option) => {
    if (!option || typeof option !== "object" || Array.isArray(option)) return true;
    const entry = option as Record<string, unknown>;
    return typeof entry["optionId"] !== "string" || !entry["optionId"] ||
      (entry["disposition"] !== "accepted" && entry["disposition"] !== "rejected") ||
      typeof entry["label"] !== "string" || !entry["label"] ||
      typeof entry["description"] !== "string" || !entry["description"] ||
      typeof entry["recommended"] !== "boolean";
  })) {
    throw new Error(`Subjective UAT receipt ${eventType} options is invalid`);
  }
  const preparedOptions = options as PreparedMilestoneSubjectiveUat["options"];
  const acceptedOptionId = receiptString(payload, "acceptedOptionId", eventType);
  const rejectedOptionId = receiptString(payload, "rejectedOptionId", eventType);
  const optionIds = new Set(preparedOptions.map((option) => option.optionId));
  const acceptedOptions = preparedOptions.filter((option) => option.disposition === "accepted");
  const rejectedOptions = preparedOptions.filter((option) => option.disposition === "rejected");
  if (optionIds.size !== preparedOptions.length || acceptedOptions.length !== 1 ||
      rejectedOptions.length !== 1 || acceptedOptions[0]!.optionId !== acceptedOptionId ||
      rejectedOptions[0]!.optionId !== rejectedOptionId ||
      preparedOptions.filter((option) => option.recommended).length !== 1) {
    throw new Error(`Subjective UAT receipt ${eventType} options is invalid`);
  }
  return {
    milestoneId: receiptString(payload, "milestoneId", eventType),
    lifecycleId: receiptString(payload, "lifecycleId", eventType),
    criterionId: receiptString(payload, "criterionId", eventType),
    questionId: receiptString(payload, "questionId", eventType),
    interactionId: receiptString(payload, "interactionId", eventType),
    acceptedOptionId,
    rejectedOptionId,
    testedSourceRevision: receiptString(payload, "testedSourceRevision", eventType),
    withdrawnQuestionIds: receiptStringArray(payload, "withdrawnQuestionIds", eventType),
    options: preparedOptions,
  };
}

function storedAnswer(operationId: string): AnsweredMilestoneSubjectiveUat {
  const eventType = "milestone.subjective-uat.answered";
  const payload = storedPayload(operationId, eventType);
  const disposition = payload["disposition"];
  if (disposition !== "accepted" && disposition !== "rejected") {
    throw new Error(`Subjective UAT receipt ${eventType} disposition is invalid`);
  }
  const supersedes = payload["supersedesHumanAcceptanceId"];
  if (supersedes !== null && (typeof supersedes !== "string" || !supersedes)) {
    throw new Error(`Subjective UAT receipt ${eventType} supersedesHumanAcceptanceId is invalid`);
  }
  return {
    milestoneId: receiptString(payload, "milestoneId", eventType),
    lifecycleId: receiptString(payload, "lifecycleId", eventType),
    criterionId: receiptString(payload, "criterionId", eventType),
    questionId: receiptString(payload, "questionId", eventType),
    interactionId: receiptString(payload, "interactionId", eventType),
    answerId: receiptString(payload, "answerId", eventType),
    humanAcceptanceId: receiptString(payload, "humanAcceptanceId", eventType),
    disposition,
    testedSourceRevision: receiptString(payload, "testedSourceRevision", eventType),
    supersedesHumanAcceptanceId: supersedes,
  };
}

export function prepareMilestoneSubjectiveUat(
  input: PrepareMilestoneSubjectiveUatInput,
): PrepareMilestoneSubjectiveUatReceipt {
  const milestoneId = requireNonBlank(input.milestoneId, "milestoneId");
  const supersedesCriterionId = input.supersedesCriterionId === undefined
    ? undefined
    : requireNonBlank(input.supersedesCriterionId, "supersedesCriterionId");
  const requestedRequirementId = input.requirementId === undefined
    ? undefined
    : requireNonBlank(input.requirementId, "requirementId");
  const description = requireNonBlank(input.description, "description");
  const focusedPrompt = requireNonBlank(input.focusedPrompt, "focusedPrompt");
  const recommendationRationale = requireNonBlank(
    input.recommendationRationale,
    "recommendationRationale",
  );
  const recommendationEvidence = requireNonBlank(
    input.recommendationEvidence,
    "recommendationEvidence",
  );
  const testedSourceRevision = requireNonBlank(
    input.testedSourceRevision,
    "testedSourceRevision",
  );
  const recommendationConfidence = input.recommendationConfidence ?? 0.5;
  if (recommendationConfidence < 0 || recommendationConfidence > 1) {
    throw new Error("recommendationConfidence must be between 0 and 1");
  }
  // The request payload records the caller's identity in its canonical form
  // (same normalization the pre-supersede path used) so request hashes stay
  // stable across upgrades and exact retries replay. The effective criterion
  // key/requirement are resolved inside the Domain Operation so an exact
  // retry replays the stored receipt instead of re-resolving a target that
  // the first commit already superseded (#2341).
  const normalizedCriterionKey = input.criterionKey === undefined
    ? undefined
    : input.criterionKey.trim().toLowerCase();
  const requestPayload = {
    milestoneId,
    ...(normalizedCriterionKey ? { criterionKey: normalizedCriterionKey } : {}),
    description,
    focusedPrompt,
    recommendedDisposition: input.recommendedDisposition,
    recommendationRationale,
    recommendationEvidence,
    testedSourceRevision,
    recommendationConfidence,
    required: input.required ?? true,
    ...(requestedRequirementId ? { requirementId: requestedRequirementId } : {}),
    ...(supersedesCriterionId !== undefined ? { supersedesCriterionId } : {}),
  };
  const fence = readDomainOperationFence(input.invocation.idempotencyKey);
  let prepared: PreparedMilestoneSubjectiveUat | undefined;
  const operation = executeDomainOperation({
    operationType: "milestone.subjective-uat.prepare",
    idempotencyKey: input.invocation.idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: input.invocation.actorType,
    ...(input.invocation.actorId ? { actorId: input.invocation.actorId } : {}),
    sourceTransport: input.invocation.sourceTransport,
    ...(input.invocation.traceId ? { traceId: input.invocation.traceId } : {}),
    ...(input.invocation.turnId ? { turnId: input.invocation.turnId } : {}),
    payload: requestPayload,
  }, (context) => {
    let requirementId = requestedRequirementId;
    let criterionKey: string;
    if (supersedesCriterionId !== undefined) {
      // #2341: explicit by-ID supersession — the replacement inherits the
      // superseded criterion's key and requirement identity (the schema
      // trigger only accepts same-scope supersession). A passed key/requirement
      // that disagrees with the target is rejected with the inherited identity
      // named. Resolution runs inside the operation, after replay handling.
      const target = resolveSubjectiveUatSupersedeTarget(milestoneId, supersedesCriterionId);
      if (input.criterionKey !== undefined) {
        const requestedKey = requireNonBlank(input.criterionKey, "criterionKey").toLowerCase();
        if (requestedKey !== target.criterionKey) {
          throw new Error(
            `supersedesCriterionId ${supersedesCriterionId} carries criterionKey "${target.criterionKey}" — ` +
            "prepare the replacement under that key or omit criterionKey",
          );
        }
      }
      if (requirementId !== undefined && requirementId !== target.requirementId) {
        throw new Error(
          `supersedesCriterionId ${supersedesCriterionId} carries requirementId ${target.requirementId ?? "null"} — ` +
          "prepare the replacement with that requirement or omit requirementId",
        );
      }
      criterionKey = target.criterionKey;
      requirementId = target.requirementId ?? undefined;
    } else {
      if (input.criterionKey === undefined) {
        throw new Error("criterionKey must not be blank");
      }
      criterionKey = requireNonBlank(input.criterionKey, "criterionKey").toLowerCase();
    }
    const preparedInput = {
      milestoneId,
      criterionKey,
      description,
      focusedPrompt,
      recommendedDisposition: input.recommendedDisposition,
      recommendationRationale,
      recommendationEvidence,
      testedSourceRevision,
      recommendationConfidence,
      required: input.required ?? true,
      ...(requirementId ? { requirementId } : {}),
      ...(supersedesCriterionId !== undefined ? { supersedesCriterionId } : {}),
    };
    prepared = prepareMilestoneSubjectiveUatQuestion(context, preparedInput);
    const eventPayload: DomainJsonValue = {
      milestoneId: prepared.milestoneId,
      lifecycleId: prepared.lifecycleId,
      criterionId: prepared.criterionId,
      questionId: prepared.questionId,
      interactionId: prepared.interactionId,
      acceptedOptionId: prepared.acceptedOptionId,
      rejectedOptionId: prepared.rejectedOptionId,
      testedSourceRevision: prepared.testedSourceRevision,
      withdrawnQuestionIds: prepared.withdrawnQuestionIds,
      options: prepared.options.map((option) => ({
        optionId: option.optionId,
        disposition: option.disposition,
        label: option.label,
        description: option.description,
        recommended: option.recommended,
      })),
    };
    return {
      events: [{
        eventType: "milestone.subjective-uat.prepared",
        entityType: "milestone",
        entityId: prepared.milestoneId,
        payload: eventPayload,
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: `subjective-uat/${prepared.milestoneId}/${prepared.questionId}`.toLowerCase(),
        projectionKind: "milestone-subjective-uat",
        rendererVersion: "1",
      }],
    };
  });
  return { ...operationReceipt(operation), ...(prepared ?? storedPreparation(operation.operationId)) };
}

export function answerMilestoneSubjectiveUat(
  input: AnswerMilestoneSubjectiveUatInput,
): AnswerMilestoneSubjectiveUatReceipt {
  if (input.invocation.actorType !== "user" || !input.invocation.actorId?.trim()) {
    throw new Error("Subjective UAT acceptance requires a user actor identity");
  }
  const answerInput = {
    criterionId: requireNonBlank(input.criterionId, "criterionId"),
    questionId: requireNonBlank(input.questionId, "questionId"),
    interactionId: requireNonBlank(input.interactionId, "interactionId"),
    selectedOptionId: requireNonBlank(input.selectedOptionId, "selectedOptionId"),
    verbatimResponse: requireNonBlank(input.verbatimResponse, "verbatimResponse"),
    rationale: requireNonBlank(input.rationale, "rationale"),
    testedSourceRevision: requireNonBlank(
      input.testedSourceRevision,
      "testedSourceRevision",
    ),
    actorId: input.invocation.actorId.trim(),
  };
  const fence = readDomainOperationFence(input.invocation.idempotencyKey);
  let answered: AnsweredMilestoneSubjectiveUat | undefined;
  const operation = executeDomainOperation({
    operationType: "milestone.subjective-uat.answer",
    idempotencyKey: input.invocation.idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "user",
    actorId: answerInput.actorId,
    sourceTransport: input.invocation.sourceTransport,
    ...(input.invocation.traceId ? { traceId: input.invocation.traceId } : {}),
    ...(input.invocation.turnId ? { turnId: input.invocation.turnId } : {}),
    payload: answerInput,
  }, (context) => {
    answered = answerMilestoneSubjectiveUatQuestion(context, answerInput);
    const eventPayload: DomainJsonValue = {
      milestoneId: answered.milestoneId,
      lifecycleId: answered.lifecycleId,
      criterionId: answered.criterionId,
      questionId: answered.questionId,
      interactionId: answered.interactionId,
      answerId: answered.answerId,
      humanAcceptanceId: answered.humanAcceptanceId,
      disposition: answered.disposition,
      testedSourceRevision: answered.testedSourceRevision,
      supersedesHumanAcceptanceId: answered.supersedesHumanAcceptanceId,
    };
    return {
      events: [{
        eventType: "milestone.subjective-uat.answered",
        entityType: "milestone",
        entityId: answered.milestoneId,
        payload: eventPayload,
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: `subjective-uat/${answered.milestoneId}/${answered.questionId}`.toLowerCase(),
        projectionKind: "milestone-subjective-uat",
        rendererVersion: "1",
      }],
    };
  });
  return { ...operationReceipt(operation), ...(answered ?? storedAnswer(operation.operationId)) };
}
