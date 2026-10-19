// Project/App: gsd-pi
// File Purpose: DB-authoritative roadmap, project query and health reads for
// external surfaces (MCP gsd_roadmap / gsd_query / gsd_doctor and
// `gsd read roadmap`). ADR-046: these readers answer from database rows, so a
// deleted or stale projection file does not change the answer.

import { deriveState, invalidateStateCache } from "./derive/index.js";
import { ensureExistingWorkflowDbOpen } from "./derive/db-open.js";
import { queryProject, queryRequirements } from "../context-store.js";
import { generateRequirementsMd } from "../db-writer.js";
import { isDbAvailable, readTransaction } from "../gsd-db.js";
import {
  readMilestones,
  readMilestoneSlices,
  readSliceTasks,
  type MilestoneRead,
} from "../db/lifecycle-read.js";
import { resolveMilestoneFile, resolveSliceFile } from "../paths.js";
import { normalizeLegacyLifecycleStatus } from "../status-guards.js";
import { stripIdPrefix } from "../strip-id-prefix.js";
import { renderStateContent } from "../workflow-projections.js";
import type { ProjectProgressReadMetadata } from "@opengsd/contracts";

const DB_READ_METADATA: ProjectProgressReadMetadata = {
  source: "database",
  authority: "db-authoritative",
};

/** The status buckets of the integration contract: done, in flight, or not started. */
function bucket(item: { status: string; done: boolean }): "done" | "active" | "pending" {
  if (item.done) return "done";
  return normalizeLegacyLifecycleStatus(item.status) === "in_progress" ? "active" : "pending";
}

function openProjectDb(basePath: string): boolean {
  return ensureExistingWorkflowDbOpen(basePath) && isDbAvailable();
}

/** Listed Milestones in workflow order. A discarded Milestone is a tombstone and is not listed. */
function listedMilestones(milestoneId?: string): MilestoneRead[] {
  return readMilestones().filter((m) => !m.discarded && (!milestoneId || m.id === milestoneId));
}

// ─── Roadmap ────────────────────────────────────────────────────────────────

/**
 * Structural mirror of `RoadmapResult`
 * (packages/mcp-server/src/readers/roadmap.ts) plus the read provenance.
 */
export interface DbRoadmapResult {
  milestones: Array<{
    id: string;
    title: string;
    status: "done" | "active" | "pending" | "parked";
    vision: string;
    slices: Array<{
      id: string;
      title: string;
      status: "done" | "active" | "pending";
      risk: string;
      depends: string[];
      demo: string;
      tasks: Array<{ id: string; title: string; status: "done" | "pending" }>;
    }>;
  }>;
  readMetadata: ProjectProgressReadMetadata;
}

/** The roadmap hierarchy from database rows, or null when the project has no openable database. */
export function readRoadmapFromDb(basePath: string, milestoneId?: string): DbRoadmapResult | null {
  if (!openProjectDb(basePath)) return null;
  return readTransaction(() => ({
    milestones: listedMilestones(milestoneId).map((m) => ({
      id: m.id,
      title: stripIdPrefix(m.title, m.id) || m.id,
      status: m.parked ? "parked" as const : bucket(m),
      vision: m.vision,
      slices: readMilestoneSlices(m.id).map((s) => ({
        id: s.id,
        title: s.title,
        status: bucket(s),
        risk: s.risk || "medium",
        depends: s.depends,
        demo: s.demo,
        tasks: readSliceTasks(m.id, s.id).map((t) => ({
          id: t.id,
          title: t.title,
          status: t.done ? "done" as const : "pending" as const,
        })),
      })),
    })),
    readMetadata: { ...DB_READ_METADATA },
  }));
}

// ─── Project query ──────────────────────────────────────────────────────────

export type ProjectQueryField = "state" | "project" | "requirements" | "milestones";

/**
 * The fields of the MCP `gsd_query` result. `state`, `project` and
 * `requirements` keep the markdown shape of the files they replace, but the
 * text is built from database rows.
 */
export interface DbProjectQueryResult {
  state?: string;
  project?: string | null;
  requirements?: string | null;
  milestones?: Array<{ id: string; title: string; status: string; hasRoadmap: boolean; hasSummary: boolean }>;
  readMetadata: ProjectProgressReadMetadata;
}

/** The requested `gsd_query` fields from database rows, or null when the project has no openable database. */
export async function readProjectQueryFromDb(
  basePath: string,
  fields: readonly ProjectQueryField[],
): Promise<DbProjectQueryResult | null> {
  if (!openProjectDb(basePath)) return null;
  const wanted = new Set(fields);
  const result: DbProjectQueryResult = { readMetadata: { ...DB_READ_METADATA } };

  if (wanted.has("state")) {
    invalidateStateCache();
    result.state = renderStateContent(await deriveState(basePath));
  }
  if (wanted.has("project")) result.project = queryProject();
  if (wanted.has("requirements")) {
    const requirements = queryRequirements();
    result.requirements = requirements.length > 0 ? generateRequirementsMd(requirements) : null;
  }
  if (wanted.has("milestones")) {
    result.milestones = readTransaction(() => listedMilestones().map((m) => ({
      id: m.id,
      title: stripIdPrefix(m.title, m.id) || m.id,
      status: m.status,
      // Kept for one contract version: a planned Milestone has Slices, a summarized one is done.
      hasRoadmap: readMilestoneSlices(m.id).length > 0,
      hasSummary: m.done,
    })));
  }
  return result;
}

// ─── Health check ───────────────────────────────────────────────────────────

/**
 * Structural mirror of `DoctorResult`
 * (packages/mcp-server/src/readers/doctor-lite.ts) plus the read provenance.
 */
export interface DbDoctorResult {
  ok: boolean;
  issues: Array<{
    severity: "info" | "warning" | "error";
    code: string;
    scope: "project" | "milestone" | "slice" | "task";
    unitId: string;
    message: string;
  }>;
  counts: { error: number; warning: number; info: number };
  readMetadata: ProjectProgressReadMetadata;
}

/**
 * Health of the hierarchy as the database records it, or null when the project
 * has no openable database. A status that contradicts its child rows is an
 * error. A missing projection file is drift: the database still holds the
 * state, so it is reported as info with the rebuild command.
 */
export function runDoctorFromDb(basePath: string, scope?: string): DbDoctorResult | null {
  if (!openProjectDb(basePath)) return null;
  const issues: DbDoctorResult["issues"] = [];
  const missingProjection = (issueScope: "milestone" | "slice", unitId: string, file: string): void => {
    issues.push({
      severity: "info",
      code: "projection_missing",
      scope: issueScope,
      unitId,
      message: `${unitId} has no ${file} file — the database holds the state; run /gsd rebuild markdown to render it`,
    });
  };

  readTransaction(() => {
    for (const milestone of listedMilestones(scope)) {
      const slices = readMilestoneSlices(milestone.id);
      const openSlices = slices.filter((slice) => !slice.done);
      if (milestone.done && openSlices.length > 0) {
        issues.push({
          severity: "error",
          code: "milestone_done_with_open_slices",
          scope: "milestone",
          unitId: milestone.id,
          message: `${milestone.id} is complete in the database but ${openSlices.map((s) => s.id).join(", ")} is not`,
        });
      }
      if (!milestone.closed && slices.length > 0 && openSlices.length === 0) {
        issues.push({
          severity: "warning",
          code: "all_slices_done_milestone_open",
          scope: "milestone",
          unitId: milestone.id,
          message: `${milestone.id} has all slices completed but the milestone is not complete`,
        });
      }
      if (slices.length > 0 && !resolveMilestoneFile(basePath, milestone.id, "ROADMAP")) {
        missingProjection("milestone", milestone.id, "ROADMAP.md");
      }

      for (const slice of slices) {
        const unitId = `${milestone.id}/${slice.id}`;
        const tasks = readSliceTasks(milestone.id, slice.id);
        const openTasks = tasks.filter((task) => !task.done);
        if (slice.done && openTasks.length > 0) {
          issues.push({
            severity: "error",
            code: "slice_done_with_open_tasks",
            scope: "slice",
            unitId,
            message: `${unitId} is complete in the database but ${openTasks.map((t) => t.id).join(", ")} is not`,
          });
        }
        if (tasks.length > 0 && !resolveSliceFile(basePath, milestone.id, slice.id, "PLAN")) {
          missingProjection("slice", unitId, "PLAN.md");
        }
      }
    }
  });

  const counts = {
    error: issues.filter((i) => i.severity === "error").length,
    warning: issues.filter((i) => i.severity === "warning").length,
    info: issues.filter((i) => i.severity === "info").length,
  };
  return { ok: counts.error === 0, issues, counts, readMetadata: { ...DB_READ_METADATA } };
}
