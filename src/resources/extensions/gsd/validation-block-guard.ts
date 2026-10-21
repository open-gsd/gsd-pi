// Project/App: gsd-pi
// File Purpose: Shared command gate for validation-blocked milestones.

import { existsSync } from "node:fs";

import { isInAutoWorktree } from "./auto-worktree-entry.js";
import { getAutoWorktreePath } from "./auto-worktree-path-resolution.js";
import { ensureDbOpen } from "./bootstrap/dynamic-tools.js";
import { refreshWorkflowDatabaseFromDisk } from "./db-workspace.js";
import { getIsolationMode } from "./preferences.js";
import { deriveState, invalidateStateCache } from "./state.js";
import type { GSDState } from "./types.js";
import { detectWorktreeName } from "./worktree.js";

const VALIDATION_BLOCK_RE =
  /milestone validation returned needs-(?:attention|remediation)|validation verdict is needs-(?:attention|remediation)/i;

const VALIDATION_SAFE_DISPATCH_COMMANDS = new Set([
  "reassess",
  "reassess-roadmap",
  "uat",
  "run-uat",
  "validate",
  "validate-milestone",
]);

const VALIDATION_BLOCKED_COMMANDS = new Set([
  "auto",
  "next",
  "start",
  "ship",
  "complete-milestone",
  "do",
  "discuss-phase",
  "import",
  "ingest-docs",
  "review-backlog",
  "docs-update",
  "secure-phase",
  "plan-phase",
  "execute-phase",
  "spec-phase",
  "mvp-phase",
  "ui-phase",
  "ai-integration-phase",
  "ultraplan-phase",
  "plan-review-convergence",
  "autonomous",
  "resume-work",
  "discuss-phase",
  "import",
  "ingest-docs",
  "review-backlog",
  "secure-phase",
]);

const VALIDATION_BLOCKED_PARALLEL_SUBCOMMANDS = new Set([
  "",
  "start",
  "resume",
  "merge",
]);

const VALIDATION_SAFE_WORKFLOW_SUBCOMMANDS = new Set([
  "",
  "new",
  "list",
  "validate",
  "pause",
  "info",
  "install",
  "uninstall",
]);

function hasFlag(command: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)${escaped}(?=\\s|$)`).test(command);
}

function isMutatingPhaseCommand(subcommand: string | undefined): boolean {
  if (!subcommand) return false;
  return ["add", "create", "new", "insert", "remove", "edit"].includes(subcommand);
}

export function isValidationBlockedState(state: GSDState): boolean {
  if (state.phase !== "blocked") return false;
  return state.blockers.some((blocker) => VALIDATION_BLOCK_RE.test(blocker));
}

export function isValidationBlockAllowedCommand(trimmed: string): boolean {
  const command = trimmed.trim();
  if (!command) return false;

  const [name, subcommand] = command.split(/\s+/, 2);
  // Inspecting/clearing a Blocker is not validation acceptance or new work.
  // Do not bootstrap a database before that handler's read-only review/consent.
  if (name === "blocker") return true;
  if (name === "dispatch") {
    return VALIDATION_SAFE_DISPATCH_COMMANDS.has(subcommand ?? "");
  }
  if (name === "parallel") {
    return !VALIDATION_BLOCKED_PARALLEL_SUBCOMMANDS.has(subcommand ?? "");
  }
  if (name === "workflow") {
    return VALIDATION_SAFE_WORKFLOW_SUBCOMMANDS.has(subcommand ?? "");
  }
  if (name === "audit-fix") {
    return hasFlag(command, "--dry-run");
  }
  if (name === "code-review") {
    return !hasFlag(command, "--fix");
  }
  if (name === "docs-update") {
    return hasFlag(command, "--verify-only");
  }
  if (name === "phase") {
    return !isMutatingPhaseCommand(subcommand);
  }
  if (name === "progress") {
    return !hasFlag(command, "--next") && !hasFlag(command, "--do");
  }
  return !VALIDATION_BLOCKED_COMMANDS.has(name);
}

export function formatValidationBlockedMessage(
  state: GSDState,
  attemptedCommand = "",
): string | null {
  if (!isValidationBlockedState(state)) return null;

  const commandLabel = attemptedCommand.trim()
    ? `/gsd ${attemptedCommand.trim()}`
    : "/gsd";
  const blockers = state.blockers.filter((blocker) => blocker.trim().length > 0);

  return [
    `${commandLabel} cannot run because the active milestone is blocked by validation.`,
    ...blockers,
  ].join("\n\n");
}

async function deriveValidationBlockState(base: string): Promise<GSDState> {
  let state = await deriveState(base);

  if (
    state.activeMilestone &&
    getIsolationMode(base) === "worktree" &&
    !detectWorktreeName(base) &&
    !isInAutoWorktree(base)
  ) {
    const wtPath = getAutoWorktreePath(base, state.activeMilestone.id);
    if (wtPath && existsSync(wtPath)) {
      state = await deriveState(wtPath);
    }
  }

  return state;
}

export async function getValidationBlockMessageForBase(
  base: string,
  attemptedCommand = "",
): Promise<string | null> {
  await ensureDbOpen(base);
  refreshWorkflowDatabaseFromDisk();
  invalidateStateCache();
  const state = await deriveValidationBlockState(base);
  return formatValidationBlockedMessage(state, attemptedCommand);
}
