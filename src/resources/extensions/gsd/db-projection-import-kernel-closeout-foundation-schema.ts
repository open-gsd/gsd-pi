// Project/App: gsd-pi
// File Purpose: Additive v35 projection, import, kernel checkpoint, and closeout settlement schema.

import type { DbAdapter } from "./db-adapter.js";

export function createKernelCheckpointChainTrigger(db: DbAdapter): void {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_workflow_kernel_checkpoint_chain
    BEFORE INSERT ON workflow_kernel_checkpoints
    WHEN (
      NEW.previous_kernel_checkpoint_id IS NULL AND (
        NEW.sequence != 1 OR NEW.next_stage != 'execute' OR EXISTS (
          SELECT 1 FROM workflow_kernel_checkpoints existing
          WHERE existing.project_id = NEW.project_id
            AND existing.lifecycle_id = NEW.lifecycle_id
        )
      )
    ) OR (
      NEW.previous_kernel_checkpoint_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM workflow_kernel_checkpoints previous
        WHERE previous.kernel_checkpoint_id = NEW.previous_kernel_checkpoint_id
          AND previous.project_id = NEW.project_id
          AND previous.lifecycle_id = NEW.lifecycle_id
          AND NEW.sequence = previous.sequence + 1
          AND (
            previous.project_revision < NEW.project_revision OR (
              previous.project_revision = NEW.project_revision
              AND previous.operation_id = NEW.operation_id
              AND previous.authority_epoch = NEW.authority_epoch
            )
          )
          AND previous.authority_epoch <= NEW.authority_epoch
          AND NOT EXISTS (
            SELECT 1 FROM workflow_kernel_checkpoints successor
            WHERE successor.previous_kernel_checkpoint_id = previous.kernel_checkpoint_id
          )
          AND (
            NEW.attempt_id = previous.attempt_id OR (
              NEW.next_stage = 'execute' AND EXISTS (
                SELECT 1 FROM workflow_execution_attempts retry
                WHERE retry.attempt_id = NEW.attempt_id
                  AND retry.project_id = NEW.project_id
                  AND retry.lifecycle_id = NEW.lifecycle_id
                  AND retry.retry_of_attempt_id = previous.attempt_id
              )
            )
          )
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'kernel checkpoint must extend the current lifecycle head');
    END;
  `);
}

/**
 * V35 records desired projection work and immutable import/kernel/closeout
 * facts. Projection delivery is operational and intentionally does not create
 * workflow operations. The S06 boundary owns the base atomic operation bundle;
 * later command writers own sibling facts, prerequisites, effects, lifecycle
 * completion, and runtime cutover.
 */
export function createProjectionImportKernelCloseoutFoundationSchemaV35(db: DbAdapter): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_projection_work (
      projection_work_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      projection_key TEXT NOT NULL CHECK (
        length(trim(projection_key)) > 0 AND projection_key = lower(trim(projection_key))
      ),
      projection_kind TEXT NOT NULL CHECK (
        length(trim(projection_kind)) > 0 AND projection_kind = lower(trim(projection_kind))
      ),
      supersedes_projection_work_id TEXT DEFAULT NULL UNIQUE,
      source_project_revision INTEGER NOT NULL CHECK (source_project_revision > 0),
      source_authority_epoch INTEGER NOT NULL CHECK (source_authority_epoch >= 0),
      renderer_version TEXT NOT NULL CHECK (length(trim(renderer_version)) > 0),
      delivery_state TEXT NOT NULL DEFAULT 'pending' CHECK (
        delivery_state IN ('pending', 'claimed', 'rendered', 'dead_letter')
      ),
      state_version INTEGER NOT NULL DEFAULT 0 CHECK (state_version >= 0),
      claim_owner TEXT DEFAULT NULL,
      claim_fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (claim_fencing_token >= 0),
      claimed_at TEXT DEFAULT NULL,
      claim_expires_at TEXT DEFAULT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at TEXT NOT NULL DEFAULT '',
      last_error TEXT NOT NULL DEFAULT '',
      rendered_content_hash TEXT DEFAULT NULL,
      rendered_at TEXT DEFAULT NULL,
      enqueue_operation_id TEXT NOT NULL,
      created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
      updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0),
      UNIQUE (projection_work_id, project_id, projection_key),
      UNIQUE (project_id, projection_key, source_project_revision),
      CHECK (
        (delivery_state = 'pending'
          AND claim_owner IS NULL AND claimed_at IS NULL AND claim_expires_at IS NULL
          AND rendered_content_hash IS NULL AND rendered_at IS NULL
          AND (
            (attempt_count = 0 AND next_attempt_at = '' AND last_error = '') OR
            (attempt_count > 0
              AND length(trim(last_error)) > 0
              AND julianday(updated_at) IS NOT NULL
              AND julianday(next_attempt_at) IS NOT NULL
              AND julianday(next_attempt_at) > julianday(updated_at))
          )) OR
        (delivery_state = 'claimed'
          AND claim_owner IS NOT NULL AND length(trim(claim_owner)) > 0
          AND claim_fencing_token > 0
          AND julianday(claimed_at) IS NOT NULL AND julianday(claim_expires_at) IS NOT NULL
          AND julianday(claim_expires_at) > julianday(claimed_at)
          AND rendered_content_hash IS NULL AND rendered_at IS NULL
          AND (
            (attempt_count = 0 AND next_attempt_at = '' AND last_error = '') OR
            (attempt_count > 0
              AND length(trim(last_error)) > 0
              AND julianday(next_attempt_at) IS NOT NULL)
          )) OR
        (delivery_state = 'rendered'
          AND claim_owner IS NULL AND claimed_at IS NULL AND claim_expires_at IS NULL
          AND rendered_content_hash IS NOT NULL AND length(rendered_content_hash) = 71
          AND substr(rendered_content_hash, 1, 7) = 'sha256:'
          AND rendered_content_hash = lower(rendered_content_hash)
          AND substr(rendered_content_hash, 8) NOT GLOB '*[^0-9a-f]*'
          AND rendered_at IS NOT NULL) OR
        (delivery_state = 'dead_letter'
          AND claim_owner IS NULL AND claimed_at IS NULL AND claim_expires_at IS NULL
          AND rendered_content_hash IS NULL AND rendered_at IS NULL
          AND length(trim(last_error)) > 0)
      ),
      FOREIGN KEY (project_id) REFERENCES project_authority(project_id),
      FOREIGN KEY (supersedes_projection_work_id)
        REFERENCES workflow_projection_work(projection_work_id),
      FOREIGN KEY (
        enqueue_operation_id, project_id, source_project_revision, source_authority_epoch
      ) REFERENCES workflow_operations(
        operation_id, project_id, resulting_revision, resulting_authority_epoch
      )
    );

    CREATE TRIGGER IF NOT EXISTS trg_workflow_projection_initial_state
    BEFORE INSERT ON workflow_projection_work
    WHEN NEW.delivery_state != 'pending'
      OR NEW.state_version != 0
      OR NEW.claim_fencing_token != 0
      OR NEW.attempt_count != 0
      OR NEW.claim_owner IS NOT NULL
      OR NEW.claimed_at IS NOT NULL
      OR NEW.claim_expires_at IS NOT NULL
      OR NEW.rendered_content_hash IS NOT NULL
      OR NEW.rendered_at IS NOT NULL
      OR NEW.next_attempt_at != ''
      OR NEW.last_error != ''
      OR NEW.created_at != NEW.updated_at
    BEGIN
      SELECT RAISE(ABORT, 'projection work must begin pending and unclaimed');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_projection_lineage
    BEFORE INSERT ON workflow_projection_work
    WHEN (
      NEW.supersedes_projection_work_id IS NULL AND EXISTS (
        SELECT 1 FROM workflow_projection_work existing
        WHERE existing.project_id = NEW.project_id
          AND existing.projection_key = NEW.projection_key
      )
    ) OR (
      NEW.supersedes_projection_work_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM workflow_projection_work previous
        WHERE previous.projection_work_id = NEW.supersedes_projection_work_id
          AND previous.project_id = NEW.project_id
          AND previous.projection_key = NEW.projection_key
          AND previous.projection_kind = NEW.projection_kind
          AND previous.source_project_revision < NEW.source_project_revision
          AND previous.source_authority_epoch <= NEW.source_authority_epoch
          AND NOT EXISTS (
            SELECT 1 FROM workflow_projection_work successor
            WHERE successor.supersedes_projection_work_id = previous.projection_work_id
          )
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'projection work must extend the current logical target head');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_projection_identity_immutable
    BEFORE UPDATE ON workflow_projection_work
    WHEN NEW.projection_work_id != OLD.projection_work_id
      OR NEW.project_id != OLD.project_id
      OR NEW.projection_key != OLD.projection_key
      OR NEW.projection_kind != OLD.projection_kind
      OR NEW.supersedes_projection_work_id IS NOT OLD.supersedes_projection_work_id
      OR NEW.source_project_revision != OLD.source_project_revision
      OR NEW.source_authority_epoch != OLD.source_authority_epoch
      OR NEW.renderer_version != OLD.renderer_version
      OR NEW.enqueue_operation_id != OLD.enqueue_operation_id
      OR NEW.created_at != OLD.created_at
    BEGIN
      SELECT RAISE(ABORT, 'projection desired identity is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_projection_current_head_update
    BEFORE UPDATE ON workflow_projection_work
    WHEN EXISTS (
      SELECT 1 FROM workflow_projection_work successor
      WHERE successor.supersedes_projection_work_id = OLD.projection_work_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'superseded projection work cannot be delivered');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_projection_delivery_transition
    BEFORE UPDATE ON workflow_projection_work
    WHEN NEW.state_version != OLD.state_version + 1
      OR NEW.updated_at = OLD.updated_at
      OR NOT (
        (OLD.delivery_state = 'pending' AND NEW.delivery_state = 'claimed'
          AND NEW.claim_fencing_token = OLD.claim_fencing_token + 1
          AND NEW.next_attempt_at = OLD.next_attempt_at
          AND NEW.last_error = OLD.last_error
          AND NEW.attempt_count = OLD.attempt_count) OR
        (OLD.delivery_state = 'claimed' AND NEW.delivery_state = 'claimed'
          AND NEW.claim_owner = OLD.claim_owner
          AND NEW.claim_fencing_token = OLD.claim_fencing_token
          AND NEW.claimed_at = OLD.claimed_at
          AND julianday(NEW.claim_expires_at) > julianday(OLD.claim_expires_at)
          AND NEW.next_attempt_at = OLD.next_attempt_at
          AND NEW.last_error = OLD.last_error
          AND NEW.attempt_count = OLD.attempt_count) OR
        (OLD.delivery_state = 'claimed' AND NEW.delivery_state IN ('pending', 'rendered', 'dead_letter')
          AND NEW.claim_fencing_token = OLD.claim_fencing_token
          AND NEW.attempt_count = OLD.attempt_count + 1)
      )
    BEGIN
      SELECT RAISE(ABORT, 'invalid projection delivery transition');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_projection_delete
    BEFORE DELETE ON workflow_projection_work
    BEGIN
      SELECT RAISE(ABORT, 'projection work is durable history');
    END;

    CREATE INDEX IF NOT EXISTS idx_workflow_projection_delivery
      ON workflow_projection_work(project_id, delivery_state, next_attempt_at);
    CREATE TABLE IF NOT EXISTS workflow_import_applications (
      operation_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      import_kind TEXT NOT NULL CHECK (
        length(trim(import_kind)) > 0 AND import_kind = lower(trim(import_kind))
      ),
      importer_version TEXT NOT NULL CHECK (length(trim(importer_version)) > 0),
      preview_schema_version INTEGER NOT NULL CHECK (preview_schema_version > 0),
      preview_id TEXT NOT NULL UNIQUE CHECK (length(trim(preview_id)) > 0),
      preview_hash TEXT NOT NULL UNIQUE CHECK (
        length(preview_hash) = 71 AND substr(preview_hash, 1, 7) = 'sha256:' AND
        preview_hash = lower(preview_hash) AND substr(preview_hash, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      base_project_revision INTEGER NOT NULL CHECK (base_project_revision >= 0),
      base_authority_epoch INTEGER NOT NULL CHECK (base_authority_epoch >= 0),
      base_database_schema_version INTEGER NOT NULL CHECK (base_database_schema_version > 0),
      source_set_hash TEXT NOT NULL CHECK (
        length(source_set_hash) = 71 AND substr(source_set_hash, 1, 7) = 'sha256:' AND
        source_set_hash = lower(source_set_hash) AND substr(source_set_hash, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      change_set_hash TEXT NOT NULL CHECK (
        length(change_set_hash) = 71 AND substr(change_set_hash, 1, 7) = 'sha256:' AND
        change_set_hash = lower(change_set_hash) AND substr(change_set_hash, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      create_count INTEGER NOT NULL CHECK (create_count >= 0),
      update_count INTEGER NOT NULL CHECK (update_count >= 0),
      delete_count INTEGER NOT NULL CHECK (delete_count >= 0),
      preserve_count INTEGER NOT NULL CHECK (preserve_count >= 0),
      unparsed_count INTEGER NOT NULL CHECK (unparsed_count >= 0),
      unresolved_count INTEGER NOT NULL CHECK (unresolved_count = 0),
      preview_json TEXT NOT NULL CHECK (
        json_valid(preview_json) AND json_type(preview_json) = 'object' AND
        json_extract(preview_json, '$.preview_schema_version') IS preview_schema_version AND
        json_extract(preview_json, '$.preview_id') IS preview_id AND
        json_extract(preview_json, '$.import_kind') IS import_kind AND
        json_extract(preview_json, '$.importer_version') IS importer_version AND
        json_extract(preview_json, '$.base_project_revision') IS base_project_revision AND
        json_extract(preview_json, '$.base_authority_epoch') IS base_authority_epoch AND
        json_extract(preview_json, '$.base_database_schema_version')
          IS base_database_schema_version AND
        json_extract(preview_json, '$.source_set_hash') IS source_set_hash AND
        json_extract(preview_json, '$.change_set_hash') IS change_set_hash AND
        json_extract(preview_json, '$.counts.create') IS create_count AND
        json_extract(preview_json, '$.counts.update') IS update_count AND
        json_extract(preview_json, '$.counts.delete') IS delete_count AND
        json_extract(preview_json, '$.counts.preserve') IS preserve_count AND
        json_extract(preview_json, '$.counts.unparsed') IS unparsed_count AND
        json_extract(preview_json, '$.counts.unresolved') IS unresolved_count AND
        json_type(preview_json, '$.sources') IS 'array' AND
        json_type(preview_json, '$.changes') IS 'array' AND
        json_type(preview_json, '$.diagnoses') IS 'array' AND
        json_type(preview_json, '$.resolutions') IS 'array'
      ),
      backup_ref TEXT NOT NULL CHECK (length(trim(backup_ref)) > 0),
      backup_sha256 TEXT NOT NULL CHECK (
        length(backup_sha256) = 71 AND substr(backup_sha256, 1, 7) = 'sha256:' AND
        backup_sha256 = lower(backup_sha256) AND substr(backup_sha256, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      backup_byte_size INTEGER NOT NULL CHECK (backup_byte_size > 0),
      backup_schema_version INTEGER NOT NULL CHECK (backup_schema_version > 0),
      backup_project_revision INTEGER NOT NULL CHECK (backup_project_revision >= 0),
      backup_authority_epoch INTEGER NOT NULL CHECK (backup_authority_epoch >= 0),
      backup_quick_check TEXT NOT NULL CHECK (backup_quick_check = 'ok'),
      backup_verified_at TEXT NOT NULL CHECK (length(trim(backup_verified_at)) > 0),
      applied_at TEXT NOT NULL CHECK (length(trim(applied_at)) > 0),
      resulting_project_revision INTEGER NOT NULL CHECK (
        resulting_project_revision = base_project_revision + 1
      ),
      resulting_authority_epoch INTEGER NOT NULL CHECK (resulting_authority_epoch >= 0),
      FOREIGN KEY (project_id) REFERENCES project_authority(project_id),
      FOREIGN KEY (
        operation_id, project_id, resulting_project_revision, resulting_authority_epoch
      ) REFERENCES workflow_operations(
        operation_id, project_id, resulting_revision, resulting_authority_epoch
      )
    );

    CREATE TRIGGER IF NOT EXISTS trg_workflow_import_application_causality
    BEFORE INSERT ON workflow_import_applications
    WHEN NEW.backup_schema_version != NEW.base_database_schema_version
      OR NEW.backup_project_revision != NEW.base_project_revision
      OR NEW.backup_authority_epoch != NEW.base_authority_epoch
      OR NOT EXISTS (
        SELECT 1 FROM workflow_operations operation
        WHERE operation.operation_id = NEW.operation_id
          AND operation.project_id = NEW.project_id
          AND operation.operation_type = 'import.apply'
          AND operation.expected_revision = NEW.base_project_revision
          AND operation.resulting_revision = NEW.resulting_project_revision
          AND operation.expected_authority_epoch = NEW.base_authority_epoch
          AND operation.resulting_authority_epoch = NEW.resulting_authority_epoch
          AND operation.request_hash = NEW.preview_hash
      )
    BEGIN
      SELECT RAISE(ABORT, 'import application must match its operation and verified base backup');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_import_operation_update
    BEFORE UPDATE ON workflow_operations
    WHEN EXISTS (
      SELECT 1 FROM workflow_import_applications application
      WHERE application.operation_id = OLD.operation_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'import application operations are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_import_application_update
    BEFORE UPDATE ON workflow_import_applications
    BEGIN
      SELECT RAISE(ABORT, 'import applications are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_workflow_import_application_delete
    BEFORE DELETE ON workflow_import_applications
    BEGIN
      SELECT RAISE(ABORT, 'import applications are immutable');
    END;

    CREATE TABLE IF NOT EXISTS workflow_kernel_checkpoints (
      kernel_checkpoint_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      lifecycle_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      next_stage TEXT NOT NULL CHECK (
        next_stage IN ('execute', 'verify', 'route', 'closeout', 'settled')
      ),
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      previous_kernel_checkpoint_id TEXT DEFAULT NULL UNIQUE,
      created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
      operation_id TEXT NOT NULL,
      project_revision INTEGER NOT NULL CHECK (project_revision > 0),
      authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 0),
      UNIQUE (project_id, lifecycle_id, sequence),
      UNIQUE (kernel_checkpoint_id, project_id, lifecycle_id, attempt_id),
      FOREIGN KEY (project_id) REFERENCES project_authority(project_id),
      FOREIGN KEY (lifecycle_id, project_id)
        REFERENCES workflow_item_lifecycles(lifecycle_id, project_id),
      FOREIGN KEY (attempt_id, lifecycle_id, project_id)
        REFERENCES workflow_execution_attempts(attempt_id, lifecycle_id, project_id),
      FOREIGN KEY (previous_kernel_checkpoint_id)
        REFERENCES workflow_kernel_checkpoints(kernel_checkpoint_id),
      FOREIGN KEY (operation_id, project_id, project_revision, authority_epoch)
        REFERENCES workflow_operations(
          operation_id, project_id, resulting_revision, resulting_authority_epoch
        )
    );

    CREATE TRIGGER IF NOT EXISTS trg_workflow_kernel_checkpoint_attempt_claim
    BEFORE INSERT ON workflow_kernel_checkpoints
    WHEN (
      NEW.previous_kernel_checkpoint_id IS NULL OR EXISTS (
        SELECT 1 FROM workflow_kernel_checkpoints previous
        WHERE previous.kernel_checkpoint_id = NEW.previous_kernel_checkpoint_id
          AND previous.attempt_id != NEW.attempt_id
      )
    ) AND NOT EXISTS (
      SELECT 1 FROM workflow_execution_attempts attempt
      WHERE attempt.attempt_id = NEW.attempt_id
        AND attempt.project_id = NEW.project_id
        AND attempt.lifecycle_id = NEW.lifecycle_id
        AND attempt.claim_operation_id = NEW.operation_id
        AND attempt.claim_project_revision = NEW.project_revision
        AND attempt.claim_authority_epoch = NEW.authority_epoch
    )
    BEGIN
      SELECT RAISE(ABORT, 'execute checkpoint must share its Attempt claim operation');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_kernel_checkpoint_update
    BEFORE UPDATE ON workflow_kernel_checkpoints
    BEGIN
      SELECT RAISE(ABORT, 'kernel checkpoints are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_workflow_kernel_checkpoint_delete
    BEFORE DELETE ON workflow_kernel_checkpoints
    BEGIN
      SELECT RAISE(ABORT, 'kernel checkpoints are immutable');
    END;
    CREATE TABLE IF NOT EXISTS workflow_closeout_plans (
      closeout_plan_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      lifecycle_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      tested_source_set_hash TEXT NOT NULL CHECK (
        length(tested_source_set_hash) = 71 AND
        substr(tested_source_set_hash, 1, 7) = 'sha256:' AND
        tested_source_set_hash = lower(tested_source_set_hash) AND
        substr(tested_source_set_hash, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      readiness_basis_hash TEXT NOT NULL CHECK (
        length(readiness_basis_hash) = 71 AND
        substr(readiness_basis_hash, 1, 7) = 'sha256:' AND
        readiness_basis_hash = lower(readiness_basis_hash) AND
        substr(readiness_basis_hash, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      supersedes_closeout_plan_id TEXT DEFAULT NULL UNIQUE,
      prepared_at TEXT NOT NULL CHECK (length(trim(prepared_at)) > 0),
      operation_id TEXT NOT NULL,
      project_revision INTEGER NOT NULL CHECK (project_revision > 0),
      authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 0),
      UNIQUE (
        closeout_plan_id, project_id, lifecycle_id,
        operation_id, project_revision, authority_epoch
      ),
      UNIQUE (closeout_plan_id, project_id, lifecycle_id, attempt_id),
      FOREIGN KEY (project_id) REFERENCES project_authority(project_id),
      FOREIGN KEY (lifecycle_id, project_id)
        REFERENCES workflow_item_lifecycles(lifecycle_id, project_id),
      FOREIGN KEY (attempt_id, lifecycle_id, project_id)
        REFERENCES workflow_execution_attempts(attempt_id, lifecycle_id, project_id),
      FOREIGN KEY (supersedes_closeout_plan_id)
        REFERENCES workflow_closeout_plans(closeout_plan_id),
      FOREIGN KEY (operation_id, project_id, project_revision, authority_epoch)
        REFERENCES workflow_operations(
          operation_id, project_id, resulting_revision, resulting_authority_epoch
        )
    );

    CREATE TRIGGER IF NOT EXISTS trg_workflow_closeout_plan_attempt
    BEFORE INSERT ON workflow_closeout_plans
    WHEN NOT EXISTS (
      SELECT 1
      FROM workflow_execution_attempts attempt
      JOIN workflow_attempt_results result ON result.attempt_id = attempt.attempt_id
      WHERE attempt.attempt_id = NEW.attempt_id
        AND attempt.project_id = NEW.project_id
        AND attempt.lifecycle_id = NEW.lifecycle_id
        AND attempt.attempt_state = 'settled'
        AND attempt.settle_project_revision < NEW.project_revision
        AND attempt.settle_authority_epoch <= NEW.authority_epoch
        AND result.project_id = NEW.project_id
        AND result.lifecycle_id = NEW.lifecycle_id
        AND result.outcome = 'succeeded'
        AND result.project_revision < NEW.project_revision
        AND result.authority_epoch <= NEW.authority_epoch
    )
    BEGIN
      SELECT RAISE(ABORT, 'closeout plan requires a causally prior settled attempt');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_closeout_plan_head
    BEFORE INSERT ON workflow_closeout_plans
    WHEN (
      NEW.supersedes_closeout_plan_id IS NULL AND EXISTS (
        SELECT 1 FROM workflow_closeout_plans existing
        WHERE existing.project_id = NEW.project_id
          AND existing.lifecycle_id = NEW.lifecycle_id
      )
    ) OR (
      NEW.supersedes_closeout_plan_id IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM workflow_closeout_plans previous
        JOIN workflow_execution_attempts previous_attempt
          ON previous_attempt.attempt_id = previous.attempt_id
        JOIN workflow_execution_attempts next_attempt
          ON next_attempt.attempt_id = NEW.attempt_id
        WHERE previous.closeout_plan_id = NEW.supersedes_closeout_plan_id
          AND previous.project_id = NEW.project_id
          AND previous.lifecycle_id = NEW.lifecycle_id
          AND previous.project_revision < NEW.project_revision
          AND previous.authority_epoch <= NEW.authority_epoch
          AND NOT EXISTS (
            SELECT 1 FROM workflow_closeout_plans successor
            WHERE successor.supersedes_closeout_plan_id = previous.closeout_plan_id
          )
          AND (
            NEW.attempt_id = previous.attempt_id OR
            next_attempt.attempt_number > previous_attempt.attempt_number
          )
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'closeout plan must extend the current lifecycle head');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_closeout_plan_update
    BEFORE UPDATE ON workflow_closeout_plans
    BEGIN
      SELECT RAISE(ABORT, 'closeout plans are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_workflow_closeout_plan_delete
    BEFORE DELETE ON workflow_closeout_plans
    BEGIN
      SELECT RAISE(ABORT, 'closeout plans are immutable');
    END;
    CREATE INDEX IF NOT EXISTS idx_workflow_closeout_plan_head
      ON workflow_closeout_plans(project_id, lifecycle_id, project_revision DESC);

    CREATE TABLE IF NOT EXISTS workflow_closeout_effects (
      closeout_effect_id TEXT PRIMARY KEY,
      closeout_plan_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      lifecycle_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal > 0),
      effect_kind TEXT NOT NULL CHECK (
        length(trim(effect_kind)) > 0 AND effect_kind = lower(trim(effect_kind))
      ),
      idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) > 0),
      effect_spec_json TEXT NOT NULL CHECK (
        json_valid(effect_spec_json) AND json_type(effect_spec_json) = 'object' AND
        json(effect_spec_json) != '{}'
      ),
      effect_spec_hash TEXT NOT NULL CHECK (
        length(effect_spec_hash) = 71 AND substr(effect_spec_hash, 1, 7) = 'sha256:' AND
        effect_spec_hash = lower(effect_spec_hash) AND
        substr(effect_spec_hash, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
      operation_id TEXT NOT NULL,
      project_revision INTEGER NOT NULL CHECK (project_revision > 0),
      authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 0),
      UNIQUE (closeout_plan_id, ordinal),
      UNIQUE (closeout_plan_id, idempotency_key),
      UNIQUE (closeout_effect_id, project_id, lifecycle_id),
      FOREIGN KEY (
        closeout_plan_id, project_id, lifecycle_id,
        operation_id, project_revision, authority_epoch
      ) REFERENCES workflow_closeout_plans(
        closeout_plan_id, project_id, lifecycle_id,
        operation_id, project_revision, authority_epoch
      )
    );

    CREATE TRIGGER IF NOT EXISTS trg_workflow_closeout_effect_current_plan
    BEFORE INSERT ON workflow_closeout_effects
    WHEN EXISTS (
      SELECT 1 FROM workflow_closeout_plans successor
      WHERE successor.supersedes_closeout_plan_id = NEW.closeout_plan_id
    ) OR EXISTS (
      SELECT 1
      FROM workflow_closeout_effects settled_effect
      JOIN workflow_settlement_receipts receipt
        ON receipt.closeout_effect_id = settled_effect.closeout_effect_id
      WHERE settled_effect.closeout_plan_id = NEW.closeout_plan_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'closeout effects must belong to the current plan');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_closeout_effect_ordinal
    BEFORE INSERT ON workflow_closeout_effects
    WHEN NEW.ordinal > 1 AND NOT EXISTS (
      SELECT 1 FROM workflow_closeout_effects previous
      WHERE previous.closeout_plan_id = NEW.closeout_plan_id
        AND previous.ordinal = NEW.ordinal - 1
    )
    BEGIN
      SELECT RAISE(ABORT, 'closeout effects must be inserted in ordinal order');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_closeout_effect_update
    BEFORE UPDATE ON workflow_closeout_effects
    BEGIN
      SELECT RAISE(ABORT, 'closeout effects are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_workflow_closeout_effect_delete
    BEFORE DELETE ON workflow_closeout_effects
    BEGIN
      SELECT RAISE(ABORT, 'closeout effects are immutable');
    END;

    CREATE TABLE IF NOT EXISTS workflow_settlement_receipts (
      settlement_receipt_id TEXT PRIMARY KEY,
      closeout_effect_id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL,
      lifecycle_id TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('performed', 'recognized')),
      external_ref TEXT NOT NULL CHECK (length(trim(external_ref)) > 0),
      proof_json TEXT NOT NULL CHECK (
        json_valid(proof_json) AND json_type(proof_json) = 'object' AND
        json(proof_json) != '{}'
      ),
      proof_hash TEXT NOT NULL CHECK (
        length(proof_hash) = 71 AND substr(proof_hash, 1, 7) = 'sha256:' AND
        proof_hash = lower(proof_hash) AND substr(proof_hash, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      settled_at TEXT NOT NULL CHECK (length(trim(settled_at)) > 0),
      operation_id TEXT NOT NULL,
      project_revision INTEGER NOT NULL CHECK (project_revision > 0),
      authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 0),
      UNIQUE (settlement_receipt_id, project_id, lifecycle_id),
      FOREIGN KEY (closeout_effect_id, project_id, lifecycle_id)
        REFERENCES workflow_closeout_effects(
          closeout_effect_id, project_id, lifecycle_id
        ),
      FOREIGN KEY (operation_id, project_id, project_revision, authority_epoch)
        REFERENCES workflow_operations(
          operation_id, project_id, resulting_revision, resulting_authority_epoch
        )
    );

    CREATE TRIGGER IF NOT EXISTS trg_workflow_settlement_receipt_order
    BEFORE INSERT ON workflow_settlement_receipts
    WHEN NOT EXISTS (
      SELECT 1
      FROM workflow_closeout_effects effect
      JOIN workflow_closeout_plans plan ON plan.closeout_plan_id = effect.closeout_plan_id
      WHERE effect.closeout_effect_id = NEW.closeout_effect_id
        AND effect.project_id = NEW.project_id
        AND effect.lifecycle_id = NEW.lifecycle_id
        AND effect.project_revision < NEW.project_revision
        AND effect.authority_epoch <= NEW.authority_epoch
        AND NOT EXISTS (
          SELECT 1 FROM workflow_closeout_plans successor
          WHERE successor.supersedes_closeout_plan_id = plan.closeout_plan_id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM workflow_closeout_effects prior_effect
          WHERE prior_effect.closeout_plan_id = effect.closeout_plan_id
            AND prior_effect.ordinal < effect.ordinal
            AND NOT EXISTS (
              SELECT 1 FROM workflow_settlement_receipts prior_receipt
              WHERE prior_receipt.closeout_effect_id = prior_effect.closeout_effect_id
            )
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'settlement receipt requires current plan and prior ordinal receipts');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_settlement_receipt_update
    BEFORE UPDATE ON workflow_settlement_receipts
    BEGIN
      SELECT RAISE(ABORT, 'settlement receipts are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_workflow_settlement_receipt_delete
    BEFORE DELETE ON workflow_settlement_receipts
    BEGIN
      SELECT RAISE(ABORT, 'settlement receipts are immutable');
    END;
    CREATE INDEX IF NOT EXISTS idx_workflow_settlement_receipt_scope
      ON workflow_settlement_receipts(project_id, lifecycle_id, closeout_effect_id);
  `);
  createKernelCheckpointChainTrigger(db);
}
