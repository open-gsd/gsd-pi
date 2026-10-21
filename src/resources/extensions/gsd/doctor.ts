import { existsSync } from "node:fs";

import { loadFile, saveFile } from "./files.js";
import { _getAdapter, getMilestoneSlices, isDbAvailable } from "./gsd-db.js";
import {
  openExistingWorkflowDatabase,
  openWorkflowDatabaseIsolated,
  resolveWorkflowDatabaseLocation,
} from "./db-workspace.js";
import { hasRequiredSchemaFeature } from "./db-required-schema.js";
import { resolveMilestoneFile, milestonesDir, legacyMilestonesDir, resolveGsdRootFile } from "./paths.js";
import { deriveState } from "./state.js";
import { invalidateAllCaches } from "./cache.js";
import { loadEffectiveGSDPreferences, type GSDPreferences } from "./preferences.js";
import { appendDoctorHistory } from "./doctor-history.js";
import { checkWorkspaceRepositoryHealth } from "./doctor-workspace-checks.js";
import { collectPreferenceDiagnostics, formatPreferenceDiagnosticDetail } from "./preferences-diagnostics.js";

import type { DoctorIssue, DoctorIssueCode, DoctorReport } from "./doctor-types.js";
import { GLOBAL_STATE_CODES } from "./doctor-types.js";
import { checkGitHealth, checkRuntimeHealth, checkGlobalHealth, checkEngineHealth } from "./doctor-checks.js";
import { checkEnvironmentHealth } from "./doctor-environment.js";
import { checkGsdStateHealth } from "./doctor-state-checks.js";
import { validateTitle } from "./validation.js";

// ── Re-exports ─────────────────────────────────────────────────────────────
// All public types and functions from extracted modules are re-exported here
// so that existing imports from "./doctor.js" continue to work unchanged.
export type { DoctorSeverity, DoctorIssueCode, DoctorIssue, DoctorReport, DoctorSummary } from "./doctor-types.js";
export { summarizeDoctorIssues, filterDoctorIssues, formatDoctorReport, formatDoctorIssuesForPrompt, formatDoctorReportJson } from "./doctor-format.js";
export { readDoctorHistory, type DoctorHistoryEntry } from "./doctor-history.js";
export { runEnvironmentChecks, runFullEnvironmentChecks, formatEnvironmentReport, type EnvironmentCheckResult } from "./doctor-environment.js";
export { computeProgressScore, computeProgressScoreWithContext, formatProgressLine, formatProgressReport, type ProgressScore, type ProgressLevel } from "./progress-score.js";

export { validateTitle } from "./validation.js";

function inspectLivenessBackstopSchema(basePath: string): boolean | undefined {
  const databasePath = resolveWorkflowDatabaseLocation(basePath).projectDb;
  if (!existsSync(databasePath)) return undefined;
  const db = openWorkflowDatabaseIsolated(databasePath);
  if (!db) return undefined;
  try {
    return hasRequiredSchemaFeature(db, "liveness-backstop");
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

function recordLivenessBackstopStartupRepair(
  wasComplete: boolean | undefined,
  issues: DoctorIssue[],
  fixesApplied: string[],
): void {
  if (wasComplete !== false) return;
  const repaired = isDbAvailable() && hasRequiredSchemaFeature(_getAdapter()!, "liveness-backstop");
  issues.push({
    severity: repaired ? "info" : "error",
    code: "liveness_backstop_schema_missing",
    scope: "project",
    unitId: "project",
    message: repaired
      ? "The ADR-047 liveness backstop schema was missing when doctor started and was repaired through guarded database startup maintenance."
      : "The ADR-047 liveness backstop schema is missing. Run `/gsd doctor --fix` to repair it before starting auto-mode.",
    file: ".gsd/gsd.db",
    fixable: true,
  });
  if (repaired) fixesApplied.push("repaired liveness backstop schema through guarded startup maintenance");
}

function validatePreferenceShape(preferences: GSDPreferences): string[] {
  const issues: string[] = [];
  const listFields = ["always_use_skills", "prefer_skills", "avoid_skills", "custom_instructions"] as const;
  for (const field of listFields) {
    const value = preferences[field];
    if (value !== undefined && !Array.isArray(value)) {
      issues.push(`${field} must be a list`);
    }
  }

  if (preferences.skill_rules !== undefined) {
    if (!Array.isArray(preferences.skill_rules)) {
      issues.push("skill_rules must be a list");
    } else {
      for (const [index, rule] of preferences.skill_rules.entries()) {
        if (!rule || typeof rule !== "object") {
          issues.push(`skill_rules[${index}] must be an object`);
          continue;
        }
        if (typeof rule.when !== "string") {
          issues.push(`skill_rules[${index}].when must be a string`);
        }
        for (const key of ["use", "prefer", "avoid"] as const) {
          const value = (rule as unknown as Record<string, unknown>)[key];
          if (value !== undefined && !Array.isArray(value)) {
            issues.push(`skill_rules[${index}].${key} must be a list`);
          }
        }
      }
    }
  }

  return issues;
}

/** Build STATE.md content from derived state. Exported for guided-flow pre-dispatch rebuild (#3475). */
export function buildStateMarkdown(state: Awaited<ReturnType<typeof deriveState>>): string {
  const lines: string[] = [];
  lines.push("# GSD State", "");

  const activeMilestone = state.activeMilestone
    ? `${state.activeMilestone.id}: ${state.activeMilestone.title}`
    : "None";
  const activeSlice = state.activeSlice
    ? `${state.activeSlice.id}: ${state.activeSlice.title}`
    : "None";

  lines.push(`**Active Milestone:** ${activeMilestone}`);
  lines.push(`**Active Slice:** ${activeSlice}`);
  lines.push(`**Phase:** ${state.phase}`);
  if (state.requirements) {
    lines.push(`**Requirements Status:** ${state.requirements.active} active \u00b7 ${state.requirements.validated} validated \u00b7 ${state.requirements.deferred} deferred \u00b7 ${state.requirements.outOfScope} out of scope`);
  }
  lines.push("");
  lines.push("## Milestone Registry");

  for (const entry of state.registry) {
    const glyph = entry.status === "complete" ? "\u2705" : entry.status === "active" ? "\uD83D\uDD04" : entry.status === "parked" ? "\u23F8\uFE0F" : "\u2B1C";
    lines.push(`- ${glyph} **${entry.id}:** ${entry.title}`);
  }

  lines.push("");
  lines.push("## Recent Decisions");
  if (state.recentDecisions.length > 0) {
    for (const decision of state.recentDecisions) lines.push(`- ${decision}`);
  } else {
    lines.push("- None recorded");
  }

  lines.push("");
  lines.push("## Blockers");
  if (state.blockers.length > 0) {
    for (const blocker of state.blockers) lines.push(`- ${blocker}`);
  } else {
    lines.push("- None");
  }

  lines.push("");
  lines.push("## Next Action");
  lines.push(state.nextAction || "None");
  lines.push("");

  return lines.join("\n");
}

async function updateStateFile(basePath: string, fixesApplied: string[]): Promise<void> {
  const state = await deriveState(basePath);
  const path = resolveGsdRootFile(basePath, "STATE");
  await saveFile(path, buildStateMarkdown(state));
  fixesApplied.push(`updated ${path}`);
}

/** Rebuild STATE.md from current disk state. Exported for auto-mode post-hooks. */
export async function rebuildState(basePath: string): Promise<void> {
  invalidateAllCaches();
  const state = await deriveState(basePath);
  const path = resolveGsdRootFile(basePath, "STATE");
  await saveFile(path, buildStateMarkdown(state));
}

export async function selectDoctorScope(basePath: string, requestedScope?: string): Promise<string | undefined> {
  if (requestedScope) return requestedScope;

  const state = await deriveState(basePath);
  if (state.activeMilestone?.id && state.activeSlice?.id) {
    return `${state.activeMilestone.id}/${state.activeSlice.id}`;
  }
  if (state.activeMilestone?.id) {
    return state.activeMilestone.id;
  }

  const milestonesPath = milestonesDir(basePath);
  const legacyMilestonesPath = legacyMilestonesDir(basePath);
  if (!existsSync(milestonesPath) && !existsSync(legacyMilestonesPath)) return undefined;

  for (const milestone of state.registry) {
    const roadmapPath = resolveMilestoneFile(basePath, milestone.id, "ROADMAP");
    const roadmapContent = roadmapPath ? await loadFile(roadmapPath) : null;
    if (!roadmapContent) continue;
    const dbSlices = getMilestoneSlices(milestone.id);
    const allDone = dbSlices.length > 0 && dbSlices.every(s => s.status === "complete");
    if (!allDone) return milestone.id;
  }

  return state.registry[0]?.id;
}

export async function runGSDDoctor(basePath: string, options?: { fix?: boolean; dryRun?: boolean; scope?: string; fixLevel?: "task" | "all"; isolationMode?: "none" | "worktree" | "branch"; includeBuild?: boolean; includeTests?: boolean }): Promise<DoctorReport> {
  const issues: DoctorIssue[] = [];
  const fixesApplied: string[] = [];
  const fix = options?.fix === true;
  const dryRun = options?.dryRun === true;
  const fixLevel = options?.fixLevel ?? "all";

  const livenessBackstopSchemaWasComplete = inspectLivenessBackstopSchema(basePath);

  // CLI doctor can run before any tool handler has opened the DB. Runtime
  // health checks need the existing project DB to surface DB-backed crash
  // locks, paused sessions, and coordination rows.
  openExistingWorkflowDatabase(basePath);
  recordLivenessBackstopStartupRepair(livenessBackstopSchemaWasComplete, issues, fixesApplied);

  // Issue codes that represent completion state transitions — creating summary
  // stubs, marking slices/milestones done in the roadmap. These belong to the
  // dispatch lifecycle (complete-slice, complete-milestone units), not to
  // mechanical post-hook bookkeeping. When fixLevel is "task", these are
  // detected and reported but never auto-fixed.

  /** Whether a given issue code should be auto-fixed at the current fixLevel. */
  const shouldFix = (code: DoctorIssueCode): boolean => {
    if (!fix || dryRun) return false;
    if (fixLevel === "task" && GLOBAL_STATE_CODES.has(code)) return false;
    return true;
  };

  const prefs = loadEffectiveGSDPreferences(basePath);
  for (const diagnostic of collectPreferenceDiagnostics(basePath)) {
    issues.push({
      severity: diagnostic.severity,
      code: "invalid_preferences",
      scope: diagnostic.scope,
      unitId: "project",
      message: `GSD preferences ${diagnostic.kind}: ${formatPreferenceDiagnosticDetail(diagnostic)}`,
      file: diagnostic.path,
      fixable: false,
    });
  }
  if (prefs) {
    const prefIssues = validatePreferenceShape(prefs.preferences);
    for (const issue of prefIssues) {
      issues.push({
        severity: "warning",
        code: "invalid_preferences",
        scope: "project",
        unitId: "project",
        message: `GSD preferences invalid: ${issue}`,
        file: prefs.path,
        fixable: false,
      });
    }
  }

  // Git health checks — timed
  const t0git = Date.now();
  const isolationMode: "none" | "worktree" | "branch" = options?.isolationMode ??
    (prefs?.preferences?.git?.isolation === "worktree" ? "worktree" :
    prefs?.preferences?.git?.isolation === "branch" ? "branch" : "none");
  await checkGitHealth(basePath, issues, fixesApplied, shouldFix, isolationMode, dryRun);
  checkWorkspaceRepositoryHealth(basePath, prefs?.preferences, issues);
  const gitMs = Date.now() - t0git;

  // Runtime health checks — timed
  const t0runtime = Date.now();
  await checkRuntimeHealth(basePath, issues, fixesApplied, shouldFix);
  const runtimeMs = Date.now() - t0runtime;

  // Global health checks — cross-project state (e.g. orphaned project state dirs)
  await checkGlobalHealth(issues, fixesApplied, shouldFix);

  // Environment health checks — timed
  const t0env = Date.now();
  await checkEnvironmentHealth(basePath, issues, {
    includeRemote: !options?.scope,
    includeBuild: options?.includeBuild,
    includeTests: options?.includeTests,
  });
  const envMs = Date.now() - t0env;

  // Engine health checks — DB constraints and projection drift
  await checkEngineHealth(basePath, issues, fixesApplied, {
    repair: fix && !dryRun,
    repairDbLock: shouldFix("db_locked"),
  });

  const milestonesPath = milestonesDir(basePath);
  const legacyMilestonesPath2 = legacyMilestonesDir(basePath);
  if (!existsSync(milestonesPath) && !existsSync(legacyMilestonesPath2)) {
    const report: DoctorReport = { ok: issues.every(i => i.severity !== "error"), basePath, issues, fixesApplied, timing: { git: gitMs, runtime: runtimeMs, environment: envMs, gsdState: 0 } };
    await appendDoctorHistory(basePath, report);
    return report;
  }

  await checkGsdStateHealth(basePath, issues, fixesApplied, {
    fix,
    shouldFix,
    scope: options?.scope,
  });

  if (fix && !dryRun && fixesApplied.length > 0) {
    await updateStateFile(basePath, fixesApplied);
  }

  const report: DoctorReport = {
    ok: issues.every(issue => issue.severity !== "error"),
    basePath,
    issues,
    fixesApplied,
    timing: { git: gitMs, runtime: runtimeMs, environment: envMs, gsdState: Math.max(0, Date.now() - t0env - envMs) },
  };
  await appendDoctorHistory(basePath, report);
  return report;
}
