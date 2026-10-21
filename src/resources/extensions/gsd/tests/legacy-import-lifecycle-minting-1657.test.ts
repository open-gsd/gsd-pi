// Project/App: gsd-pi
// File Purpose: Regression proof (#1657/#1658) that an applied legacy import mints canonical
// companion authority — lifecycle rows for every imported hierarchy row and a Q8 quality
// gate for every imported slice.

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import { prepareLegacyImportBackup } from "../legacy-import-backup.ts";
import { applyLegacyImport } from "../legacy-import-application.ts";
import { createLegacyImportPreview } from "../legacy-import-preview.ts";
import { captureCurrentLegacyImportBaseSnapshot } from "../legacy-import-preview-base.ts";
import { type DbAdapter } from "../db-adapter.ts";
import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.ts";
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

test("applied import mints lifecycle rows for every imported milestone, slice, and task (#1657)", () => {
  const workspace = mkdtempSync(join(tmpdir(), "gsd-legacy-lifecycle-minting-"));
  tempDirectories.add(workspace);
  const source = join(workspace, "source");
  const destination = join(workspace, "backups");
  cpSync(join(CORPUS_ROOT, "gsd-nested", "source"), source, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  });
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
  applyLegacyImport({
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

  // #1658: gsd_slice_complete requires exactly one Q8 quality gate per slice,
  // so every imported slice must carry the row the canonical seam would have
  // seeded — pending while the slice is open, complete (verdict "omitted",
  // since the import carries no readiness evidence) once the slice closed.
  const gatelessSlices = rows(`
    SELECT slice.milestone_id, slice.id FROM slices slice
    LEFT JOIN quality_gates gate
      ON gate.milestone_id = slice.milestone_id AND gate.slice_id = slice.id
     AND gate.gate_id = 'Q8' AND (gate.task_id = '' OR gate.task_id IS NULL)
    WHERE gate.gate_id IS NULL
  `);
  assert.deepEqual(gatelessSlices, []);
  const wrongStateGates = rows(`
    SELECT gate.milestone_id, gate.slice_id, gate.status, gate.verdict,
           lifecycle.lifecycle_status
    FROM quality_gates gate
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.item_kind = 'slice'
     AND lifecycle.milestone_id = gate.milestone_id
     AND lifecycle.slice_id = gate.slice_id
     AND lifecycle.task_id IS NULL
    WHERE gate.gate_id = 'Q8' AND (gate.task_id = '' OR gate.task_id IS NULL)
      AND CASE
        WHEN lifecycle.lifecycle_status = 'completed'
          THEN gate.status != 'complete' OR gate.verdict != 'omitted'
        ELSE gate.status != 'pending'
      END
  `);
  assert.deepEqual(wrongStateGates, []);
});
