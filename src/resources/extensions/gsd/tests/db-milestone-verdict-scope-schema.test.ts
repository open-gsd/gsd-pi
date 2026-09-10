// Project/App: gsd-pi
// File Purpose: Executable v49 authorization contract for milestone.validate technical verdicts.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  SCHEMA_VERSION,
  closeDatabase,
  openDatabase,
} from "../gsd-db.ts";

const require = createRequire(import.meta.url);
const tempDirs = new Set<string>();

interface RawDb {
  readonly isOpen: boolean;
  exec(sql: string): void;
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): Record<string, unknown> | undefined;
  };
  close(): void;
}

function openRawDatabase(path: string): RawDb {
  const sqlite = require("node:sqlite") as { DatabaseSync: new (path: string) => RawDb };
  const db = new sqlite.DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function createDatabasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-milestone-verdict-scope-"));
  tempDirs.add(dir);
  return join(dir, "gsd.db");
}

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function projectId(db: RawDb): string {
  return String(db.prepare(
    "SELECT project_id FROM project_authority WHERE singleton = 1",
  ).get()?.project_id);
}

function insertOperation(
  db: RawDb,
  operationId: string,
  operationType: string,
  revision: number,
): void {
  db.prepare(`
    INSERT INTO workflow_operations (
      operation_id, project_id, operation_type, idempotency_key,
      expected_revision, resulting_revision,
      expected_authority_epoch, resulting_authority_epoch,
      actor_type, source_transport, request_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 'test', 'test', ?, '')
  `).run(
    operationId,
    projectId(db),
    operationType,
    `key-${operationId}`,
    revision - 1,
    revision,
    `hash-${operationId}`,
  );
}

function insertMilestoneLifecycle(db: RawDb): void {
  db.exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M-VALIDATE', 'Milestone validation', 'active', '2026-07-12T00:00:00.000Z');
  `);
  db.prepare(`
    INSERT INTO workflow_item_lifecycles (
      lifecycle_id, project_id, item_kind, milestone_id, lifecycle_status,
      created_at, updated_at, last_operation_id, last_project_revision, last_authority_epoch
    ) VALUES ('life-validate', ?, 'milestone', 'M-VALIDATE', 'in_progress',
      '', '', 'op-1', 1, 0)
  `).run(projectId(db));
}

function insertSettledAttempt(
  db: RawDb,
  input: {
    attemptId: string;
    attemptNumber: number;
    retryOfAttemptId?: string;
    claimOperationId: string;
    claimRevision: number;
    settleOperationId: string;
    settleRevision: number;
    outcome: string;
  },
): void {
  db.prepare(`
    INSERT INTO workflow_execution_attempts (
      attempt_id, project_id, lifecycle_id, attempt_number, retry_of_attempt_id,
      attempt_state,
      claimed_at, claim_operation_id, claim_project_revision, claim_authority_epoch
    ) VALUES (?, ?, 'life-validate', ?, ?, 'claimed', '', ?, ?, 0)
  `).run(
    input.attemptId,
    projectId(db),
    input.attemptNumber,
    input.retryOfAttemptId ?? null,
    input.claimOperationId,
    input.claimRevision,
  );
  db.prepare(`
    UPDATE workflow_execution_attempts
    SET attempt_state = 'settled', ended_at = '2026-07-12T00:01:00.000Z',
        settle_outcome = ?,
        settle_operation_id = ?, settle_project_revision = ?, settle_authority_epoch = 0
    WHERE attempt_id = ?
  `).run(input.outcome, input.settleOperationId, input.settleRevision, input.attemptId);
  db.prepare(`
    INSERT INTO workflow_attempt_results (
      result_id, project_id, lifecycle_id, attempt_id, outcome,
      failure_class, summary, output_json, created_at,
      operation_id, project_revision, authority_epoch
    ) VALUES (?, ?, 'life-validate', ?, ?, ?, 'settled result', '{}', '', ?, ?, 0)
  `).run(
    `result-${input.attemptId}`,
    projectId(db),
    input.attemptId,
    input.outcome,
    input.outcome === "succeeded" ? "none" : "validation-inconclusive",
    input.settleOperationId,
    input.settleRevision,
  );
}

function insertTechnicalCriterion(db: RawDb, revision: number): void {
  db.prepare(`
    INSERT INTO workflow_acceptance_criteria (
      criterion_id, criterion_key, project_id, lifecycle_id, requirement_id,
      criterion_kind, evidence_class,
      required, description, supersedes_criterion_id, created_at,
      operation_id, project_revision, authority_epoch
    ) VALUES ('criterion-contract', 'milestone-validation:contract', ?, 'life-validate', NULL,
      'technical', 'command',
      1, 'Contract verification planned for this Milestone must be current and pass.',
      NULL, '', ?, ?, 0)
  `).run(projectId(db), `op-${revision}`, revision);
}

function insertTechnicalVerdict(
  db: RawDb,
  input: {
    verdictId: string;
    attemptId: string;
    verdict: string;
    operationId: string;
    revision: number;
    testedSourceRevision?: string;
  },
): void {
  db.prepare(`
    INSERT INTO workflow_technical_verdicts (
      verdict_id, project_id, criterion_id, lifecycle_id, attempt_id,
      tested_source_revision, verdict, policy_id, policy_version, rationale,
      created_at, operation_id, project_revision, authority_epoch
    ) VALUES (?, ?, 'criterion-contract', 'life-validate', ?,
      ?, ?, 'milestone-validation', '1', 'Contract verification passed.',
      '', ?, ?, 0)
  `).run(
    input.verdictId,
    projectId(db),
    input.attemptId,
    input.testedSourceRevision ?? "commit-current",
    input.verdict,
    input.operationId,
    input.revision,
  );
}

test("milestone.validate persists a per-class pass verdict while the aggregate outcome is interrupted", (t) => {
  assert.ok(SCHEMA_VERSION >= 49);
  const dbPath = createDatabasePath();
  assert.equal(openDatabase(dbPath), true);
  t.after(() => {
    closeDatabase();
  });
  const db = openRawDatabase(dbPath);
  try {
    insertOperation(db, "op-1", "fixture.seed", 1);
    insertOperation(db, "op-6", "fixture.seed", 6);
    insertOperation(db, "op-8", "fixture.seed", 8);
    insertOperation(db, "op-9", "milestone.validate", 9);
    insertMilestoneLifecycle(db);
    insertSettledAttempt(db, {
      attemptId: "attempt-validate",
      attemptNumber: 1,
      claimOperationId: "op-8",
      claimRevision: 8,
      settleOperationId: "op-9",
      settleRevision: 9,
      // The aggregate verdict is non-pass, so the validation Attempt settles
      // 'interrupted' (tools/validate-milestone.ts canonicalOutcome).
      outcome: "interrupted",
    });
    insertTechnicalCriterion(db, 6);

    insertTechnicalVerdict(db, {
      verdictId: "verdict-contract-green",
      attemptId: "attempt-validate",
      verdict: "pass",
      operationId: "op-9",
      revision: 9,
    });
    const persisted = db.prepare(`
      SELECT verdict FROM workflow_technical_verdicts WHERE verdict_id = 'verdict-contract-green'
    `).get();
    assert.equal(persisted?.verdict, "pass");
  } finally {
    db.close();
  }
});

test("non-milestone.validate operations still require outcome succeeded for pass verdicts", (t) => {
  const dbPath = createDatabasePath();
  assert.equal(openDatabase(dbPath), true);
  t.after(() => {
    closeDatabase();
  });
  const db = openRawDatabase(dbPath);
  try {
    insertOperation(db, "op-1", "fixture.seed", 1);
    insertOperation(db, "op-6", "fixture.seed", 6);
    insertOperation(db, "op-7", "attempt.settle", 7);
    insertOperation(db, "op-9", "attempt.settle", 9);
    insertMilestoneLifecycle(db);
    insertTechnicalCriterion(db, 6);
    insertSettledAttempt(db, {
      attemptId: "attempt-succeeded",
      attemptNumber: 1,
      claimOperationId: "op-6",
      claimRevision: 6,
      settleOperationId: "op-7",
      settleRevision: 7,
      outcome: "succeeded",
    });
    insertSettledAttempt(db, {
      attemptId: "attempt-interrupted",
      attemptNumber: 2,
      retryOfAttemptId: "attempt-succeeded",
      claimOperationId: "op-6",
      claimRevision: 6,
      settleOperationId: "op-7",
      settleRevision: 7,
      outcome: "interrupted",
    });
    insertSettledAttempt(db, {
      attemptId: "attempt-failed",
      attemptNumber: 3,
      retryOfAttemptId: "attempt-interrupted",
      claimOperationId: "op-6",
      claimRevision: 6,
      settleOperationId: "op-7",
      settleRevision: 7,
      outcome: "failed",
    });

    // Control: pass with a succeeded result stays legal outside milestone.validate.
    insertTechnicalVerdict(db, {
      verdictId: "verdict-pass-succeeded",
      attemptId: "attempt-succeeded",
      verdict: "pass",
      operationId: "op-9",
      revision: 9,
    });
    // Control: non-pass verdicts never required a succeeded outcome.
    insertTechnicalVerdict(db, {
      verdictId: "verdict-fail-interrupted",
      attemptId: "attempt-failed",
      verdict: "fail",
      operationId: "op-9",
      revision: 9,
    });
    // Invariant: pass with a non-succeeded result is still aborted outside
    // milestone.validate.
    assert.throws(() => insertTechnicalVerdict(db, {
      verdictId: "verdict-pass-interrupted",
      attemptId: "attempt-interrupted",
      verdict: "pass",
      operationId: "op-9",
      revision: 9,
    }), /technical verdict requires the current criterion and matching settled attempt/);
    assert.throws(() => insertTechnicalVerdict(db, {
      verdictId: "verdict-pass-interrupted-same-op",
      attemptId: "attempt-interrupted",
      verdict: "pass",
      operationId: "op-7",
      revision: 9,
    }), /technical verdict requires the current criterion and matching settled attempt/);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM workflow_technical_verdicts
    `).get()?.count, 2);
  } finally {
    db.close();
  }
});

test("v48→v49 migration replaces the strict verdict scope trigger in place", (t) => {
  const dbPath = createDatabasePath();
  assert.equal(openDatabase(dbPath), true);
  closeDatabase();

  // Downgrade the stamp and reinstall the V42-era trigger so the migration
  // has the strict conjunct to replace.
  const setup = openRawDatabase(dbPath);
  try {
    setup.exec("UPDATE schema_version SET version = 48");
    setup.exec(`
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
    `);
    insertOperation(setup, "op-1", "fixture.seed", 1);
    insertOperation(setup, "op-6", "fixture.seed", 6);
    insertOperation(setup, "op-8", "fixture.seed", 8);
    insertOperation(setup, "op-9", "milestone.validate", 9);
    insertMilestoneLifecycle(setup);
    insertSettledAttempt(setup, {
      attemptId: "attempt-validate",
      attemptNumber: 1,
      claimOperationId: "op-8",
      claimRevision: 8,
      settleOperationId: "op-9",
      settleRevision: 9,
      outcome: "interrupted",
    });
    insertTechnicalCriterion(setup, 6);

    // The strict V42 conjunct aborts the green per-class verdict.
    assert.throws(() => insertTechnicalVerdict(setup, {
      verdictId: "verdict-contract-green",
      attemptId: "attempt-validate",
      verdict: "pass",
      operationId: "op-9",
      revision: 9,
    }), /technical verdict requires the current criterion and matching settled attempt/);
  } finally {
    setup.close();
  }

  assert.equal(openDatabase(dbPath), true);
  t.after(() => {
    closeDatabase();
  });
  closeDatabase();

  const migrated = openRawDatabase(dbPath);
  try {
    assert.equal(migrated.prepare(
      "SELECT MAX(version) AS version FROM schema_version",
    ).get()?.version, SCHEMA_VERSION);
    // The migrated trigger persists the previously discarded verdict.
    insertTechnicalVerdict(migrated, {
      verdictId: "verdict-contract-green",
      attemptId: "attempt-validate",
      verdict: "pass",
      operationId: "op-9",
      revision: 9,
    });
    assert.equal(migrated.prepare(`
      SELECT verdict FROM workflow_technical_verdicts WHERE verdict_id = 'verdict-contract-green'
    `).get()?.verdict, "pass");
  } finally {
    migrated.close();
  }
});
