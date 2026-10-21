// gsd-pi — Auto-worktree cleanup helpers.
//
// Owns shared cleanup primitives used by teardown and merge cleanup paths:
// same-file DB reconciliation checks, transient project-root state removal,
// git pathspec conversion for externally-rooted .gsd paths, and expected
// unlink error classification.

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, unlinkSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

import { gsdRoot } from "./paths.js";
import { milestoneMetaPath } from "./git-service.js";
import { logWarning } from "./workflow-logger.js";

function isSamePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    logWarning("worktree", `isSamePath failed: ${(e as Error).message}`);
    return false;
  }
}

export function _isSamePath(a: string, b: string): boolean {
  return isSamePath(a, b);
}

export function _shouldReconcileWorktreeDb(
  worktreeDbPath: string,
  mainDbPath: string,
  pathExists: (path: string) => boolean = existsSync,
  samePath: (a: string, b: string) => boolean = isSamePath,
): boolean {
  return pathExists(worktreeDbPath) && !samePath(worktreeDbPath, mainDbPath);
}

export function _isExpectedWorktreeUnlinkError(
  code: string | undefined,
): boolean {
  return code === "ENOENT" || code === "EISDIR";
}

function gitPathspecForWorktreePath(
  basePath: string,
  targetPath: string,
): string | null {
  let base = basePath;
  let target = targetPath;
  try {
    base = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
    }).trim() || basePath;
  } catch {
    /* keep original */
    void base;
  }
  try {
    base = realpathSync.native(base);
  } catch {
    /* keep original */
    void base;
  }
  try {
    target = realpathSync.native(targetPath);
  } catch {
    /* keep original */
    void target;
  }

  const rel = relative(base, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.replaceAll("\\", "/");
}

export function _gitPathspecForWorktreePath(
  basePath: string,
  targetPath: string,
): string | null {
  return gitPathspecForWorktreePath(basePath, targetPath);
}

export function clearProjectRootStateFiles(
  basePath: string,
  milestoneId: string,
): void {
  const gsdDir = gsdRoot(basePath);
  // Phase C pt 2: auto.lock removed from this list — the file is gone
  // (migrated to the workers + unit_dispatches + runtime_kv tables). The
  // remaining transient files (STATE.md, {MID}-META.json) are still
  // worth removing on teardown.
  const transientFiles = [
    join(gsdDir, "STATE.md"),
    // Integration-branch META now lives flat at .gsd/<MID>-META.json (ADR-045).
    milestoneMetaPath(basePath, milestoneId),
    // Legacy location — still cleaned for pre-migration trees.
    join(gsdDir, "milestones", milestoneId, `${milestoneId}-META.json`),
  ];

  for (const file of transientFiles) {
    try {
      unlinkSync(file);
    } catch (err) {
      // ENOENT is expected — file may not exist (#3597)
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        logWarning(
          "worktree",
          `file unlink failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // Clean up legacy synced milestone directories and runtime/units.
  // Older versions copied these into the project root during execution.
  // If they remain as untracked files when we attempt
  // `git merge --squash`, git rejects the merge with "local changes would
  // be overwritten", causing silent data loss (#1738).
  const syncedDirs = [
    join(gsdDir, "milestones", milestoneId),
    join(gsdDir, "runtime", "units"),
  ];

  for (const dir of syncedDirs) {
    try {
      if (!existsSync(dir)) continue;

      const pathspec = gitPathspecForWorktreePath(basePath, dir);
      if (!pathspec) continue;

      // Only remove files that are untracked by git — tracked files are
      // managed by the branch checkout and should not be deleted.
      const untrackedOutput = execFileSync(
        "git",
        ["ls-files", "--others", "--exclude-standard", pathspec],
        {
          cwd: basePath,
          stdio: ["ignore", "pipe", "pipe"],
          encoding: "utf-8",
        },
      ).trim();
      if (!untrackedOutput) continue;

      for (const f of untrackedOutput.split("\n").filter(Boolean)) {
        try {
          unlinkSync(join(basePath, f));
        } catch (err) {
          // ENOENT/EISDIR are expected for already-removed or
          // directory entries (#3597).
          const code = (err as NodeJS.ErrnoException).code;
          if (!_isExpectedWorktreeUnlinkError(code)) {
            logWarning(
              "worktree",
              `untracked file unlink failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    } catch (err) {
      /* non-fatal — git command may fail if not in repo */
      logWarning(
        "worktree",
        `untracked file cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
