// Project/App: gsd-pi
// File Purpose: Single-writer layer for custom workflow runs (ADR-046). Owns the
// write SQL of the custom_workflow_* tables; db/custom-workflow-runs.ts reads them.

import { randomUUID } from "node:crypto";

import {
  executeDomainOperation,
  type DomainJsonValue,
  type DomainOperationContext,
} from "../domain-operation.js";
import { getDb } from "../engine.js";
import type { DomainOperationFence } from "./lifecycle-commands.js";
import type { WorkflowDefinition } from "../../definition-loader.js";
import type { WorkflowGraph } from "../../graph.js";

/** Projection Work kind of a run directory render (GRAPH.yaml, DEFINITION.yaml, PARAMS.json). */
export const CUSTOM_WORKFLOW_RUN_PROJECTION_KIND = "custom-workflow-run";

/**
 * Run one custom workflow Domain Operation. `fence` must be read before the
 * rows the caller decided on, so a change by another session fails the
 * operation with a revision conflict instead of being overwritten. Each call
 * has its own idempotency key: a second caller that read the same revision
 * gets that conflict, never a replay of the first caller's operation.
 */
function runOperation(
  fence: DomainOperationFence,
  operationType: string,
  runId: string,
  payload: { [key: string]: DomainJsonValue },
  write: (context: Readonly<DomainOperationContext>) => void,
  actorType: "system" | "user" = "system",
): void {
  executeDomainOperation({
    operationType: `custom_workflow.${operationType}`,
    idempotencyKey: `custom_workflow.${operationType}/${runId}/${randomUUID()}`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType,
    sourceTransport: "internal",
    payload: { runId, ...payload },
  }, (context) => {
    write(context);
    return {
      events: [{
        eventType: `custom_workflow.${operationType}`,
        entityType: "custom-workflow-run",
        entityId: runId,
        payload,
        destinations: ["projection"],
      }],
      projections: [{
        // Projection keys are lowercase; the renderer matches the run id without case.
        projectionKey: `${CUSTOM_WORKFLOW_RUN_PROJECTION_KIND}/${runId.toLowerCase()}`,
        projectionKind: CUSTOM_WORKFLOW_RUN_PROJECTION_KIND,
        rendererVersion: "1",
      }],
    };
  });
}

function upsertSteps(runId: string, graph: WorkflowGraph): void {
  const statement = getDb().prepare(
    `INSERT INTO custom_workflow_steps
       (run_id, step_id, position, title, status, prompt, depends_on_json, parent_step_id, started_at, finished_at)
     VALUES
       (:run_id, :step_id, :position, :title, :status, :prompt, :depends_on_json, :parent_step_id, :started_at, :finished_at)
     ON CONFLICT (run_id, step_id) DO UPDATE SET
       position = excluded.position,
       title = excluded.title,
       status = excluded.status,
       prompt = excluded.prompt,
       depends_on_json = excluded.depends_on_json,
       parent_step_id = excluded.parent_step_id,
       started_at = excluded.started_at,
       finished_at = excluded.finished_at`,
  );
  graph.steps.forEach((step, position) => {
    statement.run({
      ":run_id": runId,
      ":step_id": step.id,
      ":position": position,
      ":title": step.title,
      ":status": step.status,
      ":prompt": step.prompt,
      ":depends_on_json": JSON.stringify(step.dependsOn),
      ":parent_step_id": step.parentStepId ?? null,
      ":started_at": step.startedAt ?? null,
      ":finished_at": step.finishedAt ?? null,
    });
  });
}

/** Create the run row and its step rows. `operationType` is "run.create" or "run.import". */
export function insertCustomWorkflowRun(input: {
  fence: DomainOperationFence;
  operationType: "run.create" | "run.import";
  runId: string;
  definition: WorkflowDefinition;
  params: Record<string, string> | null;
  graph: WorkflowGraph;
}): void {
  runOperation(input.fence, input.operationType, input.runId, { name: input.graph.metadata.name }, (context) => {
    getDb().prepare(
      `INSERT INTO custom_workflow_runs (run_id, name, definition_json, params_json, created_at, operation_id)
       VALUES (:run_id, :name, :definition_json, :params_json, :created_at, :operation_id)`,
    ).run({
      ":run_id": input.runId,
      ":name": input.graph.metadata.name,
      ":definition_json": JSON.stringify(input.definition),
      ":params_json": input.params ? JSON.stringify(input.params) : null,
      ":created_at": input.graph.metadata.createdAt,
      ":operation_id": context.operationId,
    });
    upsertSteps(input.runId, input.graph);
  });
}

/** Store the step graph of a run after the transition of one step. */
export function saveCustomWorkflowSteps(input: {
  fence: DomainOperationFence;
  operationType: "step.activate" | "step.expand" | "step.complete";
  runId: string;
  stepId: string;
  graph: WorkflowGraph;
}): void {
  runOperation(input.fence, input.operationType, input.runId, { stepId: input.stepId }, () => {
    upsertSteps(input.runId, input.graph);
  });
}

interface StepVerificationRow {
  runId: string;
  stepId: string;
  verdict: "pass" | "fail" | "inconclusive";
  evidence: { [key: string]: DomainJsonValue };
  waiverRationale: string | null;
}

function insertVerificationRow(row: StepVerificationRow, operationId: string): void {
  getDb().prepare(
    `INSERT INTO custom_workflow_step_verifications
       (run_id, step_id, verdict, evidence_json, waiver_rationale, recorded_at, operation_id)
     VALUES
       (:run_id, :step_id, :verdict, :evidence_json, :waiver_rationale, :recorded_at, :operation_id)`,
  ).run({
    ":run_id": row.runId,
    ":step_id": row.stepId,
    ":verdict": row.verdict,
    ":evidence_json": JSON.stringify(row.evidence),
    ":waiver_rationale": row.waiverRationale,
    ":recorded_at": new Date().toISOString(),
    ":operation_id": operationId,
  });
}

/** Record one verification result of a step as an evidence row. */
export function insertCustomWorkflowStepVerification(input: StepVerificationRow & {
  fence: DomainOperationFence;
}): void {
  const payload = { stepId: input.stepId, verdict: input.verdict, waived: input.waiverRationale !== null };
  runOperation(input.fence, "step.verify", input.runId, payload, (context) => {
    insertVerificationRow(input, context.operationId);
  });
}

/**
 * Record the approval of the operator (/gsd workflow approve) as a `pass`
 * evidence row and store the graph with the step complete, in one operation:
 * a process that dies cannot leave an approved step active.
 */
export function approveCustomWorkflowStep(input: {
  fence: DomainOperationFence;
  runId: string;
  stepId: string;
  evidence: { [key: string]: DomainJsonValue };
  graph: WorkflowGraph;
}): void {
  runOperation(input.fence, "step.approve", input.runId, { stepId: input.stepId }, (context) => {
    insertVerificationRow({ ...input, verdict: "pass", waiverRationale: null }, context.operationId);
    upsertSteps(input.runId, input.graph);
  }, "user");
}

/** Set the verification retries a step has used. */
export function setCustomWorkflowStepVerifyRetries(input: {
  fence: DomainOperationFence;
  runId: string;
  stepId: string;
  used: number;
}): void {
  runOperation(input.fence, "step.retry", input.runId, { stepId: input.stepId, used: input.used }, () => {
    getDb().prepare(
      "UPDATE custom_workflow_steps SET verify_retries = :used WHERE run_id = :run_id AND step_id = :step_id",
    ).run({ ":run_id": input.runId, ":step_id": input.stepId, ":used": input.used });
  });
}
