// Project/App: gsd-pi
// File Purpose: Custom-engine iteration-data adapter for auto-mode loop.

import type { GSDState } from "../types.js";
import { getSlice, getTask, isDbAvailable, type TaskRow } from "../gsd-db.js";
import {
  readPendingTaskRecoveryContext,
  type PendingTaskRecoveryContext,
} from "../task-recovery-domain-operation.js";
import {
  buildTaskRecoveryReplanPrompt,
  renderTaskRecoveryDispatchContext,
} from "../auto-prompts.js";
import type { IterationData } from "./types.js";

export interface CustomEngineStep {
  unitType: string;
  unitId: string;
  prompt: string;
  customEnginePreparation?: "task-replan";
}

export interface BuildCustomEngineIterationDataInput {
  step: CustomEngineStep;
  basePath: string;
  canonicalProjectRoot: string;
  currentMilestoneId?: string | null;
  deriveState: (basePath: string) => Promise<GSDState>;
  logPostDerive: (details: {
    site: "custom-engine-gsd-state";
    basePath: string;
    canonicalProjectRoot: string;
    derivedPhase: GSDState["phase"];
    activeUnit: string | undefined;
  }) => void;
}

function parseTaskIdentity(unitId: string): {
  milestoneId: string;
  sliceId: string;
  taskId: string;
} | null {
  const [milestoneId, sliceId, taskId, extra] = unitId.split("/");
  if (extra !== undefined || !milestoneId || !sliceId || !taskId) return null;
  return { milestoneId, sliceId, taskId };
}

function renderList(values: string[]): string {
  return values.length > 0 ? values.map(value => `- ${value}`).join("\n") : "- (none)";
}

function renderRecoveryExecutionPrompt(
  recovery: PendingTaskRecoveryContext,
  task: TaskRow,
  enginePrompt: string,
): string {
  return [
    "The durable recovery action and canonical database Task plan govern this execution.",
    "The custom-engine context at the end is subordinate and must be ignored wherever it conflicts with them.",
    "",
    renderTaskRecoveryDispatchContext(recovery),
    "",
    "## Canonical Task Plan (Database Authority)",
    "",
    `**Title:** ${task.title}`,
    `**Description:** ${task.description || "(none)"}`,
    `**Estimate:** ${task.estimate || "(none)"}`,
    "",
    "### Files",
    renderList(task.files),
    "",
    "### Verification",
    task.verify || "(none)",
    "",
    "### Inputs",
    renderList(task.inputs),
    "",
    "### Expected Output",
    renderList(task.expected_output),
    "",
    "## Non-authoritative Custom Engine Context",
    "",
    enginePrompt,
  ].join("\n");
}

async function resolveRecoveryStep(
  input: BuildCustomEngineIterationDataInput,
  state: GSDState,
): Promise<CustomEngineStep> {
  if (input.step.unitType !== "execute-task" || !isDbAvailable()) return input.step;
  const task = parseTaskIdentity(input.step.unitId);
  if (!task) return input.step;
  const recovery = readPendingTaskRecoveryContext(task);
  if (!recovery) return input.step;

  const sliceTitle = getSlice(task.milestoneId, task.sliceId)?.title
    ?? state.activeSlice?.title
    ?? task.sliceId;
  const currentTask = getTask(task.milestoneId, task.sliceId, task.taskId);
  const taskTitle = currentTask?.title
    ?? state.activeTask?.title
    ?? task.taskId;
  if (recovery.action === "replan" && !recovery.replanCompleted) {
    return {
      unitType: "replan-task",
      unitId: input.step.unitId,
      prompt: await buildTaskRecoveryReplanPrompt(
        task.milestoneId,
        task.sliceId,
        sliceTitle,
        task.taskId,
        taskTitle,
        input.basePath,
      ),
      customEnginePreparation: "task-replan",
    };
  }
  if (!currentTask) {
    throw new Error(`Durable recovery Task is missing for ${input.step.unitId}`);
  }
  return {
    ...input.step,
    prompt: renderRecoveryExecutionPrompt(recovery, currentTask, input.step.prompt),
  };
}

export async function buildCustomEngineIterationData(
  input: BuildCustomEngineIterationDataInput,
): Promise<IterationData> {
  const gsdState = await input.deriveState(input.canonicalProjectRoot);
  const step = await resolveRecoveryStep(input, gsdState);
  input.logPostDerive({
    site: "custom-engine-gsd-state",
    basePath: input.basePath,
    canonicalProjectRoot: input.canonicalProjectRoot,
    derivedPhase: gsdState.phase,
    activeUnit: gsdState.activeTask?.id ?? gsdState.activeSlice?.id ?? gsdState.activeMilestone?.id,
  });

  return {
    unitType: step.unitType,
    unitId: step.unitId,
    prompt: step.prompt,
    finalPrompt: step.prompt,
    pauseAfterUatDispatch: false,
    state: gsdState,
    mid: input.currentMilestoneId ?? "workflow",
    midTitle: "Workflow",
    isRetry: false,
    previousTier: undefined,
    ...(step.customEnginePreparation
      ? { customEnginePreparation: step.customEnginePreparation }
      : {}),
  };
}
