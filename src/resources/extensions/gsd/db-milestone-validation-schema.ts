// Project/App: gsd-pi
// File Purpose: v42 authorization for atomic Milestone validation Attempt settlement.

import { createAttemptSettlementShapeTrigger } from "./db-attempt-recovery-schema.js";
import type { DbAdapter } from "./db-adapter.js";

export function createMilestoneValidationSchemaV42(db: DbAdapter): void {
  createAttemptSettlementShapeTrigger(
    db,
    ["task.cancel", "slice.cancel"],
    true,
  );
  db.exec(`
    DROP TRIGGER IF EXISTS trg_workflow_attempt_causal_provenance;
    CREATE TRIGGER trg_workflow_attempt_causal_provenance
    BEFORE UPDATE ON workflow_execution_attempts
    WHEN NEW.attempt_state = 'settled'
      AND (
        NEW.settle_project_revision < OLD.claim_project_revision OR
        NEW.settle_authority_epoch < OLD.claim_authority_epoch OR
        (
          NEW.settle_project_revision = OLD.claim_project_revision
          AND (
            NEW.settle_operation_id IS NOT OLD.claim_operation_id OR
            NOT EXISTS (
              SELECT 1 FROM workflow_operations operation
              WHERE operation.operation_id = NEW.settle_operation_id
                AND operation.project_id = NEW.project_id
                AND operation.operation_type = 'milestone.validate'
            )
          )
        )
      )
    BEGIN
      SELECT RAISE(ABORT, 'workflow attempt causal provenance must advance');
    END;

    DROP TRIGGER IF EXISTS trg_workflow_technical_verdict_scope;
    CREATE TRIGGER trg_workflow_technical_verdict_scope
    BEFORE INSERT ON workflow_technical_verdicts
    WHEN NOT EXISTS (
      SELECT 1
      FROM workflow_acceptance_criteria criterion
      JOIN workflow_execution_attempts attempt ON attempt.attempt_id = NEW.attempt_id
      JOIN workflow_attempt_results result ON result.attempt_id = attempt.attempt_id
      WHERE criterion.criterion_id = NEW.criterion_id
        AND criterion.project_id = NEW.project_id
        AND criterion.lifecycle_id = NEW.lifecycle_id
        AND criterion.criterion_kind = 'technical'
        AND criterion.project_revision <= NEW.project_revision
        AND criterion.authority_epoch <= NEW.authority_epoch
        AND NOT EXISTS (
          SELECT 1 FROM workflow_acceptance_criteria successor
          WHERE successor.supersedes_criterion_id = criterion.criterion_id
        )
        AND attempt.project_id = NEW.project_id
        AND attempt.lifecycle_id = NEW.lifecycle_id
        AND attempt.attempt_state = 'settled'
        AND result.project_revision <= NEW.project_revision
        AND result.authority_epoch <= NEW.authority_epoch
        AND (
          result.project_revision < NEW.project_revision OR
          (
            result.operation_id = NEW.operation_id AND
            EXISTS (
              SELECT 1 FROM workflow_operations operation
              WHERE operation.operation_id = NEW.operation_id
                AND operation.project_id = NEW.project_id
                AND operation.operation_type = 'milestone.validate'
            )
          )
        )
        AND (NEW.verdict != 'pass' OR result.outcome = 'succeeded')
    )
    BEGIN
      SELECT RAISE(ABORT, 'technical verdict requires the current criterion and matching settled attempt');
    END;

    DROP TRIGGER IF EXISTS trg_workflow_evidence_verdict;
    CREATE TRIGGER trg_workflow_evidence_verdict
    BEFORE INSERT ON workflow_verification_evidence
    WHEN NOT EXISTS (
      SELECT 1
      FROM workflow_technical_verdicts verdict
      JOIN workflow_acceptance_criteria criterion
        ON criterion.criterion_id = verdict.criterion_id
      JOIN workflow_execution_attempts attempt
        ON attempt.attempt_id = verdict.attempt_id
      WHERE verdict.verdict_id = NEW.verdict_id
        AND verdict.project_id = NEW.project_id
        AND verdict.criterion_id = NEW.criterion_id
        AND verdict.lifecycle_id = NEW.lifecycle_id
        AND verdict.attempt_id = NEW.attempt_id
        AND verdict.tested_source_revision = NEW.source_revision
        AND verdict.operation_id = NEW.operation_id
        AND verdict.project_revision = NEW.project_revision
        AND verdict.authority_epoch = NEW.authority_epoch
        AND criterion.evidence_class = NEW.evidence_class
        AND NEW.observed_project_revision >= COALESCE(
          attempt.settle_project_revision,
          attempt.claim_project_revision
        )
        AND NEW.observed_project_revision >= criterion.project_revision
        AND NEW.observed_project_revision <= NEW.project_revision
        AND (
          NEW.observed_project_revision < NEW.project_revision OR
          EXISTS (
            SELECT 1 FROM workflow_operations operation
            WHERE operation.operation_id = NEW.operation_id
              AND operation.project_id = NEW.project_id
              AND operation.operation_type = 'milestone.validate'
          )
        )
        AND (
          (verdict.verdict = 'pass' AND NEW.observation = 'passed') OR
          (verdict.verdict = 'fail') OR
          (verdict.verdict = 'inconclusive' AND NEW.observation IN ('passed', 'inconclusive'))
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'verification evidence must match its verdict scope and operation');
    END;
  `);
}

/**
 * V49 — milestone.validate verdict scope relaxation (#2025). When the tool
 * records a non-pass aggregate verdict it settles the validation Attempt with
 * outcome 'interrupted' (tools/validate-milestone.ts canonicalOutcome), even
 * though every per-class technical criterion is fully green and emits verdict
 * 'pass'. The pass⟺succeeded conjunct then aborted those per-class verdicts
 * and the validation result was silently discarded.
 *
 * This recreation carves milestone.validate operations out of the
 * pass/outcome conjunct only, mirroring the existing operation-matching
 * carve-out above it. Every other operation still requires outcome
 * 'succeeded' before a 'pass' verdict is accepted.
 */
export function createMilestoneVerdictScopeSchemaV49(db: DbAdapter): void {
  const verdictsTable = db.prepare(`
    SELECT 1 AS present FROM sqlite_master
    WHERE type = 'table' AND name = 'workflow_technical_verdicts'
  `).get();
  if (!verdictsTable) return;
  db.exec(`
    DROP TRIGGER IF EXISTS trg_workflow_technical_verdict_scope;

    CREATE TRIGGER trg_workflow_technical_verdict_scope
    BEFORE INSERT ON workflow_technical_verdicts
    WHEN NOT EXISTS (
      SELECT 1
      FROM workflow_acceptance_criteria criterion
      JOIN workflow_execution_attempts attempt ON attempt.attempt_id = NEW.attempt_id
      JOIN workflow_attempt_results result ON result.attempt_id = attempt.attempt_id
      WHERE criterion.criterion_id = NEW.criterion_id
        AND criterion.project_id = NEW.project_id
        AND criterion.lifecycle_id = NEW.lifecycle_id
        AND criterion.criterion_kind = 'technical'
        AND criterion.project_revision <= NEW.project_revision
        AND criterion.authority_epoch <= NEW.authority_epoch
        AND NOT EXISTS (
          SELECT 1 FROM workflow_acceptance_criteria successor
          WHERE successor.supersedes_criterion_id = criterion.criterion_id
        )
        AND attempt.project_id = NEW.project_id
        AND attempt.lifecycle_id = NEW.lifecycle_id
        AND attempt.attempt_state = 'settled'
        AND result.project_revision <= NEW.project_revision
        AND result.authority_epoch <= NEW.authority_epoch
        AND (
          result.project_revision < NEW.project_revision OR
          (
            result.operation_id = NEW.operation_id AND
            EXISTS (
              SELECT 1 FROM workflow_operations operation
              WHERE operation.operation_id = NEW.operation_id
                AND operation.project_id = NEW.project_id
                AND operation.operation_type = 'milestone.validate'
            )
          )
        )
        AND (
          NEW.verdict != 'pass' OR
          result.outcome = 'succeeded' OR
          (
            result.operation_id = NEW.operation_id AND
            EXISTS (
              SELECT 1 FROM workflow_operations operation
              WHERE operation.operation_id = NEW.operation_id
                AND operation.project_id = NEW.project_id
                AND operation.operation_type = 'milestone.validate'
            )
          )
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'technical verdict requires the current criterion and matching settled attempt');
    END;
  `);
}
