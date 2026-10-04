/**
 * run-manager.ts — Create and list isolated workflow runs.
 *
 * A run is database rows (db/custom-workflow-runs.ts): the run with its frozen
 * definition and one row per step. Each run also has a directory
 * `.gsd/workflow-runs/<name>/<timestamp>/` with renders of those rows:
 * - DEFINITION.yaml — the definition frozen at run-creation time
 * - GRAPH.yaml — the step graph
 * - PARAMS.json — (optional) parameter overrides used for this run
 * The step artifacts that the agent writes live in the same directory.
 *
 * A run directory with no run row was written before runs were database rows.
 * It is listed from its GRAPH.yaml, and `importRunDirectory` maps it to rows.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  customWorkflowRunId,
  getCustomWorkflowRun,
  listCustomWorkflowRuns,
  readCustomWorkflowGraph,
} from "./db/custom-workflow-runs.js";
import { insertCustomWorkflowRun } from "./db/writers/custom-workflow-runs.js";
import { readDomainOperationFence } from "./db/writers/lifecycle-commands.js";
import { readFrozenDefinition, renderRunDirectory } from "./definition-io.js";
import { loadDefinition, loadDefinitionFromFile, substituteParams } from "./definition-loader.js";
import { initializeGraph, readGraph } from "./graph.js";
import { isDbAvailable } from "./gsd-db.js";
import { resolvePlugin } from "./workflow-plugins.js";
import type { WorkflowDefinition } from "./definition-loader.js";
import type { WorkflowGraph } from "./graph.js";

// ─── Types ───────────────────────────────────────────────────────────────

export interface RunMetadata {
  /** Workflow definition name. */
  name: string;
  /** Filesystem-safe timestamp string used as dir name. */
  timestamp: string;
  /** Full path to the run directory. */
  runDir: string;
  /** Step counts of the run. */
  steps: { total: number; completed: number; pending: number; active: number };
  /** Overall status derived from step states. */
  status: "pending" | "running" | "complete";
}

// ─── Constants ───────────────────────────────────────────────────────────

const RUNS_DIR = "workflow-runs";
const DEFS_DIR = "workflow-defs";

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Generate a filesystem-safe timestamp: `YYYY-MM-DDTHH-MM-SS`.
 * Replaces colons with hyphens so the string is safe as a directory name
 * on all platforms (Windows forbids colons in paths).
 */
function makeTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/:/g, "-").replace(/\.\d{3}Z$/, "");
}

/**
 * Derive overall status from a graph's step statuses.
 */
function deriveStatus(graph: WorkflowGraph): "pending" | "running" | "complete" {
  const hasActive = graph.steps.some((s) => s.status === "active");
  const allDone = graph.steps.every(
    (s) => s.status === "complete" || s.status === "expanded",
  );
  if (allDone) return "complete";
  if (hasActive) return "running";
  return "pending";
}

/** List the sub-directories of a directory. */
function subDirectories(dir: string): string[] {
  return readdirSync(dir).filter((entry) => statSync(join(dir, entry)).isDirectory());
}

/** Create the run rows of a substituted definition and render its run directory. */
function createRunRows(
  basePath: string,
  defName: string,
  rawDef: WorkflowDefinition,
  overrides?: Record<string, string>,
): string {
  if (!isDbAvailable()) throw new Error("A workflow run requires the GSD database");
  const def = overrides ? substituteParams(rawDef, overrides) : substituteParams(rawDef);
  const timestamp = makeTimestamp();
  const runId = `${defName}/${timestamp}`;
  insertCustomWorkflowRun({
    fence: readDomainOperationFence(),
    operationType: "run.create",
    runId,
    definition: def,
    params: overrides && Object.keys(overrides).length > 0 ? overrides : null,
    graph: initializeGraph(def),
  });
  const runDir = join(basePath, ".gsd", RUNS_DIR, defName, timestamp);
  renderRunDirectory(runDir, getCustomWorkflowRun(runId)!);
  return runDir;
}

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Load the definition that a run of `defName` starts from.
 *
 * Resolution order:
 *   1. Plugin resolver (project → global → bundled), YAML format only.
 *   2. Legacy `.gsd/workflow-defs/<defName>.yaml`.
 *
 * @throws Error if no matching definition is found anywhere.
 */
export function loadRunDefinition(basePath: string, defName: string): WorkflowDefinition {
  // Try the unified plugin resolver first — honors project/global overrides.
  const plugin = resolvePlugin(basePath, defName);
  if (plugin && plugin.format === "yaml") return loadDefinitionFromFile(plugin.path);

  // Fall back to legacy `.gsd/workflow-defs/<defName>.yaml`.
  return loadDefinition(join(basePath, ".gsd", DEFS_DIR), defName);
}

/**
 * Create a new isolated run of a workflow definition (see `loadRunDefinition`).
 *
 * Writes the run rows and renders `<basePath>/.gsd/workflow-runs/<defName>/<timestamp>/`.
 *
 * @returns the run directory
 * @throws Error if no matching definition is found anywhere, or no database is open.
 */
export function createRun(
  basePath: string,
  defName: string,
  overrides?: Record<string, string>,
): string {
  return createRunRows(basePath, defName, loadRunDefinition(basePath, defName), overrides);
}

/**
 * Map a run directory that has no run row to database rows: the frozen
 * DEFINITION.yaml, the GRAPH.yaml step statuses and PARAMS.json. An unknown
 * step status fails loud.
 */
export function importRunDirectory(runDir: string): void {
  const fence = readDomainOperationFence();
  const graph = readGraph(runDir);
  const unknown = graph.steps.find((step) => !["pending", "active", "complete", "expanded"].includes(step.status));
  if (unknown) {
    throw new Error(`Cannot import ${runDir}: step "${unknown.id}" has unknown status "${unknown.status}"`);
  }
  const paramsPath = join(runDir, "PARAMS.json");
  insertCustomWorkflowRun({
    fence,
    operationType: "run.import",
    runId: customWorkflowRunId(runDir),
    definition: readFrozenDefinition(runDir),
    params: existsSync(paramsPath) ? JSON.parse(readFileSync(paramsPath, "utf-8")) as Record<string, string> : null,
    graph,
  });
}

/**
 * The run directory of a run to resume. `runId` is "<name>/<timestamp>". A run
 * directory with no run row is imported first.
 *
 * @throws Error when no such run exists.
 */
export function openRunForResume(basePath: string, runId: string): string {
  const segments = runId.split("/");
  if (segments.length !== 2 || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("name the run as <name>/<timestamp> (see /gsd workflow list)");
  }
  const runDir = join(basePath, ".gsd", RUNS_DIR, runId);
  if (!getCustomWorkflowRun(runId)) {
    if (!existsSync(join(runDir, "GRAPH.yaml"))) throw new Error("no such run (see /gsd workflow list)");
    importRunDirectory(runDir);
  }
  return runDir;
}

/**
 * List existing workflow runs with metadata.
 *
 * Step counts and status come from the run rows. A run directory with no run
 * row (written before runs were database rows) is listed from its GRAPH.yaml.
 *
 * @param basePath — project root directory
 * @param defName — optional filter: only list runs for this definition name
 * @returns Array of run metadata, sorted newest-first within each definition
 */
export function listRuns(basePath: string, defName?: string): RunMetadata[] {
  const runsRoot = join(basePath, ".gsd", RUNS_DIR);
  const graphs = new Map<string, WorkflowGraph>();
  for (const run of listCustomWorkflowRuns()) graphs.set(run.runId, readCustomWorkflowGraph(run));

  if (existsSync(runsRoot)) {
    for (const name of subDirectories(runsRoot)) {
      for (const timestamp of subDirectories(join(runsRoot, name))) {
        const runId = `${name}/${timestamp}`;
        if (graphs.has(runId)) continue;
        try {
          graphs.set(runId, readGraph(join(runsRoot, name, timestamp)));
        } catch {
          // Skip runs with invalid/missing GRAPH.yaml
        }
      }
    }
  }

  return [...graphs]
    .map(([runId, graph]): RunMetadata => {
      const [name, timestamp] = runId.split("/") as [string, string];
      return {
        name,
        timestamp,
        runDir: join(runsRoot, name, timestamp),
        steps: {
          total: graph.steps.length,
          completed: graph.steps.filter((s) => s.status === "complete").length,
          pending: graph.steps.filter((s) => s.status === "pending").length,
          active: graph.steps.filter((s) => s.status === "active").length,
        },
        status: deriveStatus(graph),
      };
    })
    .filter((run) => defName === undefined || run.name === defName)
    // Newest-first within each definition (ISO strings sort lexicographically)
    .sort((a, b) => a.name.localeCompare(b.name) || b.timestamp.localeCompare(a.timestamp));
}
