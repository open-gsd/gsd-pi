// Project/App: gsd-pi
// File Purpose: Additive v32 lifecycle, Attempt, Result, disposition, Waiver, and Blocker schema.

import type { DbAdapter } from "./db-adapter.js";

/**
 * The v32 tables are shadow canonical state only. Existing hierarchy status,
 * dispatch, lease, evidence, gate, and rework records retain their current
 * runtime meaning until a later cutover.
 */
export function createLifecycleFoundationSchemaV32(db: DbAdapter): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_item_lifecycles (
      lifecycle_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      item_kind TEXT NOT NULL CHECK (item_kind IN ('milestone', 'slice', 'task')),
      milestone_id TEXT NOT NULL,
      slice_id TEXT DEFAULT NULL,
      task_id TEXT DEFAULT NULL,
      lifecycle_status TEXT NOT NULL CHECK (
        lifecycle_status IN (
          'pending', 'ready', 'in_progress', 'paused', 'completed', 'cancelled', 'blocker-accepted'
        )
      ),
      state_version INTEGER NOT NULL DEFAULT 0 CHECK (state_version >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_operation_id TEXT NOT NULL,
      last_project_revision INTEGER NOT NULL CHECK (last_project_revision > 0),
      last_authority_epoch INTEGER NOT NULL CHECK (last_authority_epoch >= 0),
      UNIQUE (lifecycle_id, project_id),
      CHECK (
        (item_kind = 'milestone' AND slice_id IS NULL AND task_id IS NULL) OR
        (item_kind = 'slice' AND slice_id IS NOT NULL AND task_id IS NULL) OR
        (item_kind = 'task' AND slice_id IS NOT NULL AND task_id IS NOT NULL)
      ),
      FOREIGN KEY (project_id) REFERENCES project_authority(project_id),
      FOREIGN KEY (milestone_id) REFERENCES milestones(id),
      FOREIGN KEY (milestone_id, slice_id) REFERENCES slices(milestone_id, id),
      FOREIGN KEY (milestone_id, slice_id, task_id) REFERENCES tasks(milestone_id, slice_id, id),
      FOREIGN KEY (last_operation_id, project_id, last_project_revision, last_authority_epoch)
        REFERENCES workflow_operations(
          operation_id, project_id, resulting_revision, resulting_authority_epoch
        )
    )
  `);

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_lifecycle_milestone
    ON workflow_item_lifecycles(project_id, milestone_id)
    WHERE item_kind = 'milestone'
  `);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_lifecycle_slice
    ON workflow_item_lifecycles(project_id, milestone_id, slice_id)
    WHERE item_kind = 'slice'
  `);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_lifecycle_task
    ON workflow_item_lifecycles(project_id, milestone_id, slice_id, task_id)
    WHERE item_kind = 'task'
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_workflow_lifecycle_identity_immutable
    BEFORE UPDATE ON workflow_item_lifecycles
    WHEN NEW.lifecycle_id != OLD.lifecycle_id
      OR NEW.project_id != OLD.project_id
      OR NEW.item_kind != OLD.item_kind
      OR NEW.milestone_id != OLD.milestone_id
      OR NEW.slice_id IS NOT OLD.slice_id
      OR NEW.task_id IS NOT OLD.task_id
      OR NEW.created_at != OLD.created_at
    BEGIN
      SELECT RAISE(ABORT, 'workflow lifecycle identity is immutable');
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_workflow_lifecycle_transition
    BEFORE UPDATE ON workflow_item_lifecycles
    WHEN NEW.lifecycle_status = OLD.lifecycle_status
      OR NEW.state_version != OLD.state_version + 1
      OR NEW.last_project_revision <= OLD.last_project_revision
      OR NEW.updated_at = OLD.updated_at
      OR NOT (
        (OLD.lifecycle_status = 'pending' AND NEW.lifecycle_status IN ('ready', 'cancelled')) OR
        (OLD.lifecycle_status = 'ready' AND NEW.lifecycle_status IN ('in_progress', 'paused', 'cancelled')) OR
        (OLD.lifecycle_status = 'in_progress' AND NEW.lifecycle_status IN ('paused', 'completed', 'cancelled')) OR
        (OLD.lifecycle_status = 'paused' AND NEW.lifecycle_status IN ('ready', 'in_progress', 'cancelled')) OR
        (OLD.lifecycle_status IN ('completed', 'cancelled') AND NEW.lifecycle_status = 'ready')
      )
    BEGIN
      SELECT RAISE(ABORT, 'invalid workflow lifecycle transition');
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_workflow_lifecycle_causal_provenance
    BEFORE UPDATE ON workflow_item_lifecycles
    WHEN NEW.lifecycle_status != OLD.lifecycle_status
      AND (
        NEW.last_project_revision <= OLD.last_project_revision
        OR NEW.last_authority_epoch < OLD.last_authority_epoch
      )
    BEGIN
      SELECT RAISE(ABORT, 'workflow lifecycle causal provenance must advance');
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_workflow_lifecycle_delete
    BEFORE DELETE ON workflow_item_lifecycles
    BEGIN
      SELECT RAISE(ABORT, 'workflow lifecycle records are durable history');
    END
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_execution_attempts (
      attempt_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      lifecycle_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
      retry_of_attempt_id TEXT DEFAULT NULL,
      attempt_state TEXT NOT NULL CHECK (attempt_state IN ('claimed', 'running', 'settled')),
      coordination_dispatch_id INTEGER DEFAULT NULL UNIQUE,
      worker_id TEXT DEFAULT NULL,
      milestone_lease_token INTEGER DEFAULT NULL,
      claimed_at TEXT NOT NULL,
      started_at TEXT DEFAULT NULL,
      ended_at TEXT DEFAULT NULL,
      claim_operation_id TEXT NOT NULL,
      claim_project_revision INTEGER NOT NULL CHECK (claim_project_revision > 0),
      claim_authority_epoch INTEGER NOT NULL CHECK (claim_authority_epoch >= 0),
      settle_operation_id TEXT DEFAULT NULL,
      settle_project_revision INTEGER DEFAULT NULL,
      settle_authority_epoch INTEGER DEFAULT NULL,
      UNIQUE (lifecycle_id, attempt_number),
      UNIQUE (attempt_id, lifecycle_id),
      UNIQUE (
        attempt_id, lifecycle_id,
        settle_operation_id, settle_project_revision, settle_authority_epoch
      ),
      CHECK (
        (attempt_number = 1 AND retry_of_attempt_id IS NULL) OR
        (attempt_number > 1 AND retry_of_attempt_id IS NOT NULL)
      ),
      CHECK (
        (worker_id IS NULL AND milestone_lease_token IS NULL) OR
        (worker_id IS NOT NULL AND milestone_lease_token > 0)
      ),
      CHECK (attempt_state != 'running' OR (worker_id IS NOT NULL AND started_at IS NOT NULL)),
      CHECK (
        (attempt_state IN ('claimed', 'running') AND ended_at IS NULL
          AND settle_operation_id IS NULL AND settle_project_revision IS NULL
          AND settle_authority_epoch IS NULL) OR
        (attempt_state = 'settled' AND ended_at IS NOT NULL
          AND settle_operation_id IS NOT NULL AND settle_project_revision > 0
          AND settle_authority_epoch >= 0)
      ),
      FOREIGN KEY (project_id) REFERENCES project_authority(project_id),
      FOREIGN KEY (lifecycle_id, project_id)
        REFERENCES workflow_item_lifecycles(lifecycle_id, project_id),
      FOREIGN KEY (retry_of_attempt_id, lifecycle_id)
        REFERENCES workflow_execution_attempts(attempt_id, lifecycle_id),
      FOREIGN KEY (coordination_dispatch_id) REFERENCES unit_dispatches(id),
      FOREIGN KEY (worker_id) REFERENCES workers(worker_id),
      FOREIGN KEY (claim_operation_id, project_id, claim_project_revision, claim_authority_epoch)
        REFERENCES workflow_operations(
          operation_id, project_id, resulting_revision, resulting_authority_epoch
        ),
      FOREIGN KEY (settle_operation_id, project_id, settle_project_revision, settle_authority_epoch)
        REFERENCES workflow_operations(
          operation_id, project_id, resulting_revision, resulting_authority_epoch
        )
    )
  `);

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_attempt_active
    ON workflow_execution_attempts(lifecycle_id)
    WHERE attempt_state IN ('claimed', 'running')
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_workflow_attempt_fencing
    BEFORE INSERT ON workflow_execution_attempts
    WHEN NEW.worker_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM workflow_item_lifecycles lifecycle
      JOIN milestone_leases lease ON lease.milestone_id = lifecycle.milestone_id
      WHERE lifecycle.lifecycle_id = NEW.lifecycle_id
        AND lease.worker_id = NEW.worker_id
        AND lease.fencing_token = NEW.milestone_lease_token
        AND lease.status = 'held'
        AND lease.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    )
    BEGIN
      SELECT RAISE(ABORT, 'workflow attempt requires the current held lease');
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_workflow_attempt_dispatch_scope
    BEFORE INSERT ON workflow_execution_attempts
    WHEN NEW.coordination_dispatch_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM workflow_item_lifecycles lifecycle
      JOIN unit_dispatches dispatch ON dispatch.id = NEW.coordination_dispatch_id
      WHERE lifecycle.lifecycle_id = NEW.lifecycle_id
        AND dispatch.milestone_id = lifecycle.milestone_id
        AND dispatch.slice_id IS lifecycle.slice_id
        AND dispatch.task_id IS lifecycle.task_id
        AND dispatch.worker_id = NEW.worker_id
        AND dispatch.milestone_lease_token = NEW.milestone_lease_token
        AND dispatch.status IN ('claimed', 'running')
    )
    BEGIN
      SELECT RAISE(ABORT, 'coordination dispatch does not match workflow attempt scope');
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_workflow_attempt_transition_fencing
    BEFORE UPDATE ON workflow_execution_attempts
    WHEN NEW.attempt_state != OLD.attempt_state
      AND NEW.worker_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM workflow_item_lifecycles lifecycle
        JOIN milestone_leases lease ON lease.milestone_id = lifecycle.milestone_id
        WHERE lifecycle.lifecycle_id = NEW.lifecycle_id
          AND lease.worker_id = NEW.worker_id
          AND lease.fencing_token = NEW.milestone_lease_token
          AND lease.status = 'held'
          AND lease.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      )
    BEGIN
      SELECT RAISE(ABORT, 'workflow attempt requires the current held lease');
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_workflow_attempt_transition_dispatch_scope
    BEFORE UPDATE ON workflow_execution_attempts
    WHEN NEW.attempt_state != OLD.attempt_state
      AND NEW.coordination_dispatch_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM workflow_item_lifecycles lifecycle
        JOIN unit_dispatches dispatch ON dispatch.id = NEW.coordination_dispatch_id
        WHERE lifecycle.lifecycle_id = NEW.lifecycle_id
          AND dispatch.milestone_id = lifecycle.milestone_id
          AND dispatch.slice_id IS lifecycle.slice_id
          AND dispatch.task_id IS lifecycle.task_id
          AND dispatch.worker_id = NEW.worker_id
          AND dispatch.milestone_lease_token = NEW.milestone_lease_token
          AND dispatch.status IN ('claimed', 'running')
      )
    BEGIN
      SELECT RAISE(ABORT, 'coordination dispatch does not match workflow attempt scope');
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_workflow_attempt_number_sequence
    BEFORE INSERT ON workflow_execution_attempts
    WHEN NEW.attempt_number != COALESCE(
      (SELECT MAX(attempt_number) + 1
       FROM workflow_execution_attempts
       WHERE lifecycle_id = NEW.lifecycle_id),
      1
    )
    BEGIN
      SELECT RAISE(ABORT, 'attempt number must be next for lifecycle');
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_workflow_attempt_retry_sequence
    BEFORE INSERT ON workflow_execution_attempts
    WHEN NEW.retry_of_attempt_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM workflow_execution_attempts prior
      WHERE prior.attempt_id = NEW.retry_of_attempt_id
        AND prior.lifecycle_id = NEW.lifecycle_id
        AND prior.attempt_number = NEW.attempt_number - 1
    )
    BEGIN
      SELECT RAISE(ABORT, 'retry must reference the preceding attempt');
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_workflow_attempt_identity_immutable
    BEFORE UPDATE ON workflow_execution_attempts
    WHEN NEW.attempt_id != OLD.attempt_id
      OR NEW.project_id != OLD.project_id
      OR NEW.lifecycle_id != OLD.lifecycle_id
      OR NEW.attempt_number != OLD.attempt_number
      OR NEW.retry_of_attempt_id IS NOT OLD.retry_of_attempt_id
      OR NEW.coordination_dispatch_id IS NOT OLD.coordination_dispatch_id
      OR NEW.worker_id IS NOT OLD.worker_id
      OR NEW.milestone_lease_token IS NOT OLD.milestone_lease_token
      OR NEW.claimed_at != OLD.claimed_at
      OR (OLD.started_at IS NOT NULL AND NEW.started_at IS NOT OLD.started_at)
      OR NEW.claim_operation_id != OLD.claim_operation_id
      OR NEW.claim_project_revision != OLD.claim_project_revision
      OR NEW.claim_authority_epoch != OLD.claim_authority_epoch
    BEGIN
      SELECT RAISE(ABORT, 'workflow attempt identity is immutable');
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_workflow_attempt_terminal_immutable
    BEFORE UPDATE ON workflow_execution_attempts
    WHEN OLD.attempt_state = 'settled'
    BEGIN
      SELECT RAISE(ABORT, 'settled workflow attempts are immutable');
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_workflow_attempt_transition
    BEFORE UPDATE ON workflow_execution_attempts
    WHEN NOT (
      (OLD.attempt_state = 'claimed' AND NEW.attempt_state IN ('running', 'settled')) OR
      (OLD.attempt_state = 'running' AND NEW.attempt_state = 'settled')
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid workflow attempt transition');
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_workflow_attempt_causal_provenance
    BEFORE UPDATE ON workflow_execution_attempts
    WHEN NEW.attempt_state = 'settled'
      AND (
        NEW.settle_project_revision <= OLD.claim_project_revision
        OR NEW.settle_authority_epoch < OLD.claim_authority_epoch
      )
    BEGIN
      SELECT RAISE(ABORT, 'workflow attempt causal provenance must advance');
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_workflow_attempt_delete
    BEFORE DELETE ON workflow_execution_attempts
    BEGIN
      SELECT RAISE(ABORT, 'workflow attempts are immutable history');
    END
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_attempt_results (
      result_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      lifecycle_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL UNIQUE,
      outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'interrupted')),
      failure_class TEXT NOT NULL DEFAULT 'none',
      summary TEXT NOT NULL DEFAULT '',
      output_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      project_revision INTEGER NOT NULL CHECK (project_revision > 0),
      authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 0),
      FOREIGN KEY (project_id) REFERENCES project_authority(project_id),
      FOREIGN KEY (attempt_id, lifecycle_id)
        REFERENCES workflow_execution_attempts(attempt_id, lifecycle_id),
      FOREIGN KEY (attempt_id, lifecycle_id, operation_id, project_revision, authority_epoch)
        REFERENCES workflow_execution_attempts(
          attempt_id, lifecycle_id,
          settle_operation_id, settle_project_revision, settle_authority_epoch
        ),
      FOREIGN KEY (operation_id, project_id, project_revision, authority_epoch)
        REFERENCES workflow_operations(
          operation_id, project_id, resulting_revision, resulting_authority_epoch
        )
    )
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_workflow_attempt_result_requires_settlement
    BEFORE INSERT ON workflow_attempt_results
    WHEN NOT EXISTS (
      SELECT 1 FROM workflow_execution_attempts attempt
      WHERE attempt.attempt_id = NEW.attempt_id
        AND attempt.lifecycle_id = NEW.lifecycle_id
        AND attempt.attempt_state = 'settled'
    )
    BEGIN
      SELECT RAISE(ABORT, 'attempt result requires a settled attempt');
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_workflow_attempt_results_immutable_update
    BEFORE UPDATE ON workflow_attempt_results
    BEGIN
      SELECT RAISE(ABORT, 'workflow attempt results are immutable');
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_workflow_attempt_results_immutable_delete
    BEFORE DELETE ON workflow_attempt_results
    BEGIN
      SELECT RAISE(ABORT, 'workflow attempt results are immutable');
    END
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_blockers (
      blocker_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      lifecycle_id TEXT NOT NULL,
      blocker_kind TEXT NOT NULL CHECK (blocker_kind IN (
        'missing_authority', 'missing_access', 'external_dependency', 'consent',
        'ambiguous_intent', 'subjective_uat', 'user_limit'
      )),
      resolution_owner TEXT NOT NULL CHECK (resolution_owner IN ('user', 'external')),
      blocker_status TEXT NOT NULL CHECK (blocker_status IN ('open', 'resolved', 'dismissed')),
      description TEXT NOT NULL,
      requested_action TEXT NOT NULL DEFAULT '',
      resolution TEXT NOT NULL DEFAULT '',
      opened_at TEXT NOT NULL,
      resolved_at TEXT DEFAULT NULL,
      opened_operation_id TEXT NOT NULL,
      opened_project_revision INTEGER NOT NULL CHECK (opened_project_revision > 0),
      opened_authority_epoch INTEGER NOT NULL CHECK (opened_authority_epoch >= 0),
      resolved_operation_id TEXT DEFAULT NULL,
      resolved_project_revision INTEGER DEFAULT NULL,
      resolved_authority_epoch INTEGER DEFAULT NULL,
      UNIQUE (blocker_id, lifecycle_id),
      CHECK (
        (blocker_status = 'open' AND resolved_at IS NULL
          AND resolved_operation_id IS NULL AND resolved_project_revision IS NULL
          AND resolved_authority_epoch IS NULL) OR
        (blocker_status IN ('resolved', 'dismissed') AND resolved_at IS NOT NULL
          AND resolved_operation_id IS NOT NULL AND resolved_project_revision > 0
          AND resolved_authority_epoch >= 0)
      ),
      FOREIGN KEY (project_id) REFERENCES project_authority(project_id),
      FOREIGN KEY (lifecycle_id, project_id)
        REFERENCES workflow_item_lifecycles(lifecycle_id, project_id),
      FOREIGN KEY (opened_operation_id, project_id, opened_project_revision, opened_authority_epoch)
        REFERENCES workflow_operations(
          operation_id, project_id, resulting_revision, resulting_authority_epoch
        ),
      FOREIGN KEY (resolved_operation_id, project_id, resolved_project_revision, resolved_authority_epoch)
        REFERENCES workflow_operations(
          operation_id, project_id, resulting_revision, resulting_authority_epoch
        )
    )
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_workflow_blocker_terminal_immutable
    BEFORE UPDATE ON workflow_blockers
    WHEN OLD.blocker_status IN ('resolved', 'dismissed')
    BEGIN
      SELECT RAISE(ABORT, 'terminal workflow blockers are immutable');
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_workflow_blocker_opening_immutable
    BEFORE UPDATE ON workflow_blockers
    WHEN NEW.blocker_id != OLD.blocker_id
      OR NEW.project_id != OLD.project_id
      OR NEW.lifecycle_id != OLD.lifecycle_id
      OR NEW.blocker_kind != OLD.blocker_kind
      OR NEW.resolution_owner != OLD.resolution_owner
      OR NEW.description != OLD.description
      OR NEW.requested_action != OLD.requested_action
      OR NEW.opened_at != OLD.opened_at
      OR NEW.opened_operation_id != OLD.opened_operation_id
      OR NEW.opened_project_revision != OLD.opened_project_revision
      OR NEW.opened_authority_epoch != OLD.opened_authority_epoch
    BEGIN
      SELECT RAISE(ABORT, 'workflow blocker opening is immutable');
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_workflow_blocker_transition
    BEFORE UPDATE ON workflow_blockers
    WHEN OLD.blocker_status != 'open'
      OR NEW.blocker_status NOT IN ('resolved', 'dismissed')
    BEGIN
      SELECT RAISE(ABORT, 'invalid workflow blocker transition');
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_workflow_blocker_causal_provenance
    BEFORE UPDATE ON workflow_blockers
    WHEN NEW.blocker_status IN ('resolved', 'dismissed')
      AND (
        NEW.resolved_project_revision <= OLD.opened_project_revision
        OR NEW.resolved_authority_epoch < OLD.opened_authority_epoch
      )
    BEGIN
      SELECT RAISE(ABORT, 'workflow blocker causal provenance must advance');
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_workflow_blocker_delete
    BEFORE DELETE ON workflow_blockers
    BEGIN
      SELECT RAISE(ABORT, 'workflow blockers are durable history');
    END
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_waivers (
      waiver_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      lifecycle_id TEXT NOT NULL,
      requirement_id TEXT DEFAULT NULL,
      blocker_id TEXT DEFAULT NULL,
      waiver_status TEXT NOT NULL CHECK (waiver_status IN ('active', 'revoked', 'expired')),
      scope TEXT NOT NULL,
      rationale TEXT NOT NULL,
      granted_by_actor_type TEXT NOT NULL CHECK (granted_by_actor_type IN ('user', 'policy')),
      granted_by_actor_id TEXT DEFAULT NULL,
      granted_at TEXT NOT NULL,
      expires_at TEXT DEFAULT NULL,
      ended_at TEXT DEFAULT NULL,
      operation_id TEXT NOT NULL,
      project_revision INTEGER NOT NULL CHECK (project_revision > 0),
      authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 0),
      ended_operation_id TEXT DEFAULT NULL,
      ended_project_revision INTEGER DEFAULT NULL,
      ended_authority_epoch INTEGER DEFAULT NULL,
      UNIQUE (waiver_id, requirement_id),
      CHECK (granted_by_actor_type != 'user' OR granted_by_actor_id IS NOT NULL),
      CHECK (
        (waiver_status = 'active' AND ended_at IS NULL
          AND ended_operation_id IS NULL AND ended_project_revision IS NULL
          AND ended_authority_epoch IS NULL) OR
        (waiver_status IN ('revoked', 'expired') AND ended_at IS NOT NULL
          AND ended_operation_id IS NOT NULL AND ended_project_revision > 0
          AND ended_authority_epoch >= 0)
      ),
      FOREIGN KEY (project_id) REFERENCES project_authority(project_id),
      FOREIGN KEY (lifecycle_id, project_id)
        REFERENCES workflow_item_lifecycles(lifecycle_id, project_id),
      FOREIGN KEY (requirement_id) REFERENCES requirements(id),
      FOREIGN KEY (blocker_id, lifecycle_id)
        REFERENCES workflow_blockers(blocker_id, lifecycle_id),
      FOREIGN KEY (operation_id, project_id, project_revision, authority_epoch)
        REFERENCES workflow_operations(
          operation_id, project_id, resulting_revision, resulting_authority_epoch
        ),
      FOREIGN KEY (ended_operation_id, project_id, ended_project_revision, ended_authority_epoch)
        REFERENCES workflow_operations(
          operation_id, project_id, resulting_revision, resulting_authority_epoch
        )
    )
  `);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_waiver_active_blocker
    ON workflow_waivers(blocker_id)
    WHERE waiver_status = 'active' AND blocker_id IS NOT NULL
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_workflow_waiver_terminal_immutable
    BEFORE UPDATE ON workflow_waivers
    WHEN OLD.waiver_status IN ('revoked', 'expired')
    BEGIN
      SELECT RAISE(ABORT, 'terminal workflow waivers are immutable');
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_workflow_waiver_grant_immutable
    BEFORE UPDATE ON workflow_waivers
    WHEN NEW.waiver_id != OLD.waiver_id
      OR NEW.project_id != OLD.project_id
      OR NEW.lifecycle_id != OLD.lifecycle_id
      OR NEW.requirement_id IS NOT OLD.requirement_id
      OR NEW.blocker_id IS NOT OLD.blocker_id
      OR NEW.scope != OLD.scope
      OR NEW.rationale != OLD.rationale
      OR NEW.granted_by_actor_type != OLD.granted_by_actor_type
      OR NEW.granted_by_actor_id IS NOT OLD.granted_by_actor_id
      OR NEW.granted_at != OLD.granted_at
      OR NEW.expires_at IS NOT OLD.expires_at
      OR NEW.operation_id != OLD.operation_id
      OR NEW.project_revision != OLD.project_revision
      OR NEW.authority_epoch != OLD.authority_epoch
    BEGIN
      SELECT RAISE(ABORT, 'workflow waiver grant is immutable');
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_workflow_waiver_transition
    BEFORE UPDATE ON workflow_waivers
    WHEN OLD.waiver_status != 'active'
      OR NEW.waiver_status NOT IN ('revoked', 'expired')
    BEGIN
      SELECT RAISE(ABORT, 'invalid workflow waiver transition');
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_workflow_waiver_causal_provenance
    BEFORE UPDATE ON workflow_waivers
    WHEN NEW.waiver_status IN ('revoked', 'expired')
      AND (
        NEW.ended_project_revision <= OLD.project_revision
        OR NEW.ended_authority_epoch < OLD.authority_epoch
      )
    BEGIN
      SELECT RAISE(ABORT, 'workflow waiver causal provenance must advance');
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_workflow_waiver_delete
    BEFORE DELETE ON workflow_waivers
    BEGIN
      SELECT RAISE(ABORT, 'workflow waivers are durable history');
    END
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_requirement_dispositions (
      disposition_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      requirement_id TEXT NOT NULL,
      disposition TEXT NOT NULL CHECK (disposition IN ('unsatisfied', 'satisfied', 'waived')),
      waiver_id TEXT DEFAULT NULL,
      supersedes_disposition_id TEXT DEFAULT NULL UNIQUE,
      rationale TEXT NOT NULL,
      created_at TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      project_revision INTEGER NOT NULL CHECK (project_revision > 0),
      authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 0),
      UNIQUE (disposition_id, requirement_id),
      CHECK (
        (disposition = 'waived' AND waiver_id IS NOT NULL) OR
        (disposition IN ('unsatisfied', 'satisfied') AND waiver_id IS NULL)
      ),
      FOREIGN KEY (project_id) REFERENCES project_authority(project_id),
      FOREIGN KEY (requirement_id) REFERENCES requirements(id),
      FOREIGN KEY (waiver_id, requirement_id)
        REFERENCES workflow_waivers(waiver_id, requirement_id),
      FOREIGN KEY (supersedes_disposition_id, requirement_id)
        REFERENCES workflow_requirement_dispositions(disposition_id, requirement_id),
      FOREIGN KEY (operation_id, project_id, project_revision, authority_epoch)
        REFERENCES workflow_operations(
          operation_id, project_id, resulting_revision, resulting_authority_epoch
        )
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_workflow_requirement_disposition_history
    ON workflow_requirement_dispositions(requirement_id, project_revision, disposition_id)
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_workflow_requirement_disposition_waiver_authority
    BEFORE INSERT ON workflow_requirement_dispositions
    WHEN NEW.disposition = 'waived'
      AND NEW.waiver_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM workflow_waivers waiver
        WHERE waiver.waiver_id = NEW.waiver_id
          AND waiver.requirement_id = NEW.requirement_id
          AND waiver.project_id = NEW.project_id
          AND waiver.waiver_status = 'active'
          AND (waiver.expires_at IS NULL OR waiver.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
          AND waiver.project_revision < NEW.project_revision
          AND waiver.authority_epoch <= NEW.authority_epoch
      )
    BEGIN
      SELECT RAISE(ABORT, 'waived disposition requires an active unexpired waiver');
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_workflow_requirement_disposition_causal_provenance
    BEFORE INSERT ON workflow_requirement_dispositions
    WHEN NEW.supersedes_disposition_id IS NOT NULL AND EXISTS (
      SELECT 1
      FROM workflow_requirement_dispositions prior
      WHERE prior.disposition_id = NEW.supersedes_disposition_id
        AND (
          NEW.project_revision <= prior.project_revision
          OR NEW.authority_epoch < prior.authority_epoch
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'workflow disposition causal provenance must advance');
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_workflow_requirement_disposition_head
    BEFORE INSERT ON workflow_requirement_dispositions
    WHEN (
      NOT EXISTS (
        SELECT 1 FROM workflow_requirement_dispositions
        WHERE requirement_id = NEW.requirement_id
      )
      AND NEW.supersedes_disposition_id IS NOT NULL
    ) OR (
      EXISTS (
        SELECT 1 FROM workflow_requirement_dispositions
        WHERE requirement_id = NEW.requirement_id
      )
      AND (
        NEW.supersedes_disposition_id IS NULL OR
        NOT EXISTS (
          SELECT 1
          FROM workflow_requirement_dispositions head
          WHERE head.requirement_id = NEW.requirement_id
            AND head.disposition_id = NEW.supersedes_disposition_id
            AND NOT EXISTS (
              SELECT 1
              FROM workflow_requirement_dispositions successor
              WHERE successor.supersedes_disposition_id = head.disposition_id
            )
        )
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'requirement disposition must supersede the current head');
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_workflow_requirement_dispositions_immutable_update
    BEFORE UPDATE ON workflow_requirement_dispositions
    BEGIN
      SELECT RAISE(ABORT, 'workflow requirement dispositions are immutable');
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_workflow_requirement_dispositions_immutable_delete
    BEFORE DELETE ON workflow_requirement_dispositions
    BEGIN
      SELECT RAISE(ABORT, 'workflow requirement dispositions are immutable');
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_workflow_waiver_dependent_disposition
    BEFORE UPDATE ON workflow_waivers
    WHEN OLD.waiver_status = 'active'
      AND NEW.waiver_status IN ('revoked', 'expired')
      AND EXISTS (
        SELECT 1
        FROM workflow_requirement_dispositions disposition
        WHERE disposition.waiver_id = OLD.waiver_id
          AND disposition.disposition = 'waived'
          AND NOT EXISTS (
            SELECT 1
            FROM workflow_requirement_dispositions successor
            WHERE successor.supersedes_disposition_id = disposition.disposition_id
          )
      )
    BEGIN
      SELECT RAISE(ABORT, 'waiver termination must supersede its current waived disposition');
    END
  `);
}
