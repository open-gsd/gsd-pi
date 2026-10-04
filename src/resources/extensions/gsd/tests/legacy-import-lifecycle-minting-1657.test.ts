// Project/App: gsd-pi
// File Purpose: Regression proof (#1657/#1658) that an applied legacy import mints canonical
// companion authority — lifecycle rows for every imported hierarchy row and a pending Q8
// quality gate for every open imported slice — and keeps a markdown completion as unverified legacy.

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import { prepareLegacyImportBackup } from "../legacy-import-backup.ts";
import { applyLegacyImport } from "../legacy-import-application.ts";
import { inspectLegacyImportApplicationEvidence } from "../legacy-import-application-evidence.ts";
import { verifyLegacyImportApplicationResult } from "../legacy-import-application-result.ts";
import { createLegacyImportPreview } from "../legacy-import-preview.ts";
import { captureCurrentLegacyImportBaseSnapshot } from "../legacy-import-preview-base.ts";
import { type DbAdapter } from "../db-adapter.ts";
import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.ts";
import { completeSlice } from "../slice-lifecycle-domain-operation.ts";
import { createLegacyImportCorpusSourceRoots } from "./helpers/legacy-import-corpus.ts";

const CORPUS_ROOT = fileURLToPath(new URL("./__fixtures__/legacy-import-corpus/v1/", import.meta.url));
const tempDirectories = new Set<string>();

function db(): DbAdapter {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function rows(sql: string): Array<Record<string, unknown>> {
  return db().prepare(sql).all() as Array<Record<string, unknown>>;
}

afterEach(() => {
  closeDatabase();
  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  tempDirectories.clear();
});

/** Apply the gsd-nested markdown corpus as one Import Application on an empty database. */
function applyNestedCorpusImport(prepareSource: (source: string) => void = () => {}) {
  const workspace = mkdtempSync(join(tmpdir(), "gsd-legacy-lifecycle-minting-"));
  tempDirectories.add(workspace);
  const source = join(workspace, "source");
  const destination = join(workspace, "backups");
  cpSync(join(CORPUS_ROOT, "gsd-nested", "source"), source, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  });
  prepareSource(source);
  mkdirSync(destination);
  assert.equal(openDatabase(join(workspace, "canonical.sqlite")), true);
  const roots = createLegacyImportCorpusSourceRoots(source);
  const previewInput = { roots };
  const base = captureCurrentLegacyImportBaseSnapshot();
  const preview = createLegacyImportPreview(previewInput);
  const backup = prepareLegacyImportBackup({
    preview,
    base,
    roots,
    destination_directory: destination,
    label: "pre-application",
  });
  return applyLegacyImport({
    invocation: {
      idempotencyKey: "legacy-import/lifecycle-minting-1657",
      sourceTransport: "internal",
      actorType: "agent",
      actorId: "legacy-import-lifecycle-minting-test",
      traceId: "lifecycle-minting-trace",
      turnId: "lifecycle-minting-turn",
    },
    previewInput,
    preview,
    backup,
  });
}

test("applied import mints lifecycle rows for every imported milestone, slice, and task (#1657)", () => {
  const receipt = applyNestedCorpusImport();

  // Every imported hierarchy row must carry canonical lifecycle authority —
  // execute-task and complete-slice hard-require workflow_item_lifecycles rows,
  // and their absence wedged auto mode after recover (#1657).
  const orphanedMilestones = rows(`
    SELECT milestone.id FROM milestones milestone
    LEFT JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.item_kind = 'milestone' AND lifecycle.milestone_id = milestone.id
     AND lifecycle.slice_id IS NULL AND lifecycle.task_id IS NULL
    WHERE lifecycle.lifecycle_id IS NULL
  `);
  const orphanedSlices = rows(`
    SELECT slice.milestone_id, slice.id FROM slices slice
    LEFT JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.item_kind = 'slice' AND lifecycle.milestone_id = slice.milestone_id
     AND lifecycle.slice_id = slice.id AND lifecycle.task_id IS NULL
    WHERE lifecycle.lifecycle_id IS NULL
  `);
  const orphanedTasks = rows(`
    SELECT task.milestone_id, task.slice_id, task.id FROM tasks task
    LEFT JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.item_kind = 'task' AND lifecycle.milestone_id = task.milestone_id
     AND lifecycle.slice_id = task.slice_id AND lifecycle.task_id = task.id
    WHERE lifecycle.lifecycle_id IS NULL
  `);
  assert.deepEqual(orphanedMilestones, []);
  assert.deepEqual(orphanedSlices, []);
  assert.deepEqual(orphanedTasks, []);
  assert.ok(rows("SELECT 1 AS present FROM milestones LIMIT 1").length > 0);

  // Lifecycle states stay consistent with the imported hierarchy statuses:
  // terminal statuses adopt as-is; in-flight work adopts as ready/pending so
  // execute-task and complete-slice can advance it (mirrors the planning seam).
  const mismatched = rows(`
    SELECT lifecycle.item_kind, lifecycle.milestone_id, lifecycle.slice_id, lifecycle.task_id,
           hierarchy.status AS legacy_status, lifecycle.lifecycle_status
    FROM workflow_item_lifecycles lifecycle
    JOIN (
      SELECT 'milestone' AS item_kind, id AS milestone_id, NULL AS slice_id, NULL AS task_id, status FROM milestones
      UNION ALL
      SELECT 'slice', milestone_id, id, NULL, status FROM slices
      UNION ALL
      SELECT 'task', milestone_id, slice_id, id, status FROM tasks
    ) hierarchy
      ON hierarchy.item_kind = lifecycle.item_kind
     AND hierarchy.milestone_id = lifecycle.milestone_id
     AND hierarchy.slice_id IS lifecycle.slice_id
     AND hierarchy.task_id IS lifecycle.task_id
    WHERE CASE
      WHEN hierarchy.status IN ('complete', 'completed', 'done', 'closed') THEN lifecycle.lifecycle_status != 'completed'
      WHEN hierarchy.status IN ('skipped', 'deferred', 'cancelled') THEN lifecycle.lifecycle_status != 'cancelled'
      ELSE lifecycle.lifecycle_status NOT IN ('ready', 'pending', 'in_progress')
    END
  `);
  assert.deepEqual(mismatched, []);

  // #1658: every open imported slice carries the pending Q8 quality gate the
  // canonical seam would have seeded. A slice imported as completed carries no
  // gate row: the import has no readiness evidence, and a closed verdict that
  // no evaluation produced would be fabricated.
  const gateStates = rows(`
    SELECT lifecycle.lifecycle_status, gate.status AS gate_status, COUNT(*) AS slices
    FROM workflow_item_lifecycles lifecycle
    LEFT JOIN quality_gates gate
      ON gate.milestone_id = lifecycle.milestone_id AND gate.slice_id = lifecycle.slice_id
     AND gate.gate_id = 'Q8' AND (gate.task_id = '' OR gate.task_id IS NULL)
    WHERE lifecycle.item_kind = 'slice'
    GROUP BY lifecycle.lifecycle_status, gate.status
    ORDER BY lifecycle.lifecycle_status
  `);
  assert.deepEqual(gateStates, [
    { lifecycle_status: "completed", gate_status: null, slices: 2 },
    { lifecycle_status: "ready", gate_status: "pending", slices: 5 },
  ]);
  assert.deepEqual(rows("SELECT * FROM gate_runs"), []);
  // Restore and Forward Repair verify the retained Application against the
  // live database; a completed slice with no gate row must still verify.
  verifyLegacyImportApplicationResult(inspectLegacyImportApplicationEvidence(receipt.operationId));
});

test("an imported markdown completion stays completed as unverified legacy: adopted by the import operation, with no evidence row", () => {
  const receipt = applyNestedCorpusImport();

  // The markdown attests the completion and nothing else: the imported rows
  // carry no completion timestamp and no verification result.
  const completed = rows(`
    SELECT lifecycle.item_kind, lifecycle.milestone_id, lifecycle.slice_id, lifecycle.task_id,
           hierarchy.status AS raw_status, hierarchy.completed_at, hierarchy.verification_result,
           lifecycle.state_version, lifecycle.last_operation_id, operation.operation_type
    FROM workflow_item_lifecycles lifecycle
    JOIN workflow_operations operation ON operation.operation_id = lifecycle.last_operation_id
    JOIN (
      SELECT 'milestone' AS item_kind, id AS milestone_id, NULL AS slice_id, NULL AS task_id,
             status, completed_at, '' AS verification_result FROM milestones
      UNION ALL
      SELECT 'slice', milestone_id, id, NULL, status, completed_at, '' FROM slices
      UNION ALL
      SELECT 'task', milestone_id, slice_id, id, status, completed_at, verification_result FROM tasks
    ) hierarchy
      ON hierarchy.item_kind = lifecycle.item_kind
     AND hierarchy.milestone_id = lifecycle.milestone_id
     AND hierarchy.slice_id IS lifecycle.slice_id
     AND hierarchy.task_id IS lifecycle.task_id
    WHERE lifecycle.lifecycle_status = 'completed'
    ORDER BY lifecycle.item_kind, lifecycle.milestone_id, lifecycle.slice_id, lifecycle.task_id
  `);
  // The mark of an unverified legacy completion is its provenance: completed
  // at state version 0, adopted by the import.apply operation itself.
  const unverifiedLegacy = (itemKind: string, milestoneId: string, taskId: string | null) => ({
    item_kind: itemKind, milestone_id: milestoneId, slice_id: "S01", task_id: taskId,
    raw_status: "complete", completed_at: null, verification_result: "",
    state_version: 0, last_operation_id: receipt.operationId, operation_type: "import.apply",
  });
  assert.deepEqual(completed, [
    unverifiedLegacy("slice", "M001", null),
    unverifiedLegacy("slice", "M002", null),
    unverifiedLegacy("task", "M001", "T01"),
    unverifiedLegacy("task", "M002", "T01"),
  ]);

  // The import writes no Attempt, result, verdict, evidence or gate run for
  // these completions. The next test proves that Slice closeout accepts one.
  for (const table of [
    "workflow_execution_attempts", "workflow_attempt_results", "workflow_technical_verdicts",
    "workflow_verification_evidence", "verification_evidence", "gate_runs",
  ]) {
    assert.deepEqual(rows(`SELECT * FROM ${table}`), [], table);
  }
  // The sealed plan is unchanged: the retained Application still validates.
  verifyLegacyImportApplicationResult(inspectLegacyImportApplicationEvidence(receipt.operationId));
});

test("a Slice imported open with a markdown-completed Task closes with no new evidence for that Task", () => {
  applyNestedCorpusImport((source) => {
    // The roadmap leaves S02 unchecked; its plan attests T01 as done.
    writeFileSync(
      join(source, ".gsd", "milestones", "M001-foundation", "slices", "S02-api", "S02-PLAN.md"),
      "# S02: API wiring\n\n- [x] T01 Connect the service boundary\n",
    );
  });
  const lifecycleStatuses = () => rows(`
    SELECT item_kind, lifecycle_status FROM workflow_item_lifecycles
    WHERE milestone_id = 'M001' AND slice_id = 'S02' ORDER BY item_kind
  `);
  assert.deepEqual(lifecycleStatuses(), [
    { item_kind: "slice", lifecycle_status: "ready" },
    { item_kind: "task", lifecycle_status: "completed" },
  ]);

  const receipt = completeSlice({
    invocation: {
      idempotencyKey: "slice-complete/imported-open-slice",
      sourceTransport: "internal",
      actorType: "agent",
      actorId: "legacy-import-lifecycle-minting-test",
      traceId: "imported-open-slice-trace",
      turnId: "imported-open-slice-turn",
    },
    slice: { milestoneId: "M001", sliceId: "S02" },
    closeout: {
      sliceTitle: "API wiring",
      oneLiner: "Closed the imported Slice.",
      narrative: "The one Task was complete in the legacy source.",
      verification: "None for the imported Task.",
      uatContent: "",
      operationalReadiness: "",
      deviations: "None.",
      knownLimitations: "None.",
      followUps: "None.",
      provides: [], requires: [], affects: [], keyFiles: [], keyDecisions: [],
      patternsEstablished: [], observabilitySurfaces: [], drillDownPaths: [],
      requirementsAdvanced: [], requirementsValidated: [], requirementsSurfaced: [],
      requirementsInvalidated: [], filesModified: [],
    },
  });

  assert.equal(receipt.status, "committed");
  assert.deepEqual(receipt.completedTaskIds, ["T01"]);
  assert.deepEqual(receipt.proofs, []);
  assert.deepEqual(lifecycleStatuses(), [
    { item_kind: "slice", lifecycle_status: "completed" },
    { item_kind: "task", lifecycle_status: "completed" },
  ]);
});
