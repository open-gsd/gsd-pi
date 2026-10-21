// Project/App: gsd-pi
// File Purpose: GSD single-writer barrel + write/read wrappers.
//
// ─── Single-writer invariant ─────────────────────────────────────────────
// Every write-SQL statement against `.gsd/gsd.db` lives behind a typed
// wrapper in the explicit writer allowlist: this compatibility barrel,
// db/writers/*, typed coordination/runtime writers, schema/migration helpers,
// and ADR backfill helpers. Connection ownership, lifecycle, schema/migrations,
// and transaction primitives live in db/engine.ts and are re-exported here for
// backward compatibility, so callers keep importing from "./gsd-db.js".
//
// `_getAdapter()` (re-exported from the engine) is retained for read-only
// SELECTs in query modules. Do NOT use it for writes — add or call a typed
// wrapper in the explicit writer layer.
//
// The separate `.gsd/unit-claims.db` (unit-ownership.ts) is an intentionally
// independent store and is excluded from this invariant.
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { renamePhaseDirOnTitleChange } from "./phase-dir-rename.js";
import type { Decision, Requirement, GateRow, GateId, GateScope, GateStatus, GateVerdict } from "./types.js";
import { GSDError, GSD_STALE_STATE } from "./errors.js";
import { getGateIdsForTurn, type OwnerTurn } from "./gate-registry.js";
import { logError, logWarning } from "./workflow-logger.js";
import { type DbAdapter } from "./db-adapter.js";
import {
  emptyTaskStatusCounts,
  rowToActiveTaskSummary,
  rowToIdStatusSummary,
  rowToTaskStatusCounts,
  rowsToStringColumn,
  type ActiveTaskSummary,
  type IdStatusSummary,
  type TaskStatusCounts,
} from "./db-lightweight-query-rows.js";
import {
  rowToActiveDecision,
  rowToActiveRequirement,
  rowToDecision,
  rowToRequirement,
  rowsToRequirementCounts,
} from "./db-decision-requirement-rows.js";
import { rowToGate } from "./db-gate-rows.js";
import { rowToArtifact, rowToMilestone, type ArtifactRow, type MilestoneRow } from "./db-milestone-artifact-rows.js";
import { isClosedStatus, toStatus } from "./status-guards.js";
import { rowToSlice, rowToTask, type SliceRow, type TaskRow } from "./db-task-slice-rows.js";

// Connection ownership, lifecycle, schema/migrations and transaction
// primitives now live in the engine; re-export the full public surface so
// existing `from "./gsd-db.js"` imports keep working.
export * from "./db/engine.js";
import { immediateTransaction, transaction, getDb, getDbOrNull, getDbPath } from "./db/engine.js";
import { assertNoAdoptedLifecycleHistory } from "./db/writers/import-restore.js";

// ─── Single Writer Layer re-exports ──────────────────────────────────────
// Domain write subsystems live in db/writers/*; re-exported here so callers
// keep importing from "./gsd-db.js".
export * from "./db/writers/memory.js";
export * from "./db/writers/reconcile.js";
export * from "./db/writers/import-restore.js";
export * from "./db/writers/lifecycle-commands.js";
export * from "./db/writers/projection-kind-remediation.js";
export * from "./db/writers/liveness-backstop.js";
export * from "./db/writers/orphan-milestone-discard.js";
export { executeDomainOperation } from "./db/domain-operation.js";
export type {
  DomainJsonValue,
  DomainOperationContext,
  DomainOperationEventInput,
  DomainOperationMutation,
  DomainOperationProjectionInput,
  DomainOperationRequest,
  DomainOperationResult,
} from "./db/domain-operation.js";
export * from "./project-authority-cutover-domain-operation.js";
export * from "./legacy-import-restore-assessment.js";
export * from "./legacy-import-live-restore.js";
// Query Module (read-only seam) — extracted from the single-writer file.
export * from "./db/queries.js";
// Domain Write Operations (Hierarchy Status Cascades).
export * from "./db/writers/cascades.js";

export type { ArtifactRow, MilestoneRow } from "./db-milestone-artifact-rows.js";
export type { ActiveTaskSummary, IdStatusSummary, TaskStatusCounts } from "./db-lightweight-query-rows.js";
export type { SliceRow, TaskRow } from "./db-task-slice-rows.js";

import { TERMINAL_STATUS_SQL } from "./db/sql-constants.js";
import { applyStatusTransition } from "./db/writers/status.js";
export { projectCanonicalStatusToLegacy } from "./db/writers/status.js";
import {
  LAYOUT_SEGMENTS,
  canonicalPhaseDirName,
  milestoneIdToPhaseNum,
} from "./layout-policy.js";

export function insertDecision(d: Omit<Decision, "seq">): void {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  transaction(() => getDbOrNull()!.prepare(
    `INSERT INTO decisions (id, when_context, scope, decision, choice, rationale, revisable, made_by, source, superseded_by)
     VALUES (:id, :when_context, :scope, :decision, :choice, :rationale, :revisable, :made_by, :source, :superseded_by)`,
  ).run({
    ":id": d.id,
    ":when_context": d.when_context,
    ":scope": d.scope,
    ":decision": d.decision,
    ":choice": d.choice,
    ":rationale": d.rationale,
    ":revisable": d.revisable,
    ":made_by": d.made_by ?? "agent",
    ":source": d.source ?? "discussion",
    ":superseded_by": d.superseded_by,
  }));
}



export function insertRequirement(r: Requirement): void {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  transaction(() => getDbOrNull()!.prepare(
    `INSERT INTO requirements (id, class, status, description, why, source, primary_owner, supporting_slices, validation, notes, full_content, superseded_by)
     VALUES (:id, :class, :status, :description, :why, :source, :primary_owner, :supporting_slices, :validation, :notes, :full_content, :superseded_by)`,
  ).run({
    ":id": r.id,
    ":class": r.class,
    ":status": r.status,
    ":description": r.description,
    ":why": r.why,
    ":source": r.source,
    ":primary_owner": r.primary_owner,
    ":supporting_slices": r.supporting_slices,
    ":validation": r.validation,
    ":notes": r.notes,
    ":full_content": r.full_content,
    ":superseded_by": r.superseded_by,
  }));
}




export function upsertDecision(d: Omit<Decision, "seq">): void {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  // Use ON CONFLICT DO UPDATE instead of INSERT OR REPLACE to preserve the
  // seq column. INSERT OR REPLACE deletes then reinserts, resetting seq and
  // corrupting decision ordering in DECISIONS.md after reconcile replay.
  transaction(() => getDbOrNull()!.prepare(
    `INSERT INTO decisions (id, when_context, scope, decision, choice, rationale, revisable, made_by, source, superseded_by)
     VALUES (:id, :when_context, :scope, :decision, :choice, :rationale, :revisable, :made_by, :source, :superseded_by)
     ON CONFLICT(id) DO UPDATE SET
       when_context = excluded.when_context,
       scope = excluded.scope,
       decision = excluded.decision,
       choice = excluded.choice,
       rationale = excluded.rationale,
       revisable = excluded.revisable,
       made_by = excluded.made_by,
       source = excluded.source,
       superseded_by = excluded.superseded_by`,
  ).run({
    ":id": d.id,
    ":when_context": d.when_context,
    ":scope": d.scope,
    ":decision": d.decision,
    ":choice": d.choice,
    ":rationale": d.rationale,
    ":revisable": d.revisable,
    ":made_by": d.made_by ?? "agent",
    ":source": d.source ?? "discussion",
    ":superseded_by": d.superseded_by ?? null,
  }));
}

export function upsertRequirement(r: Requirement): void {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  transaction(() => getDbOrNull()!.prepare(
    `INSERT OR REPLACE INTO requirements (id, class, status, description, why, source, primary_owner, supporting_slices, validation, notes, full_content, superseded_by)
     VALUES (:id, :class, :status, :description, :why, :source, :primary_owner, :supporting_slices, :validation, :notes, :full_content, :superseded_by)`,
  ).run({
    ":id": r.id,
    ":class": r.class,
    ":status": r.status,
    ":description": r.description,
    ":why": r.why,
    ":source": r.source,
    ":primary_owner": r.primary_owner,
    ":supporting_slices": r.supporting_slices,
    ":validation": r.validation,
    ":notes": r.notes,
    ":full_content": r.full_content,
    ":superseded_by": r.superseded_by ?? null,
  }));
}

export function clearArtifacts(): void {
  if (!getDbOrNull()!) return;
  try { transaction(() => getDbOrNull()!.exec("DELETE FROM artifacts")); } catch (e) { logWarning("db", `clearArtifacts failed: ${(e as Error).message}`); }
}

export function clearDecisions(): void {
  if (!getDbOrNull()!) return;
  try { transaction(() => getDbOrNull()!.exec("DELETE FROM decisions")); } catch (e) { logWarning("db", `clearDecisions failed: ${(e as Error).message}`); }
}

export function clearRequirements(): void {
  if (!getDbOrNull()!) return;
  try { transaction(() => getDbOrNull()!.exec("DELETE FROM requirements")); } catch (e) { logWarning("db", `clearRequirements failed: ${(e as Error).message}`); }
}

export function insertArtifact(a: {
  path: string;
  artifact_type: string;
  milestone_id: string | null;
  slice_id: string | null;
  task_id: string | null;
  full_content: string;
}): void {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  const contentHash = createHash("sha256").update(a.full_content).digest("hex");
  transaction(() => getDbOrNull()!.prepare(
    `INSERT OR REPLACE INTO artifacts (path, artifact_type, milestone_id, slice_id, task_id, full_content, imported_at, content_hash)
     VALUES (:path, :artifact_type, :milestone_id, :slice_id, :task_id, :full_content, :imported_at, :content_hash)`,
  ).run({
    ":path": a.path,
    ":artifact_type": a.artifact_type,
    ":milestone_id": a.milestone_id,
    ":slice_id": a.slice_id,
    ":task_id": a.task_id,
    ":full_content": a.full_content,
    ":imported_at": new Date().toISOString(),
    ":content_hash": contentHash,
  }));
}

function reconcileMilestonePhaseArtifactPaths(milestoneId: string, title: string): void {
  const db = getDbOrNull()!;
  const phaseNumPrefix = String(milestoneIdToPhaseNum(milestoneId)).padStart(2, "0");
  const canonicalDir = canonicalPhaseDirName(milestoneId, title);
  const staleRows = db.prepare(
    `SELECT path
       FROM artifacts
      WHERE milestone_id = :milestone_id
        AND path LIKE :phase_prefix`,
  ).all({
    ":milestone_id": milestoneId,
    ":phase_prefix": `${LAYOUT_SEGMENTS.level1}/${phaseNumPrefix}-%/%`,
  }) as Array<{ path: string }>;

  const updatePath = db.prepare("UPDATE artifacts SET path = :new_path WHERE path = :old_path");
  const deletePath = db.prepare("DELETE FROM artifacts WHERE path = :path");
  const existingPath = db.prepare("SELECT 1 AS present FROM artifacts WHERE path = :path");

  for (const row of staleRows) {
    const parts = row.path.split("/");
    if (parts.length < 3) continue;
    if (parts[0] !== LAYOUT_SEGMENTS.level1) continue;
    if (parts[1] === canonicalDir) continue;
    if (!parts[1]?.startsWith(`${phaseNumPrefix}-`)) continue;

    const newPath = [LAYOUT_SEGMENTS.level1, canonicalDir, ...parts.slice(2)].join("/");
    if (existingPath.get({ ":path": newPath })) {
      deletePath.run({ ":path": row.path });
      continue;
    }
    updatePath.run({ ":new_path": newPath, ":old_path": row.path });
  }
}

export interface MilestonePlanningRecord {
  vision: string;
  successCriteria: string[];
  keyRisks: Array<{ risk: string; whyItMatters: string }>;
  proofStrategy: Array<{ riskOrUnknown: string; retireIn: string; whatWillBeProven: string }>;
  verificationContract: string;
  verificationIntegration: string;
  verificationOperational: string;
  verificationUat: string;
  definitionOfDone: string[];
  requirementCoverage: string;
  boundaryMapMarkdown: string;
}

export interface SlicePlanningRecord {
  goal: string;
  successCriteria: string;
  proofLevel: string;
  integrationClosure: string;
  observabilityImpact: string;
  targetRepositories?: string[];
}

export interface TaskPlanningRecord {
  title?: string;
  description: string;
  estimate: string;
  files: string[];
  verify: string;
  inputs: string[];
  expectedOutput: string[];
  requiredWorkflowTools: string[];
  observabilityImpact: string;
  fullPlanMd?: string;
  targetRepositories?: string[];
}

export function insertMilestone(m: {
  id: string;
  title?: string;
  status?: string;
  depends_on?: string[];
  planning?: Partial<MilestonePlanningRecord>;
}): boolean {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  const result = transaction(() => getDbOrNull()!.prepare(
    `INSERT OR IGNORE INTO milestones (
      id, title, status, depends_on, created_at,
      vision, success_criteria, key_risks, proof_strategy,
      verification_contract, verification_integration, verification_operational, verification_uat,
      definition_of_done, requirement_coverage, boundary_map_markdown
    ) VALUES (
      :id, :title, :status, :depends_on, :created_at,
      :vision, :success_criteria, :key_risks, :proof_strategy,
      :verification_contract, :verification_integration, :verification_operational, :verification_uat,
      :definition_of_done, :requirement_coverage, :boundary_map_markdown
    )`,
  ).run({
    ":id": m.id,
    ":title": m.title ?? "",
    // Default to "queued" — never auto-create milestones as "active" (#3380).
    // Callers that need "active" must pass it explicitly.
    ":status": m.status ?? "queued",
    ":depends_on": JSON.stringify(m.depends_on ?? []),
    ":created_at": new Date().toISOString(),
    ":vision": m.planning?.vision ?? "",
    ":success_criteria": JSON.stringify(m.planning?.successCriteria ?? []),
    ":key_risks": JSON.stringify(m.planning?.keyRisks ?? []),
    ":proof_strategy": JSON.stringify(m.planning?.proofStrategy ?? []),
    ":verification_contract": m.planning?.verificationContract ?? "",
    ":verification_integration": m.planning?.verificationIntegration ?? "",
    ":verification_operational": m.planning?.verificationOperational ?? "",
    ":verification_uat": m.planning?.verificationUat ?? "",
    ":definition_of_done": JSON.stringify(m.planning?.definitionOfDone ?? []),
    ":requirement_coverage": m.planning?.requirementCoverage ?? "",
    ":boundary_map_markdown": m.planning?.boundaryMapMarkdown ?? "",
  })) as { changes?: number };
  return (result.changes ?? 0) > 0;
}

export function upsertMilestonePlanning(milestoneId: string, planning: Partial<MilestonePlanningRecord> & { title?: string; status?: string; depends_on?: string[] }): void {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  const previousTitle = (getDbOrNull()!.prepare(
    "SELECT title FROM milestones WHERE id = :id",
  ).get({ ":id": milestoneId }) as { title?: string } | undefined)?.title;
  transaction(() => {
    if (planning.status !== undefined && planning.status !== "") {
      applyStatusTransition({
        entity: "milestone",
        milestoneId,
        status: planning.status,
        preserveCompletion: true,
      });
    }
    getDbOrNull()!.prepare(
      `UPDATE milestones SET
        title = COALESCE(NULLIF(:title, ''), title),
        depends_on = COALESCE(:depends_on, depends_on),
        vision = COALESCE(:vision, vision),
        success_criteria = COALESCE(:success_criteria, success_criteria),
        key_risks = COALESCE(:key_risks, key_risks),
        proof_strategy = COALESCE(:proof_strategy, proof_strategy),
        verification_contract = COALESCE(:verification_contract, verification_contract),
        verification_integration = COALESCE(:verification_integration, verification_integration),
        verification_operational = COALESCE(:verification_operational, verification_operational),
        verification_uat = COALESCE(:verification_uat, verification_uat),
        definition_of_done = COALESCE(:definition_of_done, definition_of_done),
        requirement_coverage = COALESCE(:requirement_coverage, requirement_coverage),
        boundary_map_markdown = COALESCE(:boundary_map_markdown, boundary_map_markdown)
       WHERE id = :id`,
    ).run({
      ":id": milestoneId,
      ":title": planning.title ?? "",
      ":depends_on": planning.depends_on ? JSON.stringify(planning.depends_on) : null,
      ":vision": planning.vision ?? null,
      ":success_criteria": planning.successCriteria ? JSON.stringify(planning.successCriteria) : null,
      ":key_risks": planning.keyRisks ? JSON.stringify(planning.keyRisks) : null,
      ":proof_strategy": planning.proofStrategy ? JSON.stringify(planning.proofStrategy) : null,
      ":verification_contract": planning.verificationContract ?? null,
      ":verification_integration": planning.verificationIntegration ?? null,
      ":verification_operational": planning.verificationOperational ?? null,
      ":verification_uat": planning.verificationUat ?? null,
      ":definition_of_done": planning.definitionOfDone ? JSON.stringify(planning.definitionOfDone) : null,
      ":requirement_coverage": planning.requirementCoverage ?? null,
      ":boundary_map_markdown": planning.boundaryMapMarkdown ?? null,
    });
    const finalTitle = planning.title?.trim();
    if (finalTitle) reconcileMilestonePhaseArtifactPaths(milestoneId, finalTitle);
  });
  const finalTitle = planning.title?.trim();
  const dbPath = getDbPath();
  if (finalTitle && dbPath && dbPath !== ":memory:") {
    try {
      renamePhaseDirOnTitleChange(dirname(dirname(dbPath)), milestoneId, previousTitle, finalTitle);
    } catch (error) {
      logWarning("db", `phase dir rename after title update failed: ${(error as Error).message}`);
    }
  }
}

export function insertSlice(s: {
  id: string;
  milestoneId: string;
  title?: string;
  status?: string;
  risk?: string;
  depends?: string[];
  demo?: string;
  sequence?: number;
  isSketch?: boolean;
  sketchScope?: string;
  planning?: Partial<SlicePlanningRecord>;
}): void {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  const SLICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
  const invalidDep = (s.depends ?? []).find(d => !SLICE_ID_RE.test(d));
  if (invalidDep !== undefined) {
    throw new GSDError(GSD_STALE_STATE, `insertSlice: depends element "${invalidDep}" is not a valid slice ID`);
  }
  transaction(() => getDbOrNull()!.prepare(
    `INSERT INTO slices (
      milestone_id, id, title, status, risk, depends, demo, created_at,
      goal, success_criteria, proof_level, integration_closure, observability_impact, target_repositories, sequence,
      is_sketch, sketch_scope
    ) VALUES (
      :milestone_id, :id, :title, :status, :risk, :depends, :demo, :created_at,
      :goal, :success_criteria, :proof_level, :integration_closure, :observability_impact, :target_repositories, :sequence,
      :is_sketch, :sketch_scope
    )
    ON CONFLICT (milestone_id, id) DO UPDATE SET
      title = CASE WHEN :raw_title IS NOT NULL THEN excluded.title ELSE slices.title END,
      status = CASE
        WHEN slices.status IN (${TERMINAL_STATUS_SQL}) OR EXISTS (
          SELECT 1 FROM workflow_item_lifecycles lifecycle
          WHERE lifecycle.project_id = (SELECT project_id FROM project_authority WHERE singleton = 1)
            AND lifecycle.item_kind = 'slice'
            AND lifecycle.milestone_id = slices.milestone_id
            AND lifecycle.slice_id = slices.id
            AND lifecycle.task_id IS NULL
        ) THEN slices.status
        ELSE excluded.status
      END,
      risk = CASE WHEN :raw_risk IS NOT NULL THEN excluded.risk ELSE slices.risk END,
      depends = excluded.depends,
      demo = CASE WHEN :raw_demo IS NOT NULL THEN excluded.demo ELSE slices.demo END,
      goal = CASE WHEN :raw_goal IS NOT NULL THEN excluded.goal ELSE slices.goal END,
      success_criteria = CASE WHEN :raw_success_criteria IS NOT NULL THEN excluded.success_criteria ELSE slices.success_criteria END,
      proof_level = CASE WHEN :raw_proof_level IS NOT NULL THEN excluded.proof_level ELSE slices.proof_level END,
      integration_closure = CASE WHEN :raw_integration_closure IS NOT NULL THEN excluded.integration_closure ELSE slices.integration_closure END,
      observability_impact = CASE WHEN :raw_observability_impact IS NOT NULL THEN excluded.observability_impact ELSE slices.observability_impact END,
      target_repositories = CASE WHEN :raw_target_repositories IS NOT NULL THEN excluded.target_repositories ELSE slices.target_repositories END,
      sequence = CASE WHEN :raw_sequence IS NOT NULL THEN excluded.sequence ELSE slices.sequence END,
      is_sketch = CASE WHEN :raw_is_sketch IS NOT NULL THEN excluded.is_sketch ELSE slices.is_sketch END,
      sketch_scope = CASE WHEN :raw_sketch_scope IS NOT NULL THEN excluded.sketch_scope ELSE slices.sketch_scope END`,
  ).run({
    ":milestone_id": s.milestoneId,
    ":id": s.id,
    ":title": s.title ?? "",
    ":status": s.status ?? "pending",
    ":risk": s.risk ?? "medium",
    ":depends": JSON.stringify(s.depends ?? []),
    ":demo": s.demo ?? "",
    ":created_at": new Date().toISOString(),
    ":goal": s.planning?.goal ?? "",
    ":success_criteria": s.planning?.successCriteria ?? "",
    ":proof_level": s.planning?.proofLevel ?? "",
    ":integration_closure": s.planning?.integrationClosure ?? "",
    ":observability_impact": s.planning?.observabilityImpact ?? "",
    ":target_repositories": JSON.stringify(s.planning?.targetRepositories ?? []),
    ":sequence": s.sequence ?? 0,
    ":is_sketch": s.isSketch ? 1 : 0,
    ":sketch_scope": s.sketchScope ?? "",
    // Raw sentinel params: NULL when caller omitted the field, used in ON CONFLICT guards
    ":raw_title": s.title ?? null,
    ":raw_risk": s.risk ?? null,
    ":raw_demo": s.demo ?? null,
    ":raw_goal": s.planning?.goal ?? null,
    ":raw_success_criteria": s.planning?.successCriteria ?? null,
    ":raw_proof_level": s.planning?.proofLevel ?? null,
    ":raw_integration_closure": s.planning?.integrationClosure ?? null,
    ":raw_observability_impact": s.planning?.observabilityImpact ?? null,
    ":raw_target_repositories": s.planning?.targetRepositories ? JSON.stringify(s.planning.targetRepositories) : null,
    ":raw_sequence": s.sequence ?? null,
    ":raw_is_sketch": s.isSketch === undefined ? null : (s.isSketch ? 1 : 0),
    // NOTE: use !== undefined (not ??) so an explicit empty string "" is treated
    // as a present value and correctly clears the existing sketch_scope on
    // CONFLICT. ?? would incorrectly preserve the stale value.
    ":raw_sketch_scope": s.sketchScope !== undefined ? s.sketchScope : null,
  }));
}

// ADR-011: sketch-then-refine helpers
export function setSliceSketchFlag(milestoneId: string, sliceId: string, isSketch: boolean): void {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  transaction(() => getDbOrNull()!.prepare(
    `UPDATE slices SET is_sketch = :is_sketch WHERE milestone_id = :mid AND id = :sid`,
  ).run({ ":is_sketch": isSketch ? 1 : 0, ":mid": milestoneId, ":sid": sliceId }));
}


export function upsertSlicePlanning(milestoneId: string, sliceId: string, planning: Partial<SlicePlanningRecord>): void {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  const result = transaction(() => getDbOrNull()!.prepare(
    `UPDATE slices SET
      goal = COALESCE(:goal, goal),
      success_criteria = COALESCE(:success_criteria, success_criteria),
      proof_level = COALESCE(:proof_level, proof_level),
      integration_closure = COALESCE(:integration_closure, integration_closure),
      observability_impact = COALESCE(:observability_impact, observability_impact),
      target_repositories = COALESCE(:target_repositories, target_repositories)
     WHERE milestone_id = :milestone_id AND id = :id`,
  ).run({
    ":milestone_id": milestoneId,
    ":id": sliceId,
    ":goal": planning.goal ?? null,
    ":success_criteria": planning.successCriteria ?? null,
    ":proof_level": planning.proofLevel ?? null,
    ":integration_closure": planning.integrationClosure ?? null,
    ":observability_impact": planning.observabilityImpact ?? null,
    ":target_repositories": planning.targetRepositories ? JSON.stringify(planning.targetRepositories) : null,
  })) as { changes?: number };

  // #1565: an UPDATE that matches no row is not a successful upsert. Without
  // this check gsd_plan_slice reports "Planned slice S04 (M004)" and writes the
  // PLAN file even though no slice row exists for that milestone id — planning
  // state then silently diverges from the DB (and the drift detector later
  // blocks on the orphaned plan file). Fail loudly instead.
  if ((result.changes ?? 0) === 0) {
    throw new GSDError(
      GSD_STALE_STATE,
      `gsd-db: no slice row for ${milestoneId}/${sliceId} — slice planning update affected 0 rows`,
    );
  }
}

export function insertTask(t: {
  id: string;
  sliceId: string;
  milestoneId: string;
  title?: string;
  status?: string;
  oneLiner?: string;
  narrative?: string;
  verificationResult?: string;
  duration?: string;
  blockerDiscovered?: boolean;
  deviations?: string;
  knownIssues?: string;
  keyFiles?: string[];
  keyDecisions?: string[];
  fullSummaryMd?: string;
  sequence?: number;
  planning?: Partial<TaskPlanningRecord>;
  // #1222 (metadata half): when re-importing from markdown, the caller only
  // knows the plan/status — not the execution prose that gsd_task_complete
  // wrote to the DB. Setting this preserves the existing row's execution
  // columns (and completed_at) whenever the incoming value is empty/default,
  // so a re-import cannot silently blank a completed task's summary metadata
  // or refresh its completion timestamp. Off by default: callers that own the
  // execution metadata (gsd_task_complete, planning) keep overwrite semantics.
  preserveCompletionMetadata?: boolean;
}): void {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  // Stamp completed_at for every terminal-complete alias (complete/done/closed),
  // not just two literals — a task imported as "closed" is completed and must
  // carry a timestamp. NOT for "skipped": a skipped task was never completed
  // (cascade writers set its completed_at = NULL).
  const isCompleteAlias = t.status != null && toStatus(t.status) === "complete";
  transaction(() => getDbOrNull()!.prepare(
    `INSERT INTO tasks (
      milestone_id, slice_id, id, title, status, one_liner, narrative,
      verification_result, duration, completed_at, blocker_discovered,
      deviations, known_issues, key_files, key_decisions, full_summary_md,
      description, estimate, files, verify, inputs, expected_output,
      required_workflow_tools, observability_impact, full_plan_md, target_repositories, sequence
    ) VALUES (
      :milestone_id, :slice_id, :id, :title, :status, :one_liner, :narrative,
      :verification_result, :duration, :completed_at, :blocker_discovered,
      :deviations, :known_issues, :key_files, :key_decisions, :full_summary_md,
      :description, :estimate, :files, :verify, :inputs, :expected_output,
      :required_workflow_tools, :observability_impact, :full_plan_md, :target_repositories, :sequence
    )
    ON CONFLICT(milestone_id, slice_id, id) DO UPDATE SET
      title = CASE WHEN NULLIF(:title, '') IS NOT NULL THEN :title ELSE tasks.title END,
      status = CASE WHEN EXISTS (
        SELECT 1 FROM workflow_item_lifecycles lifecycle
        WHERE lifecycle.project_id = (SELECT project_id FROM project_authority WHERE singleton = 1)
          AND lifecycle.item_kind = 'task'
          AND lifecycle.milestone_id = tasks.milestone_id
          AND lifecycle.slice_id = tasks.slice_id
          AND lifecycle.task_id = tasks.id
      ) THEN tasks.status ELSE :status END,
      one_liner = CASE WHEN :preserve_completion = 1 AND NULLIF(:one_liner, '') IS NULL THEN tasks.one_liner ELSE :one_liner END,
      narrative = CASE WHEN :preserve_completion = 1 AND NULLIF(:narrative, '') IS NULL THEN tasks.narrative ELSE :narrative END,
      verification_result = CASE WHEN :preserve_completion = 1 AND NULLIF(:verification_result, '') IS NULL THEN tasks.verification_result ELSE :verification_result END,
      duration = CASE WHEN :preserve_completion = 1 AND NULLIF(:duration, '') IS NULL THEN tasks.duration ELSE :duration END,
      completed_at = CASE
        WHEN EXISTS (
          SELECT 1 FROM workflow_item_lifecycles lifecycle
          WHERE lifecycle.project_id = (SELECT project_id FROM project_authority WHERE singleton = 1)
            AND lifecycle.item_kind = 'task'
            AND lifecycle.milestone_id = tasks.milestone_id
            AND lifecycle.slice_id = tasks.slice_id
            AND lifecycle.task_id = tasks.id
        ) THEN tasks.completed_at
        WHEN :preserve_completion = 1 AND tasks.completed_at IS NOT NULL THEN tasks.completed_at
        ELSE :completed_at
      END,
      blocker_discovered = CASE WHEN :preserve_completion = 1 AND :blocker_discovered = 0 THEN tasks.blocker_discovered ELSE :blocker_discovered END,
      deviations = CASE WHEN :preserve_completion = 1 AND NULLIF(:deviations, '') IS NULL THEN tasks.deviations ELSE :deviations END,
      known_issues = CASE WHEN :preserve_completion = 1 AND NULLIF(:known_issues, '') IS NULL THEN tasks.known_issues ELSE :known_issues END,
      key_files = CASE WHEN :preserve_completion = 1 AND NULLIF(:key_files, '[]') IS NULL THEN tasks.key_files ELSE :key_files END,
      key_decisions = CASE WHEN :preserve_completion = 1 AND NULLIF(:key_decisions, '[]') IS NULL THEN tasks.key_decisions ELSE :key_decisions END,
      full_summary_md = CASE WHEN :preserve_completion = 1 AND NULLIF(:full_summary_md, '') IS NULL THEN tasks.full_summary_md ELSE :full_summary_md END,
      description = CASE WHEN NULLIF(:description, '') IS NOT NULL THEN :description ELSE tasks.description END,
      estimate = CASE WHEN NULLIF(:estimate, '') IS NOT NULL THEN :estimate ELSE tasks.estimate END,
      files = CASE WHEN NULLIF(:files, '[]') IS NOT NULL THEN :files ELSE tasks.files END,
      verify = CASE WHEN NULLIF(:verify, '') IS NOT NULL THEN :verify ELSE tasks.verify END,
      inputs = CASE WHEN NULLIF(:inputs, '[]') IS NOT NULL THEN :inputs ELSE tasks.inputs END,
      expected_output = CASE WHEN NULLIF(:expected_output, '[]') IS NOT NULL THEN :expected_output ELSE tasks.expected_output END,
      required_workflow_tools = CASE
        WHEN :raw_required_workflow_tools IS NOT NULL THEN :required_workflow_tools
        ELSE tasks.required_workflow_tools
      END,
      observability_impact = CASE WHEN NULLIF(:observability_impact, '') IS NOT NULL THEN :observability_impact ELSE tasks.observability_impact END,
      full_plan_md = CASE WHEN NULLIF(:full_plan_md, '') IS NOT NULL THEN :full_plan_md ELSE tasks.full_plan_md END,
      sequence = :sequence,
      target_repositories = CASE
        WHEN :raw_target_repositories IS NOT NULL THEN :target_repositories
        ELSE tasks.target_repositories
      END`,
  ).run({
    ":milestone_id": t.milestoneId,
    ":slice_id": t.sliceId,
    ":id": t.id,
    ":title": t.title ?? "",
    ":status": t.status ?? "pending",
    ":one_liner": t.oneLiner ?? "",
    ":narrative": t.narrative ?? "",
    ":verification_result": t.verificationResult ?? "",
    ":duration": t.duration ?? "",
    ":completed_at": isCompleteAlias ? new Date().toISOString() : null,
    ":blocker_discovered": t.blockerDiscovered ? 1 : 0,
    ":deviations": t.deviations ?? "",
    ":known_issues": t.knownIssues ?? "",
    ":key_files": JSON.stringify(t.keyFiles ?? []),
    ":key_decisions": JSON.stringify(t.keyDecisions ?? []),
    ":full_summary_md": t.fullSummaryMd ?? "",
    ":description": t.planning?.description ?? "",
    ":estimate": t.planning?.estimate ?? "",
    ":files": JSON.stringify(t.planning?.files ?? []),
    ":verify": t.planning?.verify ?? "",
    ":inputs": JSON.stringify(t.planning?.inputs ?? []),
    ":expected_output": JSON.stringify(t.planning?.expectedOutput ?? []),
    ":required_workflow_tools": JSON.stringify(t.planning?.requiredWorkflowTools ?? []),
    ":raw_required_workflow_tools":
      t.planning && "requiredWorkflowTools" in t.planning
        ? JSON.stringify(t.planning.requiredWorkflowTools ?? [])
        : null,
    ":observability_impact": t.planning?.observabilityImpact ?? "",
    ":full_plan_md": t.planning?.fullPlanMd ?? "",
    ":sequence": t.sequence ?? 0,
    ":preserve_completion": t.preserveCompletionMetadata && isCompleteAlias ? 1 : 0,
    ":target_repositories": JSON.stringify(t.planning?.targetRepositories ?? []),
    ":raw_target_repositories":
      t.planning && "targetRepositories" in t.planning
        ? JSON.stringify(t.planning.targetRepositories ?? [])
        : null,
  }));
}

export function updateTaskStatus(milestoneId: string, sliceId: string, taskId: string, status: string, completedAt?: string): void {
  applyStatusTransition({ entity: "task", milestoneId, sliceId, taskId, status, completedAt });
}

export function repairTaskCompletionFromSummary(t: {
  milestoneId: string;
  sliceId: string;
  taskId: string;
  title?: string;
  oneLiner?: string;
  narrative?: string;
  verificationResult: string;
  duration?: string;
  completedAt: string;
  blockerDiscovered?: boolean;
  deviations?: string;
  knownIssues?: string;
  keyFiles?: string[];
  keyDecisions?: string[];
  fullSummaryMd: string;
}): void {
  const db = getDbOrNull();
  if (!db) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  transaction(() => {
    const seq = db.prepare(
      `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
       FROM tasks
       WHERE milestone_id = :mid AND slice_id = :sid`,
    ).get({ ":mid": t.milestoneId, ":sid": t.sliceId }) as { next_sequence?: number } | undefined;
    db.prepare(
      `INSERT INTO tasks (
        milestone_id, slice_id, id, title, status, one_liner, narrative,
        verification_result, duration, completed_at, blocker_discovered,
        deviations, known_issues, key_files, key_decisions, full_summary_md,
        sequence
      ) VALUES (
        :milestone_id, :slice_id, :id, :title, 'complete', :one_liner, :narrative,
        :verification_result, :duration, :completed_at, :blocker_discovered,
        :deviations, :known_issues, :key_files, :key_decisions, :full_summary_md,
        :sequence
      )
      ON CONFLICT(milestone_id, slice_id, id) DO UPDATE SET
        title = CASE WHEN NULLIF(:title, '') IS NOT NULL THEN :title ELSE tasks.title END,
        status = 'complete',
        one_liner = CASE WHEN NULLIF(:one_liner, '') IS NOT NULL THEN :one_liner ELSE tasks.one_liner END,
        narrative = CASE WHEN NULLIF(:narrative, '') IS NOT NULL THEN :narrative ELSE tasks.narrative END,
        verification_result = :verification_result,
        duration = CASE WHEN NULLIF(:duration, '') IS NOT NULL THEN :duration ELSE tasks.duration END,
        completed_at = :completed_at,
        blocker_discovered = :blocker_discovered,
        deviations = CASE WHEN NULLIF(:deviations, '') IS NOT NULL THEN :deviations ELSE tasks.deviations END,
        known_issues = CASE WHEN NULLIF(:known_issues, '') IS NOT NULL THEN :known_issues ELSE tasks.known_issues END,
        key_files = :key_files,
        key_decisions = :key_decisions,
        full_summary_md = :full_summary_md`,
    ).run({
      ":milestone_id": t.milestoneId,
      ":slice_id": t.sliceId,
      ":id": t.taskId,
      ":title": t.title ?? "",
      ":one_liner": t.oneLiner ?? "",
      ":narrative": t.narrative ?? "",
      ":verification_result": t.verificationResult,
      ":duration": t.duration ?? "",
      ":completed_at": t.completedAt,
      ":blocker_discovered": t.blockerDiscovered ? 1 : 0,
      ":deviations": t.deviations ?? "",
      ":known_issues": t.knownIssues ?? "",
      ":key_files": JSON.stringify(t.keyFiles ?? []),
      ":key_decisions": JSON.stringify(t.keyDecisions ?? []),
      ":full_summary_md": t.fullSummaryMd,
      ":sequence": seq?.next_sequence ?? 1,
    });
  });
}

export function setTaskBlockerDiscovered(milestoneId: string, sliceId: string, taskId: string, discovered: boolean): void {
  if (!getDbOrNull()!) return;
  transaction(() => getDbOrNull()!.prepare(
    `UPDATE tasks SET blocker_discovered = :discovered WHERE milestone_id = :mid AND slice_id = :sid AND id = :tid`,
  ).run({ ":discovered": discovered ? 1 : 0, ":mid": milestoneId, ":sid": sliceId, ":tid": taskId }));
}

export function upsertTaskPlanning(milestoneId: string, sliceId: string, taskId: string, planning: Partial<TaskPlanningRecord>): void {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  transaction(() => getDbOrNull()!.prepare(
    `UPDATE tasks SET
      title = COALESCE(:title, title),
      description = COALESCE(:description, description),
      estimate = COALESCE(:estimate, estimate),
      files = COALESCE(:files, files),
      verify = COALESCE(:verify, verify),
      inputs = COALESCE(:inputs, inputs),
      expected_output = COALESCE(:expected_output, expected_output),
      required_workflow_tools = COALESCE(:required_workflow_tools, required_workflow_tools),
      observability_impact = COALESCE(:observability_impact, observability_impact),
      full_plan_md = COALESCE(:full_plan_md, full_plan_md),
      target_repositories = COALESCE(:target_repositories, target_repositories)
     WHERE milestone_id = :milestone_id AND slice_id = :slice_id AND id = :id`,
  ).run({
    ":milestone_id": milestoneId,
    ":slice_id": sliceId,
    ":id": taskId,
    ":title": planning.title ?? null,
    ":description": planning.description ?? null,
    ":estimate": planning.estimate ?? null,
    ":files": planning.files ? JSON.stringify(planning.files) : null,
    ":verify": planning.verify ?? null,
    ":inputs": planning.inputs ? JSON.stringify(planning.inputs) : null,
    ":expected_output": planning.expectedOutput ? JSON.stringify(planning.expectedOutput) : null,
    ":required_workflow_tools": planning.requiredWorkflowTools ? JSON.stringify(planning.requiredWorkflowTools) : null,
    ":observability_impact": planning.observabilityImpact ?? null,
    ":full_plan_md": planning.fullPlanMd ?? null,
    ":target_repositories": planning.targetRepositories ? JSON.stringify(planning.targetRepositories) : null,
  }));
}


export function updateSliceStatus(milestoneId: string, sliceId: string, status: string, completedAt?: string, preserveCompletion?: boolean): void {
  applyStatusTransition({ entity: "slice", milestoneId, sliceId, status, completedAt, preserveCompletion });
}

export function setTaskSummaryMd(milestoneId: string, sliceId: string, taskId: string, md: string): void {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  transaction(() => getDbOrNull()!.prepare(
    `UPDATE tasks SET full_summary_md = :md WHERE milestone_id = :mid AND slice_id = :sid AND id = :tid`,
  ).run({ ":mid": milestoneId, ":sid": sliceId, ":tid": taskId, ":md": md }));
}

export function clearTaskSummaryProjectionState(milestoneId: string, sliceId: string, taskId: string): void {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  transaction(() => {
    getDbOrNull()!.prepare(
      `UPDATE tasks SET full_summary_md = '' WHERE milestone_id = :mid AND slice_id = :sid AND id = :tid`,
    ).run({ ":mid": milestoneId, ":sid": sliceId, ":tid": taskId });
    getDbOrNull()!.prepare(
      `DELETE FROM artifacts
       WHERE artifact_type = 'SUMMARY'
         AND milestone_id = :mid AND slice_id = :sid AND task_id = :tid`,
    ).run({ ":mid": milestoneId, ":sid": sliceId, ":tid": taskId });
  });
}

export function setSliceSummaryMd(milestoneId: string, sliceId: string, summaryMd: string, uatMd: string): void {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  transaction(() => getDbOrNull()!.prepare(
    `UPDATE slices SET full_summary_md = :summary_md, full_uat_md = :uat_md WHERE milestone_id = :mid AND id = :sid`,
  ).run({ ":mid": milestoneId, ":sid": sliceId, ":summary_md": summaryMd, ":uat_md": uatMd }));
}

/**
 * Update only the slice's UAT carrier column (full_uat_md), leaving the summary
 * carrier untouched. Returns false when no matching slice row exists so callers
 * can fail loudly instead of persisting a no-op.
 */
export function setSliceUatMd(milestoneId: string, sliceId: string, uatMd: string): boolean {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  const updated = transaction(() => getDbOrNull()!.prepare(
    `UPDATE slices SET full_uat_md = :uat_md WHERE milestone_id = :mid AND id = :sid`,
  ).run({ ":mid": milestoneId, ":sid": sliceId, ":uat_md": uatMd }));
  return Number((updated as { changes?: number }).changes ?? 0) === 1;
}





// ─── ADR-011 Phase 2 escalation helpers ──────────────────────────────────

/** Set pause-on-escalation state on a completed task. Mutually exclusive with awaiting_review. */
export function setTaskEscalationPending(
  milestoneId: string, sliceId: string, taskId: string,
  artifactPath: string,
): void {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  transaction(() => getDbOrNull()!.prepare(
    `UPDATE tasks
       SET escalation_pending = 1,
           escalation_awaiting_review = 0,
           escalation_artifact_path = :path
     WHERE milestone_id = :mid AND slice_id = :sid AND id = :tid`,
  ).run({ ":path": artifactPath, ":mid": milestoneId, ":sid": sliceId, ":tid": taskId }));
}

/** Set awaiting-review state (artifact exists and requires explicit user review). Mutually exclusive with pending. */
export function setTaskEscalationAwaitingReview(
  milestoneId: string, sliceId: string, taskId: string,
  artifactPath: string,
): void {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  transaction(() => getDbOrNull()!.prepare(
    `UPDATE tasks
       SET escalation_awaiting_review = 1,
           escalation_pending = 0,
           escalation_artifact_path = :path
     WHERE milestone_id = :mid AND slice_id = :sid AND id = :tid`,
  ).run({ ":path": artifactPath, ":mid": milestoneId, ":sid": sliceId, ":tid": taskId }));
}

/** Clear escalation-pending and awaiting-review flags once the user has resolved it. */
export function clearTaskEscalationFlags(
  milestoneId: string, sliceId: string, taskId: string,
): void {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  transaction(() => getDbOrNull()!.prepare(
    `UPDATE tasks
       SET escalation_pending = 0,
           escalation_awaiting_review = 0
     WHERE milestone_id = :mid AND slice_id = :sid AND id = :tid`,
  ).run({ ":mid": milestoneId, ":sid": sliceId, ":tid": taskId }));
}

/**
 * Atomically claim a resolved escalation override for injection into a downstream
 * task's prompt. Returns true if this caller claimed it (must inject), false if
 * another caller already claimed it (must skip).
 */
export function claimEscalationOverride(
  milestoneId: string, sliceId: string, sourceTaskId: string,
): boolean {
  if (!getDbOrNull()!) return false;
  return immediateTransaction(() => {
    const now = new Date().toISOString();
    const result = getDbOrNull()!.prepare(
      `UPDATE tasks
         SET escalation_override_applied_at = :now
       WHERE milestone_id = :mid AND slice_id = :sid AND id = :tid
         AND escalation_override_applied_at IS NULL
         AND escalation_artifact_path IS NOT NULL`,
    ).run({ ":now": now, ":mid": milestoneId, ":sid": sliceId, ":tid": sourceTaskId });
    // node:sqlite surfaces `changes` on the run result.
    const changes = (result as { changes?: number }).changes ?? 0;
    return changes > 0;
  });
}


/** Set the blocker_source provenance field (used when rejecting an escalation). */
export function setTaskBlockerSource(
  milestoneId: string, sliceId: string, taskId: string, source: string,
): void {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  transaction(() => getDbOrNull()!.prepare(
    `UPDATE tasks
       SET blocker_discovered = 1,
           blocker_source = :src
     WHERE milestone_id = :mid AND slice_id = :sid AND id = :tid`,
  ).run({ ":src": source, ":mid": milestoneId, ":sid": sliceId, ":tid": taskId }));
}


export function insertVerificationEvidence(e: {
  taskId: string;
  sliceId: string;
  milestoneId: string;
  command: string;
  exitCode: number;
  verdict: string;
  durationMs: number;
}): void {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  transaction(() => getDbOrNull()!.prepare(
    `INSERT OR IGNORE INTO verification_evidence (task_id, slice_id, milestone_id, command, exit_code, verdict, duration_ms, created_at)
     VALUES (:task_id, :slice_id, :milestone_id, :command, :exit_code, :verdict, :duration_ms, :created_at)`,
  ).run({
    ":task_id": e.taskId,
    ":slice_id": e.sliceId,
    ":milestone_id": e.milestoneId,
    ":command": e.command,
    ":exit_code": e.exitCode,
    ":verdict": e.verdict,
    ":duration_ms": e.durationMs,
    ":created_at": new Date().toISOString(),
  }));
}





export function setMilestoneQueueOrder(order: string[]): void {
  const db = getDb();
  immediateTransaction(() => {
    db.prepare("UPDATE milestones SET sequence = 0").run();
    const stmt = db.prepare("UPDATE milestones SET sequence = :sequence WHERE id = :id");
    order.forEach((id, index) => {
      stmt.run({ ":id": id, ":sequence": index + 1 });
    });
  });
}

function getMilestoneStatusForUpdate(milestoneId: string): string | null {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  const row = getDbOrNull()!.prepare("SELECT status FROM milestones WHERE id = :id").get({ ":id": milestoneId });
  return typeof row?.["status"] === "string" ? row["status"] : null;
}

function writeMilestoneStatus(milestoneId: string, status: string, completedAt?: string | null): void {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  getDbOrNull()!.prepare(
    `UPDATE milestones SET status = :status, completed_at = :completed_at WHERE id = :id`,
  ).run({ ":status": status, ":completed_at": completedAt ?? null, ":id": milestoneId });
}

/**
 * Update a milestone's status in the database.
 *
 * Generic status updates may close unadopted milestones, park/unpark open
 * milestones, or advance planned milestones. Adopted milestones close through
 * the canonical operation. Closed milestones reopen through
 * reopenMilestoneStatus(), which is reserved for gsd_milestone_reopen.
 */
export function updateMilestoneStatus(milestoneId: string, status: string, completedAt?: string | null, preserveCompletion?: boolean): void {
  applyStatusTransition({ entity: "milestone", milestoneId, status, completedAt, preserveCompletion });
}

/**
 * Explicit closed -> active transition for gsd_milestone_reopen only.
 */
export function reopenMilestoneStatus(milestoneId: string): void {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  immediateTransaction(() => {
    const currentStatus = getMilestoneStatusForUpdate(milestoneId);
    if (!currentStatus) {
      throw new Error(`Cannot reopen missing milestone ${milestoneId}`);
    }
    if (!isClosedStatus(currentStatus)) {
      throw new Error(`Cannot reopen milestone ${milestoneId} from status ${currentStatus}; milestone is not closed.`);
    }
    writeMilestoneStatus(milestoneId, "active", null);
  });
}






// ─── Lightweight Query Variants (hot-path optimized) ─────────────────────





// ─── Slice Dependencies (junction table) ─────────────────────────────────

/** Sync the slice_dependencies junction table from a slice's JSON depends array. */
export function syncSliceDependencies(milestoneId: string, sliceId: string, depends: string[]): void {
  if (!getDbOrNull()!) return;
  immediateTransaction(() => {
    getDbOrNull()!.prepare(
      "DELETE FROM slice_dependencies WHERE milestone_id = :mid AND slice_id = :sid",
    ).run({ ":mid": milestoneId, ":sid": sliceId });
    for (const dep of depends) {
      getDbOrNull()!.prepare(
        "INSERT OR IGNORE INTO slice_dependencies (milestone_id, slice_id, depends_on_slice_id) VALUES (:mid, :sid, :dep)",
      ).run({ ":mid": milestoneId, ":sid": sliceId, ":dep": dep });
    }
  });
}


// ─── Worktree DB Helpers ──────────────────────────────────────────────────

export function insertReplanHistory(entry: {
  milestoneId: string;
  sliceId?: string | null;
  taskId?: string | null;
  summary: string;
  previousArtifactPath?: string | null;
  replacementArtifactPath?: string | null;
}): void {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  // INSERT OR REPLACE: idempotent on (milestone_id, slice_id, task_id) via schema v11 unique index.
  // Retrying the same replan silently updates summary instead of accumulating duplicate rows.
  transaction(() => getDbOrNull()!.prepare(
    `INSERT OR REPLACE INTO replan_history (milestone_id, slice_id, task_id, summary, previous_artifact_path, replacement_artifact_path, created_at)
     VALUES (:milestone_id, :slice_id, :task_id, :summary, :previous_artifact_path, :replacement_artifact_path, :created_at)`,
  ).run({
    ":milestone_id": entry.milestoneId,
    ":slice_id": entry.sliceId ?? null,
    ":task_id": entry.taskId ?? null,
    ":summary": entry.summary,
    ":previous_artifact_path": entry.previousArtifactPath ?? null,
    ":replacement_artifact_path": entry.replacementArtifactPath ?? null,
    ":created_at": new Date().toISOString(),
  }));
}


export type ReworkFindingSeverity = "blocking" | "advisory";
export type ReworkFindingStatus = "pending" | "resolved" | "deferred-with-override";

export interface ReworkBriefFindingInput {
  findingId: string;
  severity: ReworkFindingSeverity;
  description: string;
  requiredFix: string;
  verificationCommands: string[];
  status?: ReworkFindingStatus;
  evidence?: string;
  decisionRef?: string;
}

export interface ReworkBriefFindingRow {
  brief_id: string;
  finding_id: string;
  severity: ReworkFindingSeverity;
  description: string;
  required_fix: string;
  verification_commands: string[];
  status: ReworkFindingStatus;
  evidence: string;
  decision_ref: string;
}

function reworkBriefIdFromTask(milestoneId: string, sliceId: string, taskId: string): string {
  return `RB-${milestoneId}-${sliceId}-${taskId}`;
}

function normalizeReworkStatus(status: unknown): ReworkFindingStatus {
  const normalized = String(status ?? "pending");
  if (normalized === "resolved" || normalized === "deferred-with-override") {
    return normalized;
  }
  return "pending";
}

function rowToReworkFinding(row: Record<string, unknown>): ReworkBriefFindingRow {
  let verificationCommands: string[] = [];
  try {
    const parsed = JSON.parse(String(row["verification_commands"] ?? "[]"));
    verificationCommands = Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    verificationCommands = [];
  }
  return {
    brief_id: String(row["brief_id"] ?? ""),
    finding_id: String(row["finding_id"] ?? ""),
    severity: String(row["severity"] ?? "blocking") === "advisory" ? "advisory" : "blocking",
    description: String(row["description"] ?? ""),
    required_fix: String(row["required_fix"] ?? ""),
    verification_commands: verificationCommands,
    status: normalizeReworkStatus(row["status"]),
    evidence: String(row["evidence"] ?? ""),
    decision_ref: String(row["decision_ref"] ?? ""),
  };
}

export function saveReworkBrief(entry: {
  briefId?: string;
  milestoneId: string;
  sliceId: string;
  taskId: string;
  findings: ReworkBriefFindingInput[];
}): { briefId: string } {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  const briefId = entry.briefId?.trim() || reworkBriefIdFromTask(entry.milestoneId, entry.sliceId, entry.taskId);
  const now = new Date().toISOString();
  transaction(() => {
    getDbOrNull()!.prepare(
      `INSERT INTO rework_briefs (id, milestone_id, slice_id, task_id, created_at, updated_at)
       VALUES (:id, :mid, :sid, :tid, :created_at, :updated_at)
       ON CONFLICT(id) DO UPDATE SET
         milestone_id = :mid,
         slice_id = :sid,
         task_id = :tid,
         updated_at = :updated_at`,
    ).run({
      ":id": briefId,
      ":mid": entry.milestoneId,
      ":sid": entry.sliceId,
      ":tid": entry.taskId,
      ":created_at": now,
      ":updated_at": now,
    });
    getDbOrNull()!.prepare("DELETE FROM rework_brief_findings WHERE brief_id = :id").run({ ":id": briefId });
    const stmt = getDbOrNull()!.prepare(
      `INSERT INTO rework_brief_findings (
         brief_id, finding_id, severity, description, required_fix, verification_commands,
         status, evidence, decision_ref, updated_at
       ) VALUES (
         :brief_id, :finding_id, :severity, :description, :required_fix, :verification_commands,
         :status, :evidence, :decision_ref, :updated_at
       )`,
    );
    for (const finding of entry.findings) {
      stmt.run({
        ":brief_id": briefId,
        ":finding_id": finding.findingId,
        ":severity": finding.severity,
        ":description": finding.description,
        ":required_fix": finding.requiredFix,
        ":verification_commands": JSON.stringify(finding.verificationCommands),
        ":status": finding.status ?? "pending",
        ":evidence": finding.evidence ?? "",
        ":decision_ref": finding.decisionRef ?? "",
        ":updated_at": now,
      });
    }
  });
  return { briefId };
}

/**
 * Exit code substituted when a `verification_evidence` row carries a NULL or
 * non-numeric `exit_code`. Non-zero so unknown exit codes can never be read as
 * a success by the verification gate (#1591).
 */
const UNKNOWN_VERIFICATION_EXIT_CODE = 1;

/** Coerce a raw SQLite column value to a finite number, else `undefined`. */
function toFiniteNumber(raw: unknown): number | undefined {
  if (raw === null || raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Read the structured verification evidence staged for a Task by
 * `gsd_task_complete` (#1591). Host verification consumes this for any Task:
 * the gate only lets it short-circuit command discovery when the Task's plan
 * `verify` is prose and every evidence record reports a passing verdict with a
 * zero exit code. Rows with a NULL or non-numeric `exit_code` are reported as
 * `UNKNOWN_VERIFICATION_EXIT_CODE` so they cannot qualify as passing.
 */
export function getTaskVerificationEvidence(
  milestoneId: string,
  sliceId: string,
  taskId: string,
): Array<{ command: string; exitCode: number; verdict: string; durationMs?: number }> {
  if (!getDbOrNull()!) return [];
  const rows = getDbOrNull()!.prepare(
    `SELECT command, exit_code, verdict, duration_ms
     FROM verification_evidence
     WHERE milestone_id = :mid AND slice_id = :sid AND task_id = :tid
     ORDER BY id`,
  ).all({ ":mid": milestoneId, ":sid": sliceId, ":tid": taskId }) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const durationMs = toFiniteNumber(row.duration_ms);
    return {
      command: String(row.command ?? ""),
      exitCode: toFiniteNumber(row.exit_code) ?? UNKNOWN_VERIFICATION_EXIT_CODE,
      verdict: String(row.verdict ?? ""),
      ...(durationMs !== undefined ? { durationMs } : {}),
    };
  });
}

export function getBlockingReworkFindingsForTask(
  milestoneId: string,
  sliceId: string,
  taskId: string,
): ReworkBriefFindingRow[] {
  if (!getDbOrNull()!) return [];
  const rows = getDbOrNull()!.prepare(
    `SELECT f.*
     FROM rework_brief_findings f
     JOIN rework_briefs b ON b.id = f.brief_id
     WHERE b.milestone_id = :mid
       AND b.slice_id = :sid
       AND b.task_id = :tid
       AND f.severity = 'blocking'
     ORDER BY b.created_at, f.finding_id`,
  ).all({ ":mid": milestoneId, ":sid": sliceId, ":tid": taskId }) as Array<Record<string, unknown>>;
  return rows.map(rowToReworkFinding);
}

export function getUnresolvedBlockingReworkFindingsForTask(
  milestoneId: string,
  sliceId: string,
  taskId: string,
): ReworkBriefFindingRow[] {
  return getBlockingReworkFindingsForTask(milestoneId, sliceId, taskId)
    .filter((finding) => finding.status === "pending");
}

export function applyReworkResolutions(resolutions: Array<{
  milestoneId: string;
  sliceId: string;
  taskId: string;
  findingId: string;
  status: ReworkFindingStatus;
  evidence: string;
  decisionRef?: string;
}>): void {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  const now = new Date().toISOString();
  const stmt = getDbOrNull()!.prepare(
    `UPDATE rework_brief_findings
     SET status = :status,
         evidence = :evidence,
         decision_ref = :decision_ref,
         updated_at = :updated_at
     WHERE finding_id = :finding_id
       AND brief_id IN (
         SELECT id FROM rework_briefs
         WHERE milestone_id = :mid AND slice_id = :sid AND task_id = :tid
       )`,
  );
  transaction(() => {
    for (const resolution of resolutions) {
      stmt.run({
        ":status": resolution.status,
        ":evidence": resolution.evidence,
        ":decision_ref": resolution.decisionRef ?? "",
        ":updated_at": now,
        ":finding_id": resolution.findingId,
        ":mid": resolution.milestoneId,
        ":sid": resolution.sliceId,
        ":tid": resolution.taskId,
      });
    }
  });
}

export function insertAssessment(entry: {
  path: string;
  milestoneId: string;
  sliceId?: string | null;
  taskId?: string | null;
  status: string;
  scope: string;
  fullContent: string;
  createdAt?: string;
}): void {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  // Idempotent: PRIMARY KEY is `path`, which is deterministic given (milestone_id, scope) per
  // the artifact-path resolver. Retrying the same reassess-roadmap silently overwrites the row
  // instead of accumulating duplicates.
  transaction(() => getDbOrNull()!.prepare(
    `INSERT OR REPLACE INTO assessments (path, milestone_id, slice_id, task_id, status, scope, full_content, created_at)
     VALUES (:path, :milestone_id, :slice_id, :task_id, :status, :scope, :full_content, :created_at)`,
  ).run({
    ":path": entry.path,
    ":milestone_id": entry.milestoneId,
    ":slice_id": entry.sliceId ?? null,
    ":task_id": entry.taskId ?? null,
    ":status": entry.status,
    ":scope": entry.scope,
    ":full_content": entry.fullContent,
    ":created_at": entry.createdAt ?? new Date().toISOString(),
  }));
}

export function deleteAssessmentByScope(milestoneId: string, scope: string): void {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  transaction(() => getDbOrNull()!.prepare(
    `DELETE FROM assessments WHERE milestone_id = :mid AND scope = :scope`,
  ).run({ ":mid": milestoneId, ":scope": scope }));
}

export function deleteVerificationEvidence(milestoneId: string, sliceId: string, taskId: string): void {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  transaction(() => getDbOrNull()!.prepare(
    `DELETE FROM verification_evidence WHERE milestone_id = :mid AND slice_id = :sid AND task_id = :tid`,
  ).run({ ":mid": milestoneId, ":sid": sliceId, ":tid": taskId }));
}

export function deleteTask(milestoneId: string, sliceId: string, taskId: string): void {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  transaction(() => {
    // Must delete verification_evidence first (FK constraint)
    getDbOrNull()!!.prepare(
      `DELETE FROM verification_evidence WHERE milestone_id = :mid AND slice_id = :sid AND task_id = :tid`,
    ).run({ ":mid": milestoneId, ":sid": sliceId, ":tid": taskId });
    getDbOrNull()!!.prepare(
      `DELETE FROM quality_gates WHERE milestone_id = :mid AND slice_id = :sid AND task_id = :tid`,
    ).run({ ":mid": milestoneId, ":sid": sliceId, ":tid": taskId });
    getDbOrNull()!!.prepare(
      `DELETE FROM tasks WHERE milestone_id = :mid AND slice_id = :sid AND id = :tid`,
    ).run({ ":mid": milestoneId, ":sid": sliceId, ":tid": taskId });
  });
}

export function deleteSlice(milestoneId: string, sliceId: string): void {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  transaction(() => {
    // Cascade-style manual deletion: evidence → tasks → dependencies → slice
    getDbOrNull()!!.prepare(
      `DELETE FROM verification_evidence WHERE milestone_id = :mid AND slice_id = :sid`,
    ).run({ ":mid": milestoneId, ":sid": sliceId });
    getDbOrNull()!!.prepare(
      `DELETE FROM tasks WHERE milestone_id = :mid AND slice_id = :sid`,
    ).run({ ":mid": milestoneId, ":sid": sliceId });
    getDbOrNull()!!.prepare(
      `DELETE FROM slice_dependencies WHERE milestone_id = :mid AND slice_id = :sid`,
    ).run({ ":mid": milestoneId, ":sid": sliceId });
    getDbOrNull()!!.prepare(
      `DELETE FROM slice_dependencies WHERE milestone_id = :mid AND depends_on_slice_id = :sid`,
    ).run({ ":mid": milestoneId, ":sid": sliceId });
    getDbOrNull()!!.prepare(
      `DELETE FROM slices WHERE milestone_id = :mid AND id = :sid`,
    ).run({ ":mid": milestoneId, ":sid": sliceId });
  });
}

export function deleteMilestone(milestoneId: string): void {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  transaction(() => {
    assertNoAdoptedLifecycleHistory("deleteMilestone", [milestoneId]);
    getDbOrNull()!!.prepare(
      `DELETE FROM verification_evidence WHERE milestone_id = :mid`,
    ).run({ ":mid": milestoneId });
    getDbOrNull()!!.prepare(
      `DELETE FROM quality_gates WHERE milestone_id = :mid`,
    ).run({ ":mid": milestoneId });
    getDbOrNull()!!.prepare(
      `DELETE FROM gate_runs WHERE milestone_id = :mid`,
    ).run({ ":mid": milestoneId });
    getDbOrNull()!!.prepare(
      `DELETE FROM tasks WHERE milestone_id = :mid`,
    ).run({ ":mid": milestoneId });
    getDbOrNull()!!.prepare(
      `DELETE FROM slice_dependencies WHERE milestone_id = :mid`,
    ).run({ ":mid": milestoneId });
    getDbOrNull()!!.prepare(
      `DELETE FROM slices WHERE milestone_id = :mid`,
    ).run({ ":mid": milestoneId });
    getDbOrNull()!!.prepare(
      `DELETE FROM replan_history WHERE milestone_id = :mid`,
    ).run({ ":mid": milestoneId });
    getDbOrNull()!!.prepare(
      `DELETE FROM assessments WHERE milestone_id = :mid`,
    ).run({ ":mid": milestoneId });
    getDbOrNull()!!.prepare(
      `DELETE FROM artifacts WHERE milestone_id = :mid`,
    ).run({ ":mid": milestoneId });
    getDbOrNull()!!.prepare(
      `DELETE FROM milestone_commit_attributions WHERE milestone_id = :mid`,
    ).run({ ":mid": milestoneId });
    getDbOrNull()!!.prepare(
      `DELETE FROM milestone_leases WHERE milestone_id = :mid`,
    ).run({ ":mid": milestoneId });
    getDbOrNull()!!.prepare(
      `DELETE FROM milestones WHERE id = :mid`,
    ).run({ ":mid": milestoneId });
  });
}

export function updateSliceFields(milestoneId: string, sliceId: string, fields: {
  title?: string;
  risk?: string;
  depends?: string[];
  demo?: string;
}): void {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  const SLICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
  if (fields.depends !== undefined) {
    const invalidDep = fields.depends.find(d => !SLICE_ID_RE.test(d));
    if (invalidDep !== undefined) {
      throw new GSDError(GSD_STALE_STATE, `updateSliceFields: depends element "${invalidDep}" is not a valid slice ID`);
    }
  }
  transaction(() => getDbOrNull()!.prepare(
    `UPDATE slices SET
      title = COALESCE(:title, title),
      risk = COALESCE(:risk, risk),
      depends = COALESCE(:depends, depends),
      demo = COALESCE(:demo, demo)
     WHERE milestone_id = :milestone_id AND id = :id`,
  ).run({
    ":milestone_id": milestoneId,
    ":id": sliceId,
    ":title": fields.title ?? null,
    ":risk": fields.risk ?? null,
    ":depends": fields.depends ? JSON.stringify(fields.depends) : null,
    ":demo": fields.demo ?? null,
  }));
}




// ─── Quality Gates ───────────────────────────────────────────────────────

export function insertGateRow(g: {
  milestoneId: string;
  sliceId: string;
  gateId: GateId;
  scope: GateScope;
  taskId?: string | null;
  status?: GateStatus;
}): void {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  transaction(() => getDbOrNull()!.prepare(
    `INSERT OR IGNORE INTO quality_gates (milestone_id, slice_id, gate_id, scope, task_id, status)
     VALUES (:mid, :sid, :gid, :scope, :tid, :status)`,
  ).run({
    ":mid": g.milestoneId,
    ":sid": g.sliceId,
    ":gid": g.gateId,
    ":scope": g.scope,
    ":tid": g.taskId ?? "",
    ":status": g.status ?? "pending",
  }));
}

export function saveGateResult(g: {
  milestoneId: string;
  sliceId: string;
  gateId: string;
  taskId?: string | null;
  verdict: GateVerdict;
  rationale: string;
  findings: string;
}): void {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  const evaluatedAt = new Date().toISOString();
  // Atomic: the gate verdict UPDATE and the gate_runs ledger INSERT must commit
  // together. As two autocommits, a crash between them records a completed gate
  // with no ledger row (the row Recovery Classification reads). transaction()
  // is re-entrant, so callers already inside a transaction are safe. The
  // throw-on-zero-changes stays inside so a missing gate row rolls back cleanly.
  transaction(() => {
    const result = getDbOrNull()!.prepare(
      `UPDATE quality_gates
       SET status = 'complete', verdict = :verdict, rationale = :rationale,
           findings = :findings, evaluated_at = :evaluated_at
       WHERE milestone_id = :mid AND slice_id = :sid AND gate_id = :gid
         AND (task_id = :tid OR (:tid = '' AND task_id IS NULL))`,
    ).run({
      ":mid": g.milestoneId,
      ":sid": g.sliceId,
      ":gid": g.gateId,
      ":tid": g.taskId ?? "",
      ":verdict": g.verdict,
      ":rationale": g.rationale,
      ":findings": g.findings,
      ":evaluated_at": evaluatedAt,
    }) as { changes?: number };

    if ((result.changes ?? 0) === 0) {
      throw new GSDError(
        GSD_STALE_STATE,
        `quality gate row not found for ${g.milestoneId}/${g.sliceId}/${g.gateId}${g.taskId ? `/${g.taskId}` : ""}`,
      );
    }

    const outcome =
      g.verdict === "pass"
        ? "pass"
        : g.verdict === "omitted"
          ? "manual-attention"
          : "fail";
    insertGateRun({
      traceId: `quality-gate:${g.milestoneId}:${g.sliceId}`,
      turnId: `gate:${g.gateId}:${g.taskId ?? "slice"}`,
      gateId: g.gateId,
      gateType: "quality-gate",
      milestoneId: g.milestoneId,
      sliceId: g.sliceId,
      taskId: g.taskId ?? undefined,
      outcome,
      failureClass: outcome === "fail" ? "verification" : outcome === "manual-attention" ? "manual-attention" : "none",
      rationale: g.rationale,
      findings: g.findings,
      attempt: 1,
      maxAttempts: 1,
      retryable: false,
      evaluatedAt,
    });
  });
}



export function markAllGatesOmitted(milestoneId: string, sliceId: string): void {
  if (!getDbOrNull()!) return;
  transaction(() => getDbOrNull()!.prepare(
    `UPDATE quality_gates SET status = 'complete', verdict = 'omitted', evaluated_at = :now
     WHERE milestone_id = :mid AND slice_id = :sid AND status = 'pending'`,
  ).run({
    ":mid": milestoneId,
    ":sid": sliceId,
    ":now": new Date().toISOString(),
  }));
}

export function markPendingGatesOmittedForTurn(
  milestoneId: string,
  sliceId: string,
  turn: OwnerTurn,
): void {
  if (!getDbOrNull()!) return;
  const gateIds = [...getGateIdsForTurn(turn)];
  if (gateIds.length === 0) return;
  const placeholders = gateIds.map((_, i) => `:gid${i}`).join(",");
  const params: Record<string, unknown> = {
    ":mid": milestoneId,
    ":sid": sliceId,
    ":now": new Date().toISOString(),
  };
  gateIds.forEach((id, index) => {
    params[`:gid${index}`] = id;
  });
  transaction(() => getDbOrNull()!.prepare(
    `UPDATE quality_gates SET status = 'complete', verdict = 'omitted', evaluated_at = :now
     WHERE milestone_id = :mid AND slice_id = :sid AND status = 'pending'
       AND gate_id IN (${placeholders})`,
  ).run(params));
}




export function insertGateRun(entry: {
  traceId: string;
  turnId: string;
  gateId: string;
  gateType: string;
  unitType?: string;
  unitId?: string;
  milestoneId?: string;
  sliceId?: string;
  taskId?: string;
  outcome: "pass" | "fail" | "retry" | "manual-attention";
  failureClass: "none" | "policy" | "input" | "execution" | "artifact" | "verification" | "closeout" | "git" | "timeout" | "manual-attention" | "unknown";
  rationale?: string;
  findings?: string;
  attempt: number;
  maxAttempts: number;
  retryable: boolean;
  evaluatedAt: string;
}): void {
  if (!getDbOrNull()!) return;
  transaction(() => getDbOrNull()!.prepare(
    `INSERT INTO gate_runs (
      trace_id, turn_id, gate_id, gate_type, unit_type, unit_id, milestone_id, slice_id, task_id,
      outcome, failure_class, rationale, findings, attempt, max_attempts, retryable, evaluated_at
    ) VALUES (
      :trace_id, :turn_id, :gate_id, :gate_type, :unit_type, :unit_id, :milestone_id, :slice_id, :task_id,
      :outcome, :failure_class, :rationale, :findings, :attempt, :max_attempts, :retryable, :evaluated_at
    )`,
  ).run({
    ":trace_id": entry.traceId,
    ":turn_id": entry.turnId,
    ":gate_id": entry.gateId,
    ":gate_type": entry.gateType,
    ":unit_type": entry.unitType ?? null,
    ":unit_id": entry.unitId ?? null,
    ":milestone_id": entry.milestoneId ?? null,
    ":slice_id": entry.sliceId ?? null,
    ":task_id": entry.taskId ?? null,
    ":outcome": entry.outcome,
    ":failure_class": entry.failureClass,
    ":rationale": entry.rationale ?? "",
    ":findings": entry.findings ?? "",
    ":attempt": entry.attempt,
    ":max_attempts": entry.maxAttempts,
    ":retryable": entry.retryable ? 1 : 0,
    ":evaluated_at": entry.evaluatedAt,
  }));
}

export function upsertTurnGitTransaction(entry: {
  traceId: string;
  turnId: string;
  unitType?: string;
  unitId?: string;
  stage: string;
  action: "commit" | "snapshot" | "status-only";
  push: boolean;
  status: "ok" | "failed";
  error?: string;
  metadata?: Record<string, unknown>;
  updatedAt: string;
}): void {
  if (!getDbOrNull()!) return;
  transaction(() => getDbOrNull()!.prepare(
    `INSERT OR REPLACE INTO turn_git_transactions (
      trace_id, turn_id, unit_type, unit_id, stage, action, push, status, error, metadata_json, updated_at
    ) VALUES (
      :trace_id, :turn_id, :unit_type, :unit_id, :stage, :action, :push, :status, :error, :metadata_json, :updated_at
    )`,
  ).run({
    ":trace_id": entry.traceId,
    ":turn_id": entry.turnId,
    ":unit_type": entry.unitType ?? null,
    ":unit_id": entry.unitId ?? null,
    ":stage": entry.stage,
    ":action": entry.action,
    ":push": entry.push ? 1 : 0,
    ":status": entry.status,
    ":error": entry.error ?? null,
    ":metadata_json": JSON.stringify(entry.metadata ?? {}),
    ":updated_at": entry.updatedAt,
  }));
}


export function recordMilestoneCommitAttribution(entry: {
  commitSha: string;
  milestoneId: string;
  sliceId?: string;
  taskId?: string;
  source: "recorded" | "backfill";
  confidence: number;
  files: string[];
  createdAt: string;
}): void {
  if (!getDbOrNull()!) return;
  transaction(() => {
    getDbOrNull()!!.prepare(
      `INSERT OR REPLACE INTO milestone_commit_attributions (
        commit_sha, milestone_id, slice_id, task_id, source, confidence, files_json, created_at
      ) VALUES (
        :commit_sha, :milestone_id, :slice_id, :task_id, :source, :confidence, :files_json, :created_at
      )`,
    ).run({
      ":commit_sha": entry.commitSha,
      ":milestone_id": entry.milestoneId,
      ":slice_id": entry.sliceId ?? null,
      ":task_id": entry.taskId ?? null,
      ":source": entry.source,
      ":confidence": entry.confidence,
      ":files_json": JSON.stringify(entry.files),
      ":created_at": entry.createdAt,
    });

    getDbOrNull()!!.prepare(
      `INSERT OR IGNORE INTO audit_events (
        event_id, trace_id, turn_id, caused_by, category, type, ts, payload_json
      ) VALUES (
        :event_id, :trace_id, :turn_id, :caused_by, :category, :type, :ts, :payload_json
      )`,
    ).run({
      ":event_id": `milestone-commit-attribution:${entry.milestoneId}:${entry.commitSha}`,
      ":trace_id": "milestone-commit-attribution",
      ":turn_id": null,
      ":caused_by": null,
      ":category": "git",
      ":type": "milestone-commit-attribution-recorded",
      ":ts": entry.createdAt,
      ":payload_json": JSON.stringify({
        commitSha: entry.commitSha,
        milestoneId: entry.milestoneId,
        sliceId: entry.sliceId ?? null,
        taskId: entry.taskId ?? null,
        source: entry.source,
        confidence: entry.confidence,
        files: entry.files,
      }),
    });
  });
}

export function insertAuditEvent(entry: {
  eventId: string;
  traceId: string;
  turnId?: string;
  causedBy?: string;
  category: string;
  type: string;
  ts: string;
  payload: Record<string, unknown>;
}): void {
  if (!getDbOrNull()!) return;
  transaction(() => {
    getDbOrNull()!!.prepare(
      `INSERT OR IGNORE INTO audit_events (
        event_id, trace_id, turn_id, caused_by, category, type, ts, payload_json
      ) VALUES (
        :event_id, :trace_id, :turn_id, :caused_by, :category, :type, :ts, :payload_json
      )`,
    ).run({
      ":event_id": entry.eventId,
      ":trace_id": entry.traceId,
      ":turn_id": entry.turnId ?? null,
      ":caused_by": entry.causedBy ?? null,
      ":category": entry.category,
      ":type": entry.type,
      ":ts": entry.ts,
      ":payload_json": JSON.stringify(entry.payload ?? {}),
    });

    if (entry.turnId) {
      const row = getDbOrNull()!!.prepare(
        `SELECT event_count, first_ts, last_ts
         FROM audit_turn_index
         WHERE trace_id = :trace_id AND turn_id = :turn_id`,
      ).get({
        ":trace_id": entry.traceId,
        ":turn_id": entry.turnId,
      });
      if (row) {
        getDbOrNull()!!.prepare(
          `UPDATE audit_turn_index
           SET first_ts = CASE WHEN :ts < first_ts THEN :ts ELSE first_ts END,
               last_ts = CASE WHEN :ts > last_ts THEN :ts ELSE last_ts END,
               event_count = event_count + 1
           WHERE trace_id = :trace_id AND turn_id = :turn_id`,
        ).run({
          ":trace_id": entry.traceId,
          ":turn_id": entry.turnId,
          ":ts": entry.ts,
        });
      } else {
        getDbOrNull()!!.prepare(
          `INSERT INTO audit_turn_index (trace_id, turn_id, first_ts, last_ts, event_count)
           VALUES (:trace_id, :turn_id, :first_ts, :last_ts, :event_count)`,
        ).run({
          ":trace_id": entry.traceId,
          ":turn_id": entry.turnId,
          ":first_ts": entry.ts,
          ":last_ts": entry.ts,
          ":event_count": 1,
        });
      }
    }
  });
}

// ─── Single-writer bypass wrappers ───────────────────────────────────────
// These wrappers exist so modules outside this file never need to call
// `_getAdapter()` for writes. Each one is a byte-equivalent replacement for
// a raw prepare/run previously issued from another module. Keep them
// minimal and direct — they exist to hold SQL text in one place, not to
// add new behavior.

/** Delete a decision row by id. Used by db-writer.ts rollback on disk-write failure. */
export function deleteDecisionById(id: string): void {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  transaction(() => getDbOrNull()!.prepare("DELETE FROM decisions WHERE id = :id").run({ ":id": id }));
}

/** Delete a requirement row by id. Used by db-writer.ts rollback on disk-write failure. */
export function deleteRequirementById(id: string): void {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  transaction(() => getDbOrNull()!.prepare("DELETE FROM requirements WHERE id = :id").run({ ":id": id }));
}

/** Delete an artifact row by path. Used by db-writer.ts rollback on disk-write failure. */
export function deleteArtifactByPath(path: string): void {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  transaction(() => getDbOrNull()!.prepare("DELETE FROM artifacts WHERE path = :path").run({ ":path": path }));
}

/** Delete artifact rows whose paths share a DB-relative prefix. */
export function deleteArtifactsByPathPrefix(prefix: string): number {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  return transaction(() => {
    const likePrefix = `${prefix}%`;
    const countRow = getDbOrNull()!.prepare(
      "SELECT COUNT(*) AS count FROM artifacts WHERE path LIKE :prefix",
    ).get({ ":prefix": likePrefix });
    getDbOrNull()!.prepare("DELETE FROM artifacts WHERE path LIKE :prefix").run({ ":prefix": likePrefix });
    return Number(countRow?.["count"] ?? 0);
  });
}

/** List artifact rows whose paths share a DB-relative prefix. */
export function getArtifactsByPathPrefix(prefix: string): ArtifactRow[] {
  if (!getDbOrNull()!) return [];
  const rows = getDbOrNull()!.prepare(
    "SELECT * FROM artifacts WHERE path LIKE :prefix ORDER BY path",
  ).all({ ":prefix": `${prefix}%` });
  return rows.map(rowToArtifact);
}

/**
 * Legacy destructive hierarchy-reset helper. Explicit recovery does not call
 * this; it applies a verified Import Application without clearing absent rows.
 */
export function clearEngineHierarchy(): void {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  immediateTransaction(() => {
    assertNoAdoptedLifecycleHistory("clearEngineHierarchy");
    getDbOrNull()!!.exec("DELETE FROM verification_evidence");
    getDbOrNull()!!.exec("DELETE FROM quality_gates");
    getDbOrNull()!!.exec("DELETE FROM slice_dependencies");
    getDbOrNull()!!.exec("DELETE FROM assessments");
    getDbOrNull()!!.exec("DELETE FROM replan_history");
    getDbOrNull()!!.exec("DELETE FROM milestone_commit_attributions");
    getDbOrNull()!!.exec("DELETE FROM tasks");
    getDbOrNull()!!.exec("DELETE FROM slices");
    getDbOrNull()!!.exec("DELETE FROM milestone_leases");
    getDbOrNull()!!.exec("DELETE FROM milestones");
  });
}

/**
 * INSERT OR IGNORE a slice during event replay (workflow-reconcile.ts).
 * Strict insert-or-ignore semantics are required here to avoid the
 * `insertSlice` ON CONFLICT path that could downgrade an already-completed
 * slice back to 'pending'.
 */
export function insertOrIgnoreSlice(args: {
  milestoneId: string;
  sliceId: string;
  title: string;
  createdAt: string;
}): void {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  transaction(() => getDbOrNull()!.prepare(
    `INSERT OR IGNORE INTO slices (milestone_id, id, title, status, created_at)
     VALUES (:mid, :sid, :title, 'pending', :ts)`,
  ).run({
    ":mid": args.milestoneId,
    ":sid": args.sliceId,
    ":title": args.title,
    ":ts": args.createdAt,
  }));
}

/**
 * INSERT OR IGNORE a task during event replay (workflow-reconcile.ts).
 * Same rationale as `insertOrIgnoreSlice`.
 */
export function insertOrIgnoreTask(args: {
  milestoneId: string;
  sliceId: string;
  taskId: string;
  title: string;
  createdAt: string;
}): void {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  transaction(() => getDbOrNull()!.prepare(
    `INSERT OR IGNORE INTO tasks (milestone_id, slice_id, id, title, status, created_at)
     VALUES (:mid, :sid, :tid, :title, 'pending', :ts)`,
  ).run({
    ":mid": args.milestoneId,
    ":sid": args.sliceId,
    ":tid": args.taskId,
    ":title": args.title,
    ":ts": args.createdAt,
  }));
}

/**
 * Stamp the `replan_triggered_at` column on a slice. Used by triage-resolution
 * when a user capture requests a replan so the dispatcher can detect the
 * trigger via DB in addition to the on-disk REPLAN-TRIGGER.md marker.
 */
export function setSliceReplanTriggeredAt(milestoneId: string, sliceId: string, ts: string): void {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  transaction(() => getDbOrNull()!.prepare(
    "UPDATE slices SET replan_triggered_at = :ts WHERE milestone_id = :mid AND id = :sid",
  ).run({ ":ts": ts, ":mid": milestoneId, ":sid": sliceId }));
}

/**
 * INSERT OR REPLACE a quality_gates row. Used by milestone-validation-gates.ts
 * to persist milestone-level (MV*) gate outcomes after validate-milestone runs.
 */
export function upsertQualityGate(g: {
  milestoneId: string;
  sliceId: string;
  gateId: string;
  scope: string;
  taskId: string;
  status: string;
  verdict: string;
  rationale: string;
  findings: string;
  evaluatedAt: string;
}): void {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  transaction(() => getDbOrNull()!.prepare(
    `INSERT OR REPLACE INTO quality_gates
     (milestone_id, slice_id, gate_id, scope, task_id, status, verdict, rationale, findings, evaluated_at)
     VALUES (:mid, :sid, :gid, :scope, :tid, :status, :verdict, :rationale, :findings, :evaluated_at)`,
  ).run({
    ":mid": g.milestoneId,
    ":sid": g.sliceId,
    ":gid": g.gateId,
    ":scope": g.scope,
    ":tid": g.taskId,
    ":status": g.status,
    ":verdict": g.verdict,
    ":rationale": g.rationale,
    ":findings": g.findings,
    ":evaluated_at": g.evaluatedAt,
  }));
}
