/**
 * definition-io.ts — Frozen definition read and run directory render.
 *
 * A custom workflow run is database rows (db/custom-workflow-runs.ts). The
 * files in the run directory are renders of those rows.
 *
 * Extracted from custom-workflow-engine.ts to break the circular dependency
 * between context-injector.ts and custom-workflow-engine.ts.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { noteRenderedProjectionFile } from "./compat/compat-marker.js";
import {
  customWorkflowRunId,
  getCustomWorkflowRun,
  readCustomWorkflowGraph,
  type CustomWorkflowRun,
} from "./db/custom-workflow-runs.js";
import type { WorkflowDefinition } from "./definition-loader.js";
import { writeGraph } from "./graph.js";

/** The definition frozen when the run was created. */
export function readFrozenDefinition(runDir: string): WorkflowDefinition {
  const run = getCustomWorkflowRun(customWorkflowRunId(runDir));
  if (run) return run.definition;
  // No run row: a run directory written before runs were database rows. It is
  // read from DEFINITION.yaml for one release.
  const defPath = join(runDir, "DEFINITION.yaml");
  const raw = readFileSync(defPath, "utf-8");
  return parse(raw, { schema: "core" }) as WorkflowDefinition;
}

/** Write DEFINITION.yaml, GRAPH.yaml and PARAMS.json of a run from its database rows. */
export function renderRunDirectory(runDir: string, run: CustomWorkflowRun): void {
  mkdirSync(runDir, { recursive: true });
  const files: Array<[string, string]> = [["DEFINITION.yaml", stringify(run.definition)]];
  if (run.params) files.push(["PARAMS.json", JSON.stringify(run.params, null, 2)]);
  for (const [name, content] of files) {
    writeFileSync(join(runDir, name), content, "utf-8");
    noteRenderedProjectionFile(join(runDir, name), content);
  }
  writeGraph(runDir, readCustomWorkflowGraph(run));
  const graphPath = join(runDir, "GRAPH.yaml");
  noteRenderedProjectionFile(graphPath, readFileSync(graphPath, "utf-8"));
}
