// Project/App: gsd-pi
// File Purpose: Conversation domain Work Checkpoint — the checkpoint.save
// Domain Operation and the reads that select the resume path.

import { getDb, getDbOrNull } from "./db/engine.js";
import { appendRecoveryWorkCheckpoint } from "./db/writers/task-recovery.js";
import { internalPlanningInvocation, type PlanningInvocation } from "./planning-invocation.js";
import { executeRecordDomainOperation } from "./record-domain-operation.js";

/** The kinds a resume checkpoint can have: a stop inside one session, or a stop for another session. */
export const RESUME_CHECKPOINT_KINDS = ["pause", "handoff"] as const;
export type ResumeCheckpointKind = (typeof RESUME_CHECKPOINT_KINDS)[number];

/** The work item a checkpoint belongs to: a milestone, a slice, or a task. */
export interface WorkCheckpointScope {
  milestoneId: string;
  sliceId?: string | null;
  taskId?: string | null;
}

export interface SaveWorkCheckpointParams extends WorkCheckpointScope {
  kind: ResumeCheckpointKind;
  /** What is done and confirmed. */
  confirmedContext: string;
  /** Remaining work and open questions. */
  unresolved?: string;
  /** Evidence for the confirmed context (commands, files, results). */
  evidence?: string;
  /** The one concrete action the next session takes first. */
  nextAction: string;
}

export interface WorkCheckpoint {
  checkpointId: string;
  kind: string;
  milestoneId: string;
  sliceId: string | null;
  taskId: string | null;
  confirmedContext: string;
  unresolvedSummary: string;
  evidenceSummary: string;
  suggestedNextAction: string;
  createdAt: string;
}

export type SaveWorkCheckpointResult = {
  checkpointId: string;
  sequence: number;
  milestoneId: string;
  sliceId: string | null;
  taskId: string | null;
};

function scopeEntity(scope: WorkCheckpointScope): string {
  return [scope.milestoneId, scope.sliceId, scope.taskId].filter(Boolean).join("/");
}

// Resume checkpoints have their own chain for each work item. The `task:` chain
// belongs to task recovery, which appends and reads its own heads.
function scopeKey(scope: WorkCheckpointScope): string {
  return `continue:${scopeEntity(scope)}`.toLowerCase();
}

function validate(params: SaveWorkCheckpointParams): SaveWorkCheckpointParams {
  const text = (value: unknown, field: string): string => {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
    return value.trim();
  };
  const milestoneId = text(params?.milestoneId, "milestoneId");
  const sliceId = params.sliceId ? text(params.sliceId, "sliceId") : null;
  const taskId = params.taskId ? text(params.taskId, "taskId") : null;
  if (taskId && !sliceId) throw new Error("sliceId is required when taskId is given");
  if (!RESUME_CHECKPOINT_KINDS.includes(params.kind)) {
    throw new Error(`kind must be one of: ${RESUME_CHECKPOINT_KINDS.join(", ")}`);
  }
  return {
    milestoneId,
    sliceId,
    taskId,
    kind: params.kind,
    confirmedContext: text(params.confirmedContext, "confirmedContext"),
    unresolved: params.unresolved?.trim() ?? "",
    evidence: params.evidence?.trim() ?? "",
    nextAction: text(params.nextAction, "nextAction"),
  };
}

/**
 * Save a Work Checkpoint through the checkpoint.save Domain Operation. The row
 * extends the checkpoint chain of the work item. A replay with the same
 * idempotency key writes nothing and returns the original result.
 */
export function saveWorkCheckpoint(
  rawParams: SaveWorkCheckpointParams,
  invocation: PlanningInvocation = internalPlanningInvocation(),
): SaveWorkCheckpointResult {
  const params = validate(rawParams);
  const entity = scopeEntity(params);
  return executeRecordDomainOperation<SaveWorkCheckpointResult>({
    operationType: "checkpoint.save",
    invocation,
    payload: params,
    eventType: "checkpoint.saved",
    entityType: "work-checkpoint",
    // The slice files hold the CONTINUE render of a slice or task checkpoint;
    // the milestone files hold the one of a milestone checkpoint.
    projectionKeys: [`planning/${[params.milestoneId, params.sliceId].filter(Boolean).join("/")}`.toLowerCase()],
    mutate: (context) => {
      const lifecycle = getDb().prepare(`
        SELECT lifecycle_id FROM workflow_item_lifecycles
        WHERE project_id = :project_id
          AND milestone_id = :milestone_id
          AND slice_id IS :slice_id
          AND task_id IS :task_id
      `).get({
        ":project_id": context.projectId,
        ":milestone_id": params.milestoneId,
        ":slice_id": params.sliceId ?? null,
        ":task_id": params.taskId ?? null,
      });
      if (typeof lifecycle?.["lifecycle_id"] !== "string") {
        throw new Error(`${entity} has no lifecycle row: plan it first, or run /gsd db adopt for a row from an older version`);
      }
      const stored = appendRecoveryWorkCheckpoint(context, {
        lifecycleId: lifecycle["lifecycle_id"],
        scopeKey: scopeKey(params),
        checkpointKind: params.kind,
        confirmedContext: params.confirmedContext,
        unresolvedSummary: params.unresolved ?? "",
        evidenceSummary: params.evidence ?? "",
        suggestedNextAction: params.nextAction,
      });
      return {
        entityId: entity,
        result: {
          checkpointId: stored.checkpointId,
          sequence: stored.sequence,
          milestoneId: params.milestoneId,
          sliceId: params.sliceId ?? null,
          taskId: params.taskId ?? null,
        },
      };
    },
  });
}

const CHECKPOINT_SELECT = `
  SELECT checkpoint.checkpoint_id, checkpoint.checkpoint_kind, checkpoint.confirmed_context,
         checkpoint.unresolved_summary, checkpoint.evidence_summary,
         checkpoint.suggested_next_action, checkpoint.created_at,
         lifecycle.milestone_id, lifecycle.slice_id, lifecycle.task_id
  FROM workflow_work_checkpoints checkpoint
  JOIN workflow_item_lifecycles lifecycle
    ON lifecycle.lifecycle_id = checkpoint.lifecycle_id
   AND lifecycle.project_id = checkpoint.project_id
`;

function rowToCheckpoint(row: Record<string, unknown> | undefined): WorkCheckpoint | null {
  if (!row) return null;
  return {
    checkpointId: String(row["checkpoint_id"]),
    kind: String(row["checkpoint_kind"]),
    milestoneId: String(row["milestone_id"]),
    sliceId: row["slice_id"] == null ? null : String(row["slice_id"]),
    taskId: row["task_id"] == null ? null : String(row["task_id"]),
    confirmedContext: String(row["confirmed_context"] ?? ""),
    unresolvedSummary: String(row["unresolved_summary"] ?? ""),
    evidenceSummary: String(row["evidence_summary"] ?? ""),
    suggestedNextAction: String(row["suggested_next_action"] ?? ""),
    createdAt: String(row["created_at"] ?? ""),
  };
}

/**
 * The event types that change the work of a milestone, slice or task. A
 * checkpoint saved before one of these events on its own item is superseded.
 * Every other event (Attempt, verification, recovery, dispatch) is bookkeeping.
 */
const WORK_CHANGE_EVENT_TYPES = [
  "workflow.milestone.planned",
  "workflow.roadmap.reassessed",
  "workflow.slice.planned",
  "workflow.slice.replanned",
  "workflow.task.planned",
  "workflow.task.replanned",
  "milestone.completed",
  "slice.completed",
  "task.completion.published",
  "milestone.discarded",
  "slice.cancelled",
  "task.cancelled",
  "milestone.reopened",
  "slice.reopened",
  "task.reopened",
] as const;

// A checkpoint is the resume state of its item only while the item is open and
// its work did not change after the save: no later work-change event of the
// item, and no later artifact save in the scope of the item.
const CURRENT_CHECKPOINT_FILTER = `
  AND lifecycle.lifecycle_status NOT IN ('completed', 'cancelled')
  AND NOT EXISTS (
    SELECT 1 FROM workflow_domain_events event
    WHERE event.project_id = checkpoint.project_id
      AND event.project_revision > checkpoint.project_revision
      AND (
        (event.entity_id = :entity
          AND event.event_type IN (${WORK_CHANGE_EVENT_TYPES.map((type) => `'${type}'`).join(", ")}))
        OR (event.event_type = 'artifact.saved' AND EXISTS (
          SELECT 1 FROM artifacts artifact
          WHERE artifact.path = event.entity_id
            AND artifact.milestone_id = lifecycle.milestone_id
            AND artifact.slice_id IS lifecycle.slice_id
            AND artifact.task_id IS lifecycle.task_id
        ))
      )
  )
`;

/**
 * The head resume checkpoint of one work item, or null when it has none or no
 * database is open. With `currentOnly`, a checkpoint of a closed item, or one
 * saved before the last change of the work of the item, is not returned.
 */
export function readWorkCheckpoint(
  scope: WorkCheckpointScope,
  options: { currentOnly?: boolean } = {},
): WorkCheckpoint | null {
  const db = getDbOrNull();
  if (!db) return null;
  return rowToCheckpoint(db.prepare(`
    ${CHECKPOINT_SELECT}
    WHERE checkpoint.scope_key = :scope_key
      ${options.currentOnly ? CURRENT_CHECKPOINT_FILTER : ""}
    ORDER BY checkpoint.sequence DESC
    LIMIT 1
  `).get({
    ":scope_key": scopeKey(scope),
    ...(options.currentOnly ? { ":entity": scopeEntity(scope) } : {}),
  }));
}

/** The newest resume checkpoint of a slice or of any of its tasks. The slice CONTINUE file renders this row. */
export function readLatestSliceWorkCheckpoint(milestoneId: string, sliceId: string): WorkCheckpoint | null {
  const db = getDbOrNull();
  if (!db) return null;
  const sliceKey = scopeKey({ milestoneId, sliceId });
  const taskPrefix = `${sliceKey}/`;
  return rowToCheckpoint(db.prepare(`
    ${CHECKPOINT_SELECT}
    WHERE checkpoint.scope_key = :slice_key
       OR substr(checkpoint.scope_key, 1, :prefix_length) = :task_prefix
    ORDER BY checkpoint.project_revision DESC
    LIMIT 1
  `).get({
    ":slice_key": sliceKey,
    ":task_prefix": taskPrefix,
    ":prefix_length": taskPrefix.length,
  }));
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function resumeSection(checkpoint: WorkCheckpoint | null, none: string): string {
  if (!checkpoint) return ["## Resume State", `- ${none}`].join("\n");
  const lines = [
    "## Resume State",
    `Source: Work Checkpoint of ${scopeEntity(checkpoint)} saved ${checkpoint.createdAt} (${checkpoint.kind})`,
    `- Completed: ${oneLine(checkpoint.confirmedContext)}`,
  ];
  if (checkpoint.unresolvedSummary) lines.push(`- Remaining: ${oneLine(checkpoint.unresolvedSummary)}`);
  if (checkpoint.evidenceSummary) lines.push(`- Evidence: ${oneLine(checkpoint.evidenceSummary)}`);
  lines.push(`- Next action: ${oneLine(checkpoint.suggestedNextAction)}`);
  return lines.join("\n");
}

/** The "Resume State" prompt section of one task, built from its head checkpoint row. */
export function buildResumeSection(milestoneId: string, sliceId: string, taskId: string): string {
  return resumeSection(
    readWorkCheckpoint({ milestoneId, sliceId, taskId }),
    "No Work Checkpoint saved for this task. Start from the top of the task plan.",
  );
}

/**
 * The "Resume State" of the active unit, for /gsd resume-work: the head
 * checkpoint of the active task, else of the active slice, else of the active
 * milestone. Only the own checkpoint of that one item counts, and only while
 * the item is open and its work did not change after the save (a work-change
 * event of the item or an artifact save in its scope).
 */
export function buildActiveResumeSection(active: Partial<WorkCheckpointScope>): string {
  const checkpoint = active.milestoneId
    ? readWorkCheckpoint({ milestoneId: active.milestoneId, sliceId: active.sliceId, taskId: active.taskId }, { currentOnly: true })
    : null;
  return resumeSection(
    checkpoint,
    "No Work Checkpoint saved for the active task, slice or milestone. Take the next step from the canonical state.",
  );
}

/** The markdown of the CONTINUE file that renders one checkpoint row. */
export function renderWorkCheckpointMarkdown(checkpoint: WorkCheckpoint): string {
  const entity = scopeEntity(checkpoint);
  const section = (title: string, body: string): string[] => (body ? ["", `## ${title}`, "", body] : []);
  return [
    `# Work Checkpoint — ${entity}`,
    "",
    `**Kind:** ${checkpoint.kind}`,
    `**Saved:** ${checkpoint.createdAt}`,
    ...section("Confirmed Context", checkpoint.confirmedContext),
    ...section("Unresolved", checkpoint.unresolvedSummary),
    ...section("Evidence", checkpoint.evidenceSummary),
    ...section("Next Action", checkpoint.suggestedNextAction),
    "",
  ].join("\n");
}
