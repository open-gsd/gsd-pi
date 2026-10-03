// Project/App: gsd-pi
// File Purpose: Mid-execution escalation questions, answers, and state helpers for GSD tasks.
// GSD Extension — ADR-011 Phase 2 Mid-Execution Escalation
//
// An escalation is an Open Question on the Task lifecycle with a presented
// choice interaction (ADR-046). The database rows are the only record: the
// question, options, recommendation, and the user's answer. The legacy task
// flags mirror the pause for state derivation. Scoped to execute-task only.

import type { EscalationArtifact, EscalationOption } from "./types.js";
import {
  setTaskEscalationPending,
  setTaskEscalationAwaitingReview,
  clearTaskEscalationFlags,
  claimEscalationOverride,
  findUnappliedEscalationOverride,
  setTaskBlockerSource,
  listEscalationArtifacts,
} from "./gsd-db.js";
import type { TaskRow } from "./db-task-slice-rows.js";
import { executeDomainOperation } from "./db/domain-operation.js";
import { getDb } from "./db/engine.js";
import { TASK_ESCALATION_OPENED_EVENT } from "./db/sql-constants.js";
import { readDomainOperationFence } from "./db/writers/lifecycle-commands.js";
import {
  answerTaskEscalationQuestion,
  openTaskEscalationQuestion,
} from "./db/writers/task-escalation.js";
import type { ExecutionInvocation } from "./execution-invocation.js";
import { emitUokAuditEvent, buildAuditEnvelope } from "./uok/audit.js";

const TASK_ESCALATION_RESOLVED_EVENT = "task.escalation.resolved";

/** An escalation as stored in the database, with its question identity. */
export interface TaskEscalation extends EscalationArtifact {
  questionId: string;
  interactionId: string;
}

// ─── Validation ───────────────────────────────────────────────────────────

/** Build an EscalationArtifact from a gsd_complete_task escalation payload. */
export function buildEscalationArtifact(params: {
  taskId: string;
  sliceId: string;
  milestoneId: string;
  question: string;
  options: EscalationOption[];
  recommendation: string;
  recommendationRationale: string;
  continueWithDefault: boolean;
}): EscalationArtifact {
  // Server-side validation — the tool schemas already constrain shape, but
  // non-tool callers must not reach the interaction contract with weaker
  // input. A choice interaction has 2-3 options with non-blank labels and a
  // recommendation with a non-blank rationale.
  if (typeof params.question !== "string" || params.question.trim().length === 0) {
    throw new Error("escalation.question must not be blank");
  }
  if (!Array.isArray(params.options) || params.options.length < 2 || params.options.length > 3) {
    throw new Error(`escalation.options must have between 2 and 3 entries (got ${params.options?.length ?? 0})`);
  }
  const optionIds = new Set(params.options.map((o) => o.id));
  if (optionIds.size !== params.options.length) {
    throw new Error("escalation.options must have unique ids");
  }
  if (params.options.some((o) => typeof o.label !== "string" || o.label.trim().length === 0)) {
    throw new Error("escalation.options labels must not be blank");
  }
  if (!optionIds.has(params.recommendation)) {
    throw new Error(`escalation.recommendation "${params.recommendation}" is not one of the option ids: ${[...optionIds].join(", ")}`);
  }
  if (typeof params.recommendationRationale !== "string" || params.recommendationRationale.trim().length === 0) {
    throw new Error("escalation.recommendationRationale must not be blank");
  }
  return {
    taskId: params.taskId,
    sliceId: params.sliceId,
    milestoneId: params.milestoneId,
    question: params.question,
    options: params.options,
    recommendation: params.recommendation,
    recommendationRationale: params.recommendationRationale,
    continueWithDefault: params.continueWithDefault,
    createdAt: new Date().toISOString(),
  };
}

// ─── Open ─────────────────────────────────────────────────────────────────

/** An escalation question is scoped to the Task's canonical lifecycle row. */
export function taskHasCanonicalLifecycle(
  milestoneId: string, sliceId: string, taskId: string,
): boolean {
  return getDb().prepare(`
    SELECT 1 FROM workflow_item_lifecycles
    WHERE item_kind = 'task'
      AND milestone_id = :milestone_id
      AND slice_id = :slice_id
      AND task_id = :task_id
  `).get({
    ":milestone_id": milestoneId,
    ":slice_id": sliceId,
    ":task_id": taskId,
  }) !== undefined;
}

/**
 * Record an escalation and the Task pause in one task.escalation.open Domain
 * Operation. The Task must have a canonical lifecycle. A replay with the same
 * idempotency key writes nothing.
 */
export function openTaskEscalation(
  basePath: string,
  artifact: EscalationArtifact,
  invocation: ExecutionInvocation,
): void {
  const { milestoneId, sliceId, taskId } = artifact;
  const fence = readDomainOperationFence(invocation.idempotencyKey);
  const operation = executeDomainOperation({
    operationType: "task.escalation.open",
    idempotencyKey: invocation.idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: invocation.actorType,
    ...(invocation.actorId ? { actorId: invocation.actorId } : {}),
    sourceTransport: invocation.sourceTransport,
    ...(invocation.traceId ? { traceId: invocation.traceId } : {}),
    ...(invocation.turnId ? { turnId: invocation.turnId } : {}),
    payload: {
      milestoneId,
      sliceId,
      taskId,
      question: artifact.question,
      options: artifact.options.map((o) => ({ id: o.id, label: o.label, tradeoffs: o.tradeoffs })),
      recommendation: artifact.recommendation,
      recommendationRationale: artifact.recommendationRationale,
      continueWithDefault: artifact.continueWithDefault,
    },
  }, (context) => {
    const opened = openTaskEscalationQuestion(context, {
      milestoneId,
      sliceId,
      taskId,
      question: artifact.question,
      options: artifact.options,
      recommendation: artifact.recommendation,
      recommendationRationale: artifact.recommendationRationale,
    });
    if (artifact.continueWithDefault) {
      setTaskEscalationAwaitingReview(milestoneId, sliceId, taskId);
    } else {
      setTaskEscalationPending(milestoneId, sliceId, taskId);
    }
    return {
      events: [{
        eventType: TASK_ESCALATION_OPENED_EVENT,
        entityType: "task",
        entityId: `${milestoneId}/${sliceId}/${taskId}`,
        payload: {
          lifecycleId: opened.lifecycleId,
          questionId: opened.questionId,
          interactionId: opened.interactionId,
          withdrawnQuestionIds: opened.withdrawnQuestionIds,
          continueWithDefault: artifact.continueWithDefault,
        },
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: `escalation/${milestoneId}/${sliceId}/${taskId}`.toLowerCase(),
        projectionKind: "state",
        rendererVersion: "1",
      }],
    };
  });
  if (operation.status !== "committed") return;

  emitUokAuditEvent(basePath, buildAuditEnvelope({
    traceId: `escalation:${milestoneId}:${sliceId}:${taskId}`,
    category: "gate",
    type: "escalation-manual-attention-created",
    payload: {
      milestoneId,
      sliceId,
      taskId,
      continueWithDefault: artifact.continueWithDefault,
      optionCount: artifact.options.length,
      recommendation: artifact.recommendation,
    },
  }));
}

// ─── Read ─────────────────────────────────────────────────────────────────

/**
 * The Task's current escalation (open or answered) from the database, or null
 * when the Task has none. A withdrawn question is not current.
 */
export function readTaskEscalation(
  milestoneId: string, sliceId: string, taskId: string,
): TaskEscalation | null {
  const row = getDb().prepare(`
    SELECT question.question_id, question.question_text, question.created_at,
           interaction.interaction_id, interaction.recommended_option_id,
           interaction.recommendation_rationale,
           json_extract(opened.payload_json, '$.continueWithDefault') AS continue_with_default,
           answer.verbatim_response, answer.created_at AS responded_at,
           json_extract(resolved.payload_json, '$.rationale') AS user_rationale
    FROM workflow_item_lifecycles lifecycle
    JOIN workflow_open_questions question
      ON question.lifecycle_id = lifecycle.lifecycle_id
     AND question.project_id = lifecycle.project_id
    JOIN workflow_domain_events opened
      ON opened.event_type = :opened_event
     AND json_extract(opened.payload_json, '$.questionId') = question.question_id
    JOIN workflow_interactions interaction
      ON interaction.question_id = question.question_id
     AND interaction.project_id = question.project_id
     AND interaction.sequence = 1
    LEFT JOIN workflow_answers answer
      ON answer.answer_id = question.accepted_answer_id
    LEFT JOIN workflow_domain_events resolved
      ON resolved.event_type = :resolved_event
     AND resolved.operation_id = answer.operation_id
    WHERE lifecycle.item_kind = 'task'
      AND lifecycle.milestone_id = :milestone_id
      AND lifecycle.slice_id = :slice_id
      AND lifecycle.task_id = :task_id
      AND question.question_status != 'withdrawn'
    ORDER BY question.created_project_revision DESC
    LIMIT 1
  `).get({
    ":opened_event": TASK_ESCALATION_OPENED_EVENT,
    ":resolved_event": TASK_ESCALATION_RESOLVED_EVENT,
    ":milestone_id": milestoneId,
    ":slice_id": sliceId,
    ":task_id": taskId,
  }) as Record<string, unknown> | undefined;
  if (!row) return null;
  const interactionId = String(row["interaction_id"]);
  const options = getDb().prepare(`
    SELECT option_id, label, description FROM workflow_interaction_options
    WHERE interaction_id = :interaction_id
    ORDER BY ordinal
  `).all({ ":interaction_id": interactionId }) as Array<Record<string, unknown>>;
  const responded = typeof row["verbatim_response"] === "string";
  return {
    questionId: String(row["question_id"]),
    interactionId,
    taskId,
    sliceId,
    milestoneId,
    question: String(row["question_text"]),
    options: options.map((option) => ({
      id: String(option["option_id"]),
      label: String(option["label"]),
      tradeoffs: String(option["description"]),
    })),
    recommendation: String(row["recommended_option_id"]),
    recommendationRationale: String(row["recommendation_rationale"]),
    continueWithDefault: Number(row["continue_with_default"]) === 1,
    createdAt: String(row["created_at"]),
    ...(responded ? {
      respondedAt: String(row["responded_at"]),
      userChoice: String(row["verbatim_response"]),
      userRationale: typeof row["user_rationale"] === "string" ? row["user_rationale"] : "",
    } : {}),
  };
}

// ─── Detection ────────────────────────────────────────────────────────────

/**
 * Returns the task id of the first task with an unresolved escalation.
 * `continueWithDefault=true` escalations keep the awaiting_review flag for
 * compatibility, but still pause dispatch until the user explicitly responds.
 */
export function detectPendingEscalation(tasks: TaskRow[]): string | null {
  for (const t of tasks) {
    if (t.escalation_pending !== 1 && t.escalation_awaiting_review !== 1) continue;
    const escalation = readTaskEscalation(t.milestone_id, t.slice_id, t.id);
    if (escalation && !escalation.respondedAt) return t.id;
  }
  return null;
}

// ─── Resolution ───────────────────────────────────────────────────────────

export interface ResolveEscalationResult {
  status: "resolved" | "not-found" | "already-resolved" | "invalid-choice" | "rejected-to-blocker";
  message: string;
  chosenOption?: EscalationOption;
}

/**
 * Apply a user response to a pending escalation in one
 * task.escalation.resolve Domain Operation:
 *  1) Store the response as the accepted Answer and close the question.
 *  2) Clear the task escalation flags.
 *  3) For "reject-blocker": set blocker_discovered=1 + blocker_source='reject-escalation'.
 * Then emit audit events.
 *
 * Note: this does NOT persist a decision via saveDecisionToDb — the caller
 * (commands/handlers/escalate.ts) owns that step so it can fail gracefully
 * and surface the decision id in the user-visible message.
 */
export function resolveEscalation(
  basePath: string, milestoneId: string, sliceId: string, taskId: string,
  choice: string, rationale: string,
): ResolveEscalationResult {
  const escalation = readTaskEscalation(milestoneId, sliceId, taskId);
  if (!escalation) {
    return { status: "not-found", message: `No escalation found for ${milestoneId}/${sliceId}/${taskId}.` };
  }
  if (escalation.respondedAt) {
    return { status: "already-resolved", message: `Escalation for ${taskId} was already resolved at ${escalation.respondedAt}.` };
  }

  // Resolve `choice` into a concrete option.
  let chosenOption: EscalationOption | undefined;
  if (choice === "accept") {
    chosenOption = escalation.options.find((o) => o.id === escalation.recommendation);
  } else if (choice !== "reject-blocker") {
    chosenOption = escalation.options.find((o) => o.id === choice);
    if (!chosenOption) {
      const valid = ["accept", "reject-blocker", ...escalation.options.map((o) => o.id)].join(", ");
      return { status: "invalid-choice", message: `Unknown choice "${choice}". Valid choices: ${valid}.` };
    }
  }

  const idempotencyKey = `escalation:resolve:${escalation.questionId}`;
  const fence = readDomainOperationFence(idempotencyKey);
  executeDomainOperation({
    operationType: "task.escalation.resolve",
    idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "user",
    sourceTransport: "internal",
    payload: { questionId: escalation.questionId, choice, rationale },
  }, (context) => {
    const { answerId } = answerTaskEscalationQuestion(context, {
      questionId: escalation.questionId,
      interactionId: escalation.interactionId,
      choice,
      selectedOptionId: chosenOption?.id ?? null,
      normalizedInterpretation: chosenOption
        ? `chose option ${chosenOption.id}: ${chosenOption.label}`
        : "rejected the escalation; replan the slice",
    });
    clearTaskEscalationFlags(milestoneId, sliceId, taskId);
    if (choice === "reject-blocker") {
      // Pre-dispatch plan-gate path, NOT a closeout (#2202): this only flags the
      // Task for replanning on the next auto pass. Closing a Task whose failed
      // Attempt is already parked at the route stage is the separate operator
      // disposition gsd_task_settle settleDisposition "blocker-accepted".
      setTaskBlockerSource(milestoneId, sliceId, taskId, "reject-escalation");
    }
    return {
      events: [{
        eventType: TASK_ESCALATION_RESOLVED_EVENT,
        entityType: "task",
        entityId: `${milestoneId}/${sliceId}/${taskId}`,
        payload: { questionId: escalation.questionId, answerId, choice, rationale },
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: `escalation/${milestoneId}/${sliceId}/${taskId}`.toLowerCase(),
        projectionKind: "state",
        rendererVersion: "1",
      }],
    };
  });

  if (choice === "reject-blocker") {
    emitUokAuditEvent(basePath, buildAuditEnvelope({
      traceId: `escalation:${milestoneId}:${sliceId}:${taskId}`,
      category: "gate",
      type: "escalation-rejected-to-blocker",
      payload: { milestoneId, sliceId, taskId, rationale },
    }));
    return {
      status: "rejected-to-blocker",
      message: `Escalation rejected. Task ${taskId} now flagged as a blocker — next /gsd auto will replan slice ${sliceId}.`,
    };
  }

  emitUokAuditEvent(basePath, buildAuditEnvelope({
    traceId: `escalation:${milestoneId}:${sliceId}:${taskId}`,
    category: "gate",
    type: "escalation-user-responded",
    payload: {
      milestoneId, sliceId, taskId,
      chosenOptionId: chosenOption?.id,
      rationale,
    },
  }));

  return {
    status: "resolved",
    message: `Escalation resolved. Next task in ${sliceId} will receive the override.`,
    chosenOption,
  };
}

// ─── Carry-forward lookup ─────────────────────────────────────────────────

/**
 * If this slice has a resolved-but-unapplied escalation override, atomically
 * claim it (via DB UPDATE) and return the markdown block to prepend to the
 * next task's prompt. Returns null when there's no unapplied override OR
 * when another caller claimed it first (idempotent).
 */
export function claimOverrideForInjection(
  milestoneId: string, sliceId: string,
): { injectionBlock: string; sourceTaskId: string } | null {
  const unapplied = findUnappliedEscalationOverride(milestoneId, sliceId);
  if (!unapplied) return null;
  const escalation = readTaskEscalation(milestoneId, sliceId, unapplied.taskId);
  if (!escalation?.respondedAt || !escalation.userChoice) return null;
  const claimed = claimEscalationOverride(milestoneId, sliceId, unapplied.taskId);
  if (!claimed) return null; // lost the race
  return {
    injectionBlock: formatOverrideBlock(escalation),
    sourceTaskId: unapplied.taskId,
  };
}

function formatOverrideBlock(art: EscalationArtifact): string {
  const isReject = art.userChoice === "reject-blocker";
  const isAccept = art.userChoice === "accept";
  const isOptionChoice = !!art.userChoice && !isReject && !isAccept;
  // Include the stable option id in the block so downstream prompts and
  // parsers have a machine-readable token, not just the display label.
  const choiceLabel = isReject
    ? "rejected — blocker path"
    : isAccept
      ? `accepted recommendation (${art.recommendation})`
      : isOptionChoice
        ? `${art.options.find((o) => o.id === art.userChoice)?.label ?? art.userChoice} (id: ${art.userChoice})`
        : (art.userChoice ?? "unknown");

  const tradeoffs = isOptionChoice
    ? art.options.find((o) => o.id === art.userChoice)?.tradeoffs ?? ""
    : "";

  const rationale = art.userRationale ? `\n\n**User rationale:** ${art.userRationale}` : "";

  return [
    `## Escalation Override (from ${art.taskId})`,
    "",
    `During ${art.taskId} the executor escalated: **${art.question}**`,
    "",
    `The user's resolution: **${choiceLabel}**.${rationale}`,
    tradeoffs ? `\n**Tradeoffs of this choice:** ${tradeoffs}` : "",
    "",
    "Apply this decision as a hard constraint for the current task. If it contradicts the task plan, surface the conflict in your summary rather than silently deviating.",
  ].filter((line) => line !== undefined).join("\n");
}

// ─── Display ──────────────────────────────────────────────────────────────

/** Human-readable summary of an artifact for `/gsd escalate show`. */
export function formatEscalationForDisplay(art: EscalationArtifact): string {
  const resolved = art.respondedAt
    ? `\nResolved: ${art.respondedAt} — user chose "${art.userChoice}"${art.userRationale ? ` (rationale: ${art.userRationale})` : ""}`
    : "\nStatus: awaiting user response";
  const optionLines = art.options.map((o) =>
    `  [${o.id}] ${o.label}${o.id === art.recommendation ? "  (recommended)" : ""}\n      ${o.tradeoffs}`,
  ).join("\n");
  return [
    `Task ${art.taskId} (slice ${art.sliceId})`,
    `continueWithDefault: ${art.continueWithDefault}`,
    `Question: ${art.question}`,
    "",
    "Options:",
    optionLines,
    "",
    `Recommendation: ${art.recommendation} — ${art.recommendationRationale}`,
    resolved,
    "",
    `Resolve with: /gsd escalate resolve ${art.taskId} <${art.options.map((o) => o.id).join("|")}|accept|reject-blocker> [rationale...]`,
  ].join("\n");
}

/** List actionable (unresolved) escalations for `/gsd escalate list`. */
export function listActionableEscalations(milestoneId: string): TaskRow[] {
  return listEscalationArtifacts(milestoneId, /* includeResolved */ false);
}

/** List every escalation (including resolved) for `/gsd escalate list --all`. */
export function listAllEscalations(milestoneId: string): TaskRow[] {
  return listEscalationArtifacts(milestoneId, /* includeResolved */ true);
}
