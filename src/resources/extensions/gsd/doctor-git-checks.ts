// gsd-pi doctor git health checks
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import type { DoctorIssue, DoctorIssueCode } from "./doctor-types.js";
import { loadFile } from "./files.js";
import { resolveMilestoneFile } from "./paths.js";
import { isCompletedMilestoneTerminal } from "./milestone-closeout.js";
import { deriveState } from "./state.js";
import { isClosedStatus } from "./status-guards.js";
import { allWorktreesDirs, createWorktree, listWorktrees, resolveGitDir } from "./worktree-manager.js";
import { abortAndReset } from "./git-self-heal.js";
import { RUNTIME_EXCLUSION_PATHS, resolveMilestoneIntegrationBranch, writeIntegrationBranch } from "./git-service.js";
import { nativeIsRepo, nativeWorktreeList, nativeWorktreeRemove, nativeBranchList, nativeBranchDelete, nativeLsFiles, nativeRmCached, nativeHasChanges, nativeLastCommitEpoch, nativeGetCurrentBranch, nativeAddTracked, nativeCommit, nativeIsCurrentUnbornBranch } from "./native-git-bridge.js";
import { getAllWorktreeHealth } from "./worktree-health.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import { listUnmergedGitPaths, probeGitConflictState, reconcileGitConflictsOnSignal } from "./git-conflict-state.js";
import { resolveWorktreeProjectRoot } from "./worktree-root.js";
import { enterBranchModeForMilestone } from "./auto-worktree-branch-lifecycle.js";

/**
 * Returns true if the directory contains only doctor artifacts
 * (e.g. `.gsd/doctor-history.jsonl`). These dirs are created by
 * appendDoctorHistory() writing to worktree-scoped paths during the audit
 * and should not be flagged as orphaned worktrees (#3105).
 */
function isDoctorArtifactOnly(dirPath: string): boolean {
  try {
    const entries = readdirSync(dirPath);
    // Empty dir — not a doctor artifact, still orphaned
    if (entries.length === 0) return false;
    // Only a .gsd subdirectory
    if (entries.length === 1 && entries[0] === ".gsd") {
      const gsdEntries = readdirSync(join(dirPath, ".gsd"));
      return gsdEntries.length <= 1 && gsdEntries.every(e => e === "doctor-history.jsonl");
    }
    return false;
  } catch {
    return false;
  }
}

function normalizePathForComparison(path: string): string {
  const resolved = existsSync(path) ? realpathSync(path) : path;
  const normalized = resolved
    .replaceAll("\\", "/")
    .replace(/^\/\/\?\//, "")
    .replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isSameOrNestedPath(candidate: string, container: string): boolean {
  const normalizedCandidate = normalizePathForComparison(candidate);
  const normalizedContainer = normalizePathForComparison(container);
  return normalizedCandidate === normalizedContainer ||
    normalizedCandidate.startsWith(`${normalizedContainer}/`);
}

function normalizeGitPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isProjectContentPath(path: string): boolean {
  const normalized = normalizeGitPath(path);
  if (!normalized || normalized.endsWith("/")) return false;
  if (normalized === ".gitignore" || normalized === ".gitattributes") return false;
  if (normalized.endsWith(".DS_Store")) return false;
  const parts = normalized.split("/");
  return !parts.some(part => part === ".git" || part === ".gsd");
}

function gitLines(basePath: string, args: string[]): string[] {
  const result = spawnSync("git", args, {
    cwd: basePath,
    encoding: "utf-8",
  });
  if (result.status !== 0) return [];
  return result.stdout
    .split("\n")
    .map(line => normalizeGitPath(line.trim()))
    .filter(isProjectContentPath);
}

function listProjectContentFiles(basePath: string): string[] {
  return [...new Set([
    ...gitLines(basePath, ["ls-files"]),
    ...gitLines(basePath, ["ls-files", "--others", "--exclude-standard"]),
  ])];
}

function hasMaterializedProjectContentFallback(dirPath: string): boolean {
  try {
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      if (!isProjectContentPath(entry.name)) continue;
      if (entry.name === ".DS_Store") continue;
      if (entry.isDirectory()) {
        if (hasMaterializedProjectContentFallback(join(dirPath, entry.name))) return true;
        continue;
      }
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function hasProjectContentOnDisk(dirPath: string): boolean {
  const gitProjectFiles = listProjectContentFiles(dirPath);
  if (gitProjectFiles.length > 0) {
    return gitProjectFiles.some(file => existsSync(join(dirPath, file)));
  }
  return hasMaterializedProjectContentFallback(dirPath);
}

function copyProjectRootContentIntoWorktree(projectRoot: string, worktreeRoot: string): number {
  let copied = 0;
  for (const relPath of listProjectContentFiles(projectRoot)) {
    const src = join(projectRoot, relPath);
    if (!existsSync(src)) continue;
    const dst = join(worktreeRoot, relPath);
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst, { recursive: true, force: true });
    copied++;
  }
  return copied;
}

function getSnapshotDiffCheckFailure(basePath: string): string | null {
  const failures: string[] = [];

  for (const args of [["--cached"], []]) {
    const result = spawnSync("git", ["diff", "--check", ...args], {
      cwd: basePath,
      encoding: "utf-8",
    });
    if (result.status === 0) continue;

    const output = [result.stdout, result.stderr, result.error?.message]
      .filter(Boolean)
      .join("\n")
      .trim();
    failures.push(output || `git diff --check ${args.join(" ")} failed`);
  }

  return failures.length > 0 ? failures.join("\n") : null;
}

export async function checkGitHealth(
  basePath: string,
  issues: DoctorIssue[],
  fixesApplied: string[],
  shouldFix: (code: DoctorIssueCode) => boolean,
  isolationMode: "none" | "worktree" | "branch" = "none",
  dryRun = false,
): Promise<void> {
  // Degrade gracefully if not a git repo
  if (!nativeIsRepo(basePath)) {
    return; // Not a git repo — skip all git health checks
  }

  const gitDir = resolveGitDir(basePath);
  let unmergedPaths = listUnmergedGitPaths(basePath);
  if (unmergedPaths === null) {
    issues.push({
      severity: "error",
      code: "corrupt_merge_state",
      scope: "project",
      unitId: "project",
      message: "Failed to evaluate unresolved Git conflicts. Resolve Git/worktree state manually before resuming auto-mode.",
      fixable: false,
    });
    return;
  }

  // ── Auto-resolve safe conflicts before reporting ──────────────────────
  // A failed worktree merge (e.g. during complete-slice) can leave conflict
  // markers for paths that are always safe to accept from the milestone side
  // (.gsd/ state and build artifacts). Run the same reconciliation the
  // preflight/auto-worktree paths use before the doctor hard-blocks auto-mode,
  // so only genuinely-manual conflicts remain. This also clears stale
  // merge-state markers (e.g. MERGE_HEAD) in the same pass when auto-resolve
  // empties the unmerged set (#849).
  if (unmergedPaths.length > 0 && !dryRun) {
    try {
      const reconcileFixes = reconcileGitConflictsOnSignal(basePath, probeGitConflictState(basePath));
      if (reconcileFixes.length > 0) {
        fixesApplied.push(...reconcileFixes);
        const refreshed = listUnmergedGitPaths(basePath);
        if (refreshed !== null) unmergedPaths = refreshed;
      }
    } catch {
      // Non-fatal — fall through to report the unmerged paths as-is
    }
  }

  // ── Orphaned auto-worktrees & Stale milestone branches ────────────────
  // These checks only apply in worktree/branch modes — skip in none mode
  // where no milestone worktrees or branches are created.
  if (isolationMode !== "none") {
  try {
    const worktrees = listWorktrees(basePath);
    // Orphan entries are milestone branches with no backing worktree; they are
    // handled by the stale milestone branch check below, not the worktree checks.
    const milestoneWorktrees = worktrees.filter(wt => wt.branch.startsWith("milestone/") && !wt.orphan);

    // Load roadmap state once for cross-referencing
    const state = await deriveState(basePath);

    for (const wt of milestoneWorktrees) {
      // Extract milestone ID from branch name "milestone/M001" → "M001"
      const milestoneId = wt.branch.replace(/^milestone\//, "");
      const milestoneEntry = state.registry.find(m => m.id === milestoneId);
      const isComplete = milestoneEntry
        ? isClosedStatus(milestoneEntry.status)
        : false;

      if (!isComplete && !hasProjectContentOnDisk(wt.path) && hasProjectContentOnDisk(basePath)) {
        issues.push({
          severity: "error",
          code: "worktree_empty_with_project_content",
          scope: "milestone",
          unitId: milestoneId,
          message: `Worktree ${wt.path} has no project content, but project root ${basePath} does. Run doctor --fix to recreate the worktree.`,
          fixable: true,
        });

        if (shouldFix("worktree_empty_with_project_content")) {
          try {
            nativeWorktreeRemove(basePath, wt.path, true);
            const recreated = createWorktree(basePath, milestoneId, {
              branch: wt.branch,
              reuseExistingBranch: true,
            });
            const reset = spawnSync("git", ["reset", "--hard"], {
              cwd: recreated.path,
              encoding: "utf-8",
            });
            if (reset.status !== 0) {
              throw new Error(reset.stderr || reset.error?.message || "git reset --hard failed");
            }
            const copied = !hasProjectContentOnDisk(recreated.path) && hasProjectContentOnDisk(basePath)
              ? copyProjectRootContentIntoWorktree(basePath, recreated.path)
              : 0;
            if (!hasProjectContentOnDisk(recreated.path) && hasProjectContentOnDisk(basePath)) {
              throw new Error("recreated worktree still has no project content");
            }
            fixesApplied.push(
              copied > 0
                ? `recreated empty worktree ${wt.path} and copied ${copied} project file${copied === 1 ? "" : "s"} from project root`
                : `recreated empty worktree ${wt.path}`,
            );
          } catch {
            fixesApplied.push(`failed to recreate empty worktree ${wt.path}`);
          }
        }
      }

      if (isComplete) {
        issues.push({
          severity: "warning",
          code: "orphaned_auto_worktree",
          scope: "milestone",
          unitId: milestoneId,
          message: `Worktree for completed milestone ${milestoneId} still exists at ${wt.path}`,
          fixable: true,
        });

        if (shouldFix("orphaned_auto_worktree")) {
          // If cwd is inside the worktree, chdir out first — matching the
          // pattern in removeWorktree() (#1946). Without this, git cannot
          // remove the worktree and the doctor enters a deadlock where it
          // detects the orphan every run but never cleans it up.
          let cwd = basePath;
          try {
            cwd = process.cwd();
          } catch {
            cwd = basePath;
          }
          if (isSameOrNestedPath(cwd, wt.path)) {
            try {
              process.chdir(basePath);
            } catch {
              fixesApplied.push(`skipped removing worktree at ${wt.path} (cannot chdir to basePath)`);
              continue;
            }
          }
          try {
            nativeWorktreeRemove(basePath, wt.path, true);
            fixesApplied.push(`removed orphaned worktree ${wt.path}`);
          } catch {
            fixesApplied.push(`failed to remove worktree ${wt.path}`);
          }
        }
      }
    }

    // ── Stale milestone branches ─────────────────────────────────────────
    try {
      const branches = nativeBranchList(basePath, "milestone/*");
      if (branches.length > 0) {
        const worktreeBranches = new Set(milestoneWorktrees.map(wt => wt.branch));

        for (const branch of branches) {
          // Skip branches that have a worktree (handled above)
          if (worktreeBranches.has(branch)) continue;

          const milestoneId = branch.replace(/^milestone\//, "");
          const roadmapPath = resolveMilestoneFile(basePath, milestoneId, "ROADMAP");
          let branchMilestoneComplete = false;
          const roadmapContent = roadmapPath ? await loadFile(roadmapPath) : null;
          if (!roadmapContent) continue;
          const milestoneEntry = state.registry.find(m => m.id === milestoneId);
          if (!milestoneEntry || !isClosedStatus(milestoneEntry.status)) continue;
          branchMilestoneComplete = await isCompletedMilestoneTerminal(basePath, milestoneId);
          if (branchMilestoneComplete) {
            issues.push({
              severity: "info",
              code: "stale_milestone_branch",
              scope: "milestone",
              unitId: milestoneId,
              message: `Branch ${branch} exists for completed milestone ${milestoneId}`,
              fixable: true,
            });

            if (shouldFix("stale_milestone_branch")) {
              try {
                nativeBranchDelete(basePath, branch, true);
                fixesApplied.push(`deleted stale branch ${branch}`);
              } catch {
                fixesApplied.push(`failed to delete branch ${branch}`);
              }
            }
          }
        }
      }
    } catch {
      // git branch list failed — skip stale branch check
    }
  } catch {
    // listWorktrees or deriveState failed — skip worktree/branch checks
  }
  } // end isolationMode !== "none"

  // ── Corrupt merge state ────────────────────────────────────────────────
  try {
    const mergeStateFiles = ["MERGE_HEAD", "SQUASH_MSG"];
    const mergeStateDirs = ["rebase-apply", "rebase-merge"];
    const found: string[] = [];

    for (const f of mergeStateFiles) {
      if (existsSync(join(gitDir, f))) found.push(f);
    }
    for (const d of mergeStateDirs) {
      if (existsSync(join(gitDir, d))) found.push(d);
    }

    if (unmergedPaths.length > 0) {
      issues.push({
        severity: "error",
        code: "unresolved_git_conflicts",
        scope: "project",
        unitId: "project",
        message: `Unresolved Git conflicts detected: ${unmergedPaths.join(", ")}. Resolve these files manually before auto-mode can proceed.`,
        fixable: false,
      });
    }

    if (found.length > 0) {
      issues.push({
        severity: "error",
        code: "corrupt_merge_state",
        scope: "project",
        unitId: "project",
        message: `Corrupt merge/rebase state detected: ${found.join(", ")}`,
        fixable: unmergedPaths.length === 0,
      });

      if (shouldFix("corrupt_merge_state") && unmergedPaths.length === 0) {
        const result = abortAndReset(basePath);
        fixesApplied.push(`cleaned merge state: ${result.cleaned.join(", ")}`);
      } else if (shouldFix("corrupt_merge_state")) {
        fixesApplied.push("skipped merge-state reset because unresolved conflicts require manual resolution");
      }
    }
  } catch {
    // Can't check .git dir — skip
  }

  // ── Tracked runtime files ──────────────────────────────────────────────
  try {
    const trackedPaths: string[] = [];
    for (const exclusion of RUNTIME_EXCLUSION_PATHS) {
      try {
        const files = nativeLsFiles(basePath, exclusion);
        if (files.length > 0) {
          trackedPaths.push(...files);
        }
      } catch {
        // Individual ls-files can fail — continue
      }
    }

    if (trackedPaths.length > 0) {
      issues.push({
        severity: "warning",
        code: "tracked_runtime_files",
        scope: "project",
        unitId: "project",
        message: `${trackedPaths.length} runtime file(s) are tracked by git: ${trackedPaths.slice(0, 5).join(", ")}${trackedPaths.length > 5 ? "..." : ""}`,
        fixable: true,
      });

      if (shouldFix("tracked_runtime_files")) {
        try {
          for (const exclusion of RUNTIME_EXCLUSION_PATHS) {
            nativeRmCached(basePath, [exclusion]);
          }
          fixesApplied.push(`untracked ${trackedPaths.length} runtime file(s)`);
        } catch {
          fixesApplied.push("failed to untrack runtime files");
        }
      }
    }
  } catch {
    // git ls-files failed — skip
  }

  // ── Legacy slice branches ──────────────────────────────────────────────
  try {
    const branchList = nativeBranchList(basePath, "gsd/*/*")
      .filter((branch) => !branch.startsWith("gsd/quick/"));
    if (branchList.length > 0) {
      issues.push({
        severity: "info",
        code: "legacy_slice_branches",
        scope: "project",
        unitId: "project",
        message: `${branchList.length} legacy slice branch(es) found: ${branchList.slice(0, 3).join(", ")}${branchList.length > 3 ? "..." : ""}. These are no longer used (branchless architecture).`,
        fixable: true,
      });

      if (shouldFix("legacy_slice_branches")) {
        let deleted = 0;
        for (const branch of branchList) {
          try {
            nativeBranchDelete(basePath, branch, true);
            deleted++;
          } catch { /* skip branches that can't be deleted */ }
        }
        if (deleted > 0) {
          fixesApplied.push(`deleted ${deleted} legacy slice branch(es)`);
        }
      }
    }
  } catch {
    // git branch list failed — skip
  }

  // ── Integration branch existence ──────────────────────────────────────
  // For each active (non-complete) milestone, verify the stored integration
  // branch still exists in git. A missing integration branch blocks merge-back
  // and causes the next merge operation to fail silently.
  try {
    const state = await deriveState(basePath);
    const gitPrefs = loadEffectiveGSDPreferences()?.preferences?.git ?? {};
    for (const milestone of state.registry) {
      if (milestone.status === "complete") continue;
      const resolution = resolveMilestoneIntegrationBranch(basePath, milestone.id, gitPrefs);
      if (!resolution.recordedBranch) continue; // No stored branch — skip (not yet set)
      if (resolution.status === "fallback" && resolution.effectiveBranch) {
        issues.push({
          severity: "warning",
          code: "integration_branch_missing",
          scope: "milestone",
          unitId: milestone.id,
          message: resolution.reason,
          fixable: true,
        });
        if (shouldFix("integration_branch_missing")) {
          writeIntegrationBranch(basePath, milestone.id, resolution.effectiveBranch);
          fixesApplied.push(`updated integration branch for ${milestone.id} to "${resolution.effectiveBranch}"`);
        }
        continue;
      }

      if (resolution.status === "missing") {
        const fixableUnbornBranch =
          isolationMode === "branch" &&
          nativeIsCurrentUnbornBranch(basePath, `milestone/${milestone.id}`);
        issues.push({
          severity: "error",
          code: "integration_branch_missing",
          scope: "milestone",
          unitId: milestone.id,
          message: resolution.reason,
          fixable: fixableUnbornBranch,
        });
        if (fixableUnbornBranch && shouldFix("integration_branch_missing")) {
          enterBranchModeForMilestone(basePath, milestone.id);
          fixesApplied.push(`established integration branch for ${milestone.id}`);
        }
      }
    }
  } catch {
    // Non-fatal — integration branch check failed
  }

  // ── Orphaned worktree directories ────────────────────────────────────
  // Worktree removal can fail after a branch delete, leaving a directory
  // that is no longer registered with git. These orphaned dirs cause
  // "already exists" errors when re-creating the same worktree name.
  try {
    for (const wtDir of allWorktreesDirs(basePath)) {
      if (!existsSync(wtDir)) continue;
      // Resolve symlinks and normalize separators so that symlinked .gsd
      // paths (e.g. ~/.gsd/projects/<hash>/worktrees/…) match the paths
      // returned by `git worktree list`.
      const normalizePath = (p: string): string => {
        try { p = realpathSync(p); } catch { /* path may not exist */ }
        return p.replaceAll("\\", "/");
      };
      const registeredPaths = new Set(
        nativeWorktreeList(basePath).map(entry => normalizePath(entry.path)),
      );
      for (const entry of readdirSync(wtDir)) {
        const fullPath = join(wtDir, entry);
        try {
          if (!statSync(fullPath).isDirectory()) continue;
        } catch { continue; }
        const normalizedFullPath = normalizePath(fullPath);
        if (!registeredPaths.has(normalizedFullPath)) {
          // Skip directories that only contain doctor artifacts (.gsd/doctor-history.jsonl).
          // appendDoctorHistory() can recreate these dirs during the audit itself,
          // causing a circular false positive (#3105 Bug 1).
          if (isDoctorArtifactOnly(fullPath)) continue;
          issues.push({
            severity: "warning",
            code: "worktree_directory_orphaned",
            scope: "project",
            unitId: entry,
            message: `Worktree directory ${fullPath} exists on disk but is not registered with git. Run "git worktree prune" or doctor --fix to remove it.`,
            fixable: true,
          });
          if (shouldFix("worktree_directory_orphaned")) {
            try {
              rmSync(fullPath, { recursive: true, force: true });
              fixesApplied.push(`removed orphaned worktree directory ${fullPath}`);
            } catch {
              fixesApplied.push(`failed to remove orphaned worktree directory ${fullPath}`);
            }
          }
        }
      }
    }
  } catch {
    // Non-fatal — orphaned worktree directory check failed
  }

  // ── Stale uncommitted changes ────────────────────────────────────────────
  // If the working tree has uncommitted changes and the last commit was
  // longer ago than the configured threshold, flag it and optionally
  // auto-commit a safety snapshot so work isn't lost.
  try {
    const prefs = loadEffectiveGSDPreferences()?.preferences ?? {};
    // `git.snapshots: false` is the canonical toggle that disables WIP
    // snapshot commits — honour it here as well so both the proactive gate
    // and the doctor-run path stay consistent (#4420).
    const snapshotsEnabled = prefs.git?.snapshots !== false;
    const thresholdMinutes = prefs.stale_commit_threshold_minutes ?? 30;

    if (snapshotsEnabled && thresholdMinutes > 0) {
      const dirty = nativeHasChanges(basePath);
      if (dirty) {
        const branch = nativeGetCurrentBranch(basePath);
        const lastEpoch = nativeLastCommitEpoch(basePath, branch || "HEAD");
        const nowEpoch = Math.floor(Date.now() / 1000);
        const minutesSinceCommit = lastEpoch > 0 ? (nowEpoch - lastEpoch) / 60 : Infinity;

        if (minutesSinceCommit >= thresholdMinutes) {
          const mins = Math.floor(minutesSinceCommit);
          issues.push({
            severity: "warning",
            code: "stale_uncommitted_changes",
            scope: "project",
            unitId: "project",
            message: `Uncommitted changes detected with no commit in ${mins} minute${mins === 1 ? "" : "s"} (threshold: ${thresholdMinutes}m). Snapshotting tracked files.`,
            fixable: true,
          });

          const diffCheckFailure = getSnapshotDiffCheckFailure(basePath);
          if (diffCheckFailure) {
            issues.push({
              severity: "error",
              code: "conflict_markers_in_tracked_files",
              scope: "project",
              unitId: "project",
              message: `Cannot create gsd snapshot: tracked changes contain conflict markers or whitespace errors. Resolve conflicts manually before auto-mode can proceed.\n${diffCheckFailure}`,
              fixable: false,
            });
          }

          if (shouldFix("stale_uncommitted_changes")) {
            try {
              if (diffCheckFailure) {
                fixesApplied.push("gsd snapshot skipped - conflict markers detected in tracked files");
              } else {
                nativeAddTracked(basePath);
                const commitMsg = `gsd snapshot: uncommitted changes after ${mins}m inactivity`;
                const result = nativeCommit(basePath, commitMsg);
                if (result) {
                  fixesApplied.push(`created gsd snapshot after ${mins}m of uncommitted changes`);
                } else {
                  fixesApplied.push("gsd snapshot skipped — nothing to commit after staging tracked files");
                }
              }
            } catch {
              fixesApplied.push("failed to create gsd snapshot commit");
            }
          }
        }
      }
    }
  } catch {
    // Non-fatal — stale commit check failed
  }

  // ── Worktree lifecycle checks ──────────────────────────────────────────
  // Check GSD-managed worktrees for: merged branches, stale work, dirty
  // state, and unpushed commits. Only worktrees under .gsd/worktrees/.
  try {
    const healthBasePath = resolveWorktreeProjectRoot(basePath);
    const healthStatuses = getAllWorktreeHealth(healthBasePath);
    const cwd = process.cwd();

    for (const health of healthStatuses) {
      const wt = health.worktree;
      const isCwd = isSameOrNestedPath(cwd, wt.path);

      // Branch fully merged into main — safe to remove
      if (health.mergedIntoMain) {
        issues.push({
          severity: "info",
          code: "worktree_branch_merged",
          scope: "project",
          unitId: wt.name,
          message: `Worktree "${wt.name}" (branch ${wt.branch}) is fully merged into main${health.safeToRemove ? " — safe to remove" : ""}`,
          fixable: health.safeToRemove,
        });

        if (health.safeToRemove && shouldFix("worktree_branch_merged") && !isCwd) {
          try {
            const { removeWorktree } = await import("./worktree-manager.js");
            removeWorktree(healthBasePath, wt.name, { deleteBranch: true, branch: wt.branch });
            fixesApplied.push(`removed merged worktree "${wt.name}" and deleted branch ${wt.branch}`);
          } catch {
            fixesApplied.push(`failed to remove merged worktree "${wt.name}"`);
          }
        }
        // If merged, skip the stale/dirty/unpushed checks — they're irrelevant
        continue;
      }

      // Stale: no commits in N days, not merged
      if (health.stale) {
        const days = Math.floor(health.lastCommitAgeDays);
        issues.push({
          severity: "warning",
          code: "worktree_stale",
          scope: "project",
          unitId: wt.name,
          message: `Worktree "${wt.name}" has had no commits in ${days} day${days === 1 ? "" : "s"}`,
          fixable: false,
        });
      }

      // Dirty: uncommitted changes in a worktree (only flag on stale worktrees to avoid noise)
      if (health.dirty && health.stale) {
        issues.push({
          severity: "warning",
          code: "worktree_dirty",
          scope: "project",
          unitId: wt.name,
          message: `Worktree "${wt.name}" has ${health.dirtyFileCount} uncommitted file${health.dirtyFileCount === 1 ? "" : "s"} and is stale`,
          fixable: false,
        });
      }

      // Unpushed: commits not on any remote (only flag on stale worktrees to avoid noise)
      if (health.unpushedCommits > 0 && health.stale) {
        issues.push({
          severity: "warning",
          code: "worktree_unpushed",
          scope: "project",
          unitId: wt.name,
          message: `Worktree "${wt.name}" has ${health.unpushedCommits} unpushed commit${health.unpushedCommits === 1 ? "" : "s"}`,
          fixable: false,
        });
      }
    }
  } catch {
    // Non-fatal — worktree lifecycle check failed
  }
}
