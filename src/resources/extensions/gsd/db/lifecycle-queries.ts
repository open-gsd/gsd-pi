// Project/App: gsd-pi
// File Purpose: Read queries on the canonical lifecycle tables (and the
// workflow tables joined to them) that decision and report code outside db/
// asks. Each function is the SQL and its row shape only; the decision that
// reads the answer stays at the call site. Writes never live here — the
// Single Writer owns them in db/writers/ (tests/single-writer-invariant.test.ts).

import type { DbAdapter } from "../db-adapter.js";
import { getDb } from "./engine.js";

/** rule-registry.ts — the legacy row and the lifecycle head of one completed Task. */
export interface TaskCompletionIdentityRow {
  status: string;
  completed_at: string | null;
  lifecycle_status: string | null;
  last_operation_id: string | null;
}

export function getTaskCompletionIdentity(
  milestoneId: string,
  sliceId: string,
  taskId: string,
): TaskCompletionIdentityRow | null {
  const row = getDb().prepare(`
    SELECT task.status, task.completed_at,
           lifecycle.lifecycle_status, lifecycle.last_operation_id
    FROM tasks task
    LEFT JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.item_kind = 'task'
     AND lifecycle.milestone_id = task.milestone_id
     AND lifecycle.slice_id = task.slice_id
     AND lifecycle.task_id = task.id
    WHERE task.milestone_id = :milestone_id
      AND task.slice_id = :slice_id
      AND task.id = :task_id
  `).get({
    ":milestone_id": milestoneId,
    ":slice_id": sliceId,
    ":task_id": taskId,
  }) as TaskCompletionIdentityRow | undefined;
  return row ?? null;
}

/** undo.ts — the legacy row and the lifecycle head of one Task. */
export interface UndoTaskStateRow {
  legacy_status: string;
  completed_at: string | null;
  lifecycle_id: string | null;
  lifecycle_status: string | null;
  lifecycle_operation_id: string | null;
}

export function getUndoTaskStateRow(
  milestoneId: string,
  sliceId: string,
  taskId: string,
): UndoTaskStateRow | null {
  const row = getDb().prepare(`
    SELECT task.status AS legacy_status,
           task.completed_at,
           lifecycle.lifecycle_id,
           lifecycle.lifecycle_status,
           lifecycle.last_operation_id AS lifecycle_operation_id
    FROM tasks task
    LEFT JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.item_kind = 'task'
     AND lifecycle.milestone_id = task.milestone_id
     AND lifecycle.slice_id = task.slice_id
     AND lifecycle.task_id = task.id
    WHERE task.milestone_id = :milestone_id
      AND task.slice_id = :slice_id
      AND task.id = :task_id
  `).get({
    ":milestone_id": milestoneId,
    ":slice_id": sliceId,
    ":task_id": taskId,
  }) as UndoTaskStateRow | undefined;
  return row ?? null;
}

/** undo.ts — what the lifecycle head of one Slice says about its last reopen. */
export interface SliceReopenOperationRow {
  lifecycle_status: string | null;
  last_operation_id: string | null;
  operation_type: string | null;
  idempotency_key: string | null;
  payload_json: string | null;
}

export function getSliceReopenOperationRow(
  milestoneId: string,
  sliceId: string,
): SliceReopenOperationRow | null {
  const row = getDb().prepare(`
    SELECT lifecycle.lifecycle_status, lifecycle.last_operation_id,
           operation.operation_type, operation.idempotency_key, event.payload_json
    FROM workflow_item_lifecycles lifecycle
    LEFT JOIN workflow_operations operation
      ON operation.operation_id = lifecycle.last_operation_id
    LEFT JOIN workflow_domain_events event
      ON event.operation_id = operation.operation_id
     AND event.event_type = 'slice.reopened'
    WHERE lifecycle.item_kind = 'slice'
      AND lifecycle.milestone_id = :milestone_id
      AND lifecycle.slice_id = :slice_id
      AND lifecycle.task_id IS NULL
  `).get({
    ":milestone_id": milestoneId,
    ":slice_id": sliceId,
  }) as SliceReopenOperationRow | undefined;
  return row ?? null;
}

/** undo.ts — the lifecycle head operation id of a Slice or a Milestone. */
export function getLifecycleLastOperationId(
  itemKind: "slice" | "milestone",
  milestoneId: string,
  sliceId: string | null,
): string | null {
  const row = getDb().prepare(`
    SELECT last_operation_id FROM workflow_item_lifecycles
    WHERE item_kind = :item_kind AND milestone_id = :milestone_id
      AND slice_id IS :slice_id AND task_id IS NULL
  `).get({ ":item_kind": itemKind, ":milestone_id": milestoneId, ":slice_id": sliceId }) as
    | { last_operation_id?: string }
    | undefined;
  return row?.["last_operation_id"] ? String(row["last_operation_id"]) : null;
}

/**
 * tools/reopen-slice.ts — the canonical lifecycle status of one Milestone.
 * Undefined when the Milestone has no row, null when it has no lifecycle row.
 */
export function getMilestoneCanonicalLifecycleStatus(milestoneId: string): string | null | undefined {
  const row = getDb().prepare(`
    SELECT lifecycle.lifecycle_status AS status
    FROM milestones milestone
    LEFT JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.project_id = (SELECT project_id FROM project_authority WHERE singleton = 1)
     AND lifecycle.item_kind = 'milestone'
     AND lifecycle.milestone_id = milestone.id
     AND lifecycle.slice_id IS NULL
    WHERE milestone.id = :milestone_id
  `).get({ ":milestone_id": milestoneId }) as { status: string | null } | undefined;
  return row?.["status"];
}

/** auto-post-unit.ts — the lifecycle head of one Task. */
export interface TaskLifecycleHeadRow {
  lifecycle_status: string;
  last_operation_id: string;
}

export function getTaskLifecycleHead(
  milestoneId: string,
  sliceId: string,
  taskId: string,
): TaskLifecycleHeadRow | undefined {
  return getDb().prepare(`
    SELECT lifecycle_status, last_operation_id
    FROM workflow_item_lifecycles
    WHERE item_kind = 'task'
      AND milestone_id = :milestone_id
      AND slice_id = :slice_id
      AND task_id = :task_id
  `).get({
    ":milestone_id": milestoneId,
    ":slice_id": sliceId,
    ":task_id": taskId,
  }) as TaskLifecycleHeadRow | undefined;
}

/** auto-post-unit.ts — the operation an idempotency key already names, if any. */
export function getOperationIdByIdempotencyKey(idempotencyKey: string): string | null {
  const row = getDb().prepare(`
    SELECT operation_id
    FROM workflow_operations
    WHERE idempotency_key = :idempotency_key
  `).get({ ":idempotency_key": idempotencyKey }) as { operation_id?: string } | undefined;
  return typeof row?.["operation_id"] === "string" ? row["operation_id"] : null;
}

/** Whether one Task has a canonical lifecycle row (escalation.ts, task-settle.ts). */
export function hasTaskLifecycleRow(
  milestoneId: string,
  sliceId: string,
  taskId: string,
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

/** escalation.ts — the legacy artifact of the latest resolved escalation event. */
export function getLatestLegacyResolutionPayload(
  entityId: string,
  resolvedEvent: string,
): string | null {
  const row = getDb().prepare(`
    SELECT json_extract(event.payload_json, '$.legacy') AS legacy
    FROM project_authority authority
    CROSS JOIN workflow_domain_events event
      ON event.project_id = authority.project_id
     AND event.entity_type = 'task'
     AND event.entity_id = :entity_id
     AND event.event_type = :resolved_event
     AND json_extract(event.payload_json, '$.legacy') IS NOT NULL
    ORDER BY event.project_revision DESC
    LIMIT 1
  `).get({
    ":entity_id": entityId,
    ":resolved_event": resolvedEvent,
  }) as { legacy?: string } | undefined;
  return typeof row?.["legacy"] === "string" ? row["legacy"] : null;
}

/** escalation.ts — the escalation question of one Task, its interaction and answer. */
export function getTaskEscalationQuestionRow(params: {
  milestoneId: string;
  sliceId: string;
  taskId: string;
  openedEvent: string;
  resolvedEvent: string;
}): Record<string, unknown> | undefined {
  return getDb().prepare(`
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
    CROSS JOIN workflow_domain_events opened
      ON opened.project_id = lifecycle.project_id
     AND opened.entity_type = 'task'
     AND opened.entity_id = lifecycle.milestone_id || '/' || lifecycle.slice_id || '/' || lifecycle.task_id
     AND opened.event_type = :opened_event
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
    ":opened_event": params.openedEvent,
    ":resolved_event": params.resolvedEvent,
    ":milestone_id": params.milestoneId,
    ":slice_id": params.sliceId,
    ":task_id": params.taskId,
  }) as Record<string, unknown> | undefined;
}

/** escalation.ts — the options of one interaction, in ordinal order. */
export function listInteractionOptions(interactionId: string): Array<Record<string, unknown>> {
  return getDb().prepare(`
    SELECT option_id, label, description FROM workflow_interaction_options
    WHERE interaction_id = :interaction_id
    ORDER BY ordinal
  `).all({ ":interaction_id": interactionId }) as Array<Record<string, unknown>>;
}

/** escalation-resolution.ts — every open task escalation question, oldest first. */
export function listOpenTaskEscalationQuestionRows(openedEvent: string): Array<Record<string, unknown>> {
  return getDb().prepare(`
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
  `).all({ ":opened_event": openedEvent }) as Array<Record<string, unknown>>;
}

/** milestone-actions.ts — every hierarchy row the discard of one Milestone cancels. */
export interface DiscardRow {
  slice_id: string | null;
  task_id: string | null;
  status: string;
  lifecycle_status: string | null;
}

export function getDiscardRows(milestoneId: string): DiscardRow[] {
  const lifecycleJoin = (kind: string, slice: string, task: string) => `
    LEFT JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.item_kind = '${kind}'
     AND lifecycle.milestone_id = :milestone_id
     AND lifecycle.slice_id IS ${slice}
     AND lifecycle.task_id IS ${task}`;
  return getDb().prepare(`
    SELECT task.slice_id, task.id AS task_id, task.status, lifecycle.lifecycle_status
    FROM tasks task ${lifecycleJoin("task", "task.slice_id", "task.id")}
    WHERE task.milestone_id = :milestone_id
    UNION ALL
    SELECT slice.id, NULL, slice.status, lifecycle.lifecycle_status
    FROM slices slice ${lifecycleJoin("slice", "slice.id", "NULL")}
    WHERE slice.milestone_id = :milestone_id
    UNION ALL
    SELECT NULL, NULL, milestone.status, lifecycle.lifecycle_status
    FROM milestones milestone ${lifecycleJoin("milestone", "NULL", "NULL")}
    WHERE milestone.id = :milestone_id
  `).all({ ":milestone_id": milestoneId }) as unknown as DiscardRow[];
}

/** reopen-reason.ts — the latest task.reopened diagnosis no Attempt has answered. */
export function getLatestPendingReopenEventRow(
  milestoneId: string,
  sliceId: string,
  taskId: string,
): { payload_json: string } | undefined {
  return getDb().prepare(`
    SELECT event.payload_json
    FROM workflow_domain_events event
    WHERE event.event_type = 'task.reopened'
      AND event.entity_type = 'task'
      AND event.entity_id = :entity_id
      AND NOT EXISTS (
        SELECT 1
        FROM workflow_item_lifecycles lifecycle
        JOIN workflow_execution_attempts attempt
          ON attempt.lifecycle_id = lifecycle.lifecycle_id
         AND attempt.project_id = lifecycle.project_id
        WHERE lifecycle.item_kind = 'task'
          AND lifecycle.project_id = event.project_id
          AND lifecycle.milestone_id = :milestone_id
          AND lifecycle.slice_id = :slice_id
          AND lifecycle.task_id = :task_id
          AND attempt.claim_project_revision > event.project_revision
      )
    ORDER BY event.project_revision DESC
    LIMIT 1
  `).get({
    ":entity_id": `${milestoneId}/${sliceId}/${taskId}`,
    ":milestone_id": milestoneId,
    ":slice_id": sliceId,
    ":task_id": taskId,
  }) as { payload_json: string } | undefined;
}

/** task-settle.ts — a running Attempt of one Task and its lease identity. */
export interface RunningTaskAttemptRow {
  attempt_id: string;
  worker_id: string | null;
  milestone_lease_token: number | null;
}

export function listRunningTaskAttempts(
  milestoneId: string,
  sliceId: string,
  taskId: string,
): RunningTaskAttemptRow[] {
  return getDb().prepare(`
    SELECT attempt.attempt_id, attempt.worker_id, attempt.milestone_lease_token
    FROM workflow_item_lifecycles lifecycle
    JOIN workflow_execution_attempts attempt
      ON attempt.lifecycle_id = lifecycle.lifecycle_id
     AND attempt.project_id = lifecycle.project_id
    WHERE lifecycle.item_kind = 'task'
      AND lifecycle.milestone_id = :milestone_id
      AND lifecycle.slice_id = :slice_id
      AND lifecycle.task_id = :task_id
      AND attempt.attempt_state = 'running'
    ORDER BY attempt.attempt_number DESC
  `).all({
    ":milestone_id": milestoneId,
    ":slice_id": sliceId,
    ":task_id": taskId,
  }) as unknown as RunningTaskAttemptRow[];
}

/** task-settle.ts — the legacy status and the lifecycle status of one Task. */
export function getTaskLegacyAndLifecycleStatus(
  milestoneId: string,
  sliceId: string,
  taskId: string,
): { task_status: string; lifecycle_status: string | null } | undefined {
  return getDb().prepare(`
    SELECT task.status AS task_status, lifecycle.lifecycle_status
    FROM tasks task
    LEFT JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.item_kind = 'task'
     AND lifecycle.milestone_id = task.milestone_id
     AND lifecycle.slice_id = task.slice_id
     AND lifecycle.task_id = task.id
    WHERE task.milestone_id = :milestone_id
      AND task.slice_id = :slice_id
      AND task.id = :task_id
  `).get({
    ":milestone_id": milestoneId,
    ":slice_id": sliceId,
    ":task_id": taskId,
  }) as { task_status: string; lifecycle_status: string | null } | undefined;
}

/** task-settle.ts — the newest settled Attempt whose Technical Verdict passed with evidence. */
export function getPassingProofAttemptId(
  milestoneId: string,
  sliceId: string,
  taskId: string,
): string | null {
  const row = getDb().prepare(`
    SELECT attempt.attempt_id
    FROM workflow_item_lifecycles lifecycle
    JOIN workflow_execution_attempts attempt
      ON attempt.lifecycle_id = lifecycle.lifecycle_id
     AND attempt.project_id = lifecycle.project_id
     AND attempt.attempt_state = 'settled'
    JOIN workflow_attempt_results result
      ON result.attempt_id = attempt.attempt_id
     AND result.lifecycle_id = lifecycle.lifecycle_id
     AND result.outcome = 'succeeded'
    JOIN workflow_acceptance_criteria criterion
      ON criterion.lifecycle_id = lifecycle.lifecycle_id
     AND criterion.criterion_key = 'host-technical-verification'
     AND NOT EXISTS (
       SELECT 1 FROM workflow_acceptance_criteria successor
       WHERE successor.supersedes_criterion_id = criterion.criterion_id
     )
    JOIN workflow_technical_verdicts verdict
      ON verdict.criterion_id = criterion.criterion_id
     AND verdict.attempt_id = attempt.attempt_id
     AND verdict.verdict = 'pass'
     AND NOT EXISTS (
       SELECT 1 FROM workflow_technical_verdicts successor
       WHERE successor.supersedes_verdict_id = verdict.verdict_id
     )
    JOIN workflow_verification_evidence evidence
      ON evidence.verdict_id = verdict.verdict_id
     AND evidence.attempt_id = attempt.attempt_id
     AND evidence.observation = 'passed'
    WHERE lifecycle.item_kind = 'task'
      AND lifecycle.milestone_id = :milestone_id
      AND lifecycle.slice_id = :slice_id
      AND lifecycle.task_id = :task_id
    ORDER BY attempt.attempt_number DESC
    LIMIT 1
  `).get({
    ":milestone_id": milestoneId,
    ":slice_id": sliceId,
    ":task_id": taskId,
  }) as { attempt_id?: string } | undefined;
  return row?.attempt_id ? String(row.attempt_id) : null;
}

/** task-settle.ts — the verification-pause events of one Task, newest first. */
export function listVerificationPauseEventRows(
  entityId: string,
  eventType: string,
): Array<{ created_at: string; payload_json: string }> {
  return getDb().prepare(`
    SELECT created_at, payload_json
    FROM workflow_domain_events
    WHERE event_type = :event_type
      AND entity_type = 'task'
      AND entity_id = :entity_id
    ORDER BY project_revision DESC, event_index DESC
  `).all({
    ":event_type": eventType,
    ":entity_id": entityId,
  }) as Array<{ created_at: string; payload_json: string }>;
}

/** task-settle.ts — when an Attempt got its Result. */
export function getAttemptResultCreatedAt(attemptId: string): string | null {
  const row = getDb().prepare(`
    SELECT created_at FROM workflow_attempt_results WHERE attempt_id = :attempt_id
  `).get({ ":attempt_id": attemptId }) as { created_at?: string } | undefined;
  return typeof row?.["created_at"] === "string" ? row["created_at"] : null;
}

/** task-settle.ts — the route head (the last kernel checkpoint) of one Task. */
export interface TaskRouteHeadRow {
  kernel_checkpoint_id: string;
  lifecycle_id: string;
  attempt_id: string;
  next_stage: string;
}

export function getTaskRouteHead(
  milestoneId: string,
  sliceId: string,
  taskId: string,
): TaskRouteHeadRow | null {
  return (getDb().prepare(`
    SELECT head.kernel_checkpoint_id, head.lifecycle_id, head.attempt_id, head.next_stage
    FROM workflow_kernel_checkpoints head
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.lifecycle_id = head.lifecycle_id
     AND lifecycle.project_id = head.project_id
    WHERE lifecycle.item_kind = 'task'
      AND lifecycle.milestone_id = :milestone_id
      AND lifecycle.slice_id = :slice_id
      AND lifecycle.task_id = :task_id
      AND NOT EXISTS (
        SELECT 1 FROM workflow_kernel_checkpoints successor
        WHERE successor.previous_kernel_checkpoint_id = head.kernel_checkpoint_id
      )
  `).get({
    ":milestone_id": milestoneId,
    ":slice_id": sliceId,
    ":task_id": taskId,
  }) ?? null) as TaskRouteHeadRow | null;
}

/** doctor-engine-checks.ts — every running Attempt of a Task, with its scope. */
export interface DoctorRunningAttemptRow {
  attempt_id: string;
  worker_id: string | null;
  milestone_lease_token: number | null;
  milestone_id: string;
  slice_id: string;
  task_id: string;
}

export function listOrphanableRunningAttempts(db: DbAdapter): DoctorRunningAttemptRow[] {
  return db.prepare(`
    SELECT attempt.attempt_id, attempt.worker_id, attempt.milestone_lease_token,
           lifecycle.milestone_id, lifecycle.slice_id, lifecycle.task_id
    FROM workflow_execution_attempts attempt
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.lifecycle_id = attempt.lifecycle_id
     AND lifecycle.project_id = attempt.project_id
    WHERE attempt.attempt_state = 'running'
      AND lifecycle.item_kind = 'task'
  `).all() as unknown as DoctorRunningAttemptRow[];
}

/** doctor-engine-checks.ts — the settled succeeded Attempts never published. */
export function listUnpublishedSucceededAttempts(db: DbAdapter): Array<{
  attempt_id: string;
  lifecycle_status: string;
  legacy_status: string;
  milestone_id: string;
  slice_id: string;
  task_id: string;
}> {
  return db.prepare(`
    SELECT attempt.attempt_id, lifecycle.lifecycle_status,
           COALESCE(tasks.status, '') AS legacy_status,
           lifecycle.milestone_id, lifecycle.slice_id, lifecycle.task_id
    FROM workflow_execution_attempts attempt
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.lifecycle_id = attempt.lifecycle_id
     AND lifecycle.project_id = attempt.project_id
    JOIN workflow_attempt_results result
      ON result.attempt_id = attempt.attempt_id
     AND result.lifecycle_id = attempt.lifecycle_id
     AND result.project_id = attempt.project_id
    JOIN workflow_kernel_checkpoints checkpoint
      ON checkpoint.attempt_id = attempt.attempt_id
     AND checkpoint.project_id = attempt.project_id
    LEFT JOIN tasks
      ON tasks.milestone_id = lifecycle.milestone_id
     AND tasks.slice_id = lifecycle.slice_id
     AND tasks.id = lifecycle.task_id
    WHERE lifecycle.item_kind = 'task'
      AND attempt.attempt_state = 'settled'
      AND result.outcome = 'succeeded'
      AND checkpoint.next_stage = 'verify'
      AND attempt.attempt_number = (
        SELECT MAX(latest.attempt_number)
        FROM workflow_execution_attempts latest
        WHERE latest.lifecycle_id = attempt.lifecycle_id
          AND latest.project_id = attempt.project_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM workflow_kernel_checkpoints successor
        WHERE successor.previous_kernel_checkpoint_id = checkpoint.kernel_checkpoint_id
      )
      AND lifecycle.lifecycle_status NOT IN ('completed', 'cancelled', 'blocker-accepted')
  `).all() as Array<{
    attempt_id: string;
    lifecycle_status: string;
    legacy_status: string;
    milestone_id: string;
    slice_id: string;
    task_id: string;
  }>;
}

/**
 * state-reconciliation/drift/artifact-db.ts — whether one Task ran before it
 * returned to pending, or its lifecycle head is an explicit reopen.
 */
export function hasTaskExecutionOrReopenHistory(
  milestoneId: string,
  sliceId: string,
  taskId: string,
): boolean {
  const row = getDb().prepare(`
    SELECT 1 AS present
    FROM workflow_item_lifecycles lifecycle
    WHERE lifecycle.item_kind = 'task'
      AND lifecycle.milestone_id = :milestone_id
      AND lifecycle.slice_id = :slice_id
      AND lifecycle.task_id = :task_id
      AND (
        EXISTS (
          SELECT 1 FROM workflow_execution_attempts attempt
          WHERE attempt.lifecycle_id = lifecycle.lifecycle_id
            AND attempt.project_id = lifecycle.project_id
        )
        OR (
          lifecycle.lifecycle_status = 'ready'
          AND EXISTS (
            SELECT 1 FROM workflow_domain_events reopened
            WHERE reopened.project_id = lifecycle.project_id
              AND reopened.operation_id = lifecycle.last_operation_id
              AND reopened.event_type = 'task.reopened'
              AND reopened.entity_type = 'task'
              AND reopened.entity_id = :entity_id
          )
        )
      )
    LIMIT 1
  `).get({
    ":milestone_id": milestoneId,
    ":slice_id": sliceId,
    ":task_id": taskId,
    ":entity_id": `${milestoneId}/${sliceId}/${taskId}`,
  });
  return row !== undefined;
}

/**
 * state-reconciliation/drift/artifact-db.ts — whether a Slice's current
 * lifecycle head is an explicit reopen. Mirrors
 * hasTaskExecutionOrReopenHistory's reopen branch at the slice level: a
 * completed-then-reopened slice keeps its orphaned SUMMARY artifact row (the
 * reopen clears slices.full_summary_md and quarantines the file but does not
 * delete the artifacts row), and that row must not wedge the reopened
 * slice's re-execution.
 */
export function hasSliceReopenHistory(milestoneId: string, sliceId: string): boolean {
  const row = getDb().prepare(`
    SELECT 1 AS present
    FROM workflow_domain_events reopened
    WHERE reopened.event_type = 'slice.reopened'
      AND reopened.entity_type = 'slice'
      AND reopened.entity_id = :entity_id
    LIMIT 1
  `).get({ ":entity_id": `${milestoneId}/${sliceId}` });
  return row !== undefined;
}

/**
 * bootstrap/dynamic-tools.ts — the Milestone a recovery action belongs to.
 * The caller owns the connection: the tool resolves it for an arbitrary
 * project root through an isolated database, not the open project database.
 */
export function getRecoveryActionMilestoneId(db: DbAdapter, recoveryActionId: string): string | null {
  const row = db.prepare(`
    SELECT lifecycle.milestone_id
    FROM workflow_recovery_actions action
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.project_id = action.project_id
     AND lifecycle.lifecycle_id = action.lifecycle_id
    WHERE action.recovery_action_id = :recovery_action_id
  `).get({ ":recovery_action_id": recoveryActionId });
  return typeof row?.["milestone_id"] === "string" ? row["milestone_id"] : null;
}

/**
 * tools/complete-slice.ts — the payload of the newest slice.completed event of
 * one Slice. The caller owns which operation wins: `where` and `bindings`
 * carry the idempotency-key match of the retrying invocation, or `1 = 1` with
 * no bindings for the newest event of any operation.
 */
export function getSliceCompletedEventPayloadRow(
  entityId: string,
  where: string,
  bindings: Record<string, string>,
): Record<string, unknown> | undefined {
  return getDb().prepare(`
    SELECT event.payload_json
    FROM workflow_domain_events event
    JOIN workflow_operations operation ON operation.operation_id = event.operation_id
    WHERE event.event_type = 'slice.completed'
      AND event.entity_type = 'slice'
      AND event.entity_id = :entity_id
      AND ${where}
    ORDER BY event.project_revision DESC
    LIMIT 1
  `).get({
    ":entity_id": entityId,
    ...bindings,
  }) as Record<string, unknown> | undefined;
}
