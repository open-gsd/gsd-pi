// Project/App: gsd-pi
// File Purpose: Task escalation Open Question, choice interaction, and answer persistence.

import type { DomainOperationContext } from "../domain-operation.js";
import { getDb } from "../engine.js";
import { insertAcceptedAnswer, insertPresentedQuestion, withdrawOpenQuestion } from "./conversation.js";
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
    SELECT question_id FROM workflow_open_questions
    WHERE project_id = :project_id
      AND lifecycle_id = :lifecycle_id
      AND question_status = 'open'
  `).all({
    ":project_id": context.projectId,
    ":lifecycle_id": lifecycleId,
  }) as Array<Record<string, unknown>>;
  return open.map((row) => {
    const questionId = String(row["question_id"]);
    withdrawOpenQuestion(context, questionId);
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
