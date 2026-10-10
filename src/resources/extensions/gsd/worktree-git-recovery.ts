// Project/App: gsd-pi
// File Purpose: Git checkout/stash/merge-state recovery primitives for worktree operations.

/**
 * Worktree Git Recovery — the recurring-bug hot spot, in one place.
 *
 * Owns the verbs that recover a repository from interrupted or conflicting
 * git operations during worktree transitions:
 *
 *   - `checkoutBranchWithStashGuard` — branch switch with stash protection,
 *     including the stash-pop EEXIST collision recovery for untracked files
 *     (force-checkout + targeted stash drop; #645 broadened it beyond `.gsd/`,
 *     guarded by "no non-.gsd unmerged entries remain").
 *   - `removeMergeStateFiles` — clears SQUASH_MSG / MERGE_HEAD / etc. left by
 *     a failed merge so subsequent merges don't fail on stale state.
 *   - `cleanupConflictState` — merge-abort + index reset + state-file cleanup
 *     after a conflicted (including squash) merge.
 *   - stash helpers (`popStashByRef`, `stashRefFromError`,
 *     `stashAlreadyExistsFilesFromError`, `gsdJsonlFilesWithConflictMarkers`)
 *     used by the merge pipeline in auto-worktree.ts.
 *
 * Extracted from auto-worktree.ts so recovery fixes land here instead of as
 * embedded special cases in a 2,600-line orchestration module, and so the
 * rules can be tested against scripted git states.
 *
 * The State Reconciliation drift repair (`state-reconciliation/drift/
 * merge-state.ts`) keeps its own merge-state primitive by design — drift
 * repairs own their raw primitives (see CONTEXT.md, Drift repair).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { debugLog } from "./debug-logger.js";
import { logError, logWarning } from "./workflow-logger.js";
import {
  nativeAddPaths,
  nativeCheckoutBranch,
  nativeConflictFiles,
  nativeIsCurrentUnbornBranch,
  nativeLsFiles,
  nativeMergeAbort,
  nativeWorkingTreeStatus,
} from "./native-git-bridge.js";
import { resolveGitDir } from "./worktree-manager.js";

/**
 * Pop the stash entry created with `stashMarker` in its subject, resolving it
 * to a concrete `stash@{n}` ref first so a concurrent stash push cannot make
 * `git stash pop` grab the wrong entry.
 *
 * If `stashMarker` is null or no longer present in the stash list (e.g. a
 * concurrent process popped/dropped it), leaves the stash list untouched and
 * returns null.
 *
 * Throws on pop failure so callers can handle conflict cases the same way
 * they would with the prior `git stash pop` form. When throwing after a
 * targeted pop attempt, the error is annotated with the targeted stash ref.
 *
 * (Issue #4980 HIGH-6)
 */
export function popStashByRef(basePath: string, stashMarker: string | null): string | null {
  let popArg: string | null = null;
  if (stashMarker) {
    try {
      const list = execFileSync("git", ["stash", "list", "--format=%gd%x00%s"], {
        cwd: basePath,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
      }).trim().split("\n").filter(Boolean);
      for (const entry of list) {
        const [ref, subject] = entry.split("\0");
        if (ref && subject?.includes(stashMarker)) {
          popArg = ref;
          break;
        }
      }
    } catch (err) {
      logWarning("worktree", `stash list lookup failed; leaving stash untouched: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!popArg) {
    logWarning("worktree", "recorded stash entry could not be resolved; skipping automatic pop");
    return null;
  }
  try {
    execFileSync("git", ["stash", "pop", popArg], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    });
  } catch (err) {
    if (err && typeof err === "object") {
      (err as { stashRef?: string }).stashRef = popArg;
    }
    throw err;
  }
  return popArg;
}

/**
 * Extract a stash ref annotation injected by popStashByRef() when git stash
 * pop fails and we need to conditionally drop the exact stash entry later.
 */
export function stashRefFromError(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const stashRef = (err as { stashRef?: unknown }).stashRef;
  return typeof stashRef === "string" && stashRef.length > 0 ? stashRef : null;
}

export function stashAlreadyExistsFilesFromError(err: unknown): string[] {
  if (!err || typeof err !== "object") return [];
  const stderr = (err as { stderr?: unknown }).stderr;
  const stderrText = typeof stderr === "string"
    ? stderr
    : stderr instanceof Uint8Array
      ? Buffer.from(stderr).toString("utf-8")
      : "";
  const message = err instanceof Error ? err.message : String(err);
  const text = `${stderrText}\n${message}`;
  const files = new Set<string>();
  for (const line of text.split("\n")) {
    const m = line.match(/^(.*?)\s+already exists, no checkout\s*$/i);
    if (!m) continue;
    const filePath = m[1]?.trim();
    if (filePath) files.add(filePath);
  }
  return [...files];
}

/**
 * Detect whether an on-disk file still contains unresolved merge conflict
 * markers from a failed stash-pop or merge attempt.
 *
 * Returns false when the file cannot be read.
 */
export function hasConflictMarkers(filePath: string): boolean {
  try {
    const content = readFileSync(filePath, "utf-8");
    return content.includes("<<<<<<<") && content.includes("=======") && content.includes(">>>>>>>");
  } catch {
    return false;
  }
}

export function gsdJsonlFilesWithConflictMarkers(basePath: string): string[] {
  return nativeLsFiles(basePath, ".gsd/*.jsonl").filter((f) =>
    hasConflictMarkers(join(basePath, f)),
  );
}

export function removeMergeStateFiles(basePath: string, contextLabel: string): void {
  const files = ["SQUASH_MSG", "MERGE_MSG", "MERGE_MODE", "MERGE_HEAD", "AUTO_MERGE"];
  try {
    // One rev-parse for all names: git prints one line per --git-path argument.
    const rawPaths = execFileSync("git", ["rev-parse", ...files.flatMap((f) => ["--git-path", f])], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    }).trim().split(/\r?\n/);
    const resolved = rawPaths.length === files.length;
    let gitDir: string | undefined;
    for (const [i, f] of files.entries()) {
      const rawPath = resolved ? rawPaths[i]! : "";
      const p = rawPath.length > 0
        ? (isAbsolute(rawPath) ? rawPath : resolve(basePath, rawPath))
        : join((gitDir ??= resolveGitDir(basePath)), f);
      if (existsSync(p)) unlinkSync(p);
    }
  } catch (err) {
    logError("worktree", `${contextLabel} merge state cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function cleanupConflictState(basePath: string): void {
  // Merge conflicts can leave unmerged index entries; merge-abort alone is not
  // enough for squash merges (MERGE_HEAD is never written). Reset the merge
  // index, then remove merge message files that native/libgit2 paths may have
  // created.
  try {
    nativeMergeAbort(basePath);
  } catch (err) {
    // MERGE_HEAD absent (squash merge path) — abort is a no-op, which is fine.
    debugLog("conflict-cleanup:merge-abort-skipped", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    execFileSync("git", ["reset", "--merge"], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    });
  } catch (err) {
    logError("worktree", `git reset --merge failed after merge conflict: ${err instanceof Error ? err.message : String(err)}`);
  }
  removeMergeStateFiles(basePath, "conflict");
}

export function checkoutBranchWithStashGuard(
  basePath: string,
  branch: string,
  reason: string,
): void {
  if (nativeIsCurrentUnbornBranch(basePath, branch)) return;

  let stashMarker: string | null = null;
  let stashed = false;

  const status = nativeWorkingTreeStatus(basePath).trim();
  if (status.length > 0) {
    stashMarker = `gsd-checkout-stash:${reason}:${process.pid}:${Date.now()}:${process.hrtime.bigint().toString(36)}`;
    const stashListBefore = execFileSync("git", ["stash", "list"], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    });
    execFileSync(
      "git",
      ["stash", "push", "--include-untracked", "-m", `gsd: checkout stash [${stashMarker}]`],
      {
        cwd: basePath,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
      },
    );
    const stashListAfter = execFileSync("git", ["stash", "list"], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    });
    stashed = stashListAfter !== stashListBefore;
  }

  // Checkout and stash-restore are split so we can distinguish two failure
  // modes: (a) checkout failed → HEAD did not move, restore stash and rethrow;
  // (b) checkout succeeded but stash pop failed → HEAD moved to `branch` but
  // the working-tree changes remain in the stash list. We surface a distinct
  // error in case (b) so callers don't assume the branch switch was rolled back.
  try {
    nativeCheckoutBranch(basePath, branch);
  } catch (checkoutErr) {
    if (stashed) {
      try {
        popStashByRef(basePath, stashMarker);
      } catch (restoreErr) {
        logWarning("worktree", `git stash pop failed during checkout restore: ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}`);
      }
    }
    throw checkoutErr;
  }

  if (stashed) {
    try {
      popStashByRef(basePath, stashMarker);
    } catch (popErr) {
      const msg = popErr instanceof Error ? popErr.message : String(popErr);
      const stderr = popErr && typeof popErr === "object"
        ? (popErr as { stderr?: unknown }).stderr
        : undefined;
      const stderrText = typeof stderr === "string"
        ? stderr
        : stderr instanceof Uint8Array
          ? Buffer.from(stderr).toString("utf-8")
          : "";
      const stashPopMessage = `${stderrText}\n${msg}`.trim();
      const alreadyExists = stashAlreadyExistsFilesFromError(popErr);
      const isUntrackedRestoreFailure = stashPopMessage.includes("could not restore untracked files from stash");
      const stashRefForDrop = stashRefFromError(popErr);
      const allConflictFiles = nativeConflictFiles(basePath);
      const nonGsdUnmerged = allConflictFiles.filter((f) => !f.startsWith(".gsd/"));
      const gsdUnmerged = allConflictFiles.filter((f) => f.startsWith(".gsd/"));
      const gsdContentConflicts = isUntrackedRestoreFailure
        ? gsdJsonlFilesWithConflictMarkers(basePath)
        : [];
      // Resolve ALL untracked-collision files by accepting HEAD — files in
      // alreadyExists were untracked on the source branch by definition of the
      // "already exists, no checkout" failure, so target HEAD is authoritative.
      // gsdUnmerged: .gsd/ index conflicts left by the partial stash pop are
      // also resolved via HEAD — .gsd/ runtime state is always authoritative
      // on the target branch, so accepting HEAD is safe here too.
      const resolvable = [...new Set([...alreadyExists, ...gsdContentConflicts, ...gsdUnmerged])];

      if (
        isUntrackedRestoreFailure &&
        resolvable.length > 0 &&
        nonGsdUnmerged.length === 0
      ) {
        for (const f of resolvable) {
          execFileSync("git", ["checkout", "HEAD", "--", f], {
            cwd: basePath,
            stdio: ["ignore", "pipe", "pipe"],
            encoding: "utf-8",
          });
          nativeAddPaths(basePath, [f]);
        }

        if (stashRefForDrop) {
          try {
            execFileSync("git", ["stash", "drop", stashRefForDrop], {
              cwd: basePath,
              stdio: ["ignore", "pipe", "pipe"],
              encoding: "utf-8",
            });
          } catch (err) { /* stash may already be consumed */
            logWarning("worktree", `git stash drop failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          logWarning("worktree", "recorded stash entry could not be resolved; skipping automatic drop");
        }
        return;
      }

      const wrapped = new Error(
        `checkout to '${branch}' succeeded but stash restore failed; working tree changes remain in the stash list. Original error: ${msg}`,
      );
      if (stashRefForDrop) (wrapped as { stashRef?: string }).stashRef = stashRefForDrop;
      throw wrapped;
    }
  }
}
