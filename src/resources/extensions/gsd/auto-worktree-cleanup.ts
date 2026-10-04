// gsd-pi — Auto-worktree cleanup helpers.
//
// Owns shared cleanup primitives used by teardown and merge cleanup paths:
// the worktree-local DB check, transient project-root state removal,
// git pathspec conversion for externally-rooted .gsd paths, and expected
// unlink error classification.

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, unlinkSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

import { gsdRoot, normalizeRealPath } from "./paths.js";
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

/**
 * True when the worktree holds its own gsd.db, a file other than the project
 * database. Worktrees share the project database, so such a file comes from
 * an older release, a manual copy, or a git-tracked gsd.db.
 */
export function _hasWorktreeLocalDb(
  worktreeDbPath: string,
  mainDbPath: string,
  pathExists: (path: string) => boolean = existsSync,
  samePath: (a: string, b: string) => boolean = isSamePath,
): boolean {
  return pathExists(worktreeDbPath) && !samePath(worktreeDbPath, mainDbPath);
}

/**
 * The path where a worktree holds a gsd.db of its own, or null when the
 * worktree `.gsd` resolves outside the worktree directory. That layout is
 * shared external state: a gsd.db there is project state, not a worktree-local
 * file, also when the project `.gsd` no longer points at the same directory.
 */
export function worktreeOwnDbPath(worktreeRoot: string): string | null {
  const ownGsd = join(normalizeRealPath(worktreeRoot), ".gsd");
  return normalizeRealPath(ownGsd) === ownGsd ? join(ownGsd, "gsd.db") : null;
}

/**
 * The stop message for a worktree-local gsd.db. GSD never merges such a file
 * into the project database on its own: the operator imports it explicitly.
 */
export function worktreeLocalDbInstruction(worktreeDbPath: string, worktreeName: string): string {
  return `worktree-local database found at ${worktreeDbPath}. ` +
    `GSD does not merge it into the project database automatically. ` +
    `Run /worktree import-db ${worktreeName} to preview and import its rows, ` +
    `or delete the file when its rows are not needed.`;
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
  // remaining transient file ({MID}-META.json) is still worth removing on
  // teardown. STATE.md is a DB projection and is never deleted here.
  const transientFiles = [
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
