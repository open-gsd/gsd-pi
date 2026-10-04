/**
 * custom-workflow-engine.ts — WorkflowEngine implementation for custom workflows.
 *
 * Drives the auto-loop from the step rows of a run (db/custom-workflow-runs.ts).
 * Each iteration: deriveState reads the steps, resolveDispatch picks the
 * next eligible step, reconcile marks it complete. Each step transition is one
 * Domain Operation, and the run directory files are rendered from the rows
 * after it. GRAPH.yaml is never read for a run that has rows.
 *
 * A run directory with no run row was written before runs were database rows.
 * Its GRAPH.yaml is the step state for one release.
 *
 * Observability:
 * - `resolveDispatch` returns unitType "custom-step" with unitId "<name>/<stepId>".
 * - `getDisplayMetadata` provides step N/M progress for dashboard rendering.
 */

import type { WorkflowEngine } from "./workflow-engine.js";
import type {
  EngineState,
  EngineDispatchAction,
  CompletedStep,
  ReconcileResult,
  DisplayMetadata,
} from "./engine-types.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  readGraph,
  writeGraph,
  getNextPendingStep,
  markStepActive,
  markStepComplete,
  expandIteration,
  isTerminalStepStatus,
  type GraphStep,
  type WorkflowGraph,
} from "./graph.js";
import { injectContext } from "./context-injector.js";
import { isAutoWorkerLive } from "./db/auto-workers.js";
import {
  customWorkflowRunId,
  getCustomWorkflowRun,
  getCustomWorkflowStepClaim,
  getLatestCustomWorkflowStepVerification,
  readCustomWorkflowGraph,
} from "./db/custom-workflow-runs.js";
import { saveCustomWorkflowSteps } from "./db/writers/custom-workflow-runs.js";
import { readDomainOperationFence } from "./db/writers/lifecycle-commands.js";
import type { StepDefinition } from "./definition-loader.js";
import { readFrozenDefinition, renderRunDirectory } from "./definition-io.js";
import { parseUnitId } from "./unit-id.js";
import { withFileLock } from "./file-lock.js";

// Re-export for downstream consumers
export { readFrozenDefinition } from "./definition-io.js";

function formatBlockedWorkflowReason(graph: WorkflowGraph): string {
  const statusById = new Map(graph.steps.map((step) => [step.id, step.status]));
  const blockedSteps = graph.steps
    .filter((step) => step.status === "pending")
    .map((step) => {
      const blockers = step.dependsOn
        .filter((depId) => !isTerminalStepStatus(statusById.get(depId)))
        .map((depId) => `${depId} (${statusById.get(depId) ?? "missing"})`);
      return blockers.length > 0
        ? `${step.id} waiting on ${blockers.join(", ")}`
        : `${step.id} has no runnable dependency path`;
    });

  return blockedSteps.length > 0
    ? `Workflow blocked: no pending steps are ready. Blocked steps: ${blockedSteps.join("; ")}`
    : "Workflow blocked: no pending steps are ready.";
}

/** The step transition that one resolveDispatch call decided on. */
interface StepTransition {
  operationType: "step.activate" | "step.expand";
  stepId: string;
  graph: WorkflowGraph;
}

export class CustomWorkflowEngine implements WorkflowEngine {
  readonly engineId = "custom";
  private readonly runDir: string;
  private readonly runId: string;
  private readonly workerId: string | null;

  /** `workerId` is the auto worker of this session. A step it starts is claimed by it. */
  constructor(runDir: string, workerId: string | null = null) {
    this.runDir = runDir;
    this.runId = customWorkflowRunId(runDir);
    this.workerId = workerId;
  }

  /**
   * Derive engine state from the step rows of the run.
   *
   * Phase is "complete" when all steps are complete or expanded,
   * "running" otherwise (any pending or active steps remain).
   */
  async deriveState(_basePath: string): Promise<EngineState> {
    const run = getCustomWorkflowRun(this.runId);
    const graph = run ? readCustomWorkflowGraph(run) : readGraph(this.runDir);
    const allDone = graph.steps.every(
      (s) => s.status === "complete" || s.status === "expanded",
    );
    const phase = allDone ? "complete" : "running";

    return {
      phase,
      currentMilestoneId: null,
      activeSliceId: null,
      activeTaskId: null,
      isComplete: allDone,
      raw: graph,
    };
  }

  private dispatchStep(graph: WorkflowGraph, step: GraphStep): EngineDispatchAction {
    return {
      action: "dispatch",
      step: {
        unitType: "custom-step",
        unitId: `${graph.metadata.name}/${step.id}`,
        // Enrich prompt with context from prior step artifacts
        prompt: injectContext(this.runDir, step.id, step.prompt),
      },
    };
  }

  /**
   * Pick the next step of a graph with no active step. If the step has an
   * `iterate` config in the frozen definition, it is expanded into instance
   * steps first. Returns the dispatch action and the step transition to store.
   *
   * Observability:
   * - Missing source artifacts throw with the full resolved path for diagnosis.
   * - Zero-match expansions return a stop action with level "info".
   */
  private nextStep(graph: WorkflowGraph): { action: EngineDispatchAction; transition?: StepTransition } {
    let next = getNextPendingStep(graph);

    if (!next) {
      const allDone = graph.steps.every(
        (step) => step.status === "complete" || step.status === "expanded",
      );
      if (!allDone) {
        return {
          action: {
            action: "stop",
            reason: formatBlockedWorkflowReason(graph),
            level: "error",
          },
        };
      }
      return {
        action: {
          action: "stop",
          reason: "All steps complete",
          level: "info",
        },
      };
    }

    // Check the frozen definition for iterate config on this step
    const parentId = next.id;
    const def = readFrozenDefinition(this.runDir);
    const stepDef = def.steps.find((s: StepDefinition) => s.id === parentId);

    if (stepDef?.iterate) {
      const iterate = stepDef.iterate;

      // Read source artifact
      const sourcePath = join(this.runDir, iterate.source);
      let sourceContent: string;
      try {
        sourceContent = readFileSync(sourcePath, "utf-8");
      } catch {
        throw new Error(
          `Iterate source artifact not found: ${sourcePath} (step "${parentId}", source: "${iterate.source}")`,
        );
      }

      // Extract items via regex with global+multiline flags.
      // Guard against ReDoS: if matching takes too long on large inputs, bail.
      const regex = new RegExp(iterate.pattern, "gm");
      const items: string[] = [];
      const matchStart = Date.now();
      let match: RegExpExecArray | null;
      while ((match = regex.exec(sourceContent)) !== null) {
        if (match[1] !== undefined) items.push(match[1]);
        if (Date.now() - matchStart > 5_000) {
          throw new Error(
            `Iterate pattern "${iterate.pattern}" exceeded 5s timeout on step "${parentId}" — possible ReDoS`,
          );
        }
      }

      // Expand the graph
      graph = expandIteration(graph, parentId, items, next.prompt);

      // Re-query for first instance step
      next = getNextPendingStep(graph);

      if (!next) {
        return {
          action: {
            action: "stop",
            reason: "Iterate expansion produced no instances",
            level: "info",
          },
          transition: { operationType: "step.expand", stepId: parentId, graph },
        };
      }
    }

    const nextId = next.id;
    const activeGraph = markStepActive(graph, nextId);
    const activeStep = activeGraph.steps.find((s) => s.id === nextId);
    if (!activeStep) {
      throw new Error(`Active step not found after step activation: ${nextId}`);
    }

    return {
      action: this.dispatchStep(activeGraph, activeStep),
      transition: { operationType: "step.activate", stepId: nextId, graph: activeGraph },
    };
  }

  /**
   * Resolve the next dispatch action from the step rows.
   *
   * An active step is dispatched again (a retry, or a resume after a crash). A
   * step that a live worker of another session runs is never dispatched: the
   * result is a stop. Otherwise the first step whose dependencies are all
   * satisfied becomes active and is claimed by this worker.
   *
   * Returns a dispatch with unitType "custom-step" and unitId in
   * "<workflowName>/<stepId>" format.
   */
  async resolveDispatch(
    state: EngineState,
    _context: { basePath: string },
  ): Promise<EngineDispatchAction> {
    const run = getCustomWorkflowRun(this.runId);
    if (!run) return this.resolveDispatchFromGraphFile();

    // Read the fence before the rows: a change by another session then fails
    // the operation below with a revision conflict.
    const fence = readDomainOperationFence();
    const graph = readCustomWorkflowGraph(run);
    const active = graph.steps.find((step) => step.status === "active");
    let action: EngineDispatchAction;
    if (active) {
      const owner = getCustomWorkflowStepClaim(this.runId, active.id);
      if (owner !== null && owner !== this.workerId && isAutoWorkerLive(owner)) {
        return {
          action: "stop",
          reason: `Workflow step "${active.id}" is running in another session (worker ${owner}).`,
          level: "error",
        };
      }
      if (owner !== this.workerId) {
        saveCustomWorkflowSteps({
          fence,
          operationType: "step.claim",
          runId: this.runId,
          stepId: active.id,
          graph,
          claimedBy: this.workerId,
        });
      }
      action = this.dispatchStep(graph, active);
    } else {
      const next = this.nextStep(graph);
      if (next.transition) {
        saveCustomWorkflowSteps({ fence, runId: this.runId, claimedBy: this.workerId, ...next.transition });
      }
      action = next.action;
    }
    renderRunDirectory(this.runDir, run);
    return action;
  }

  /** resolveDispatch for a run directory with no run row: GRAPH.yaml is the step state. */
  private async resolveDispatchFromGraphFile(): Promise<EngineDispatchAction> {
    return await withFileLock(join(this.runDir, "GRAPH.yaml"), () => {
      const graph = readGraph(this.runDir);
      const active = graph.steps.find((step) => step.status === "active");
      if (active) return this.dispatchStep(graph, active);

      const next = this.nextStep(graph);
      if (next.transition) writeGraph(this.runDir, next.transition.graph);
      return next.action;
    });
  }

  /**
   * Reconcile state after a step completes.
   *
   * Extracts the stepId from the completedStep's unitId (last segment after `/`)
   * and marks it complete. A step of a run with rows is completed only when its
   * newest verification result is a pass or carries a waiver.
   *
   * Returns "milestone-complete" when all steps are now done, "continue" otherwise.
   */
  async reconcile(
    state: EngineState,
    completedStep: CompletedStep,
  ): Promise<ReconcileResult> {
    // Extract stepId from "<workflowName>/<stepId>"
    const { milestone, slice, task } = parseUnitId(completedStep.unitId);
    const stepId = task ?? slice ?? milestone;

    const run = getCustomWorkflowRun(this.runId);
    let updatedGraph: WorkflowGraph;
    if (run) {
      const fence = readDomainOperationFence();
      const verification = getLatestCustomWorkflowStepVerification(this.runId, stepId);
      if (!verification || (verification.verdict !== "pass" && verification.waiverRationale === null)) {
        throw new Error(
          `Workflow step "${stepId}" cannot complete: its verification result is ${verification?.verdict ?? "missing"}`,
        );
      }
      updatedGraph = markStepComplete(readCustomWorkflowGraph(run), stepId);
      saveCustomWorkflowSteps({
        fence,
        operationType: "step.complete",
        runId: this.runId,
        stepId,
        graph: updatedGraph,
      });
      renderRunDirectory(this.runDir, run);
    } else {
      updatedGraph = await withFileLock(join(this.runDir, "GRAPH.yaml"), () => {
        // Re-read the graph from disk so we do not overwrite concurrent
        // workflow edits with a stale in-memory snapshot from deriveState().
        const updated = markStepComplete(readGraph(this.runDir), stepId);
        writeGraph(this.runDir, updated);
        return updated;
      });
    }

    const allDone = updatedGraph.steps.every(
      (s) => s.status === "complete" || s.status === "expanded",
    );

    return {
      outcome: allDone ? "milestone-complete" : "continue",
    };
  }

  /**
   * Return UI-facing metadata for progress display.
   *
   * Shows "Step N/M" progress where N = completed count and M = total.
   */
  getDisplayMetadata(state: EngineState): DisplayMetadata {
    const graph = state.raw as WorkflowGraph;
    const total = graph.steps.length;
    const completed = graph.steps.filter((s) => s.status === "complete").length;

    return {
      engineLabel: "WORKFLOW",
      currentPhase: state.phase,
      progressSummary: `Step ${completed}/${total}`,
      stepCount: { completed, total },
    };
  }
}
