// Project/App: gsd-pi
// File Purpose: Public Import Application commit/refusal capstone across the sealed legacy corpus.

import assert from "node:assert/strict";
import {
  cpSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  prepareLegacyImportBackup,
  type LegacyImportVerifiedBackup,
} from "../legacy-import-backup.ts";
import {
  LegacyImportApplicationError,
  applyLegacyImport,
  createLegacyImportApplicationConsent,
  createLegacyImportApplicationIdentity,
  type LegacyImportApplicationInput,
  type LegacyImportApplicationReceipt,
} from "../legacy-import-application.ts";
import {
  compileLegacyImportApplicationPlan,
  legacyImportProjectionKind,
  type LegacyImportApplicationPlan,
  type LegacyImportApplicationPlanInstruction,
} from "../legacy-import-application-plan.ts";
import {
  canonicalLegacyImportJson,
  createLegacyImportPreview,
  hashLegacyImportBytes,
  hashLegacyImportValue,
  type LegacyImportPreviewArtifact,
  type LegacyImportPreviewCreateInput,
} from "../legacy-import-preview.ts";
import {
  captureCurrentLegacyImportBaseSnapshot,
  type LegacyImportBaseSnapshot,
} from "../legacy-import-preview-base.ts";
import type { DbAdapter } from "../db-adapter.ts";
import {
  _getAdapter,
  closeDatabase,
  insertDecision,
  openDatabase,
} from "../gsd-db.ts";
import {
  createLegacyImportCorpusSourceRoots,
  fingerprintLegacyImportCorpusTree,
  type LegacyImportCorpusManifest,
} from "./helpers/legacy-import-corpus.ts";

const CORPUS_ROOT = new URL("./__fixtures__/legacy-import-corpus/v1/", import.meta.url);
const CORPUS_PATH = fileURLToPath(CORPUS_ROOT);
const MANIFEST = JSON.parse(
  readFileSync(join(CORPUS_PATH, "corpus.json"), "utf8"),
) as LegacyImportCorpusManifest;

const ELIGIBLE_CASES = new Set([
  "custom-workflow",
  "gsd-nested",
  "jsonl-history",
  "knowledge-graph",
  "planning-flat-complete",
  "planning-multi-milestone-completed-range",
  "planning-multi-milestone-details",
  "planning-multi-milestone-emoji-range",
  "planning-multi-milestone-heading",
  "planning-multi-milestone-summary",
  "root-external-boundaries",
  "synthetic-smoke",
]);

const PRESERVE_ONLY_CASES = new Set([
  "custom-workflow",
  "jsonl-history",
  "knowledge-graph",
  "root-external-boundaries",
  "synthetic-smoke",
]);

const DURABLE_TABLES = [
  "project_authority", "milestones", "slices", "tasks", "slice_dependencies",
  "requirements", "decisions", "memories", "artifacts", "assessments",
  "workflow_acceptance_criteria", "workflow_answers", "workflow_attempt_results",
  "workflow_blockers", "workflow_closeout_effects", "workflow_closeout_plans",
  "workflow_conversation_decisions", "workflow_decision_impacts", "workflow_domain_events",
  "workflow_execution_attempts", "workflow_failure_observations", "workflow_human_acceptances",
  "workflow_import_applications", "workflow_interaction_options", "workflow_interactions",
  "workflow_item_lifecycles", "workflow_kernel_checkpoints", "workflow_milestone_contexts",
  "workflow_open_questions", "workflow_operations", "workflow_outbox", "workflow_projection_work",
  "workflow_question_dependencies", "workflow_recovery_actions", "workflow_recovery_budgets",
  "workflow_remediation_links", "workflow_requirement_dispositions", "workflow_settlement_receipts",
  "workflow_technical_verdicts", "workflow_verification_evidence", "workflow_waivers",
  "workflow_work_checkpoints",
] as const;

const LOGICAL_TABLES = [
  "milestones", "slices", "tasks", "slice_dependencies", "requirements",
  "decisions", "memories", "artifacts", "assessments", "workflow_item_lifecycles",
] as const;

interface PreparedCase {
  name: string;
  caseRoot: string;
  source: string;
  backupDirectory: string;
  databasePath: string;
  base: LegacyImportBaseSnapshot;
  preview: LegacyImportPreviewArtifact;
  backup: LegacyImportVerifiedBackup;
  input: LegacyImportApplicationInput;
}

function db(): DbAdapter {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function rows(sql: string, params?: Record<string, unknown>): Array<Record<string, unknown>> {
  const statement = db().prepare(sql);
  return params === undefined ? statement.all() : statement.all(params);
}

function tableSnapshot(tables: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(tables.map((table) => [
    table,
    rows(`SELECT * FROM ${table} ORDER BY rowid`),
  ]));
}

function totalChanges(): number {
  return Number(db().prepare("SELECT total_changes() AS count").get()?.["count"]);
}

function treeInventory(root: string, relative = ""): string[] {
  const inventory: string[] = [];
  for (const name of readdirSync(join(root, relative)).sort()) {
    const child = relative ? `${relative}/${name}` : name;
    const physical = join(root, child);
    const stat = lstatSync(physical);
    if (stat.isDirectory()) {
      inventory.push(`${child}/`);
      inventory.push(...treeInventory(root, child));
    } else if (stat.isSymbolicLink()) {
      inventory.push(`${child}->${readlinkSync(physical)}`);
    } else {
      inventory.push(child);
    }
  }
  return inventory;
}

function seedActionMatrixBase(source: string): void {
  const fixture = new DatabaseSync(join(source, ".gsd", "gsd.db"), { readOnly: true });
  try {
    const decisions = fixture.prepare(`SELECT id, when_context, scope, decision, choice,
      rationale, revisable, made_by, source, superseded_by FROM decisions
      WHERE id IN ('D002', 'D003', 'D004') ORDER BY id`).all();
    for (const decision of decisions) {
      insertDecision(decision as unknown as Parameters<typeof insertDecision>[0]);
    }
  } finally {
    fixture.close();
  }
}

function prepareCase(root: string, name: string): PreparedCase {
  const caseRoot = join(root, name);
  const source = join(caseRoot, "source");
  const backupDirectory = join(caseRoot, "backups");
  const databasePath = join(caseRoot, "canonical.sqlite");
  cpSync(join(CORPUS_PATH, name, "source"), source, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  });
  mkdirSync(backupDirectory);
  assert.equal(openDatabase(databasePath), true, name);
  if (name === "action-matrix") seedActionMatrixBase(source);
  const previewInput: LegacyImportPreviewCreateInput = {
    roots: createLegacyImportCorpusSourceRoots(source),
  };
  const base = captureCurrentLegacyImportBaseSnapshot();
  const preview = createLegacyImportPreview(previewInput);
  const backup = prepareLegacyImportBackup({
    preview,
    base,
    roots: previewInput.roots,
    destination_directory: backupDirectory,
    label: `public-corpus-${name}`,
  });
  const input: LegacyImportApplicationInput = {
    invocation: {
      idempotencyKey: `legacy-import/public-corpus/${name}`,
      sourceTransport: "internal",
      actorType: "agent",
      actorId: "legacy-import-public-corpus-test",
      traceId: `public-corpus-${name}`,
      turnId: `public-corpus-${name}`,
    },
    previewInput,
    preview,
    backup,
  };
  return { name, caseRoot, source, backupDirectory, databasePath, base, preview, backup, input };
}

function withPreparedCase(
  root: string,
  name: string,
  run: (prepared: PreparedCase) => void,
): void {
  const prepared = prepareCase(root, name);
  try {
    run(prepared);
  } finally {
    closeDatabase();
  }
}

function assertPlanAccounting(prepared: PreparedCase, plan: LegacyImportApplicationPlan): void {
  const changeIds = prepared.preview.preview.changes.map((change) => change.change_id);
  const instructionChangeIds = plan.instructions.flatMap((instruction) => [...instruction.changeIds]);
  assert.deepEqual(plan.accounting.changeIds, changeIds, `${prepared.name}: plan change accounting`);
  assert.deepEqual(
    [...new Set(instructionChangeIds)].sort(),
    [...changeIds].sort(),
    `${prepared.name}: no silently dropped change`,
  );
  assert.deepEqual(plan.receiptCounts, prepared.preview.preview.counts, `${prepared.name}: receipt counts`);
}

function identityWhere(identity: Readonly<Record<string, unknown>>): {
  clause: string;
  params: Record<string, unknown>;
} {
  const entries = Object.entries(identity);
  return {
    clause: entries.map(([field]) => `${field} = :${field}`).join(" AND "),
    params: Object.fromEntries(entries.map(([field, value]) => [`:${field}`, value])),
  };
}

function assertLogicalInstruction(instruction: LegacyImportApplicationPlanInstruction): void {
  if (instruction.action === "create" || instruction.action === "update" || instruction.action === "delete") {
    const { clause, params } = identityWhere(instruction.identity);
    const stored = db().prepare(`SELECT * FROM ${instruction.rowSet} WHERE ${clause}`).get(params);
    if (instruction.action === "delete") {
      assert.equal(stored, undefined, `${instruction.targetKey}: deleted row`);
      return;
    }
    assert.ok(stored, `${instruction.targetKey}: stored row`);
    for (const [field, value] of Object.entries({ ...instruction.identity, ...instruction.values })) {
      assert.deepEqual(stored[field], value, `${instruction.targetKey}: ${field}`);
    }
    return;
  }
  if (instruction.action === "replace-slice-dependencies") {
    assert.deepEqual(rows(`SELECT depends_on_slice_id FROM slice_dependencies
      WHERE milestone_id = :milestone_id AND slice_id = :slice_id
      ORDER BY depends_on_slice_id`, {
      ":milestone_id": instruction.milestoneId,
      ":slice_id": instruction.sliceId,
    }).map((row) => row["depends_on_slice_id"]), instruction.dependsOnSliceIds, instruction.targetKey);
    return;
  }
  if (instruction.action === "delete-slice-dependencies") {
    assert.equal(db().prepare(`SELECT COUNT(*) AS count FROM slice_dependencies
      WHERE milestone_id = :milestone_id
        AND (slice_id = :slice_id OR depends_on_slice_id = :slice_id)`).get({
      ":milestone_id": instruction.milestoneId,
      ":slice_id": instruction.sliceId,
    })?.["count"], 0, instruction.targetKey);
    return;
  }
  if (instruction.action === "adopt-lifecycle") {
    const stored = db().prepare(`SELECT item_kind, milestone_id, slice_id, task_id,
      lifecycle_status, state_version, last_operation_id FROM workflow_item_lifecycles
      WHERE item_kind = :item_kind AND milestone_id = :milestone_id
        AND slice_id IS :slice_id AND task_id IS :task_id`).get({
      ":item_kind": instruction.itemKind,
      ":milestone_id": instruction.milestoneId,
      ":slice_id": instruction.sliceId ?? null,
      ":task_id": instruction.taskId ?? null,
    });
    assert.deepEqual(stored, {
      item_kind: instruction.itemKind,
      milestone_id: instruction.milestoneId,
      slice_id: instruction.sliceId ?? null,
      task_id: instruction.taskId ?? null,
      lifecycle_status: instruction.lifecycleStatus,
      state_version: 0,
      last_operation_id: rows("SELECT operation_id FROM workflow_operations")[0]?.["operation_id"],
    }, instruction.targetKey);
  }
}

function expectedInstructionResults(
  prepared: PreparedCase,
  plan: LegacyImportApplicationPlan,
): Array<Record<string, unknown>> {
  return plan.instructions.map((instruction) => {
    const identity = {
      action: instruction.action,
      targetKind: instruction.targetKind,
      targetIdentityHash: hashLegacyImportValue({
        kind: instruction.targetKind,
        key: instruction.targetKey,
      }),
    };
    if (instruction.action === "replace-slice-dependencies") {
      const deleted = prepared.base.rows.filter((row) => row.row_set === "slice_dependencies"
        && row.value["milestone_id"] === instruction.milestoneId
        && row.value["slice_id"] === instruction.sliceId).length;
      return {
        ...identity,
        expectedAffectedRows: instruction.dependsOnSliceIds.length,
        affectedRows: deleted + instruction.dependsOnSliceIds.length,
      };
    }
    if (instruction.action === "delete-slice-dependencies") {
      const deleted = prepared.base.rows.filter((row) => row.row_set === "slice_dependencies"
        && row.value["milestone_id"] === instruction.milestoneId
        && (row.value["slice_id"] === instruction.sliceId
          || row.value["depends_on_slice_id"] === instruction.sliceId)).length;
      return { ...identity, expectedAffectedRows: 0, affectedRows: deleted };
    }
    if (instruction.action === "preserve") {
      return { ...identity, expectedAffectedRows: 0, affectedRows: 0 };
    }
    return { ...identity, expectedAffectedRows: 1, affectedRows: 1 };
  });
}

function assertDurableCommit(
  prepared: PreparedCase,
  plan: LegacyImportApplicationPlan,
  receipt: LegacyImportApplicationReceipt,
): void {
  assert.equal(receipt.status, "committed", prepared.name);
  assert.deepEqual(rows("SELECT revision, authority_epoch FROM project_authority"), [{
    revision: prepared.base.authority.revision + 1,
    authority_epoch: prepared.base.authority.authority_epoch,
  }], prepared.name);
  const operation = db().prepare("SELECT * FROM workflow_operations WHERE operation_id = :id")
    .get({ ":id": receipt.operationId });
  const application = db().prepare("SELECT * FROM workflow_import_applications WHERE operation_id = :id")
    .get({ ":id": receipt.operationId });
  assert.ok(operation);
  assert.ok(application);
  const identity = createLegacyImportApplicationIdentity(prepared.input);
  assert.deepEqual(receipt, {
    status: "committed",
    operationId: receipt.operationId,
    projectId: prepared.base.authority.project_id,
    applicationIdentityHash: identity.applicationIdentityHash,
    previewId: prepared.preview.preview.preview_id,
    previewHash: prepared.preview.preview_hash,
    backupId: prepared.backup.backup_id,
    baseProjectRevision: prepared.base.authority.revision,
    baseAuthorityEpoch: prepared.base.authority.authority_epoch,
    resultingRevision: prepared.base.authority.revision + 1,
    resultingAuthorityEpoch: prepared.base.authority.authority_epoch,
    appliedAt: application["applied_at"],
    eventIds: receipt.eventIds,
    outboxIds: receipt.outboxIds,
    projectionWorkIds: receipt.projectionWorkIds,
  }, prepared.name);
  assert.equal(operation["idempotency_key"], prepared.input.invocation.idempotencyKey);
  assert.equal(operation["resulting_revision"], receipt.resultingRevision);
  assert.deepEqual({
    preview_id: application["preview_id"],
    preview_hash: application["preview_hash"],
    backup_id: prepared.backup.backup_id,
    create_count: application["create_count"],
    update_count: application["update_count"],
    delete_count: application["delete_count"],
    preserve_count: application["preserve_count"],
    unparsed_count: application["unparsed_count"],
    unresolved_count: application["unresolved_count"],
    preview_json: application["preview_json"],
    backup_ref: application["backup_ref"],
    backup_sha256: application["backup_sha256"],
    backup_byte_size: application["backup_byte_size"],
  }, {
    preview_id: prepared.preview.preview.preview_id,
    preview_hash: prepared.preview.preview_hash,
    backup_id: receipt.backupId,
    create_count: prepared.preview.preview.counts.create,
    update_count: prepared.preview.preview.counts.update,
    delete_count: prepared.preview.preview.counts.delete,
    preserve_count: prepared.preview.preview.counts.preserve,
    unparsed_count: prepared.preview.preview.counts.unparsed,
    unresolved_count: prepared.preview.preview.counts.unresolved,
    preview_json: canonicalLegacyImportJson(prepared.preview.preview),
    backup_ref: prepared.backup.backup_ref,
    backup_sha256: prepared.backup.backup_sha256,
    backup_byte_size: prepared.backup.backup_byte_size,
  }, prepared.name);
  const events = rows("SELECT * FROM workflow_domain_events WHERE operation_id = :id ORDER BY event_index", {
    ":id": receipt.operationId,
  });
  assert.deepEqual(events.map((event) => event["event_id"]), receipt.eventIds, prepared.name);
  assert.equal(events.length, 1, prepared.name);
  assert.equal(events[0]?.["project_revision"], receipt.resultingRevision);
  assert.equal(events[0]?.["authority_epoch"], receipt.resultingAuthorityEpoch);
  assert.deepEqual(JSON.parse(String(events[0]?.["payload_json"])), {
    replayIdentitySchemaVersion: identity.replayIdentity.replayIdentitySchemaVersion,
    applicationIdentityHash: identity.applicationIdentityHash,
    previewInputHash: identity.replayIdentity.previewInputHash,
    backupArtifactHash: hashLegacyImportValue(prepared.backup),
    backupId: prepared.backup.backup_id,
    applicationRelevantRowsHash: captureCurrentLegacyImportBaseSnapshot().relevant_rows_hash,
    planSchemaVersion: plan.planSchemaVersion,
    eventFacts: plan.eventFacts,
    projectionKeys: plan.projectionKeys,
    instructionResults: expectedInstructionResults(prepared, plan),
  }, prepared.name);
  const outbox = rows(`SELECT outbox_id, event_id, destination FROM workflow_outbox
    WHERE event_id IN (SELECT event_id FROM workflow_domain_events WHERE operation_id = :id)
    ORDER BY outbox_id`, { ":id": receipt.operationId });
  assert.deepEqual(outbox.map((row) => row["outbox_id"]), receipt.outboxIds, prepared.name);
  assert.deepEqual(outbox.map((row) => row["destination"]), ["projection"], prepared.name);
  const projections = rows(`SELECT projection_work_id, projection_key, projection_kind,
    renderer_version, source_project_revision, source_authority_epoch,
    enqueue_operation_id, delivery_state
    FROM workflow_projection_work WHERE enqueue_operation_id = :id ORDER BY projection_work_id`, {
    ":id": receipt.operationId,
  });
  assert.deepEqual(projections, plan.projectionKeys.map((projectionKey, index) => ({
    projection_work_id: receipt.projectionWorkIds[index],
    projection_key: projectionKey,
    projection_kind: legacyImportProjectionKind(projectionKey),
    renderer_version: "v1",
    source_project_revision: prepared.base.authority.revision + 1,
    source_authority_epoch: prepared.base.authority.authority_epoch,
    enqueue_operation_id: receipt.operationId,
    delivery_state: "pending",
  })), prepared.name);
}

function expectUnresolved(run: () => unknown, name: string): LegacyImportApplicationError {
  let observed: unknown;
  try {
    run();
  } catch (error) {
    observed = error;
  }
  assert.ok(observed instanceof LegacyImportApplicationError, name);
  assert.equal(observed.stage, "preview", name);
  assert.equal(observed.code, "LEGACY_IMPORT_APPLICATION_PREVIEW_UNRESOLVED", name);
  assert.equal(observed.retryable, false, name);
  return observed;
}

function expectDestructiveConsentRequired(run: () => unknown): void {
  assert.throws(run, (error) => (
    error instanceof LegacyImportApplicationError
    && error.stage === "preview"
    && error.code === "LEGACY_IMPORT_APPLICATION_DESTRUCTIVE_CONSENT_REQUIRED"
    && error.retryable === false
  ));
}

test("public Application commits and exactly replays all 12 eligible fresh corpus cases", (t) => {
  assert.equal(MANIFEST.cases.length, 26);
  const root = mkdtempSync(join(tmpdir(), "gsd-application-public-eligible-"));
  t.after(() => {
    closeDatabase();
    rmSync(root, { recursive: true, force: true });
  });
  const committedNames: string[] = [];
  const preserveNames: string[] = [];

  for (const entry of MANIFEST.cases.filter((candidate) => ELIGIBLE_CASES.has(candidate.name))) {
    withPreparedCase(root, entry.name, (prepared) => {
      const plan = compileLegacyImportApplicationPlan(prepared.preview);
      assertPlanAccounting(prepared, plan);
      const sourceBefore = fingerprintLegacyImportCorpusTree(prepared.source);
      const backupBefore = fingerprintLegacyImportCorpusTree(prepared.backupDirectory);
      const inventoryBefore = treeInventory(prepared.caseRoot);
      const logicalBefore = tableSnapshot(LOGICAL_TABLES);

      const committed = applyLegacyImport(prepared.input);

      assertDurableCommit(prepared, plan, committed);
      for (const instruction of plan.instructions) assertLogicalInstruction(instruction);
      if (PRESERVE_ONLY_CASES.has(entry.name)) {
        preserveNames.push(entry.name);
        assert.ok(plan.instructions.length > 0, entry.name);
        assert.ok(plan.instructions.every((instruction) => instruction.action === "preserve"), entry.name);
        assert.deepEqual(tableSnapshot(LOGICAL_TABLES), logicalBefore, `${entry.name}: no promotion`);
        assert.equal(rows("SELECT * FROM workflow_operations").length, 1, entry.name);
      }
      if (entry.name === "planning-flat-complete") {
        assert.deepEqual(db().prepare(`SELECT title, status, full_summary_md FROM tasks
          WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'`).get(), {
          title: "Persist notes",
          status: "complete",
          full_summary_md: "The note persistence task passed its stated verification.",
        });
        assert.equal(db().prepare("SELECT status FROM requirements WHERE id = 'R001'").get()?.["status"], "validated");
        assert.equal(db().prepare(`SELECT lifecycle_status FROM workflow_item_lifecycles
          WHERE item_kind = 'task' AND milestone_id = 'M001' AND slice_id = 'S01' AND task_id = 'T01'`)
          .get()?.["lifecycle_status"], "completed");
      }
      if (entry.name === "gsd-nested") {
        assert.deepEqual(rows(`SELECT slice_id, depends_on_slice_id FROM slice_dependencies
          WHERE milestone_id = 'M001' ORDER BY slice_id, depends_on_slice_id`), [
          { slice_id: "S02", depends_on_slice_id: "S01" },
          { slice_id: "S03", depends_on_slice_id: "S01" },
          { slice_id: "S03", depends_on_slice_id: "S02" },
          { slice_id: "S04", depends_on_slice_id: "S02" },
          { slice_id: "S04", depends_on_slice_id: "S03" },
        ]);
      }
      const durable = tableSnapshot(DURABLE_TABLES);
      closeDatabase();
      assert.equal(openDatabase(prepared.databasePath), true, entry.name);
      const changesBeforeReplay = totalChanges();
      const replayed = applyLegacyImport(structuredClone(prepared.input));
      assert.deepEqual(replayed, { ...committed, status: "replayed" }, entry.name);
      assert.deepEqual(tableSnapshot(DURABLE_TABLES), durable, `${entry.name}: replay read-only`);
      assert.equal(totalChanges(), changesBeforeReplay, `${entry.name}: replay performs no writes`);
      assert.equal(fingerprintLegacyImportCorpusTree(prepared.source), sourceBefore, `${entry.name}: source immutable`);
      assert.equal(fingerprintLegacyImportCorpusTree(prepared.backupDirectory), backupBefore, `${entry.name}: backup immutable`);
      assert.deepEqual(treeInventory(prepared.caseRoot), inventoryBefore, `${entry.name}: inventory immutable`);
      committedNames.push(entry.name);
    });
  }

  assert.deepEqual(committedNames.sort(), [...ELIGIBLE_CASES].sort());
  assert.deepEqual(preserveNames.sort(), [...PRESERVE_ONLY_CASES].sort());
});

test("public Application refuses all 14 unapproved or unresolved fresh corpus cases with zero residue", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gsd-application-public-refused-"));
  t.after(() => {
    closeDatabase();
    rmSync(root, { recursive: true, force: true });
  });
  const refusedNames: string[] = [];

  for (const entry of MANIFEST.cases.filter((candidate) => !ELIGIBLE_CASES.has(candidate.name))) {
    withPreparedCase(root, entry.name, (prepared) => {
      const before = tableSnapshot(DURABLE_TABLES);
      const changesBeforeRefusal = totalChanges();
      const sourceBefore = fingerprintLegacyImportCorpusTree(prepared.source);
      const backupBefore = hashLegacyImportBytes(readFileSync(prepared.backup.backup_ref));
      const inventoryBefore = treeInventory(prepared.caseRoot);

      if (entry.name === "action-matrix") {
        assert.equal(prepared.preview.preview.counts.unresolved, 0, entry.name);
        assert.equal(prepared.preview.preview.counts.delete, 1, entry.name);
        assert.doesNotThrow(() => compileLegacyImportApplicationPlan(prepared.preview));
        expectDestructiveConsentRequired(() => applyLegacyImport(prepared.input));
      } else {
        assert.ok(prepared.preview.preview.counts.unresolved > 0, entry.name);
        expectUnresolved(() => compileLegacyImportApplicationPlan(prepared.preview), entry.name);
        expectUnresolved(() => applyLegacyImport(prepared.input), entry.name);
      }

      assert.deepEqual(tableSnapshot(DURABLE_TABLES), before, `${entry.name}: zero residue`);
      assert.equal(totalChanges(), changesBeforeRefusal, `${entry.name}: refusal performs no writes`);
      assert.equal(fingerprintLegacyImportCorpusTree(prepared.source), sourceBefore, `${entry.name}: source immutable`);
      assert.equal(hashLegacyImportBytes(readFileSync(prepared.backup.backup_ref)), backupBefore, `${entry.name}: backup immutable`);
      assert.deepEqual(treeInventory(prepared.caseRoot), inventoryBefore, `${entry.name}: inventory immutable`);
      refusedNames.push(entry.name);
    });
  }

  assert.equal(refusedNames.length, 14);
  assert.deepEqual(refusedNames.sort(), MANIFEST.cases
    .filter((candidate) => !ELIGIBLE_CASES.has(candidate.name))
    .map((candidate) => candidate.name)
    .sort());
});

test("public Application applies the action matrix only with exact Preview-bound delete consent", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gsd-application-public-delete-consent-"));
  t.after(() => {
    closeDatabase();
    rmSync(root, { recursive: true, force: true });
  });

  withPreparedCase(root, "action-matrix", (prepared) => {
    const consent = createLegacyImportApplicationConsent(prepared.preview);
    const committed = applyLegacyImport({ ...prepared.input, destructiveConsent: consent });

    assert.equal(committed.status, "committed");
    const tombstone = rows(`SELECT structured_fields FROM memories
      WHERE category = 'architecture'
        AND json_extract(structured_fields, '$.sourceDecisionId') = 'D003'`);
    assert.equal(tombstone.length, 1);
    assert.equal(JSON.parse(String(tombstone[0]?.["structured_fields"])).deleted, true);
    assert.equal(rows("SELECT * FROM workflow_import_applications").length, 1);
  });
});
