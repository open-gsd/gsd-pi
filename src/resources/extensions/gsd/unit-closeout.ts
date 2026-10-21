// Project/App: gsd-pi
// File Purpose: Unit Closeout module — durable completion pipeline behind one seam (ADR-032).
//
// `closeUnit` owns what makes a Unit's completion durable. This pass ships the
// **Interactive Closeout adapter** path: commit the work and compute the
// Closeout Git Verdict, failing closed (loudly) instead of silently when a
// non-`none` `git.isolation` preference was never honoured by the session.
// Motivating failure (2026-06-10): an interactive session under
// `git.isolation: worktree` completed a milestone with every source file
// untracked on the integration branch — no commit, no merge, no warning.
//
// The interactive adapter only fires on milestone boundaries — the durability
// gap is the milestone close, and committing at every task/slice would sweep a
// developer's unrelated working-tree changes. `closeUnit` itself stays general
// over all boundaries for the pending Auto Closeout adapter re-seat.
//
// The auto loop keeps its existing closeout pipeline for now (the Auto
// Closeout adapter re-seat is the documented next step in ADR-032); the
// interactive trigger in bootstrap/register-hooks.ts is a no-op while
// `isAutoActive()`, so auto-mode behaviour is untouched.
//
// Re-entrancy is naturally safe: a re-fired completion commits an already-clean
// tree, which yields `nothing-to-commit`, and `appendNotification` carries its
// own dedup window — so `closeUnit` keeps no result cache of its own.

import { appendNotification, type NotifySeverity } from "./notification-store.js";
import { isInAutoWorktree } from "./auto-worktree-entry.js";
import { readStringField } from "./auto-unit-tool-scope.js";
import { MILESTONE_BRANCH_PREFIX } from "./branch-patterns.js";
import { hasPendingCloseoutEffect } from "./milestone-closeout-effects.js";
import { nativeGetCurrentBranch } from "./native-git-bridge.js";
import { getIsolationMode, loadEffectiveGSDPreferences } from "./preferences.js";
import { pushIntegrationBranchIfAhead } from "./publication.js";
import { autoCommitCurrentBranch, getCurrentBranch } from "./worktree.js";
import { logWarning } from "./workflow-logger.js";

export type CloseoutBoundary = "task" | "slice" | "milestone";
export type CloseoutOutcome = "complete" | "failed" | "skipped";

/**
 * What git state the closeout found and did.
 *
 * - `committed`           — work committed on the current branch (expected under
 *                           `isolation: none`, and for task/slice boundaries).
 * - `nothing-to-commit`   — working tree was already clean.
 * - `milestone-branch`    — milestone boundary closed on a `milestone/<MID>`
 *                           branch; the merge stays owned by worktree tooling.
 * - `isolation-bypassed`  — milestone boundary closed outside a milestone
 *                           worktree/branch while `git.isolation` is
 *                           `worktree`/`branch`: committed where the work sits
 *                           and surfaced a Needs Attention notice instead of
 *                           completing silently.
 * - `commit-failed`       — the commit attempt threw; surfaced, never thrown.
 */
export type CloseoutGitVerdict =
  | "committed"
  | "nothing-to-commit"
  | "milestone-branch"
  | "isolation-bypassed"
  | "commit-failed";

export interface UnitCloseoutRequest {
  basePath: string;
  unitType: string;
  /** "M001" | "M001/S01" | "M001/S01/T01" */
  unitId: string;
  boundary: CloseoutBoundary;
  outcome: CloseoutOutcome;
}

export interface UnitCloseoutResult {
  gitVerdict: CloseoutGitVerdict;
  commitMessage: string | null;
  /** The user-facing Needs Attention / status notice, when one was emitted. */
  notice?: string;
}

/** Seam for tests; production callers use the defaults. */
export interface UnitCloseoutDeps {
  isolationMode(basePath: string): "none" | "worktree" | "branch";
  currentBranch(basePath: string): string | null;
  commit(basePath: string, unitType: string, unitId: string): string | null;
  notify(message: string, severity: NotifySeverity): void;
  /**
   * The solo-mode auto-push honor point (#2874). Only called for the
   * milestone boundary under `isolation: none` — production resolves to the
   * Publication module's push-if-ahead.
   */
  pushIfAhead?(basePath: string, milestoneId: string): void;
}

/**
 * The default honor point: with `git.isolation: none` the milestone work
 * lands directly on the integration branch and no merge/publication step
 * ever runs, so the closeout commit is the one point where `git.auto_push`
 * can still honor its documented "push after committing" contract.
 * Delegates to the Publication module's push-if-ahead (the #2153 closeout
 * path): a plain, never-forced `git push <remote> <branch>` of the
 * integration branch only when it is ahead of its upstream, journal-logged.
 */
function pushIfAheadAtCloseout(basePath: string, milestoneId: string): void {
  // A surviving milestone worktree must not be published by a solo push even
  // when the preferences now say isolation none — its branch belongs to the
  // worktree merge flow (same guard as milestoneCloseoutEffects).
  if (isInAutoWorktree(basePath)) return;
  const git = loadEffectiveGSDPreferences(basePath)?.preferences?.git ?? {};
  try {
    pushIntegrationBranchIfAhead({
      basePath,
      branch: getCurrentBranch(basePath),
      milestoneId,
      prefs: {
        autoPush: git.auto_push === true,
        autoPr: git.auto_pr === true,
        remote: typeof git.remote === "string" ? git.remote : undefined,
      },
    });
  } catch (err) {
    // The closeout already committed; a push problem must not fail it.
    logWarning("engine", `auto_push at milestone closeout failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const defaultDeps: UnitCloseoutDeps = {
  isolationMode: (basePath) => getIsolationMode(basePath),
  currentBranch: (basePath) => {
    try {
      return nativeGetCurrentBranch(basePath);
    } catch {
      return null;
    }
  },
  commit: (basePath, unitType, unitId) => autoCommitCurrentBranch(basePath, unitType, unitId),
  notify: (message, severity) => appendNotification(message, severity),
  pushIfAhead: pushIfAheadAtCloseout,
};

export function closeUnit(request: UnitCloseoutRequest, deps: UnitCloseoutDeps = defaultDeps): UnitCloseoutResult {
  let commitMessage: string | null = null;
  let gitVerdict: CloseoutGitVerdict;
  let notice: string | undefined;

  try {
    commitMessage = deps.commit(request.basePath, request.unitType, request.unitId);
    gitVerdict = commitMessage === null ? "nothing-to-commit" : "committed";
  } catch (err) {
    gitVerdict = "commit-failed";
    notice = `Unit closeout commit failed for ${request.unitId}: ${err instanceof Error ? err.message : String(err)}`;
    logWarning("engine", notice);
    deps.notify(notice, "error");
  }

  if (request.boundary === "milestone" && gitVerdict !== "commit-failed") {
    const isolation = deps.isolationMode(request.basePath);
    if (isolation !== "none") {
      const branch = deps.currentBranch(request.basePath);
      if (branch?.startsWith(MILESTONE_BRANCH_PREFIX)) {
        gitVerdict = "milestone-branch";
        // A prepared Closeout Plan keeps the milestone open until the system
        // merge records its receipt; a manual merge would leave it open.
        notice = hasPendingCloseoutEffect(request.unitId)
          ? `Milestone ${request.unitId} closeout is prepared on ${branch}. ` +
            `It completes when the branch is merged: run /gsd dispatch complete-milestone ${request.unitId}.`
          : `Milestone ${request.unitId} completed on ${branch}. ` +
            `Merge it to the integration branch with the worktree tooling (/gsd worktree merge).`;
        deps.notify(notice, "info");
      } else {
        gitVerdict = "isolation-bypassed";
        notice =
          `Needs attention: milestone ${request.unitId} completed outside a milestone worktree/branch ` +
          `while git.isolation is "${isolation}" — the isolation preference was not honoured this session. ` +
          (commitMessage
            ? `Work was committed directly on "${branch ?? "the current branch"}".`
            : `The working tree had nothing left to commit on "${branch ?? "the current branch"}".`);
        logWarning("engine", notice);
        deps.notify(notice, "warning");
      }
    } else {
      // #2874: solo mode has no merge or publication step, so this commit is
      // the one point auto_push can still honor. Non-fatal, journal-logged;
      // worktree/branch flows keep owning publication.
      (deps.pushIfAhead ?? pushIfAheadAtCloseout)(request.basePath, request.unitId);
    }
  }

  return { gitVerdict, commitMessage, notice };
}

// ─── Interactive Closeout adapter (tool-observation trigger) ─────────────

// Canonical closeout tool → boundary. Aliases are canonicalized by the hook.
// Only the milestone boundary is wired interactively: it is the durability gap
// that motivated ADR-032, and committing at every task/slice would sweep a
// developer's unrelated working-tree changes. `closeUnit` still handles every
// boundary for the pending Auto Closeout adapter re-seat.
const CLOSEOUT_TOOL_BOUNDARIES: Record<string, CloseoutBoundary> = {
  gsd_complete_milestone: "milestone",
};

// Commit attribution uses the canonical unit types so interactive closeout
// commits carry the same GSD-Unit evidence trailers the verification prompts
// look for.
const BOUNDARY_UNIT_TYPES: Record<CloseoutBoundary, string> = {
  task: "execute-task",
  slice: "complete-slice",
  milestone: "complete-milestone",
};

export function isUnitCloseoutTool(canonicalToolName: string): boolean {
  return canonicalToolName in CLOSEOUT_TOOL_BOUNDARIES;
}

function readId(input: unknown, camel: string, snake: string): string | undefined {
  const value = readStringField(input, camel, snake);
  return value && value.length > 0 ? value : undefined;
}

/**
 * Interactive Closeout adapter entry, called from the host's tool-observation
 * hook for successful closeout tool calls when auto-mode is NOT active.
 * Returns null when the tool input doesn't identify a unit.
 */
export function runInteractiveUnitCloseout(
  args: { basePath: string; canonicalToolName: string; input: unknown },
  deps: UnitCloseoutDeps = defaultDeps,
): UnitCloseoutResult | null {
  const boundary = CLOSEOUT_TOOL_BOUNDARIES[args.canonicalToolName];
  if (!boundary) return null;

  const milestoneId = readId(args.input, "milestoneId", "milestone_id");
  if (!milestoneId) return null;
  const sliceId = readId(args.input, "sliceId", "slice_id");
  const taskId = readId(args.input, "taskId", "task_id");

  let unitId = milestoneId;
  if (boundary !== "milestone") {
    if (!sliceId) return null;
    unitId = boundary === "slice" ? `${milestoneId}/${sliceId}` : `${milestoneId}/${sliceId}/${taskId ?? ""}`;
    if (boundary === "task" && !taskId) return null;
  }

  return closeUnit(
    {
      basePath: args.basePath,
      unitType: BOUNDARY_UNIT_TYPES[boundary],
      unitId,
      boundary,
      outcome: "complete",
    },
    deps,
  );
}
