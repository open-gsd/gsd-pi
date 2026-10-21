// Project/App: gsd-pi
// File Purpose: Atomic durable Milestone validation and evidence receipts.

import {
  executeDomainOperation,
  type DomainJsonValue,
  type DomainOperationResult,
} from "./db/domain-operation.js";
import { getDb } from "./db/engine.js";
import { readDomainOperationFence } from "./db/writers/lifecycle-commands.js";
import {
  writeMilestoneValidation,
  type InsertedMilestoneValidationVerdict,
  type MilestoneValidationEvidenceClass,
  type MilestoneValidationObservation,
  type MilestoneValidationVerdict,
  type PreparedMilestoneValidationCriterion,
  type ValidateMilestoneWriteInput,
  type ValidateMilestoneWriteResult,
} from "./db/writers/milestone-validation.js";
import type { ExecutionInvocation } from "./execution-invocation.js";

export interface MilestoneValidationCriterionInput {
  criterionKey: string;
  evidenceClass: MilestoneValidationEvidenceClass;
  description: string;
  required?: boolean;
  requirementId?: string;
}

export interface MilestoneValidationEvidenceInput {
  evidenceClass: MilestoneValidationEvidenceClass;
  commandOrTool: string;
  workingDirectory: string;
  startedAt: string;
  endedAt: string;
  exitCode?: number;
  observation: MilestoneValidationObservation;
  durableOutputRef: string;
  environment: { [key: string]: DomainJsonValue };
}

export interface ValidateMilestoneCriterionInput extends MilestoneValidationCriterionInput {
  verdict: MilestoneValidationVerdict;
  rationale: string;
  evidence: MilestoneValidationEvidenceInput[];
}

export interface ValidateMilestoneInput {
  invocation: ExecutionInvocation;
  milestoneId: string;
  testedSourceRevision: string;
  policyId: string;
  policyVersion: string;
  verdict: MilestoneValidationVerdict;
  rationale: string;
  outcome: "succeeded" | "failed" | "interrupted";
  failureClass: string;
  summary: string;
  output: DomainJsonValue;
  criteria: ValidateMilestoneCriterionInput[];
}

interface OperationReceipt {
  status: "committed" | "replayed";
  operationId: string;
  resultingRevision: number;
  resultingAuthorityEpoch: number;
  eventIds: string[];
  outboxIds: number[];
  projectionWorkIds: string[];
}

interface SubjectiveProofRow {
  criterion_id: string;
  human_acceptance_id: string | null;
  disposition: string | null;
}

export interface ValidateMilestoneReceipt extends OperationReceipt {
  milestoneId: string;
  lifecycleId: string;
  attemptId: string;
  attemptNumber: number;
  retryOfAttemptId: string | null;
  criteria: PreparedMilestoneValidationCriterion[];
  resultId: string;
  outcome: ValidateMilestoneInput["outcome"];
  endedAt: string;
  testedSourceRevision: string;
  verdict: MilestoneValidationVerdict;
  verdicts: InsertedMilestoneValidationVerdict[];
}

export interface MilestoneValidationReplaySource {
  aggregateRevision: string;
  targets: Array<{ id: string; revision: string }>;
}

function requireNonBlank(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${field} must not be blank`);
  return normalized;
}

function operationReceipt(operation: DomainOperationResult): OperationReceipt {
  return {
    status: operation.status,
    operationId: operation.operationId,
    resultingRevision: operation.resultingRevision,
    resultingAuthorityEpoch: operation.resultingAuthorityEpoch,
    eventIds: operation.eventIds,
    outboxIds: operation.outboxIds,
    projectionWorkIds: operation.projectionWorkIds,
  };
}

function storedEventPayload(operationId: string, eventType: string): Record<string, unknown> {
  const event = getDb().prepare(`
    SELECT payload_json
    FROM workflow_domain_events
    WHERE operation_id = :operation_id AND event_type = :event_type
  `).get({
    ":operation_id": operationId,
    ":event_type": eventType,
  }) as Record<string, unknown> | undefined;
  if (!event) throw new Error(`Milestone validation receipt is missing ${eventType}`);
  const payload = JSON.parse(String(event["payload_json"])) as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`Milestone validation receipt ${eventType} payload is invalid`);
  }
  return payload as Record<string, unknown>;
}

function invalidStoredReceipt(field: string): never {
  throw new Error(`Milestone validation stored receipt ${field} is invalid`);
}

function storedString(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    return invalidStoredReceipt(field);
  }
  return value;
}

function storedStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) =>
    typeof item !== "string" || item.trim().length === 0
  )) {
    return invalidStoredReceipt(field);
  }
  return value;
}

function storedCriteria(value: unknown): PreparedMilestoneValidationCriterion[] {
  if (!Array.isArray(value) || value.length === 0) {
    return invalidStoredReceipt("criteria");
  }
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return invalidStoredReceipt(`criteria[${index}]`);
    }
    const criterion = item as Record<string, unknown>;
    const evidenceClass = criterion["evidenceClass"];
    if (
      evidenceClass !== "command" && evidenceClass !== "runtime" &&
      evidenceClass !== "browser" && evidenceClass !== "artifact"
    ) {
      return invalidStoredReceipt(`criteria[${index}].evidenceClass`);
    }
    if (typeof criterion["required"] !== "boolean") {
      return invalidStoredReceipt(`criteria[${index}].required`);
    }
    const requirementId = criterion["requirementId"];
    if (requirementId !== undefined && (
      typeof requirementId !== "string" || requirementId.trim().length === 0
    )) {
      return invalidStoredReceipt(`criteria[${index}].requirementId`);
    }
    return {
      criterionId: storedString(criterion, "criterionId"),
      criterionKey: storedString(criterion, "criterionKey"),
      evidenceClass,
      required: criterion["required"],
      ...(typeof requirementId === "string" ? { requirementId } : {}),
    };
  });
}

function storedVerdicts(value: unknown): InsertedMilestoneValidationVerdict[] {
  if (!Array.isArray(value) || value.length === 0) {
    return invalidStoredReceipt("verdicts");
  }
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return invalidStoredReceipt(`verdicts[${index}]`);
    }
    const verdict = item as Record<string, unknown>;
    const value = verdict["verdict"];
    if (value !== "pass" && value !== "fail" && value !== "inconclusive") {
      return invalidStoredReceipt(`verdicts[${index}].verdict`);
    }
    return {
      criterionId: storedString(verdict, "criterionId"),
      verdictId: storedString(verdict, "verdictId"),
      verdict: value,
      evidenceIds: storedStringArray(verdict["evidenceIds"], `verdicts[${index}].evidenceIds`),
    };
  });
}

function storedCombinedValidation(
  operationId: string,
): Omit<ValidateMilestoneReceipt, keyof OperationReceipt> {
  const payload = storedEventPayload(operationId, "milestone.validation.recorded");
  const attemptNumber = payload["attemptNumber"];
  if (typeof attemptNumber !== "number" || !Number.isInteger(attemptNumber) || attemptNumber < 1) {
    return invalidStoredReceipt("attemptNumber");
  }
  const retryOfAttemptId = payload["retryOfAttemptId"];
  if (retryOfAttemptId !== null && (
    typeof retryOfAttemptId !== "string" || retryOfAttemptId.trim().length === 0
  )) {
    return invalidStoredReceipt("retryOfAttemptId");
  }
  const outcome = payload["outcome"];
  if (outcome !== "succeeded" && outcome !== "failed" && outcome !== "interrupted") {
    return invalidStoredReceipt("outcome");
  }
  const endedAt = storedString(payload, "endedAt");
  if (!Number.isFinite(Date.parse(endedAt))) return invalidStoredReceipt("endedAt");
  const verdict = payload["overallVerdict"];
  if (verdict !== "pass" && verdict !== "fail" && verdict !== "inconclusive") {
    return invalidStoredReceipt("overallVerdict");
  }
  return {
    milestoneId: storedString(payload, "milestoneId"),
    lifecycleId: storedString(payload, "lifecycleId"),
    attemptId: storedString(payload, "attemptId"),
    attemptNumber,
    retryOfAttemptId,
    criteria: storedCriteria(payload["criteria"]),
    resultId: storedString(payload, "resultId"),
    outcome,
    endedAt,
    testedSourceRevision: storedString(payload, "testedSourceRevision"),
    verdict,
    verdicts: storedVerdicts(payload["verdicts"]),
  };
}

export function readMilestoneValidationAggregateTimestamp(
  idempotencyKey: string,
): string | null {
  const row = getDb().prepare(`
    SELECT evidence.started_at
    FROM workflow_operations operation
    JOIN workflow_technical_verdicts verdict
      ON verdict.operation_id = operation.operation_id
     AND verdict.project_id = operation.project_id
    JOIN workflow_acceptance_criteria criterion
      ON criterion.criterion_id = verdict.criterion_id
     AND criterion.project_id = verdict.project_id
    JOIN workflow_verification_evidence evidence
      ON evidence.verdict_id = verdict.verdict_id
     AND evidence.project_id = verdict.project_id
    WHERE operation.idempotency_key = :idempotency_key
      AND operation.operation_type = 'milestone.validate'
      AND criterion.criterion_key = 'milestone-validation:aggregate'
    LIMIT 1
  `).get({ ":idempotency_key": idempotencyKey }) as Record<string, unknown> | undefined;
  return row ? String(row["started_at"]) : null;
}

export function readMilestoneValidationReplaySource(
  idempotencyKey: string,
): MilestoneValidationReplaySource | null {
  const row = getDb().prepare(`
    SELECT event.payload_json, result.output_json
    FROM workflow_operations operation
    JOIN workflow_domain_events event
      ON event.operation_id = operation.operation_id
     AND event.project_id = operation.project_id
     AND event.event_type = 'milestone.validation.recorded'
    JOIN workflow_attempt_results result
      ON result.result_id = json_extract(event.payload_json, '$.resultId')
     AND result.project_id = event.project_id
    WHERE operation.operation_type = 'milestone.validate'
      AND operation.idempotency_key = :idempotency_key
  `).get({ ":idempotency_key": idempotencyKey }) as Record<string, unknown> | undefined;
  if (!row) return null;
  const event = JSON.parse(String(row["payload_json"])) as Record<string, unknown>;
  const output = JSON.parse(String(row["output_json"])) as Record<string, unknown>;
  const aggregateRevision = event["testedSourceRevision"];
  const targets = output["sourceTargets"];
  if (typeof aggregateRevision !== "string" || !Array.isArray(targets)) {
    throw new Error("Milestone validation replay source binding is invalid");
  }
  const normalizedTargets = targets.map((target) => {
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      throw new Error("Milestone validation replay source target is invalid");
    }
    const value = target as Record<string, unknown>;
    if (typeof value["id"] !== "string" || typeof value["revision"] !== "string") {
      throw new Error("Milestone validation replay source target is invalid");
    }
    return { id: value["id"], revision: value["revision"] };
  });
  return { aggregateRevision, targets: normalizedTargets };
}

export function isCurrentMilestoneValidationOperation(
  operationId: string,
  milestoneId: string,
): boolean {
  const row = getDb().prepare(`
    SELECT event.operation_id,
           EXISTS (
             SELECT 1
             FROM workflow_operations superseding_operation
             JOIN workflow_domain_events superseding_event
               ON superseding_event.operation_id = superseding_operation.operation_id
              AND superseding_event.project_id = superseding_operation.project_id
             WHERE superseding_operation.operation_type = 'milestone.reopen'
               AND superseding_operation.resulting_revision > event.project_revision
               AND superseding_event.event_type = 'milestone.reopened'
               AND superseding_event.entity_type = 'milestone'
               AND superseding_event.entity_id = event.entity_id
           ) AS reopened
    FROM workflow_domain_events event
    JOIN workflow_operations operation
      ON operation.operation_id = event.operation_id
     AND operation.project_id = event.project_id
    WHERE event.event_type = 'milestone.validation.recorded'
      AND event.entity_type = 'milestone'
      AND event.entity_id = :milestone_id
      AND operation.operation_type = 'milestone.validate'
    ORDER BY event.project_revision DESC, event.event_index DESC, event.event_id DESC
    LIMIT 1
  `).get({ ":milestone_id": milestoneId }) as Record<string, unknown> | undefined;
  return row?.["operation_id"] === operationId && row["reopened"] === 0;
}

function currentRequiredSubjectiveProofs(
  lifecycleId: string,
  testedSourceRevision: string,
): SubjectiveProofRow[] {
  return getDb().prepare(`
    SELECT criterion.criterion_id,
           acceptance.human_acceptance_id,
           acceptance.disposition
    FROM workflow_acceptance_criteria criterion
    LEFT JOIN workflow_human_acceptances acceptance
      ON acceptance.project_id = criterion.project_id
     AND acceptance.lifecycle_id = criterion.lifecycle_id
     AND acceptance.criterion_id = criterion.criterion_id
     AND NOT EXISTS (
       SELECT 1 FROM workflow_human_acceptances successor
       WHERE successor.supersedes_human_acceptance_id = acceptance.human_acceptance_id
     )
     AND EXISTS (
       SELECT 1 FROM workflow_domain_events answered
       WHERE answered.operation_id = acceptance.operation_id
         AND answered.project_id = acceptance.project_id
         AND answered.event_type = 'milestone.subjective-uat.answered'
         AND json_extract(answered.payload_json, '$.humanAcceptanceId') = acceptance.human_acceptance_id
         AND json_extract(answered.payload_json, '$.testedSourceRevision') = :tested_source_revision
     )
     AND NOT EXISTS (
       SELECT 1 FROM workflow_domain_events prepared
       WHERE prepared.project_id = acceptance.project_id
         AND prepared.event_type = 'milestone.subjective-uat.prepared'
         AND json_extract(prepared.payload_json, '$.criterionId') = acceptance.criterion_id
         AND prepared.project_revision > acceptance.project_revision
     )
    WHERE criterion.lifecycle_id = :lifecycle_id
      AND criterion.criterion_kind = 'subjective_uat'
      AND criterion.required = 1
      AND NOT EXISTS (
        SELECT 1 FROM workflow_acceptance_criteria successor
        WHERE successor.supersedes_criterion_id = criterion.criterion_id
      )
    ORDER BY criterion.criterion_id
  `).all({
    ":lifecycle_id": lifecycleId,
    ":tested_source_revision": testedSourceRevision,
  }) as unknown as SubjectiveProofRow[];
}

export function validateMilestone(input: ValidateMilestoneInput): ValidateMilestoneReceipt {
  const milestoneId = requireNonBlank(input.milestoneId, "milestoneId");
  const testedSourceRevision = requireNonBlank(
    input.testedSourceRevision,
    "testedSourceRevision",
  );
  const policyId = requireNonBlank(input.policyId, "policyId");
  const policyVersion = requireNonBlank(input.policyVersion, "policyVersion");
  const rationale = requireNonBlank(input.rationale, "rationale");
  const failureClass = requireNonBlank(input.failureClass, "failureClass");
  const summary = requireNonBlank(input.summary, "summary");
  if (input.criteria.length === 0) {
    throw new Error("Milestone validation requires objective criteria");
  }
  const seen = new Set<string>();
  const criteria = input.criteria.map((criterion) => {
    const criterionKey = requireNonBlank(criterion.criterionKey, "criterionKey").toLowerCase();
    const description = requireNonBlank(criterion.description, "criterion description");
    const criterionRationale = requireNonBlank(criterion.rationale, "criterion rationale");
    const requirementId = criterion.requirementId === undefined
      ? undefined
      : requireNonBlank(criterion.requirementId, "requirementId");
    const identity = `${criterionKey}\u0000${requirementId ?? ""}`;
    if (seen.has(identity)) {
      throw new Error("Milestone validation criteria must not contain duplicates");
    }
    seen.add(identity);
    return {
      criterionKey,
      evidenceClass: criterion.evidenceClass,
      description,
      required: criterion.required ?? true,
      ...(requirementId ? { requirementId } : {}),
      verdict: criterion.verdict,
      rationale: criterionRationale,
      evidence: criterion.evidence,
    };
  }).sort((left, right) => {
    const leftKey = `${left.criterionKey}\u0000${left.requirementId ?? ""}`;
    const rightKey = `${right.criterionKey}\u0000${right.requirementId ?? ""}`;
    return leftKey.localeCompare(rightKey);
  });
  const writeInput: ValidateMilestoneWriteInput = {
    milestoneId,
    testedSourceRevision,
    policyId,
    policyVersion,
    verdict: input.verdict,
    outcome: input.outcome,
    failureClass,
    summary,
    output: input.output,
    criteria,
  };
  const payload: DomainJsonValue = {
    ...writeInput,
    rationale,
    criteria: criteria.map((criterion) => ({
      criterionKey: criterion.criterionKey,
      evidenceClass: criterion.evidenceClass,
      description: criterion.description,
      required: criterion.required,
      ...(criterion.requirementId ? { requirementId: criterion.requirementId } : {}),
      verdict: criterion.verdict,
      rationale: criterion.rationale,
      evidence: criterion.evidence.map((evidence) => ({
        evidenceClass: evidence.evidenceClass,
        commandOrTool: evidence.commandOrTool,
        workingDirectory: evidence.workingDirectory,
        startedAt: evidence.startedAt,
        endedAt: evidence.endedAt,
        ...(evidence.exitCode === undefined ? {} : { exitCode: evidence.exitCode }),
        observation: evidence.observation,
        durableOutputRef: evidence.durableOutputRef,
        environment: evidence.environment,
      })),
    })),
  };
  const fence = readDomainOperationFence(input.invocation.idempotencyKey);
  let written: ValidateMilestoneWriteResult | undefined;
  const operation = executeDomainOperation({
    operationType: "milestone.validate",
    idempotencyKey: input.invocation.idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: input.invocation.actorType,
    ...(input.invocation.actorId ? { actorId: input.invocation.actorId } : {}),
    sourceTransport: input.invocation.sourceTransport,
    ...(input.invocation.traceId ? { traceId: input.invocation.traceId } : {}),
    ...(input.invocation.turnId ? { turnId: input.invocation.turnId } : {}),
    payload,
  }, (context) => {
    written = writeMilestoneValidation(context, writeInput);
    const subjectiveProofs = currentRequiredSubjectiveProofs(
      written.lifecycleId,
      testedSourceRevision,
    );
    if (input.verdict === "pass") {
      const unsatisfied = subjectiveProofs.find((proof) =>
        !proof.human_acceptance_id || proof.disposition !== "accepted"
      );
      if (unsatisfied) {
        throw new Error(
          `Milestone validation pass requires accepted subjective UAT criterion ${unsatisfied.criterion_id}`,
        );
      }
    }
    const recordedSubjectiveProofs = subjectiveProofs.filter(
      (proof): proof is SubjectiveProofRow & { human_acceptance_id: string } =>
        proof.human_acceptance_id !== null,
    );
    return {
      events: [{
        eventType: "milestone.validation.recorded",
        entityType: "milestone",
        entityId: written.milestoneId,
        payload: {
          milestoneId: written.milestoneId,
          lifecycleId: written.lifecycleId,
          attemptId: written.attemptId,
          attemptNumber: written.attemptNumber,
          retryOfAttemptId: written.retryOfAttemptId,
          criteria: written.criteria.map((criterion) => ({ ...criterion })),
          resultId: written.resultId,
          outcome: written.outcome,
          endedAt: written.endedAt,
          testedSourceRevision,
          overallVerdict: written.verdict,
          policyId,
          policyVersion,
          rationale,
          criterionIds: [
            ...written.verdicts.map((verdict) => verdict.criterionId),
            ...recordedSubjectiveProofs.map((proof) => proof.criterion_id),
          ],
          verdictIds: written.verdicts.map((verdict) => verdict.verdictId),
          evidenceIds: written.verdicts.flatMap((verdict) => verdict.evidenceIds),
          humanAcceptanceIds: recordedSubjectiveProofs.map(
            (proof) => proof.human_acceptance_id,
          ),
          verdicts: written.verdicts.map((verdict) => ({
            criterionId: verdict.criterionId,
            verdictId: verdict.verdictId,
            verdict: verdict.verdict,
            evidenceIds: verdict.evidenceIds,
          })),
        },
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: `validation/${written.milestoneId}`.toLowerCase(),
        projectionKind: "milestone-validation",
        rendererVersion: "1",
      }],
    };
  });
  const stored = written ?? storedCombinedValidation(operation.operationId);
  return {
    ...operationReceipt(operation),
    milestoneId: stored.milestoneId,
    lifecycleId: stored.lifecycleId,
    attemptId: stored.attemptId,
    attemptNumber: stored.attemptNumber,
    retryOfAttemptId: stored.retryOfAttemptId,
    criteria: stored.criteria,
    resultId: stored.resultId,
    outcome: stored.outcome,
    endedAt: stored.endedAt,
    testedSourceRevision,
    verdict: stored.verdict,
    verdicts: stored.verdicts,
  };
}
