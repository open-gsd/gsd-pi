// Project/App: gsd-pi
// File Purpose: Markdown projection renderer for GSD workflow database rows.
// GSD Markdown Renderer — DB → Markdown file generation
//
// Transforms DB state into correct markdown files on disk.
// Each render function reads from DB, writes a markdown projection to disk,
// stores generated content in the artifacts table, and invalidates caches.
//
// Critical invariant: rendered markdown must round-trip through
// parseRoadmap(), parsePlan(), parseSummary() in files.ts.

import { readFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { createProjectionDirectorySync, removeProjectionFileSync } from "./atomic-write.js";
import { logWarning } from "./workflow-logger.js";
import { isClosedStatus, isHiddenFromRoadmap, toStatus } from "./status-guards.js";
import { isCanonicalStagedTaskSummaryState } from "./task-summary-projection-policy.js";
import { dirname, join } from "node:path";
import {
  getAllMilestones,
  getMilestone,
  getMilestoneScopedArtifacts,
  getSliceScopedArtifacts,
  getMilestoneSlices,
  getSliceTasks,
  getTasksBySliceIds,
  getTask,
  getSlice,
  insertArtifact,
  deleteArtifactByPath,
  getGateResults,
  getDbOrNull,
  isDbAvailable,
} from "./gsd-db.js";
import type { MilestoneRow, ArtifactRow } from "./db-milestone-artifact-rows.js";
import type { SliceRow, TaskRow } from "./db-task-slice-rows.js";
import type { GateRow } from "./types.js";
import {
  resolveDir,
  resolveFile,
  resolveSliceFile,
  resolveSlicePath,
  resolveTaskFile,
  resolveTasksDir,
  targetMilestoneFile,
  targetSliceFile,
  targetTaskFile,
  gsdProjectionRoot,
  gsdRoot,
  buildTaskFileName,
  buildSliceFileName,
} from "./paths.js";
import { saveFile, clearParseCache, registerCacheClearCallback } from "./files.js";
import { parseProjectionRoadmap } from "./schemas/parsers.js";
import { stripIdPrefix } from "./strip-id-prefix.js";
import { invalidateStateCache } from "./state.js";
import { clearPathCache, milestonesDir, legacyMilestonesDir, isLegacyMilestonesLayout, resolveMilestonePath, relSliceFile, canonicalPhaseDirName } from "./paths.js";
import { readCompatMarker, writeCompatMarker, computeProjectionSha, deriveCompatProjectionKey } from "./compat/compat-marker.js";
import type { RiskLevel } from "./types.js";
import {
  phaseDirName,
  derivePhaseSlug,
} from "./layout-policy.js";
import {
  readMilestoneCompletionProjection,
  renderMilestoneSummaryMarkdown,
} from "./milestone-summary-projection.js";

// ─── Compat marker invalidation ───────────────────────────────────────────
// Every successful projection write pushes its (basePath, projectionPath,
// entities) here; invalidateCaches() drains it and refreshes .gsd/.compat.json
// so the next reconcile pass sees gsd-pi's own writes as expected. This is the
// feedback-loop-prevention mechanism for cross-tool compatibility.
const _pendingProjectionWrites: Array<{
  basePath: string;
  projectionPath: string;
  entities: string[];
  sha: string;
}> = [];

function recordProjectionWrite(
  basePath: string,
  projectionPath: string,
  entities: string[],
  content: string,
): void {
  _pendingProjectionWrites.push({
    basePath,
    projectionPath,
    entities,
    sha: computeProjectionSha(content),
  });
}

function flushProjectionWritesToMarker(): void {
  if (_pendingProjectionWrites.length === 0) return;
  // Group by basePath (defensive — multiple projects are unusual but possible).
  const byBase = new Map<string, Map<string, { entities: string[]; sha: string }>>();
  for (const w of _pendingProjectionWrites) {
    let bucket = byBase.get(w.basePath);
    if (!bucket) { bucket = new Map(); byBase.set(w.basePath, bucket); }
    bucket.set(w.projectionPath, { entities: w.entities, sha: w.sha });
  }
  _pendingProjectionWrites.length = 0;

  for (const [basePath, writes] of byBase) {
    try {
      const marker = readCompatMarker(basePath);
      for (const [projectionPath, write] of writes) {
        marker.projections[projectionPath] = {
          sha: write.sha,
          entities: write.entities,
        };
      }
      marker.lastWriter = "gsd-pi";
      marker.lastProjectedAt = new Date().toISOString();
      writeCompatMarker(basePath, marker);
    } catch (e) {
      // Marker I/O must never break projection. Reconcile will heal on next run.
      logWarning("renderer", `compat marker flush failed: ${(e as Error).message}`);
    }
  }
}

// ─── State-version stamp ──────────────────────────────────────────────────
// Every projection written by this renderer carries an additive trailing
// HTML-comment stamp recording the DB project revision/authority epoch it was
// rendered from (the jj working-copy pattern). The stamp is the ONLY change to
// the byte stream — strip it and the pre-cutover projection format is
// reproduced exactly. Drift judgments compare projections stamp-insensitively
// against the current DB render intent, so a stamp-only difference is never
// content drift.

const STATE_VERSION_STAMP_RE = /<!-- gsd:state-version=(\d+):(\d+) -->/;
const TRAILING_STATE_VERSION_STAMP_RE = /<!-- gsd:state-version=\d+:\d+ -->[ \t]*(?:\r\n|\n)?$/;

export interface ProjectStateVersion {
  revision: number;
  authorityEpoch: number;
}

export class ProjectionWriteError extends Error {
  readonly stage = "artifact-persistence" as const;

  constructor(artifactPath: string, artifactType: string, taskScoped: boolean, cause: unknown) {
    const scope = taskScoped ? "task " : "";
    super(
      `${scope}${artifactType} projection artifact persistence failed: ${artifactPath}`,
      cause instanceof Error ? { cause } : undefined,
    );
    this.name = "ProjectionWriteError";
  }
}

/**
 * Current DB project revision/authority epoch — the same authority row the
 * cutover receipt (T006) advances. Falls back to 0:0 when the DB or its
 * authority row is unavailable; render paths always hold an open DB, so the
 * fallback only covers defensive/degraded callers.
 */
export function getCurrentProjectStateVersion(): ProjectStateVersion {
  const db = getDbOrNull();
  if (!db) return { revision: 0, authorityEpoch: 0 };
  try {
    const row = db.prepare(
      "SELECT revision, authority_epoch FROM project_authority WHERE singleton = 1",
    ).get() as { revision?: unknown; authority_epoch?: unknown } | undefined;
    return {
      revision: Number(row?.revision ?? 0),
      authorityEpoch: Number(row?.authority_epoch ?? 0),
    };
  } catch {
    return { revision: 0, authorityEpoch: 0 };
  }
}

/** Read the state-version stamp from projection content, if present. */
export function readProjectionStateVersion(content: string): ProjectStateVersion | null {
  const match = content.match(STATE_VERSION_STAMP_RE);
  if (!match) return null;
  return { revision: Number(match[1]), authorityEpoch: Number(match[2]) };
}

/** Remove a trailing state-version stamp line; unstamped content is unchanged. */
export function stripProjectionStamp(content: string): string {
  return content.replace(TRAILING_STATE_VERSION_STAMP_RE, "");
}

/**
 * Append the state-version stamp at the fixed end-of-file position. Any prior
 * trailing stamp is replaced, so re-renders of replayed artifact content stay
 * byte-stable instead of accumulating stamp lines.
 */
function stampProjectionContent(content: string): string {
  const { revision, authorityEpoch } = getCurrentProjectStateVersion();
  const stripped = stripProjectionStamp(content);
  const separator = stripped === "" || stripped.endsWith("\n") ? "" : "\n";
  return `${stripped}${separator}<!-- gsd:state-version=${revision}:${authorityEpoch} -->\n`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Convert an absolute file path to a .gsd-relative artifact path.
 * E.g. "/project/.gsd/milestones/M001/M001-ROADMAP.md" → "milestones/M001/M001-ROADMAP.md"
 */
function toArtifactPath(absPath: string, basePath: string): string {
  const projectionRoot = gsdProjectionRoot(basePath);
  return deriveCompatProjectionKey(absPath, [projectionRoot, gsdRoot(basePath)]);
}

/**
 * Invalidate all caches after a disk write.
 */
function invalidateCaches(): void {
  flushProjectionWritesToMarker();
  invalidateStateCache();
  clearPathCache();
  clearParseCache();
}

function meaningfulSection(value: string | null | undefined): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return "";
  if (/^(not provided\.?|none\.?|n\/a)$/i.test(trimmed)) return "";
  if (/^\{\{[^}]+\}\}$/.test(trimmed)) return "";
  return trimmed;
}

function renderGateFindings(gate: GateRow): string {
  const findings = gate.findings.trim() || `- **Verdict:** ${gate.verdict}\n- **Rationale:** ${gate.rationale}`;
  if (gate.verdict !== "flag") return findings;
  return `> **Warning:** Verdict: flag - concerns recorded below\n\n${findings}`;
}

function pushIndented(lines: string[], value: string, indent = "  "): void {
  for (const line of value.split("\n")) {
    // Blank (empty or whitespace-only, incl. a stray \r from CRLF input) lines
    // stay truly empty — indent-only lines are trailing whitespace that fails
    // git's whitespace checks (#2128).
    lines.push(line.trim() ? `${indent}${line}` : "");
  }
}

function taskSummaryForSlicePlan(description: string): string {
  const meaningful = meaningfulSection(description);
  if (!meaningful) return "";

  // The description is indented inside the flat-phase <tasks> block, so nested
  // headings remain task detail instead of becoming slice-level sections.
  return meaningful.replace(/<\/?tasks>/g, "").trim();
}

function normalizeRiskLevel(value: string | null | undefined): RiskLevel {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "low" || normalized === "medium" || normalized === "high") {
    return normalized;
  }
  return "medium";
}

function sanitizeInlineRoadmapText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/\r?\n+/g, " ")
    .replace(/[|`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isMilestoneFlatPhaseLayout(basePath: string, milestoneId: string): boolean {
  const existing = resolveMilestonePath(basePath, milestoneId);
  const legacyBase = legacyMilestonesDir(basePath);
  return existing
    ? !(existing.startsWith(legacyBase + "/") || existing.startsWith(legacyBase + "\\"))
    : !isLegacyMilestonesLayout(basePath);
}

/**
 * Write rendered content to disk and update the artifacts table.
 * The content is stamped with the current DB state version before writing;
 * disk bytes, artifact content, and the returned string are identical.
 */
async function writeAndStore(
  absPath: string,
  artifactPath: string,
  content: string,
  opts: {
    artifact_type: string;
    milestone_id: string;
    slice_id?: string;
    task_id?: string;
  },
  basePath: string,
): Promise<string> {
  const stamped = stampProjectionContent(content);
  await saveFile(absPath, stamped);

  try {
    insertArtifact({
      path: artifactPath,
      artifact_type: opts.artifact_type,
      milestone_id: opts.milestone_id,
      slice_id: opts.slice_id ?? null,
      task_id: opts.task_id ?? null,
      full_content: stamped,
    });
  } catch (error) {
    // Disk is a rebuildable projection, but callers must not report success
    // without its authoritative artifact lineage. The unstored disk copy is
    // intentionally left for drift reconciliation and post-mortem evidence.
    throw new ProjectionWriteError(
      artifactPath,
      opts.artifact_type,
      Boolean(opts.task_id),
      error,
    );
  }

  // Record the projection write so invalidateCaches() can refresh the compat
  // marker. basePath is optional only to avoid forcing every caller; when
  // present, the marker gets updated. artifactPath is already .gsd/-relative.
  if (basePath) {
    const entities: string[] = [];
    if (opts.milestone_id) entities.push(opts.milestone_id);
    if (opts.milestone_id && opts.slice_id) entities.push(`${opts.milestone_id}/${opts.slice_id}`);
    if (opts.milestone_id && opts.slice_id && opts.task_id) entities.push(`${opts.milestone_id}/${opts.slice_id}/${opts.task_id}`);
    recordProjectionWrite(basePath, artifactPath, entities, stamped);
  }

  invalidateCaches();
  return stamped;
}

function renderRoadmapMarkdown(milestone: MilestoneRow, slices: SliceRow[]): string {
  const lines: string[] = [];
  const displayTitle = stripIdPrefix(milestone.title || milestone.id, milestone.id);

  lines.push(`# ${milestone.id}: ${displayTitle}`);
  lines.push("");
  lines.push(milestone.vision ? `**Vision:** ${milestone.vision}` : "**Vision:**");
  lines.push("");

  if (milestone.success_criteria.length > 0) {
    lines.push("## Success Criteria");
    lines.push("");
    for (const criterion of milestone.success_criteria) {
      lines.push(`- ${criterion}`);
    }
    lines.push("");
  }

  lines.push("## Slices");
  lines.push("");
  for (const slice of slices) {
    const done = isClosedStatus(slice.status) ? "x" : " ";
    const cleanDepends = (slice.depends ?? []).map(d => d.replace(/^\[|\]$/g, '')).filter(d => /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(d));
    const depends = `[${cleanDepends.join(",")}]`;
    const safeTitle = sanitizeInlineRoadmapText(slice.title || slice.id) || slice.id;
    const safeRisk = normalizeRiskLevel(slice.risk);
    // ADR-011: sketch slices get a `[sketch]` badge so the roadmap shows at a
    // glance which slices are still pending refine-slice expansion. The badge
    // sits in front of `risk:` so it's visible in narrow terminals that may
    // truncate the line.
    const sketchBadge = slice.is_sketch === 1 ? "`[sketch]` " : "";
    lines.push(`- [${done}] **${slice.id}: ${safeTitle}** ${sketchBadge}\`risk:${safeRisk}\` \`depends:${depends}\``);
    lines.push(slice.demo ? `  > After this: ${slice.demo}` : "  > After this:");
    lines.push("");
  }

  if (milestone.boundary_map_markdown.trim()) {
    lines.push("## Boundary Map");
    lines.push("");
    lines.push(milestone.boundary_map_markdown.trim());
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function renderTaskPlanMarkdown(task: TaskRow, taskGates: GateRow[] = []): string {
  const description = meaningfulSection(task.description);
  const observabilityImpact = meaningfulSection(task.observability_impact);
  const estimatedSteps = Math.max(1, description.split(/\n+/).filter(Boolean).length || 1);
  const estimatedFiles = task.files.length > 0
    ? task.files.length
    : task.expected_output.length > 0
      ? task.expected_output.length
      : task.inputs.length > 0
        ? task.inputs.length
        : 1;

  const lines: string[] = [];
  lines.push("---");
  lines.push(`estimated_steps: ${estimatedSteps}`);
  lines.push(`estimated_files: ${estimatedFiles}`);
  lines.push("skills_used: []");
  lines.push(`required_workflow_tools: ${JSON.stringify(task.required_workflow_tools ?? [])}`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${task.id}: ${task.title || task.id}`);
  lines.push("");

  if (description) {
    lines.push(description);
    lines.push("");
  }

  lines.push("## Inputs");
  lines.push("");
  if (task.inputs.length > 0) {
    for (const input of task.inputs) {
      lines.push(`- \`${input}\``);
    }
  } else {
    lines.push("- None specified.");
  }
  lines.push("");

  lines.push("## Expected Output");
  lines.push("");
  if (task.expected_output.length > 0) {
    for (const output of task.expected_output) {
      lines.push(`- \`${output}\``);
    }
  } else if (task.files.length > 0) {
    for (const file of task.files) {
      lines.push(`- \`${file}\``);
    }
  } else {
    lines.push("- Update the implementation and proof artifacts needed for this task.");
  }
  lines.push("");

  lines.push("## Verification");
  lines.push("");
  lines.push(task.verify.trim() || "- Verify the task outcome with the slice-level checks.");
  lines.push("");

  if (observabilityImpact) {
    lines.push("## Observability Impact");
    lines.push("");
    lines.push(observabilityImpact);
    lines.push("");
  }

  // ── Quality Gate Sections (Q5/Q6/Q7) ──────────────────────────────────
  const gateLabels: Record<string, string> = { Q5: "Failure Modes", Q6: "Load Profile", Q7: "Negative Tests" };
  for (const [gid, label] of Object.entries(gateLabels)) {
    const gate = taskGates.find(g => g.gate_id === gid && g.status === "complete");
    if (gate && gate.verdict !== "omitted") {
      lines.push(`## ${label}`);
      lines.push("");
      lines.push(renderGateFindings(gate));
      lines.push("");
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function renderSlicePlanMarkdown(slice: SliceRow, tasks: TaskRow[], gates: GateRow[] = []): string {
  const lines: string[] = [];

  lines.push(`# ${slice.id}: ${slice.title || slice.id}`);
  lines.push("");
  // State the DB identities explicitly. Under flat-phase layout this file lives
  // at .gsd/phases/01-m001/01-01-PLAN.md, and an agent with only the path to go
  // on infers milestoneId "01-m001"/sliceId "01-01" — which the tool contract
  // rejects, since it demands the DB identities M001/S01.
  lines.push(`**Milestone:** ${slice.milestone_id}`);
  lines.push(`**Slice:** ${slice.id}`);
  lines.push("");
  lines.push(`**Goal:** ${slice.goal}`);
  lines.push(`**Demo:** ${slice.demo}`);
  lines.push("");

  lines.push("## Must-Haves");
  lines.push("");
  const successCriteria = meaningfulSection(slice.success_criteria);
  if (successCriteria) {
    for (const line of successCriteria.split(/\n+/).map((entry) => entry.trim()).filter(Boolean)) {
      lines.push(line.startsWith("-") ? line : `- ${line}`);
    }
  } else {
    lines.push("- Complete the planned slice outcomes.");
  }
  lines.push("");

  // ── Quality Gate Sections (Q3/Q4) ────────────────────────────────────
  const q3 = gates.find(g => g.gate_id === "Q3" && g.status === "complete");
  if (q3 && q3.verdict !== "omitted") {
    lines.push("## Threat Surface");
    lines.push("");
    lines.push(renderGateFindings(q3));
    lines.push("");
  }

  const q4 = gates.find(g => g.gate_id === "Q4" && g.status === "complete");
  if (q4 && q4.verdict !== "omitted") {
    lines.push("## Requirement Impact");
    lines.push("");
    lines.push(renderGateFindings(q4));
    lines.push("");
  }

  const proofLevel = meaningfulSection(slice.proof_level);
  if (proofLevel) {
    lines.push("## Proof Level");
    lines.push("");
    lines.push(`- This slice proves: ${proofLevel}`);
    lines.push("");
  }

  const integrationClosure = meaningfulSection(slice.integration_closure);
  if (integrationClosure) {
    lines.push("## Integration Closure");
    lines.push("");
    lines.push(integrationClosure);
    lines.push("");
  }

  lines.push("## Verification");
  lines.push("");
  const verification = meaningfulSection(slice.observability_impact);
  if (verification) {
    const verificationLines = verification
      .split(/\n+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    for (const line of verificationLines) {
      lines.push(line.startsWith("-") ? line : `- ${line}`);
    }
  } else {
    lines.push("- Run the task and slice verification checks for this slice.");
  }
  lines.push("");

  // Flat-phase: tasks render as a <tasks> XML block (gsd-core native format)
  // instead of a ## Tasks markdown section. This makes the plan file compatible
  // with gsd-core's parseOldPlan which extracts <tasks> blocks.
  lines.push("<tasks>");
  for (const task of tasks) {
    const done = isClosedStatus(task.status) ? "x" : " ";
    const estimate = task.estimate.trim() ? ` _(${task.estimate.trim()})_` : "";
    lines.push(`- [${done}] **${task.id}**: ${task.title || task.id}${estimate}`);
    const summary = taskSummaryForSlicePlan(task.description);
    if (summary) {
      pushIndented(lines, summary);
    }
    if (task.files.length > 0) {
      lines.push(`  - Files: ${task.files.map((file) => `\`${file}\``).join(", ")}`);
    }
    if (task.verify.trim()) {
      lines.push(`  - Verify: ${task.verify.trim()}`);
    }
  }
  lines.push("</tasks>");
  lines.push("");

  const filesLikelyTouched = Array.from(new Set(tasks.flatMap((task) => task.files)));
  if (filesLikelyTouched.length > 0) {
    lines.push("## Files Likely Touched");
    lines.push("");
    for (const file of filesLikelyTouched) {
      lines.push(`- ${file}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function getActivePlanTasks(milestoneId: string, sliceId: string): TaskRow[] {
  return getSliceTasks(milestoneId, sliceId).filter((task) => task.status !== "skipped");
}

function planProjectionPath(
  basePath: string,
  milestoneId: string,
  sliceId: string,
  outputPath?: string,
): string {
  if (outputPath) return outputPath;
  const existingPlanPath = resolveSliceFile(basePath, milestoneId, sliceId, "PLAN");
  if (existingPlanPath) return existingPlanPath;
  const milestoneTitle = getMilestone(milestoneId)?.title;
  return join(basePath, relSliceFile(basePath, milestoneId, sliceId, "PLAN", milestoneTitle));
}

export async function renderPlanFromDb(
  basePath: string,
  milestoneId: string,
  sliceId: string,
  outputPath?: string,
): Promise<{ planPath: string; taskPlanPaths: string[]; content: string }> {
  const slice = getSlice(milestoneId, sliceId);
  if (!slice) {
    throw new Error(`slice ${milestoneId}/${sliceId} not found`);
  }

  const tasks = getActivePlanTasks(milestoneId, sliceId);
  if (tasks.length === 0) {
    throw new Error(`no tasks found for ${milestoneId}/${sliceId}`);
  }

  // Layout-aware path: prefer an existing plan file's location so re-renders
  // stay in place (legacy: milestones/MID/slices/SID/SID-PLAN.md;
  // flat-phase: phases/NN-slug/NN-MM-PLAN.md).
  // Pass the milestone title so the fallback flat-phase dir uses the human-readable
  // slug ("05-milestone-five") rather than the bare ID slug ("05-m005").
  const absPath = planProjectionPath(basePath, milestoneId, sliceId, outputPath);
  createProjectionDirectorySync(dirname(absPath));
  const artifactPath = toArtifactPath(absPath, basePath);
  const sliceGates = getGateResults(milestoneId, sliceId, "slice");
  const content = renderSlicePlanMarkdown(slice, tasks, sliceGates);

  const stamped = await writeAndStore(absPath, artifactPath, content, {
    artifact_type: "PLAN",
    milestone_id: milestoneId,
    slice_id: sliceId,
  }, basePath);

  // Flat-phase: tasks are checkboxes inside the plan file, not separate files.
  // No per-task render loop — task state is in the <tasks> block above.
  const taskPlanPaths: string[] = [];

  return { planPath: absPath, taskPlanPaths, content: stamped };
}

export async function renderTaskPlanFromDb(
  basePath: string,
  milestoneId: string,
  sliceId: string,
  taskId: string,
): Promise<{ taskPlanPath: string; content: string }> {
  const task = getTask(milestoneId, sliceId, taskId);
  if (!task) {
    throw new Error(`task ${milestoneId}/${sliceId}/${taskId} not found`);
  }

  // Flat-phase: task plans live inside the phase dir, not a tasks/ subdir.
  // This function is legacy — tasks are now checkboxes inside the plan file.
  const existingPlanPath = resolveTaskFile(basePath, milestoneId, sliceId, taskId, "PLAN");
  let absPath: string;
  if (existingPlanPath) {
    absPath = existingPlanPath;
  } else {
    const slicePath = resolveSlicePath(basePath, milestoneId, sliceId);
    if (slicePath) {
      const tasksDir = resolveTasksDir(basePath, milestoneId, sliceId) ?? slicePath;
      mkdirSync(tasksDir, { recursive: true });
      absPath = join(tasksDir, buildTaskFileName(taskId, "PLAN"));
    } else {
      const existing = resolveMilestonePath(basePath, milestoneId);
      const legacyBase = legacyMilestonesDir(basePath);
      const isLegacyLayout = existing
        ? existing.startsWith(legacyBase + "/") || existing.startsWith(legacyBase + "\\")
        : isLegacyMilestonesLayout(basePath);
      const phaseDir = existing ?? join(
        isLegacyLayout ? legacyBase : milestonesDir(basePath),
        isLegacyLayout ? milestoneId : canonicalPhaseDirName(milestoneId, getMilestone(milestoneId)?.title),
      );
      mkdirSync(phaseDir, { recursive: true });
      const tasksDir = isLegacyLayout
        ? join(phaseDir, "slices", sliceId, "tasks")
        : phaseDir;
      mkdirSync(tasksDir, { recursive: true });
      absPath = join(tasksDir, buildTaskFileName(taskId, "PLAN"));
    }
  }
  const artifactPath = toArtifactPath(absPath, basePath);
  const taskGates = getGateResults(milestoneId, sliceId, "task").filter(g => g.task_id === taskId);
  const content = task.full_plan_md.trim() ? task.full_plan_md : renderTaskPlanMarkdown(task, taskGates);

  const stamped = await writeAndStore(absPath, artifactPath, content, {
    artifact_type: "PLAN",
    milestone_id: milestoneId,
    slice_id: sliceId,
    task_id: taskId,
  }, basePath);

  return { taskPlanPath: absPath, content: stamped };
}

export async function renderRoadmapFromDb(
  basePath: string,
  milestoneId: string,
): Promise<{ roadmapPath: string; content: string } | { skipped: "unplanned-milestone" }> {
  const milestone = getMilestone(milestoneId);
  if (!milestone) {
    throw new Error(`milestone ${milestoneId} not found`);
  }

  // Shared with roadmap-divergence detection (#1623) so the projection and the
  // drift check agree on which slices ROADMAP.md is expected to contain.
  const slices = getMilestoneSlices(milestoneId).filter(
    (slice) => !isHiddenFromRoadmap(slice.status),
  );

  // Refuse to render a stub ROADMAP for an unplanned milestone (#852).
  // A milestone row created by gsd_milestone_generate_id / ensureMilestoneDbRow
  // starts with title="" / vision="" and zero slices. Rendering that produces a
  // 38-byte stub (`# M015: M015\n\n**Vision:** \n\n## Slices`) which passes
  // existsSync but fails the plan-milestone "zero slices" content check —
  // trapping auto-mode in a finalize-retry loop. A real plan (written by
  // gsd_plan_milestone via writePlanRows) always sets a non-empty vision AND at
  // least one slice, so zero-slice + empty-vision is a reliable "never planned"
  // signal. Skip the write so verification sees a genuinely missing file (a
  // clear "write the ROADMAP" failure) instead of a misleading stub.
  if (slices.length === 0 && !milestone.vision.trim()) {
    logWarning(
      "projection",
      `renderRoadmapFromDb skipped unplanned milestone ${milestoneId} (zero slices, empty vision) — refusing to write a stub ROADMAP`,
    );
    const absPath = targetMilestoneFile(basePath, milestoneId, "ROADMAP", milestone.title);
    if (existsSync(absPath)) {
      const artifactPath = toArtifactPath(absPath, basePath);
      removeProjectionFileSync(absPath);
      try {
        deleteArtifactByPath(artifactPath);
      } catch {
        logWarning("renderer", `failed to remove artifact from DB: ${artifactPath}`);
      }
      invalidateCaches();
    }
    return { skipped: "unplanned-milestone" };
  }

  const absPath = targetMilestoneFile(basePath, milestoneId, "ROADMAP", milestone.title);
  const artifactPath = toArtifactPath(absPath, basePath);
  const content = renderRoadmapMarkdown(milestone, slices);

  const stamped = await writeAndStore(absPath, artifactPath, content, {
    artifact_type: "ROADMAP",
    milestone_id: milestoneId,
  }, basePath);

  return { roadmapPath: absPath, content: stamped };
}

// ─── Roadmap Checkbox Rendering ───────────────────────────────────────────

/**
 * Compatibility wrapper for legacy callers that used to patch roadmap
 * checkboxes in-place. Roadmaps are now regenerated from DB rows so stale
 * artifact content cannot preserve old titles/dependencies.
 *
 * @returns true if the roadmap was written, false on skip/error
 */
export async function renderRoadmapCheckboxes(
  basePath: string,
  milestoneId: string,
): Promise<boolean> {
  const rendered = await renderRoadmapFromDb(basePath, milestoneId);
  return !("skipped" in rendered);
}

/**
 * Project milestone-level artifacts (CONTEXT, RESEARCH, VALIDATION, etc.) from
 * the artifacts table into the flat-phase phase directory. ROADMAP is skipped
 * because renderRoadmapFromDb regenerates it from hierarchy rows.
 */
export async function renderMilestoneArtifactsFromDb(
  basePath: string,
  milestoneId: string,
): Promise<boolean> {
  const artifacts = getMilestoneScopedArtifacts(milestoneId);
  if (artifacts.length === 0) return false;

  const milestone = getMilestone(milestoneId);
  const milestoneComplete = toStatus(milestone?.status ?? "") === "complete";

  let wrote = false;
  for (const artifact of artifacts) {
    if (artifact.artifact_type === "ROADMAP") continue;
    if (artifact.artifact_type.toUpperCase() === "SUMMARY" && !milestoneComplete) continue;
    if (!artifact.full_content.trim()) continue;

    const absPath = targetMilestoneFile(
      basePath,
      milestoneId,
      artifact.artifact_type,
      milestone?.title,
    );
    mkdirSync(dirname(absPath), { recursive: true });
    const artifactPath = toArtifactPath(absPath, basePath);
    await writeAndStore(absPath, artifactPath, artifact.full_content, {
      artifact_type: artifact.artifact_type,
      milestone_id: milestoneId,
    }, basePath);
    wrote = true;
  }

  return wrote;
}

/** Render the canonical Milestone closeout from its immutable completion event. */
export async function renderMilestoneSummary(
  basePath: string,
  milestoneId: string,
): Promise<boolean> {
  const milestone = getMilestone(milestoneId);
  if (!milestone || toStatus(milestone.status) !== "complete") return false;

  const projection = readMilestoneCompletionProjection(milestoneId);
  if (!projection) return false;

  const absPath = targetMilestoneFile(basePath, milestoneId, "SUMMARY", milestone.title);
  const artifactPath = toArtifactPath(absPath, basePath);
  const content = renderMilestoneSummaryMarkdown(
    milestoneId,
    projection.completedAt,
    projection.closeout,
  );
  await writeAndStore(absPath, artifactPath, content, {
    artifact_type: "SUMMARY",
    milestone_id: milestoneId,
  }, basePath);
  return true;
}

/**
 * Slice-scoped artifacts (CONTEXT, RESEARCH, CONTINUE, etc.) must survive
 * layout migration. PLAN is normally regenerated from task rows, but a real
 * imported PLAN can still be replayed as a fallback; known recovery stubs are
 * treated as missing.
 */
export async function renderSliceArtifactsFromDb(
  basePath: string,
  milestoneId: string,
  sliceId: string,
): Promise<boolean> {
  const artifacts = getSliceScopedArtifacts(milestoneId, sliceId);
  if (artifacts.length === 0) return false;
  const sliceComplete = toStatus(getSlice(milestoneId, sliceId)?.status ?? "") === "complete";

  let wrote = false;
  for (const artifact of artifacts) {
    const artifactType = artifact.artifact_type.toUpperCase();
    if (!artifact.full_content.trim()) continue;
    if ((artifactType === "SUMMARY" || artifactType === "UAT") && !sliceComplete) continue;
    if (artifactType === "PLAN" && isAutoRecoveryPlaceholderPlan(artifact.full_content)) continue;

    const absPath = join(basePath, relSliceFile(basePath, milestoneId, sliceId, artifactType));
    createProjectionDirectorySync(dirname(absPath));
    const artifactPath = toArtifactPath(absPath, basePath);
    await writeAndStore(absPath, artifactPath, artifact.full_content, {
      artifact_type: artifactType,
      milestone_id: milestoneId,
      slice_id: sliceId,
    }, basePath);
    wrote = true;
  }

  return wrote;
}

function isAutoRecoveryPlaceholderPlan(content: string): boolean {
  return /(?:^|\n)\s*#\s*BLOCKER\b/i.test(content) && /auto-mode recovery failed/i.test(content);
}

// ─── Plan Checkbox Rendering ──────────────────────────────────────────────

/**
 * Render plan checkbox states from DB.
 *
 * Compatibility wrapper for legacy callers that used to patch plan checkboxes
 * in-place. Plans are now fully regenerated from DB rows (mirroring
 * renderRoadmapCheckboxes) so the projection always reflects the complete
 * current task set and statuses. The previous regex-patch approach reused the
 * cached PLAN artifact as the render input, which silently dropped tasks added
 * to the DB after the artifact was first written — producing a lossy
 * projection (the 4S/0T-vs-5S/13T drift class). The artifacts table is an
 * output sink, never a render input.
 *
 * @returns true if the plan was written, false when the DB slice has no tasks
 * @throws when the DB connection is unavailable or the render write fails
 */
export async function renderPlanCheckboxes(
  basePath: string,
  milestoneId: string,
  sliceId: string,
  outputPath?: string,
): Promise<boolean> {
  const tasks = getActivePlanTasks(milestoneId, sliceId);
  if (tasks.length === 0) {
    if (!isDbAvailable()) {
      throw new Error(`database unavailable while rendering plan checkboxes for ${milestoneId}/${sliceId}`);
    }
    process.stderr.write(
      `markdown-renderer: no tasks found for ${milestoneId}/${sliceId}\n`,
    );
    return false;
  }

  await renderPlanFromDb(basePath, milestoneId, sliceId, outputPath);
  return true;
}

// ─── Task Summary Rendering ───────────────────────────────────────────────

/**
 * Render a task summary from DB to disk.
 * Reads full_summary_md from the tasks table and writes it to the appropriate file.
 *
 * @returns true if the summary was written, false on skip/error
 */
export async function renderTaskSummary(
  basePath: string,
  milestoneId: string,
  sliceId: string,
  taskId: string,
): Promise<boolean> {
  const task = getTask(milestoneId, sliceId, taskId);
  const status = task ? toStatus(task.status) : null;
  if (!task || !task.full_summary_md) {
    return false;
  }
  if (status === "complete") {
    // Published completions keep projecting.
  } else if (
    status !== "in_progress" ||
    !isCanonicalStagedTaskSummaryState({ milestoneId, sliceId, taskId })
  ) {
    return false;
  }

  await writeTaskSummaryProjection(
    basePath,
    milestoneId,
    sliceId,
    taskId,
    task.full_summary_md,
  );

  return true;
}

/**
 * Persist task-summary projection bytes through the canonical projection seam.
 * Callers may render content differently, but stamping, disk placement,
 * artifact lineage, compatibility markers, and cache invalidation stay here.
 */
export async function writeTaskSummaryProjection(
  basePath: string,
  milestoneId: string,
  sliceId: string,
  taskId: string,
  content: string,
): Promise<{ artifactPath: string; content: string }> {
  const absPath = targetTaskFile(basePath, milestoneId, sliceId, taskId, "SUMMARY", getMilestone(milestoneId)?.title);
  const artifactPath = toArtifactPath(absPath, basePath);

  const stamped = await writeAndStore(absPath, artifactPath, content, {
    artifact_type: "SUMMARY",
    milestone_id: milestoneId,
    slice_id: sliceId,
    task_id: taskId,
  }, basePath);
  return { artifactPath, content: stamped };
}

// ─── Slice Summary Rendering ──────────────────────────────────────────────

/**
 * Render slice summary and UAT files from DB to disk.
 * Reads full_summary_md and full_uat_md from the slices table.
 *
 * @returns true if at least one file was written, false on skip/error
 */
export async function renderSliceSummary(
  basePath: string,
  milestoneId: string,
  sliceId: string,
): Promise<boolean> {
  const slice = getSlice(milestoneId, sliceId);
  if (!slice || toStatus(slice.status) !== "complete") {
    return false; // No slice data — skip silently
  }

  const milestoneTitle = getMilestone(milestoneId)?.title;
  let wrote = false;

  if (slice.full_summary_md) {
    const summaryAbs = targetSliceFile(basePath, milestoneId, sliceId, "SUMMARY", milestoneTitle);
    mkdirSync(dirname(summaryAbs), { recursive: true });
    const summaryArtifact = toArtifactPath(summaryAbs, basePath);

    await writeAndStore(summaryAbs, summaryArtifact, slice.full_summary_md, {
      artifact_type: "SUMMARY",
      milestone_id: milestoneId,
      slice_id: sliceId,
    }, basePath);
    wrote = true;
  }

  if (slice.full_uat_md) {
    const uatAbs = targetSliceFile(basePath, milestoneId, sliceId, "UAT", milestoneTitle);
    mkdirSync(dirname(uatAbs), { recursive: true });
    const uatArtifact = toArtifactPath(uatAbs, basePath);

    await writeAndStore(uatAbs, uatArtifact, slice.full_uat_md, {
      artifact_type: "UAT",
      milestone_id: milestoneId,
      slice_id: sliceId,
    }, basePath);
    wrote = true;
  }

  return wrote;
}

// ─── Render All From DB ───────────────────────────────────────────────────

export interface RenderAllResult {
  rendered: number;
  skipped: number;
  errors: string[];
}

/**
 * Iterate all milestones, slices, and tasks in the DB and render each artifact to disk.
 * Returns structured result for inspection.
 */
export async function renderAllFromDb(basePath: string): Promise<RenderAllResult> {
  const result: RenderAllResult = { rendered: 0, skipped: 0, errors: [] };
  const milestones = getAllMilestones();

  // Pre-fetch slices once per milestone and batch-load all tasks in one query
  // family, avoiding an N+1 (previously one task query per slice).
  const slicesByMilestone = new Map<string, SliceRow[]>();
  const slicePairs: Array<{ milestoneId: string; sliceId: string }> = [];
  for (const milestone of milestones) {
    const slices = getMilestoneSlices(milestone.id);
    slicesByMilestone.set(milestone.id, slices);
    for (const slice of slices) slicePairs.push({ milestoneId: milestone.id, sliceId: slice.id });
  }
  const tasksBySlice = getTasksBySliceIds(slicePairs);

  for (const milestone of milestones) {
    // Render roadmap checkboxes
    try {
      const ok = await renderRoadmapCheckboxes(basePath, milestone.id);
      if (ok) result.rendered++;
      else result.skipped++;
    } catch (err) {
      result.errors.push(`roadmap ${milestone.id}: ${(err as Error).message}`);
    }

    try {
      const ok = await renderMilestoneArtifactsFromDb(basePath, milestone.id);
      if (ok) result.rendered++;
      else result.skipped++;
    } catch (err) {
      result.errors.push(`milestone artifacts ${milestone.id}: ${(err as Error).message}`);
    }

    try {
      const ok = await renderMilestoneSummary(basePath, milestone.id);
      if (ok) result.rendered++;
      else result.skipped++;
    } catch (err) {
      result.errors.push(`milestone summary ${milestone.id}: ${(err as Error).message}`);
    }

    // Iterate slices (pre-fetched above)
    const slices = slicesByMilestone.get(milestone.id) ?? [];
    for (const slice of slices) {
      // Preserve slice-scoped artifacts imported from disk, including real PLAN
      // fallback content when task rows cannot regenerate it.
      try {
        const ok = await renderSliceArtifactsFromDb(basePath, milestone.id, slice.id);
        if (ok) result.rendered++;
        else result.skipped++;
      } catch (err) {
        result.errors.push(
          `slice artifacts ${milestone.id}/${slice.id}: ${(err as Error).message}`,
        );
      }

      // Render plan checkboxes
      try {
        const ok = await renderPlanCheckboxes(basePath, milestone.id, slice.id);
        if (ok) result.rendered++;
        else result.skipped++;
      } catch (err) {
        result.errors.push(
          `plan ${milestone.id}/${slice.id}: ${(err as Error).message}`,
        );
      }

      // Render slice summary
      try {
        const ok = await renderSliceSummary(basePath, milestone.id, slice.id);
        if (ok) result.rendered++;
        else result.skipped++;
      } catch (err) {
        result.errors.push(
          `slice summary ${milestone.id}/${slice.id}: ${(err as Error).message}`,
        );
      }

      // Iterate tasks (batched above)
      const tasks = tasksBySlice.get(`${milestone.id}\0${slice.id}`) ?? [];
      for (const task of tasks) {
        try {
          const ok = await renderTaskSummary(
            basePath,
            milestone.id,
            slice.id,
            task.id,
          );
          if (ok) result.rendered++;
          else result.skipped++;
        } catch (err) {
          result.errors.push(
            `task summary ${milestone.id}/${slice.id}/${task.id}: ${(err as Error).message}`,
          );
        }
      }
    }
  }

  // Re-project root DECISIONS.md from the authoritative decision records so a
  // full DB → markdown re-projection (rebuild or reconcile) also heals decisions
  // drift — e.g. a worktree merge that accepted one branch's DECISIONS.md while
  // the DB holds the union of both branches' decisions.
  try {
    const { regenerateDecisionsMarkdown } = await import("./db-writer.js");
    await regenerateDecisionsMarkdown(basePath);
    result.rendered++;
  } catch (err) {
    result.errors.push(`decisions: ${(err as Error).message}`);
  }

  // Project to .planning/ if the compat marker says it's active. Dynamic
  // import for writePlanningDirectory avoids a static-import cycle. Gated on
  // planning.active so the double-write cost only hits projects that use
  // .planning/. writePlanningDirectory records per-file SHAs via
  // applyPlanningProjectionWrites so the reconcile detector has a baseline.
  try {
    const marker = readCompatMarker(basePath);
    if (marker.planning?.active && marker.planning.layout) {
      if (marker.planning.layout === "flat-phases") {
        const { writePlanningDirectory } = await import("./migrate/planning-writer.js");
        await writePlanningDirectory(basePath, marker.planning.layout);
        result.rendered++;
      } else {
        logWarning(
          "renderer",
          `planning projection skipped: layout "${marker.planning.layout}" not yet supported (v1 supports flat-phases only)`,
        );
      }
    }
  } catch (err) {
    result.errors.push(`planning projection: ${(err as Error).message}`);
  }

  return result;
}

// ─── Stale Detection ──────────────────────────────────────────────────────

export interface StaleEntry {
  path: string;
  reason: string;
}

/**
 * Detect stale renders by comparing DB state against file content.
 *
 * Checks:
 * 1. Roadmap checkbox states vs DB slice statuses
 * 2. Plan checkbox states vs DB task statuses
 * 3. Missing SUMMARY.md files for complete tasks with full_summary_md (legacy only)
 * 4. Missing SUMMARY.md/UAT.md files for complete slices with content
 *
 * Returns a list of stale entries with file path and reason.
 * Logs to stderr when stale files are detected.
 */
// #442 Phase 1.5: cache parsed ROADMAP/PLAN projections by file identity
// (path + mtimeMs + size) so an unchanged projection skips readFileSync AND
// the parse entirely on repeated dispatches. The DB-vs-disk comparison below
// still runs every call against fresh DB rows — only the disk-parse half is
// memoized, and parsed output depends solely on file bytes, so this is
// behavior-preserving. Invalidation rides the existing clearParseCache()
// callback chain (fired by invalidateCaches() after every projection write and
// by reconcileBeforeDispatch repairs), so a changed file always re-parses.
interface CachedProjection { mtimeMs: number; size: number; parsed: unknown }
const _projectionParseCache = new Map<string, CachedProjection>();
registerCacheClearCallback(() => _projectionParseCache.clear());

function parseProjectionByIdentity(path: string, parse: (content: string) => unknown): unknown {
  let st: ReturnType<typeof statSync> | null = null;
  try { st = statSync(path); } catch { st = null; }
  if (st) {
    const hit = _projectionParseCache.get(path);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      return hit.parsed;
    }
    const parsed = parse(readFileSync(path, "utf-8"));
    _projectionParseCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, parsed });
    return parsed;
  }
  // stat failed (e.g. file vanished between existsSync and here) — fall back to
  // the original plain read+parse so error handling is unchanged.
  return parse(readFileSync(path, "utf-8"));
}

// ─── Projection Drift (DB-vs-render-intent) ───────────────────────────────
// Post-cutover staleness is judged DB-vs-render-intent: the on-disk bytes
// (stamp-insensitive) are compared against what the renderer would emit from
// current DB rows. Projection files are never parsed to make the judgment, so
// a hand-edit is drift while a stamp-only difference is not. Reasons keep the
// "in roadmap" / "in plan" markers the stale-render repair dispatch keys on.

interface ProjectionRenderIntent {
  path: string;
  content: string;
  reason: string;
}

function planRenderIntentDrift(
  basePath: string,
  milestoneId: string,
  slice: SliceRow,
  tasks: TaskRow[],
): StaleEntry | null {
  const planPath = resolveSliceFile(basePath, milestoneId, slice.id, "PLAN");
  if (!planPath || !existsSync(planPath)) return null;
  const intent = renderSlicePlanMarkdown(
    slice,
    tasks,
    getGateResults(milestoneId, slice.id, "slice"),
  );
  const actual = readFileSync(planPath, "utf-8");
  if (stripProjectionStamp(actual) === stripProjectionStamp(intent)) return null;
  return {
    path: planPath,
    reason: `plan for ${milestoneId}/${slice.id} differs from DB render intent (content drift in plan)`,
  };
}

function projectionRenderIntents(basePath: string): ProjectionRenderIntent[] {
  const intents = new Map<string, ProjectionRenderIntent>();
  const record = (path: string, content: string, reason: string): void => {
    intents.set(path, { path, content, reason });
  };

  for (const milestone of getAllMilestones()) {
    const slices = getMilestoneSlices(milestone.id);
    const roadmapSlices = slices.filter((slice) => !isHiddenFromRoadmap(slice.status));
    if (roadmapSlices.length > 0 || milestone.vision.trim()) {
      record(
        targetMilestoneFile(basePath, milestone.id, "ROADMAP", milestone.title),
        renderRoadmapMarkdown(milestone, roadmapSlices),
        `roadmap for ${milestone.id} differs from DB render intent (content drift in roadmap)`,
      );
    }

    const milestoneComplete = toStatus(milestone.status) === "complete";
    for (const artifact of getMilestoneScopedArtifacts(milestone.id)) {
      const artifactType = artifact.artifact_type.toUpperCase();
      if (artifact.artifact_type === "ROADMAP") continue;
      if (artifactType === "SUMMARY" && !milestoneComplete) continue;
      if (!artifact.full_content.trim()) continue;
      record(
        targetMilestoneFile(basePath, milestone.id, artifact.artifact_type, milestone.title),
        artifact.full_content,
        `${artifactType} for ${milestone.id} differs from DB render intent`,
      );
    }

    if (milestoneComplete) {
      try {
        const completion = readMilestoneCompletionProjection(milestone.id);
        if (completion) {
          record(
            targetMilestoneFile(basePath, milestone.id, "SUMMARY", milestone.title),
            renderMilestoneSummaryMarkdown(milestone.id, completion.completedAt, completion.closeout),
            `summary for ${milestone.id} differs from DB render intent`,
          );
        }
      } catch (error) {
        logWarning("renderer", `milestone summary drift check failed: ${(error as Error).message}`);
      }
    }

    for (const slice of slices) {
      const sliceComplete = toStatus(slice.status) === "complete";
      for (const artifact of getSliceScopedArtifacts(milestone.id, slice.id)) {
        const artifactType = artifact.artifact_type.toUpperCase();
        if (!artifact.full_content.trim()) continue;
        if ((artifactType === "SUMMARY" || artifactType === "UAT") && !sliceComplete) continue;
        if (artifactType === "PLAN") continue;
        record(
          join(basePath, relSliceFile(basePath, milestone.id, slice.id, artifactType)),
          artifact.full_content,
          `${artifactType} for ${milestone.id}/${slice.id} differs from DB render intent`,
        );
      }

      const activeTasks = getActivePlanTasks(milestone.id, slice.id);
      if (activeTasks.length > 0) {
        record(
          planProjectionPath(basePath, milestone.id, slice.id),
          renderSlicePlanMarkdown(
            slice,
            activeTasks,
            getGateResults(milestone.id, slice.id, "slice"),
          ),
          `plan for ${milestone.id}/${slice.id} differs from DB render intent (content drift in plan)`,
        );
      }

      if (sliceComplete && slice.full_summary_md) {
        record(
          targetSliceFile(basePath, milestone.id, slice.id, "SUMMARY", milestone.title),
          slice.full_summary_md,
          `summary for ${milestone.id}/${slice.id} differs from DB render intent`,
        );
      }
      if (sliceComplete && slice.full_uat_md) {
        record(
          targetSliceFile(basePath, milestone.id, slice.id, "UAT", milestone.title),
          slice.full_uat_md,
          `UAT for ${milestone.id}/${slice.id} differs from DB render intent`,
        );
      }

      for (const task of getSliceTasks(milestone.id, slice.id)) {
        const taskStatus = toStatus(task.status);
        const stagedSummaryIsCanonical = taskStatus === "in_progress" &&
          isCanonicalStagedTaskSummaryState({
            milestoneId: milestone.id,
            sliceId: slice.id,
            taskId: task.id,
          });
        if (
          (taskStatus !== "complete" && !stagedSummaryIsCanonical) ||
          !task.full_summary_md
        ) continue;
        record(
          targetTaskFile(basePath, milestone.id, slice.id, task.id, "SUMMARY", milestone.title),
          task.full_summary_md,
          `summary for ${milestone.id}/${slice.id}/${task.id} differs from DB render intent`,
        );
      }
    }
  }

  return [...intents.values()];
}

/**
 * Detect content drift between renderer-owned on-disk projections and current
 * DB render intent. State-version stamps do not participate in the comparison.
 */
export function detectProjectionDrift(basePath: string): StaleEntry[] {
  const stale: StaleEntry[] = [];
  for (const intent of projectionRenderIntents(basePath)) {
    if (!existsSync(intent.path)) continue;
    try {
      const actual = readFileSync(intent.path, "utf-8");
      if (stripProjectionStamp(actual) !== stripProjectionStamp(intent.content)) {
        stale.push({ path: intent.path, reason: intent.reason });
      }
    } catch (e) {
      logWarning("renderer", `projection drift check failed: ${(e as Error).message}`);
    }
  }
  return stale;
}

export function detectStaleRenders(basePath: string): StaleEntry[] {
  // TODO(flat-phase): stale-render detection is temporarily fully disabled.
  // The isLegacyMilestonesLayout gate is unreliable: git-service.ts creates
  // milestones/<mid>/ directories for integration-branch metadata even in
  // flat-phase projects, making the gate fire true and then producing false
  // stale-render drift in the second reconcile cycle → ReconciliationFailedError
  // → auto-mode blocked (exit 10) for multi-slice/remediation e2e scenarios.
  // Re-enable after path construction is unified and the metadata dir is
  // decoupled from the layout-detection signal.
  return [];
}

function detectStaleRendersImpl(basePath: string): StaleEntry[] {
  // per-call createRequire() for the legacy parsers that used to live here ran
  // on every dispatch. The static `./schemas/parsers.js` specifier resolves in
  // both packaged (.js) and source (.ts via the strip-types loader) contexts —
  // the same form a dozen other modules already use.
  const stale: StaleEntry[] = [];
  const milestones = getAllMilestones();

  for (const milestone of milestones) {
    const slices = getMilestoneSlices(milestone.id);
    const isFlatPhase = isMilestoneFlatPhaseLayout(basePath, milestone.id);

    // ── Check roadmap checkbox state ──────────────────────────────────
    // TODO(flat-phase): roadmap checkbox parsing may not match flat-phase
    // roadmap format, causing false-positive drift loops. Skip during transition.
    /*
    const roadmapPath = targetMilestoneFile(basePath, milestone.id, "ROADMAP", milestone.title);
    if (existsSync(roadmapPath)) {
      try {
        const parsed = parseProjectionByIdentity(roadmapPath, parseProjectionRoadmap) as ReturnType<typeof parseProjectionRoadmap>;

        for (const slice of slices) {
          const isCompleteInDb = isClosedStatus(slice.status);
          const roadmapSlice = parsed.slices.find((s: { id: string }) => s.id === slice.id);
          if (!roadmapSlice) continue;

          if (isCompleteInDb && !roadmapSlice!.done) {
            stale.push({
              path: roadmapPath,
              reason: `${slice.id} is closed in DB but unchecked in roadmap`,
            });
          } else if (!isCompleteInDb && roadmapSlice!.done) {
            stale.push({
              path: roadmapPath,
              reason: `${slice.id} is not closed in DB but checked in roadmap`,
            });
          }
        }
      } catch (e) {
        logWarning("renderer", `roadmap parse failed: ${(e as Error).message}`);
      }
    }
    */

    // ── Check plan checkbox state and summaries for each slice ────────
    for (const slice of slices) {
      const tasks = getActivePlanTasks(milestone.id, slice.id);

      if (!isFlatPhase) {
        // Check plan content against the DB render intent (T008): the
        // projection file is never parsed — staleness is judged
        // DB-vs-render-intent via a stamp-insensitive byte comparison.
        if (tasks.length > 0) {
          try {
            const entry = planRenderIntentDrift(basePath, milestone.id, slice, tasks);
            if (entry) stale.push(entry);
          } catch (e) {
            logWarning("renderer", `plan render-intent check failed: ${(e as Error).message}`);
          }
        }
      }

      // Check missing task summary files (legacy layout only — flat-phase keeps
      // task state in plan <tasks> blocks and does not project Txx-SUMMARY.md)
      if (!isFlatPhase) {
        for (const task of tasks) {
          if (isClosedStatus(task.status) && task.full_summary_md) {
            const slicePath = resolveSlicePath(basePath, milestone.id, slice.id);
            if (slicePath) {
              const fileName = buildTaskFileName(task.id, "SUMMARY");
              const summaryAbsPath = join(slicePath, fileName);

              if (!existsSync(summaryAbsPath)) {
                stale.push({
                  path: summaryAbsPath,
                  reason: `${task.id} is complete with summary in DB but SUMMARY.md missing on disk`,
                });
              }
            }
          }
        }
      }

      // Check missing slice summary/UAT files. Use the same target helper as
      // renderSliceSummary so detection and repair agree on flat-phase vs legacy
      // output locations.
      const sliceRow = getSlice(milestone.id, slice.id);
      if (sliceRow && sliceRow.status === "complete") {
        if (sliceRow.full_summary_md) {
          const summaryAbsPath = targetSliceFile(basePath, milestone.id, slice.id, "SUMMARY", milestone.title);
          if (!existsSync(summaryAbsPath)) {
            stale.push({
              path: summaryAbsPath,
              reason: `${slice.id} is complete with summary in DB but SUMMARY.md missing on disk`,
            });
          }
        }

        if (sliceRow.full_uat_md) {
          const uatAbsPath = targetSliceFile(basePath, milestone.id, slice.id, "UAT", milestone.title);
          if (!existsSync(uatAbsPath)) {
            stale.push({
              path: uatAbsPath,
              reason: `${slice.id} is complete with UAT in DB but UAT.md missing on disk`,
            });
          }
        }
      }
    }
  }

  if (stale.length > 0) {
    process.stderr.write(
      `markdown-renderer: detected ${stale.length} stale render(s):\n`,
    );
    for (const entry of stale) {
      process.stderr.write(`  - ${entry.path}: ${entry.reason}\n`);
    }
  }

  return stale;
}

/**
 * Render-verification helper: does the rendered ROADMAP markdown mark a slice
 * as done? Used by completion code to verify/repair the *projection* after a
 * DB write — never as a source of truth for dispatch or completion decisions
 * (ADR-017). Lives here so decision-path modules need not import the legacy
 * markdown parsers directly.
 */
export function roadmapRenderMarksSliceDone(roadmapContent: string, sliceId: string): boolean {
  return parseProjectionRoadmap(roadmapContent).slices.some((slice) => slice.id === sliceId && slice.done);
}

// ─── Stale Repair ─────────────────────────────────────────────────────────
// Body relocated to state-reconciliation/drift/stale-render.ts (ADR-017 #5702).
// detectStaleRenders above stays as a useful diagnostic primitive; the
// drift handler composes it with the per-reason renderer dispatch and the
// reconcileBeforeDispatch lifecycle.

// ─── Replan & Assessment Renderers ────────────────────────────────────────

export interface ReplanData {
  blockerTaskId: string;
  blockerDescription: string;
  whatChanged: string;
  createdAt?: string;
}

export interface AssessmentData {
  verdict: string;
  assessment: string;
  completedSliceId?: string;
  createdAt?: string;
}

function existingLegacySliceAssessmentPath(
  basePath: string,
  milestoneId: string,
  sliceId: string,
): string | null {
  if (!isLegacyMilestonesLayout(basePath)) return null;
  const legacyBase = legacyMilestonesDir(basePath);
  const milestoneDirName = resolveDir(legacyBase, milestoneId);
  if (!milestoneDirName) return null;
  const slicesDir = join(legacyBase, milestoneDirName, "slices");
  const sliceDirName = resolveDir(slicesDir, sliceId);
  if (!sliceDirName) return null;
  return join(slicesDir, sliceDirName, `${sliceId}-ASSESSMENT.md`);
}

export function resolveAssessmentProjectionPath(
  basePath: string,
  milestoneId: string,
  sliceId: string,
): string {
  return existingLegacySliceAssessmentPath(basePath, milestoneId, sliceId)
    ?? targetSliceFile(
      basePath,
      milestoneId,
      sliceId,
      "ASSESSMENT",
      getMilestone(milestoneId)?.title,
    );
}

export function resolveRoadmapAssessmentProjectionPath(
  basePath: string,
  milestoneId: string,
): string {
  const legacyDir = join(legacyMilestonesDir(basePath), milestoneId);
  if (existsSync(legacyDir)) {
    return join(legacyDir, `${milestoneId}-ROADMAP-ASSESSMENT.md`);
  }
  return targetMilestoneFile(
    basePath,
    milestoneId,
    "ROADMAP-ASSESSMENT",
    getMilestone(milestoneId)?.title,
  );
}

export async function renderReplanFromDb(
  basePath: string,
  milestoneId: string,
  sliceId: string,
  replanData: ReplanData,
): Promise<{ replanPath: string; content: string }> {
  const absPath = targetSliceFile(
    basePath,
    milestoneId,
    sliceId,
    "REPLAN",
    getMilestone(milestoneId)?.title,
  );
  mkdirSync(dirname(absPath), { recursive: true });
  const artifactPath = toArtifactPath(absPath, basePath);

  const lines: string[] = [];
  lines.push(`# ${sliceId} Replan`);
  lines.push("");
  lines.push(`**Milestone:** ${milestoneId}`);
  lines.push(`**Slice:** ${sliceId}`);
  lines.push(`**Blocker Task:** ${replanData.blockerTaskId}`);
  lines.push(`**Created:** ${replanData.createdAt ?? new Date().toISOString()}`);
  lines.push("");
  lines.push("## Blocker Description");
  lines.push("");
  lines.push(replanData.blockerDescription);
  lines.push("");
  lines.push("## What Changed");
  lines.push("");
  lines.push(replanData.whatChanged);
  lines.push("");

  const content = `${lines.join("\n").trimEnd()}\n`;

  const stamped = await writeAndStore(absPath, artifactPath, content, {
    artifact_type: "REPLAN",
    milestone_id: milestoneId,
    slice_id: sliceId,
  }, basePath);

  return { replanPath: absPath, content: stamped };
}

export async function renderAssessmentFromDb(
  basePath: string,
  milestoneId: string,
  sliceId: string,
  assessmentData: AssessmentData,
): Promise<{ assessmentPath: string; content: string }> {
  const absPath = resolveAssessmentProjectionPath(basePath, milestoneId, sliceId);
  mkdirSync(dirname(absPath), { recursive: true });
  const artifactPath = toArtifactPath(absPath, basePath);

  const lines: string[] = [];
  lines.push(`# ${sliceId} Assessment`);
  lines.push("");
  lines.push(`**Milestone:** ${milestoneId}`);
  lines.push(`**Slice:** ${sliceId}`);
  if (assessmentData.completedSliceId) {
    lines.push(`**Completed Slice:** ${assessmentData.completedSliceId}`);
  }
  lines.push(`**Verdict:** ${assessmentData.verdict}`);
  lines.push(`**Created:** ${assessmentData.createdAt ?? new Date().toISOString()}`);
  lines.push("");
  lines.push("## Assessment");
  lines.push("");
  lines.push(assessmentData.assessment);
  lines.push("");

  const content = `${lines.join("\n").trimEnd()}\n`;

  const stamped = await writeAndStore(absPath, artifactPath, content, {
    artifact_type: "ASSESSMENT",
    milestone_id: milestoneId,
    slice_id: sliceId,
  }, basePath);

  return { assessmentPath: absPath, content: stamped };
}

export async function renderRoadmapAssessmentFromDb(
  basePath: string,
  milestoneId: string,
  assessmentData: AssessmentData,
): Promise<{ assessmentPath: string; content: string }> {
  const absPath = resolveRoadmapAssessmentProjectionPath(basePath, milestoneId);
  mkdirSync(dirname(absPath), { recursive: true });
  const artifactPath = toArtifactPath(absPath, basePath);

  const lines = [
    `# ${milestoneId} Roadmap Assessment`,
    "",
    `**Milestone:** ${milestoneId}`,
    ...(assessmentData.completedSliceId ? [`**Completed Slice:** ${assessmentData.completedSliceId}`] : []),
    `**Verdict:** ${assessmentData.verdict}`,
    `**Created:** ${assessmentData.createdAt ?? new Date().toISOString()}`,
    "",
    "## Assessment",
    "",
    assessmentData.assessment,
    "",
  ];
  const content = `${lines.join("\n").trimEnd()}\n`;
  const stamped = await writeAndStore(absPath, artifactPath, content, {
    artifact_type: "ASSESSMENT",
    milestone_id: milestoneId,
  }, basePath);

  return { assessmentPath: absPath, content: stamped };
}
