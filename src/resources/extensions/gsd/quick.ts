/**
 * GSD Quick Mode — /gsd quick <task>
 * Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>
 *
 * Lightweight task execution with GSD guarantees (atomic commits, state
 * tracking) but without the full milestone/slice ceremony.
 *
 * Quick tasks live in `.gsd/quick/` and are tracked in STATE.md's
 * "Quick Tasks Completed" table.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { QUICK_BRANCH_RE } from "./branch-patterns.js";
import { loadPrompt } from "./prompt-loader.js";
import { gsdRoot } from "./paths.js";
import { GitServiceImpl, runGit, taskBranchArgs } from "./git-service.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import { nativeBranchExists, nativeDetectMainBranch, nativeDiffNumstat } from "./native-git-bridge.js";
import { nativeHasStagedChanges } from "./native-git-bridge.js";
import { resolveUokFlags } from "./uok/flags.js";

interface QuickReturnState {
  basePath: string;
  originalBranch: string;
  quickBranch: string;
  taskNum: number;
  slug: string;
  description: string;
}

export interface QuickOptions {
  description: string;
  discuss: boolean;
  research: boolean;
  validate: boolean;
  full: boolean;
}

const QUICK_FLAG_RE = /(^|\s)--(discuss|research|validate|full)(?=\s|$)/g;

/** Parse composable right-sizing flags without including them in the task description. */
export function parseQuickArgs(raw: string): QuickOptions {
  const explicitFull = /(^|\s)--full(?=\s|$)/.test(raw);
  const discuss = explicitFull || /(^|\s)--discuss(?=\s|$)/.test(raw);
  const research = explicitFull || /(^|\s)--research(?=\s|$)/.test(raw);
  const validate = explicitFull || /(^|\s)--validate(?=\s|$)/.test(raw);
  const description = raw.replace(QUICK_FLAG_RE, " ").replace(/\s+/g, " ").trim();

  return {
    description,
    discuss,
    research,
    validate,
    full: explicitFull || (discuss && research && validate),
  };
}

/** Build the optional pipeline instructions injected into the quick-task prompt. */
export function buildQuickQualityInstructions(
  options: QuickOptions,
  taskDir: string,
  taskNum: number,
): string {
  if (!options.discuss && !options.research && !options.validate) return "";

  const planPath = `${taskDir}/${taskNum}-PLAN.md`;
  const lines = [
    "## Right-sized quality pipeline",
    "",
    "Complete the enabled pre-execution stages before editing, then complete any post-execution stage before writing the summary.",
  ];

  if (options.discuss) {
    lines.push(
      "",
      "### Discussion",
      "Before planning, identify material ambiguities or design choices. Ask focused questions and wait for the user's answers when a choice could change the outcome; otherwise state the assumptions you will use.",
    );
  }

  if (options.research) {
    lines.push(
      "",
      "### Research",
      `Before planning, use a scout subagent to investigate relevant code, implementation approaches, and pitfalls. Summarize the findings and chosen approach in \`${taskDir}/${taskNum}-RESEARCH.md\`.`,
    );
  }

  lines.push(
    "",
    "### Plan",
    `Write a concise implementation plan with verification steps to \`${planPath}\` before editing.`,
  );

  if (options.validate) {
    lines.push(
      "Use a reviewer subagent to check that plan for correctness, completeness, scope, and test coverage. Address its findings before execution.",
      "",
      "### Post-execution verification",
      "After implementation, use a tester or reviewer subagent to verify the finished work independently. Fix any findings and rerun the relevant checks before writing the quick-task summary.",
    );
  }

  return lines.join("\n");
}

let pendingQuickReturn: QuickReturnState | null = null;
const pendingQuickReturnMisses = new Map<string, string>();

// ─── Quick Task Helpers ───────────────────────────────────────────────────────

/**
 * Generate a URL-friendly slug from a description.
 * Lowercase, hyphens, max 40 chars.
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
    .replace(/-$/, "");
}

/**
 * Determine the next quick task number by scanning existing directories.
 */
function getNextTaskNum(quickDir: string): number {
  if (!existsSync(quickDir)) return 1;
  try {
    const entries = readdirSync(quickDir, { withFileTypes: true });
    let max = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const match = entry.name.match(/^(\d+)-/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > max) max = num;
      }
    }
    return max + 1;
  } catch {
    return 1;
  }
}

/**
 * Ensure the quick task directory structure exists.
 * Returns the task directory path.
 */
function ensureQuickDir(basePath: string, taskNum: number, slug: string): string {
  const quickDir = join(gsdRoot(basePath), "quick");
  const taskDir = join(quickDir, `${taskNum}-${slug}`);
  mkdirSync(taskDir, { recursive: true });
  return taskDir;
}

function isRuntimePath(path: string): boolean {
  return path === ".gsd" || path.startsWith(".gsd/");
}

export function parseQuickBranchName(branch: string): { taskNum: number; slug: string } | null {
  if (!QUICK_BRANCH_RE.test(branch)) return null;
  const rest = branch.slice("gsd/quick/".length);
  const match = rest.match(/^(\d+)-(.+)$/);
  if (!match) return null;
  return { taskNum: Number.parseInt(match[1], 10), slug: match[2] };
}

function resolveQuickReturnTargetBranch(basePath: string): string | null {
  try {
    const detected = nativeDetectMainBranch(basePath);
    if (detected && nativeBranchExists(basePath, detected)) return detected;
  } catch {
    // Fall through to conventional branch names.
  }
  for (const candidate of ["main", "master"]) {
    if (nativeBranchExists(basePath, candidate)) return candidate;
  }
  return null;
}

function quickBranchHasProductDiff(basePath: string, originalBranch: string, quickBranch: string): boolean {
  return nativeDiffNumstat(basePath, originalBranch, quickBranch)
    .map((entry) => entry.path)
    .some((path) => path && !isRuntimePath(path));
}

export function inferQuickReturnFromBranch(basePath: string): QuickReturnState | null {
  try {
    const gitPrefs = loadEffectiveGSDPreferences(basePath)?.preferences?.git ?? {};
    const git = new GitServiceImpl(basePath, gitPrefs);
    const quickBranch = git.getCurrentBranch();
    const parsed = parseQuickBranchName(quickBranch);
    if (!parsed) return null;

    const originalBranch = resolveQuickReturnTargetBranch(basePath);
    if (!originalBranch || originalBranch === quickBranch) return null;
    if (!quickBranchHasProductDiff(basePath, originalBranch, quickBranch)) return null;

    return {
      basePath,
      originalBranch,
      quickBranch,
      taskNum: parsed.taskNum,
      slug: parsed.slug,
      description: parsed.slug.replace(/-/g, " "),
    };
  } catch {
    return null;
  }
}

export interface StrandedQuickBranch {
  quickBranch: string;
  originalBranch: string;
  taskNum: number;
  slug: string;
}

export function detectStrandedQuickBranch(basePath: string): StrandedQuickBranch | null {
  if (existsSync(quickReturnStatePath(basePath))) return null;
  const inferred = inferQuickReturnFromBranch(basePath);
  if (!inferred) return null;
  return {
    quickBranch: inferred.quickBranch,
    originalBranch: inferred.originalBranch,
    taskNum: inferred.taskNum,
    slug: inferred.slug,
  };
}

function isPathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function isExternalGsdRoot(basePath: string, root: string): boolean {
  try {
    return !isPathInside(realpathSync(basePath), realpathSync(root));
  } catch {
    return !isPathInside(basePath, root);
  }
}

export function buildQuickCommitInstruction(basePath: string, root: string): string {
  const externalState = isExternalGsdRoot(basePath, root);
  if (externalState) {
    return [
      "Commit repo changes atomically, but do not stage or commit `.gsd/quick/...`:",
      "   - `.gsd/` resolves outside this git repository, so Git cannot stage quick-task summary files from the project repo.",
      "   - Write the quick summary file directly at the requested path; that file is persisted by GSD external state.",
      "   - Stage and commit only implementation/test/docs files that live inside the repository.",
      "   - If the task only writes quick-task research/summary files and no repository files changed, do not run `git commit`; report that there was nothing in the project repo to commit.",
    ].join("\n");
  }

  return [
    "Commit your changes atomically:",
    "   - Use conventional commit messages (feat:, fix:, refactor:, etc.)",
    "   - Stage only relevant files — never commit secrets or runtime files.",
    "   - Commit logical units separately if the task involves distinct changes.",
    "   - Quick tasks run outside the auto-mode lifecycle — there is no system auto-commit, so commit directly here.",
  ].join("\n");
}

function readHeadBranchName(basePath: string): string | null {
  try {
    const gitPath = join(basePath, ".git");
    if (!existsSync(gitPath)) return null;

    let headPath: string;
    if (lstatSync(gitPath).isDirectory()) {
      headPath = join(gitPath, "HEAD");
    } else {
      const gitFile = readFileSync(gitPath, "utf-8").trim();
      if (!gitFile.startsWith("gitdir: ")) return null;
      headPath = join(resolve(basePath, gitFile.slice("gitdir: ".length)), "HEAD");
    }

    const head = readFileSync(headPath, "utf-8").trim();
    if (!head.startsWith("ref: refs/heads/")) return null;
    return head.slice("ref: refs/heads/".length);
  } catch {
    return null;
  }
}

function quickReturnStatePath(basePath: string): string {
  return join(gsdRoot(basePath), "runtime", "quick-return.json");
}

function persistPendingReturn(state: QuickReturnState): void {
  pendingQuickReturn = state;
  pendingQuickReturnMisses.delete(state.basePath);
  mkdirSync(join(gsdRoot(state.basePath), "runtime"), { recursive: true });
  writeFileSync(quickReturnStatePath(state.basePath), JSON.stringify(state) + "\n", "utf-8");
}

function readPendingReturn(basePath: string): QuickReturnState | null {
  if (pendingQuickReturn && pendingQuickReturn.basePath === basePath) {
    return pendingQuickReturn;
  }
  if (pendingQuickReturnMisses.has(basePath)) {
    const statePath = quickReturnStatePath(basePath);
    if (!existsSync(statePath) && readHeadBranchName(basePath) === pendingQuickReturnMisses.get(basePath)) {
      return null;
    }
    pendingQuickReturnMisses.delete(basePath);
  }

  try {
    const raw = readFileSync(quickReturnStatePath(basePath), "utf-8");
    const parsed = JSON.parse(raw) as Partial<QuickReturnState>;
    if (
      typeof parsed.basePath === "string"
      && typeof parsed.originalBranch === "string"
      && typeof parsed.quickBranch === "string"
      && typeof parsed.taskNum === "number"
      && typeof parsed.slug === "string"
      && typeof parsed.description === "string"
    ) {
      pendingQuickReturn = parsed as QuickReturnState;
      pendingQuickReturnMisses.delete(basePath);
      return pendingQuickReturn;
    }
  } catch {
    // No persisted quick-return state
  }

  const inferred = inferQuickReturnFromBranch(basePath);
  if (inferred) {
    pendingQuickReturn = inferred;
    pendingQuickReturnMisses.delete(basePath);
    return inferred;
  }

  const branchAtMiss = readHeadBranchName(basePath);
  if (branchAtMiss) {
    pendingQuickReturnMisses.set(basePath, branchAtMiss);
  }
  return null;
}

function clearPendingReturn(basePath: string): void {
  if (pendingQuickReturn?.basePath === basePath) {
    pendingQuickReturn = null;
  }
  const branchAtMiss = readHeadBranchName(basePath);
  if (branchAtMiss) {
    pendingQuickReturnMisses.set(basePath, branchAtMiss);
  }
  rmSync(quickReturnStatePath(basePath), { force: true });
}

function hasStagedChanges(basePath: string): boolean {
  return nativeHasStagedChanges(basePath);
}

function isGitOpsEnabled(): boolean {
  const prefs = loadEffectiveGSDPreferences()?.preferences;
  return resolveUokFlags(prefs).gitops;
}

export function cleanupQuickBranch(basePath = process.cwd()): boolean {
  const state = readPendingReturn(basePath);
  if (!state) return false;

  const repoPath = state.basePath;
  const gitPrefs = loadEffectiveGSDPreferences()?.preferences?.git ?? {};
  const git = new GitServiceImpl(repoPath, gitPrefs);
  if (!isGitOpsEnabled()) {
    clearPendingReturn(repoPath);
    return false;
  }

  if (git.getCurrentBranch() === state.quickBranch) {
    try {
      git.autoCommit("quick-task", `Q${state.taskNum}`, []);
    } catch {
      // Best-effort: quick work may already be committed.
    }
  }

  if (git.getCurrentBranch() !== state.originalBranch) {
    runGit(repoPath, ["checkout", state.originalBranch]);
  }

  runGit(repoPath, ["merge", "--squash", state.quickBranch]);

  if (hasStagedChanges(repoPath)) {
    runGit(repoPath, ["commit", "-m", `quick(Q${state.taskNum}): ${state.slug}`]);
  }

  runGit(repoPath, ["branch", "-D", state.quickBranch], { allowFailure: true });
  clearPendingReturn(repoPath);
  return true;
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

export async function handleQuick(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  const basePath = process.cwd();
  const root = gsdRoot(basePath);

  // Validate: .gsd/ must exist
  if (!existsSync(root)) {
    ctx.ui.notify(
      "No .gsd/ directory found. Run /gsd to initialize a project first.",
      "error",
    );
    return;
  }

  // Parse description and optional right-sizing flags from args
  const quickOptions = parseQuickArgs(args);
  const { description } = quickOptions;
  if (!description) {
    ctx.ui.notify(
      "Usage: /gsd quick [--discuss] [--research] [--validate] [--full] <task description>\n\nExample: /gsd quick --validate fix login button not responding on mobile",
      "info",
    );
    return;
  }

  // Setup
  const quickDir = join(root, "quick");
  const taskNum = getNextTaskNum(quickDir);
  const slug = slugify(description);
  const taskDir = ensureQuickDir(basePath, taskNum, slug);
  const taskDirRel = `.gsd/quick/${taskNum}-${slug}`;
  const date = new Date().toISOString().split("T")[0];

  // Create git branch for the quick task (unless isolation:none — #3337)
  const gitPrefs = loadEffectiveGSDPreferences()?.preferences?.git ?? {};
  const git = new GitServiceImpl(basePath, gitPrefs);
  const branchName = `gsd/quick/${taskNum}-${slug}`;
  let originalBranch = git.getCurrentBranch();
  let returnBranch = originalBranch;

  const { getIsolationMode } = await import("./preferences.js");
  const usesBranch = getIsolationMode() !== "none" && isGitOpsEnabled();

  let branchCreated = false;
  if (usesBranch) {
    try {
      const current = originalBranch;
      if (current !== branchName) {
        // Auto-commit any dirty state before switching
        try {
          if (isGitOpsEnabled()) {
            git.autoCommit("quick-task", `Q${taskNum}`, []);
          }
        } catch { /* nothing to commit — fine */ }

        const branchArgs = taskBranchArgs(basePath, branchName, current, git.getMainBranch());
        const startPoint = branchArgs[3];
        // When the quick branch is redirected off a stale task branch, the
        // squash-merge on closeout must return to the same base — merging a
        // base-branch-rooted quick branch back into the stale task branch
        // would drag the base's newer history into it.
        if (startPoint) returnBranch = startPoint;
        runGit(basePath, branchArgs);
        branchCreated = true;
      }
    } catch (err) {
      // Branch creation failed — continue on current branch
      const message = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Could not create branch ${branchName}: ${message}. Working on current branch.`, "warning");
    }
  }

  const actualBranch = branchCreated ? branchName : git.getCurrentBranch();
  if (actualBranch === branchName && originalBranch !== branchName) {
    persistPendingReturn({
      basePath,
      originalBranch: returnBranch,
      quickBranch: branchName,
      taskNum,
      slug,
      description,
    });
  }

  // Notify user
  ctx.ui.notify(
    `Quick task ${taskNum}: ${description}\nDirectory: ${taskDirRel}\nBranch: ${actualBranch}`,
    "info",
  );

  // Build and dispatch the quick task prompt
  const summaryPath = `${taskDirRel}/${taskNum}-SUMMARY.md`;
  const prompt = loadPrompt("quick-task", {
    description,
    qualityInstructions: buildQuickQualityInstructions(quickOptions, taskDirRel, taskNum),
    taskDir: taskDirRel,
    branch: actualBranch,
    summaryPath,
    commitInstruction: buildQuickCommitInstruction(basePath, root),
    date,
    taskNum: String(taskNum),
    slug,
  });

  pi.sendMessage(
    {
      customType: "gsd-quick-task",
      content: prompt,
      display: false,
    },
    { triggerTurn: true },
  );
}
