// gsd-pi — Pre-merge stash handling for auto-worktree merge closeout.
//
// Owns the local-work protection around milestone merge: stash before merge,
// DB handle cycling for Windows, restoring on merge failures, and post-commit
// stash-pop conflict recovery.

import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import {
  closeWorkflowDatabase,
  getWorkflowDatabasePath,
  openWorkflowDatabasePath,
} from "./db-workspace.js";
import {
  nativeAddPaths,
  nativeConflictFiles,
  nativeLsFiles,
  nativeRmForce,
} from "./native-git-bridge.js";
import {
  gsdJsonlFilesWithConflictMarkers,
  hasConflictMarkers,
  popStashByRef,
  stashAlreadyExistsFilesFromError,
  stashRefFromError,
} from "./worktree-git-recovery.js";
import { logWarning } from "./workflow-logger.js";
import { checkpointDatabase } from "./gsd-db.js";

export interface PreMergeStash {
  stash(): void;
  reopenDbAfterMerge(): void;
  restoreBeforeAutoCommit(): void;
  restoreForMergeFailure(): void;
  restoreAfterCommit(): void;
}

export interface PreMergeStashOptions {
  excludeGsdState?: boolean;
}

export function createPreMergeStash(
  basePath: string,
  milestoneId: string,
  cycleDbHandles: boolean,
  options: PreMergeStashOptions = {},
): PreMergeStash {
  let stashed = false;
  let marker: string | null = null;
  const dbPathToReopen = cycleDbHandles ? getWorkflowDatabasePath() : null;

  return {
    stash(): void {
      closeDbBeforeStashIfNeeded(cycleDbHandles);
      try {
        const status = execFileSync("git", ["status", "--porcelain"], {
          cwd: basePath,
          stdio: ["ignore", "pipe", "pipe"],
          encoding: "utf-8",
        }).trim();
        if (!status) return;

        marker = createStashMarker(milestoneId);
        const stashOutput = execFileSync(
          "git",
          [
            "stash",
            "push",
            "--include-untracked",
            "-m",
            `gsd: pre-merge stash for ${milestoneId} [${marker}]`,
            "--",
            ".",
            ":(exclude).gsd/.milestone-shelter",
            ":(exclude,glob).gsd/.milestone-shelter/**",
            ...(options.excludeGsdState
              ? [":(exclude).gsd", ":(exclude,glob).gsd/**"]
              : []),
          ],
          { cwd: basePath, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" },
        );
        stashed = stashOutput.includes(marker);
      } catch (err) {
        // Stash failure is non-fatal — proceed without stash and let the merge
        // report the dirty tree if it fails.
        logWarning("worktree", `git stash failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },

    reopenDbAfterMerge(): void {
      if (!cycleDbHandles || !dbPathToReopen) return;
      try {
        openWorkflowDatabasePath(dbPathToReopen);
      } catch (err) {
        logWarning("worktree", `post-merge db reopen failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },

    restoreBeforeAutoCommit(): void {
      if (!stashed) return;
      const restoredRef = popStashByRef(basePath, marker);
      if (!restoredRef) {
        throw new Error("pre-merge authorization stash could not be restored");
      }
      stashed = false;
    },

    restoreForMergeFailure(): void {
      if (!stashed) return;
      try {
        popStashByRef(basePath, marker);
        stashed = false;
      } catch (err) {
        logWarning("worktree", `git stash pop failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },

    restoreAfterCommit(): void {
      if (!stashed) return;
      restoreStashAfterCommit(basePath, marker);
      stashed = false;
    },
  };
}

function closeDbBeforeStashIfNeeded(cycleDbHandles: boolean): void {
  if (!cycleDbHandles) return;
  try {
    const databasePath = getWorkflowDatabasePath();
    if (!databasePath) throw new Error("active workflow database path is unavailable");
    checkpointDatabase();
    closeWorkflowDatabase();
    removeCheckpointedSqliteSidecars(databasePath);
  } catch (err) {
    logWarning("worktree", `pre-stash db close failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function removeCheckpointedSqliteSidecars(databasePath: string): void {
  for (const suffix of ["-wal", "-shm"]) {
    const path = `${databasePath}${suffix}`;
    let descriptor: number;
    try {
      descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    try {
      const opened = fstatSync(descriptor, { bigint: true });
      const live = lstatSync(path, { bigint: true });
      if (!opened.isFile() || live.isSymbolicLink() || opened.dev !== live.dev || opened.ino !== live.ino) {
        throw new Error(`SQLite ${suffix} sidecar identity changed after checkpoint`);
      }
      if (suffix === "-wal" && opened.size !== 0n) {
        throw new Error("SQLite WAL remained non-empty after checkpoint");
      }
    } finally {
      closeSync(descriptor);
    }
    unlinkSync(path);
  }
}

function createStashMarker(milestoneId: string): string {
  return `gsd-pre-merge:${milestoneId}:${process.pid}:${Date.now()}:${process.hrtime.bigint().toString(36)}`;
}

function restoreStashAfterCommit(basePath: string, marker: string | null): void {
  let stashRefForDrop: string | null = null;
  try {
    stashRefForDrop = popStashByRef(basePath, marker);
  } catch (e) {
    stashRefForDrop = stashRefFromError(e);
    logWarning("worktree", `git stash pop failed, attempting conflict resolution: ${(e as Error).message}`);
    resolveStashPopConflict(basePath, e, stashRefForDrop);
  }
}

function resolveStashPopConflict(basePath: string, error: unknown, stashRefForDrop: string | null): void {
  const uu = nativeConflictFiles(basePath);
  const gsdUU = uu.filter((f) => f.startsWith(".gsd/"));
  const nonGsdUU = uu.filter((f) => !f.startsWith(".gsd/"));
  const stashPopMessage = error instanceof Error ? error.message : String(error);
  const isUntrackedRestoreFailure = stashPopMessage.includes("could not restore untracked files from stash");
  const gsdContentConflicts: string[] = [];
  const alreadyExists = stashAlreadyExistsFilesFromError(error);

  if (isUntrackedRestoreFailure) {
    gsdContentConflicts.push(...gsdJsonlFilesWithConflictMarkers(basePath));
  }

  const gsdConflictFiles = [...new Set([...gsdUU, ...gsdContentConflicts])];
  resolveGsdConflictFiles(basePath, gsdConflictFiles);

  if (gsdConflictFiles.length > 0 && nonGsdUU.length === 0) {
    dropStashIfNoNonGsdConflictsRemain(basePath, stashRefForDrop);
    return;
  }

  if (gsdUU.length === 0 && nonGsdUU.length === 0 && alreadyExists.length > 0) {
    dropRecordedStash(basePath, stashRefForDrop);
    return;
  }

  if (nonGsdUU.length > 0) {
    logWarning("reconcile", "Stash pop conflict on non-.gsd files after merge", {
      files: nonGsdUU.join(", "),
    });
    return;
  }

  logWarning(
    "worktree",
    "git stash pop failed without resolvable conflict files; leaving stash for manual recovery",
  );
}

function resolveGsdConflictFiles(basePath: string, conflictFiles: string[]): void {
  for (const file of conflictFiles) {
    try {
      // Accept the committed (HEAD) version of the state file.
      execFileSync("git", ["checkout", "HEAD", "--", file], {
        cwd: basePath,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
      });
      nativeAddPaths(basePath, [file]);
    } catch (err) {
      // Last resort: remove the conflicted state file.
      logWarning("worktree", `checkout HEAD failed for ${file}, removing: ${(err as Error).message}`);
      nativeRmForce(basePath, [file]);
    }
  }
}

function dropStashIfNoNonGsdConflictsRemain(basePath: string, stashRefForDrop: string | null): void {
  const remainingUnmerged = nativeConflictFiles(basePath);
  const nonGsdUnmerged = remainingUnmerged.filter((f) => !f.startsWith(".gsd/"));
  const markerCandidates = Array.from(new Set([
    ...nonGsdUnmerged,
    ...nativeLsFiles(basePath, "."),
  ])).filter((f) => !f.startsWith(".gsd/"));
  const nonGsdMarkerConflicts = markerCandidates.filter((f) =>
    hasConflictMarkers(join(basePath, f)),
  );
  const hasRemainingNonGsdConflicts = nonGsdUnmerged.length > 0 || nonGsdMarkerConflicts.length > 0;
  if (hasRemainingNonGsdConflicts) {
    const files = Array.from(new Set([...nonGsdUnmerged, ...nonGsdMarkerConflicts]));
    logWarning("reconcile", "Leaving stash because non-.gsd conflicts remain after auto-resolution", {
      files: files.join(", "),
    });
    return;
  }

  dropRecordedStash(basePath, stashRefForDrop);
}

function dropRecordedStash(basePath: string, stashRefForDrop: string | null): void {
  if (!stashRefForDrop) {
    logWarning("worktree", "recorded stash entry could not be resolved; skipping automatic drop");
    return;
  }
  try {
    execFileSync("git", ["stash", "drop", stashRefForDrop], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    });
  } catch (err) {
    logWarning("worktree", `git stash drop failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
