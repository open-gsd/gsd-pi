// gsd-pi + Custom workflow runs as database rows (ADR-046)
//
// A custom workflow run is a custom_workflow_runs row (with the definition
// frozen at creation) plus one custom_workflow_steps row per step. The files in
// the run directory are renders of these rows.
//
// This module reads the rows. db/writers/custom-workflow-runs.ts writes them.

import { basename, dirname } from "node:path";

import { getDbOrNull } from "./engine.js";
import type { WorkflowDefinition } from "../definition-loader.js";
import type { GraphStep, WorkflowGraph } from "../graph.js";

export interface CustomWorkflowRun {
  runId: string;
  name: string;
  definition: WorkflowDefinition;
  params: Record<string, string> | null;
  createdAt: string;
}

export interface CustomWorkflowStepVerification {
  verdict: "pass" | "fail" | "inconclusive";
  evidence: Record<string, unknown>;
  waiverRationale: string | null;
}

/** The run id of a run directory: "<name>/<timestamp>", its path under .gsd/workflow-runs. */
export function customWorkflowRunId(runDir: string): string {
  return `${basename(dirname(runDir))}/${basename(runDir)}`;
}

function runFromRow(row: Record<string, unknown>): CustomWorkflowRun {
  return {
    runId: String(row["run_id"]),
    name: String(row["name"]),
    definition: JSON.parse(String(row["definition_json"])) as WorkflowDefinition,
    params: typeof row["params_json"] === "string"
      ? JSON.parse(row["params_json"]) as Record<string, string>
      : null,
    createdAt: String(row["created_at"]),
  };
}

/** The run row, or null when the run has no row or no database is open. */
export function getCustomWorkflowRun(runId: string): CustomWorkflowRun | null {
  const row = getDbOrNull()?.prepare(
    "SELECT run_id, name, definition_json, params_json, created_at FROM custom_workflow_runs WHERE run_id = :run_id",
  ).get({ ":run_id": runId });
  return row == null ? null : runFromRow(row);
}

/** Every run that has a row. */
export function listCustomWorkflowRuns(): CustomWorkflowRun[] {
  const rows = getDbOrNull()?.prepare(
    "SELECT run_id, name, definition_json, params_json, created_at FROM custom_workflow_runs",
  ).all() ?? [];
  return rows.map(runFromRow);
}

/** The step graph of a run in step order. */
export function readCustomWorkflowGraph(run: CustomWorkflowRun): WorkflowGraph {
  const rows = getDbOrNull()?.prepare(
    `SELECT step_id, title, status, prompt, depends_on_json, parent_step_id, started_at, finished_at
     FROM custom_workflow_steps
     WHERE run_id = :run_id
     ORDER BY position`,
  ).all({ ":run_id": run.runId }) ?? [];
  return {
    steps: rows.map((row) => ({
      id: String(row["step_id"]),
      title: String(row["title"]),
      status: row["status"] as GraphStep["status"],
      prompt: String(row["prompt"]),
      dependsOn: JSON.parse(String(row["depends_on_json"])) as string[],
      ...(row["parent_step_id"] != null ? { parentStepId: String(row["parent_step_id"]) } : {}),
      ...(row["started_at"] != null ? { startedAt: String(row["started_at"]) } : {}),
      ...(row["finished_at"] != null ? { finishedAt: String(row["finished_at"]) } : {}),
    })),
    metadata: { name: run.name, createdAt: run.createdAt },
  };
}

/** How many verification retries the step has used. */
export function getCustomWorkflowStepVerifyRetries(runId: string, stepId: string): number {
  const row = getDbOrNull()?.prepare(
    "SELECT verify_retries FROM custom_workflow_steps WHERE run_id = :run_id AND step_id = :step_id",
  ).get({ ":run_id": runId, ":step_id": stepId });
  return Number(row?.["verify_retries"] ?? 0);
}

/** The newest verification result of the step, or null when it was never verified. */
export function getLatestCustomWorkflowStepVerification(
  runId: string,
  stepId: string,
): CustomWorkflowStepVerification | null {
  const row = getDbOrNull()?.prepare(
    `SELECT verdict, evidence_json, waiver_rationale
     FROM custom_workflow_step_verifications
     WHERE run_id = :run_id AND step_id = :step_id
     ORDER BY id DESC
     LIMIT 1`,
  ).get({ ":run_id": runId, ":step_id": stepId });
  if (row == null) return null;
  return {
    verdict: row["verdict"] as CustomWorkflowStepVerification["verdict"],
    evidence: JSON.parse(String(row["evidence_json"])) as Record<string, unknown>,
    waiverRationale: typeof row["waiver_rationale"] === "string" ? row["waiver_rationale"] : null,
  };
}
