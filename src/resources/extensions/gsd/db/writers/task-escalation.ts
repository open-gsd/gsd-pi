// Project/App: gsd-pi
// File Purpose: Task escalation Open Question, choice interaction, and answer persistence.

import { randomUUID } from "node:crypto";

import type { DomainOperationContext } from "../domain-operation.js";
import { getDb } from "../engine.js";
import { requireActiveDomainOperationContext } from "./lifecycle-commands.js";

export interface TaskEscalationOptionInput {
  id: string;
  label: string;
  tradeoffs: string;
}

export interface OpenTaskEscalationWriteInput {
  milestoneId: string;
  sliceId: string;
  taskId: string;
  question: string;
  options: TaskEscalationOptionInput[];
  recommendation: string;
  recommendationRationale: string;
}

export interface OpenedTaskEscalation {
  lifecycleId: string;
  questionId: string;
  interactionId: string;
  withdrawnQuestionIds: string[];
}

export interface AnswerTaskEscalationWriteInput {
  questionId: string;
  interactionId: string;
  /** The user's response token: an option id, "accept", or "reject-blocker". */
  choice: string;
  selectedOptionId: string | null;
  normalizedInterpretation: string;
}

function distinctTimestamp(previousTimestamp: string): string {
  return new Date(Math.max(Date.now(), Date.parse(previousTimestamp) + 1)).toISOString();
}

function requireTaskLifecycle(
  context: Readonly<DomainOperationContext>,
  input: Pick<OpenTaskEscalationWriteInput, "milestoneId" | "sliceId" | "taskId">,
): string {
  const row = getDb().prepare(`
    SELECT lifecycle_id FROM workflow_item_lifecycles
    WHERE project_id = :project_id
      AND item_kind = 'task'
      AND milestone_id = :milestone_id
      AND slice_id = :slice_id
      AND task_id = :task_id
  `).get({
    ":project_id": context.projectId,
    ":milestone_id": input.milestoneId,
    ":slice_id": input.sliceId,
    ":task_id": input.taskId,
  }) as Record<string, unknown> | undefined;
  if (!row) {
    throw new Error(
      `escalation requires a canonical Task lifecycle for ${input.milestoneId}/${input.sliceId}/${input.taskId}`,
    );
  }
  return String(row["lifecycle_id"]);
}

/** A new escalation replaces any still-open escalation question of the Task. */
function withdrawOpenQuestions(
  context: Readonly<DomainOperationContext>,
  lifecycleId: string,
): string[] {
  const open = getDb().prepare(`
    SELECT question_id, updated_at FROM workflow_open_questions
    WHERE project_id = :project_id
      AND lifecycle_id = :lifecycle_id
      AND question_status = 'open'
  `).all({
    ":project_id": context.projectId,
    ":lifecycle_id": lifecycleId,
  }) as Array<Record<string, unknown>>;
  const withdraw = getDb().prepare(`
    UPDATE workflow_open_questions
    SET question_status = 'withdrawn', state_version = state_version + 1,
        updated_at = :updated_at,
        last_operation_id = :operation_id,
        last_project_revision = :project_revision,
        last_authority_epoch = :authority_epoch
    WHERE question_id = :question_id
  `);
  return open.map((row) => {
    const questionId = String(row["question_id"]);
    withdraw.run({
      ":updated_at": distinctTimestamp(String(row["updated_at"])),
      ":operation_id": context.operationId,
      ":project_revision": context.resultingRevision,
      ":authority_epoch": context.resultingAuthorityEpoch,
      ":question_id": questionId,
    });
    return questionId;
  });
}

/**
 * Write one escalation as an Open Question with a presented choice
 * interaction. The recommended option is stored first, as the interaction
 * contract requires.
 */
export function openTaskEscalationQuestion(
  context: Readonly<DomainOperationContext>,
  input: OpenTaskEscalationWriteInput,
): OpenedTaskEscalation {
  if (requireActiveDomainOperationContext(context) !== "task.escalation.open") {
    throw new Error("Task escalation requires its Domain Operation");
  }
  const lifecycleId = requireTaskLifecycle(context, input);
  const withdrawnQuestionIds = withdrawOpenQuestions(context, lifecycleId);
  const recommended = input.options.find((option) => option.id === input.recommendation);
  if (!recommended) throw new Error("escalation recommendation must name an option");
  const options = [recommended, ...input.options.filter((option) => option !== recommended)];
  const questionId = randomUUID();
  const interactionId = randomUUID();
  const createdAt = new Date().toISOString();
  const provenance = {
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
  };

  getDb().prepare(`
    INSERT INTO workflow_open_questions (
      question_id, project_id, lifecycle_id, question_text, question_status,
      state_version, accepted_answer_id, created_at, updated_at,
      created_operation_id, created_project_revision, created_authority_epoch,
      last_operation_id, last_project_revision, last_authority_epoch
    ) VALUES (
      :question_id, :project_id, :lifecycle_id, :question_text, 'open',
      0, NULL, :created_at, :created_at,
      :operation_id, :project_revision, :authority_epoch,
      :operation_id, :project_revision, :authority_epoch
    )
  `).run({
    ":question_id": questionId,
    ":project_id": context.projectId,
    ":lifecycle_id": lifecycleId,
    ":question_text": input.question,
    ":created_at": createdAt,
    ...provenance,
  });
  getDb().prepare(`
    INSERT INTO workflow_interactions (
      interaction_id, project_id, question_id, sequence, interaction_kind,
      presentation_state, focused_prompt, requires_answer, option_count,
      recommended_option_id, recommendation_text, recommendation_rationale,
      operation_id, project_revision, authority_epoch
    ) VALUES (
      :interaction_id, :project_id, :question_id, 1, 'choice',
      'prepared', :focused_prompt, 1, :option_count,
      :recommended_option_id, :recommendation_text, :recommendation_rationale,
      :operation_id, :project_revision, :authority_epoch
    )
  `).run({
    ":interaction_id": interactionId,
    ":project_id": context.projectId,
    ":question_id": questionId,
    ":focused_prompt": input.question,
    ":option_count": options.length,
    ":recommended_option_id": recommended.id,
    ":recommendation_text": recommended.label,
    ":recommendation_rationale": input.recommendationRationale,
    ...provenance,
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
    ":option_id": option.id,
    ":project_id": context.projectId,
    ":ordinal": index + 1,
    ":label": option.label,
    ":description": option.tradeoffs,
    ...provenance,
  }));
  getDb().prepare(`
    UPDATE workflow_interactions
    SET presentation_state = 'presented', presented_at = :presented_at
    WHERE interaction_id = :interaction_id
  `).run({ ":presented_at": createdAt, ":interaction_id": interactionId });

  return { lifecycleId, questionId, interactionId, withdrawnQuestionIds };
}

/** Record the user's response as the accepted Answer and close the question. */
export function answerTaskEscalationQuestion(
  context: Readonly<DomainOperationContext>,
  input: AnswerTaskEscalationWriteInput,
): { answerId: string } {
  if (requireActiveDomainOperationContext(context) !== "task.escalation.resolve") {
    throw new Error("Task escalation answer requires its Domain Operation");
  }
  const binding = getDb().prepare(`
    SELECT interaction.project_revision, question.updated_at
    FROM workflow_open_questions question
    JOIN workflow_interactions interaction
      ON interaction.question_id = question.question_id
     AND interaction.project_id = question.project_id
    WHERE question.question_id = :question_id
      AND question.project_id = :project_id
      AND question.question_status = 'open'
      AND interaction.interaction_id = :interaction_id
      AND interaction.presentation_state = 'presented'
  `).get({
    ":question_id": input.questionId,
    ":project_id": context.projectId,
    ":interaction_id": input.interactionId,
  }) as Record<string, unknown> | undefined;
  if (!binding) throw new Error("escalation answer must match an open escalation question");

  const answerId = randomUUID();
  const createdAt = distinctTimestamp(String(binding["updated_at"]));
  const provenance = {
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
  };
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
    ":verbatim_response": input.choice,
    ":selected_option_id": input.selectedOptionId,
    ":normalized_interpretation": input.normalizedInterpretation,
    ":observed_project_revision": Number(binding["project_revision"]),
    ":created_at": createdAt,
    ...provenance,
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
    ":question_id": input.questionId,
    ...provenance,
  });
  return { answerId };
}
