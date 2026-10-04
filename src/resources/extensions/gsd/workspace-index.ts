import { join } from "node:path";

import { isDbAvailable, getMilestoneSlices, getSliceTasks } from "./gsd-db.js";
import { readMilestones } from "./db/lifecycle-read.js";
import { ensureExistingWorkflowDbOpen } from "./state/derive/db-open.js";
import { stripIdPrefix } from "./strip-id-prefix.js";
import {
  resolveMilestoneFile,
  resolveSliceFile,
  resolveSlicePath,
  resolveTaskFile,
  resolveTasksDir,
} from "./paths.js";
import { deriveState } from "./state.js";
import { readMilestoneValidationVerdict } from "./milestone-validation-verdict.js";
import { milestoneIdSort, findMilestoneIds } from "./guided-flow.js";
import type { RiskLevel } from "./types.js";
import { getSliceBranchName, detectWorktreeName } from "./worktree.js";

export interface WorkspaceTaskTarget {
  id: string;
  title: string;
  done: boolean;
  planPath?: string;
  summaryPath?: string;
}

export interface WorkspaceSliceTarget {
  id: string;
  title: string;
  done: boolean;
  planPath?: string;
  summaryPath?: string;
  uatPath?: string;
  tasksDir?: string;
  branch?: string;
  risk?: RiskLevel;
  depends?: string[];
  demo?: string;
  tasks: WorkspaceTaskTarget[];
}

export interface WorkspaceMilestoneTarget {
  id: string;
  title: string;
  roadmapPath?: string;
  status?: "complete" | "active" | "pending" | "parked";
  validationVerdict?: "pass" | "needs-attention" | "needs-remediation";
  slices: WorkspaceSliceTarget[];
}

export interface WorkspaceScopeTarget {
  scope: string;
  label: string;
  kind: "project" | "milestone" | "slice" | "task";
}

export interface WorkspaceValidationIssue {
  message?: string;
  [key: string]: unknown;
}

export interface WorkspaceIndex {
  milestones: WorkspaceMilestoneTarget[];
  active: {
    milestoneId?: string;
    sliceId?: string;
    taskId?: string;
    phase: string;
  };
  scopes: WorkspaceScopeTarget[];
  validationIssues: WorkspaceValidationIssue[];
}

export type GSDWorkspaceIndex = WorkspaceIndex;

async function indexSlice(basePath: string, milestoneId: string, sliceId: string, fallbackTitle: string, done: boolean, roadmapMeta?: { risk?: RiskLevel; depends?: string[]; demo?: string }): Promise<WorkspaceSliceTarget> {
  const planPath = resolveSliceFile(basePath, milestoneId, sliceId, "PLAN") ?? undefined;
  const summaryPath = resolveSliceFile(basePath, milestoneId, sliceId, "SUMMARY") ?? undefined;
  const uatPath = resolveSliceFile(basePath, milestoneId, sliceId, "UAT") ?? undefined;
  const tasksDir = resolveTasksDir(basePath, milestoneId, sliceId) ?? undefined;

  const tasks: WorkspaceTaskTarget[] = [];
  const title = fallbackTitle;

  // Post-cutover the DB is the read authority — no markdown fallback.
  if (isDbAvailable()) {
    const dbTasks = getSliceTasks(milestoneId, sliceId);
    for (const task of dbTasks) {
      tasks.push({
        id: task.id,
        title: task.title,
        done: task.status === "complete" || task.status === "done",
        planPath: resolveTaskFile(basePath, milestoneId, sliceId, task.id, "PLAN") ?? undefined,
        summaryPath: resolveTaskFile(basePath, milestoneId, sliceId, task.id, "SUMMARY") ?? undefined,
      });
    }
  }

  return {
    id: sliceId,
    title,
    done,
    planPath,
    summaryPath,
    uatPath,
    tasksDir,
    branch: getSliceBranchName(milestoneId, sliceId, detectWorktreeName(basePath)),
    risk: roadmapMeta?.risk,
    depends: roadmapMeta?.depends,
    demo: roadmapMeta?.demo,
    tasks,
  };
}

export interface IndexWorkspaceOptions {
  validate?: boolean;
}

export async function indexWorkspace(basePath: string, opts: IndexWorkspaceOptions = {}): Promise<GSDWorkspaceIndex> {
  // The database is the read authority. It is opened before the first read:
  // the web boot runs this function in a new process, where nothing else has
  // opened it.
  ensureExistingWorkflowDbOpen(basePath);
  const dbOpen = isDbAvailable();
  // Milestones and their titles come from database rows; a discarded
  // Milestone is not listed. With no database only the directory names are known.
  const milestoneRefs = dbOpen
    ? readMilestones()
      .filter((milestone) => !milestone.discarded)
      .map((milestone) => ({ id: milestone.id, title: stripIdPrefix(milestone.title, milestone.id) || milestone.id }))
    : findMilestoneIds(basePath).map((id) => ({ id, title: id }));
  const milestones: WorkspaceMilestoneTarget[] = [];

  for (const { id: milestoneId, title } of milestoneRefs) {
    const roadmapPath = resolveMilestoneFile(basePath, milestoneId, "ROADMAP") ?? undefined;
    // Slices come from the database only — no markdown fallback.
    const slices = dbOpen
      ? await Promise.all(getMilestoneSlices(milestoneId).map((slice) =>
        indexSlice(basePath, milestoneId, slice.id, slice.title, slice.status === "complete", {
          risk: (slice.risk || "medium") as RiskLevel,
          depends: slice.depends,
          demo: slice.demo,
        })))
      : [];

    milestones.push({ id: milestoneId, title, roadmapPath, slices });
  }

  const state = await deriveState(basePath);
  const active = {
    milestoneId: state.activeMilestone?.id,
    sliceId: state.activeSlice?.id,
    taskId: state.activeTask?.id,
    phase: state.phase,
  };

  // Enrich milestones with authoritative status from state registry (#2807)
  if (state.registry) {
    const registryMap = new Map(state.registry.map(e => [e.id, e]));
    for (const milestone of milestones) {
      const entry = registryMap.get(milestone.id);
      if (entry) {
        milestone.status = entry.status;
      }
    }
  }

  // Populate validationVerdict from the milestone-validation row (#2807).
  // VALIDATION.md is a projection and is not read.
  for (const milestone of milestones) {
    const verdict = readMilestoneValidationVerdict(milestone.id);
    if (verdict) milestone.validationVerdict = verdict;
  }

  const scopes: WorkspaceScopeTarget[] = [{ scope: "project", label: "project", kind: "project" }];
  for (const milestone of milestones) {
    scopes.push({ scope: milestone.id, label: `${milestone.id}: ${milestone.title}`, kind: "milestone" });
    for (const slice of milestone.slices) {
      scopes.push({ scope: `${milestone.id}/${slice.id}`, label: `${milestone.id}/${slice.id}: ${slice.title}`, kind: "slice" });
      for (const task of slice.tasks) {
        scopes.push({
          scope: `${milestone.id}/${slice.id}/${task.id}`,
          label: `${milestone.id}/${slice.id}/${task.id}: ${task.title}`,
          kind: "task",
        });
      }
    }
  }

  return { milestones, active, scopes, validationIssues: [] };
}

export async function listDoctorScopeSuggestions(basePath: string): Promise<Array<{ value: string; label: string }>> {
  const index = await indexWorkspace(basePath);
  const activeSliceScope = index.active.milestoneId && index.active.sliceId
    ? `${index.active.milestoneId}/${index.active.sliceId}`
    : null;

  const ordered = [...index.scopes].filter(scope => scope.kind !== "project");
  ordered.sort((a, b) => {
    if (activeSliceScope && a.scope === activeSliceScope) return -1;
    if (activeSliceScope && b.scope === activeSliceScope) return 1;
    return a.scope.localeCompare(b.scope);
  });

  return ordered.map(scope => ({ value: scope.scope, label: scope.label }));
}

export async function getSuggestedNextCommands(basePath: string): Promise<string[]> {
  const index = await indexWorkspace(basePath);
  const scope = index.active.milestoneId && index.active.sliceId
    ? `${index.active.milestoneId}/${index.active.sliceId}`
    : index.active.milestoneId;

  const commands = new Set<string>();
  if (index.active.phase === "planning") commands.add("/gsd");
  if (index.active.phase === "executing" || index.active.phase === "summarizing") commands.add("/gsd auto");
  if (scope) commands.add(`/gsd doctor ${scope}`);
  if (scope) commands.add(`/gsd doctor fix ${scope}`);
  commands.add("/gsd status");
  return [...commands];
}
