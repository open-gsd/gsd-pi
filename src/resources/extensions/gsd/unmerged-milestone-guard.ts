// Project/App: gsd-pi
// File Purpose: Block new workflow entry when completed milestone branches are still unmerged.

import { execFileSync } from "node:child_process";

import {
  nativeBranchExists,
  nativeDetectMainBranch,
  nativeDiffNumstat,
  nativeIsAncestor,
} from "./native-git-bridge.js";
import { autoWorktreeBranch } from "./auto-worktree-branch-lifecycle.js";
import { ensureDbOpen } from "./bootstrap/dynamic-tools.js";
import { getAllMilestones } from "./gsd-db.js";
import { resolveMilestoneIntegrationBranch, VALID_BRANCH_NAME } from "./git-service.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import { isClosedStatus } from "./status-guards.js";

export interface UnmergedMilestoneDirtyEntry {
  path: string;
  status: string;
}

export interface UnmergedMilestoneBlocker {
  milestoneId: string;
  branch: string;
  integrationBranch: string;
  files: string[];
  dirtyOverlap: UnmergedMilestoneDirtyEntry[];
}

type UnmergedMilestoneDirtySnapshot = Map<string, UnmergedMilestoneDirtyEntry>;

const BLOCKED_COMMANDS = new Set([
  "auto",
  "next",
  "start",
  "workflow",
  "new-milestone",
  "new-project",
  "do",
  "discuss-phase",
  "plan-phase",
  "execute-phase",
  "spec-phase",
  "mvp-phase",
  "ui-phase",
  "ai-integration-phase",
  "ultraplan-phase",
  "validate-phase",
  "docs-update",
  "review-backlog",
  "import",
  "ingest-docs",
  "secure-phase",
  "plan-review-convergence",
  "autonomous",
  "resume-work",
  "execute-task",
  "research-milestone",
  "plan-slice",
  "plan-milestone",
  "research-slice",
  "complete-slice",
  "validate-milestone",
  "complete-milestone",
]);

const UNMERGED_SAFE_PARALLEL_SUBCOMMANDS = new Set([
  "status",
  "watch",
]);

function isRuntimePath(path: string): boolean {
  return path === ".gsd" || path.startsWith(".gsd/");
}

function captureDirtyPathStatusSnapshot(rootPath: string): UnmergedMilestoneDirtySnapshot {
  const snapshot: UnmergedMilestoneDirtySnapshot = new Map();
  let status = "";
  try {
    status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: rootPath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    });
  } catch {
    return snapshot;
  }

  for (const line of status.split("\n")) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    const path = line.slice(3).replace(/^"|"$/g, "");
    if (!path || isRuntimePath(path)) continue;
    snapshot.set(path, {
      path,
      status: code.trim() || code,
    });
  }
  return snapshot;
}

function formatCommandLabel(attemptedCommand: string): string {
  const trimmed = attemptedCommand.trim();
  return trimmed ? `/gsd ${trimmed}` : "/gsd";
}

function hasFlag(command: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)${escaped}(?=\\s|$)`).test(command);
}

function isMutatingPhaseCommand(subcommand: string | undefined): boolean {
  if (!subcommand) return false;
  return ["add", "create", "new", "insert", "remove", "edit"].includes(subcommand);
}

function resolveIntegrationBranch(base: string, milestoneId: string): string | null {
  const prefs = loadEffectiveGSDPreferences(base)?.preferences?.git ?? {};
  const resolution = resolveMilestoneIntegrationBranch(base, milestoneId, prefs);
  if (resolution.effectiveBranch && nativeBranchExists(base, resolution.effectiveBranch)) {
    return resolution.effectiveBranch;
  }
  if (prefs.main_branch && VALID_BRANCH_NAME.test(prefs.main_branch) && nativeBranchExists(base, prefs.main_branch)) {
    return prefs.main_branch;
  }

  try {
    const detected = nativeDetectMainBranch(base);
    if (detected && nativeBranchExists(base, detected)) return detected;
  } catch {
    // No reliable integration branch; leave this milestone unclassified.
  }

  return null;
}

export function isUnmergedMilestoneAllowedCommand(trimmed: string): boolean {
  const command = trimmed.trim();
  if (!command) return false;

  const [name, subcommand] = command.split(/\s+/, 2);
  if (name === "dispatch") {
    return subcommand === "complete" || subcommand === "complete-milestone";
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
  if (name === "parallel") {
    return UNMERGED_SAFE_PARALLEL_SUBCOMMANDS.has(subcommand ?? "");
  }
  if (name === "phase") {
    return !isMutatingPhaseCommand(subcommand);
  }
  if (name === "progress") {
    return !hasFlag(command, "--next") && !hasFlag(command, "--do");
  }
  return !BLOCKED_COMMANDS.has(name);
}

export async function findUnmergedCompletedMilestones(base: string): Promise<UnmergedMilestoneBlocker[]> {
  await ensureDbOpen(base);

  const blockers: UnmergedMilestoneBlocker[] = [];
  let dirtyByPath: UnmergedMilestoneDirtySnapshot | null = null;

  for (const milestone of getAllMilestones()) {
    if (!isClosedStatus(milestone.status)) continue;

    const branch = autoWorktreeBranch(milestone.id);
    if (!nativeBranchExists(base, branch)) continue;

    const integrationBranch = resolveIntegrationBranch(base, milestone.id);
    if (!integrationBranch || integrationBranch === branch) continue;

    // The milestone is merged when its branch tip is reachable from the
    // integration branch tip — true for fast-forward, --no-ff, and squash
    // merges alike. A raw diff is the wrong predicate: a --no-ff merge that
    // took main's side for some conflicts leaves the branch tip differing from
    // main, which the diff check would misread as "unmerged" (#825). The diff
    // below remains the correct fallback only when the branch is NOT yet an
    // ancestor — i.e. the merge is genuinely still pending.
    if (nativeIsAncestor(base, branch, integrationBranch)) continue;

    const files = nativeDiffNumstat(base, integrationBranch, branch)
      .map((entry) => entry.path)
      .filter((path) => path && !isRuntimePath(path));
    const uniqueFiles = [...new Set(files)].sort();
    if (uniqueFiles.length === 0) continue;

    if (!dirtyByPath) dirtyByPath = captureDirtyPathStatusSnapshot(base);
    const dirtySnapshot = dirtyByPath;
    blockers.push({
      milestoneId: milestone.id,
      branch,
      integrationBranch,
      files: uniqueFiles,
      dirtyOverlap: uniqueFiles
        .map((path) => dirtySnapshot.get(path))
        .filter((entry): entry is UnmergedMilestoneDirtyEntry => Boolean(entry)),
    });
  }

  return blockers;
}

export function formatUnmergedMilestoneBlockMessage(
  blocker: UnmergedMilestoneBlocker,
  attemptedCommand = "",
): string {
  const commandLabel = formatCommandLabel(attemptedCommand);
  const fileList = blocker.files.map((path) => `  - ${path}`).join("\n");
  const dirtyOverlap = blocker.dirtyOverlap.length > 0
    ? [
        "",
        "Project-root dirty files overlap that milestone branch:",
        ...blocker.dirtyOverlap.map((entry) => `  ${entry.status.padEnd(2)} ${entry.path}`),
      ]
    : [];

  return [
    `${commandLabel} cannot start new workflow work because ${blocker.milestoneId} is complete but not merged.`,
    "",
    `Branch: ${blocker.branch}`,
    `Target: ${blocker.integrationBranch}`,
    "Unmerged product files:",
    fileList,
    ...dirtyOverlap,
    "",
    "Fix:",
    blocker.dirtyOverlap.length > 0
      ? "  1. Commit, stash, or discard the overlapping project-root files."
      : "  1. Review the unmerged milestone branch.",
    `  2. Run /gsd dispatch complete-milestone ${blocker.milestoneId} to complete the preserved milestone merge.`,
    `  3. After ${blocker.milestoneId} is merged, run /gsd again.`,
  ].join("\n");
}

export async function getUnmergedMilestoneBlockMessageForBase(
  base: string,
  attemptedCommand = "",
): Promise<string | null> {
  const blockers = await findUnmergedCompletedMilestones(base);
  if (blockers.length === 0) return null;
  return formatUnmergedMilestoneBlockMessage(blockers[0], attemptedCommand);
}
