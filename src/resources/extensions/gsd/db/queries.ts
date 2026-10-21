// Project/App: gsd-pi
// File Purpose: Query Module — the read-only seam of the DB layer.
// SELECT-only wrappers, read through the shared engine handle (getDbOrNull()).
// Contains NO write SQL (asserted by tests/single-writer-invariant.test.ts).
// Read-only callers (forensics, dashboard, doctor) depend on this seam, not on
// the single-writer surface.
import { createHash } from "node:crypto";

import { getDbOrNull, readTransaction } from "./engine.js";
import { isClosedStatus } from "../status-guards.js";
import { getGateIdsForTurn, type OwnerTurn } from "../gate-registry.js";
import type { Decision, Requirement, GateRow, GateScope } from "../types.js";
import {
  emptyTaskStatusCounts,
  rowToActiveTaskSummary,
  rowToIdStatusSummary,
  rowToTaskStatusCounts,
  rowsToStringColumn,
  type ActiveTaskSummary,
  type IdStatusSummary,
  type TaskStatusCounts,
} from "../db-lightweight-query-rows.js";
import {
  rowToActiveDecision,
  rowToActiveRequirement,
  rowToDecision,
  rowToRequirement,
  rowsToRequirementCounts,
} from "../db-decision-requirement-rows.js";
import { rowToGate } from "../db-gate-rows.js";
import { rowToArtifact, rowToMilestone, type ArtifactRow, type MilestoneRow } from "../db-milestone-artifact-rows.js";
import { rowToSlice, rowToTask, type SliceRow, type TaskRow } from "../db-task-slice-rows.js";
import { TERMINAL_STATUS_SQL } from "./sql-constants.js";
import {
  compareLifecycleShadow,
  normalizeCanonicalLifecycleStatus,
  normalizeLegacyLifecycleStatus,
  type CanonicalLifecycleStatus,
  type LifecycleShadowComparison,
} from "./lifecycle-shadow-comparison.js";
import {
  lifecycleShadowObservationItem,
  type LifecycleShadowObservationSnapshot,
} from "../lifecycle-shadow-observation.js";


function parseStringArrayColumn(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((entry): entry is string => typeof entry === "string");
  if (typeof raw !== "string") return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.filter((entry): entry is string => typeof entry === "string");
    if (typeof parsed === "string") return [parsed];
  } catch {
    return trimmed.split(",");
  }
  return [];
}

function normalizeRepoPath(file: string): string {
  return file.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
}

export interface HierarchyCompletionCounts {
  milestones: number;
  milestonesTotal: number;
  slices: number;
  slicesTotal: number;
  tasks: number;
  tasksTotal: number;
}

export interface MilestoneStatusCounts {
  total: number;
  done: number;
  active: number;
  pending: number;
  parked: number;
}

export interface ProjectAuthorityVersion {
  revision: number;
  authorityEpoch: number;
}

function numberColumn(row: Record<string, unknown> | undefined, column: string): number {
  const value = row?.[column];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function getCompletionCount(table: "milestones" | "slices" | "tasks"): { completed: number; total: number } {
  const row = getDbOrNull()!.prepare(
    `SELECT
       COUNT(*) AS total,
       COALESCE(SUM(CASE WHEN status IN (${TERMINAL_STATUS_SQL}) THEN 1 ELSE 0 END), 0) AS completed
     FROM ${table}`,
  ).get();

  return {
    completed: numberColumn(row, "completed"),
    total: numberColumn(row, "total"),
  };
}

export function getProjectAuthorityVersion(): ProjectAuthorityVersion {
  const db = getDbOrNull();
  if (!db) throw new Error("GSD database is not available");

  const row = db.prepare(
    "SELECT revision, authority_epoch FROM project_authority WHERE singleton = 1",
  ).get();
  if (!row) throw new Error("GSD project authority row is not available");

  return {
    revision: numberColumn(row, "revision"),
    authorityEpoch: numberColumn(row, "authority_epoch"),
  };
}

export interface ProjectAuthorityRow {
  projectId: string;
  revision: number;
  authorityEpoch: number;
}

/** Full project_authority singleton read (null when no row / no DB open). */
export function getProjectAuthorityRow(): ProjectAuthorityRow | null {
  const db = getDbOrNull();
  if (!db) return null;
  const row = db.prepare(
    "SELECT project_id, revision, authority_epoch FROM project_authority WHERE singleton = 1",
  ).get();
  if (!row) return null;
  return {
    projectId: String(row["project_id"] ?? ""),
    revision: numberColumn(row, "revision"),
    authorityEpoch: numberColumn(row, "authority_epoch"),
  };
}

export interface OpenBlockerRow {
  blockerId: string;
  blockerKind: string;
  resolutionOwner: string;
  description: string;
  requestedAction: string;
  openedAt: string;
  openedProjectRevision: number;
}

/** Open workflow blockers, oldest first (issue #2102 snapshot read). */
export function getOpenBlockers(): OpenBlockerRow[] {
  const db = getDbOrNull();
  if (!db) return [];
  const rows = db.prepare(
    `SELECT blocker_id, blocker_kind, resolution_owner, description, requested_action,
            opened_at, opened_project_revision
       FROM workflow_blockers
      WHERE blocker_status = 'open'
      ORDER BY opened_project_revision, blocker_id`,
  ).all();
  return rows.map((row) => ({
    blockerId: String(row["blocker_id"] ?? ""),
    blockerKind: String(row["blocker_kind"] ?? ""),
    resolutionOwner: String(row["resolution_owner"] ?? ""),
    description: String(row["description"] ?? ""),
    requestedAction: String(row["requested_action"] ?? ""),
    openedAt: String(row["opened_at"] ?? ""),
    openedProjectRevision: numberColumn(row, "opened_project_revision"),
  }));
}

export interface OpenQuestionRow {
  questionId: string;
  questionText: string;
  createdAt: string;
}

/** Open workflow questions, creation order (issue #2102 snapshot read). */
export function getOpenQuestions(): OpenQuestionRow[] {
  const db = getDbOrNull();
  if (!db) return [];
  const rows = db.prepare(
    `SELECT question_id, question_text, created_at
       FROM workflow_open_questions
      WHERE question_status = 'open'
      ORDER BY created_at, question_id`,
  ).all();
  return rows.map((row) => ({
    questionId: String(row["question_id"] ?? ""),
    questionText: String(row["question_text"] ?? ""),
    createdAt: String(row["created_at"] ?? ""),
  }));
}

/** Max applied migration version from the schema_version table (null when absent). */
export function getSchemaVersion(): number | null {
  const db = getDbOrNull();
  if (!db) return null;
  const row = db.prepare("SELECT MAX(version) AS version FROM schema_version").get();
  if (!row || row["version"] === null || row["version"] === undefined) return null;
  return numberColumn(row, "version");
}

export interface VerificationSummaryCounts {
  assessments: { total: number; pass: number; fail: number };
  evidence: { total: number; passed: number; failed: number };
}

/**
 * Project-wide verification summary (issue #2102 snapshot read): assessment
 * status counts plus verification_evidence verdict counts.
 */
export function getVerificationSummary(): VerificationSummaryCounts {
  const db = getDbOrNull();
  if (!db) return { assessments: { total: 0, pass: 0, fail: 0 }, evidence: { total: 0, passed: 0, failed: 0 } };

  const assessmentRows = db.prepare(
    "SELECT lower(status) AS status, COUNT(*) AS count FROM assessments GROUP BY lower(status)",
  ).all();
  const assessments = { total: 0, pass: 0, fail: 0 };
  for (const row of assessmentRows) {
    const count = numberColumn(row, "count");
    assessments.total += count;
    const status = String(row["status"] ?? "");
    if (status === "pass" || status === "passed") assessments.pass += count;
    else if (status === "fail" || status === "failed") assessments.fail += count;
  }

  const evidenceRows = db.prepare(
    "SELECT lower(verdict) AS verdict, COUNT(*) AS count FROM verification_evidence GROUP BY lower(verdict)",
  ).all();
  const evidence = { total: 0, passed: 0, failed: 0 };
  for (const row of evidenceRows) {
    const count = numberColumn(row, "count");
    evidence.total += count;
    const verdict = String(row["verdict"] ?? "");
    if (verdict === "passed" || verdict === "pass") evidence.passed += count;
    else if (verdict === "failed" || verdict === "fail") evidence.failed += count;
  }

  return { assessments, evidence };
}

export function getHierarchyCompletionCounts(): HierarchyCompletionCounts {
  if (!getDbOrNull()!) {
    return { milestones: 0, milestonesTotal: 0, slices: 0, slicesTotal: 0, tasks: 0, tasksTotal: 0 };
  }

  const milestones = getCompletionCount("milestones");
  const slices = getCompletionCount("slices");
  const tasks = getCompletionCount("tasks");

  return {
    milestones: milestones.completed,
    milestonesTotal: milestones.total,
    slices: slices.completed,
    slicesTotal: slices.total,
    tasks: tasks.completed,
    tasksTotal: tasks.total,
  };
}

export function getMilestoneStatusCounts(): MilestoneStatusCounts {
  const db = getDbOrNull();
  if (!db) {
    return { total: 0, done: 0, active: 0, pending: 0, parked: 0 };
  }

  const row = db.prepare(
    `SELECT
       COUNT(*) AS total,
       COALESCE(SUM(CASE WHEN status IN (${TERMINAL_STATUS_SQL}) THEN 1 ELSE 0 END), 0) AS done,
       COALESCE(SUM(CASE WHEN status IN ('active', 'in_progress', 'in-progress') THEN 1 ELSE 0 END), 0) AS active,
       COALESCE(SUM(CASE WHEN status = 'parked' THEN 1 ELSE 0 END), 0) AS parked
     FROM milestones`,
  ).get();
  const total = numberColumn(row, "total");
  const done = numberColumn(row, "done");
  const active = numberColumn(row, "active");
  const parked = numberColumn(row, "parked");

  return {
    total,
    done,
    active,
    pending: total - done - active - parked,
    parked,
  };
}

/**
 * Slices currently in flight, for progress reads that expose an "active"
 * bucket (integration ProgressResult). Canonical in-flight statuses plus the
 * legacy 'in-progress' alias — the DB column is free-form
 * (status-guards.ts). Deferred/blocked/queued slices are NOT in flight; they
 * land in the caller's "pending" bucket, matching the projection reader's
 * buckets, which have no deferred field.
 */
export function getInFlightSliceCount(): number {
  if (!getDbOrNull()!) return 0;
  const row = getDbOrNull()!
    .prepare(
      "SELECT COUNT(*) AS n FROM slices WHERE status IN ('in_progress', 'in-progress', 'active')",
    )
    .get();
  return numberColumn(row, "n");
}

export function getDecisionById(id: string): Decision | null {
  if (!getDbOrNull()!) return null;
  const row = getDbOrNull()!.prepare("SELECT * FROM decisions WHERE id = ?").get(id);
  if (!row) return null;
  return rowToDecision(row);
}

export function getActiveDecisions(): Decision[] {
  if (!getDbOrNull()!) return [];
  const rows = getDbOrNull()!.prepare("SELECT * FROM active_decisions").all();
  return rows.map(rowToActiveDecision);
}

export function getRequirementById(id: string): Requirement | null {
  if (!getDbOrNull()!) return null;
  const row = getDbOrNull()!.prepare("SELECT * FROM requirements WHERE id = ?").get(id);
  if (!row) return null;
  return rowToRequirement(row);
}

export function getActiveRequirements(): Requirement[] {
  if (!getDbOrNull()!) return [];
  const rows = getDbOrNull()!.prepare("SELECT * FROM active_requirements").all();
  return rows.map(rowToActiveRequirement);
}

export function getRequirementCounts(): {
  active: number;
  validated: number;
  deferred: number;
  outOfScope: number;
  blocked: number;
  total: number;
} {
  if (!getDbOrNull()!) {
    return { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 };
  }
  const rows = getDbOrNull()!
    .prepare("SELECT lower(status) as status, COUNT(*) as count FROM requirements GROUP BY lower(status)")
    .all();
  return rowsToRequirementCounts(rows);
}

/**
 * ADR-017 raw primitive: returns slice IDs in a milestone whose is_sketch flag
 * is still 1. The stale-sketch-flag drift handler at
 * `state-reconciliation/drift/sketch-flag.ts` composes this with PLAN.md
 * existence checks to detect drift, then writes via `setSliceSketchFlag`.
 */
export function getSketchedSliceIds(milestoneId: string): string[] {
  if (!getDbOrNull()!) return [];
  const rows = getDbOrNull()!.prepare(
    `SELECT id FROM slices WHERE milestone_id = :mid AND is_sketch = 1`,
  ).all({ ":mid": milestoneId }) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

export function getSlice(milestoneId: string, sliceId: string): SliceRow | null {
  if (!getDbOrNull()!) return null;
  const row = getDbOrNull()!.prepare("SELECT * FROM slices WHERE milestone_id = :mid AND id = :sid").get({ ":mid": milestoneId, ":sid": sliceId });
  if (!row) return null;
  return rowToSlice(row);
}

export function getTask(milestoneId: string, sliceId: string, taskId: string): TaskRow | null {
  if (!getDbOrNull()!) return null;
  const row = getDbOrNull()!.prepare(
    "SELECT * FROM tasks WHERE milestone_id = :mid AND slice_id = :sid AND id = :tid",
  ).get({ ":mid": milestoneId, ":sid": sliceId, ":tid": taskId });
  if (!row) return null;
  return rowToTask(row);
}

export interface LifecycleShadowRepairIdentity {
  itemKind: "milestone" | "slice" | "task";
  milestoneId: string;
  sliceId?: string;
  taskId?: string;
}

export interface LifecycleShadowRepairEvidence {
  kind: "legacy_completion";
  legacyStatus: string;
  completedAt: string;
  verificationResult: string | null;
  evidenceDigest: string;
}

export interface LifecycleShadowRepairCandidate extends LifecycleShadowRepairIdentity {
  legacyStatus: string | null;
  canonicalStatus: CanonicalLifecycleStatus | null;
  canonicalLastOperationId: string | null;
  comparison: LifecycleShadowComparison;
  targetStatus: "completed" | null;
  evidence: LifecycleShadowRepairEvidence | null;
  reason: string | null;
  /**
   * Raw legacy verification_result for tasks (null for slices/milestones or
   * when unrecorded). Distinguishes "never verified" bare legacy completions —
   * completion's adoption territory when a canonically-completed sibling
   * establishes the adoption pattern (#2070) — from rows with a recorded
   * failed verification, which must never be silently repaired (#2002).
   */
  legacyVerificationResult: string | null;
}

function validCompletedAt(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function repairHierarchyRow(identity: LifecycleShadowRepairIdentity): Record<string, unknown> | undefined {
  const db = getDbOrNull();
  if (!db) return undefined;
  if (identity.itemKind === "milestone") {
    return db.prepare(`
      SELECT status, completed_at, NULL AS verification_result, NULL AS full_summary_md
      FROM milestones WHERE id = :milestone_id
    `).get({ ":milestone_id": identity.milestoneId });
  }
  if (identity.itemKind === "slice") {
    return db.prepare(`
      SELECT status, completed_at, NULL AS verification_result, full_summary_md
      FROM slices WHERE milestone_id = :milestone_id AND id = :slice_id
    `).get({
      ":milestone_id": identity.milestoneId,
      ":slice_id": identity.sliceId ?? null,
    });
  }
  return db.prepare(`
    SELECT status, completed_at, verification_result, full_summary_md
    FROM tasks
    WHERE milestone_id = :milestone_id AND slice_id = :slice_id AND id = :task_id
  `).get({
    ":milestone_id": identity.milestoneId,
    ":slice_id": identity.sliceId ?? null,
    ":task_id": identity.taskId ?? null,
  });
}

interface RepairEvidenceFacts {
  supported: boolean;
  digestFacts: unknown;
}

export function isPassingVerificationResult(verificationResult: string): boolean {
  return verificationResult.trim().toLowerCase() === "passed";
}

function taskCompletionFacts(row: Record<string, unknown>): RepairEvidenceFacts {
  const completedAt = validCompletedAt(row["completed_at"]);
  const verificationResult = typeof row["verification_result"] === "string"
    ? row["verification_result"].trim()
    : "";
  const summary = typeof row["full_summary_md"] === "string" ? row["full_summary_md"].trim() : "";
  return {
    supported:
      normalizeLegacyLifecycleStatus(typeof row["status"] === "string" ? row["status"] : null) === "completed" &&
      completedAt !== null &&
      isPassingVerificationResult(verificationResult) &&
      summary.length > 0,
    digestFacts: {
      status: row["status"] ?? null,
      completedAt,
      verificationResult,
      summaryHash: `sha256:${createHash("sha256").update(summary).digest("hex")}`,
    },
  };
}

function descendantsCompletionFacts(identity: LifecycleShadowRepairIdentity): RepairEvidenceFacts {
  const db = getDbOrNull()!;
  const tasks = db.prepare(`
    SELECT milestone_id, slice_id, id, status, completed_at, verification_result, full_summary_md
    FROM tasks
    WHERE milestone_id = :milestone_id
      AND (:slice_id IS NULL OR slice_id = :slice_id)
    ORDER BY milestone_id, slice_id, sequence, id
  `).all({
    ":milestone_id": identity.milestoneId,
    ":slice_id": identity.itemKind === "slice" ? identity.sliceId ?? null : null,
  });
  const taskFacts = tasks.map((row) => ({
    identity: {
      milestoneId: row["milestone_id"],
      sliceId: row["slice_id"],
      taskId: row["id"],
    },
    ...taskCompletionFacts(row),
  }));
  if (identity.itemKind === "slice") {
    return {
      supported: taskFacts.length > 0 && taskFacts.every((fact) => fact.supported),
      digestFacts: taskFacts.map(({ identity: item, digestFacts }) => ({ item, facts: digestFacts })),
    };
  }

  const slices = db.prepare(`
    SELECT milestone_id, id, status, completed_at, full_summary_md
    FROM slices WHERE milestone_id = :milestone_id
    ORDER BY milestone_id, sequence, id
  `).all({ ":milestone_id": identity.milestoneId });
  const sliceFacts = slices.map((row) => ({
    identity: { milestoneId: row["milestone_id"], sliceId: row["id"] },
    status: row["status"],
    completedAt: validCompletedAt(row["completed_at"]),
    summaryHash: `sha256:${createHash("sha256")
      .update(typeof row["full_summary_md"] === "string" ? row["full_summary_md"].trim() : "")
      .digest("hex")}`,
    supported:
      normalizeLegacyLifecycleStatus(typeof row["status"] === "string" ? row["status"] : null) === "completed" &&
      validCompletedAt(row["completed_at"]) !== null &&
      typeof row["full_summary_md"] === "string" &&
      row["full_summary_md"].trim().length > 0,
  }));
  return {
    supported:
      sliceFacts.length > 0 &&
      sliceFacts.every((fact) => fact.supported) &&
      taskFacts.length > 0 &&
      taskFacts.every((fact) => fact.supported),
    digestFacts: {
      slices: sliceFacts.map(({ supported: _supported, ...fact }) => fact),
      tasks: taskFacts.map(({ identity: item, digestFacts }) => ({ item, facts: digestFacts })),
    },
  };
}

function evidenceDigest(facts: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(facts)).digest("hex")}`;
}

/**
 * Returns stable database evidence for a possible forward-only shadow repair.
 * This seam is deliberately SELECT-only; deciding and recording a disposition
 * belongs to the lifecycle.shadow.repair Domain Operation.
 */
export function getLifecycleShadowRepairCandidate(
  identity: LifecycleShadowRepairIdentity,
): LifecycleShadowRepairCandidate | null {
  if (!getDbOrNull()) return null;
  return readTransaction(() => {
    const db = getDbOrNull()!;
    const lifecycle = db.prepare(`
      SELECT lifecycle_status, last_operation_id
      FROM workflow_item_lifecycles
      WHERE item_kind = :item_kind
        AND milestone_id = :milestone_id
        AND slice_id IS :slice_id
        AND task_id IS :task_id
    `).get({
      ":item_kind": identity.itemKind,
      ":milestone_id": identity.milestoneId,
      ":slice_id": identity.sliceId ?? null,
      ":task_id": identity.taskId ?? null,
    });
    const hierarchy = repairHierarchyRow(identity);
    if (!hierarchy && !lifecycle) return null;
    const canonicalStatus = normalizeCanonicalLifecycleStatus(
      typeof lifecycle?.["lifecycle_status"] === "string" ? lifecycle["lifecycle_status"] : null,
    );
    const canonicalLastOperationId = typeof lifecycle?.["last_operation_id"] === "string"
      ? lifecycle["last_operation_id"]
      : null;
    if (!hierarchy) {
      return {
        ...identity,
        legacyStatus: null,
        legacyVerificationResult: null,
        canonicalStatus,
        canonicalLastOperationId,
        comparison: compareLifecycleShadow(null, canonicalStatus),
        targetStatus: null,
        evidence: null,
        reason: "legacy hierarchy row is missing; extra canonical shadow remains unresolved",
      };
    }
    const legacyStatus = typeof hierarchy["status"] === "string" ? hierarchy["status"] : null;
    const completedAt = validCompletedAt(hierarchy["completed_at"]);
    const verificationResult = typeof hierarchy["verification_result"] === "string"
      ? hierarchy["verification_result"].trim()
      : "";
    const ownFacts = identity.itemKind === "task"
      ? taskCompletionFacts(hierarchy)
      : {
          supported:
            normalizeLegacyLifecycleStatus(legacyStatus) === "completed" &&
            completedAt !== null &&
            (identity.itemKind === "milestone" || (
              typeof hierarchy["full_summary_md"] === "string" &&
              hierarchy["full_summary_md"].trim().length > 0
            )),
          digestFacts: {
            status: legacyStatus,
            completedAt,
            summaryHash: identity.itemKind === "slice"
              ? `sha256:${createHash("sha256").update(String(hierarchy["full_summary_md"] ?? "").trim()).digest("hex")}`
              : null,
          },
        };
    const descendantFacts = identity.itemKind === "task"
      ? { supported: true, digestFacts: null }
      : descendantsCompletionFacts(identity);
    const supportsCompletion = ownFacts.supported && descendantFacts.supported;
    const digestFacts = {
      identity,
      own: ownFacts.digestFacts,
      descendants: descendantFacts.digestFacts,
    };

    return {
      ...identity,
      legacyStatus,
      legacyVerificationResult: identity.itemKind === "task" ? (verificationResult || null) : null,
      canonicalStatus,
      canonicalLastOperationId,
      comparison: compareLifecycleShadow(legacyStatus, canonicalStatus),
      targetStatus: supportsCompletion ? "completed" : null,
      evidence: supportsCompletion
        ? {
            kind: "legacy_completion",
            legacyStatus: legacyStatus!,
            completedAt: completedAt!,
            verificationResult: identity.itemKind === "task" ? verificationResult : null,
            evidenceDigest: evidenceDigest(digestFacts),
          }
        : null,
      reason: supportsCompletion
        ? null
        : "durable completion evidence does not prove a supported terminal target",
    };
  });
}

/**
 * Reads the full legacy/canonical Milestone hierarchy comparison. Callers own
 * the surrounding read transaction so this snapshot can be paired atomically
 * with the legacy milestone-status response.
 */
export function getMilestoneLifecycleShadowSnapshot(
  milestoneId: string,
): LifecycleShadowObservationSnapshot {
  const db = getDbOrNull();
  if (!db) {
    return {
      projectRevision: 0,
      authorityEpoch: 0,
      items: [],
      queryError: new Error("GSD database is not available"),
    };
  }

  let projectRevision = 0;
  let authorityEpoch = 0;
  try {
    const authority = db.prepare(`
      SELECT revision, authority_epoch
      FROM project_authority WHERE singleton = 1
    `).get();
    projectRevision = numberColumn(authority, "revision");
    authorityEpoch = numberColumn(authority, "authority_epoch");
    const rows = db.prepare(`
      WITH hierarchy AS (
        SELECT
          'milestone' AS item_kind,
          id AS milestone_id,
          NULL AS slice_id,
          NULL AS task_id,
          status AS legacy_status
        FROM milestones
        WHERE id = :milestone_id
        UNION ALL
        SELECT
          'slice', milestone_id, id, NULL, status
        FROM slices
        WHERE milestone_id = :milestone_id
        UNION ALL
        SELECT
          'task', milestone_id, slice_id, id, status
        FROM tasks
        WHERE milestone_id = :milestone_id
      ), identities AS (
        SELECT item_kind, milestone_id, slice_id, task_id FROM hierarchy
        UNION
        SELECT item_kind, milestone_id, slice_id, task_id
        FROM workflow_item_lifecycles
        WHERE milestone_id = :milestone_id
      )
      SELECT
        identity.item_kind,
        identity.milestone_id,
        identity.slice_id,
        identity.task_id,
        hierarchy.legacy_status,
        lifecycle.lifecycle_id,
        lifecycle.lifecycle_status AS canonical_status
      FROM identities identity
      LEFT JOIN hierarchy
        ON hierarchy.item_kind = identity.item_kind
       AND hierarchy.milestone_id = identity.milestone_id
       AND hierarchy.slice_id IS identity.slice_id
       AND hierarchy.task_id IS identity.task_id
      LEFT JOIN workflow_item_lifecycles lifecycle
        ON lifecycle.item_kind = identity.item_kind
       AND lifecycle.milestone_id = identity.milestone_id
       AND lifecycle.slice_id IS identity.slice_id
       AND lifecycle.task_id IS identity.task_id
      ORDER BY
        CASE identity.item_kind WHEN 'milestone' THEN 0 WHEN 'slice' THEN 1 ELSE 2 END,
        identity.slice_id,
        identity.task_id
    `).all({ ":milestone_id": milestoneId });

    return {
      projectRevision,
      authorityEpoch,
      items: rows.map((row) => {
        const legacyStatus = typeof row["legacy_status"] === "string" ? row["legacy_status"] : null;
        const canonicalStatus = typeof row["canonical_status"] === "string" ? row["canonical_status"] : null;
        return lifecycleShadowObservationItem({
          itemKind: String(row["item_kind"]) as "milestone" | "slice" | "task",
          milestoneId: String(row["milestone_id"]),
          sliceId: typeof row["slice_id"] === "string" ? row["slice_id"] : null,
          taskId: typeof row["task_id"] === "string" ? row["task_id"] : null,
          lifecycleId: typeof row["lifecycle_id"] === "string" ? row["lifecycle_id"] : null,
          comparison: compareLifecycleShadow(legacyStatus, canonicalStatus),
        });
      }),
    };
  } catch (queryError) {
    return { projectRevision, authorityEpoch, items: [], queryError };
  }
}

export function getSliceTasks(milestoneId: string, sliceId: string): TaskRow[] {
  if (!getDbOrNull()!) return [];
  const rows = getDbOrNull()!.prepare(
    "SELECT * FROM tasks WHERE milestone_id = :mid AND slice_id = :sid ORDER BY sequence, id",
  ).all({ ":mid": milestoneId, ":sid": sliceId });
  return rows.map(rowToTask);
}

export function getCompletedMilestoneTaskFileHints(milestoneId: string): string[] {
  if (!getDbOrNull()!) return [];
  const rows = getDbOrNull()!.prepare(
    `SELECT files, key_files
     FROM tasks
     WHERE milestone_id = :mid AND status IN ('complete', 'done')`,
  ).all({ ":mid": milestoneId }) as Array<Record<string, unknown>>;

  const hints = new Set<string>();
  for (const row of rows) {
    for (const raw of [row["files"], row["key_files"]]) {
      for (const file of parseStringArrayColumn(raw)) {
        const normalized = normalizeRepoPath(file);
        if (normalized) hints.add(normalized);
      }
    }
  }
  return [...hints];
}

/** Find the most recent resolved-but-unapplied escalation override in a slice. */
export function findUnappliedEscalationOverride(
  milestoneId: string, sliceId: string,
): { taskId: string; artifactPath: string } | null {
  if (!getDbOrNull()!) return null;
  // Filter BOTH flags: escalation_pending=0 AND escalation_awaiting_review=0
  // ensures we only claim overrides the user has explicitly resolved.
  // Without the awaiting_review filter, continueWithDefault=true artifacts
  // (not yet responded to) would be prematurely claimed, causing the override
  // to be lost when the user later resolves (#ADR-011 Phase 2 peer-review Bug 2).
  const row = getDbOrNull()!.prepare(
    `SELECT id, escalation_artifact_path AS path
       FROM tasks
      WHERE milestone_id = :mid AND slice_id = :sid
        AND escalation_artifact_path IS NOT NULL
        AND escalation_override_applied_at IS NULL
        AND escalation_pending = 0
        AND escalation_awaiting_review = 0
      ORDER BY sequence DESC, id DESC
      LIMIT 1`,
  ).get({ ":mid": milestoneId, ":sid": sliceId }) as
    | { id: string; path: string | null }
    | undefined;
  if (!row || !row.path) return null;
  return { taskId: row.id, artifactPath: row.path };
}

/** List tasks with active escalation artifacts across a milestone (for /gsd escalate list). */
export function listEscalationArtifacts(milestoneId: string, includeResolved: boolean = false): TaskRow[] {
  if (!getDbOrNull()!) return [];
  const filter = includeResolved
    ? "escalation_artifact_path IS NOT NULL"
    : "(escalation_pending = 1 OR escalation_awaiting_review = 1) AND escalation_artifact_path IS NOT NULL";
  const rows = getDbOrNull()!.prepare(
    `SELECT * FROM tasks WHERE milestone_id = :mid AND ${filter} ORDER BY slice_id, sequence, id`,
  ).all({ ":mid": milestoneId });
  return rows.map(rowToTask);
}

export interface VerificationEvidenceRow {
  id: number;
  task_id: string;
  slice_id: string;
  milestone_id: string;
  command: string;
  exit_code: number;
  verdict: string;
  duration_ms: number;
  created_at: string;
}

export function getVerificationEvidence(milestoneId: string, sliceId: string, taskId: string): VerificationEvidenceRow[] {
  if (!getDbOrNull()!) return [];
  const rows = getDbOrNull()!.prepare(
    "SELECT * FROM verification_evidence WHERE milestone_id = :mid AND slice_id = :sid AND task_id = :tid ORDER BY id",
  ).all({ ":mid": milestoneId, ":sid": sliceId, ":tid": taskId });
  return rows as unknown as VerificationEvidenceRow[];
}

export function getAllMilestones(): MilestoneRow[] {
  if (!getDbOrNull()!) return [];
  const rows = getDbOrNull()!.prepare(
    "SELECT * FROM milestones ORDER BY CASE WHEN sequence > 0 THEN 0 ELSE 1 END, sequence, id",
  ).all();
  return rows.map(rowToMilestone);
}

export function getMilestone(id: string): MilestoneRow | null {
  if (!getDbOrNull()!) return null;
  const row = getDbOrNull()!.prepare("SELECT * FROM milestones WHERE id = :id").get({ ":id": id });
  if (!row) return null;
  return rowToMilestone(row);
}

export interface PlanMilestoneRecoveryBlock {
  reason: string;
}

/** Latest unresolved fail-closed recovery gate for a milestone with no executable plan. */
export function getPlanMilestoneRecoveryBlock(milestoneId: string): PlanMilestoneRecoveryBlock | null {
  const db = getDbOrNull();
  if (!db) return null;
  const row = db.prepare(`
    SELECT outcome, rationale, findings
    FROM gate_runs
    WHERE gate_id = 'plan-milestone-recovery'
      AND unit_type = 'plan-milestone'
      AND milestone_id = :milestone_id
    ORDER BY id DESC
    LIMIT 1
  `).get({ ":milestone_id": milestoneId });
  if (!row || row["outcome"] !== "manual-attention") return null;
  const rationale = typeof row["rationale"] === "string" ? row["rationale"].trim() : "";
  const findings = typeof row["findings"] === "string" ? row["findings"].trim() : "";
  return {
    reason: rationale || findings || `Milestone ${milestoneId} planning failed.`,
  };
}

export function getActiveMilestoneFromDb(): MilestoneRow | null {
  if (!getDbOrNull()!) return null;
  const row = getDbOrNull()!.prepare(
    `SELECT * FROM milestones WHERE status NOT IN (${TERMINAL_STATUS_SQL}, 'parked') ORDER BY id LIMIT 1`,
  ).get();
  if (!row) return null;
  return rowToMilestone(row);
}

export function getActiveSliceFromDb(milestoneId: string): SliceRow | null {
  if (!getDbOrNull()!) return null;

  // Single query: find the first non-complete slice whose dependencies are all satisfied.
  // Uses json_each() to expand the JSON depends array and checks each dep is complete.
  const row = getDbOrNull()!.prepare(
    `SELECT s.* FROM slices s
     WHERE s.milestone_id = :mid
       AND s.status NOT IN (${TERMINAL_STATUS_SQL})
       AND NOT EXISTS (
         SELECT 1 FROM json_each(s.depends) AS dep
         WHERE dep.value NOT IN (
           SELECT id FROM slices WHERE milestone_id = :mid AND status IN (${TERMINAL_STATUS_SQL})
         )
       )
     ORDER BY s.sequence, s.id
     LIMIT 1`,
  ).get({ ":mid": milestoneId });
  if (!row) return null;
  return rowToSlice(row);
}

export function getActiveTaskFromDb(milestoneId: string, sliceId: string): TaskRow | null {
  if (!getDbOrNull()!) return null;
  const row = getDbOrNull()!.prepare(
    `SELECT * FROM tasks WHERE milestone_id = :mid AND slice_id = :sid AND status NOT IN (${TERMINAL_STATUS_SQL}) ORDER BY sequence, id LIMIT 1`,
  ).get({ ":mid": milestoneId, ":sid": sliceId });
  if (!row) return null;
  return rowToTask(row);
}

export function getMilestoneSlices(milestoneId: string): SliceRow[] {
  if (!getDbOrNull()!) return [];
  const rows = getDbOrNull()!.prepare("SELECT * FROM slices WHERE milestone_id = :mid ORDER BY sequence, id").all({ ":mid": milestoneId });
  return rows.map(rowToSlice);
}

export interface ParallelMonitorSliceProgress {
  id: string;
  status: string;
  total: number;
  done: number;
}

export function getParallelMonitorSliceProgress(milestoneId: string): ParallelMonitorSliceProgress[] {
  const db = getDbOrNull();
  if (!db) return [];
  const rows = db.prepare(
    `SELECT
       s.id AS id,
       s.status AS status,
       COUNT(t.id) AS total,
       COALESCE(SUM(CASE WHEN t.status IN (${TERMINAL_STATUS_SQL}) THEN 1 ELSE 0 END), 0) AS done
     FROM slices s
     LEFT JOIN tasks t ON s.milestone_id=t.milestone_id AND s.id=t.slice_id
     WHERE s.milestone_id=:mid
     GROUP BY s.id
     ORDER BY s.id`,
  ).all({ ":mid": milestoneId });
  return rows.map((row) => ({
    id: String(row["id"] ?? ""),
    status: String(row["status"] ?? ""),
    total: Number(row["total"] ?? 0),
    done: Number(row["done"] ?? 0),
  }));
}

export interface ParallelMonitorCompletion {
  taskId: string;
  sliceId: string;
  oneLiner: string;
}

export function getParallelMonitorRecentCompletions(
  milestoneId: string,
  limit: number = 5,
): ParallelMonitorCompletion[] {
  const db = getDbOrNull();
  if (!db) return [];
  const numericLimit = Number.isFinite(limit) ? Math.floor(limit) : 5;
  const safeLimit = Math.max(1, Math.min(50, numericLimit));
  const rows = db.prepare(
    `SELECT id, slice_id, one_liner
     FROM tasks
     WHERE milestone_id=:mid
       AND status='complete'
       AND completed_at IS NOT NULL
     ORDER BY completed_at DESC
     LIMIT ${safeLimit}`,
  ).all({ ":mid": milestoneId });
  return rows.map((row) => ({
    taskId: String(row["id"] ?? ""),
    sliceId: String(row["slice_id"] ?? ""),
    oneLiner: String(row["one_liner"] ?? ""),
  }));
}

/**
 * Load slices for many milestones in a single query. Returns a Map keyed by
 * milestone_id, preserving `ORDER BY sequence, id` within each bucket.
 */
export function getSlicesByMilestoneIds(milestoneIds: readonly string[]): Map<string, SliceRow[]> {
  const db = getDbOrNull();
  if (!db || milestoneIds.length === 0) return new Map();
  const idList = [...milestoneIds];
  const placeholders = idList.map((_, i) => `:mid${i}`).join(",");
  const params: Record<string, unknown> = {};
  idList.forEach((id, i) => {
    params[`:mid${i}`] = id;
  });
  const rows = db
    .prepare(`SELECT * FROM slices WHERE milestone_id IN (${placeholders}) ORDER BY milestone_id, sequence, id`)
    .all(params) as Record<string, unknown>[];
  const byMilestone = new Map<string, SliceRow[]>();
  for (const row of rows) {
    const slice = rowToSlice(row);
    const bucket = byMilestone.get(slice.milestone_id);
    if (bucket) {
      bucket.push(slice);
    } else {
      byMilestone.set(slice.milestone_id, [slice]);
    }
  }
  return byMilestone;
}

/**
 * Load tasks for many (milestone, slice) pairs in batched queries. Returns a Map
 * keyed by `${milestone_id}\0${slice_id}`, preserving `ORDER BY sequence, id`
 * within each bucket. Mirrors getSlicesByMilestoneIds to avoid an N+1 over tasks
 * during full projection rebuilds.
 */
export function getTasksBySliceIds(
  slices: ReadonlyArray<{ milestoneId: string; sliceId: string }>,
): Map<string, TaskRow[]> {
  const bySlice = new Map<string, TaskRow[]>();
  const db = getDbOrNull();
  if (!db || slices.length === 0) return bySlice;
  // SQLite caps bound params (~999); 2 per pair, so chunk well under the limit.
  const CHUNK = 400;
  for (let start = 0; start < slices.length; start += CHUNK) {
    const chunk = slices.slice(start, start + CHUNK);
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    chunk.forEach((s, i) => {
      clauses.push(`(milestone_id = :m${i} AND slice_id = :s${i})`);
      params[`:m${i}`] = s.milestoneId;
      params[`:s${i}`] = s.sliceId;
    });
    const rows = db
      .prepare(`SELECT * FROM tasks WHERE ${clauses.join(" OR ")} ORDER BY milestone_id, slice_id, sequence, id`)
      .all(params) as Record<string, unknown>[];
    for (const row of rows) {
      const task = rowToTask(row);
      const key = `${task.milestone_id}\0${task.slice_id}`;
      const bucket = bySlice.get(key);
      if (bucket) {
        bucket.push(task);
      } else {
        bySlice.set(key, [task]);
      }
    }
  }
  return bySlice;
}

export interface ProgressHierarchyDetails {
  milestones: Array<{
    id: string;
    title: string;
    status: string;
    truncated: boolean;
    slices: Array<{
      id: string;
      title: string;
      status: string;
      truncated: boolean;
      tasks: Array<{ id: string; title: string; status: string }>;
    }>;
  }>;
  milestonesTruncated: boolean;
  tasksTruncated: boolean;
}

/** Read a bounded project hierarchy for compact integration consumers. */
export function getProgressHierarchyDetails(): ProgressHierarchyDetails {
  const db = getDbOrNull();
  if (!db) return { milestones: [], milestonesTruncated: false, tasksTruncated: false };

  const maxMilestones = 50;
  const maxSlicesPerMilestone = 50;
  const maxTasksPerSlice = 50;
  const maxTasks = 1_000;

  const milestones = db.prepare(
    "SELECT id, title, status FROM milestones ORDER BY CASE WHEN sequence > 0 THEN 0 ELSE 1 END, sequence, id LIMIT 51",
  ).all() as Array<{ id: string; title: string; status: string }>;
  const selectedMilestones = milestones.slice(0, maxMilestones);
  if (selectedMilestones.length === 0) return { milestones: [], milestonesTruncated: false, tasksTruncated: false };

  const milestonePlaceholders = selectedMilestones.map((_, index) => `:mid${index}`).join(",");
  const milestoneParams: Record<string, string> = {};
  selectedMilestones.forEach((milestone, index) => {
    milestoneParams[`:mid${index}`] = milestone.id;
  });
  const slices = db.prepare(
    `SELECT milestone_id, id, title, status, sequence, row_number
       FROM (
         SELECT milestone_id, id, title, status, sequence,
                ROW_NUMBER() OVER (PARTITION BY milestone_id ORDER BY sequence, id) AS row_number
           FROM slices
          WHERE milestone_id IN (${milestonePlaceholders})
       )
      WHERE row_number <= 51
      ORDER BY milestone_id, sequence, id`,
  ).all(milestoneParams) as Array<Record<string, unknown>>;
  const selectedSlices = slices.filter((slice) => Number(slice.row_number) <= maxSlicesPerMilestone);
  const sliceKeys = selectedSlices.map((slice) => ({
    milestoneId: String(slice.milestone_id),
    sliceId: String(slice.id),
  }));
  const tasks: Array<Record<string, unknown>> = [];
  for (let start = 0; start < sliceKeys.length; start += 400) {
    const remainingTaskRows = maxTasks + 1 - tasks.length;
    if (remainingTaskRows <= 0) break;
    const chunk = sliceKeys.slice(start, start + 400);
    const taskClauses = chunk.map((slice, index) => `(milestone_id = :taskMid${index} AND slice_id = :taskSid${index})`).join(" OR ");
    const taskParams: Record<string, string> = {};
    chunk.forEach((slice, index) => {
      taskParams[`:taskMid${index}`] = slice.milestoneId;
      taskParams[`:taskSid${index}`] = slice.sliceId;
    });
    const rows = db.prepare(
      `SELECT milestone_id, slice_id, id, title, status, sequence, row_number
         FROM (
           SELECT milestone_id, slice_id, id, title, status, sequence,
                  ROW_NUMBER() OVER (PARTITION BY milestone_id, slice_id ORDER BY sequence, id) AS row_number
             FROM tasks
            WHERE ${taskClauses}
         )
        WHERE row_number <= ${maxTasksPerSlice + 1}
        ORDER BY milestone_id, slice_id, sequence, id
        LIMIT ${remainingTaskRows}`,
    ).all(taskParams) as Array<Record<string, unknown>>;
    tasks.push(...rows);
  }

  const tasksTruncated = tasks.length > maxTasks;
  const selectedTasks = tasks.slice(0, maxTasks);
  const slicesByMilestone = new Map<string, Array<Record<string, unknown>>>();
  for (const slice of slices) {
    const key = String(slice.milestone_id);
    const bucket = slicesByMilestone.get(key) ?? [];
    bucket.push(slice);
    slicesByMilestone.set(key, bucket);
  }
  const tasksBySlice = new Map<string, Array<Record<string, unknown>>>();
  for (const task of selectedTasks) {
    const key = `${String(task.milestone_id)}\0${String(task.slice_id)}`;
    const bucket = tasksBySlice.get(key) ?? [];
    bucket.push(task);
    tasksBySlice.set(key, bucket);
  }

  return {
    milestones: selectedMilestones.map((milestone) => {
      const milestoneSlices = slicesByMilestone.get(milestone.id) ?? [];
      return {
        ...milestone,
        truncated: milestoneSlices.some((slice) => Number(slice.row_number) > maxSlicesPerMilestone),
        slices: milestoneSlices.filter((slice) => Number(slice.row_number) <= maxSlicesPerMilestone).map((slice) => {
          const milestoneId = String(slice.milestone_id);
          const sliceId = String(slice.id);
          const sliceTasks = tasksBySlice.get(`${milestoneId}\0${sliceId}`) ?? [];
          return {
            id: sliceId,
            title: String(slice.title ?? ""),
            status: String(slice.status ?? ""),
            truncated: sliceTasks.some((task) => Number(task.row_number) > maxTasksPerSlice),
            tasks: sliceTasks.filter((task) => Number(task.row_number) <= maxTasksPerSlice).map((task) => ({
              id: String(task.id ?? ""),
              title: String(task.title ?? ""),
              status: String(task.status ?? ""),
            })),
          };
        }),
      };
    }),
    milestonesTruncated: milestones.length > maxMilestones,
    tasksTruncated,
  };
}

/** Dispatch-eligibility shape consumed by decision-path callers (ADR-017). */
export interface MilestoneSliceSummary {
  id: string;
  title: string;
  /** Closed per the canonical status vocabulary (complete/done/skipped/closed/cancelled). */
  done: boolean;
  depends: string[];
}

/**
 * Consolidated DB read for dispatch/gate/completion decisions (ADR-017).
 * `done` uses the canonical closed-status predicate (`isClosedStatus`) — the
 * same vocabulary the SQL terminal-status fragment derives from. Decision
 * paths must consume this instead of parsing `.gsd/*.md` projections.
 * Rows keep `getMilestoneSlices` ordering (sequence, then id).
 */
export function getMilestoneSliceSummaries(milestoneId: string): MilestoneSliceSummary[] {
  return getMilestoneSlices(milestoneId).map((s) => ({
    id: s.id,
    title: s.title,
    done: isClosedStatus(s.status),
    depends: s.depends ?? [],
  }));
}

/**
 * Ids of slices closed per the canonical status vocabulary (ADR-017), in
 * milestone order. Thin wrapper over `getMilestoneSliceSummaries` for the
 * common "which slices are done?" decision-path read.
 */
export function getClosedSliceIds(milestoneId: string): string[] {
  return getMilestoneSliceSummaries(milestoneId)
    .filter((s) => s.done)
    .map((s) => s.id);
}

export function getArtifact(path: string): ArtifactRow | null {
  if (!getDbOrNull()!) return null;
  const row = getDbOrNull()!.prepare("SELECT * FROM artifacts WHERE path = :path").get({ ":path": path });
  if (!row) return null;
  return rowToArtifact(row);
}

/** Milestone-level artifacts (CONTEXT, RESEARCH, VALIDATION, etc.) from the artifacts table. */
export function getMilestoneScopedArtifacts(milestoneId: string): ArtifactRow[] {
  if (!getDbOrNull()!) return [];
  const rows = getDbOrNull()!.prepare(
    "SELECT * FROM artifacts WHERE milestone_id = :mid AND slice_id IS NULL AND task_id IS NULL ORDER BY path",
  ).all({ ":mid": milestoneId });
  return rows.map(rowToArtifact);
}

/** Slice-level artifacts (CONTEXT, RESEARCH, CONTINUE, etc.) from the artifacts table. */
export function getSliceScopedArtifacts(milestoneId: string, sliceId: string): ArtifactRow[] {
  if (!getDbOrNull()!) return [];
  const rows = getDbOrNull()!.prepare(
    "SELECT * FROM artifacts WHERE milestone_id = :mid AND slice_id = :sid AND task_id IS NULL ORDER BY path",
  ).all({ ":mid": milestoneId, ":sid": sliceId });
  return rows.map(rowToArtifact);
}

/** Fast milestone status check — avoids deserializing JSON planning fields. */
export function getActiveMilestoneIdFromDb(): IdStatusSummary | null {
  if (!getDbOrNull()!) return null;
  const row = getDbOrNull()!.prepare(
    `SELECT id, status FROM milestones WHERE status NOT IN (${TERMINAL_STATUS_SQL}, 'parked') ORDER BY id LIMIT 1`,
  ).get();
  if (!row) return null;
  return rowToIdStatusSummary(row);
}

/** Fast slice status check — avoids deserializing JSON depends/planning fields. */
export function getSliceStatusSummary(milestoneId: string): IdStatusSummary[] {
  if (!getDbOrNull()!) return [];
  return getDbOrNull()!.prepare(
    "SELECT id, status FROM slices WHERE milestone_id = :mid ORDER BY sequence, id",
  ).all({ ":mid": milestoneId }).map(rowToIdStatusSummary);
}

/** Fast task status check — avoids deserializing JSON arrays and large text fields. */
export function getActiveTaskIdFromDb(milestoneId: string, sliceId: string): ActiveTaskSummary | null {
  if (!getDbOrNull()!) return null;
  const row = getDbOrNull()!.prepare(
    `SELECT id, status, title FROM tasks WHERE milestone_id = :mid AND slice_id = :sid AND status NOT IN (${TERMINAL_STATUS_SQL}) ORDER BY sequence, id LIMIT 1`,
  ).get({ ":mid": milestoneId, ":sid": sliceId });
  if (!row) return null;
  return rowToActiveTaskSummary(row);
}

/** Count tasks by status for a slice — useful for progress reporting without full row load. */
export function getSliceTaskCounts(milestoneId: string, sliceId: string): TaskStatusCounts {
  if (!getDbOrNull()!) return emptyTaskStatusCounts();
  const row = getDbOrNull()!.prepare(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN status IN (${TERMINAL_STATUS_SQL}) THEN 1 ELSE 0 END) as done,
       SUM(CASE WHEN status NOT IN (${TERMINAL_STATUS_SQL}) THEN 1 ELSE 0 END) as pending
     FROM tasks WHERE milestone_id = :mid AND slice_id = :sid`,
  ).get({ ":mid": milestoneId, ":sid": sliceId });
  return rowToTaskStatusCounts(row);
}

/** Get all slices that depend on a given slice. */
export function getDependentSlices(milestoneId: string, sliceId: string): string[] {
  if (!getDbOrNull()!) return [];
  const rows = getDbOrNull()!.prepare(
    "SELECT slice_id FROM slice_dependencies WHERE milestone_id = :mid AND depends_on_slice_id = :sid",
  ).all({ ":mid": milestoneId, ":sid": sliceId });
  return rowsToStringColumn(rows, "slice_id");
}

export function getReplanHistory(milestoneId: string, sliceId?: string): Array<Record<string, unknown>> {
  if (!getDbOrNull()!) return [];
  if (sliceId) {
    return getDbOrNull()!.prepare(
      `SELECT * FROM replan_history WHERE milestone_id = :mid AND slice_id = :sid ORDER BY created_at DESC`,
    ).all({ ":mid": milestoneId, ":sid": sliceId });
  }
  return getDbOrNull()!.prepare(
    `SELECT * FROM replan_history WHERE milestone_id = :mid ORDER BY created_at DESC`,
  ).all({ ":mid": milestoneId });
}

export interface WorkflowDomainEventRecord {
  payload: Record<string, unknown>;
  createdAt: string;
}

export function getLatestWorkflowDomainEvent(
  eventType: string,
  entityType: string,
  entityId: string,
): WorkflowDomainEventRecord | null {
  if (!getDbOrNull()) return null;
  const row = getDbOrNull()!.prepare(`
    SELECT payload_json, created_at
    FROM workflow_domain_events
    WHERE event_type = :event_type
      AND entity_type = :entity_type
      AND entity_id = :entity_id
    ORDER BY project_revision DESC, event_index DESC
    LIMIT 1
  `).get({
    ":event_type": eventType,
    ":entity_type": entityType,
    ":entity_id": entityId,
  });
  if (!row) return null;
  const payload = JSON.parse(String(row["payload_json"] ?? "{}")) as unknown;
  if (!payload || Array.isArray(payload) || typeof payload !== "object") {
    throw new Error(`invalid payload for workflow event ${eventType}`);
  }
  return {
    payload: payload as Record<string, unknown>,
    createdAt: String(row["created_at"] ?? ""),
  };
}

export function getAssessment(path: string): Record<string, unknown> | null {
  if (!getDbOrNull()!) return null;
  const row = getDbOrNull()!.prepare(
    `SELECT * FROM assessments WHERE path = :path`,
  ).get({ ":path": path });
  return row ?? null;
}

/**
 * Look up a slice's `run-uat` assessment by (milestoneId, sliceId) identity,
 * independent of the artifact `path`. Used as a DB fallback by the UAT
 * closeout gate when a path migration orphans the ASSESSMENT markdown from its
 * canonical expected path (ADR-017: DB-authoritative UAT sign-off).
 *
 * `status` holds the normalized verdict (`pass`/`fail`/…) written by
 * `executeUatResultSave`; `fullContent` carries the ASSESSMENT body so callers
 * can derive `uatType` without re-reading a file that may not exist.
 */
export function getSliceRunUatAssessment(
  milestoneId: string,
  sliceId: string,
): { status: string; fullContent: string } | null {
  if (!getDbOrNull()!) return null;
  const row = getDbOrNull()!.prepare(
    `SELECT status, full_content AS fullContent FROM assessments
      WHERE milestone_id = :mid AND slice_id = :sid AND scope = 'run-uat'
      ORDER BY created_at DESC, ROWID DESC
      LIMIT 1`,
  ).get({ ":mid": milestoneId, ":sid": sliceId });
  if (!row) return null;
  return { status: String(row["status"] ?? ""), fullContent: String(row["fullContent"] ?? "") };
}

export function getLatestAssessmentByScope(
  milestoneId: string,
  scope: string,
): Record<string, unknown> | null {
  if (!getDbOrNull()!) return null;
  const row = getDbOrNull()!.prepare(
    `SELECT * FROM assessments
      WHERE milestone_id = :mid AND scope = :scope
      ORDER BY created_at DESC
      LIMIT 1`,
  ).get({ ":mid": milestoneId, ":scope": scope });
  return row ?? null;
}

export function getPendingGates(milestoneId: string, sliceId: string, scope?: GateScope): GateRow[] {
  if (!getDbOrNull()!) return [];
  const sql = scope
    ? `SELECT * FROM quality_gates WHERE milestone_id = :mid AND slice_id = :sid AND scope = :scope AND status = 'pending'`
    : `SELECT * FROM quality_gates WHERE milestone_id = :mid AND slice_id = :sid AND status = 'pending'`;
  const params: Record<string, unknown> = { ":mid": milestoneId, ":sid": sliceId };
  if (scope) params[":scope"] = scope;
  return getDbOrNull()!.prepare(sql).all(params).map(rowToGate);
}

export function getGateResults(milestoneId: string, sliceId: string, scope?: GateScope): GateRow[] {
  if (!getDbOrNull()!) return [];
  const sql = scope
    ? `SELECT * FROM quality_gates WHERE milestone_id = :mid AND slice_id = :sid AND scope = :scope`
    : `SELECT * FROM quality_gates WHERE milestone_id = :mid AND slice_id = :sid`;
  const params: Record<string, unknown> = { ":mid": milestoneId, ":sid": sliceId };
  if (scope) params[":scope"] = scope;
  return getDbOrNull()!.prepare(sql).all(params).map(rowToGate);
}

export function getPendingSliceGateCount(milestoneId: string, sliceId: string): number {
  if (!getDbOrNull()!) return 0;
  const row = getDbOrNull()!.prepare(
    `SELECT COUNT(*) as cnt FROM quality_gates
     WHERE milestone_id = :mid AND slice_id = :sid AND scope = 'slice' AND status = 'pending'`,
  ).get({ ":mid": milestoneId, ":sid": sliceId });
  return row ? (row["cnt"] as number) : 0;
}

/**
 * Return pending gate rows owned by a specific workflow turn.
 *
 * Unlike `getPendingGates(..., scope)`, this filters by the registry's
 * `ownerTurn` metadata so callers can distinguish Q3/Q4 (owned by
 * gate-evaluate) from Q8 (owned by complete-slice) even though both are
 * scope:"slice". Pass `taskId` to narrow task-scoped results to one task.
 */
export function getPendingGatesForTurn(
  milestoneId: string,
  sliceId: string,
  turn: OwnerTurn,
  taskId?: string,
): GateRow[] {
  if (!getDbOrNull()!) return [];
  const ids = getGateIdsForTurn(turn);
  if (ids.size === 0) return [];
  const idList = [...ids];
  const placeholders = idList.map((_, i) => `:gid${i}`).join(",");
  const params: Record<string, unknown> = {
    ":mid": milestoneId,
    ":sid": sliceId,
  };
  idList.forEach((id, i) => {
    params[`:gid${i}`] = id;
  });
  let sql =
    `SELECT * FROM quality_gates
     WHERE milestone_id = :mid AND slice_id = :sid
       AND status = 'pending'
       AND gate_id IN (${placeholders})`;
  if (taskId !== undefined) {
    sql += ` AND task_id = :tid`;
    params[":tid"] = taskId;
  }
  return getDbOrNull()!.prepare(sql).all(params).map(rowToGate);
}

/**
 * Count pending gates for a turn. Convenience wrapper used by state
 * derivation to decide whether a phase transition should pause.
 */
export function getPendingGateCountForTurn(
  milestoneId: string,
  sliceId: string,
  turn: OwnerTurn,
): number {
  return getPendingGatesForTurn(milestoneId, sliceId, turn).length;
}

export function getMilestoneCommitAttributionShas(milestoneId: string): string[] {
  if (!getDbOrNull()!) return [];
  const rows = getDbOrNull()!.prepare(
    `SELECT commit_sha
     FROM milestone_commit_attributions
     WHERE milestone_id = :mid
     ORDER BY created_at, commit_sha`,
  ).all({ ":mid": milestoneId }) as Array<Record<string, unknown>>;
  return rows
    .map((row) => typeof row["commit_sha"] === "string" ? row["commit_sha"] : "")
    .filter(Boolean);
}
