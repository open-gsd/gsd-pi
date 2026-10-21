// Project/App: gsd-pi
// File Purpose: Worktree DB reconciliation writers for the single-writer layer.
// Owns copyWorktreeDb + reconcileWorktreeDb: the ATTACH-and-merge of an
// auto-worktree's gsd.db back into the project-root DB, with conflict
// detection. Reads the shared engine handle via getDbOrNull(); opens the
// project-root DB via the engine's openDatabase().
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { GSDError, GSD_STALE_STATE } from "../../errors.js";
import { logError, logWarning } from "../../workflow-logger.js";
import { getDbOrNull, openDatabase, snapshotDatabaseFile, transaction } from "../engine.js";
import { TERMINAL_STATUS_SQL } from "../sql-constants.js";

export class CanonicalWorktreeDivergenceError extends GSDError {
  constructor(surfaces: readonly string[]) {
    super(
      GSD_STALE_STATE,
      `canonical worktree divergence prevents reconciliation: ${surfaces.join(", ")}`,
    );
    this.name = "CanonicalWorktreeDivergenceError";
  }
}

/**
 * Optional override for the project-root DB open inside reconcileWorktreeDb.
 * Production leaves this null so the real engine.openDatabase runs; tests
 * inject a function returning false to deterministically exercise the
 * cannot-open-main-DB branch (reconcile.ts:82), which is otherwise unreachable
 * without a contrived provider/OS fault (openDatabase rethrows on real failures
 * rather than returning false across providers).
 * @internal
 */
let _mainDbOpenerFn: ((mainDbPath: string) => boolean) | null = null;

export function _setMainDbOpenerFnForTests(
  fn: ((mainDbPath: string) => boolean) | null,
): () => void {
  const previous = _mainDbOpenerFn;
  _mainDbOpenerFn = fn;
  return () => { _mainDbOpenerFn = previous; };
}

function openMainDb(mainDbPath: string): boolean {
  return _mainDbOpenerFn ? _mainDbOpenerFn(mainDbPath) : openDatabase(mainDbPath);
}

export function copyWorktreeDb(srcDbPath: string, destDbPath: string): boolean {
  try {
    if (!existsSync(srcDbPath)) return false;
    const destDir = dirname(destDbPath);
    mkdirSync(destDir, { recursive: true });
    snapshotDatabaseFile(srcDbPath, destDbPath);
    return true;
  } catch (err) {
    logError("db", "failed to copy DB to worktree", { error: (err as Error).message });
    return false;
  }
}

export interface ReconcileResult {
  decisions: number;
  requirements: number;
  artifacts: number;
  milestones: number;
  slices: number;
  tasks: number;
  memories: number;
  replan_history: number;
  assessments: number;
  quality_gates: number;
  slice_dependencies: number;
  verification_evidence: number;
  gate_runs: number;
  milestone_commit_attributions: number;
  conflicts: string[];
}

export function reconcileWorktreeDb(
  mainDbPath: string,
  worktreeDbPath: string,
): ReconcileResult {
  const zero: ReconcileResult = {
    decisions: 0,
    requirements: 0,
    artifacts: 0,
    milestones: 0,
    slices: 0,
    tasks: 0,
    memories: 0,
    replan_history: 0,
    assessments: 0,
    quality_gates: 0,
    slice_dependencies: 0,
    verification_evidence: 0,
    gate_runs: 0,
    milestone_commit_attributions: 0,
    conflicts: [],
  };
  if (!existsSync(worktreeDbPath)) return zero;
  // Guard: bail when both paths resolve to the same physical file.
  // ATTACHing a WAL-mode DB to itself corrupts the WAL (#2823).
  try {
    if (realpathSync(mainDbPath) === realpathSync(worktreeDbPath)) return zero;
  } catch (e) { logWarning("db", `realpathSync failed: ${(e as Error).message}`); }
  // Sanitize path: reject any characters that could break ATTACH syntax.
  // ATTACH DATABASE doesn't support parameterized paths in all providers,
  // so we use strict allowlist validation instead.
  if (/['";\x00]/.test(worktreeDbPath)) {
    logError("db", "worktree DB reconciliation failed: path contains unsafe characters");
    return zero;
  }
  if (!getDbOrNull()!) {
    const opened = openMainDb(mainDbPath);
    if (!opened) {
      logError("db", "worktree DB reconciliation failed: cannot open main DB");
      return zero;
    }
  }
  const adapter = getDbOrNull()!!;
  const conflicts: string[] = [];
  try {
    adapter.exec(`ATTACH DATABASE '${worktreeDbPath}' AS wt`);
    try {
      function countChanges(result: unknown): number {
        return typeof result === "object" && result !== null ? ((result as { changes?: number }).changes ?? 0) : 0;
      }

      function wtTableInfo(tableName: string): Array<Record<string, unknown>> {
        return adapter.prepare(`PRAGMA wt.table_info('${tableName}')`).all() as Array<Record<string, unknown>>;
      }

      function mainTableInfo(tableName: string): Array<Record<string, unknown>> {
        return adapter.prepare(`PRAGMA main.table_info('${tableName}')`).all() as Array<Record<string, unknown>>;
      }

      function tableRowCount(schema: "main" | "wt", tableName: string): number {
        const count = adapter.prepare(`SELECT COUNT(*) AS count FROM ${schema}.${tableName}`).get();
        return Number(count?.["count"] ?? 0);
      }

      function worktreeRowsMissingFromMain(tableName: string): boolean {
        const mainColumns = mainTableInfo(tableName).map((column) => String(column["name"]));
        const worktreeColumns = wtTableInfo(tableName).map((column) => String(column["name"]));
        if (worktreeColumns.length === 0) return false;
        if (
          mainColumns.length !== worktreeColumns.length ||
          mainColumns.some((column, index) => column !== worktreeColumns[index])
        ) {
          return tableRowCount("wt", tableName) > 0;
        }
        const columns = mainColumns.map((column) => `"${column}"`).join(", ");
        const difference = adapter.prepare(`
          SELECT 1 AS divergent
          WHERE EXISTS (
            SELECT ${columns} FROM wt.${tableName}
            EXCEPT
            SELECT ${columns} FROM main.${tableName}
          )
        `).get();
        return difference !== undefined;
      }

      function worktreeAuthorityIsAhead(): boolean {
        if (wtTableInfo("project_authority").length === 0) return false;
        const main = adapter.prepare(`
          SELECT project_id, revision, authority_epoch FROM main.project_authority WHERE singleton = 1
        `).get();
        const worktree = adapter.prepare(`
          SELECT project_id, revision, authority_epoch FROM wt.project_authority WHERE singleton = 1
        `).get();
        if (!worktree) return false;
        if (!main || worktree["project_id"] !== main["project_id"]) return true;
        return Number(worktree["revision"]) > Number(main["revision"])
          || Number(worktree["authority_epoch"]) > Number(main["authority_epoch"]);
      }

      function worktreeLifecycleIsAheadOrMismatched(): boolean {
        const mainColumns = mainTableInfo("workflow_item_lifecycles").map((column) => String(column["name"]));
        const worktreeColumns = wtTableInfo("workflow_item_lifecycles").map((column) => String(column["name"]));
        if (worktreeColumns.length === 0) return false;
        if (
          mainColumns.length !== worktreeColumns.length ||
          mainColumns.some((column, index) => column !== worktreeColumns[index])
        ) {
          return tableRowCount("wt", "workflow_item_lifecycles") > 0;
        }
        const equalVersionDifferences = mainColumns
          .filter((column) => column !== "state_version")
          .map((column) => `w."${column}" IS NOT m."${column}"`)
          .join(" OR ");
        const difference = adapter.prepare(`
          SELECT 1 AS divergent
          FROM wt.workflow_item_lifecycles w
          LEFT JOIN main.workflow_item_lifecycles m ON m.lifecycle_id = w.lifecycle_id
          WHERE m.lifecycle_id IS NULL
             OR w.state_version > m.state_version
             OR (w.state_version = m.state_version AND (${equalVersionDifferences}))
          LIMIT 1
        `).get();
        return difference !== undefined;
      }

      const authorityDiverged = worktreeAuthorityIsAhead();
      const operationsDiverged = worktreeRowsMissingFromMain("workflow_operations");
      const lifecyclesDiverged = worktreeLifecycleIsAheadOrMismatched();
      // Legacy writers can advance project_authority without recording a
      // canonical operation. Treat authority as corroborating evidence only;
      // blocking on it alone would reject valid pre-adoption worktrees.
      if (operationsDiverged || lifecyclesDiverged) {
        const divergentSurfaces = [
          authorityDiverged ? "authority" : null,
          operationsDiverged ? "operations" : null,
          lifecyclesDiverged ? "lifecycles" : null,
        ].filter((surface): surface is string => surface !== null);
        throw new CanonicalWorktreeDivergenceError(divergentSurfaces);
      }

      const wtInfo = wtTableInfo("decisions");
      const hasWtDecisions = wtInfo.length > 0;
      const hasMadeBy = wtInfo.some((col) => col["name"] === "made_by");
      // ADR-011: worktree may predate schema v16/v17. For missing columns we
      // fall through to the main DB's existing value (not a literal default)
      // so reconcile never silently clears state the main tree has recorded.
      const hasDecisionSource = wtInfo.some((col) => col["name"] === "source");
      const wtRequirementInfo = wtTableInfo("requirements");
      const hasWtRequirements = wtRequirementInfo.length > 0;
      const wtMilestoneInfo = wtTableInfo("milestones");
      const hasWtMilestones = wtMilestoneInfo.length > 0;
      const hasMilestoneSequence = wtMilestoneInfo.some((col) => col["name"] === "sequence");
      const wtSliceInfo = wtTableInfo("slices");
      const hasWtSlices = wtSliceInfo.length > 0;
      const hasIsSketch = wtSliceInfo.some((col) => col["name"] === "is_sketch");
      const hasSketchScope = wtSliceInfo.some((col) => col["name"] === "sketch_scope");
      const hasSliceTargetRepositories = wtSliceInfo.some((col) => col["name"] === "target_repositories");
      const wtTaskInfo = wtTableInfo("tasks");
      const hasWtTasks = wtTaskInfo.length > 0;
      const hasTaskTargetRepositories = wtTaskInfo.some((col) => col["name"] === "target_repositories");
      const hasBlockerSource = wtTaskInfo.some((col) => col["name"] === "blocker_source");
      const hasEscalationPending = wtTaskInfo.some((col) => col["name"] === "escalation_pending");
      const hasEscalationAwaiting = wtTaskInfo.some((col) => col["name"] === "escalation_awaiting_review");
      const hasEscalationArtifact = wtTaskInfo.some((col) => col["name"] === "escalation_artifact_path");
      const hasEscalationOverride = wtTaskInfo.some((col) => col["name"] === "escalation_override_applied_at");
      const wtArtifactInfo = wtTableInfo("artifacts");
      const hasWtArtifacts = wtArtifactInfo.length > 0;
      const wtMemoryInfo = wtTableInfo("memories");
      const hasWtMemories = wtMemoryInfo.length > 0;
      const hasMemoryScope = wtMemoryInfo.some((col) => col["name"] === "scope");
      const hasMemoryTags = wtMemoryInfo.some((col) => col["name"] === "tags");
      const hasMemoryStructuredFields = wtMemoryInfo.some((col) => col["name"] === "structured_fields");
      const hasMemoryLastHitAt = wtMemoryInfo.some((col) => col["name"] === "last_hit_at");
      const hasWtReplanHistory = wtTableInfo("replan_history").length > 0;
      const hasWtAssessments = wtTableInfo("assessments").length > 0;
      const hasWtQualityGates = wtTableInfo("quality_gates").length > 0;
      const hasWtSliceDependencies = wtTableInfo("slice_dependencies").length > 0;
      const hasWtVerificationEvidence = wtTableInfo("verification_evidence").length > 0;
      const hasWtGateRuns = wtTableInfo("gate_runs").length > 0;
      const hasWtMilestoneCommitAttributions = wtTableInfo("milestone_commit_attributions").length > 0;
      const hasWtLifecycles = wtTableInfo("workflow_item_lifecycles").length > 0;

      function mainLifecycleIsNewer(itemKind: "milestone" | "slice" | "task"): string {
        const identity = [
          "main_lifecycle.project_id = worktree_lifecycle.project_id",
          "main_lifecycle.item_kind = worktree_lifecycle.item_kind",
          "main_lifecycle.milestone_id = worktree_lifecycle.milestone_id",
          "main_lifecycle.slice_id IS worktree_lifecycle.slice_id",
          "main_lifecycle.task_id IS worktree_lifecycle.task_id",
        ].join(" AND ");
        let hierarchyIdentity: string;
        if (itemKind === "milestone") {
          hierarchyIdentity = "main_lifecycle.milestone_id = w.id AND main_lifecycle.slice_id IS NULL AND main_lifecycle.task_id IS NULL";
        } else if (itemKind === "slice") {
          hierarchyIdentity = "main_lifecycle.milestone_id = w.milestone_id AND main_lifecycle.slice_id = w.id AND main_lifecycle.task_id IS NULL";
        } else {
          hierarchyIdentity = "main_lifecycle.milestone_id = w.milestone_id AND main_lifecycle.slice_id = w.slice_id AND main_lifecycle.task_id = w.id";
        }
        const newerThanWorktree = hasWtLifecycles
          ? `AND NOT EXISTS (
               SELECT 1 FROM wt.workflow_item_lifecycles worktree_lifecycle
               WHERE ${identity}
                 AND worktree_lifecycle.state_version >= main_lifecycle.state_version
             )`
          : "";
        return `EXISTS (
          SELECT 1 FROM main.workflow_item_lifecycles main_lifecycle
          WHERE main_lifecycle.item_kind = '${itemKind}'
            AND ${hierarchyIdentity}
            ${newerThanWorktree}
        )`;
      }

      const newerMilestoneLifecycle = mainLifecycleIsNewer("milestone");
      const newerSliceLifecycle = mainLifecycleIsNewer("slice");
      const newerTaskLifecycle = mainLifecycleIsNewer("task");

      if (hasWtDecisions) {
        const decConf = adapter.prepare(
          `SELECT m.id FROM decisions m INNER JOIN wt.decisions w ON m.id = w.id WHERE m.decision != w.decision OR m.choice != w.choice OR m.rationale != w.rationale OR ${
            hasMadeBy ? "m.made_by != w.made_by" : "'agent' != 'agent'"
          } OR m.superseded_by IS NOT w.superseded_by`,
        ).all();
        for (const row of decConf) conflicts.push(`decision ${(row as Record<string, unknown>)["id"]}: modified in both`);
      }

      if (hasWtRequirements) {
        const reqConf = adapter.prepare(
          `SELECT m.id FROM requirements m INNER JOIN wt.requirements w ON m.id = w.id WHERE m.description != w.description OR m.status != w.status OR m.notes != w.notes OR m.superseded_by IS NOT w.superseded_by`,
        ).all();
        for (const row of reqConf) conflicts.push(`requirement ${(row as Record<string, unknown>)["id"]}: modified in both`);
      }

      const merged: Omit<ReconcileResult, "conflicts"> = {
        decisions: 0,
        requirements: 0,
        artifacts: 0,
        milestones: 0,
        slices: 0,
        tasks: 0,
        memories: 0,
        replan_history: 0,
        assessments: 0,
        quality_gates: 0,
        slice_dependencies: 0,
        verification_evidence: 0,
        gate_runs: 0,
        milestone_commit_attributions: 0,
      };
      const sliceTargetRepositoriesSql = hasSliceTargetRepositories
        ? `CASE
             WHEN w.target_repositories = '[]' AND COALESCE(m.target_repositories, '[]') <> '[]'
             THEN m.target_repositories
             ELSE COALESCE(w.target_repositories, m.target_repositories, '[]')
           END`
        : "COALESCE(m.target_repositories, '[]')";
      const taskTargetRepositoriesSql = hasTaskTargetRepositories
        ? `CASE
             WHEN w.target_repositories = '[]' AND COALESCE(m.target_repositories, '[]') <> '[]'
             THEN m.target_repositories
             ELSE COALESCE(w.target_repositories, m.target_repositories, '[]')
           END`
        : "COALESCE(m.target_repositories, '[]')";

      transaction(() => {
        // Join the target decisions so we can prefer an existing main.source
        // when the worktree predates v16 — otherwise a write-through reconcile
        // would clobber 'escalation'-sourced decisions with the literal default.
        if (hasWtDecisions) {
          merged.decisions = countChanges(adapter.prepare(`
            INSERT INTO decisions (
              id, when_context, scope, decision, choice, rationale, revisable, made_by, source, superseded_by
            )
            SELECT w.id, w.when_context, w.scope, w.decision, w.choice, w.rationale, w.revisable, ${
              hasMadeBy ? "w.made_by" : "COALESCE(m.made_by, 'agent')"
            }, ${
              hasDecisionSource ? "w.source" : "COALESCE(m.source, 'discussion')"
            }, w.superseded_by
            FROM wt.decisions w
            LEFT JOIN decisions m ON m.id = w.id
            WHERE true
            ON CONFLICT(id) DO UPDATE SET
              when_context = excluded.when_context,
              scope = excluded.scope,
              decision = excluded.decision,
              choice = excluded.choice,
              rationale = excluded.rationale,
              revisable = excluded.revisable,
              made_by = excluded.made_by,
              source = excluded.source,
              superseded_by = excluded.superseded_by
          `).run());
        }

        if (hasWtRequirements) {
          merged.requirements = countChanges(adapter.prepare(`
            INSERT OR REPLACE INTO requirements (
              id, class, status, description, why, source, primary_owner,
              supporting_slices, validation, notes, full_content, superseded_by
            )
            SELECT id, class, status, description, why, source, primary_owner,
                   supporting_slices, validation, notes, full_content, superseded_by
            FROM wt.requirements
          `).run());
        }

        // Always recompute artifact hashes from the content being merged. Older
        // worktree DBs may not have content_hash at all, and migrated old DBs can
        // carry stale default/null hashes after their content changed.
        if (hasWtArtifacts) {
          const artifactRows = adapter.prepare(`
            SELECT path, artifact_type, milestone_id, slice_id, task_id, full_content, imported_at
            FROM wt.artifacts
          `).all() as Array<Record<string, unknown>>;
          const artifactStmt = adapter.prepare(`
            INSERT OR REPLACE INTO artifacts (
              path, artifact_type, milestone_id, slice_id, task_id, full_content, imported_at, content_hash
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `);
          for (const row of artifactRows) {
            const fullContent = String(row["full_content"] ?? "");
            merged.artifacts += countChanges(artifactStmt.run(
              row["path"],
              row["artifact_type"],
              row["milestone_id"] ?? null,
              row["slice_id"] ?? null,
              row["task_id"] ?? null,
              fullContent,
              row["imported_at"],
              createHash("sha256").update(fullContent).digest("hex"),
            ));
          }
        }

        // Merge milestones — worktree may have updated status/planning fields.
        // Never downgrade status: complete > active > pre-planning (#4372).
        // A stale worktree may carry an older 'active' status for a milestone
        // that the main DB has already marked 'complete'; preserve the higher status.
        if (hasWtMilestones) {
          merged.milestones = countChanges(adapter.prepare(`
            INSERT INTO milestones (
              id, title, status, depends_on, created_at, completed_at,
              vision, success_criteria, key_risks, proof_strategy,
              verification_contract, verification_integration, verification_operational, verification_uat,
              definition_of_done, requirement_coverage, boundary_map_markdown, sequence
            )
            SELECT w.id, w.title,
                   CASE
                     WHEN ${newerMilestoneLifecycle} THEN m.status
                     WHEN m.status IN (${TERMINAL_STATUS_SQL}) AND w.status NOT IN (${TERMINAL_STATUS_SQL})
                     THEN m.status ELSE w.status
                   END,
                   w.depends_on,
                   CASE
                     WHEN ${newerMilestoneLifecycle} THEN m.created_at
                     WHEN m.status IN (${TERMINAL_STATUS_SQL}) AND w.status NOT IN (${TERMINAL_STATUS_SQL})
                     THEN m.created_at ELSE w.created_at
                   END,
                   CASE
                     WHEN ${newerMilestoneLifecycle} THEN m.completed_at
                     WHEN m.status IN (${TERMINAL_STATUS_SQL}) AND w.status NOT IN (${TERMINAL_STATUS_SQL})
                     THEN m.completed_at ELSE w.completed_at
                   END,
                   w.vision, w.success_criteria, w.key_risks, w.proof_strategy,
                   w.verification_contract, w.verification_integration, w.verification_operational, w.verification_uat,
                   w.definition_of_done, w.requirement_coverage, w.boundary_map_markdown,
                   ${hasMilestoneSequence ? "COALESCE(w.sequence, 0)" : "COALESCE(m.sequence, 0)"}
            FROM wt.milestones w
            LEFT JOIN milestones m ON m.id = w.id
            WHERE true
            ON CONFLICT(id) DO UPDATE SET
              title = excluded.title,
              status = excluded.status,
              depends_on = excluded.depends_on,
              created_at = excluded.created_at,
              completed_at = excluded.completed_at,
              vision = excluded.vision,
              success_criteria = excluded.success_criteria,
              key_risks = excluded.key_risks,
              proof_strategy = excluded.proof_strategy,
              verification_contract = excluded.verification_contract,
              verification_integration = excluded.verification_integration,
              verification_operational = excluded.verification_operational,
              verification_uat = excluded.verification_uat,
              definition_of_done = excluded.definition_of_done,
              requirement_coverage = excluded.requirement_coverage,
              boundary_map_markdown = excluded.boundary_map_markdown,
              sequence = excluded.sequence
          `).run());
        }

        // Merge slices — preserve worktree progress but never downgrade completed status (#2558).
        // ADR-011 Phase 1: carry is_sketch + sketch_scope so reconcile doesn't
        // silently clear sketch metadata. When the worktree predates v16,
        // fall back to the main DB's existing value rather than a literal 0/''.
        if (hasWtSlices) {
          merged.slices = countChanges(adapter.prepare(`
            INSERT INTO slices (
              milestone_id, id, title, status, risk, depends, demo, created_at, completed_at,
              full_summary_md, full_uat_md, goal, success_criteria, proof_level,
              integration_closure, observability_impact, target_repositories, sequence, replan_triggered_at,
              is_sketch, sketch_scope
            )
            SELECT w.milestone_id, w.id, w.title,
                   CASE
                     WHEN ${newerSliceLifecycle} THEN m.status
                     WHEN m.status IN (${TERMINAL_STATUS_SQL}) AND w.status NOT IN (${TERMINAL_STATUS_SQL})
                     THEN m.status ELSE w.status
                   END,
                   w.risk, w.depends, w.demo, w.created_at,
                   CASE
                     WHEN ${newerSliceLifecycle} THEN m.completed_at
                     WHEN m.status IN (${TERMINAL_STATUS_SQL}) AND w.status NOT IN (${TERMINAL_STATUS_SQL})
                     THEN m.completed_at ELSE w.completed_at
                   END,
                   CASE WHEN ${newerSliceLifecycle} THEN m.full_summary_md ELSE w.full_summary_md END,
                   CASE WHEN ${newerSliceLifecycle} THEN m.full_uat_md ELSE w.full_uat_md END,
                   w.goal, w.success_criteria, w.proof_level,
                   w.integration_closure, w.observability_impact,
                   ${sliceTargetRepositoriesSql},
                   w.sequence, w.replan_triggered_at,
                   ${hasIsSketch ? "w.is_sketch" : "COALESCE(m.is_sketch, 0)"},
                   ${hasSketchScope ? "w.sketch_scope" : "COALESCE(m.sketch_scope, '')"}
            FROM wt.slices w
            LEFT JOIN slices m ON m.milestone_id = w.milestone_id AND m.id = w.id
            WHERE true
            ON CONFLICT(milestone_id, id) DO UPDATE SET
              title = excluded.title,
              status = excluded.status,
              risk = excluded.risk,
              depends = excluded.depends,
              demo = excluded.demo,
              created_at = excluded.created_at,
              completed_at = excluded.completed_at,
              full_summary_md = excluded.full_summary_md,
              full_uat_md = excluded.full_uat_md,
              goal = excluded.goal,
              success_criteria = excluded.success_criteria,
              proof_level = excluded.proof_level,
              integration_closure = excluded.integration_closure,
              observability_impact = excluded.observability_impact,
              target_repositories = excluded.target_repositories,
              sequence = excluded.sequence,
              replan_triggered_at = excluded.replan_triggered_at,
              is_sketch = excluded.is_sketch,
              sketch_scope = excluded.sketch_scope
          `).run());
        }

        // Merge tasks — preserve execution results, never downgrade completed status (#2558).
        // ADR-011 P2: carry blocker_source + escalation_* columns so worktree reconcile
        // doesn't silently clear escalation state back to defaults.
        if (hasWtTasks) {
          merged.tasks = countChanges(adapter.prepare(`
            INSERT INTO tasks (
              milestone_id, slice_id, id, title, status, one_liner, narrative,
              verification_result, duration, completed_at, blocker_discovered,
              deviations, known_issues, key_files, key_decisions, full_summary_md,
              description, estimate, files, verify, inputs, expected_output,
              observability_impact, full_plan_md, target_repositories, sequence,
              blocker_source, escalation_pending, escalation_awaiting_review,
              escalation_artifact_path, escalation_override_applied_at
            )
            SELECT w.milestone_id, w.slice_id, w.id, w.title,
                   CASE
                     WHEN ${newerTaskLifecycle} THEN m.status
                     WHEN m.status IN (${TERMINAL_STATUS_SQL}) AND w.status NOT IN (${TERMINAL_STATUS_SQL})
                     THEN m.status ELSE w.status
                   END,
                   CASE WHEN ${newerTaskLifecycle} THEN m.one_liner ELSE w.one_liner END,
                   CASE WHEN ${newerTaskLifecycle} THEN m.narrative ELSE w.narrative END,
                   CASE WHEN ${newerTaskLifecycle} THEN m.verification_result ELSE w.verification_result END,
                   CASE WHEN ${newerTaskLifecycle} THEN m.duration ELSE w.duration END,
                   CASE
                     WHEN ${newerTaskLifecycle} THEN m.completed_at
                     WHEN m.status IN (${TERMINAL_STATUS_SQL}) AND w.status NOT IN (${TERMINAL_STATUS_SQL})
                     THEN m.completed_at ELSE w.completed_at
                   END,
                   CASE WHEN ${newerTaskLifecycle} THEN m.blocker_discovered ELSE w.blocker_discovered END,
                   CASE WHEN ${newerTaskLifecycle} THEN m.deviations ELSE w.deviations END,
                   CASE WHEN ${newerTaskLifecycle} THEN m.known_issues ELSE w.known_issues END,
                   CASE WHEN ${newerTaskLifecycle} THEN m.key_files ELSE w.key_files END,
                   CASE WHEN ${newerTaskLifecycle} THEN m.key_decisions ELSE w.key_decisions END,
                   CASE WHEN ${newerTaskLifecycle} THEN m.full_summary_md ELSE w.full_summary_md END,
                   w.description, w.estimate, w.files, w.verify, w.inputs, w.expected_output,
                   w.observability_impact, w.full_plan_md,
                   ${taskTargetRepositoriesSql},
                   w.sequence,
                   ${hasBlockerSource ? `CASE WHEN ${newerTaskLifecycle} THEN m.blocker_source ELSE w.blocker_source END` : "COALESCE(m.blocker_source, '')"},
                   ${hasEscalationPending ? `CASE WHEN ${newerTaskLifecycle} THEN m.escalation_pending ELSE w.escalation_pending END` : "COALESCE(m.escalation_pending, 0)"},
                   ${hasEscalationAwaiting ? `CASE WHEN ${newerTaskLifecycle} THEN m.escalation_awaiting_review ELSE w.escalation_awaiting_review END` : "COALESCE(m.escalation_awaiting_review, 0)"},
                   ${hasEscalationArtifact ? `CASE WHEN ${newerTaskLifecycle} THEN m.escalation_artifact_path ELSE w.escalation_artifact_path END` : "m.escalation_artifact_path"},
                   ${hasEscalationOverride ? `CASE WHEN ${newerTaskLifecycle} THEN m.escalation_override_applied_at ELSE w.escalation_override_applied_at END` : "m.escalation_override_applied_at"}
            FROM wt.tasks w
            LEFT JOIN tasks m ON m.milestone_id = w.milestone_id AND m.slice_id = w.slice_id AND m.id = w.id
            WHERE true
            ON CONFLICT(milestone_id, slice_id, id) DO UPDATE SET
              title = excluded.title,
              status = excluded.status,
              one_liner = excluded.one_liner,
              narrative = excluded.narrative,
              verification_result = excluded.verification_result,
              duration = excluded.duration,
              completed_at = excluded.completed_at,
              blocker_discovered = excluded.blocker_discovered,
              deviations = excluded.deviations,
              known_issues = excluded.known_issues,
              key_files = excluded.key_files,
              key_decisions = excluded.key_decisions,
              full_summary_md = excluded.full_summary_md,
              description = excluded.description,
              estimate = excluded.estimate,
              files = excluded.files,
              verify = excluded.verify,
              inputs = excluded.inputs,
              expected_output = excluded.expected_output,
              observability_impact = excluded.observability_impact,
              full_plan_md = excluded.full_plan_md,
              target_repositories = excluded.target_repositories,
              sequence = excluded.sequence,
              blocker_source = excluded.blocker_source,
              escalation_pending = excluded.escalation_pending,
              escalation_awaiting_review = excluded.escalation_awaiting_review,
              escalation_artifact_path = excluded.escalation_artifact_path,
              escalation_override_applied_at = excluded.escalation_override_applied_at
          `).run());
        }

        // Merge memories — keep worktree-learned insights.
        // V18 (scope, tags), V21 (structured_fields), V28 (last_hit_at): for each
        // column the wt may not yet have (older worktree DB), fall back to the
        // main DB's existing value via LEFT JOIN so reconcile never silently
        // resets these fields to defaults on rows that already had them.
        if (hasWtMemories) {
          merged.memories = countChanges(adapter.prepare(`
            INSERT OR REPLACE INTO memories (
              seq, id, category, content, confidence, source_unit_type, source_unit_id,
              created_at, updated_at, superseded_by, hit_count,
              scope, tags, structured_fields, last_hit_at
            )
            SELECT w.seq, w.id, w.category, w.content, w.confidence, w.source_unit_type, w.source_unit_id,
                   w.created_at, w.updated_at, w.superseded_by, w.hit_count,
                   ${hasMemoryScope ? "w.scope" : "COALESCE(m.scope, 'project')"},
                   ${hasMemoryTags ? "w.tags" : "COALESCE(m.tags, '[]')"},
                   ${hasMemoryStructuredFields ? "w.structured_fields" : "m.structured_fields"},
                   ${hasMemoryLastHitAt ? "w.last_hit_at" : "m.last_hit_at"}
            FROM wt.memories w
            LEFT JOIN memories m ON m.id = w.id
          `).run());
        }

        if (hasWtReplanHistory) {
          merged.replan_history = countChanges(adapter.prepare(`
            INSERT INTO replan_history (
              milestone_id, slice_id, task_id, summary, previous_artifact_path, replacement_artifact_path, created_at
            )
            SELECT w.milestone_id, w.slice_id, w.task_id, w.summary, w.previous_artifact_path, w.replacement_artifact_path, w.created_at
            FROM wt.replan_history w
            WHERE EXISTS (SELECT 1 FROM milestones m WHERE m.id = w.milestone_id)
              AND NOT EXISTS (
                SELECT 1 FROM replan_history m
                WHERE m.milestone_id = w.milestone_id
                  AND m.slice_id IS w.slice_id
                  AND m.task_id IS w.task_id
                  AND m.summary = w.summary
                  AND m.previous_artifact_path IS w.previous_artifact_path
                  AND m.replacement_artifact_path IS w.replacement_artifact_path
              )
          `).run());
        }

        if (hasWtAssessments) {
          merged.assessments = countChanges(adapter.prepare(`
            INSERT OR REPLACE INTO assessments (
              path, milestone_id, slice_id, task_id, status, scope, full_content, created_at
            )
            SELECT w.path, w.milestone_id, w.slice_id, w.task_id, w.status, w.scope, w.full_content, w.created_at
            FROM wt.assessments w
            WHERE EXISTS (SELECT 1 FROM milestones m WHERE m.id = w.milestone_id)
          `).run());
        }

        if (hasWtQualityGates) {
          merged.quality_gates = countChanges(adapter.prepare(`
            INSERT OR REPLACE INTO quality_gates (
              milestone_id, slice_id, gate_id, scope, task_id, status, verdict, rationale, findings, evaluated_at
            )
            SELECT w.milestone_id, w.slice_id, w.gate_id, w.scope, COALESCE(w.task_id, ''), w.status, w.verdict, w.rationale, w.findings, w.evaluated_at
            FROM wt.quality_gates w
            WHERE EXISTS (SELECT 1 FROM slices s WHERE s.milestone_id = w.milestone_id AND s.id = w.slice_id)
          `).run());
        }

        if (hasWtSliceDependencies) {
          merged.slice_dependencies = countChanges(adapter.prepare(`
            INSERT OR IGNORE INTO slice_dependencies (milestone_id, slice_id, depends_on_slice_id)
            SELECT w.milestone_id, w.slice_id, w.depends_on_slice_id
            FROM wt.slice_dependencies w
            WHERE EXISTS (SELECT 1 FROM slices s WHERE s.milestone_id = w.milestone_id AND s.id = w.slice_id)
              AND EXISTS (SELECT 1 FROM slices d WHERE d.milestone_id = w.milestone_id AND d.id = w.depends_on_slice_id)
          `).run());
        }

        // Merge verification evidence — append-only, use INSERT OR IGNORE to avoid duplicates
        if (hasWtVerificationEvidence) {
          merged.verification_evidence = countChanges(adapter.prepare(`
            INSERT OR IGNORE INTO verification_evidence (
              task_id, slice_id, milestone_id, command, exit_code, verdict, duration_ms, created_at
            )
            SELECT task_id, slice_id, milestone_id, command, exit_code, verdict, duration_ms, created_at
            FROM wt.verification_evidence
          `).run());
        }

        if (hasWtGateRuns) {
          merged.gate_runs = countChanges(adapter.prepare(`
            INSERT INTO gate_runs (
              trace_id, turn_id, gate_id, gate_type, unit_type, unit_id, milestone_id, slice_id, task_id,
              outcome, failure_class, rationale, findings, attempt, max_attempts, retryable, evaluated_at
            )
            SELECT w.trace_id, w.turn_id, w.gate_id, w.gate_type, w.unit_type, w.unit_id, w.milestone_id, w.slice_id, w.task_id,
                   w.outcome, w.failure_class, w.rationale, w.findings, w.attempt, w.max_attempts, w.retryable, w.evaluated_at
            FROM wt.gate_runs w
            WHERE NOT EXISTS (
              SELECT 1 FROM gate_runs m
              WHERE m.trace_id = w.trace_id
                AND m.turn_id = w.turn_id
                AND m.gate_id = w.gate_id
                AND m.attempt = w.attempt
                AND m.evaluated_at = w.evaluated_at
            )
          `).run());
        }

        if (hasWtMilestoneCommitAttributions) {
          merged.milestone_commit_attributions = countChanges(adapter.prepare(`
            INSERT OR REPLACE INTO milestone_commit_attributions (
              commit_sha, milestone_id, slice_id, task_id, source, confidence, files_json, created_at
            )
            SELECT w.commit_sha, w.milestone_id, w.slice_id, w.task_id, w.source, w.confidence, w.files_json, w.created_at
            FROM wt.milestone_commit_attributions w
            WHERE EXISTS (SELECT 1 FROM milestones m WHERE m.id = w.milestone_id)
          `).run());
        }

      });
      return { ...merged, conflicts };
    } finally {
      try { adapter.exec("DETACH DATABASE wt"); } catch (e) { logWarning("db", `detach worktree DB failed: ${(e as Error).message}`); }
    }
  } catch (err) {
    if (err instanceof CanonicalWorktreeDivergenceError) throw err;
    logError("db", "worktree DB reconciliation failed", { error: (err as Error).message });
    return { ...zero, conflicts };
  }
}

// ─── Replan & Assessment Helpers ──────────────────────────────────────────
