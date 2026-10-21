// Project/App: gsd-pi
// File Purpose: Shared classification for DB-backed Task SUMMARY projections.

import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { stripProjectionStamp } from "./markdown-renderer.js";
import { gsdProjectionRoot, gsdRoot, targetTaskFile } from "./paths.js";
import { isGsdWorktreePath, resolveWorktreeProjectRoot } from "./worktree-root.js";
import { isCanonicalStagedTaskSummaryState } from "./task-summary-projection-policy.js";

interface TaskSummaryProjectionArtifact {
  path: string;
  milestoneId: string | null;
  sliceId: string | null;
  taskId: string | null;
  fullContent: string;
}

interface TaskSummaryProjectionTask {
  milestoneId: string;
  sliceId: string;
  taskId: string;
  status: string;
  fullSummaryMd: string;
}

function artifactPathCandidates(basePath: string, artifactPath: string): string[] {
  if (isAbsolute(artifactPath)) return [resolve(artifactPath)];
  const relativePath = artifactPath
    .replaceAll("\\", "/")
    .replace(/^\.gsd\//, "");
  const candidates = [
    resolve(join(gsdProjectionRoot(basePath), relativePath)),
    resolve(join(gsdRoot(basePath), relativePath)),
  ];
  // Inside a milestone worktree the staged SUMMARY may exist only at the
  // project root (#1677): the worktree-local `.gsd` is gitignored and the
  // canonical copy lives with the project — offer it as a fallback candidate.
  if (isGsdWorktreePath(basePath)) {
    const projectRoot = resolveWorktreeProjectRoot(basePath);
    if (projectRoot && resolve(projectRoot) !== resolve(basePath)) {
      candidates.push(resolve(join(gsdProjectionRoot(projectRoot), relativePath)));
    }
  }
  return candidates;
}

function readFirstExisting(candidates: string[]): string | null {
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, "utf8");
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function hasCanonicalContent(
  basePath: string,
  artifact: TaskSummaryProjectionArtifact,
  task: TaskSummaryProjectionTask,
): boolean {
  if (
    artifact.milestoneId !== task.milestoneId ||
    artifact.sliceId !== task.sliceId ||
    artifact.taskId !== task.taskId
  ) {
    return false;
  }

  const canonicalPaths = [resolve(targetTaskFile(
    basePath,
    task.milestoneId,
    task.sliceId,
    task.taskId,
    "SUMMARY",
  ))];
  // Inside a milestone worktree the canonical copy may live at the project
  // root (#1677): the worktree-local `.gsd` is gitignored, so accept the
  // project-root canonical path as the identity and the read source.
  if (isGsdWorktreePath(basePath)) {
    const projectRoot = resolveWorktreeProjectRoot(basePath);
    if (projectRoot && resolve(projectRoot) !== resolve(basePath)) {
      canonicalPaths.push(resolve(targetTaskFile(
        projectRoot,
        task.milestoneId,
        task.sliceId,
        task.taskId,
        "SUMMARY",
      )));
    }
  }
  const candidates = artifactPathCandidates(basePath, artifact.path);
  const canonicalPath = canonicalPaths.find((path) => candidates.includes(path));
  if (!canonicalPath) return false;
  // Fall back to the remaining candidates (project-root copy) when the
  // worktree-local file is absent, instead of fail-closing on the read (#1677).
  const diskContent = readFirstExisting([canonicalPath, ...candidates]);
  if (diskContent === null || diskContent !== artifact.fullContent) return false;
  return stripProjectionStamp(artifact.fullContent) === stripProjectionStamp(task.fullSummaryMd);
}

export function isCanonicalStagedTaskSummaryProjection(
  basePath: string,
  artifact: TaskSummaryProjectionArtifact,
  task: TaskSummaryProjectionTask,
): boolean {
  try {
    if (
      task.status !== "in_progress" ||
      !task.fullSummaryMd ||
      !hasCanonicalContent(basePath, artifact, task)
    ) {
      return false;
    }

    return isCanonicalStagedTaskSummaryState({
      milestoneId: task.milestoneId,
      sliceId: task.sliceId,
      taskId: task.taskId,
    });
  } catch {
    return false;
  }
}
