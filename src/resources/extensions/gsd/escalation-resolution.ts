// Project/App: gsd-pi
// File Purpose: Resolve a Task escalation from any transport: the answer, the state render, and the decision record.
//
// An open escalation question is the project's pending blocker. It is a
// database row, so a transport that holds no session (an MCP server after a
// restart) reads it and resolves it here, the same way `/gsd escalate resolve`
// does.

import type { EscalationOption } from "./types.js";
import { saveDecisionToDb } from "./db-writer.js";
import { getDb } from "./db/engine.js";
import { TASK_ESCALATION_OPENED_EVENT } from "./db/sql-constants.js";
import { readTaskEscalation, resolveEscalation, type ResolveEscalationResult } from "./escalation.js";
import type { ExecutionInvocation } from "./execution-invocation.js";
import { emitUokAuditEvent, buildAuditEnvelope } from "./uok/audit.js";
import { renderStateProjection } from "./workflow-projections.js";

export interface EscalationTaskRef {
  milestoneId: string;
  sliceId: string;
  taskId: string;
}

export interface OpenEscalation extends EscalationTaskRef {
  questionId: string;
  question: string;
}

/** Every open escalation question of the project, oldest first. */
export function listOpenEscalations(): OpenEscalation[] {
  const rows = getDb().prepare(`
    SELECT question.question_id, question.question_text,
           lifecycle.milestone_id, lifecycle.slice_id, lifecycle.task_id
    FROM workflow_open_questions question
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.lifecycle_id = question.lifecycle_id
     AND lifecycle.project_id = question.project_id
    WHERE question.question_status = 'open'
      AND lifecycle.item_kind = 'task'
      AND EXISTS (
        SELECT 1 FROM workflow_domain_events opened
        WHERE opened.project_id = question.project_id
          AND opened.event_type = :opened_event
          AND json_extract(opened.payload_json, '$.questionId') = question.question_id
      )
    ORDER BY question.created_project_revision, question.question_id
  `).all({ ":opened_event": TASK_ESCALATION_OPENED_EVENT });
  return rows.map((row) => ({
    questionId: String(row["question_id"]),
    question: String(row["question_text"]),
    milestoneId: String(row["milestone_id"]),
    sliceId: String(row["slice_id"]),
    taskId: String(row["task_id"]),
  }));
}

/**
 * Record the resolution of an escalation in the decision register and return
 * the decision id. `invocation` is the transport and the actor of the
 * resolution. Without it the resolution is from the user, through
 * `/gsd escalate`.
 */
export async function recordEscalationDecision(
  basePath: string,
  task: EscalationTaskRef,
  choice: string,
  rationale: string,
  chosenOption: EscalationOption | undefined,
  invocation?: ExecutionInvocation,
): Promise<string> {
  const { milestoneId, sliceId, taskId } = task;
  const art = readTaskEscalation(milestoneId, sliceId, taskId);
  const choiceLabel = choice === "accept"
    ? `${art?.recommendation ?? "accepted"} (recommended)`
    : (chosenOption?.label ?? choice);
  const { id: decisionId } = await saveDecisionToDb({
    scope: `${milestoneId}/${sliceId}/${taskId}`,
    decision: art?.question ?? `escalation on ${taskId}`,
    choice: choiceLabel,
    rationale: rationale || chosenOption?.tradeoffs || "User-resolved escalation.",
    made_by: !invocation || invocation.actorType === "user" ? "human" : "agent",
    source: "escalation",
    when_context: `ADR-011 escalation resolved ${new Date().toISOString()}`,
  }, basePath, invocation);

  emitUokAuditEvent(basePath, buildAuditEnvelope({
    traceId: `escalation:${milestoneId}:${sliceId}:${taskId}`,
    category: "gate",
    type: "escalation-decision-persisted",
    payload: { milestoneId, sliceId, taskId, decisionId, choice },
  }));
  return decisionId;
}

export interface PendingEscalationResolution extends ResolveEscalationResult, OpenEscalation {
  /** The decision register entry of a resolved escalation. */
  decisionId?: string;
  /** Why the decision register entry was not written. The escalation is resolved. */
  decisionError?: string;
}

/**
 * Resolve the project's pending escalation. `response` is
 * `<choice> [rationale...]`, where choice is an option id, `accept`, or
 * `reject-blocker`. `invocation` is the transport and the actor of the caller:
 * the answer and the decision record them. `questionId` selects one escalation
 * when more than one is open. Throws when no escalation is open or the
 * selection is not unique.
 */
export async function resolvePendingEscalation(
  basePath: string,
  response: string,
  invocation: ExecutionInvocation,
  questionId?: string,
): Promise<PendingEscalationResolution> {
  const open = listOpenEscalations();
  const matches = questionId ? open.filter((escalation) => escalation.questionId === questionId) : open;
  if (matches.length === 0) {
    throw new Error(questionId
      ? `No open escalation with questionId ${questionId}.`
      : "No pending blocker: the project database has no open escalation.");
  }
  if (matches.length > 1) {
    throw new Error(
      `More than one escalation is open. Pass questionId: ${matches.map((m) => `${m.questionId} (${m.sliceId}/${m.taskId})`).join(", ")}.`,
    );
  }
  const escalation = matches[0]!;
  const [choice = "", ...rationaleWords] = response.trim().split(/\s+/);
  const rationale = rationaleWords.join(" ");

  const result = resolveEscalation(
    basePath, escalation.milestoneId, escalation.sliceId, escalation.taskId, choice, rationale, invocation,
  );
  await renderStateProjection(basePath);
  if (result.status !== "resolved") return { ...escalation, ...result };
  try {
    return {
      ...escalation,
      ...result,
      decisionId: await recordEscalationDecision(basePath, escalation, choice, rationale, result.chosenOption, invocation),
    };
  } catch (err) {
    return { ...escalation, ...result, decisionError: (err as Error).message };
  }
}
