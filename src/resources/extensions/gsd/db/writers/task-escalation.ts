// Project/App: gsd-pi
// File Purpose: Task escalation Open Question, choice interaction, and answer persistence.

import type { DomainOperationContext } from "../domain-operation.js";
import { getDb } from "../engine.js";
import { distinctTimestamp, insertAcceptedAnswer, insertPresentedQuestion } from "./conversation.js";
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
  const { questionId, interactionId } = insertPresentedQuestion(context, {
    lifecycleId,
    question: input.question,
    interactionKind: "choice",
    options: options.map((option) => ({ id: option.id, label: option.label, description: option.tradeoffs })),
    recommendationRationale: input.recommendationRationale,
  });

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
  return insertAcceptedAnswer(context, {
    questionId: input.questionId,
    interactionId: input.interactionId,
    responseKind: "answer",
    verbatimResponse: input.choice,
    selectedOptionId: input.selectedOptionId,
    normalizedInterpretation: input.normalizedInterpretation,
  });
}
