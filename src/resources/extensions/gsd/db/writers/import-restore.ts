// Project/App: gsd-pi
// File Purpose: Bulk import/restore writers for the single-writer layer.
// restoreManifest rebuilds the engine DB from a StateManifest;
// bulkInsertLegacyHierarchy replaces the milestone/slice/task hierarchy from
// markdown-parsed payloads. Both own an immediate transaction and contain only
// write SQL, read through the shared engine handle.
import { createHash } from "node:crypto";
import { getDbOrNull, immediateTransaction } from "../engine.js";
import { GSDError, GSD_STALE_STATE } from "../../errors.js";
import type { StateManifest } from "../../workflow-manifest.js";

export function assertNoAdoptedLifecycleHistory(
  operation: string,
  milestoneIds?: readonly string[],
): void {
  const db = getDbOrNull();
  if (!db) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  if (milestoneIds?.length === 0) return;

  const scope = milestoneIds
    ? ` WHERE milestone_id IN (${milestoneIds.map(() => "?").join(",")})`
    : "";
  const adopted = db.prepare(
    `SELECT 1 AS adopted FROM workflow_item_lifecycles${scope} LIMIT 1`,
  ).get(...(milestoneIds ?? []));
  if (adopted !== undefined) {
    throw new GSDError(
      GSD_STALE_STATE,
      `${operation}: cannot replace hierarchy with adopted canonical lifecycle history`,
    );
  }
}

export function restoreManifest(manifest: StateManifest): void {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  const db = getDbOrNull()!;

  immediateTransaction(() => {
    assertNoAdoptedLifecycleHistory("restoreManifest");
    const restoredMilestoneIds = new Set(manifest.milestones.map((m) => m.id));
    const restoredSliceKeys = new Set(manifest.slices.map((s) => JSON.stringify([s.milestone_id, s.id])));
    const preservedReplanHistory = manifest.replan_history === undefined
      ? db.prepare("SELECT * FROM replan_history ORDER BY id").all() as unknown as NonNullable<StateManifest["replan_history"]>
      : [];
    const preservedAssessments = manifest.assessments === undefined
      ? db.prepare("SELECT * FROM assessments ORDER BY path").all() as unknown as NonNullable<StateManifest["assessments"]>
      : [];
    const preservedQualityGates = manifest.quality_gates === undefined
      ? db.prepare("SELECT * FROM quality_gates ORDER BY milestone_id, slice_id, gate_id, task_id").all() as unknown as NonNullable<StateManifest["quality_gates"]>
      : [];
    const preservedCommitAttributions = manifest.milestone_commit_attributions === undefined
      ? db.prepare("SELECT * FROM milestone_commit_attributions ORDER BY milestone_id, commit_sha").all() as unknown as NonNullable<StateManifest["milestone_commit_attributions"]>
      : [];

    // Clear workflow tables in dependency order.
    db.exec("DELETE FROM verification_evidence");
    db.exec("DELETE FROM quality_gates");
    db.exec("DELETE FROM slice_dependencies");
    db.exec("DELETE FROM assessments");
    db.exec("DELETE FROM replan_history");
    db.exec("DELETE FROM milestone_commit_attributions");
    db.exec("DELETE FROM tasks");
    db.exec("DELETE FROM slices");
    db.exec("DELETE FROM milestone_leases");
    db.exec("DELETE FROM milestones");
    db.exec("DELETE FROM decisions WHERE 1=1");
    db.exec(`DELETE FROM memories WHERE category = 'architecture' AND structured_fields LIKE '%"sourceDecisionId":"%'`);
    if (manifest.artifacts !== undefined) db.exec("DELETE FROM artifacts");
    if (manifest.requirements !== undefined) db.exec("DELETE FROM requirements");

    if (manifest.requirements !== undefined) {
      const reqStmt = db.prepare(
        `INSERT INTO requirements (
          id, class, status, description, why, source, primary_owner,
          supporting_slices, validation, notes, full_content, superseded_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of manifest.requirements) {
        reqStmt.run(
          r.id, r.class, r.status, r.description, r.why, r.source, r.primary_owner,
          r.supporting_slices, r.validation, r.notes, r.full_content, r.superseded_by,
        );
      }
    }

    if (manifest.artifacts !== undefined) {
      const artStmt = db.prepare(
        `INSERT INTO artifacts (
          path, artifact_type, milestone_id, slice_id, task_id, full_content, imported_at, content_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const a of manifest.artifacts) {
        const fullContent = a.full_content ?? "";
        artStmt.run(
          a.path, a.artifact_type, a.milestone_id, a.slice_id, a.task_id,
          fullContent, a.imported_at, a.content_hash ?? createHash("sha256").update(fullContent).digest("hex"),
        );
      }
    }

    // Restore milestones
    const msStmt = db.prepare(
      `INSERT INTO milestones (id, title, status, depends_on, created_at, completed_at,
        vision, success_criteria, key_risks, proof_strategy,
        verification_contract, verification_integration, verification_operational, verification_uat,
        definition_of_done, requirement_coverage, boundary_map_markdown, sequence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const m of manifest.milestones) {
      msStmt.run(
        m.id, m.title, m.status,
        JSON.stringify(m.depends_on), m.created_at, m.completed_at,
        m.vision, JSON.stringify(m.success_criteria), JSON.stringify(m.key_risks),
        JSON.stringify(m.proof_strategy),
        m.verification_contract, m.verification_integration, m.verification_operational, m.verification_uat,
        JSON.stringify(m.definition_of_done), m.requirement_coverage, m.boundary_map_markdown, m.sequence ?? 0,
      );
    }

    // Restore slices (ADR-011 Phase 1: includes is_sketch + sketch_scope)
    const slStmt = db.prepare(
      `INSERT INTO slices (milestone_id, id, title, status, risk, depends, demo,
        created_at, completed_at, full_summary_md, full_uat_md,
        goal, success_criteria, proof_level, integration_closure, observability_impact,
        target_repositories, sequence, replan_triggered_at, is_sketch, sketch_scope)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const s of manifest.slices) {
      slStmt.run(
        s.milestone_id, s.id, s.title, s.status, s.risk,
        JSON.stringify(s.depends), s.demo,
        s.created_at, s.completed_at, s.full_summary_md, s.full_uat_md,
        s.goal, s.success_criteria, s.proof_level, s.integration_closure, s.observability_impact,
        JSON.stringify(s.target_repositories ?? []),
        s.sequence, s.replan_triggered_at,
        s.is_sketch ?? 0,
        s.sketch_scope ?? "",
      );
    }

    const depStmt = db.prepare(
      "INSERT OR IGNORE INTO slice_dependencies (milestone_id, slice_id, depends_on_slice_id) VALUES (?, ?, ?)",
    );
    for (const s of manifest.slices) {
      for (const dep of s.depends ?? []) {
        depStmt.run(s.milestone_id, s.id, dep);
      }
    }

    // Restore tasks (ADR-011 P2: includes blocker_source + escalation_* columns)
    const tkStmt = db.prepare(
      `INSERT INTO tasks (milestone_id, slice_id, id, title, status,
        one_liner, narrative, verification_result, duration, completed_at,
        blocker_discovered, deviations, known_issues, key_files, key_decisions,
        full_summary_md, description, estimate, files, verify,
        inputs, expected_output, observability_impact, full_plan_md, target_repositories, sequence,
        blocker_source, escalation_pending, escalation_awaiting_review,
        escalation_artifact_path, escalation_override_applied_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const t of manifest.tasks) {
      tkStmt.run(
        t.milestone_id, t.slice_id, t.id, t.title, t.status,
        t.one_liner, t.narrative, t.verification_result, t.duration, t.completed_at,
        t.blocker_discovered ? 1 : 0, t.deviations, t.known_issues,
        JSON.stringify(t.key_files), JSON.stringify(t.key_decisions),
        t.full_summary_md, t.description, t.estimate, JSON.stringify(t.files), t.verify,
        JSON.stringify(t.inputs), JSON.stringify(t.expected_output),
        t.observability_impact, t.full_plan_md ?? "", JSON.stringify(t.target_repositories ?? []), t.sequence,
        t.blocker_source ?? "",
        t.escalation_pending ?? 0,
        t.escalation_awaiting_review ?? 0,
        t.escalation_artifact_path ?? null,
        t.escalation_override_applied_at ?? null,
      );
    }

    // Restore decisions (ADR-011 P2: include source so escalation decisions survive)
    const dcStmt = db.prepare(
      `INSERT INTO decisions (seq, id, when_context, scope, decision, choice, rationale, revisable, made_by, source, superseded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const d of manifest.decisions) {
      dcStmt.run(d.seq, d.id, d.when_context, d.scope, d.decision, d.choice, d.rationale, d.revisable, d.made_by, d.source ?? "discussion", d.superseded_by);
    }

    const replanHistoryRows = manifest.replan_history ?? preservedReplanHistory.filter((r) => restoredMilestoneIds.has(r.milestone_id));
    if (replanHistoryRows.length > 0) {
      const replStmt = db.prepare(
        `INSERT INTO replan_history (
          id, milestone_id, slice_id, task_id, summary, previous_artifact_path, replacement_artifact_path, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of replanHistoryRows) {
        replStmt.run(
          r.id, r.milestone_id, r.slice_id, r.task_id, r.summary,
          r.previous_artifact_path, r.replacement_artifact_path, r.created_at,
        );
      }
    }

    const assessmentRows = manifest.assessments ?? preservedAssessments.filter((a) => restoredMilestoneIds.has(a.milestone_id));
    if (assessmentRows.length > 0) {
      const assessStmt = db.prepare(
        `INSERT INTO assessments (
          path, milestone_id, slice_id, task_id, status, scope, full_content, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const a of assessmentRows) {
        assessStmt.run(
          a.path, a.milestone_id, a.slice_id, a.task_id,
          a.status, a.scope, a.full_content, a.created_at,
        );
      }
    }

    const qualityGateRows = manifest.quality_gates ?? preservedQualityGates.filter((g) => (
      restoredSliceKeys.has(JSON.stringify([g.milestone_id, g.slice_id]))
    ));
    if (qualityGateRows.length > 0) {
      const gateStmt = db.prepare(
        `INSERT INTO quality_gates (
          milestone_id, slice_id, gate_id, scope, task_id, status, verdict, rationale, findings, evaluated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const g of qualityGateRows) {
        gateStmt.run(
          g.milestone_id, g.slice_id, g.gate_id, g.scope, g.task_id,
          g.status, g.verdict ?? "", g.rationale, g.findings, g.evaluated_at,
        );
      }
    }

    const commitAttributionRows = manifest.milestone_commit_attributions ??
      preservedCommitAttributions.filter((a) => restoredMilestoneIds.has(a.milestone_id));
    if (commitAttributionRows.length > 0) {
      const attrStmt = db.prepare(
        `INSERT OR REPLACE INTO milestone_commit_attributions (
          commit_sha, milestone_id, slice_id, task_id, source, confidence, files_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const a of commitAttributionRows) {
        attrStmt.run(
          a.commit_sha, a.milestone_id, a.slice_id, a.task_id,
          a.source, a.confidence, a.files_json, a.created_at,
        );
      }
    }

    // Restore verification evidence
    const evStmt = db.prepare(
      `INSERT INTO verification_evidence (task_id, slice_id, milestone_id, command, exit_code, verdict, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const e of manifest.verification_evidence) {
      evStmt.run(e.task_id, e.slice_id, e.milestone_id, e.command, e.exit_code, e.verdict, e.duration_ms, e.created_at);
    }
  });
}

// ─── Legacy markdown → DB bulk migration ─────────────────────────────────

export interface LegacyMilestoneInsert {
  id: string;
  title: string;
  status: string;
}

export interface LegacySliceInsert {
  id: string;
  milestoneId: string;
  title: string;
  status: string;
  risk: string;
  sequence: number;
}

export interface LegacyTaskInsert {
  id: string;
  sliceId: string;
  milestoneId: string;
  title: string;
  status: string;
  sequence: number;
}

/**
 * Bulk delete + insert a legacy milestone hierarchy for markdown → DB migration.
 * Populates engine tables from parsed ROADMAP/PLAN files.
 * All operations run inside a single transaction.
 */
export function bulkInsertLegacyHierarchy(payload: {
  milestones: LegacyMilestoneInsert[];
  slices: LegacySliceInsert[];
  tasks: LegacyTaskInsert[];
  clearMilestoneIds: string[];
  createdAt: string;
}): void {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  const db = getDbOrNull()!;
  const { milestones, slices, tasks, clearMilestoneIds, createdAt } = payload;

  if (clearMilestoneIds.length === 0) return;
  const placeholders = clearMilestoneIds.map(() => "?").join(",");

  immediateTransaction(() => {
    assertNoAdoptedLifecycleHistory("bulkInsertLegacyHierarchy", clearMilestoneIds);
    db.prepare(`DELETE FROM tasks WHERE milestone_id IN (${placeholders})`).run(...clearMilestoneIds);
    db.prepare(`DELETE FROM slices WHERE milestone_id IN (${placeholders})`).run(...clearMilestoneIds);
    db.prepare(`DELETE FROM milestone_leases WHERE milestone_id IN (${placeholders})`).run(...clearMilestoneIds);
    db.prepare(`DELETE FROM milestones WHERE id IN (${placeholders})`).run(...clearMilestoneIds);

    const insertMilestone = db.prepare(
      "INSERT INTO milestones (id, title, status, created_at) VALUES (?, ?, ?, ?)",
    );
    for (const m of milestones) {
      insertMilestone.run(m.id, m.title, m.status, createdAt);
    }

    const insertSliceStmt = db.prepare(
      "INSERT INTO slices (id, milestone_id, title, status, risk, depends, sequence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const s of slices) {
      insertSliceStmt.run(s.id, s.milestoneId, s.title, s.status, s.risk, "[]", s.sequence, createdAt);
    }

    const insertTaskStmt = db.prepare(
      "INSERT INTO tasks (id, slice_id, milestone_id, title, description, status, estimate, files, sequence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const t of tasks) {
      insertTaskStmt.run(t.id, t.sliceId, t.milestoneId, t.title, "", t.status, "", "[]", t.sequence);
    }
  });
}
