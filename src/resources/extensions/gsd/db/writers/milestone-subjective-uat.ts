// Project/App: gsd-pi
// File Purpose: Context-bound subjective-UAT question, answer, and human-acceptance persistence.

import { randomUUID } from "node:crypto";

import type { DomainOperationContext } from "../domain-operation.js";
import { getDb } from "../engine.js";
import { requireActiveDomainOperationContext } from "./lifecycle-commands.js";

export type SubjectiveUatDisposition = "accepted" | "rejected";

export interface SubjectiveUatOption {
  optionId: string;
  disposition: SubjectiveUatDisposition;
  label: string;
  description: string;
  recommended: boolean;
}

export interface PrepareMilestoneSubjectiveUatWriteInput {
  milestoneId: string;
  criterionKey: string;
  description: string;
  focusedPrompt: string;
  recommendedDisposition: SubjectiveUatDisposition;
  recommendationRationale: string;
  recommendationEvidence: string;
  testedSourceRevision: string;
  recommendationConfidence: number;
  required: boolean;
  requirementId?: string;
}

export interface PreparedMilestoneSubjectiveUat {
  milestoneId: string;
  lifecycleId: string;
  criterionId: string;
  questionId: string;
  interactionId: string;
  acceptedOptionId: string;
  rejectedOptionId: string;
  testedSourceRevision: string;
  withdrawnQuestionIds: string[];
  options: SubjectiveUatOption[];
}

export interface AnswerMilestoneSubjectiveUatWriteInput {
  criterionId: string;
  questionId: string;
  interactionId: string;
  selectedOptionId: string;
  verbatimResponse: string;
  rationale: string;
  testedSourceRevision: string;
  actorId: string;
}

export interface AnsweredMilestoneSubjectiveUat {
  milestoneId: string;
  lifecycleId: string;
  criterionId: string;
  questionId: string;
  interactionId: string;
  answerId: string;
  humanAcceptanceId: string;
  disposition: SubjectiveUatDisposition;
  testedSourceRevision: string;
  supersedesHumanAcceptanceId: string | null;
}

interface MilestoneLifecycleRow {
  lifecycle_id: string;
  lifecycle_status: string;
}

interface CriterionRow {
  criterion_id: string;
  criterion_kind: string;
  evidence_class: string;
  required: number;
  description: string;
}

interface PreparedBindingRow {
  milestone_id: string;
  lifecycle_id: string;
  lifecycle_status: string;
  interaction_project_revision: number;
  question_updated_at: string;
  accepted_option_id: string;
  rejected_option_id: string;
  tested_source_revision: string;
}

interface OptionRow {
  label: string;
}

interface OpenQuestionRow {
  question_id: string;
  criterion_id: string;
  tested_source_revision: string;
  updated_at: string;
}

interface AcceptanceHeadRow {
  human_acceptance_id: string;
}

function requireNonBlank(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${field} must not be blank`);
  return normalized;
}

function requireMilestoneLifecycle(
  context: Readonly<DomainOperationContext>,
  milestoneId: string,
): MilestoneLifecycleRow {
  const lifecycle = getDb().prepare(`
    SELECT lifecycle_id, lifecycle_status
    FROM workflow_item_lifecycles
    WHERE project_id = :project_id
      AND item_kind = 'milestone'
      AND milestone_id = :milestone_id
      AND slice_id IS NULL
      AND task_id IS NULL
  `).get({
    ":project_id": context.projectId,
    ":milestone_id": milestoneId,
  }) as unknown as MilestoneLifecycleRow | undefined;
  if (!lifecycle) throw new Error("Subjective UAT requires an adopted Milestone lifecycle");
  requireActiveMilestoneLifecycle(lifecycle.lifecycle_status);
  return lifecycle;
}

function requireActiveMilestoneLifecycle(lifecycleStatus: string): void {
  if (lifecycleStatus !== "ready" && lifecycleStatus !== "in_progress") {
    throw new Error(
      `Subjective UAT requires a ready or in_progress lifecycle, found ${lifecycleStatus}`,
    );
  }
}

function currentCriterion(
  context: Readonly<DomainOperationContext>,
  lifecycleId: string,
  criterionKey: string,
  requirementId?: string,
): CriterionRow | undefined {
  return getDb().prepare(`
    SELECT criterion_id, criterion_kind, evidence_class, required, description
    FROM workflow_acceptance_criteria criterion
    WHERE criterion.project_id = :project_id
      AND criterion.lifecycle_id = :lifecycle_id
      AND criterion.criterion_key = :criterion_key
      AND criterion.requirement_id IS :requirement_id
      AND NOT EXISTS (
        SELECT 1 FROM workflow_acceptance_criteria successor
        WHERE successor.supersedes_criterion_id = criterion.criterion_id
      )
  `).get({
    ":project_id": context.projectId,
    ":lifecycle_id": lifecycleId,
    ":criterion_key": criterionKey,
    ":requirement_id": requirementId ?? null,
  }) as unknown as CriterionRow | undefined;
}

function ensureSubjectiveCriterion(
  context: Readonly<DomainOperationContext>,
  lifecycleId: string,
  input: PrepareMilestoneSubjectiveUatWriteInput,
  createdAt: string,
): string {
  const current = currentCriterion(
    context,
    lifecycleId,
    input.criterionKey,
    input.requirementId,
  );
  if (current && current.criterion_kind !== "subjective_uat") {
    throw new Error("Subjective UAT criterion identity conflicts with a technical criterion");
  }
  if (
    current &&
    current.evidence_class === "human" &&
    Boolean(current.required) === input.required &&
    current.description === input.description
  ) {
    return current.criterion_id;
  }

  const criterionId = randomUUID();
  getDb().prepare(`
    INSERT INTO workflow_acceptance_criteria (
      criterion_id, criterion_key, project_id, lifecycle_id, requirement_id,
      criterion_kind, evidence_class, required, description,
      supersedes_criterion_id, created_at,
      operation_id, project_revision, authority_epoch
    ) VALUES (
      :criterion_id, :criterion_key, :project_id, :lifecycle_id, :requirement_id,
      'subjective_uat', 'human', :required, :description,
      :supersedes_criterion_id, :created_at,
      :operation_id, :project_revision, :authority_epoch
    )
  `).run({
    ":criterion_id": criterionId,
    ":criterion_key": input.criterionKey,
    ":project_id": context.projectId,
    ":lifecycle_id": lifecycleId,
    ":requirement_id": input.requirementId ?? null,
    ":required": input.required ? 1 : 0,
    ":description": input.description,
    ":supersedes_criterion_id": current?.criterion_id ?? null,
    ":created_at": createdAt,
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
  });
  return criterionId;
}

function reconcileOpenQuestions(
  context: Readonly<DomainOperationContext>,
  lifecycleId: string,
  input: PrepareMilestoneSubjectiveUatWriteInput,
  criterionId: string,
): string[] {
  const openQuestions = getDb().prepare(`
    SELECT question.question_id, criterion.criterion_id, question.updated_at,
           json_extract(event.payload_json, '$.testedSourceRevision') AS tested_source_revision
    FROM workflow_domain_events event
    JOIN workflow_open_questions question
      ON question.question_id = json_extract(event.payload_json, '$.questionId')
     AND question.project_id = event.project_id
    JOIN workflow_acceptance_criteria criterion
      ON criterion.criterion_id = json_extract(event.payload_json, '$.criterionId')
     AND criterion.project_id = event.project_id
    WHERE event.project_id = :project_id
      AND event.event_type = 'milestone.subjective-uat.prepared'
      AND criterion.lifecycle_id = :lifecycle_id
      AND criterion.criterion_key = :criterion_key
      AND criterion.requirement_id IS :requirement_id
      AND question.question_status = 'open'
    ORDER BY question.created_project_revision, question.question_id
  `).all({
    ":project_id": context.projectId,
    ":lifecycle_id": lifecycleId,
    ":criterion_key": input.criterionKey,
    ":requirement_id": input.requirementId ?? null,
  }) as unknown as OpenQuestionRow[];
  const duplicate = openQuestions.find((question) =>
    question.criterion_id === criterionId &&
    question.tested_source_revision === input.testedSourceRevision
  );
  if (duplicate) throw new Error("Subjective UAT criterion already has an open question");

  const withdrawQuestion = getDb().prepare(`
    UPDATE workflow_open_questions
    SET question_status = 'withdrawn', state_version = state_version + 1,
        updated_at = :updated_at, last_operation_id = :operation_id,
        last_project_revision = :project_revision,
        last_authority_epoch = :authority_epoch
    WHERE question_id = :question_id
  `);
  for (const question of openQuestions) {
    withdrawQuestion.run({
      ":updated_at": distinctTimestamp(question.updated_at),
      ":operation_id": context.operationId,
      ":project_revision": context.resultingRevision,
      ":authority_epoch": context.resultingAuthorityEpoch,
      ":question_id": question.question_id,
    });
  }
  return openQuestions.map((question) => question.question_id);
}

function optionLabel(disposition: SubjectiveUatDisposition, recommended: boolean): string {
  const label = disposition === "accepted" ? "Accept" : "Reject";
  return recommended ? `${label} (Recommended)` : label;
}

function buildOptions(recommendedDisposition: SubjectiveUatDisposition): SubjectiveUatOption[] {
  const dispositions: SubjectiveUatDisposition[] = [
    recommendedDisposition,
    recommendedDisposition === "accepted" ? "rejected" : "accepted",
  ];
  return dispositions
    .map((disposition, index) => ({
      optionId: randomUUID(),
      disposition,
      label: optionLabel(disposition, index === 0),
      description: disposition === "accepted"
        ? "The experience meets this subjective criterion."
        : "The experience needs another revision before acceptance.",
      recommended: index === 0,
    }));
}

export function prepareMilestoneSubjectiveUatQuestion(
  context: Readonly<DomainOperationContext>,
  input: PrepareMilestoneSubjectiveUatWriteInput,
): PreparedMilestoneSubjectiveUat {
  if (requireActiveDomainOperationContext(context) !== "milestone.subjective-uat.prepare") {
    throw new Error("Subjective UAT preparation requires its Domain Operation");
  }
  const milestoneId = requireNonBlank(input.milestoneId, "milestoneId");
  const lifecycle = requireMilestoneLifecycle(context, milestoneId);
  const createdAt = new Date().toISOString();
  const criterionId = ensureSubjectiveCriterion(context, lifecycle.lifecycle_id, input, createdAt);
  const withdrawnQuestionIds = reconcileOpenQuestions(
    context,
    lifecycle.lifecycle_id,
    input,
    criterionId,
  );

  const questionId = randomUUID();
  const interactionId = randomUUID();
  const options = buildOptions(input.recommendedDisposition);
  const acceptedOptionId = options.find((option) => option.disposition === "accepted")!.optionId;
  const rejectedOptionId = options.find((option) => option.disposition === "rejected")!.optionId;

  getDb().prepare(`
    INSERT INTO workflow_open_questions (
      question_id, project_id, lifecycle_id, question_text, question_status,
      state_version, accepted_answer_id, created_at, updated_at,
      created_operation_id, created_project_revision, created_authority_epoch,
      last_operation_id, last_project_revision, last_authority_epoch
    ) VALUES (
      :question_id, :project_id, :lifecycle_id, :question_text, 'open',
      0, NULL, :created_at, :updated_at,
      :operation_id, :project_revision, :authority_epoch,
      :operation_id, :project_revision, :authority_epoch
    )
  `).run({
    ":question_id": questionId,
    ":project_id": context.projectId,
    ":lifecycle_id": lifecycle.lifecycle_id,
    ":question_text": input.focusedPrompt,
    ":created_at": createdAt,
    ":updated_at": createdAt,
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
  });
  getDb().prepare(`
    INSERT INTO workflow_interactions (
      interaction_id, project_id, question_id, sequence, interaction_kind,
      presentation_state, focused_prompt, requires_answer, option_count,
      recommended_option_id, recommendation_text, recommendation_rationale,
      recommendation_evidence, recommendation_confidence,
      recommendation_uncertainty, revisit_condition, presented_at,
      operation_id, project_revision, authority_epoch
    ) VALUES (
      :interaction_id, :project_id, :question_id, 1, 'subjective-uat',
      'prepared', :focused_prompt, 1, 2,
      :recommended_option_id, :recommendation_text, :recommendation_rationale,
      :recommendation_evidence, :recommendation_confidence,
      '', '', '', :operation_id, :project_revision, :authority_epoch
    )
  `).run({
    ":interaction_id": interactionId,
    ":project_id": context.projectId,
    ":question_id": questionId,
    ":focused_prompt": input.focusedPrompt,
    ":recommended_option_id": options[0]!.optionId,
    ":recommendation_text": input.recommendedDisposition === "accepted"
      ? "I recommend accepting this experience."
      : "I recommend rejecting this experience for revision.",
    ":recommendation_rationale": input.recommendationRationale,
    ":recommendation_evidence": input.recommendationEvidence,
    ":recommendation_confidence": input.recommendationConfidence,
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
  });
  const insertOption = getDb().prepare(`
    INSERT INTO workflow_interaction_options (
      interaction_id, option_id, project_id, ordinal, label, description,
      operation_id, project_revision, authority_epoch
    ) VALUES (
      :interaction_id, :option_id, :project_id, :ordinal, :label, :description,
      :operation_id, :project_revision, :authority_epoch
    )
  `);
  options.forEach((option, index) => insertOption.run({
    ":interaction_id": interactionId,
    ":option_id": option.optionId,
    ":project_id": context.projectId,
    ":ordinal": index + 1,
    ":label": option.label,
    ":description": option.description,
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
  }));
  getDb().prepare(`
    UPDATE workflow_interactions
    SET presentation_state = 'presented', presented_at = :presented_at
    WHERE interaction_id = :interaction_id
  `).run({
    ":presented_at": createdAt,
    ":interaction_id": interactionId,
  });
  return {
    milestoneId,
    lifecycleId: lifecycle.lifecycle_id,
    criterionId,
    questionId,
    interactionId,
    acceptedOptionId,
    rejectedOptionId,
    testedSourceRevision: input.testedSourceRevision,
    withdrawnQuestionIds,
    options,
  };
}

function preparedBinding(
  context: Readonly<DomainOperationContext>,
  input: AnswerMilestoneSubjectiveUatWriteInput,
): PreparedBindingRow {
  const binding = getDb().prepare(`
    SELECT lifecycle.milestone_id, criterion.lifecycle_id, lifecycle.lifecycle_status,
           interaction.project_revision AS interaction_project_revision,
           question.updated_at AS question_updated_at,
           json_extract(event.payload_json, '$.acceptedOptionId') AS accepted_option_id,
           json_extract(event.payload_json, '$.rejectedOptionId') AS rejected_option_id,
           json_extract(event.payload_json, '$.testedSourceRevision') AS tested_source_revision
    FROM workflow_domain_events event
    JOIN workflow_acceptance_criteria criterion
      ON criterion.criterion_id = :criterion_id
     AND criterion.project_id = event.project_id
     AND criterion.lifecycle_id = json_extract(event.payload_json, '$.lifecycleId')
    JOIN workflow_open_questions question
      ON question.question_id = :question_id
     AND question.project_id = event.project_id
     AND question.lifecycle_id = criterion.lifecycle_id
    JOIN workflow_interactions interaction
      ON interaction.interaction_id = :interaction_id
     AND interaction.project_id = event.project_id
     AND interaction.question_id = question.question_id
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.lifecycle_id = criterion.lifecycle_id
     AND lifecycle.project_id = criterion.project_id
    WHERE event.project_id = :project_id
      AND event.event_type = 'milestone.subjective-uat.prepared'
      AND json_extract(event.payload_json, '$.criterionId') = :criterion_id
      AND json_extract(event.payload_json, '$.questionId') = :question_id
      AND json_extract(event.payload_json, '$.interactionId') = :interaction_id
      AND criterion.criterion_kind = 'subjective_uat'
      AND criterion.evidence_class = 'human'
      AND NOT EXISTS (
        SELECT 1 FROM workflow_acceptance_criteria successor
        WHERE successor.supersedes_criterion_id = criterion.criterion_id
      )
      AND question.question_status = 'open'
      AND interaction.interaction_kind = 'subjective-uat'
      AND interaction.presentation_state = 'presented'
  `).get({
    ":project_id": context.projectId,
    ":criterion_id": input.criterionId,
    ":question_id": input.questionId,
    ":interaction_id": input.interactionId,
  }) as unknown as PreparedBindingRow | undefined;
  if (!binding) throw new Error("Answer must match a current prepared subjective-UAT binding");
  requireActiveMilestoneLifecycle(binding.lifecycle_status);
  return binding;
}

function distinctTimestamp(previousTimestamp: string): string {
  return new Date(Math.max(Date.now(), Date.parse(previousTimestamp) + 1)).toISOString();
}

export function answerMilestoneSubjectiveUatQuestion(
  context: Readonly<DomainOperationContext>,
  input: AnswerMilestoneSubjectiveUatWriteInput,
): AnsweredMilestoneSubjectiveUat {
  if (requireActiveDomainOperationContext(context) !== "milestone.subjective-uat.answer") {
    throw new Error("Subjective UAT answer requires its Domain Operation");
  }
  const binding = preparedBinding(context, input);
  if (input.testedSourceRevision !== binding.tested_source_revision) {
    throw new Error("Subjective UAT answer must match the prepared source revision");
  }
  let disposition: SubjectiveUatDisposition;
  if (input.selectedOptionId === binding.accepted_option_id) {
    disposition = "accepted";
  } else if (input.selectedOptionId === binding.rejected_option_id) {
    disposition = "rejected";
  } else {
    throw new Error("Answer must select the prepared Accept or Reject option");
  }
  const option = getDb().prepare(`
    SELECT label FROM workflow_interaction_options
    WHERE interaction_id = :interaction_id AND option_id = :option_id
  `).get({
    ":interaction_id": input.interactionId,
    ":option_id": input.selectedOptionId,
  }) as unknown as OptionRow | undefined;
  if (!option || input.verbatimResponse !== option.label) {
    throw new Error("Subjective UAT acceptance requires the actual selected option response");
  }

  const previous = getDb().prepare(`
    SELECT human_acceptance_id
    FROM workflow_human_acceptances acceptance
    WHERE acceptance.project_id = :project_id
      AND acceptance.criterion_id = :criterion_id
      AND NOT EXISTS (
        SELECT 1 FROM workflow_human_acceptances successor
        WHERE successor.supersedes_human_acceptance_id = acceptance.human_acceptance_id
      )
  `).get({
    ":project_id": context.projectId,
    ":criterion_id": input.criterionId,
  }) as unknown as AcceptanceHeadRow | undefined;
  const answerId = randomUUID();
  const humanAcceptanceId = randomUUID();
  const createdAt = distinctTimestamp(binding.question_updated_at);
  getDb().prepare(`
    INSERT INTO workflow_answers (
      answer_id, project_id, question_id, interaction_id, response_kind,
      verbatim_response, selected_option_id, normalized_interpretation,
      interpretation_confidence, answer_disposition, observed_project_revision,
      created_at, operation_id, project_revision, authority_epoch
    ) VALUES (
      :answer_id, :project_id, :question_id, :interaction_id, 'answer',
      :verbatim_response, :selected_option_id, :normalized_interpretation,
      1, 'accepted', :observed_project_revision,
      :created_at, :operation_id, :project_revision, :authority_epoch
    )
  `).run({
    ":answer_id": answerId,
    ":project_id": context.projectId,
    ":question_id": input.questionId,
    ":interaction_id": input.interactionId,
    ":verbatim_response": input.verbatimResponse,
    ":selected_option_id": input.selectedOptionId,
    ":normalized_interpretation": `${disposition}_subjective_experience`,
    ":observed_project_revision": binding.interaction_project_revision,
    ":created_at": createdAt,
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
  });
  getDb().prepare(`
    UPDATE workflow_open_questions
    SET question_status = 'answered', accepted_answer_id = :answer_id,
        state_version = state_version + 1, updated_at = :updated_at,
        last_operation_id = :operation_id,
        last_project_revision = :project_revision,
        last_authority_epoch = :authority_epoch
    WHERE question_id = :question_id
  `).run({
    ":answer_id": answerId,
    ":updated_at": createdAt,
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
    ":question_id": input.questionId,
  });
  getDb().prepare(`
    INSERT INTO workflow_human_acceptances (
      human_acceptance_id, project_id, criterion_id, lifecycle_id,
      answer_id, question_id, interaction_id, disposition, actor_id, rationale,
      supersedes_human_acceptance_id, created_at,
      operation_id, project_revision, authority_epoch
    ) VALUES (
      :human_acceptance_id, :project_id, :criterion_id, :lifecycle_id,
      :answer_id, :question_id, :interaction_id, :disposition, :actor_id, :rationale,
      :supersedes_human_acceptance_id, :created_at,
      :operation_id, :project_revision, :authority_epoch
    )
  `).run({
    ":human_acceptance_id": humanAcceptanceId,
    ":project_id": context.projectId,
    ":criterion_id": input.criterionId,
    ":lifecycle_id": binding.lifecycle_id,
    ":answer_id": answerId,
    ":question_id": input.questionId,
    ":interaction_id": input.interactionId,
    ":disposition": disposition,
    ":actor_id": input.actorId,
    ":rationale": input.rationale,
    ":supersedes_human_acceptance_id": previous?.human_acceptance_id ?? null,
    ":created_at": createdAt,
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
  });
  return {
    milestoneId: binding.milestone_id,
    lifecycleId: binding.lifecycle_id,
    criterionId: input.criterionId,
    questionId: input.questionId,
    interactionId: input.interactionId,
    answerId,
    humanAcceptanceId,
    disposition,
    testedSourceRevision: input.testedSourceRevision,
    supersedesHumanAcceptanceId: previous?.human_acceptance_id ?? null,
  };
}
