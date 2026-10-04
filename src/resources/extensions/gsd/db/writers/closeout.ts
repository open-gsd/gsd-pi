// Project/App: gsd-pi
// File Purpose: Context-bound Closeout Plan, Closeout Effect and Settlement Receipt rows for a Milestone.

import { createHash, randomUUID } from "node:crypto";

import {
  canonicalDomainJson,
  type DomainJsonValue,
  type DomainOperationContext,
} from "../domain-operation.js";
import { getDb } from "../engine.js";
import { requireActiveDomainOperationContext } from "./lifecycle-commands.js";

export const CLOSEOUT_PREPARE_OPERATION = "milestone.closeout.prepare";
export const CLOSEOUT_SETTLE_EFFECT_OPERATION = "milestone.closeout.settle_effect";

export interface CloseoutEffectInput {
  /** One effect per kind in a plan; the kind is also the idempotency key. */
  effectKind: string;
  /** Publication is not required: it never gates completion (ADR-034). */
  required: boolean;
  spec?: Record<string, DomainJsonValue>;
}

export interface CloseoutSettlementReceipt {
  settlementReceiptId: string;
  outcome: "performed" | "recognized";
  externalRef: string;
  proof: Record<string, DomainJsonValue>;
  settledAt: string;
}

export interface CloseoutEffect {
  closeoutEffectId: string;
  ordinal: number;
  effectKind: string;
  required: boolean;
  spec: Record<string, DomainJsonValue>;
  receipt: CloseoutSettlementReceipt | null;
}

export interface CloseoutPlan {
  closeoutPlanId: string;
  milestoneId: string;
  lifecycleId: string;
  lifecycleStatus: string;
  attemptId: string;
  operationId: string;
  readinessBasisHash: string;
  preparedAt: string;
  effects: CloseoutEffect[];
}

export function closeoutHash(value: DomainJsonValue): string {
  return `sha256:${createHash("sha256").update(canonicalDomainJson(value)).digest("hex")}`;
}

function effectSpec(effect: CloseoutEffectInput): Record<string, DomainJsonValue> {
  return { ...effect.spec, required: effect.required };
}

/** True when the plan carries exactly these effects, in this order. */
export function closeoutPlanHasEffects(plan: CloseoutPlan, effects: CloseoutEffectInput[]): boolean {
  return plan.effects.length === effects.length && effects.every((effect, index) =>
    plan.effects[index]!.effectKind === effect.effectKind &&
    canonicalDomainJson(plan.effects[index]!.spec) === canonicalDomainJson(effectSpec(effect))
  );
}

export function pendingRequiredCloseoutEffects(plan: CloseoutPlan): CloseoutEffect[] {
  return plan.effects.filter((effect) => effect.required && !effect.receipt);
}

interface PlanHeadRow {
  closeout_plan_id: string;
  lifecycle_id: string;
  lifecycle_status: string;
  attempt_id: string;
  operation_id: string;
  readiness_basis_hash: string;
  prepared_at: string;
  project_revision: number;
  lifecycle_revision: number;
}

function planHead(milestoneId: string): PlanHeadRow | undefined {
  return getDb().prepare(`
    SELECT plan.closeout_plan_id, plan.lifecycle_id, lifecycle.lifecycle_status,
           plan.attempt_id, plan.operation_id, plan.readiness_basis_hash,
           plan.prepared_at, plan.project_revision,
           lifecycle.last_project_revision AS lifecycle_revision
    FROM workflow_closeout_plans plan
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.lifecycle_id = plan.lifecycle_id
     AND lifecycle.project_id = plan.project_id
    JOIN project_authority authority
      ON authority.project_id = plan.project_id
     AND authority.singleton = 1
    WHERE lifecycle.item_kind = 'milestone'
      AND lifecycle.milestone_id = :milestone_id
      AND lifecycle.slice_id IS NULL
      AND lifecycle.task_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM workflow_closeout_plans successor
        WHERE successor.supersedes_closeout_plan_id = plan.closeout_plan_id
      )
  `).get({ ":milestone_id": milestoneId }) as unknown as PlanHeadRow | undefined;
}

function planEffects(closeoutPlanId: string): CloseoutEffect[] {
  const rows = getDb().prepare(`
    SELECT effect.closeout_effect_id, effect.ordinal, effect.effect_kind, effect.effect_spec_json,
           receipt.settlement_receipt_id, receipt.outcome, receipt.external_ref,
           receipt.proof_json, receipt.settled_at
    FROM workflow_closeout_effects effect
    LEFT JOIN workflow_settlement_receipts receipt
      ON receipt.closeout_effect_id = effect.closeout_effect_id
    WHERE effect.closeout_plan_id = :closeout_plan_id
    ORDER BY effect.ordinal
  `).all({ ":closeout_plan_id": closeoutPlanId }) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const spec = JSON.parse(String(row["effect_spec_json"])) as Record<string, DomainJsonValue>;
    return {
      closeoutEffectId: String(row["closeout_effect_id"]),
      ordinal: Number(row["ordinal"]),
      effectKind: String(row["effect_kind"]),
      required: spec["required"] === true,
      spec,
      receipt: typeof row["settlement_receipt_id"] === "string"
        ? {
          settlementReceiptId: row["settlement_receipt_id"],
          outcome: row["outcome"] as CloseoutSettlementReceipt["outcome"],
          externalRef: String(row["external_ref"]),
          proof: JSON.parse(String(row["proof_json"])) as Record<string, DomainJsonValue>,
          settledAt: String(row["settled_at"]),
        }
        : null,
    };
  });
}

/**
 * The Closeout Plan that speaks for the Milestone now. A plan prepared before
 * the last lifecycle transition of an open Milestone (a reopen) is history:
 * its receipts must not settle the new closeout.
 */
export function readMilestoneCloseoutPlan(milestoneId: string): CloseoutPlan | null {
  const head = planHead(milestoneId);
  if (!head) return null;
  if (head.lifecycle_status !== "completed" && head.project_revision <= head.lifecycle_revision) {
    return null;
  }
  return {
    closeoutPlanId: head.closeout_plan_id,
    milestoneId,
    lifecycleId: head.lifecycle_id,
    lifecycleStatus: head.lifecycle_status,
    attemptId: head.attempt_id,
    operationId: head.operation_id,
    readinessBasisHash: head.readiness_basis_hash,
    preparedAt: head.prepared_at,
    effects: planEffects(head.closeout_plan_id),
  };
}

/** True while the Milestone is open and its Closeout Plan waits for the host to settle it. */
export function isMilestoneCloseoutPrepared(milestoneId: string): boolean {
  const plan = readMilestoneCloseoutPlan(milestoneId);
  return Boolean(plan && plan.lifecycleStatus !== "completed");
}

/**
 * Effects of one kind that have no receipt, in live plans where the effect of
 * `settledKind` already has one. Oldest plan first.
 */
export function readUnsettledEffectsBehind(
  effectKind: string,
  settledKind: string,
): Array<{ milestoneId: string; settledProof: Record<string, DomainJsonValue> }> {
  const rows = getDb().prepare(`
    SELECT lifecycle.milestone_id, settled_receipt.proof_json
    FROM workflow_closeout_effects effect
    JOIN workflow_closeout_effects settled
      ON settled.closeout_plan_id = effect.closeout_plan_id
     AND settled.effect_kind = :settled_kind
    JOIN workflow_settlement_receipts settled_receipt
      ON settled_receipt.closeout_effect_id = settled.closeout_effect_id
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.lifecycle_id = effect.lifecycle_id
     AND lifecycle.project_id = effect.project_id
    JOIN project_authority authority
      ON authority.project_id = effect.project_id
     AND authority.singleton = 1
    WHERE effect.effect_kind = :effect_kind
      AND NOT EXISTS (
        SELECT 1 FROM workflow_settlement_receipts receipt
        WHERE receipt.closeout_effect_id = effect.closeout_effect_id
      )
    ORDER BY effect.project_revision
  `).all({ ":effect_kind": effectKind, ":settled_kind": settledKind }) as Array<Record<string, unknown>>;
  return rows
    .map((row) => ({
      milestoneId: String(row["milestone_id"]),
      settledProof: JSON.parse(String(row["proof_json"])) as Record<string, DomainJsonValue>,
    }))
    // A receipt can only be recorded against the live plan of its Milestone.
    .filter((row) => readMilestoneCloseoutPlan(row.milestoneId)?.effects
      .some((effect) => effect.effectKind === effectKind && !effect.receipt));
}

/** The settled, succeeded Attempt a Closeout Plan must cite, newest first. */
export function readCloseoutAttemptId(milestoneId: string): string | null {
  const row = getDb().prepare(`
    SELECT attempt.attempt_id
    FROM workflow_execution_attempts attempt
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.lifecycle_id = attempt.lifecycle_id
     AND lifecycle.project_id = attempt.project_id
    JOIN project_authority authority
      ON authority.project_id = attempt.project_id
     AND authority.singleton = 1
    JOIN workflow_attempt_results result
      ON result.attempt_id = attempt.attempt_id
     AND result.outcome = 'succeeded'
    WHERE lifecycle.item_kind = 'milestone'
      AND lifecycle.milestone_id = :milestone_id
      AND lifecycle.slice_id IS NULL
      AND lifecycle.task_id IS NULL
      AND attempt.attempt_state = 'settled'
    ORDER BY attempt.attempt_number DESC
    LIMIT 1
  `).get({ ":milestone_id": milestoneId });
  return typeof row?.["attempt_id"] === "string" ? row["attempt_id"] : null;
}

export function insertCloseoutPlan(
  context: Readonly<DomainOperationContext>,
  input: {
    milestoneId: string;
    lifecycleId: string;
    attemptId: string;
    testedSourceSetHash: string;
    readinessBasisHash: string;
    effects: CloseoutEffectInput[];
    preparedAt: string;
  },
): string {
  if (requireActiveDomainOperationContext(context) !== CLOSEOUT_PREPARE_OPERATION) {
    throw new Error(`Closeout Plan requires a ${CLOSEOUT_PREPARE_OPERATION} Domain Operation`);
  }
  const closeoutPlanId = randomUUID();
  const provenance = {
    ":project_id": context.projectId,
    ":lifecycle_id": input.lifecycleId,
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
  };
  getDb().prepare(`
    INSERT INTO workflow_closeout_plans (
      closeout_plan_id, project_id, lifecycle_id, attempt_id,
      tested_source_set_hash, readiness_basis_hash, supersedes_closeout_plan_id,
      prepared_at, operation_id, project_revision, authority_epoch
    ) VALUES (
      :closeout_plan_id, :project_id, :lifecycle_id, :attempt_id,
      :tested_source_set_hash, :readiness_basis_hash, :supersedes_closeout_plan_id,
      :prepared_at, :operation_id, :project_revision, :authority_epoch
    )
  `).run({
    ...provenance,
    ":closeout_plan_id": closeoutPlanId,
    ":attempt_id": input.attemptId,
    ":tested_source_set_hash": input.testedSourceSetHash,
    ":readiness_basis_hash": input.readinessBasisHash,
    ":supersedes_closeout_plan_id": planHead(input.milestoneId)?.closeout_plan_id ?? null,
    ":prepared_at": input.preparedAt,
  });
  input.effects.forEach((effect, index) => {
    const spec = effectSpec(effect);
    getDb().prepare(`
      INSERT INTO workflow_closeout_effects (
        closeout_effect_id, closeout_plan_id, project_id, lifecycle_id, ordinal,
        effect_kind, idempotency_key, effect_spec_json, effect_spec_hash,
        created_at, operation_id, project_revision, authority_epoch
      ) VALUES (
        :closeout_effect_id, :closeout_plan_id, :project_id, :lifecycle_id, :ordinal,
        :effect_kind, :effect_kind, :effect_spec_json, :effect_spec_hash,
        :created_at, :operation_id, :project_revision, :authority_epoch
      )
    `).run({
      ...provenance,
      ":closeout_effect_id": randomUUID(),
      ":closeout_plan_id": closeoutPlanId,
      ":ordinal": index + 1,
      ":effect_kind": effect.effectKind,
      ":effect_spec_json": canonicalDomainJson(spec),
      ":effect_spec_hash": closeoutHash(spec),
      ":created_at": input.preparedAt,
    });
  });
  return closeoutPlanId;
}

export function insertSettlementReceipt(
  context: Readonly<DomainOperationContext>,
  input: {
    closeoutEffectId: string;
    lifecycleId: string;
    outcome: CloseoutSettlementReceipt["outcome"];
    externalRef: string;
    proof: Record<string, DomainJsonValue>;
    settledAt: string;
  },
): string {
  if (requireActiveDomainOperationContext(context) !== CLOSEOUT_SETTLE_EFFECT_OPERATION) {
    throw new Error(`Settlement Receipt requires a ${CLOSEOUT_SETTLE_EFFECT_OPERATION} Domain Operation`);
  }
  const settlementReceiptId = randomUUID();
  getDb().prepare(`
    INSERT INTO workflow_settlement_receipts (
      settlement_receipt_id, closeout_effect_id, project_id, lifecycle_id,
      outcome, external_ref, proof_json, proof_hash, settled_at,
      operation_id, project_revision, authority_epoch
    ) VALUES (
      :settlement_receipt_id, :closeout_effect_id, :project_id, :lifecycle_id,
      :outcome, :external_ref, :proof_json, :proof_hash, :settled_at,
      :operation_id, :project_revision, :authority_epoch
    )
  `).run({
    ":settlement_receipt_id": settlementReceiptId,
    ":closeout_effect_id": input.closeoutEffectId,
    ":project_id": context.projectId,
    ":lifecycle_id": input.lifecycleId,
    ":outcome": input.outcome,
    ":external_ref": input.externalRef,
    ":proof_json": canonicalDomainJson(input.proof),
    ":proof_hash": closeoutHash(input.proof),
    ":settled_at": input.settledAt,
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
  });
  return settlementReceiptId;
}
