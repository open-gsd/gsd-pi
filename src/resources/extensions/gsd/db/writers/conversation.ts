// Project/App: gsd-pi
// File Purpose: Open Question, presented interaction, option, and accepted Answer rows of the Conversation domain.

import { randomUUID } from "node:crypto";

import type { DomainOperationContext } from "../domain-operation.js";
import { getDb } from "../engine.js";
import { requireActiveDomainOperationContext } from "./lifecycle-commands.js";

export interface InteractionOptionInput {
  id: string;
  label: string;
  description: string;
}

export interface PresentedQuestionWriteInput {
  lifecycleId: string;
  question: string;
  interactionKind: "choice" | "consent";
  /** The recommended option is first, as the interaction contract requires. */
  options: InteractionOptionInput[];
  recommendationRationale: string;
}

export interface AcceptedAnswerWriteInput {
  questionId: string;
  interactionId: string;
  responseKind: "answer" | "pushback" | "consent";
  /** What the user said or selected, unchanged. */
  verbatimResponse: string;
  selectedOptionId: string | null;
  normalizedInterpretation: string;
}

function distinctTimestamp(previousTimestamp: string): string {
  return new Date(Math.max(Date.now(), Date.parse(previousTimestamp) + 1)).toISOString();
}

function provenanceOf(context: Readonly<DomainOperationContext>) {
  return {
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
  };
}

/** Write one Open Question with a presented interaction and its options. */
export function insertPresentedQuestion(
  context: Readonly<DomainOperationContext>,
  input: PresentedQuestionWriteInput,
): { questionId: string; interactionId: string } {
  requireActiveDomainOperationContext(context);
  const recommended = input.options[0];
  if (!recommended) throw new Error("a presented interaction requires a recommended option");
  const questionId = randomUUID();
  const interactionId = randomUUID();
  const createdAt = new Date().toISOString();
  const provenance = provenanceOf(context);

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
    ":lifecycle_id": input.lifecycleId,
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
      :interaction_id, :project_id, :question_id, 1, :interaction_kind,
      'prepared', :focused_prompt, 1, :option_count,
      :recommended_option_id, :recommendation_text, :recommendation_rationale,
      :operation_id, :project_revision, :authority_epoch
    )
  `).run({
    ":interaction_id": interactionId,
    ":project_id": context.projectId,
    ":question_id": questionId,
    ":interaction_kind": input.interactionKind,
    ":focused_prompt": input.question,
    ":option_count": input.options.length,
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
  input.options.forEach((option, index) => insertOption.run({
    ":interaction_id": interactionId,
    ":option_id": option.id,
    ":project_id": context.projectId,
    ":ordinal": index + 1,
    ":label": option.label,
    ":description": option.description,
    ...provenance,
  }));
  getDb().prepare(`
    UPDATE workflow_interactions
    SET presentation_state = 'presented', presented_at = :presented_at
    WHERE interaction_id = :interaction_id
  `).run({ ":presented_at": createdAt, ":interaction_id": interactionId });

  return { questionId, interactionId };
}

/** Record the user's response as the accepted Answer and close the question. */
export function insertAcceptedAnswer(
  context: Readonly<DomainOperationContext>,
  input: AcceptedAnswerWriteInput,
): { answerId: string } {
  requireActiveDomainOperationContext(context);
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
  if (!binding) throw new Error("an answer must match an open question and its presented interaction");

  const answerId = randomUUID();
  const createdAt = distinctTimestamp(String(binding["updated_at"]));
  const provenance = provenanceOf(context);
  getDb().prepare(`
    INSERT INTO workflow_answers (
      answer_id, project_id, question_id, interaction_id, response_kind,
      verbatim_response, selected_option_id, normalized_interpretation,
      interpretation_confidence, answer_disposition, observed_project_revision,
      created_at, operation_id, project_revision, authority_epoch
    ) VALUES (
      :answer_id, :project_id, :question_id, :interaction_id, :response_kind,
      :verbatim_response, :selected_option_id, :normalized_interpretation,
      1, 'accepted', :observed_project_revision,
      :created_at, :operation_id, :project_revision, :authority_epoch
    )
  `).run({
    ":answer_id": answerId,
    ":project_id": context.projectId,
    ":question_id": input.questionId,
    ":interaction_id": input.interactionId,
    ":response_kind": input.responseKind,
    ":verbatim_response": input.verbatimResponse,
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

/** Withdraw one question that is still open. */
export function withdrawOpenQuestion(
  context: Readonly<DomainOperationContext>,
  questionId: string,
): void {
  requireActiveDomainOperationContext(context);
  const open = getDb().prepare(`
    SELECT updated_at FROM workflow_open_questions
    WHERE question_id = :question_id
      AND project_id = :project_id
      AND question_status = 'open'
  `).get({
    ":question_id": questionId,
    ":project_id": context.projectId,
  }) as Record<string, unknown> | undefined;
  if (!open) throw new Error("only an open question can be withdrawn");
  getDb().prepare(`
    UPDATE workflow_open_questions
    SET question_status = 'withdrawn', state_version = state_version + 1,
        updated_at = :updated_at,
        last_operation_id = :operation_id,
        last_project_revision = :project_revision,
        last_authority_epoch = :authority_epoch
    WHERE question_id = :question_id
  `).run({
    ":updated_at": distinctTimestamp(String(open["updated_at"])),
    ":question_id": questionId,
    ...provenanceOf(context),
  });
}
