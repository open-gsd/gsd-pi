// Project/App: gsd-pi
// File Purpose: Conversation Domain Operations — an answered ask_user_questions round as Open Question, interaction, and Answer rows.

import { classifyQuestion } from "./consent-question.js";
import { isDepthConfirmationAnswer } from "./consent-verdict.js";
import { executeDomainOperation } from "./db/domain-operation.js";
import { getDb } from "./db/engine.js";
import { insertAcceptedAnswer, insertPresentedQuestion } from "./db/writers/conversation.js";
import { readDomainOperationFence } from "./db/writers/lifecycle-commands.js";

export interface QuestionRoundQuestion {
  id?: string;
  header?: string;
  question?: string;
  options?: Array<{ label?: string; description?: string }>;
  allowMultiple?: boolean;
}

export interface QuestionRoundAnswer {
  selected?: unknown;
  notes?: unknown;
}

export interface RecordedQuestionRound {
  /** Tool question ids stored as question, interaction, option, and answer rows. */
  stored: string[];
  /** Questions that are not stored as rows, each with the reason. */
  skipped: Array<{ id: string; reason: string }>;
}

interface StorableQuestion {
  promptId: string;
  header: string;
  question: string;
  allowMultiple: boolean;
  interactionKind: "choice" | "consent";
  options: Array<{ id: string; label: string; description: string }>;
  responseKind: "answer" | "pushback" | "consent";
  verbatimResponse: string;
  selectedOptionId: string | null;
  normalizedInterpretation: string;
}

function nonBlank(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Map one tool question and its answer to the interaction contract, or return
 * the reason it does not fit. The tool contract puts the recommended option
 * first; its description is the recommendation rationale.
 */
function toStorableQuestion(
  question: QuestionRoundQuestion,
  answer: QuestionRoundAnswer | undefined,
): StorableQuestion | string {
  const text = nonBlank(question.question);
  if (!text) return "the question has no text";
  const options = Array.isArray(question.options) ? question.options : [];
  if (options.length < 2 || options.length > 3) {
    return `an interaction holds 2 or 3 options (got ${options.length})`;
  }
  if (options.some((option) => !nonBlank(option?.label))) return "an option has no label";
  const recommendationRationale = nonBlank(options[0]?.description);
  if (!recommendationRationale) return "the recommended option has no description to store as the rationale";

  const selected = answer?.selected;
  const selections = (Array.isArray(selected) ? selected : [selected])
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  const notes = nonBlank(answer?.notes);
  if (selections.length === 0 && !notes) return "the question has no answer";

  const optionIds = selections.map((label) => options.findIndex((option) => option.label === label));
  const choseOptions = selections.length > 0 && optionIds.every((index) => index >= 0);
  // A gate is the only question that authorizes a write; an ordinary choice is not consent (ADR-046).
  const interactionKind = classifyQuestion({ id: question.id, options }).kind === "gate" ? "consent" : "choice";
  return {
    promptId: String(question.id),
    header: nonBlank(question.header),
    question: text,
    allowMultiple: question.allowMultiple === true,
    interactionKind,
    options: options.map((option, index) => ({
      id: `option-${index + 1}`,
      label: String(option.label),
      description: nonBlank(option.description),
    })),
    responseKind: interactionKind === "consent" && isDepthConfirmationAnswer(selected, options)
      ? "consent"
      : choseOptions ? "answer" : "pushback",
    verbatimResponse: [...selections, ...(notes ? [`user_note: ${notes}`] : [])].join("\n"),
    selectedOptionId: choseOptions && selections.length === 1 ? `option-${optionIds[0]! + 1}` : null,
    normalizedInterpretation: choseOptions ? selections.join(", ") : notes || selections.join(", "),
  };
}

function findMilestoneLifecycleId(milestoneId: string): string | null {
  const row = getDb().prepare(`
    SELECT lifecycle_id FROM workflow_item_lifecycles
    WHERE item_kind = 'milestone' AND milestone_id = :milestone_id
  `).get({ ":milestone_id": milestoneId });
  return row ? String(row["lifecycle_id"]) : null;
}

/**
 * Store an answered ask_user_questions round of a Milestone. Each question is
 * an Open Question on the Milestone lifecycle with a presented interaction,
 * and each answer is its accepted Answer. An Answer must observe the revision
 * of its presented interaction, so the round is two Domain Operations:
 * conversation.question.ask, then conversation.question.answer.
 *
 * A question that does not fit the interaction contract is not stored as rows
 * and is returned in `skipped`. A replay of the same tool call writes nothing.
 */
export function recordAnsweredQuestionRound(input: {
  milestoneId: string;
  toolCallId: string;
  questions: QuestionRoundQuestion[];
  answers: Record<string, QuestionRoundAnswer | undefined>;
}): RecordedQuestionRound {
  const { milestoneId, toolCallId } = input;
  const lifecycleId = findMilestoneLifecycleId(milestoneId);
  const storable: StorableQuestion[] = [];
  const skipped: RecordedQuestionRound["skipped"] = [];
  for (const question of input.questions) {
    const id = nonBlank(question.id);
    const mapped = !id
      ? "the question has no id"
      : !lifecycleId
        ? `milestone ${milestoneId} has no lifecycle row`
        : toStorableQuestion(question, input.answers[id]);
    if (typeof mapped === "string") skipped.push({ id, reason: mapped });
    else storable.push(mapped);
  }
  const stored = storable.map((question) => question.promptId);
  if (!lifecycleId || storable.length === 0) return { stored, skipped };

  const identity = { sourceTransport: "internal", traceId: toolCallId };
  const projections = [{
    projectionKey: `questions/${milestoneId}`.toLowerCase(),
    projectionKind: "state",
    rendererVersion: "1",
  }];
  const opened: Array<{ questionId: string; interactionId: string }> = [];
  const askKey = `ask_user_questions:${toolCallId}:ask`;
  const askFence = readDomainOperationFence(askKey);
  const asked = executeDomainOperation({
    operationType: "conversation.question.ask",
    idempotencyKey: askKey,
    expectedRevision: askFence.revision,
    expectedAuthorityEpoch: askFence.authorityEpoch,
    actorType: "agent",
    ...identity,
    payload: {
      milestoneId,
      toolCallId,
      questions: storable.map((question) => ({
        promptId: question.promptId,
        header: question.header,
        question: question.question,
        interactionKind: question.interactionKind,
        allowMultiple: question.allowMultiple,
        options: question.options.map((option) => ({ label: option.label, description: option.description })),
      })),
    },
  }, (context) => ({
    events: storable.map((question) => {
      const row = insertPresentedQuestion(context, {
        lifecycleId,
        question: question.question,
        interactionKind: question.interactionKind,
        options: question.options,
        recommendationRationale: question.options[0]!.description,
      });
      opened.push(row);
      return {
        eventType: "conversation.question.asked",
        entityType: "milestone",
        entityId: milestoneId,
        payload: {
          ...row,
          lifecycleId,
          toolCallId,
          promptId: question.promptId,
          header: question.header,
          allowMultiple: question.allowMultiple,
        },
        destinations: ["projection"],
      };
    }),
    projections,
  }));
  // A replay means this tool call is already stored; its answer went with it.
  if (asked.status !== "committed") return { stored, skipped };

  const answerKey = `ask_user_questions:${toolCallId}:answer`;
  const answerFence = readDomainOperationFence(answerKey);
  executeDomainOperation({
    operationType: "conversation.question.answer",
    idempotencyKey: answerKey,
    expectedRevision: answerFence.revision,
    expectedAuthorityEpoch: answerFence.authorityEpoch,
    actorType: "user",
    ...identity,
    payload: {
      milestoneId,
      toolCallId,
      answers: storable.map((question) => ({
        promptId: question.promptId,
        responseKind: question.responseKind,
        verbatimResponse: question.verbatimResponse,
        selectedOptionId: question.selectedOptionId,
        normalizedInterpretation: question.normalizedInterpretation,
      })),
    },
  }, (context) => ({
    events: storable.map((question, index) => {
      const { questionId, interactionId } = opened[index]!;
      const { answerId } = insertAcceptedAnswer(context, {
        questionId,
        interactionId,
        responseKind: question.responseKind,
        verbatimResponse: question.verbatimResponse,
        selectedOptionId: question.selectedOptionId,
        normalizedInterpretation: question.normalizedInterpretation,
      });
      return {
        eventType: "conversation.question.answered",
        entityType: "milestone",
        entityId: milestoneId,
        payload: {
          questionId,
          interactionId,
          answerId,
          toolCallId,
          promptId: question.promptId,
          responseKind: question.responseKind,
        },
        destinations: ["projection"],
      };
    }),
    projections,
  }));
  return { stored, skipped };
}
