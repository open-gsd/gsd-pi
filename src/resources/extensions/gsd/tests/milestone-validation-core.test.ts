// Project/App: gsd-pi
// File Purpose: Canonical Milestone validation lifecycle, replay, and rollback contracts.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { executeDomainOperation } from "../db/domain-operation.ts";
import { createSliceCancellationSchemaV40 } from "../db-slice-cancellation-schema.ts";
import { createSliceCompletionSchemaV41 } from "../db-slice-completion-schema.ts";
import { adoptOrTransitionLifecycle, readDomainOperationFence } from "../db/writers/lifecycle-commands.ts";
import {
  validateMilestone,
  type ValidateMilestoneInput,
} from "../milestone-validation-domain-operation.ts";
import {
  _getAdapter,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
  SCHEMA_VERSION,
} from "../gsd-db.ts";

let basePath: string | undefined;

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function count(table: string): number {
  const result = db().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
  return Number(result?.["count"] ?? 0);
}

function invoke(idempotencyKey: string) {
  return {
    idempotencyKey,
    sourceTransport: "internal" as const,
    actorType: "agent",
    actorId: "milestone-validation-test",
  };
}

function setup(): void {
  basePath = mkdtempSync(join(tmpdir(), "gsd-milestone-validation-core-"));
  assert.equal(openDatabase(join(basePath, "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Canonical validation", status: "active" });
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.milestone.adopt",
    idempotencyKey: "fixture/milestone/adopt",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { milestoneId: "M001" },
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone",
      milestoneId: "M001",
      lifecycleStatus: "ready",
    });
    return {
      events: [{
        eventType: "test.milestone.adopted",
        entityType: "milestone",
        entityId: "M001",
        payload: { milestoneId: "M001" },
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: "test/milestone/m001",
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}

afterEach(() => {
  closeDatabase();
  if (basePath) rmSync(basePath, { recursive: true, force: true });
  basePath = undefined;
});

function combinedValidationInput(idempotencyKey: string): ValidateMilestoneInput {
  return {
    invocation: invoke(idempotencyKey),
    milestoneId: "M001",
    testedSourceRevision: "sha256:tested-source",
    policyId: "milestone-validation",
    policyVersion: "1",
    verdict: "pass",
    rationale: "All required objective criteria passed.",
    outcome: "succeeded",
    failureClass: "none",
    summary: "Validation checks completed.",
    output: { checks: 1 },
    criteria: [{
      criterionKey: "focused-tests",
      evidenceClass: "command",
      description: "Focused tests pass.",
      verdict: "pass",
      rationale: "Focused tests passed.",
      evidence: [{
        evidenceClass: "command",
        commandOrTool: "pnpm test focused",
        workingDirectory: "/workspace",
        startedAt: "2026-07-14T10:00:00.000Z",
        endedAt: "2026-07-14T10:01:00.000Z",
        exitCode: 0,
        observation: "passed",
        durableOutputRef: "artifact://validation/focused-tests",
        environment: { runner: "node-test" },
      }],
    }],
  };
}

function executeAttemptWrite(
  operationType: string,
  idempotencyKey: string,
  write: (context: Parameters<Parameters<typeof executeDomainOperation>[1]>[0]) => void,
): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType,
    idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { operationType },
  }, (context) => {
    write(context);
    return {
      events: [{
        eventType: `${operationType}.tested`,
        entityType: "milestone",
        entityId: "M001",
        payload: { operationType },
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: `test/${idempotencyKey}`,
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}

function descendantLifecycleIds(): string[] {
  insertSlice({ id: "S01", milestoneId: "M001", status: "active" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "pending" });
  const lifecycleIds: string[] = [];
  executeAttemptWrite("test.descendants.adopt", "test/descendants/adopt", (context) => {
    lifecycleIds.push(adoptOrTransitionLifecycle(context, {
      itemKind: "slice",
      milestoneId: "M001",
      sliceId: "S01",
      lifecycleStatus: "ready",
    }).lifecycleId);
    lifecycleIds.push(adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      lifecycleStatus: "ready",
    }).lifecycleId);
  });
  return lifecycleIds;
}

function insertClaimedAttempt(lifecycleId: string, attemptId: string): void {
  executeAttemptWrite("test.attempt.claim", `test/attempt/claim/${attemptId}`, (context) => {
    db().prepare(`
      INSERT INTO workflow_execution_attempts (
        attempt_id, project_id, lifecycle_id, attempt_number, attempt_state,
        claimed_at, claim_operation_id, claim_project_revision, claim_authority_epoch
      ) VALUES (
        :attempt_id, :project_id, :lifecycle_id, 1, 'claimed',
        :claimed_at, :operation_id, :project_revision, :authority_epoch
      )
    `).run({
      ":attempt_id": attemptId,
      ":project_id": context.projectId,
      ":lifecycle_id": lifecycleId,
      ":claimed_at": "2026-07-14T09:00:00.000Z",
      ":operation_id": context.operationId,
      ":project_revision": context.resultingRevision,
      ":authority_epoch": context.resultingAuthorityEpoch,
    });
  });
}

test("one validation command atomically records criteria, Attempt, Result, evidence, and one receipt", () => {
  setup();
  const revisionBefore = Number(db().prepare(
    `SELECT revision FROM project_authority WHERE singleton = 1`,
  ).get()?.["revision"]);
  const input = combinedValidationInput("milestone-validation/combined/1");

  const committed = validateMilestone(input);
  const replayed = validateMilestone(input);

  assert.equal(committed.status, "committed");
  assert.equal(replayed.status, "replayed");
  assert.equal(replayed.operationId, committed.operationId);
  assert.equal(replayed.attemptId, committed.attemptId);
  assert.equal(replayed.resultId, committed.resultId);
  assert.deepEqual(replayed.criteria, committed.criteria);
  assert.deepEqual(replayed.verdicts, committed.verdicts);
  assert.equal(committed.resultingRevision, revisionBefore + 1);
  assert.equal(Number(db().prepare(
    `SELECT revision FROM project_authority WHERE singleton = 1`,
  ).get()?.["revision"]), revisionBefore + 1);
  assert.deepEqual(db().prepare(`
    SELECT attempt_state, claim_operation_id, settle_operation_id,
           claim_project_revision, settle_project_revision
    FROM workflow_execution_attempts
    WHERE attempt_id = :attempt_id
  `).get({ ":attempt_id": committed.attemptId }), {
    attempt_state: "settled",
    claim_operation_id: committed.operationId,
    settle_operation_id: committed.operationId,
    claim_project_revision: committed.resultingRevision,
    settle_project_revision: committed.resultingRevision,
  });
  assert.equal(count("workflow_acceptance_criteria"), 1);
  assert.equal(count("workflow_execution_attempts"), 1);
  assert.equal(count("workflow_attempt_results"), 1);
  assert.equal(count("workflow_technical_verdicts"), 1);
  assert.equal(count("workflow_verification_evidence"), 1);
  assert.equal(db().prepare(`
    SELECT COUNT(*) AS count FROM workflow_operations
    WHERE idempotency_key = :idempotency_key
      AND operation_type = 'milestone.validate'
  `).get({ ":idempotency_key": input.invocation.idempotencyKey })?.["count"], 1);
  assert.equal(db().prepare(`
    SELECT COUNT(*) AS count FROM workflow_domain_events
    WHERE operation_id = :operation_id
      AND event_type = 'milestone.validation.recorded'
  `).get({ ":operation_id": committed.operationId })?.["count"], 1);
  assert.equal(db().prepare(`
    SELECT COUNT(*) AS count FROM workflow_projection_work
    WHERE enqueue_operation_id = :operation_id
      AND projection_kind = 'milestone-validation'
  `).get({ ":operation_id": committed.operationId })?.["count"], 1);
});

test("command evidence requires an exit code and cannot pass with a failing exit", () => {
  setup();
  const missingExitCode = combinedValidationInput("milestone-validation/command/missing-exit");
  delete missingExitCode.criteria[0]!.evidence[0]!.exitCode;
  assert.throws(
    () => validateMilestone(missingExitCode),
    /command evidence requires an exit code/i,
  );

  const failedExit = combinedValidationInput("milestone-validation/command/failed-exit");
  failedExit.criteria[0]!.evidence[0]!.exitCode = 1;
  assert.throws(
    () => validateMilestone(failedExit),
    /passing command evidence requires exit code 0/i,
  );
});

test("the current schema preserves the v42 validation upgrade from a genuine v41 database", () => {
  setup();
  assert.ok(basePath);
  const databasePath = join(basePath, "gsd.db");
  createSliceCancellationSchemaV40(db());
  createSliceCompletionSchemaV41(db());
  db().exec(`
    DELETE FROM schema_version;
    INSERT INTO schema_version (version, applied_at)
    VALUES (41, '2026-07-14T00:00:00.000Z');
  `);
  const v41SettlementTrigger = String(db().prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'trigger' AND name = 'trg_workflow_attempt_settlement_shape_v36'
  `).get()?.["sql"]);
  assert.doesNotMatch(v41SettlementTrigger, /milestone\.validate/);
  assert.match(v41SettlementTrigger, /slice\.cancel/);
  closeDatabase();

  assert.equal(openDatabase(databasePath), true);
  assert.equal(db().prepare(
    `SELECT MAX(version) AS version FROM schema_version`,
  ).get()?.["version"], SCHEMA_VERSION);
  const receipt = validateMilestone(
    combinedValidationInput("milestone-validation/combined/v42-upgrade"),
  );

  assert.equal(receipt.status, "committed");
  assert.equal(db().prepare(`
    SELECT attempt_state FROM workflow_execution_attempts
    WHERE attempt_id = :attempt_id
  `).get({ ":attempt_id": receipt.attemptId })?.["attempt_state"], "settled");
});

test("milestone.validate cannot settle Slice or Task Attempts", () => {
  setup();
  const lifecycleIds = descendantLifecycleIds();
  for (const [index, lifecycleId] of lifecycleIds.entries()) {
    const attemptId = `attempt-descendant-${index}`;
    insertClaimedAttempt(lifecycleId, attemptId);

    assert.throws(() => executeAttemptWrite(
      "milestone.validate",
      `milestone-validation/forbidden-descendant/${index}`,
      (context) => {
        db().prepare(`
          UPDATE workflow_execution_attempts
          SET attempt_state = 'settled', settle_outcome = 'succeeded',
              ended_at = :ended_at, settle_operation_id = :operation_id,
              settle_project_revision = :project_revision,
              settle_authority_epoch = :authority_epoch
          WHERE attempt_id = :attempt_id
        `).run({
          ":attempt_id": attemptId,
          ":ended_at": "2026-07-14T10:00:00.000Z",
          ":operation_id": context.operationId,
          ":project_revision": context.resultingRevision,
          ":authority_epoch": context.resultingAuthorityEpoch,
        });
      },
    ), /requires.*complete lease identity/i);
    assert.equal(db().prepare(`
      SELECT attempt_state FROM workflow_execution_attempts WHERE attempt_id = :attempt_id
    `).get({ ":attempt_id": attemptId })?.["attempt_state"], "claimed");
  }
});

test("milestone.validate cannot insert an already-settled Milestone Attempt", () => {
  setup();
  const lifecycleId = String(db().prepare(`
    SELECT lifecycle_id FROM workflow_item_lifecycles
    WHERE item_kind = 'milestone' AND milestone_id = 'M001'
  `).get()?.["lifecycle_id"]);

  assert.throws(() => executeAttemptWrite(
    "milestone.validate",
    "milestone-validation/direct-settled-insert",
    (context) => {
      db().prepare(`
        INSERT INTO workflow_execution_attempts (
          attempt_id, project_id, lifecycle_id, attempt_number, attempt_state,
          claimed_at, ended_at, claim_operation_id, claim_project_revision,
          claim_authority_epoch, settle_operation_id, settle_project_revision,
          settle_authority_epoch, settle_outcome
        ) VALUES (
          'attempt-direct-settled', :project_id, :lifecycle_id, 1, 'settled',
          :created_at, :created_at, :operation_id, :project_revision,
          :authority_epoch, :operation_id, :project_revision,
          :authority_epoch, 'succeeded'
        )
      `).run({
        ":project_id": context.projectId,
        ":lifecycle_id": lifecycleId,
        ":created_at": "2026-07-14T10:00:00.000Z",
        ":operation_id": context.operationId,
        ":project_revision": context.resultingRevision,
        ":authority_epoch": context.resultingAuthorityEpoch,
      });
    },
  ), /requires.*complete lease identity/i);
  assert.equal(count("workflow_execution_attempts"), 0);
});

test("replay fails loud when the stored combined receipt shape is corrupt", () => {
  setup();
  const input = combinedValidationInput("milestone-validation/combined/corrupt-replay");
  const receipt = validateMilestone(input);
  db().exec("DROP TRIGGER trg_workflow_domain_events_immutable_update");
  db().prepare(`
    UPDATE workflow_domain_events
    SET payload_json = '{"milestoneId":"M001","criteria":"not-an-array"}'
    WHERE operation_id = :operation_id AND event_type = 'milestone.validation.recorded'
  `).run({ ":operation_id": receipt.operationId });

  assert.throws(() => validateMilestone(input), /stored receipt.*invalid/i);
});

test("one validation command conflicts on changed replay facts", () => {
  setup();
  const input = combinedValidationInput("milestone-validation/combined/conflict");
  validateMilestone(input);

  assert.throws(() => validateMilestone({
    ...input,
    rationale: "Changed facts under the same execution identity.",
  }), /idempotency conflict/i);
});

test("one validation command atomically supersedes criteria removed from the plan", () => {
  setup();
  const baseInput = combinedValidationInput("milestone-validation/combined/criteria-1");
  const first = {
    ...baseInput,
    criteria: [...baseInput.criteria, {
      criterionKey: "browser-uat",
      evidenceClass: "browser" as const,
      description: "Browser UAT passes.",
      verdict: "pass" as const,
      rationale: "Browser UAT passed.",
      evidence: [{
        evidenceClass: "browser" as const,
        commandOrTool: "browser smoke",
        workingDirectory: "/workspace",
        startedAt: "2026-07-14T10:00:00.000Z",
        endedAt: "2026-07-14T10:01:00.000Z",
        exitCode: 0,
        observation: "passed" as const,
        durableOutputRef: "artifact://validation/browser-uat",
        environment: { runner: "browser" },
      }],
    }],
  };
  validateMilestone(first);

  const second = validateMilestone(
    combinedValidationInput("milestone-validation/combined/criteria-2"),
  );

  assert.equal(second.status, "committed");
  assert.deepEqual(db().prepare(`
    SELECT criterion_key, required
    FROM workflow_acceptance_criteria criterion
    WHERE NOT EXISTS (
      SELECT 1 FROM workflow_acceptance_criteria successor
      WHERE successor.supersedes_criterion_id = criterion.criterion_id
    )
    ORDER BY criterion_key
  `).all(), [
    { criterion_key: "browser-uat", required: 0 },
    { criterion_key: "focused-tests", required: 1 },
  ]);
  assert.equal(db().prepare(`
    SELECT COUNT(*) AS count
    FROM workflow_acceptance_criteria
    WHERE operation_id = :operation_id
  `).get({ ":operation_id": second.operationId })?.["count"], 1);
});

test("one validation command rolls back all rows when evidence persistence fails", () => {
  setup();
  const revisionBefore = Number(db().prepare(
    `SELECT revision FROM project_authority WHERE singleton = 1`,
  ).get()?.["revision"]);
  const tables = [
    "workflow_acceptance_criteria",
    "workflow_execution_attempts",
    "workflow_attempt_results",
    "workflow_technical_verdicts",
    "workflow_verification_evidence",
    "workflow_operations",
    "workflow_domain_events",
    "workflow_projection_work",
  ];
  const countsBefore = new Map(tables.map((table) => [table, count(table)]));
  const input = combinedValidationInput("milestone-validation/combined/rollback");
  input.criteria[0]!.evidence[0]!.evidenceClass = "browser";

  assert.throws(() => validateMilestone(input), /evidence class does not match/i);

  for (const table of tables) {
    assert.equal(count(table), countsBefore.get(table), `${table} must have zero residue`);
  }
  assert.equal(Number(db().prepare(
    `SELECT revision FROM project_authority WHERE singleton = 1`,
  ).get()?.["revision"]), revisionBefore);
});

test("Milestone validation rejects an aggregate verdict that hides failed evidence", () => {
  setup();
  const input = combinedValidationInput("milestone-validation/combined/aggregate");
  input.criteria[0]!.verdict = "fail";
  input.criteria[0]!.rationale = "Tests failed.";
  input.criteria[0]!.evidence[0]!.exitCode = 1;
  input.criteria[0]!.evidence[0]!.observation = "failed";

  assert.throws(() => validateMilestone(input), /aggregate verdict/i);

  assert.equal(count("workflow_execution_attempts"), 0);
  assert.equal(count("workflow_attempt_results"), 0);
  assert.equal(count("workflow_technical_verdicts"), 0);
  assert.equal(count("workflow_verification_evidence"), 0);
});
