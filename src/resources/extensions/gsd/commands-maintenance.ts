/**
 * GSD Maintenance — cleanup, skip, dry-run, and recover handlers.
 *
 * Contains: handleCleanupBranches, handleCleanupSnapshots, handleCleanupWorktrees, handleSkip, handleDryRun, handleRecover, handleRebuild
 */

import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import {
  chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, linkSync, lstatSync,
  mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync,
  rmdirSync, unlinkSync, writeFileSync, constants as fsConstants,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { deriveState } from "./state.js";
import { nativeBranchList, nativeDetectMainBranch, nativeBranchListMerged, nativeBranchDelete, nativeForEachRef, nativeUpdateRef } from "./native-git-bridge.js";
import { logWarning } from "./workflow-logger.js";
import {
  applyPreparedVerifiedRecoverApplication,
  loadRetainedVerifiedRecoverApplication,
  loadVerifiedRecoverApplication,
  prepareVerifiedRecoverApplication,
  type PreparedVerifiedRecoverApplication,
} from "./db-workspace.js";
import {
  executeLegacyImportRecoveryAction,
  parseLegacyImportRecoveryAction,
} from "./legacy-import-recovery-action.js";
import {
  formatLegacyImportForwardRepairChoice,
  parseLegacyImportForwardRepairChoices,
} from "./legacy-import-forward-repair-choice-token.js";
import { LegacyImportBaseSnapshotError } from "./legacy-import-preview-base.js";
import { LEGACY_IMPORT_RESTORE_ASSESSMENT_CONSENT_SCHEMA_VERSION, type LegacyImportRestoreAssessmentConsent } from "./legacy-import-restore-assessment.js";
import {
  preserveProjectionChanges,
  rebuildMarkdownProjectionsFromDb,
  type RebuildMarkdownProjectionsResult,
} from "./projection-worker.js";

export { rebuildMarkdownProjectionsFromDb };
export type { RebuildMarkdownProjectionsResult };

export async function handleCleanupBranches(ctx: ExtensionCommandContext, basePath: string): Promise<void> {
  let branches: string[];
  try {
    branches = nativeBranchList(basePath, "gsd/*");
  } catch (e) {
    logWarning("command", `branch list failed: ${(e as Error).message}`);
    ctx.ui.notify("No GSD branches to clean up.", "info");
    return;
  }

  const quickBranches = branches.filter((b) => b.startsWith("gsd/quick/"));

  const mainBranch = nativeDetectMainBranch(basePath);
  let merged: string[];
  try {
    merged = nativeBranchListMerged(basePath, mainBranch, "gsd/*");
  } catch (e) {
    logWarning("command", `merged branch list failed: ${(e as Error).message}`);
    merged = [];
  }

  const mergedNonQuick = merged.filter((b) => !b.startsWith("gsd/quick/"));
  let deletedMerged = 0;
  for (const branch of mergedNonQuick) {
    try {
      nativeBranchDelete(basePath, branch, false);
      deletedMerged++;
    } catch (e) {
      logWarning("command", `branch delete failed for ${branch}: ${(e as Error).message}`);
    }
  }

  // Also delete stale milestone branches for completed milestones when detached
  // from any registered worktree. DB-only: the database is the canonical state
  // source, so a branch with no DB milestone row (or no DB at all) is skipped.
  let deletedStaleMilestones = 0;
  try {
    const { listWorktrees } = await import("./worktree-manager.js");
    const { isDbAvailable, getMilestone } = await import("./gsd-db.js");

    const attachedBranches = new Set(
      listWorktrees(basePath).map((wt) => wt.branch),
    );
    const milestoneBranches = nativeBranchList(basePath, "milestone/*");
    for (const branch of milestoneBranches) {
      if (attachedBranches.has(branch)) continue;
      const milestoneId = branch.replace(/^milestone\//, "");

      if (!isDbAvailable()) continue;
      const dbRow = getMilestone(milestoneId);
      if (!dbRow) continue;
      if (dbRow.status !== "complete" && dbRow.status !== "done") continue;
      // Milestone is complete per DB — proceed to delete branch
      try {
        nativeBranchDelete(basePath, branch, true);
        deletedStaleMilestones++;
      } catch (e) { logWarning("command", `stale milestone branch delete failed for ${branch}: ${(e as Error).message}`); }
    }
  } catch (e) {
    logWarning("command", `stale milestone cleanup failed: ${(e as Error).message}`);
  }

  const summary: string[] = [];
  if (deletedMerged > 0) {
    summary.push(`Cleaned up ${deletedMerged} merged branch${deletedMerged === 1 ? "" : "es"}.`);
  }
  if (deletedStaleMilestones > 0) {
    summary.push(`Deleted ${deletedStaleMilestones} stale milestone branch${deletedStaleMilestones === 1 ? "" : "es"}.`);
  }
  if (quickBranches.length > 0) {
    summary.push(`Skipped ${quickBranches.length} quick branch${quickBranches.length === 1 ? "" : "es"} (gsd/quick/*).`);
  }

  if (summary.length === 0) {
    const nonQuickCount = branches.filter((b) => !b.startsWith("gsd/quick/")).length;
    ctx.ui.notify(
      nonQuickCount > 0
        ? `${nonQuickCount} GSD branch${nonQuickCount === 1 ? "" : "es"} found, none merged into ${mainBranch} yet.`
        : "No non-quick GSD branches to clean up.",
      "info",
    );
    return;
  }

  ctx.ui.notify(summary.join(" "), "success");
}

export async function handleCleanupSnapshots(ctx: ExtensionCommandContext, basePath: string): Promise<void> {
  let refs: string[];
  try {
    refs = nativeForEachRef(basePath, "refs/gsd/snapshots/");
  } catch (e) {
    logWarning("command", `snapshot ref list failed: ${(e as Error).message}`);
    ctx.ui.notify("No snapshot refs to clean up.", "info");
    return;
  }

  if (refs.length === 0) {
    ctx.ui.notify("No snapshot refs to clean up.", "info");
    return;
  }

  const byLabel = new Map<string, string[]>();
  for (const ref of refs) {
    const parts = ref.split("/");
    const label = parts.slice(0, -1).join("/");
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label)!.push(ref);
  }

  let pruned = 0;
  for (const [, labelRefs] of byLabel) {
    const sorted = labelRefs.sort();
    for (const old of sorted.slice(0, -5)) {
      try {
        nativeUpdateRef(basePath, old);
        pruned++;
      } catch (e) {
        logWarning("command", `snapshot ref update failed for ${old}: ${(e as Error).message}`);
      }
    }
  }

  ctx.ui.notify(`Pruned ${pruned} old snapshot refs. ${refs.length - pruned} remain.`, "success");
}

export async function handleCleanupWorktrees(ctx: ExtensionCommandContext, basePath: string): Promise<void> {
  const { getAllWorktreeHealth, formatWorktreeStatusLine } = await import("./worktree-health.js");
  const { removeWorktree } = await import("./worktree-manager.js");
  const { sep } = await import("node:path");

  let statuses;
  try {
    statuses = getAllWorktreeHealth(basePath);
  } catch (e) {
    logWarning("command", `worktree health inspection failed: ${(e as Error).message}`);
    ctx.ui.notify("Failed to inspect worktrees.", "error");
    return;
  }

  if (statuses.length === 0) {
    ctx.ui.notify("No GSD worktrees found.", "info");
    return;
  }

  const safeToRemove = statuses.filter(s => s.safeToRemove);
  const stale = statuses.filter(s => s.stale && !s.safeToRemove);
  const active = statuses.filter(s => !s.safeToRemove && !s.stale);

  const lines: string[] = [];
  lines.push(`${statuses.length} worktree${statuses.length === 1 ? "" : "s"} found.`);
  lines.push("");

  if (safeToRemove.length > 0) {
    lines.push(`Safe to remove (${safeToRemove.length}) — merged into main, clean:`);
    const cwd = process.cwd();
    let removed = 0;
    for (const s of safeToRemove) {
      const wt = s.worktree;
      const isCwd = wt.path === cwd || cwd.startsWith(wt.path + sep);
      if (isCwd) {
        lines.push(`  ⊘ ${wt.name}  (skipped — current working directory)`);
        continue;
      }
      try {
        removeWorktree(basePath, wt.name, { deleteBranch: true });
        lines.push(`  ✓ ${wt.name}  removed (branch ${wt.branch} deleted)`);
        removed++;
      } catch (e) {
        logWarning("command", `worktree removal failed for ${wt.name}: ${(e as Error).message}`);
        lines.push(`  ✗ ${wt.name}  failed to remove`);
      }
    }
    if (removed > 0) {
      lines.push("");
      lines.push(`Removed ${removed} merged worktree${removed === 1 ? "" : "s"}.`);
    }
    lines.push("");
  }

  if (stale.length > 0) {
    lines.push(`Stale (${stale.length}) — no recent commits, not merged (review manually):`);
    for (const s of stale) {
      lines.push(`  ⚠ ${s.worktree.name}  ${formatWorktreeStatusLine(s)}`);
    }
    lines.push("");
  }

  if (active.length > 0) {
    lines.push(`Active (${active.length}) — in progress:`);
    for (const s of active) {
      lines.push(`  ● ${s.worktree.name}  ${formatWorktreeStatusLine(s)}`);
    }
    lines.push("");
  }

  if (safeToRemove.length === 0 && stale.length === 0) {
    lines.push("All worktrees are active — nothing to clean up.");
  }

  ctx.ui.notify(lines.join("\n"), safeToRemove.length > 0 ? "success" : "info");
}

export async function handleSkip(unitArg: string, ctx: ExtensionCommandContext, basePath: string): Promise<void> {
  if (!unitArg) {
    ctx.ui.notify("Usage: /gsd skip <unit-id>  (e.g., /gsd skip execute-task/M001/S01/T03 or /gsd skip T03)", "info");
    return;
  }

  const { existsSync: fileExists, writeFileSync: writeFile, mkdirSync: mkDir, readFileSync: readFile } = await import("node:fs");
  const { join: pathJoin } = await import("node:path");

  const completedKeysFile = pathJoin(basePath, ".gsd", "completed-units.json");
  let keys: string[] = [];
  try {
    if (fileExists(completedKeysFile)) {
      keys = JSON.parse(readFile(completedKeysFile, "utf-8"));
    }
  } catch (e) { logWarning("command", `completed-units.json parse failed: ${(e as Error).message}`); }

  // Normalize: accept "execute-task/M001/S01/T03", "M001/S01/T03", or just "T03"
  let skipKey = unitArg;

  if (!skipKey.includes("execute-task") && !skipKey.includes("plan-") && !skipKey.includes("research-") && !skipKey.includes("complete-")) {
    const state = await deriveState(basePath);
    const mid = state.activeMilestone?.id;
    const sid = state.activeSlice?.id;

    if (unitArg.match(/^T\d+$/i) && mid && sid) {
      skipKey = `execute-task/${mid}/${sid}/${unitArg.toUpperCase()}`;
    } else if (unitArg.match(/^S\d+$/i) && mid) {
      skipKey = `plan-slice/${mid}/${unitArg.toUpperCase()}`;
    } else if (unitArg.includes("/")) {
      skipKey = `execute-task/${unitArg}`;
    }
  }

  if (keys.includes(skipKey)) {
    ctx.ui.notify(`Already skipped: ${skipKey}`, "info");
    return;
  }

  keys.push(skipKey);
  mkDir(pathJoin(basePath, ".gsd"), { recursive: true });
  writeFile(completedKeysFile, JSON.stringify(keys), "utf-8");

  ctx.ui.notify(`Skipped: ${skipKey}. Will not be dispatched in auto-mode.`, "success");
}

export async function handleDryRun(ctx: ExtensionCommandContext, basePath: string): Promise<void> {
  const state = await deriveState(basePath);

  if (!state.activeMilestone) {
    ctx.ui.notify("No active milestone — nothing to dispatch.", "info");
    return;
  }

  const { getLedger, getProjectTotals, formatCost, formatTokenCount, loadLedgerFromDisk } = await import("./metrics.js");
  const { loadEffectiveGSDPreferences: loadPrefs } = await import("./preferences.js");
  const { formatDuration } = await import("../shared/format-utils.js");

  const ledger = getLedger();
  const units = ledger?.units ?? loadLedgerFromDisk(basePath)?.units ?? [];
  const prefs = loadPrefs()?.preferences;

  let nextType = "unknown";
  let nextId = "unknown";

  const mid = state.activeMilestone.id;
  const midTitle = state.activeMilestone.title;

  if (state.phase === "pre-planning") {
    nextType = "research-milestone";
    nextId = mid;
  } else if (state.phase === "planning" && state.activeSlice) {
    nextType = "plan-slice";
    nextId = `${mid}/${state.activeSlice.id}`;
  } else if (state.phase === "executing" && state.activeTask && state.activeSlice) {
    nextType = "execute-task";
    nextId = `${mid}/${state.activeSlice.id}/${state.activeTask.id}`;
  } else if (state.phase === "summarizing" && state.activeSlice) {
    nextType = "complete-slice";
    nextId = `${mid}/${state.activeSlice.id}`;
  } else if (state.phase === "completing-milestone") {
    nextType = "complete-milestone";
    nextId = mid;
  } else {
    nextType = state.phase;
    nextId = mid;
  }

  const sameTypeUnits = units.filter(u => u.type === nextType);
  const avgCost = sameTypeUnits.length > 0
    ? sameTypeUnits.reduce((s, u) => s + u.cost, 0) / sameTypeUnits.length
    : null;
  const avgDuration = sameTypeUnits.length > 0
    ? sameTypeUnits.reduce((s, u) => s + (u.finishedAt - u.startedAt), 0) / sameTypeUnits.length
    : null;

  const totals = units.length > 0 ? getProjectTotals(units) : null;
  const budgetRemaining = prefs?.budget_ceiling && totals
    ? prefs.budget_ceiling - totals.cost
    : null;

  const lines = [
    `Dry-run preview:`,
    ``,
    `  Next unit:     ${nextType}`,
    `  ID:            ${nextId}`,
    `  Milestone:     ${mid}: ${midTitle}`,
    `  Phase:         ${state.phase}`,
    `  Est. cost:     ${avgCost !== null ? `${formatCost(avgCost)} (avg of ${sameTypeUnits.length} similar)` : "unknown (first of this type)"}`,
    `  Est. duration: ${avgDuration !== null ? formatDuration(avgDuration) : "unknown"}`,
    `  Spent so far:  ${totals ? formatCost(totals.cost) : "$0"}`,
    `  Budget left:   ${budgetRemaining !== null ? formatCost(budgetRemaining) : "no ceiling set"}`,
  ];

  if (state.progress) {
    const p = state.progress;
    lines.push(`  Progress:      ${p.tasks?.done ?? 0}/${p.tasks?.total ?? "?"} tasks, ${p.slices?.done ?? 0}/${p.slices?.total ?? "?"} slices`);
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

export async function handleCleanupProjects(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const { readdirSync, existsSync: fsExists, rmSync: fsRmSync } = await import("node:fs");
  const { join: pathJoin } = await import("node:path");
  const { readRepoMeta, externalProjectsRoot } = await import("./repo-identity.js");

  const fix = args.includes("--fix");
  const projectsDir = externalProjectsRoot();

  if (!fsExists(projectsDir)) {
    ctx.ui.notify(`No project-state directory found at ${projectsDir} — nothing to clean up.`, "info");
    return;
  }

  let hashList: string[];
  try {
    hashList = readdirSync(projectsDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch (e) {
    logWarning("command", `readdir failed for project-state directory: ${(e as Error).message}`);
    ctx.ui.notify(`Failed to read project-state directory at ${projectsDir}.`, "error");
    return;
  }

  if (hashList.length === 0) {
    ctx.ui.notify(`Project-state directory is empty (${projectsDir}) — nothing to clean up.`, "info");
    return;
  }

  type ProjectEntry = { hash: string; gitRoot: string; remoteUrl: string };
  const active: ProjectEntry[] = [];
  const orphaned: ProjectEntry[] = [];
  const unknown: string[] = [];

  for (const hash of hashList) {
    const dirPath = pathJoin(projectsDir, hash);
    const meta = readRepoMeta(dirPath);
    if (!meta) {
      unknown.push(hash);
      continue;
    }
    const entry: ProjectEntry = { hash, gitRoot: meta.gitRoot, remoteUrl: meta.remoteUrl };
    if (fsExists(meta.gitRoot)) {
      active.push(entry);
    } else {
      orphaned.push(entry);
    }
  }

  const pl = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const lines: string[] = [
    `${projectsDir}  ${pl(hashList.length, "project state director")}${hashList.length === 1 ? "y" : "ies"}`,
    "",
  ];

  if (active.length > 0) {
    lines.push(`Active (${active.length}) — git root present on disk:`);
    for (const e of active) {
      const remote = e.remoteUrl ? `  [${e.remoteUrl}]` : "";
      lines.push(`  + ${e.hash}  ${e.gitRoot}${remote}`);
    }
    lines.push("");
  }

  if (orphaned.length > 0) {
    lines.push(`Orphaned (${orphaned.length}) — git root no longer exists:`);
    for (const e of orphaned) {
      const remote = e.remoteUrl ? `  [${e.remoteUrl}]` : "";
      lines.push(`  - ${e.hash}  ${e.gitRoot}${remote}`);
    }
    lines.push("");
  }

  if (unknown.length > 0) {
    lines.push(`Unknown (${unknown.length}) — no metadata yet:`);
    for (const h of unknown) {
      lines.push(`  ? ${h}  (open that project in GSD once to register metadata)`);
    }
    lines.push("");
  }

  if (orphaned.length === 0) {
    lines.push("No orphaned project state — all tracked repos are still present on disk.");
    if (!fix) {
      ctx.ui.notify(lines.join("\n"), "success");
      return;
    }
  }

  if (!fix && orphaned.length > 0) {
    lines.push(`Run /gsd cleanup projects --fix to permanently delete ${pl(orphaned.length, "orphaned director")}${orphaned.length === 1 ? "y" : "ies"}.`);
    ctx.ui.notify(lines.join("\n"), "warning");
    return;
  }

  if (fix && orphaned.length > 0) {
    let removed = 0;
    const failed: string[] = [];
    for (const e of orphaned) {
      try {
        fsRmSync(pathJoin(projectsDir, e.hash), { recursive: true, force: true });
        removed++;
      } catch (err) {
        logWarning("command", `project cleanup rm failed for ${e.hash}: ${(err as Error).message}`);
        failed.push(e.hash);
      }
    }
    lines.push(`Removed ${pl(removed, "orphaned director")}${removed === 1 ? "y" : "ies"}.`);
    if (failed.length > 0) {
      lines.push(`Failed to remove: ${failed.join(", ")}`);
    }
    ctx.ui.notify(lines.join("\n"), removed > 0 ? "success" : "warning");
    return;
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

type HierarchyCounts = { milestones: number; slices: number; tasks: number };

function requestedApplication(args: string): string | null {
  return /(?:^|\s)--application=([^\s]+)(?=\s|$)/u.exec(args)?.[1] ?? null;
}

function requestedPreviewApproval(args: string): string | null {
  return /(?:^|\s)--preview=(sha256:[0-9a-f]{64})(?=\s|$)/u.exec(args)?.[1] ?? null;
}

function requestedRestoreConsent(args: string): LegacyImportRestoreAssessmentConsent | undefined {
  const evidenceHash = /(?:^|\s)--consent=proceed:destructive-database-restore:(sha256:[0-9a-f]{64})(?=\s|$)/u.exec(args)?.[1];
  return evidenceHash ? { consentSchemaVersion: LEGACY_IMPORT_RESTORE_ASSESSMENT_CONSENT_SCHEMA_VERSION, decision: "proceed", destructiveDatabaseRestore: true, evidenceHash } : undefined;
}

async function confirmRecover(
  ctx: ExtensionCommandContext,
  prepared: Readonly<PreparedVerifiedRecoverApplication>,
  approvedPreviewHash: string | null,
  markdown: HierarchyCounts,
  beforeDb: HierarchyCounts,
): Promise<boolean> {
  const warning = [
    "gsd recover imports markdown into the database.",
    "It applies modeled changes through one verified Import Application.",
    "Existing database rows absent from markdown are not cleared.",
    "Use /gsd rebuild markdown for normal DB-to-markdown realignment.",
    "",
    `  Markdown on disk: ${markdown.milestones}M/${markdown.slices}S/${markdown.tasks}T`,
    `  Current DB:       ${beforeDb.milestones}M/${beforeDb.slices}S/${beforeDb.tasks}T`,
    "",
    prepared.authorizationText,
  ];
  const warningText = warning.join("\n");

  if (approvedPreviewHash !== null) {
    if (approvedPreviewHash !== prepared.preview.preview_hash) {
      throw new Error("gsd recover approval does not match the sealed Import Preview");
    }
    return true;
  }

  if (typeof ctx.ui.confirm === "function") {
    const confirmed = await ctx.ui.confirm(
      "Import markdown into the DB?",
      `${warningText}\n\nContinue only if the DB is lost or corrupt and markdown is the source you intend to import.`,
    );
    if (!confirmed) {
      ctx.ui.notify("gsd recover cancelled. No database changes made.", "info");
      return false;
    }
    return true;
  }

  ctx.ui.notify(
    `${warningText}\n\nNo database changes made. Re-run /gsd recover --preview=${prepared.preview.preview_hash} to approve this exact Preview.`,
    "warning",
  );
  return false;
}

/**
 * `gsd recover` — Explicitly import legacy markdown into canonical DB state.
 *
 * Applies one sealed Preview through the verified Import Application boundary,
 * then calls `deriveState()` to verify sanity.
 *
 * Prints counts of recovered items and the resulting project phase.
 */
export async function handleRecover(
  ctx: ExtensionCommandContext,
  basePath: string,
  args = "",
): Promise<void> {
  const { isDbAvailable: dbAvailable } = await import("./gsd-db.js");
  const { invalidateStateCache } = await import("./state.js");
  const { countDbHierarchy, countMarkdownHierarchy } = await import("./migration-auto-check.js");

  if (!dbAvailable()) {
    ctx.ui.notify("gsd recover: No database open. Run a GSD command first to initialize the DB.", "error");
    return;
  }

  // Show both sides before the user approves the explicit import. Application
  // updates only modeled Preview targets and never clears absent DB rows.
  const markdown = countMarkdownHierarchy(basePath);
  const beforeDb = countDbHierarchy();

  try {
    const action = parseLegacyImportRecoveryAction(args.trim().split(/\s+/u).filter(Boolean));
    const applicationId = requestedApplication(args);
    if (!applicationId && action !== "assess") {
      throw new Error("run gsd recover assessment first, then use its --application evidence");
    }
    let application = applicationId
      ? loadVerifiedRecoverApplication(applicationId)
      : loadRetainedVerifiedRecoverApplication();
    let appliedPreview = false;
    if (!application) {
      const prepared = prepareVerifiedRecoverApplication(basePath);
      if (!(await confirmRecover(
        ctx,
        prepared,
        requestedPreviewApproval(args),
        markdown,
        beforeDb,
      ))) return;
      application = applyPreparedVerifiedRecoverApplication(
        prepared,
        prepared.preview.preview_hash,
      );
      appliedPreview = true;
    }
    const { backup } = application;
    const recoveryAction = executeLegacyImportRecoveryAction(
      application,
      action,
      parseLegacyImportForwardRepairChoices(args),
      requestedRestoreConsent(args),
    );
    const recoveryAssessment = recoveryAction.status === "assessed"
      || recoveryAction.status === "choice-required"
      ? recoveryAction.assessment
      : null;

    const counts = countDbHierarchy();
    invalidateStateCache();
    const state = await deriveState(basePath);
    const lines = [
      `gsd recover: ${applicationId || application.receipt.status === "replayed" ? "loaded retained" : "applied verified markdown Preview"} Import Application`,
      `  Milestones: ${counts.milestones}`,
      `  Slices:     ${counts.slices}`,
      `  Tasks:      ${counts.tasks}`,
      ``,
      `  Phase:      ${state.phase}`,
    ];
    // Post-import verification: markdown that failed to parse imports as fewer
    // rows than countMarkdownHierarchy saw on disk. Surface the shortfall.
    if (
      appliedPreview
      && (counts.milestones < markdown.milestones
        || counts.slices < markdown.slices
        || counts.tasks < markdown.tasks)
    ) {
      lines.push(
        ``,
        `  ⚠ Imported fewer rows than markdown contained ` +
          `(${markdown.milestones}M/${markdown.slices}S/${markdown.tasks}T on disk). ` +
          `Some markdown may have failed to parse — review before continuing.`,
      );
    }
    lines.push(``, `  Verified backup: ${backup.backup_ref}`);
    if (recoveryAction.status === "restored") {
      lines.push(``, `  Restored database: ${recoveryAction.result.status}`);
    } else if (recoveryAction.status === "forward-repaired") {
      lines.push(``, `  Forward Repair: ${recoveryAction.result.status}`);
    } else if (recoveryAction.status === "choice-required") {
      lines.push(
        ``,
        `  ${recoveryAction.assessment.recommendation.recommendationText}`,
        ...recoveryAction.choices.map((choice) => (
          `  Review ${choice.reasonCode} at ${choice.instructionIndex}:${choice.targetKind}:${choice.targetKey} (${choice.reviewHash}).\n`
          + `    Current canonical value: ${choice.currentValueJson}\n`
          + `    Proposed backup mutation: ${choice.proposedMutationJson}\n`
          + `    Recommended: ${choice.recommendedDecision} — ${choice.recommendationRationale}\n`
          + `Use ${formatLegacyImportForwardRepairChoice(choice, "preserve-later")} or `
          + formatLegacyImportForwardRepairChoice(choice, "restore-backup")
        )),
      );
    } else if (recoveryAssessment) {
      lines.push(
        ``,
        `  ${recoveryAssessment.recommendation.recommendationText}`,
        `  Application: ${application.receipt.operationId}`,
      );
      if (recoveryAssessment.decision === "restore-consent-required") {
        lines.push(`  To consent: --application=${application.receipt.operationId} --restore --consent=proceed:destructive-database-restore:${recoveryAssessment.evidenceHash}`);
      } else if (recoveryAssessment.decision === "forward-repair-required") {
        lines.push(`  Use --application=${application.receipt.operationId} --forward-repair to apply the assessed action.`);
      }
    }
    if (state.activeMilestone) {
      lines.push(`  Active:     ${state.activeMilestone.id}: ${state.activeMilestone.title}`);
    }
    if (state.activeSlice) {
      lines.push(`  Slice:      ${state.activeSlice.id}: ${state.activeSlice.title}`);
    }
    if (state.activeTask) {
      lines.push(`  Task:       ${state.activeTask.id}: ${state.activeTask.title}`);
    }

    if (recoveryAction.status === "choice-required") {
      ctx.ui.notify(lines.join("\n"), "warning");
      return;
    }
    if (
      recoveryAssessment?.decision === "transaction-rollback-only"
      || recoveryAssessment?.decision === "temporarily-unavailable"
      || recoveryAssessment?.decision === "refused"
    ) {
      lines.push(`  Assessment: ${recoveryAssessment.decision} (${recoveryAssessment.reasonCode})`);
      ctx.ui.notify(lines.join("\n"), recoveryAssessment.decision === "refused" ? "error" : "warning");
      return;
    }
    process.stderr.write(
      `gsd-recover: recovered ${counts.milestones}M/${counts.slices}S/${counts.tasks}T hierarchy\n`,
    );
    ctx.ui.notify(lines.join("\n"), "success");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const details = err instanceof LegacyImportBaseSnapshotError
      ? ` [${err.code}] context=${JSON.stringify(err.context)}`
      : "";
    const msg = `${message}${details}`;
    logWarning("command", `recover failed: ${msg}`);
    ctx.ui.notify(`gsd recover failed: ${msg}`, "error");
  }
}

type RebuildTarget = "markdown" | "database" | "usage";

function parseRebuildTarget(args: string): RebuildTarget {
  const trimmed = args.trim().toLowerCase();
  if (!trimmed || trimmed === "markdown") return "markdown";
  if (trimmed === "database" || trimmed === "db") return "database";
  return "usage";
}

/**
 * `/gsd sync` — preserve external projection edits and re-project from the DB.
 *
 * Projection observation preserves modeled external bytes without importing
 * them. Workflow-state reconciliation can still block the rebuild.
 *
 * Accepts `--dry-run` to report what would change without writing.
 */
export async function handleSync(
  ctx: ExtensionCommandContext,
  basePath: string,
  args = "",
): Promise<void> {
  const { isDbAvailable } = await import("./gsd-db.js");
  const { reconcileBeforeDispatch } = await import("./state-reconciliation/index.js");
  const { writeCompatMarker, readCompatMarker } = await import("./compat/compat-marker.js");

  const dryRun = args.trim() === "--dry-run";

  if (!isDbAvailable()) {
    ctx.ui.notify("gsd sync: No database open. Run a GSD command first to initialize the DB.", "error");
    return;
  }

  const lines: string[] = ["gsd sync: checking projections against the database…"];

  try {
    const observation = await preserveProjectionChanges(basePath, dryRun);
    const result = await reconcileBeforeDispatch(basePath, { dryRun });
    const refreshedPlanningPassthrough = observation.refreshedPassthrough;
    if (refreshedPlanningPassthrough.length > 0) {
      lines.push(
        `  Planning passthrough checksums ${dryRun ? "to refresh" : "refreshed"}: ${refreshedPlanningPassthrough.length}`,
      );
      for (const projectionPath of refreshedPlanningPassthrough) {
        lines.push(`    • ${projectionPath}`);
      }
    }
    if (result.blockers.length > 0) {
      lines.push("", "  ⚠ Blockers:");
      for (const b of result.blockers) lines.push(`    • ${b}`);
      if (dryRun) {
        lines.push("", "  (dry-run: no repairs, projection, or marker writes performed)");
      }
      ctx.ui.notify(lines.join("\n"), "warning");
      return;
    }

    if (dryRun) {
      if (observation.preserved.length > 0) {
        lines.push("", `  Projection edits to preserve: ${observation.preserved.length}`);
        for (const evidence of observation.preserved) {
          lines.push(`    • ${evidence.sourcePath}`);
        }
      }
      lines.push("", "  (dry-run: no repairs, projection, or marker writes performed)");
      ctx.ui.notify(lines.join("\n"), "info");
      return;
    }

    const renderResult = await rebuildMarkdownProjectionsFromDb(basePath);
    const quarantinedPaths = [
      ...observation.preserved.map((evidence) => evidence.quarantinePath),
      ...renderResult.quarantinedPaths,
    ];
    if (quarantinedPaths.length > 0) {
      lines.push(
        "",
        `  Preserved external projection edits: ${quarantinedPaths.length}`,
      );
      for (const path of quarantinedPaths) lines.push(`    • ${path}`);
    }
    if (renderResult.errors.length > 0) {
      lines.push("", "  ⚠ Projection errors:");
      for (const e of renderResult.errors) lines.push(`    • ${e}`);
    }

    // Refresh the marker to reflect the freshly re-projected state. The
    // planning hook inside renderAllFromDb already recorded per-file SHAs
    // into marker.planning.projections; we read back the fully-populated
    // marker here so the timestamp is the last thing written.
    const marker = readCompatMarker(basePath);
    marker.lastWriter = "gsd-pi";
    marker.lastProjectedAt = new Date().toISOString();
    writeCompatMarker(basePath, marker);
    const planningShaCnt = Object.keys(marker.planning?.projections ?? {}).length;
    const planningNote = planningShaCnt > 0
      ? ` + ${planningShaCnt} .planning/ SHA${planningShaCnt !== 1 ? "s" : ""}`
      : "";

    const state = await deriveState(basePath);
    lines.push(
      "",
      `  Phase:  ${state.phase}`,
      `  Marker: .gsd/.compat.json refreshed${planningNote}`,
    );
    if (state.activeMilestone) {
      lines.push(`  Active: ${state.activeMilestone.id}: ${state.activeMilestone.title}`);
    }

    ctx.ui.notify(lines.join("\n"), "info");
  } catch (err) {
    ctx.ui.notify(`gsd sync failed: ${(err as Error).message}`, "error");
  }
}

/**
 * `gsd rebuild markdown` — Re-render markdown projections from the authoritative DB.
 *
 * This is the DB-first realignment command. It does not import markdown into the
 * DB. Externally changed modeled projection bytes are preserved under
 * `.gsd/quarantine/projections/` before DB projections are rendered.
 */
export async function handleRebuild(ctx: ExtensionCommandContext, basePath: string, args = ""): Promise<void> {
  const { isDbAvailable: dbAvailable } = await import("./gsd-db.js");

  const target = parseRebuildTarget(args);
  if (target === "usage") {
    ctx.ui.notify(
      [
        "Usage:",
        "  /gsd rebuild markdown   Rebuild markdown projections from the canonical DB",
        "  /gsd rebuild database   Reserved for DB-native rebuilds; does not import markdown",
      ].join("\n"),
      "warning",
    );
    return;
  }

  if (target === "database") {
    ctx.ui.notify(
      [
        "gsd rebuild database is reserved for DB-native rebuilds.",
        "It will not import markdown projections into the DB.",
        "For normal realignment, run /gsd rebuild markdown.",
        "If the DB is lost or corrupt and markdown is the source to import, run /gsd recover and approve its exact Preview hash.",
      ].join("\n"),
      "warning",
    );
    return;
  }

  if (!dbAvailable()) {
    ctx.ui.notify("gsd rebuild markdown: No database open. Run a GSD command first to initialize the DB.", "error");
    return;
  }

  try {
    const result = await rebuildMarkdownProjectionsFromDb(basePath);

    const lines = [
      "gsd rebuild markdown: rebuilt markdown projections from the canonical DB",
      `  Rendered:    ${result.rendered}`,
      `  Skipped:     ${result.skipped}`,
      `  Quarantined: ${result.quarantined}`,
    ];
    if (result.errors.length > 0) {
      lines.push(`  Errors:      ${result.errors.length}`);
      for (const err of result.errors.slice(0, 5)) {
        lines.push(`    - ${err}`);
      }
      if (result.errors.length > 5) {
        lines.push(`    - ${result.errors.length - 5} more`);
      }
    }
    if (result.quarantined > 0) {
      lines.push("", "  Quarantine:");
      for (const target of result.quarantinedPaths.slice(0, 5)) {
        lines.push(`    - ${target}`);
      }
      if (result.quarantined > 5) {
        lines.push(`    - ${result.quarantined - 5} more`);
      }
    }

    ctx.ui.notify(lines.join("\n"), result.errors.length > 0 ? "warning" : "success");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logWarning("command", `rebuild failed: ${msg}`);
    ctx.ui.notify(`gsd rebuild failed: ${msg}`, "error");
  }
}

// ─── gsd db restore-backup ──────────────────────────────────────────────────
//
// Explicit user-facing restore of a verified pre-migration backup
// (`gsd.db.backup-v<N>`). The restore publishes the backup through the same
// replacement-intent machinery as the legacy-import live restore, persists an
// auditable receipt through the authority-recovery writers, and refuses
// anything that fails verification or lacks an exact consent token.

type RestoreBackupCandidate = {
  path: string;
  fileName: string;
  nameVersion: number;
  schemaVersion: number | null;
  quickCheck: string | null;
  byteSize: number;
  sha256: string;
};

type VerifiedRestoreBackup = {
  schemaVersion: number;
  projectId: string;
  projectRevision: number;
  authorityEpoch: number;
};

type RestoreFileIdentity = { device: string; inode: string };

type RestoreBackupIntent = {
  intentSchemaVersion: 1;
  requestHash: string;
  stage: "claimed" | "staged" | "recovery-staged" | "published" | "receipt-recorded";
  ownerPid: number;
  ownerProcessStartIdentity: string;
  ownerNonce: string;
  originalDatabaseDevice: string;
  originalDatabaseInode: string;
  candidateDatabaseDevice: string | null;
  candidateDatabaseInode: string | null;
  applicationOperationId: string;
  applicationIdentityHash: string;
  backupId: string;
  backupSha256: string;
  backupByteSize: number;
  backupSchemaVersion: number;
  backupProjectRevision: number;
  backupAuthorityEpoch: number;
  assessmentEvidenceHash: string;
  differenceHash: string;
  consentHash: string;
  erasedLineageHash: string;
  erasedLineageJson: string;
};

function requestedBackupPath(args: string): string | null {
  return /(?:^|\s)--backup=(\S+)(?=\s|$)/u.exec(args)?.[1]
    ?? /(?:^|\s)--backup\s+(\S+)(?=\s|$)/u.exec(args)?.[1]
    ?? null;
}

function requestedBackupList(args: string): boolean {
  return /(?:^|\s)--list(?=\s|$)/u.test(args);
}

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sha256FileHex(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function restoreSyncFile(path: string): void {
  const access = process.platform === "win32" ? fsConstants.O_RDWR : fsConstants.O_RDONLY;
  const fd = openSync(path, access | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

async function restoreSyncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") {
    const { syncDirectoryEntry } = await import("@gsd/native/directory-sync");
    syncDirectoryEntry(path);
    return;
  }
  const fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function restoreFileIdentity(path: string): RestoreFileIdentity {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`restore file identity requires one regular file: ${path}`);
  }
  return { device: String(stat.dev), inode: String(stat.ino) };
}

async function listRestoreBackupCandidates(dbPath: string): Promise<RestoreBackupCandidate[]> {
  const { openSqliteReadOnly } = await import("./sqlite-readonly.js");
  const pattern = new RegExp(`^${escapeRegExpLiteral(basename(dbPath))}\\.backup-v(\\d+)$`);
  const candidates: RestoreBackupCandidate[] = [];
  for (const entry of readdirSync(dirname(dbPath))) {
    const match = pattern.exec(entry);
    if (!match) continue;
    const path = join(dirname(dbPath), entry);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    let schemaVersion: number | null = null;
    let quickCheck: string | null = null;
    try {
      const connection = openSqliteReadOnly(path);
      try {
        const rows = connection.db.prepare("PRAGMA quick_check").all();
        quickCheck = rows.length === 1 && rows[0]?.["quick_check"] === "ok" ? "ok" : "failed";
        const version = Number(
          connection.db.prepare("SELECT MAX(version) AS version FROM schema_version").get()?.["version"],
        );
        schemaVersion = Number.isSafeInteger(version) && version > 0 ? version : null;
      } finally {
        connection.db.close();
      }
    } catch {
      schemaVersion = null;
      quickCheck = null;
    }
    candidates.push({
      path,
      fileName: entry,
      nameVersion: Number(match[1]),
      schemaVersion,
      quickCheck,
      byteSize: Number(stat.size),
      sha256: sha256FileHex(path),
    });
  }
  return candidates.sort((a, b) => a.nameVersion - b.nameVersion);
}

/**
 * Verify a restore candidate through the same ATTACH + quick_check +
 * schema-version approach as db-migration-backup.ts's verifyBackup.
 */
async function verifyRestoreBackupCandidate(
  backupPath: string,
  expectedNameVersion: number,
): Promise<VerifiedRestoreBackup> {
  const { getDb, SCHEMA_VERSION } = await import("./db/engine.js");
  const db = getDb();
  let attached = false;
  try {
    db.prepare("ATTACH DATABASE ? AS restore_candidate").run(backupPath);
    attached = true;
    const checkRows = db.prepare("PRAGMA restore_candidate.quick_check").all();
    if (checkRows.length !== 1 || checkRows[0]?.["quick_check"] !== "ok") {
      throw new Error(`backup failed quick_check: ${checkRows.map((row) => String(row?.["quick_check"])).join("; ")}`);
    }
    const version = Number(
      db.prepare("SELECT MAX(version) AS version FROM restore_candidate.schema_version").get()?.["version"],
    );
    if (!Number.isSafeInteger(version) || version <= 0) {
      throw new Error("backup has no readable schema_version");
    }
    if (version !== expectedNameVersion) {
      throw new Error(`backup file name says v${expectedNameVersion} but its schema_version records v${version}`);
    }
    if (version > SCHEMA_VERSION) {
      throw new Error(
        `backup schema is v${version}, newer than the v${SCHEMA_VERSION} this gsd-pi supports — ` +
        "upgrade gsd-pi (npm i -g @opengsd/gsd-pi) before restoring this backup",
      );
    }
    const receipts = db.prepare(
      "SELECT 1 AS present FROM restore_candidate.sqlite_master WHERE type = 'table' AND name = 'workflow_import_restores'",
    ).get()?.["present"];
    if (receipts !== 1) {
      throw new Error(
        "backup predates v45 restore receipts — restore it manually: stop gsd-pi, replace the project " +
        "gsd.db with the backup file, then start the older gsd-pi release the backup was taken with",
      );
    }
    const authority = db.prepare(
      "SELECT project_id, revision, authority_epoch FROM restore_candidate.project_authority WHERE singleton = 1",
    ).get();
    if (
      typeof authority?.["project_id"] !== "string"
      || authority["project_id"].length === 0
      || !Number.isSafeInteger(authority?.["revision"])
      || !Number.isSafeInteger(authority?.["authority_epoch"])
    ) {
      throw new Error("backup has no readable project_authority row");
    }
    return {
      schemaVersion: version,
      projectId: authority["project_id"] as string,
      projectRevision: Number(authority["revision"]),
      authorityEpoch: Number(authority["authority_epoch"]),
    };
  } finally {
    if (attached) db.exec("DETACH DATABASE restore_candidate");
  }
}

function readRestoreBackupIntent(path: string): RestoreBackupIntent | null {
  if (!existsSync(path)) return null;
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("restore intent is malformed");
  }
  const record = value as Record<string, unknown>;
  if (
    record["intentSchemaVersion"] !== 1
    || typeof record["requestHash"] !== "string"
    || typeof record["stage"] !== "string"
    || typeof record["applicationOperationId"] !== "string"
  ) {
    throw new Error("restore intent does not satisfy the v1 contract");
  }
  return record as unknown as RestoreBackupIntent;
}

async function claimRestoreBackupIntent(path: string, intent: RestoreBackupIntent): Promise<boolean> {
  const { canonicalLegacyImportJson } = await import("./legacy-import-preview.js");
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let fd: number | undefined;
  let linkAttempted = false;
  try {
    fd = openSync(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    writeFileSync(fd, canonicalLegacyImportJson(intent), "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    linkAttempted = true;
    linkSync(temporary, path);
    await restoreSyncDirectory(dirname(path));
    unlinkSync(temporary);
    await restoreSyncDirectory(dirname(path));
    return true;
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch (closeError) {
        logWarning("command", `restore intent claim leaked an open descriptor for ${temporary}: ${(closeError as Error).message}`);
      }
    }
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch (cleanupError) {
      logWarning("command", `restore intent claim left ${temporary} behind: ${(cleanupError as Error).message}`);
    }
    if (linkAttempted && (error as { code?: unknown }).code === "EEXIST") return false;
    throw error;
  }
}

async function rewriteRestoreBackupIntent(path: string, intent: RestoreBackupIntent): Promise<void> {
  const { canonicalLegacyImportJson } = await import("./legacy-import-preview.js");
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    writeFileSync(fd, canonicalLegacyImportJson(intent), "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    await restoreSyncDirectory(dirname(path));
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch (closeError) {
        logWarning("command", `restore intent rewrite leaked an open descriptor for ${temporary}: ${(closeError as Error).message}`);
      }
    }
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch (cleanupError) {
      logWarning("command", `restore intent rewrite left ${temporary} behind: ${(cleanupError as Error).message}`);
    }
    throw error;
  }
}

async function restoreBackupIntentOwnerIsActive(intent: RestoreBackupIntent): Promise<boolean> {
  if (intent.ownerPid === process.pid) return false;
  const { processStartIdentity } = await import("./process-start-identity.js");
  try {
    process.kill(intent.ownerPid, 0);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ESRCH") return false;
  }
  const current = processStartIdentity(intent.ownerPid);
  return current === null || current === intent.ownerProcessStartIdentity;
}

type RestoreBackupPlan = {
  dbPath: string;
  backupPath: string;
  backupSha: string;
  idempotencyKey: string;
  verified: VerifiedRestoreBackup;
  originalIdentity: RestoreFileIdentity;
  intentBase: RestoreBackupIntent;
  receiptPayload: {
    readonly applicationOperationId: string;
    readonly applicationIdentityHash: string;
    readonly applicationResultingProjectRevision: number;
    readonly applicationResultingAuthorityEpoch: number;
    readonly erasedLineageHash: string;
    readonly erasedLineageJson: string;
    readonly previewId: string;
    readonly previewHash: string;
    readonly backupId: string;
    readonly backupSha256: string;
    readonly backupByteSize: number;
    readonly backupSchemaVersion: number;
    readonly backupProjectRevision: number;
    readonly backupAuthorityEpoch: number;
    readonly differenceHash: string;
    readonly consentHash: string;
    readonly verificationHash: string;
  };
};

/**
 * Stage, publish, and receipt one verified backup restore. Every step is
 * idempotent so a crash-converging re-run of the identical command redrives
 * the pipeline: staging re-verifies bytes, publication skips an already
 * published file, and the receipt domain operation replays on its stable
 * idempotency key.
 */
async function executeRestoreBackupPlan(plan: RestoreBackupPlan): Promise<"committed" | "replayed"> {
  const engine = await import("./db/engine.js");
  const { getDatabaseReplacementPaths } = await import("./database-replacement-paths.js");
  const { _executeImportRestoreDomainOperation } = await import("./db/domain-operation.js");
  const { insertImportRestoreReceipt } = await import("./db/writers/authority-recovery.js");

  const { dbPath, backupPath, backupSha, verified, receiptPayload } = plan;
  const paths = getDatabaseReplacementPaths(dbPath);
  const candidatePath = join(paths.recoveryDirectory, "candidate.sqlite");

  // TOCTOU guard: the consented bytes must still be the verified bytes.
  if (sha256FileHex(backupPath) !== backupSha) {
    throw new Error("backup file changed after consent — re-list candidates and re-consent");
  }

  mkdirSync(dirname(paths.recoveryDirectory), { recursive: true, mode: 0o700 });
  mkdirSync(paths.recoveryDirectory, { recursive: true, mode: 0o700 });

  const intent: RestoreBackupIntent = { ...plan.intentBase, stage: "claimed" };
  let activeIntent = readRestoreBackupIntent(paths.activeIntentPath);
  if (activeIntent !== null && activeIntent.requestHash !== intent.requestHash) {
    throw new Error(`a different restore intent is active at ${paths.activeIntentPath}`);
  }
  if (activeIntent === null) {
    const claimed = await claimRestoreBackupIntent(paths.activeIntentPath, intent);
    if (!claimed) {
      activeIntent = readRestoreBackupIntent(paths.activeIntentPath);
      if (activeIntent === null || activeIntent.requestHash !== intent.requestHash) {
        throw new Error("another database restore claimed the replacement fence first");
      }
    }
  }
  // (Re)write the intent under this process's ownership at stage "claimed".
  await rewriteRestoreBackupIntent(paths.activeIntentPath, intent);

  // Stage the candidate beside the live database and prove its bytes.
  if (existsSync(candidatePath) && sha256FileHex(candidatePath) !== backupSha) {
    unlinkSync(candidatePath);
    await restoreSyncDirectory(paths.recoveryDirectory);
  }
  if (!existsSync(candidatePath)) {
    copyFileSync(backupPath, candidatePath, fsConstants.COPYFILE_EXCL);
    chmodSync(candidatePath, 0o600);
  }
  restoreSyncFile(candidatePath);
  if (sha256FileHex(candidatePath) !== backupSha) {
    throw new Error("staged restore candidate bytes do not match the verified backup");
  }
  const candidateIdentity = restoreFileIdentity(candidatePath);
  const stagedIntent: RestoreBackupIntent = {
    ...intent,
    stage: "staged",
    candidateDatabaseDevice: candidateIdentity.device,
    candidateDatabaseInode: candidateIdentity.inode,
  };
  await rewriteRestoreBackupIntent(paths.activeIntentPath, stagedIntent);

  let detached: import("./db/engine.js").DatabaseReplacementToken | undefined;
  let published = false;
  try {
    detached = engine.detachActiveDatabaseForReplacement(dbPath);
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      try {
        unlinkSync(`${dbPath}${suffix}`);
      } catch (error) {
        if ((error as { code?: unknown }).code !== "ENOENT") throw error;
      }
    }
    if (sha256FileHex(dbPath) !== backupSha) {
      renameSync(candidatePath, dbPath);
    }
    published = true;
    restoreSyncFile(dbPath);
    await restoreSyncDirectory(dirname(dbPath));
    if (sha256FileHex(dbPath) !== backupSha) {
      throw new Error("published database bytes do not match the verified backup");
    }
    const publishedIntent: RestoreBackupIntent = { ...stagedIntent, stage: "published" };
    await rewriteRestoreBackupIntent(paths.activeIntentPath, publishedIntent);

    const capability = engine.reopenDatabaseAfterReplacement(detached, {
      expectedPublishedSha256: backupSha,
      persistedOriginalFileIdentity: plan.originalIdentity,
      expectedPublishedFileIdentity: restoreFileIdentity(dbPath),
      expectedActiveIntentFileIdentity: restoreFileIdentity(paths.activeIntentPath),
      expectedActiveIntentSha256: sha256FileHex(paths.activeIntentPath),
    });
    if (capability === null) {
      throw new Error("published restore reopened the original database file");
    }
    detached = undefined;

    const result = _executeImportRestoreDomainOperation(capability, {
      operationType: "import.restore",
      idempotencyKey: plan.idempotencyKey,
      expectedRevision: verified.projectRevision,
      expectedAuthorityEpoch: verified.authorityEpoch,
      actorType: "user",
      sourceTransport: "pi-tool",
      payload: receiptPayload,
    }, (context) => {
      insertImportRestoreReceipt(context, receiptPayload);
      return {
        events: [{
          eventType: "legacy-import.restored",
          entityType: "legacy-import",
          entityId: receiptPayload.previewId,
          payload: receiptPayload,
          destinations: ["projection"],
        }],
        projections: [{
          projectionKey: "legacy-import/restore",
          projectionKind: "markdown",
          rendererVersion: "v1",
        }],
      };
    });

    const checkpoint = engine.getDb().prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    const busy = Number(checkpoint?.["busy"] ?? -1);
    const log = Number(checkpoint?.["log"] ?? Number.NaN);
    const checkpointed = Number(checkpoint?.["checkpointed"] ?? Number.NaN);
    if (busy !== 0 || !((log === -1 && checkpointed === -1) || (Number.isSafeInteger(log) && log >= 0 && checkpointed === log))) {
      throw new Error("restore receipt checkpoint did not complete");
    }
    restoreSyncFile(dbPath);
    await restoreSyncDirectory(dirname(dbPath));

    // Drop the replacement fence: intent, staged candidate, recovery dir.
    unlinkSync(paths.activeIntentPath);
    if (existsSync(candidatePath)) unlinkSync(candidatePath);
    await restoreSyncDirectory(paths.recoveryDirectory);
    try {
      rmdirSync(paths.recoveryDirectory);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
    }
    await restoreSyncDirectory(dirname(dbPath));
    return result.status;
  } catch (error) {
    if (detached !== undefined) {
      try {
        if (published) {
          engine.reopenDatabaseAfterReplacement(detached, {
            expectedPublishedSha256: backupSha,
            persistedOriginalFileIdentity: plan.originalIdentity,
            expectedPublishedFileIdentity: restoreFileIdentity(dbPath),
            expectedActiveIntentFileIdentity: restoreFileIdentity(paths.activeIntentPath),
            expectedActiveIntentSha256: sha256FileHex(paths.activeIntentPath),
          });
        } else {
          engine.reopenDatabaseAfterReplacement(detached, {});
        }
      } catch (reopenError) {
        logWarning("command", `restore could not reopen the database after replacement (published=${published}); the replacement fence stays in place for the next run to converge: ${(reopenError as Error).message}`);
      }
    }
    if (!published) {
      // Pre-publication failure: drop the fence this run owns, best-effort.
      try { if (existsSync(paths.activeIntentPath)) unlinkSync(paths.activeIntentPath); } catch (cleanupError) {
        logWarning("command", `restore could not drop the active intent fence ${paths.activeIntentPath}; the next run must converge it: ${(cleanupError as Error).message}`);
      }
      try { if (existsSync(candidatePath)) unlinkSync(candidatePath); } catch (cleanupError) {
        logWarning("command", `restore could not drop the staged candidate ${candidatePath}; the next run must converge it: ${(cleanupError as Error).message}`);
      }
      try { rmdirSync(paths.recoveryDirectory); } catch (cleanupError) {
        logWarning("command", `restore could not drop the recovery directory ${paths.recoveryDirectory}; the next run must converge it: ${(cleanupError as Error).message}`);
      }
    }
    throw error;
  }
}

/**
 * `gsd db restore-backup` — Explicitly restore a verified pre-migration backup.
 *
 * Without `--backup` (or with `--list`), lists `gsd.db.backup-v*` candidates
 * beside the project database with their schema versions and consent hashes
 * without mutating anything. With `--backup` and an exact
 * `--consent=proceed:destructive-database-restore:sha256:<hash>` token, it
 * verifies the backup (ATTACH + quick_check + schema-version read), publishes
 * it through the database replacement machinery inside the EXCLUSIVE
 * maintenance claim, and persists an auditable import.restore receipt through
 * the existing authority-recovery writers.
 */
export async function handleDbRestoreBackup(
  ctx: ExtensionCommandContext,
  basePath: string,
  args = "",
): Promise<void> {
  const { resolveProjectRootDbPath, openWorkflowDatabase } = await import("./db-workspace.js");
  const listOnly = requestedBackupList(args);
  const backupArg = requestedBackupPath(args);
  if (listOnly && backupArg !== null) {
    ctx.ui.notify("gsd db restore-backup: --backup and --list are mutually exclusive.", "error");
    return;
  }

  const dbPathResolved = resolveProjectRootDbPath(basePath);
  let dbPath = dbPathResolved;
  try {
    dbPath = realpathSync(dbPathResolved);
  } catch (error) {
    // Expected before the first open: fall back to the unresolved path.
    logWarning("command", `db restore-backup could not resolve ${dbPathResolved} (the project database may not exist yet); using the unresolved path: ${(error as Error).message}`);
  }

  // List mode: read-only inspection only — never opens (or migrates) the
  // engine database, so a previously restored older-schema DB stays untouched.
  if (listOnly || backupArg === null) {
    const candidates = existsSync(dirname(dbPath)) ? await listRestoreBackupCandidates(dbPath) : [];
    if (candidates.length === 0) {
      ctx.ui.notify(`gsd db restore-backup: no ${basename(dbPath)}.backup-v* candidates found beside ${dbPath}.`, "info");
      return;
    }
    const lines = [
      `gsd db restore-backup: ${candidates.length} backup candidate${candidates.length === 1 ? "" : "s"} beside ${dbPath}`,
      "",
    ];
    for (const candidate of candidates) {
      const state = candidate.schemaVersion === null
        ? "unreadable (failed verification)"
        : `schema v${candidate.schemaVersion}${candidate.schemaVersion !== candidate.nameVersion ? ` (file name says v${candidate.nameVersion} — suspect)` : ""}, quick_check ${candidate.quickCheck ?? "FAILED"}`;
      lines.push(`  ${candidate.fileName}  ${state}  ${candidate.byteSize} bytes`);
      lines.push(`    sha256: ${candidate.sha256}`);
    }
    lines.push(
      "",
      "Restore one with:",
      "  /gsd db restore-backup --backup <path> --consent=proceed:destructive-database-restore:<sha256>",
      "The consent hash must be the exact sha256 printed above for the chosen backup.",
    );
    ctx.ui.notify(lines.join("\n"), "info");
    return;
  }

  try {
    // The backup must live beside the project DB and follow the verified
    // backup naming contract.
    let backupPath: string;
    try {
      backupPath = realpathSync(resolve(basePath, backupArg));
    } catch {
      ctx.ui.notify(`gsd db restore-backup: backup not found: ${backupArg}`, "error");
      return;
    }
    const nameMatch = new RegExp(`^${escapeRegExpLiteral(basename(dbPath))}\\.backup-v(\\d+)$`).exec(basename(backupPath));
    if (nameMatch === null || dirname(backupPath) !== dirname(dbPath)) {
      ctx.ui.notify(
        `gsd db restore-backup: --backup must name a ${basename(dbPath)}.backup-v<N> file beside ${dbPath}.`,
        "error",
      );
      return;
    }
    const nameVersion = Number(nameMatch[1]);
    const engine = await import("./db/engine.js");
    if (nameVersion > engine.SCHEMA_VERSION) {
      ctx.ui.notify(
        `gsd db restore-backup: backup schema is v${nameVersion}, newer than the v${engine.SCHEMA_VERSION} this gsd-pi supports. ` +
        "Upgrade gsd-pi (npm i -g @opengsd/gsd-pi) before restoring this backup.",
        "error",
      );
      return;
    }
    if (!existsSync(dbPath)) {
      ctx.ui.notify(`gsd db restore-backup: no project database at ${dbPath} — nothing to restore over.`, "error");
      return;
    }

    // Ensure the engine DB is open. A crashed earlier restore opens as a
    // read-only observation connection; fresh runs migrate as usual.
    const opened = openWorkflowDatabase(basePath);
    if (!opened.ok) {
      ctx.ui.notify(`gsd db restore-backup: cannot open the project database (${opened.reason}).`, "error");
      return;
    }

    const { getDatabaseReplacementPaths } = await import("./database-replacement-paths.js");
    const paths = getDatabaseReplacementPaths(dbPath);
    let existingIntent: RestoreBackupIntent | null;
    try {
      existingIntent = readRestoreBackupIntent(paths.activeIntentPath);
    } catch {
      ctx.ui.notify(
        `gsd db restore-backup: malformed restore intent at ${paths.activeIntentPath} — ` +
        `inspect and remove the ${basename(dbPath)}.recovery directory manually, then retry.`,
        "error",
      );
      return;
    }
    if (existingIntent !== null) {
      // Crash convergence: the replacement intent itself fences writers, so no
      // maintenance claim is taken; promote the observation connection instead.
      engine.promoteDatabaseForReplacementRecovery();
    }

    let verified: VerifiedRestoreBackup;
    try {
      verified = await verifyRestoreBackupCandidate(backupPath, nameVersion);
    } catch (error) {
      ctx.ui.notify(`gsd db restore-backup: backup verification failed: ${(error as Error).message}. Nothing was restored.`, "error");
      return;
    }

    const currentProjectId = engine.getDb().prepare(
      "SELECT project_id FROM project_authority WHERE singleton = 1",
    ).get()?.["project_id"];
    if (typeof currentProjectId !== "string" || currentProjectId !== verified.projectId) {
      ctx.ui.notify("gsd db restore-backup: the backup belongs to a different project — refusing to restore. Nothing was restored.", "error");
      return;
    }

    const backupSha = sha256FileHex(backupPath);
    const byteSize = Number(lstatSync(backupPath).size);

    const consent = requestedRestoreConsent(args);
    if (!consent) {
      ctx.ui.notify([
        "gsd db restore-backup: explicit consent is required — nothing was restored.",
        `  Backup:  ${basename(backupPath)} (schema v${verified.schemaVersion}, ${byteSize} bytes)`,
        `  sha256:  ${backupSha}`,
        "",
        "This replaces the current database with the verified backup; current DB contents are erased.",
        "Re-run with:",
        `  /gsd db restore-backup --backup ${backupPath} --consent=proceed:destructive-database-restore:${backupSha}`,
      ].join("\n"), "warning");
      return;
    }
    if (consent.evidenceHash !== backupSha) {
      ctx.ui.notify([
        "gsd db restore-backup: stale consent — the consent hash does not match the backup file. Nothing was restored.",
        `  Current backup sha256: ${backupSha}`,
        "Re-run with:",
        `  /gsd db restore-backup --backup ${backupPath} --consent=proceed:destructive-database-restore:${backupSha}`,
      ].join("\n"), "error");
      return;
    }

    // Deterministic receipt/intent material: every field derives only from the
    // backup file and its contents, so a crash-converging re-run recomputes
    // the identical request and the receipt domain operation replays.
    const { canonicalLegacyImportJson, hashLegacyImportValue } = await import("./legacy-import-preview.js");
    const applicationOperationId = `backup-restore/${backupSha.slice("sha256:".length, "sha256:".length + 24)}`;
    const applicationIdentityHash = hashLegacyImportValue({
      backupRestoreApplication: 1,
      applicationOperationId,
      backupSha256: backupSha,
      backupByteSize: byteSize,
      backupSchemaVersion: verified.schemaVersion,
      projectId: verified.projectId,
      backupProjectRevision: verified.projectRevision,
      backupAuthorityEpoch: verified.authorityEpoch,
    });
    const erasedLineage = {
      schemaVersion: 1,
      applicationOperationId,
      applicationIdentityHash,
      applicationResultingProjectRevision: verified.projectRevision + 1,
      applicationResultingAuthorityEpoch: verified.authorityEpoch,
    };
    const erasedLineageJson = canonicalLegacyImportJson(erasedLineage);
    const erasedLineageHash = hashLegacyImportValue(erasedLineage);
    const previewId = basename(backupPath);
    const previewHash = hashLegacyImportValue({ backupRestorePreview: 1, previewId, backupSha256: backupSha });
    const backupId = hashLegacyImportValue({ backupRestoreBackup: 1, fileName: previewId, backupSha256: backupSha, backupByteSize: byteSize });
    const differenceHash = hashLegacyImportValue({ backupRestoreDifference: 1, backupSha256: backupSha, backupSchemaVersion: verified.schemaVersion, projectId: verified.projectId });
    const consentHash = hashLegacyImportValue(consent);
    const verificationHash = hashLegacyImportValue({
      backupRestoreVerification: 1,
      backupSha256: backupSha,
      quickCheck: "ok",
      backupSchemaVersion: verified.schemaVersion,
      projectId: verified.projectId,
      backupProjectRevision: verified.projectRevision,
      backupAuthorityEpoch: verified.authorityEpoch,
    });
    const receiptPayload = {
      applicationOperationId,
      applicationIdentityHash,
      applicationResultingProjectRevision: verified.projectRevision + 1,
      applicationResultingAuthorityEpoch: verified.authorityEpoch,
      erasedLineageHash,
      erasedLineageJson,
      previewId,
      previewHash,
      backupId,
      backupSha256: backupSha,
      backupByteSize: byteSize,
      backupSchemaVersion: verified.schemaVersion,
      backupProjectRevision: verified.projectRevision,
      backupAuthorityEpoch: verified.authorityEpoch,
      differenceHash,
      consentHash,
      verificationHash,
    };
    const requestHash = hashLegacyImportValue({
      backupRestoreRequest: 1,
      backupSha256: backupSha,
      backupByteSize: byteSize,
      backupSchemaVersion: verified.schemaVersion,
      projectId: verified.projectId,
      backupProjectRevision: verified.projectRevision,
      backupAuthorityEpoch: verified.authorityEpoch,
      fileName: previewId,
    });
    const idempotencyKey = `import.restore/${requestHash.slice("sha256:".length)}`;

    if (existingIntent !== null && existingIntent.requestHash !== requestHash) {
      ctx.ui.notify(
        `gsd db restore-backup: a different restore intent is active at ${paths.activeIntentPath}. ` +
        `If you are certain it is stale, remove the ${basename(dbPath)}.recovery directory and retry.`,
        "error",
      );
      return;
    }
    if (existingIntent !== null && await restoreBackupIntentOwnerIsActive(existingIntent)) {
      ctx.ui.notify("gsd db restore-backup: another live process owns the active restore intent — wait for it to finish.", "error");
      return;
    }

    const { processStartIdentity } = await import("./process-start-identity.js");
    const selfIdentity = processStartIdentity(process.pid);
    if (selfIdentity === null) {
      throw new Error("cannot prove the current process start identity");
    }
    const originalIdentity = existingIntent !== null
      ? { device: existingIntent.originalDatabaseDevice, inode: existingIntent.originalDatabaseInode }
      : restoreFileIdentity(dbPath);
    const intentBase: RestoreBackupIntent = {
      intentSchemaVersion: 1,
      requestHash,
      stage: "claimed",
      ownerPid: process.pid,
      ownerProcessStartIdentity: selfIdentity,
      ownerNonce: randomUUID(),
      originalDatabaseDevice: originalIdentity.device,
      originalDatabaseInode: originalIdentity.inode,
      candidateDatabaseDevice: null,
      candidateDatabaseInode: null,
      applicationOperationId,
      applicationIdentityHash,
      backupId,
      backupSha256: backupSha,
      backupByteSize: byteSize,
      backupSchemaVersion: verified.schemaVersion,
      backupProjectRevision: verified.projectRevision,
      backupAuthorityEpoch: verified.authorityEpoch,
      assessmentEvidenceHash: consent.evidenceHash,
      differenceHash,
      consentHash,
      erasedLineageHash,
      erasedLineageJson,
    };

    const plan: RestoreBackupPlan = {
      dbPath,
      backupPath,
      backupSha,
      idempotencyKey,
      verified,
      originalIdentity,
      intentBase,
      receiptPayload,
    };
    // Fresh runs restore inside the startup EXCLUSIVE maintenance claim
    // (single-writer invariant); crash-convergence re-runs are already fenced
    // by the replacement intent, and the claim would refuse them.
    const status = existingIntent !== null
      ? await executeRestoreBackupPlan(plan)
      : await engine.withDatabaseMaintenanceClaim(() => executeRestoreBackupPlan(plan));
    engine.closeDatabase();

    const downgradeNote = verified.schemaVersion < engine.SCHEMA_VERSION
      ? `To stay on schema v${verified.schemaVersion}, run the older gsd-pi release this backup was taken with — ` +
        `this gsd-pi stamps v${engine.SCHEMA_VERSION} on next open (keeping a fresh verified backup-v${verified.schemaVersion}).`
      : `Backup schema matches this gsd-pi (v${engine.SCHEMA_VERSION}).`;
    ctx.ui.notify([
      `gsd db restore-backup: restored ${basename(backupPath)}`,
      `  Backup schema: v${verified.schemaVersion}`,
      `  Backup sha256: ${backupSha}`,
      `  Receipt: import.restore ${status} (application ${applicationOperationId})`,
      `  ${downgradeNote}`,
    ].join("\n"), "success");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logWarning("command", `db restore-backup failed: ${msg}`);
    try {
      (await import("./db/engine.js")).closeDatabase();
    } catch (closeError) {
      logWarning("command", `db restore-backup could not close the database after the failure above: ${(closeError as Error).message}`);
    }
    ctx.ui.notify(`gsd db restore-backup failed: ${msg}. If a restore was interrupted, re-run the identical command to converge.`, "error");
  }
}
