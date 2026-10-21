// Project/App: gsd-pi
// File Purpose: Git-based detection of milestone implementation evidence for closeout guards.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MILESTONE_ID_RE } from "./milestone-ids.js";
import {
  getCompletedMilestoneTaskFileHints,
  getMilestone,
  getMilestoneCommitAttributionShas,
  getTask,
  isDbAvailable,
  recordMilestoneCommitAttribution,
} from "./gsd-db.js";
import { readIntegrationBranch } from "./git-service.js";
import { logWarning } from "./workflow-logger.js";
import { resolveTasksDir } from "./paths.js";

/** Large enough for unbounded milestone-history git log scans in big repos. */
const GIT_LOG_MAX_BUFFER = 16 * 1024 * 1024;
const LOG_FIELD_SEPARATOR = "\x1f";
const LOG_RECORD_SEPARATOR = "\x1e";

type CommitRecord = {
  hash: string;
  parents: string;
  committedAt: string;
  message: string;
  files: string[];
};

/**
 * Check whether a milestone produced implementation artifacts (non-`.gsd/`
 * files) in git history. The primary signal is the branch diff against the
 * integration branch. When a retry is already on the integration branch, that
 * diff is a self-diff; if a milestone ID is available, fall back to recent
 * GSD-tagged commits for that milestone.
 *
 * Returns "present" if implementation files found, "absent" if only .gsd/ files,
 * "unknown" if git is unavailable or check failed (callers decide how to handle).
 */
export function hasImplementationArtifacts(basePath: string, milestoneId?: string): "present" | "absent" | "unknown" {
  try {
    // Verify we're in a git repo
    try {
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: basePath,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
      });
    } catch (e) {
      logWarning("recovery", `git rev-parse check failed: ${(e as Error).message}`);
      return "unknown";
    }

    // Strategy: check `git diff --name-only` against the merge-base with the
    // main branch. This captures ALL files changed during the milestone's
    // lifetime while running on a milestone branch.
    const recordedIntegrationBranch = milestoneId
      ? readIntegrationBranch(basePath, milestoneId)
      : null;
    let integrationBranch: string;
    if (recordedIntegrationBranch?.startsWith("milestone/")) {
      integrationBranch = detectMainBranch(basePath);
    } else {
      integrationBranch = recordedIntegrationBranch ?? detectMainBranch(basePath);
    }
    const currentBranch = getCurrentBranch(basePath);
    const branchDiff = getChangedFilesSinceBranch(basePath, integrationBranch);
    if (!branchDiff.ok) return "unknown";
    const changedFiles = branchDiff.files;

    // No branch-diff files can mean the unit retried on main after milestone
    // commits already landed there. In that topology, inspect GSD-tagged
    // milestone commits instead of treating the self-diff as proof of no work.
    if (changedFiles.length === 0) {
      if (milestoneId && currentBranch === integrationBranch) {
        const milestoneEvidence = getChangedFilesFromMilestoneEvidence(basePath, milestoneId);
        if (!milestoneEvidence.ok) return "unknown";
        if (milestoneEvidence.matched) return classifyImplementationFiles(milestoneEvidence.files);
        return "unknown";
      }
      if (currentBranch && currentBranch !== "HEAD") return "absent";
      return "unknown";
    }

    const branchClassification = classifyImplementationFiles(changedFiles);
    if (branchClassification === "present") return "present";

    // A completing milestone branch can have a non-empty diff containing only
    // .gsd/ closeout files after implementation commits already landed on the
    // recorded integration branch. In that topology, the branch diff alone is
    // insufficient; use the same milestone-tagged evidence fallback as the
    // self-diff retry path before declaring the milestone implementation-free.
    if (milestoneId) {
      const milestoneEvidence = getChangedFilesFromMilestoneEvidence(basePath, milestoneId);
      if (!milestoneEvidence.ok) return "unknown";
      if (milestoneEvidence.matched) return classifyImplementationFiles(milestoneEvidence.files);
    }

    return "absent";
  } catch (e) {
    // Non-fatal — if git operations fail, return unknown so callers can decide
    logWarning("recovery", `implementation artifact check failed: ${(e as Error).message}`);
    return "unknown";
  }
}

function getCurrentBranch(basePath: string): string | null {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    }).trim();
    return branch || null;
  } catch {
    return null;
  }
}

function classifyImplementationFiles(files: readonly string[]): "present" | "absent" {
  const implFiles = files.filter(isImplementationPath);
  return implFiles.length > 0 ? "present" : "absent";
}

function isImplementationPath(file: string): boolean {
  return !file.startsWith(".gsd/") && !file.startsWith(".gsd\\");
}

function normalizeRepoPath(file: string): string {
  return file.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
}

/**
 * Detect the main/master branch name.
 */
function detectMainBranch(basePath: string): string {
  try {
    const result = execFileSync("git", ["rev-parse", "--verify", "main"], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    });
    if (result.trim()) return "main";
  } catch (_) {
    // Expected — main doesn't exist, try master next
    void _;
  }
  try {
    const result = execFileSync("git", ["rev-parse", "--verify", "master"], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    });
    if (result.trim()) return "master";
  } catch (_) {
    // Expected — master doesn't exist either
    void _;
  }
  // Neither main nor master found — warn and fall back
  logWarning("recovery", "neither main nor master branch found, defaulting to main");
  return "main";
}

/**
 * Get files changed since the branch diverged from the target branch.
 * Falls back to checking HEAD~20 if merge-base detection fails.
 */
function getChangedFilesSinceBranch(basePath: string, targetBranch: string): { ok: boolean; files: string[] } {
  try {
    // Try merge-base approach first
    const mergeBase = execFileSync(
      "git", ["merge-base", targetBranch, "HEAD"],
      { cwd: basePath, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" },
    ).trim();

    if (mergeBase) {
      const result = execFileSync(
        "git", ["diff", "--name-only", mergeBase, "HEAD"],
        { cwd: basePath, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8", maxBuffer: GIT_LOG_MAX_BUFFER },
      ).trim();
      return { ok: true, files: result ? result.split("\n").filter(Boolean) : [] };
    }
  } catch (err) {
    // merge-base failed — fall back
    logWarning("recovery", `merge-base detection failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Fallback: check last 20 commits
  try {
    const result = execFileSync(
      "git", ["log", "--name-only", "--pretty=format:", "-20", "HEAD"],
      { cwd: basePath, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" },
    ).trim();
    return { ok: true, files: result ? [...new Set(result.split("\n").filter(Boolean))] : [] };
  } catch (e) {
    logWarning("recovery", `git log fallback failed: ${(e as Error).message}`);
    return { ok: false, files: [] };
  }
}

function getChangedFilesFromMilestoneTaggedCommits(
  basePath: string,
  milestoneId: string,
): { ok: boolean; matched: boolean; files: string[] } {
  // Primary: path-scoped log against .gsd/milestones/<id>. Fast and unbounded
  // by depth when .gsd/ is tracked in git.
  const scoped = scanGsdTaggedCommits(basePath, milestoneId, [
    "log", "--full-diff", "--name-only", "--format=%x1e%H%x1f%B%x1f", "HEAD", "--", `.gsd/milestones/${milestoneId}`,
  ]);
  if (!scoped.ok) return scoped;
  if (scoped.matched && classifyImplementationFiles(scoped.files) === "present") return scoped;

  // Fallback (#5033): when .gsd/ is gitignored / external / untracked, the
  // path-scoped scan matches no commits even though GSD-tagged commits
  // referencing the milestone exist on the integration branch. Re-scan all
  // of HEAD's history and rely on commitMatchesMilestone to bind by
  // explicit milestone mention in the message body.
  //
  // Intentionally unbounded — symmetric with the primary scan, and avoids
  // reintroducing the rolling-depth failure class removed in #4699 where
  // milestone evidence aged out behind unrelated activity.
  const unscoped = scanGsdTaggedCommits(basePath, milestoneId, [
    "log", "--name-only", "--format=%x1e%H%x1f%B%x1f", "HEAD",
  ]);
  if (!unscoped.ok) return scoped.matched ? scoped : unscoped;
  if (!unscoped.matched) return scoped;

  return {
    ok: true,
    matched: true,
    files: [...new Set([...scoped.files, ...unscoped.files])],
  };
}

function getChangedFilesFromMilestoneEvidence(
  basePath: string,
  milestoneId: string,
): { ok: boolean; matched: boolean; files: string[] } {
  const tagged = getChangedFilesFromMilestoneTaggedCommits(basePath, milestoneId);
  if (!tagged.ok) return tagged;
  if (tagged.matched && classifyImplementationFiles(tagged.files) === "present") return tagged;

  const attributed = getChangedFilesFromAttributedMilestoneCommits(basePath, milestoneId);
  if (!attributed.ok) return tagged.matched ? tagged : attributed;
  if (attributed.matched && classifyImplementationFiles(attributed.files) === "present") return attributed;

  const backfilled = backfillChangedFilesFromUntaggedMilestoneCommits(basePath, milestoneId);
  if (!backfilled.ok) return tagged.matched ? tagged : attributed.matched ? attributed : backfilled;
  if (!backfilled.matched) {
    if (tagged.matched) return tagged;
    return attributed.matched ? attributed : backfilled;
  }

  return {
    ok: true,
    matched: true,
    files: [...new Set([...tagged.files, ...attributed.files, ...backfilled.files])],
  };
}

function getChangedFilesFromAttributedMilestoneCommits(
  basePath: string,
  milestoneId: string,
): { ok: boolean; matched: boolean; files: string[] } {
  try {
    const shas = getMilestoneCommitAttributionShas(milestoneId);
    if (shas.length === 0) return { ok: true, matched: false, files: [] };

    const files = new Set<string>();
    let matched = false;
    for (const sha of shas) {
      if (!isFullCommitSha(sha)) continue;
      const commitFiles = getChangedFilesForCommit(basePath, sha);
      if (commitFiles.length === 0) continue;
      matched = true;
      for (const file of commitFiles) files.add(file);
    }
    return { ok: true, matched, files: [...files] };
  } catch (e) {
    logWarning("recovery", `milestone attribution scan failed: ${(e as Error).message}`);
    return { ok: false, matched: false, files: [] };
  }
}

function backfillChangedFilesFromUntaggedMilestoneCommits(
  basePath: string,
  milestoneId: string,
): { ok: boolean; matched: boolean; files: string[] } {
  try {
    const milestone = getMilestone(milestoneId);
    const milestoneStartedAt = milestone?.created_at ? Math.floor(Date.parse(milestone.created_at) / 1000) * 1000 : NaN;
    if (!Number.isFinite(milestoneStartedAt)) return { ok: true, matched: false, files: [] };

    const taskFileHints = getCompletedMilestoneTaskFileHints(milestoneId);
    if (taskFileHints.length === 0) return { ok: true, matched: false, files: [] };

    const hintSet = new Set(taskFileHints.map(normalizeRepoPath).filter(Boolean));
    if (hintSet.size === 0) return { ok: true, matched: false, files: [] };

    const records = getCommitRecords(basePath);
    const files = new Set<string>();
    let matched = false;
    for (const record of records) {
      if (!isFullCommitSha(record.hash)) continue;
      if (Date.parse(record.committedAt) < milestoneStartedAt) continue;
      if (record.parents.trim().split(/\s+/).filter(Boolean).length > 1) continue;
      if (commitMessageHasGsdTrailer(record.message)) continue;

      const implementationFiles = record.files.map(normalizeRepoPath).filter(isImplementationPath);
      if (implementationFiles.length === 0) continue;
      if (!implementationFiles.some((file) => hintSet.has(file))) continue;

      matched = true;
      for (const file of implementationFiles) files.add(file);
      recordMilestoneCommitAttribution({
        commitSha: record.hash,
        milestoneId,
        source: "backfill",
        confidence: 0.8,
        files: implementationFiles,
        createdAt: new Date().toISOString(),
      });
    }

    return { ok: true, matched, files: [...files] };
  } catch (e) {
    logWarning("recovery", `milestone attribution backfill failed: ${(e as Error).message}`);
    return { ok: false, matched: false, files: [] };
  }
}

function getCommitRecords(basePath: string): CommitRecord[] {
  const logOutput = execFileSync("git", ["log", "--name-only", "--format=%x1e%H%x1f%P%x1f%cI%x1f%B%x1f", "HEAD"], {
    cwd: basePath,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    maxBuffer: GIT_LOG_MAX_BUFFER,
  });
  return logOutput
    .split(LOG_RECORD_SEPARATOR)
    .filter(Boolean)
    .flatMap((record) => {
      const parts = record.split(LOG_FIELD_SEPARATOR);
      if (parts.length < 5) return [];
      const [hash, parents, committedAt] = parts;
      const files = parseNameOnlyFiles(parts.at(-1) ?? "");
      const message = parts.slice(3, -1).join(LOG_FIELD_SEPARATOR);
      return [{ hash: hash.trim(), parents: parents.trim(), committedAt: committedAt.trim(), message, files }];
    });
}

function parseNameOnlyFiles(rawFiles: string): string[] {
  return rawFiles.split(/\r?\n/).map((file) => file.trim()).filter(Boolean);
}

function isFullCommitSha(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}

function scanGsdTaggedCommits(
  basePath: string,
  milestoneId: string,
  gitArgs: readonly string[],
): { ok: boolean; matched: boolean; files: string[] } {
  try {
    const logOutput = execFileSync("git", [...gitArgs], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      maxBuffer: GIT_LOG_MAX_BUFFER,
    });
    const records = logOutput
      .split(LOG_RECORD_SEPARATOR)
      .filter(Boolean)
      .flatMap((record) => {
        const parts = record.split(LOG_FIELD_SEPARATOR);
        if (parts.length < 3) return [];
        const hash = parts[0].trim();
        if (!hash) return [];
        const files = parseNameOnlyFiles(parts.at(-1) ?? "");
        const message = parts.slice(1, -1).join(LOG_FIELD_SEPARATOR);
        return [{ message, files }];
      });

    const files = new Set<string>();
    let matched = false;
    for (const { message, files: commitFiles } of records) {
      if (!commitMessageHasGsdTrailer(message)) continue;

      if (!commitMatchesMilestone(basePath, message, milestoneId, commitFiles)) continue;

      matched = true;
      for (const file of commitFiles) {
        files.add(file);
      }
    }

    return { ok: true, matched, files: [...files] };
  } catch (e) {
    logWarning("recovery", `milestone-tagged commit scan failed: ${(e as Error).message}`);
    return { ok: false, matched: false, files: [] };
  }
}

function getChangedFilesForCommit(basePath: string, hash: string): string[] {
  const fileOutput = execFileSync(
    "git",
    ["diff-tree", "--root", "--no-commit-id", "-r", "--name-only", hash],
    { cwd: basePath, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" },
  ).trim();
  return fileOutput.split("\n").map((f) => f.trim()).filter(Boolean);
}

function commitMessageHasGsdTrailer(message: string): boolean {
  return /^GSD-(?:Task|Unit):\s*\S+/m.test(message);
}

function commitMatchesMilestone(basePath: string, message: string, milestoneId: string, files: readonly string[]): boolean {
  if (commitTrailerStartsWithMilestone(message, milestoneId)) return true;

  // Meaningful execute-task commits currently store task scope as Sxx/Tyy
  // rather than Mxx/Sxx/Tyy. Bind those commits back to the milestone when
  // either the commit touched this milestone's artifacts, or — for projects
  // where .gsd/ is gitignored/external (#5033) — the message explicitly
  // names the milestone, local GSD state proves the task belongs here, or the
  // commit is implementation-bearing evidence itself (#5100).
  if (/^GSD-Task:\s*S[^/\s]+\/T\S+/m.test(message)) {
    if (files.some((file) => isMilestoneArtifactPath(file, milestoneId))) return true;
    if (commitMessageMentionsMilestone(message, milestoneId)) return true;
    const taskTrailerOwnership = getTaskOwnershipStatus(basePath, message, milestoneId);
    if (taskTrailerOwnership === true) return true;
    if (taskTrailerOwnership === false) return false;
    // taskTrailerOwnership === null: unknown ownership. Apply fallback only
    // in this case to avoid cross-milestone attribution.
    if (MILESTONE_ID_RE.test(milestoneId) && classifyImplementationFiles(files) === "present") return true;
  }

  return false;
}

/**
 * Tri-state task ownership probe.
 * true => DB or local files confirm this milestone owns the task.
 * false => DB is available and this milestone is registered, but task is absent.
 * null => ownership unknown (milestone not in DB yet, or no DB + no local files).
 */
function getTaskOwnershipStatus(
  basePath: string,
  message: string,
  milestoneId: string,
): true | false | null {
  const match = message.match(/^GSD-Task:\s*(S[^/\s]+)\/(T[^\s]+)/m);
  if (!match) return null;
  const [, sliceId, taskId] = match;

  if (isDbAvailable()) {
    if (!getMilestone(milestoneId)) return null;
    return getTask(milestoneId, sliceId, taskId) ? true : false;
  }

  // DB unavailable: fallback to local task-file presence.
  const tasksDir = resolveTasksDir(basePath, milestoneId, sliceId);
  if (
    tasksDir
    && (
      existsSync(join(tasksDir, `${taskId}-PLAN.md`))
      || existsSync(join(tasksDir, `${taskId}-SUMMARY.md`))
    )
  ) {
    return true;
  }

  return null;
}

function commitMessageMentionsMilestone(message: string, milestoneId: string): boolean {
  if (!MILESTONE_ID_RE.test(milestoneId)) return false;

  const escapedMilestone = milestoneId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escapedMilestone}\\b`).test(message);
}

function commitTrailerStartsWithMilestone(message: string, milestoneId: string): boolean {
  const escapedMilestone = milestoneId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const trailerPattern = new RegExp(
    `^GSD-(?:Task|Unit):\\s*${escapedMilestone}(?:$|[\\s/])`,
    "m",
  );
  return trailerPattern.test(message);
}

function isMilestoneArtifactPath(file: string, milestoneId: string): boolean {
  return file.startsWith(`.gsd/milestones/${milestoneId}/`)
    || file.startsWith(`.gsd\\milestones\\${milestoneId}\\`);
}
