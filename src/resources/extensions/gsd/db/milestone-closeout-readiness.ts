// Project/App: gsd-pi
// File Purpose: Deterministic DB-only Milestone closeout readiness query.

import { getDb, getDbOrNull } from "./engine.js";
import { compareLifecycleShadow } from "./lifecycle-shadow-comparison.js";

export interface MilestoneCloseoutReadinessInput {
  milestoneId: string;
  sourceRevision?: string;
}

export type MilestoneCloseoutBlocker =
  | { kind: "validation-missing" }
  | { kind: "validation-receipt-invalid"; fields: string[] }
  | { kind: "validation-not-pass"; overallVerdict: string }
  | {
    kind: "validation-source-revision-mismatch";
    expectedSourceRevision: string;
    testedSourceRevision: string;
  }
  | { kind: "criterion-unsatisfied"; criterionId: string; criterionKey: string }
  | {
    kind: "source-revision-mismatch";
    criterionId: string;
    criterionKey: string;
    expectedSourceRevision: string;
    testedSourceRevision: string | null;
  }
  | {
    kind: "validation-stale";
    validationRevision: number;
    descendantRevision: number;
  }
  | {
    kind: "validation-attempt-newer";
    attemptId: string;
    attemptState: string;
    attemptRevision: number;
  };

export type MilestoneCloseoutReadiness =
  | {
    ready: true;
    validationEventId: string;
    validationRevision: number;
  }
  | {
    ready: false;
    validationEventId?: string;
    validationRevision?: number;
    blockers: MilestoneCloseoutBlocker[];
  };

export type MilestoneCloseoutAuthorization =
  | {
    authorized: true;
    kind: "validated" | "waived";
    eventId: string;
    revision: number;
    testedSourceRevision: string;
    waiverId?: string;
  }
  | {
    authorized: false;
    blockers: MilestoneCloseoutBlocker[];
  };

interface ValidationRow {
  event_id: string;
  operation_id: string;
  project_id: string;
  project_revision: number;
  payload_json: string;
}

interface ValidationBundle {
  milestoneId: string;
  lifecycleId: string;
  attemptId: string;
  resultId: string;
  overallVerdict: string;
  testedSourceRevision: string;
  policyId: string;
  policyVersion: string;
  criterionIds: Set<string>;
  verdictIds: Set<string>;
  evidenceIds: Set<string>;
  humanAcceptanceIds: Set<string>;
}

interface CriterionRow {
  criterion_id: string;
  criterion_key: string;
  criterion_kind: "technical" | "subjective_uat";
  technical_verdict: string | null;
  technical_observation: string | null;
  tested_source_revision: string | null;
  human_disposition: string | null;
}

interface TechnicalProofRow {
  verdict_id: string;
  criterion_id: string;
  policy_id: string;
  policy_version: string;
}

interface EvidenceProofRow {
  evidence_id: string;
}

interface HumanProofRow {
  human_acceptance_id: string;
  criterion_id: string;
}

interface AttemptRow {
  result_id: string;
  outcome: string;
}

interface NewerAttemptRow {
  attempt_id: string;
  attempt_state: string;
  attempt_revision: number;
}

interface ValidationWaiverRow {
  waiver_id: string;
  event_id: string;
  project_revision: number;
  payload_json: string;
}

export function readMilestoneLifecycleStatus(milestoneId: string): string | null {
  const row = getDb().prepare(`
    SELECT lifecycle.lifecycle_status
    FROM workflow_item_lifecycles lifecycle
    JOIN project_authority authority
      ON authority.project_id = lifecycle.project_id
     AND authority.singleton = 1
    WHERE lifecycle.item_kind = 'milestone'
      AND lifecycle.milestone_id = :milestone_id
      AND lifecycle.slice_id IS NULL
      AND lifecycle.task_id IS NULL
  `).get({ ":milestone_id": milestoneId });
  return typeof row?.["lifecycle_status"] === "string"
    ? row["lifecycle_status"]
    : null;
}

export function isMilestoneLifecycleAdopted(milestoneId: string): boolean {
  return readMilestoneLifecycleStatus(milestoneId) !== null;
}

export type MilestoneMergeObservation =
  | { kind: "unavailable" }
  | { kind: "unadopted" }
  | { kind: "completed"; legacyStatus: string; canonicalStatus: string }
  | { kind: "not-completed" | "mismatch"; legacyStatus: string; canonicalStatus: string };

export function readMilestoneMergeObservation(milestoneId: string): MilestoneMergeObservation {
  const db = getDbOrNull();
  if (!db) return { kind: "unavailable" };
  const row = db.prepare(`
    SELECT milestone.status AS legacy_status, lifecycle.lifecycle_status AS canonical_status
    FROM milestones milestone
    LEFT JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.milestone_id = milestone.id
     AND lifecycle.item_kind = 'milestone'
     AND lifecycle.slice_id IS NULL
     AND lifecycle.task_id IS NULL
     AND lifecycle.project_id = (
       SELECT project_id FROM project_authority WHERE singleton = 1
     )
    WHERE milestone.id = :milestone_id
  `).get({ ":milestone_id": milestoneId });
  const legacyStatus = typeof row?.["legacy_status"] === "string" ? row["legacy_status"] : null;
  const canonicalStatus = typeof row?.["canonical_status"] === "string" ? row["canonical_status"] : null;
  if (!canonicalStatus) return { kind: "unadopted" };
  if (legacyStatus === null) {
    return { kind: "mismatch", legacyStatus: "missing", canonicalStatus };
  }
  const shadow = compareLifecycleShadow(legacyStatus, canonicalStatus);
  if (shadow.kind !== "match" && shadow.kind !== "semantic_match_exact_delta") {
    return {
      kind: "mismatch",
      legacyStatus,
      canonicalStatus,
    };
  }
  if (shadow.normalizedLegacyStatus === "completed" && canonicalStatus === "completed") {
    return { kind: "completed", legacyStatus, canonicalStatus };
  }
  return { kind: "not-completed", legacyStatus, canonicalStatus };
}

function stringIdSet(payload: Record<string, unknown>, field: string): Set<string> | null {
  const value = payload[field];
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || id.length === 0)) {
    return null;
  }
  const ids = new Set(value as string[]);
  return ids.size === value.length ? ids : null;
}

function validationBundle(payloadJson: string): {
  bundle?: ValidationBundle;
  invalidFields: string[];
} {
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(payloadJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { invalidFields: ["payload"] };
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    return { invalidFields: ["payload"] };
  }

  const idFields = ["criterionIds", "verdictIds", "evidenceIds", "humanAcceptanceIds"];
  const idSets = idFields.map((field) => stringIdSet(payload, field));
  const invalidFields = idFields.filter((_, index) => idSets[index] === null);
  const stringFields = [
    "milestoneId",
    "lifecycleId",
    "attemptId",
    "resultId",
    "testedSourceRevision",
    "policyId",
    "policyVersion",
  ];
  for (const field of stringFields) {
    if (typeof payload[field] !== "string" || payload[field].trim().length === 0) {
      invalidFields.push(field);
    }
  }
  if (!new Set(["pass", "fail", "inconclusive"]).has(payload["overallVerdict"] as string)) {
    invalidFields.push("overallVerdict");
  }
  if (invalidFields.length > 0) return { invalidFields };
  return {
    bundle: {
      milestoneId: payload["milestoneId"] as string,
      lifecycleId: payload["lifecycleId"] as string,
      attemptId: payload["attemptId"] as string,
      resultId: payload["resultId"] as string,
      overallVerdict: payload["overallVerdict"] as string,
      testedSourceRevision: payload["testedSourceRevision"] as string,
      policyId: payload["policyId"] as string,
      policyVersion: payload["policyVersion"] as string,
      criterionIds: idSets[0]!,
      verdictIds: idSets[1]!,
      evidenceIds: idSets[2]!,
      humanAcceptanceIds: idSets[3]!,
    },
    invalidFields: [],
  };
}

function sameIds(expected: Set<string>, actual: Set<string>): boolean {
  return expected.size === actual.size && [...expected].every((id) => actual.has(id));
}

function receiptBindingInvalidFields(
  validation: ValidationRow,
  bundle: ValidationBundle,
  milestoneId: string,
): string[] {
  const invalidFields: string[] = [];
  if (bundle.milestoneId !== milestoneId) invalidFields.push("milestoneId");

  const attempt = getDb().prepare(`
    SELECT result.result_id, result.outcome
    FROM workflow_execution_attempts attempt
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.lifecycle_id = attempt.lifecycle_id
     AND lifecycle.project_id = attempt.project_id
    JOIN workflow_attempt_results result
      ON result.attempt_id = attempt.attempt_id
     AND result.lifecycle_id = attempt.lifecycle_id
     AND result.project_id = attempt.project_id
    JOIN workflow_operations result_operation
      ON result_operation.operation_id = result.operation_id
     AND result_operation.project_id = result.project_id
    WHERE attempt.project_id = :project_id
      AND attempt.lifecycle_id = :lifecycle_id
      AND attempt.attempt_id = :attempt_id
      AND attempt.attempt_state = 'settled'
      AND lifecycle.item_kind = 'milestone'
      AND lifecycle.milestone_id = :milestone_id
      AND lifecycle.slice_id IS NULL
      AND lifecycle.task_id IS NULL
      AND (
        result.project_revision < :validation_revision OR (
          result.project_revision = :validation_revision
          AND result.operation_id = :validation_operation_id
          AND result_operation.operation_type = 'milestone.validate'
        )
      )
  `).get({
    ":project_id": validation.project_id,
    ":lifecycle_id": bundle.lifecycleId,
    ":attempt_id": bundle.attemptId,
    ":milestone_id": milestoneId,
    ":validation_revision": validation.project_revision,
    ":validation_operation_id": validation.operation_id,
  }) as unknown as AttemptRow | undefined;
  if (!attempt) invalidFields.push("attemptId");
  if (!attempt || attempt.result_id !== bundle.resultId) invalidFields.push("resultId");
  if (bundle.overallVerdict === "pass" && attempt?.outcome !== "succeeded") {
    if (!invalidFields.includes("resultId")) invalidFields.push("resultId");
  }

  const technicalProofs = getDb().prepare(`
    SELECT verdict_id, criterion_id, policy_id, policy_version
    FROM workflow_technical_verdicts
    WHERE project_id = :project_id
      AND operation_id = :operation_id
      AND lifecycle_id = :lifecycle_id
      AND attempt_id = :attempt_id
      AND tested_source_revision = :source_revision
  `).all({
    ":project_id": validation.project_id,
    ":operation_id": validation.operation_id,
    ":lifecycle_id": bundle.lifecycleId,
    ":attempt_id": bundle.attemptId,
    ":source_revision": bundle.testedSourceRevision,
  }) as unknown as TechnicalProofRow[];
  const verdictIds = new Set(technicalProofs.map((proof) => proof.verdict_id));
  if (!sameIds(bundle.verdictIds, verdictIds)) invalidFields.push("verdictIds");
  if (technicalProofs.some((proof) => proof.policy_id !== bundle.policyId)) {
    invalidFields.push("policyId");
  }
  if (technicalProofs.some((proof) => proof.policy_version !== bundle.policyVersion)) {
    invalidFields.push("policyVersion");
  }

  const evidence = getDb().prepare(`
    SELECT evidence_id
    FROM workflow_verification_evidence
    WHERE project_id = :project_id
      AND operation_id = :operation_id
      AND lifecycle_id = :lifecycle_id
      AND attempt_id = :attempt_id
      AND source_revision = :source_revision
  `).all({
    ":project_id": validation.project_id,
    ":operation_id": validation.operation_id,
    ":lifecycle_id": bundle.lifecycleId,
    ":attempt_id": bundle.attemptId,
    ":source_revision": bundle.testedSourceRevision,
  }) as unknown as EvidenceProofRow[];
  const evidenceIds = new Set(evidence.map((proof) => proof.evidence_id));
  if (!sameIds(bundle.evidenceIds, evidenceIds)) invalidFields.push("evidenceIds");

  const humanProofs = bundle.humanAcceptanceIds.size === 0
    ? []
    : getDb().prepare(`
      SELECT acceptance.human_acceptance_id, acceptance.criterion_id
      FROM workflow_human_acceptances acceptance
      JOIN workflow_domain_events answered
        ON answered.operation_id = acceptance.operation_id
       AND answered.project_id = acceptance.project_id
       AND answered.event_type = 'milestone.subjective-uat.answered'
       AND json_extract(answered.payload_json, '$.humanAcceptanceId') = acceptance.human_acceptance_id
       AND json_extract(answered.payload_json, '$.testedSourceRevision') = :source_revision
      WHERE acceptance.project_id = :project_id
        AND acceptance.lifecycle_id = :lifecycle_id
        AND acceptance.project_revision < :validation_revision
        AND acceptance.human_acceptance_id IN (
          SELECT value FROM json_each(:acceptance_ids)
        )
        AND NOT EXISTS (
          SELECT 1 FROM workflow_human_acceptances successor
          WHERE successor.supersedes_human_acceptance_id = acceptance.human_acceptance_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM workflow_domain_events prepared
          WHERE prepared.project_id = acceptance.project_id
            AND prepared.event_type = 'milestone.subjective-uat.prepared'
            AND json_extract(prepared.payload_json, '$.criterionId') = acceptance.criterion_id
            AND prepared.project_revision > acceptance.project_revision
        )
    `).all({
      ":project_id": validation.project_id,
      ":lifecycle_id": bundle.lifecycleId,
      ":validation_revision": validation.project_revision,
      ":source_revision": bundle.testedSourceRevision,
      ":acceptance_ids": JSON.stringify([...bundle.humanAcceptanceIds]),
    }) as unknown as HumanProofRow[];
  const humanAcceptanceIds = new Set(humanProofs.map((proof) => proof.human_acceptance_id));
  if (!sameIds(bundle.humanAcceptanceIds, humanAcceptanceIds)) {
    invalidFields.push("humanAcceptanceIds");
  }

  const criterionIds = new Set([
    ...technicalProofs.map((proof) => proof.criterion_id),
    ...humanProofs.map((proof) => proof.criterion_id),
  ]);
  if (!sameIds(bundle.criterionIds, criterionIds)) invalidFields.unshift("criterionIds");
  return invalidFields;
}

function currentCriteria(
  milestoneId: string,
  payloadJson: string,
  validation: ValidationRow,
  bundle: ValidationBundle,
): CriterionRow[] {
  return getDb().prepare(`
    WITH current_criteria AS (
      SELECT criterion.criterion_id, criterion.criterion_key, criterion.criterion_kind
      FROM workflow_acceptance_criteria criterion
      JOIN workflow_item_lifecycles lifecycle
        ON lifecycle.lifecycle_id = criterion.lifecycle_id
       AND lifecycle.project_id = criterion.project_id
      JOIN project_authority authority
        ON authority.project_id = criterion.project_id
       AND authority.singleton = 1
      WHERE lifecycle.milestone_id = :milestone_id
        AND lifecycle.item_kind = 'milestone'
        AND lifecycle.slice_id IS NULL
        AND lifecycle.task_id IS NULL
        AND criterion.required = 1
        AND NOT EXISTS (
          SELECT 1 FROM workflow_acceptance_criteria successor
          WHERE successor.supersedes_criterion_id = criterion.criterion_id
        )
    ),
    technical_proofs AS (
      SELECT verdict.criterion_id, verdict.verdict, evidence.observation,
             verdict.tested_source_revision,
             ROW_NUMBER() OVER (
               PARTITION BY verdict.criterion_id
               ORDER BY verdict.project_revision DESC, verdict.verdict_id DESC
             ) AS rank
      FROM workflow_technical_verdicts verdict
      JOIN workflow_verification_evidence evidence
        ON evidence.verdict_id = verdict.verdict_id
       AND evidence.project_id = verdict.project_id
       AND evidence.criterion_id = verdict.criterion_id
      JOIN json_each(:payload_json, '$.verdictIds') listed_verdict
        ON listed_verdict.value = verdict.verdict_id
      JOIN json_each(:payload_json, '$.evidenceIds') listed_evidence
        ON listed_evidence.value = evidence.evidence_id
      WHERE verdict.operation_id = :operation_id
        AND verdict.lifecycle_id = :lifecycle_id
        AND verdict.attempt_id = :attempt_id
        AND verdict.tested_source_revision = :source_revision
        AND NOT EXISTS (
        SELECT 1 FROM workflow_technical_verdicts successor
        WHERE successor.supersedes_verdict_id = verdict.verdict_id
      )
    ),
    human_proofs AS (
      SELECT acceptance.criterion_id, acceptance.disposition,
             ROW_NUMBER() OVER (
               PARTITION BY acceptance.criterion_id
               ORDER BY acceptance.project_revision DESC,
                        acceptance.human_acceptance_id DESC
             ) AS rank
      FROM workflow_human_acceptances acceptance
      JOIN workflow_domain_events answered
        ON answered.operation_id = acceptance.operation_id
       AND answered.project_id = acceptance.project_id
       AND answered.event_type = 'milestone.subjective-uat.answered'
       AND json_extract(answered.payload_json, '$.humanAcceptanceId') = acceptance.human_acceptance_id
       AND json_extract(answered.payload_json, '$.testedSourceRevision') = :source_revision
      JOIN json_each(:payload_json, '$.humanAcceptanceIds') listed_acceptance
        ON listed_acceptance.value = acceptance.human_acceptance_id
      WHERE NOT EXISTS (
        SELECT 1 FROM workflow_human_acceptances successor
        WHERE successor.supersedes_human_acceptance_id = acceptance.human_acceptance_id
      )
        AND NOT EXISTS (
          SELECT 1 FROM workflow_domain_events prepared
          WHERE prepared.project_id = acceptance.project_id
            AND prepared.event_type = 'milestone.subjective-uat.prepared'
            AND json_extract(prepared.payload_json, '$.criterionId') = acceptance.criterion_id
            AND prepared.project_revision > acceptance.project_revision
        )
    )
    SELECT criterion.criterion_id, criterion.criterion_key, criterion.criterion_kind,
           technical.verdict AS technical_verdict,
           technical.observation AS technical_observation,
           technical.tested_source_revision,
           human.disposition AS human_disposition
    FROM current_criteria criterion
    LEFT JOIN technical_proofs technical
      ON technical.criterion_id = criterion.criterion_id AND technical.rank = 1
    LEFT JOIN human_proofs human
      ON human.criterion_id = criterion.criterion_id AND human.rank = 1
    ORDER BY criterion.criterion_id
  `).all({
    ":milestone_id": milestoneId,
    ":payload_json": payloadJson,
    ":operation_id": validation.operation_id,
    ":lifecycle_id": bundle.lifecycleId,
    ":attempt_id": bundle.attemptId,
    ":source_revision": bundle.testedSourceRevision,
  }) as unknown as CriterionRow[];
}

function newerAttempts(
  validation: ValidationRow,
  bundle: ValidationBundle,
  milestoneId: string,
): NewerAttemptRow[] {
  return getDb().prepare(`
    SELECT attempt.attempt_id, attempt.attempt_state,
           COALESCE(attempt.settle_project_revision, attempt.claim_project_revision) AS attempt_revision
    FROM workflow_execution_attempts attempt
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.lifecycle_id = attempt.lifecycle_id
     AND lifecycle.project_id = attempt.project_id
    WHERE attempt.project_id = :project_id
      AND lifecycle.item_kind = 'milestone'
      AND lifecycle.milestone_id = :milestone_id
      AND lifecycle.slice_id IS NULL
      AND lifecycle.task_id IS NULL
      AND attempt.attempt_id != :validated_attempt_id
      AND COALESCE(attempt.settle_project_revision, attempt.claim_project_revision) > :validation_revision
    ORDER BY attempt_revision, attempt.attempt_number
  `).all({
    ":project_id": validation.project_id,
    ":milestone_id": milestoneId,
    ":validated_attempt_id": bundle.attemptId,
    ":validation_revision": validation.project_revision,
  }) as unknown as NewerAttemptRow[];
}

function criterionBlocker(
  criterion: CriterionRow,
  validation: ValidationBundle,
): MilestoneCloseoutBlocker | null {
  if (!validation.criterionIds.has(criterion.criterion_id)) {
    return {
      kind: "criterion-unsatisfied",
      criterionId: criterion.criterion_id,
      criterionKey: criterion.criterion_key,
    };
  }
  if (criterion.criterion_kind === "subjective_uat") {
    return criterion.human_disposition === "accepted"
      ? null
      : {
        kind: "criterion-unsatisfied",
        criterionId: criterion.criterion_id,
        criterionKey: criterion.criterion_key,
      };
  }

  const passed = criterion.technical_verdict === "pass" &&
    criterion.technical_observation === "passed";
  if (!passed) {
    return {
      kind: "criterion-unsatisfied",
      criterionId: criterion.criterion_id,
      criterionKey: criterion.criterion_key,
    };
  }
  if (criterion.tested_source_revision === validation.testedSourceRevision) {
    return null;
  }
  return {
    kind: "source-revision-mismatch",
    criterionId: criterion.criterion_id,
    criterionKey: criterion.criterion_key,
    expectedSourceRevision: validation.testedSourceRevision,
    testedSourceRevision: criterion.tested_source_revision,
  };
}

export function readMilestoneCloseoutReadiness(
  input: MilestoneCloseoutReadinessInput,
): MilestoneCloseoutReadiness {
  const validation = getDb().prepare(`
    SELECT event.event_id, event.operation_id, event.project_id,
           event.project_revision, event.payload_json
    FROM workflow_domain_events event
    JOIN workflow_operations operation
      ON operation.operation_id = event.operation_id
     AND operation.project_id = event.project_id
    JOIN project_authority authority
      ON authority.project_id = event.project_id
     AND authority.singleton = 1
    WHERE event.event_type = 'milestone.validation.recorded'
      AND event.entity_type = 'milestone'
      AND event.entity_id = :milestone_id
      AND operation.operation_type = 'milestone.validate'
    ORDER BY event.project_revision DESC, event.event_index DESC, event.event_id DESC
    LIMIT 1
  `).get({ ":milestone_id": input.milestoneId }) as unknown as ValidationRow | undefined;
  if (!validation) return { ready: false, blockers: [{ kind: "validation-missing" }] };

  const parsed = validationBundle(validation.payload_json);
  if (!parsed.bundle) {
    return {
      ready: false,
      validationEventId: validation.event_id,
      validationRevision: validation.project_revision,
      blockers: [{ kind: "validation-receipt-invalid", fields: parsed.invalidFields }],
    };
  }
  const bundle = parsed.bundle;
  const invalidFields = receiptBindingInvalidFields(validation, bundle, input.milestoneId);
  if (invalidFields.length > 0) {
    return {
      ready: false,
      validationEventId: validation.event_id,
      validationRevision: validation.project_revision,
      blockers: [{ kind: "validation-receipt-invalid", fields: invalidFields }],
    };
  }

  const blockers: MilestoneCloseoutBlocker[] = [];
  if (bundle.overallVerdict !== "pass") {
    blockers.push({
      kind: "validation-not-pass",
      overallVerdict: bundle.overallVerdict,
    });
  }
  if (input.sourceRevision !== undefined && input.sourceRevision !== bundle.testedSourceRevision) {
    blockers.push({
      kind: "validation-source-revision-mismatch",
      expectedSourceRevision: input.sourceRevision,
      testedSourceRevision: bundle.testedSourceRevision,
    });
  }
  for (const criterion of currentCriteria(
    input.milestoneId,
    validation.payload_json,
    validation,
    bundle,
  )) {
    const blocker = criterionBlocker(criterion, bundle);
    if (blocker) blockers.push(blocker);
  }
  for (const attempt of newerAttempts(validation, bundle, input.milestoneId)) {
    blockers.push({
      kind: "validation-attempt-newer",
      attemptId: attempt.attempt_id,
      attemptState: attempt.attempt_state,
      attemptRevision: attempt.attempt_revision,
    });
  }

  const descendantRevision = closeoutRelevantDescendantRevision(input.milestoneId);
  if (descendantRevision >= validation.project_revision) {
    blockers.push({
      kind: "validation-stale",
      validationRevision: validation.project_revision,
      descendantRevision,
    });
  }

  if (blockers.length > 0) {
    return {
      ready: false,
      validationEventId: validation.event_id,
      validationRevision: validation.project_revision,
      blockers,
    };
  }
  return {
    ready: true,
    validationEventId: validation.event_id,
    validationRevision: validation.project_revision,
  };
}

function readCurrentValidationWaiver(milestoneId: string): ValidationWaiverRow[] {
  return getDb().prepare(`
    SELECT waiver.waiver_id, event.event_id, event.project_revision, event.payload_json
    FROM workflow_waivers waiver
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.lifecycle_id = waiver.lifecycle_id
     AND lifecycle.project_id = waiver.project_id
    JOIN project_authority authority
      ON authority.project_id = waiver.project_id
     AND authority.singleton = 1
    JOIN workflow_operations operation
      ON operation.operation_id = waiver.operation_id
     AND operation.project_id = waiver.project_id
     AND operation.operation_type = 'milestone.validation.waive'
    JOIN workflow_domain_events event
      ON event.operation_id = waiver.operation_id
     AND event.project_id = waiver.project_id
     AND event.event_type = 'milestone.validation.waived'
     AND event.entity_type = 'milestone'
     AND event.entity_id = :milestone_id
     AND json_extract(event.payload_json, '$.milestoneId') = :milestone_id
     AND json_extract(event.payload_json, '$.lifecycleId') = waiver.lifecycle_id
     AND json_extract(event.payload_json, '$.waiverId') = waiver.waiver_id
    WHERE lifecycle.item_kind = 'milestone'
      AND lifecycle.milestone_id = :milestone_id
      AND lifecycle.slice_id IS NULL
      AND lifecycle.task_id IS NULL
      AND waiver.waiver_status = 'active'
      AND waiver.scope = 'milestone-validation'
      AND waiver.requirement_id IS NULL
      AND waiver.blocker_id IS NULL
      AND (waiver.expires_at IS NULL OR waiver.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ORDER BY waiver.project_revision DESC, waiver.waiver_id
  `).all({ ":milestone_id": milestoneId }) as unknown as ValidationWaiverRow[];
}

function countActiveValidationWaivers(milestoneId: string): number {
  const row = getDb().prepare(`
    SELECT COUNT(*) AS count
    FROM workflow_waivers waiver
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.lifecycle_id = waiver.lifecycle_id
     AND lifecycle.project_id = waiver.project_id
    JOIN project_authority authority
      ON authority.project_id = waiver.project_id
     AND authority.singleton = 1
    WHERE lifecycle.item_kind = 'milestone'
      AND lifecycle.milestone_id = :milestone_id
      AND lifecycle.slice_id IS NULL
      AND lifecycle.task_id IS NULL
      AND waiver.waiver_status = 'active'
      AND waiver.scope = 'milestone-validation'
      AND waiver.requirement_id IS NULL
      AND waiver.blocker_id IS NULL
      AND (waiver.expires_at IS NULL OR waiver.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `).get({ ":milestone_id": milestoneId });
  return Number(row?.["count"] ?? 0);
}

function waiverSourceRevision(payloadJson: string): string | null {
  try {
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    const sourceRevision = payload["testedSourceRevision"];
    const reason = payload["reason"];
    const policyId = payload["policyId"];
    const policyVersion = payload["policyVersion"];
    if (typeof sourceRevision !== "string" || !sourceRevision.trim()) return null;
    if (reason !== "preference" && reason !== "trivial-scope") return null;
    if (typeof policyId !== "string" || !policyId.trim()) return null;
    if (typeof policyVersion !== "string" || !policyVersion.trim()) return null;
    return sourceRevision;
  } catch {
    return null;
  }
}

// milestone.complete may adopt legacy completed descendants after authorizing
// validation. Those state-version-zero rows record compatibility, not newer
// work; any later lifecycle transition increments the version and counts again.
function closeoutRelevantDescendantRevision(milestoneId: string): number {
  const descendant = getDb().prepare(`
    SELECT COALESCE(MAX(lifecycle.last_project_revision), 0) AS revision
    FROM workflow_item_lifecycles lifecycle
    JOIN project_authority authority
      ON authority.project_id = lifecycle.project_id
     AND authority.singleton = 1
    LEFT JOIN workflow_operations lifecycle_operation
      ON lifecycle_operation.project_id = lifecycle.project_id
     AND lifecycle_operation.operation_id = lifecycle.last_operation_id
    WHERE lifecycle.milestone_id = :milestone_id
      AND lifecycle.item_kind IN ('slice', 'task')
      AND NOT (
        lifecycle.lifecycle_status = 'completed'
        AND lifecycle.state_version = 0
        AND COALESCE(lifecycle_operation.operation_type, '') = 'milestone.complete'
      )
  `).get({ ":milestone_id": milestoneId });
  return Number(descendant?.["revision"] ?? 0);
}

function latestValidationEventRevision(milestoneId: string): number {
  const row = getDb().prepare(`
    SELECT event.project_revision
    FROM workflow_domain_events event
    JOIN workflow_operations operation
      ON operation.operation_id = event.operation_id
     AND operation.project_id = event.project_id
    JOIN project_authority authority
      ON authority.project_id = event.project_id
     AND authority.singleton = 1
    WHERE event.event_type = 'milestone.validation.recorded'
      AND event.entity_type = 'milestone'
      AND event.entity_id = :milestone_id
      AND operation.operation_type = 'milestone.validate'
    ORDER BY event.project_revision DESC, event.event_index DESC, event.event_id DESC
    LIMIT 1
  `).get({ ":milestone_id": milestoneId });
  return Number(row?.["project_revision"] ?? 0);
}

export function readMilestoneCloseoutAuthorization(
  input: MilestoneCloseoutReadinessInput,
): MilestoneCloseoutAuthorization {
  const readiness = readMilestoneCloseoutReadiness(input);
  const waivers = readCurrentValidationWaiver(input.milestoneId);
  const activeWaiverCount = countActiveValidationWaivers(input.milestoneId);
  if (activeWaiverCount !== waivers.length || waivers.length > 1) {
    return {
      authorized: false,
      blockers: [{ kind: "validation-receipt-invalid", fields: ["waiverId"] }],
    };
  }

  const waiver = waivers[0];
  const validationRevision = latestValidationEventRevision(input.milestoneId);
  if (waiver && waiver.project_revision > validationRevision) {
    const testedSourceRevision = waiverSourceRevision(waiver.payload_json);
    if (!testedSourceRevision) {
      return {
        authorized: false,
        blockers: [{ kind: "validation-receipt-invalid", fields: ["waiver"] }],
      };
    }
    if (input.sourceRevision !== undefined && input.sourceRevision !== testedSourceRevision) {
      return {
        authorized: false,
        blockers: [{
          kind: "validation-source-revision-mismatch",
          expectedSourceRevision: input.sourceRevision,
          testedSourceRevision,
        }],
      };
    }
    const currentDescendantRevision = closeoutRelevantDescendantRevision(input.milestoneId);
    if (currentDescendantRevision >= waiver.project_revision) {
      return {
        authorized: false,
        blockers: [{
          kind: "validation-stale",
          validationRevision: waiver.project_revision,
          descendantRevision: currentDescendantRevision,
        }],
      };
    }
    return {
      authorized: true,
      kind: "waived",
      eventId: waiver.event_id,
      revision: waiver.project_revision,
      testedSourceRevision,
      waiverId: waiver.waiver_id,
    };
  }

  if (!readiness.ready) return { authorized: false, blockers: readiness.blockers };
  const validation = validationBundle(getDb().prepare(`
    SELECT payload_json FROM workflow_domain_events WHERE event_id = :event_id
  `).get({ ":event_id": readiness.validationEventId })?.["payload_json"] as string ?? "");
  if (!validation.bundle) {
    return {
      authorized: false,
      blockers: [{ kind: "validation-receipt-invalid", fields: validation.invalidFields }],
    };
  }
  return {
    authorized: true,
    kind: "validated",
    eventId: readiness.validationEventId,
    revision: readiness.validationRevision,
    testedSourceRevision: validation.bundle.testedSourceRevision,
  };
}
