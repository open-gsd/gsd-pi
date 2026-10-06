/**
 * Reactive Task Graph — derives dependency edges from task plan IO signatures.
 *
 * Pure functions that build a DAG from task IO intersections and resolve
 * which tasks are currently ready for parallel dispatch. Used by the
 * reactive-execute dispatch path (ADR-004).
 *
 * Graph derivation and resolution functions are pure. The `loadSliceTaskIO`
 * loader at the bottom reads the task rows of the database. No function here
 * reads a file.
 */

import type { TaskIO, DerivedTaskNode } from "./types.js";
import { normalizePlannedFileReference } from "./files.js";
import { isDbAvailable } from "./gsd-db.js";
import { readSliceTasks } from "./db/lifecycle-read.js";

// ─── Graph Construction ───────────────────────────────────────────────────

/**
 * Build a dependency graph from task IO signatures.
 *
 * A task T_b depends on T_a when any of T_b's inputFiles appear in T_a's
 * outputFiles. Self-references are excluded.
 *
 * Tasks are returned in the same order as the input array.
 */
export function deriveTaskGraph(tasks: TaskIO[]): DerivedTaskNode[] {
  // Build output → producer lookup
  const outputToProducer = new Map<string, string[]>();
  for (const task of tasks) {
    for (const outFile of task.outputFiles) {
      const existing = outputToProducer.get(outFile);
      if (existing) {
        existing.push(task.id);
      } else {
        outputToProducer.set(outFile, [task.id]);
      }
    }
  }

  return tasks.map((task) => {
    const deps = new Set<string>();
    for (const inFile of task.inputFiles) {
      const producers = outputToProducer.get(inFile);
      if (producers) {
        for (const pid of producers) {
          if (pid !== task.id) deps.add(pid);
        }
      }
    }
    return {
      ...task,
      dependsOn: [...deps].sort(),
    };
  });
}

// ─── Ready Set Resolution ─────────────────────────────────────────────────

/**
 * Return task IDs whose dependencies are all in `completed`.
 * Excludes tasks that are already done or in-flight.
 */
export function getReadyTasks(
  graph: DerivedTaskNode[],
  completed: Set<string>,
  inFlight: Set<string>,
): string[] {
  return graph
    .filter((node) => {
      if (node.done || completed.has(node.id) || inFlight.has(node.id)) return false;
      return node.dependsOn.every((dep) => completed.has(dep));
    })
    .map((node) => node.id);
}

// ─── Conflict-Free Subset Selection ──────────────────────────────────────

/**
 * Greedy selection of non-conflicting tasks up to `maxParallel`.
 *
 * Two tasks conflict if they share any outputFile. We also exclude tasks
 * whose outputs overlap with `inFlightOutputs` (files being written by
 * tasks currently in progress).
 */
export function chooseNonConflictingSubset(
  readyIds: string[],
  graph: DerivedTaskNode[],
  maxParallel: number,
  inFlightOutputs: Set<string>,
): string[] {
  const nodeMap = new Map(graph.map((n) => [n.id, n]));
  const claimed = new Set(inFlightOutputs);
  const selected: string[] = [];

  for (const id of readyIds) {
    if (selected.length >= maxParallel) break;
    const node = nodeMap.get(id);
    if (!node) continue;

    // Check for output overlap with already-selected or in-flight
    const conflicts = node.outputFiles.some((f) => claimed.has(f));
    if (conflicts) continue;

    // Claim this task's outputs
    for (const f of node.outputFiles) claimed.add(f);
    selected.push(id);
  }

  return selected;
}

// ─── Graph Quality Checks ─────────────────────────────────────────────────

/**
 * Returns true if any incomplete task has 0 inputFiles AND 0 outputFiles.
 *
 * An ambiguous graph means IO annotations are too sparse to derive reliable
 * edges — the dispatcher should fall back to sequential execution.
 */
export function isGraphAmbiguous(graph: DerivedTaskNode[]): boolean {
  return graph.some(
    (node) =>
      !node.done &&
      node.inputFiles.length === 0 &&
      node.outputFiles.length === 0,
  );
}

/**
 * Returns tasks that are missing IO annotations (no inputFiles and no outputFiles).
 * These tasks prevent parallel dispatch by making the graph ambiguous.
 * Used to surface actionable diagnostics when parallel execution falls back to sequential.
 */
export function getMissingAnnotationTasks(
  graph: DerivedTaskNode[],
): Array<{ id: string; title: string }> {
  return graph
    .filter(
      (node) =>
        !node.done &&
        node.inputFiles.length === 0 &&
        node.outputFiles.length === 0,
    )
    .map((node) => ({ id: node.id, title: node.title }));
}

/**
 * Detect deadlock: no tasks are ready and none are in-flight, yet incomplete
 * tasks remain. This indicates a circular dependency or impossible state.
 */
export function detectDeadlock(
  graph: DerivedTaskNode[],
  completed: Set<string>,
  inFlight: Set<string>,
): boolean {
  const incomplete = graph.filter(
    (n) => !n.done && !completed.has(n.id) && !inFlight.has(n.id),
  );
  if (incomplete.length === 0) return false; // all done
  if (inFlight.size > 0) return false; // something is running, wait for it

  // Nothing in flight, but incomplete tasks remain — check if any are ready
  const ready = getReadyTasks(graph, completed, inFlight);
  return ready.length === 0;
}

// ─── Graph Metrics ────────────────────────────────────────────────────────

/** Compute summary metrics for logging. */
export function graphMetrics(graph: DerivedTaskNode[]): {
  taskCount: number;
  edgeCount: number;
  readySetSize: number;
  ambiguous: boolean;
} {
  const completed = new Set(graph.filter((n) => n.done).map((n) => n.id));
  const ready = getReadyTasks(graph, completed, new Set());
  const edgeCount = graph.reduce((sum, n) => sum + n.dependsOn.length, 0);

  return {
    taskCount: graph.length,
    edgeCount,
    readySetSize: ready.length,
    ambiguous: isGraphAmbiguous(graph),
  };
}

// ─── IO Loader (database) ─────────────────────────────────────────────────

/** The planned file references of a task row that name a file path. */
function plannedFilePaths(references: string[]): string[] {
  return references
    .map(normalizePlannedFileReference)
    // A file path has at least one dot or slash; `true` or `None` is not one.
    .filter((path) => path.includes("/") || path.includes("\\") || path.includes("."));
}

/**
 * Load TaskIO for all tasks in a slice from the task rows: the planned inputs,
 * and the planned expected output (the planned files when a task names no
 * expected output). PLAN files are projections and are not read.
 *
 * Returns [] when no database is open or the slice has no task rows.
 */
export function loadSliceTaskIO(mid: string, sid: string): TaskIO[] {
  if (!isDbAvailable()) return [];
  return readSliceTasks(mid, sid).map((task) => ({
    id: task.id,
    title: task.title,
    inputFiles: plannedFilePaths(task.inputs),
    outputFiles: plannedFilePaths(task.expected_output.length > 0 ? task.expected_output : task.files),
    done: task.done,
  }));
}
