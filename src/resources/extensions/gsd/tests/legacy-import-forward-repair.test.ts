// Project/App: gsd-pi
// File Purpose: Executable contract for three-way legacy Import Forward Repair.

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  _executeImportForwardRepairDomainOperation,
  _setDomainOperationFaultForTest,
  executeDomainOperation,
  type DomainJsonValue,
  type DomainOperationFaultPoint,
} from "../db/domain-operation.ts";
import {
  applyImportForwardRepairPlan,
  insertImportForwardRepairReceipt,
} from "../db/writers/authority-recovery.ts";
import {
  prepareLegacyImportBackup,
  type LegacyImportVerifiedBackup,
} from "../legacy-import-backup.ts";
import {
  applyLegacyImport,
  createLegacyImportApplicationIdentity,
  type LegacyImportApplicationInput,
  type LegacyImportApplicationReceipt,
} from "../legacy-import-application.ts";
import type { LegacyImportApplicationPlan } from "../legacy-import-application-plan.ts";
import {
  applyLegacyImportForwardRepair,
  inspectLegacyImportForwardRepair,
  LegacyImportForwardRepairError,
  type LegacyImportForwardRepairInput,
} from "../legacy-import-forward-repair.ts";
import {
  compileLegacyImportForwardRepairPlan,
  LEGACY_IMPORT_FORWARD_REPAIR_PLAN_SCHEMA_VERSION,
  type LegacyImportForwardRepairPlan,
} from "../legacy-import-forward-repair-plan.ts";
import {
  canonicalLegacyImportJson,
  createLegacyImportPreview,
  hashLegacyImportValue,
} from "../legacy-import-preview.ts";
import {
  captureCurrentLegacyImportBaseSnapshot,
  type LegacyImportBaseRow,
  type LegacyImportBaseSnapshot,
} from "../legacy-import-preview-base.ts";
import { _getAdapter, closeDatabase, openDatabase, SCHEMA_VERSION } from "../gsd-db.ts";
import { createLegacyImportCorpusSourceRoots } from "./helpers/legacy-import-corpus.ts";

const CORPUS_ROOT = fileURLToPath(new URL("./__fixtures__/legacy-import-corpus/v1/", import.meta.url));
const tempDirectories = new Set<string>();
let sequence = 0;

interface PreparedCase {
  databasePath: string;
  backup: LegacyImportVerifiedBackup;
  applicationReceipt: LegacyImportApplicationReceipt;
  applicationIdentityHash: string;
}

function db(): NonNullable<ReturnType<typeof _getAdapter>> {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function prepareCase(
  seedExistingMilestone = false,
  corpusCase = "gsd-nested",
): PreparedCase {
  sequence += 1;
  const workspace = mkdtempSync(join(tmpdir(), "gsd-forward-repair-"));
  tempDirectories.add(workspace);
  const source = join(workspace, "source");
  const backupDirectory = join(workspace, "backups");
  const databasePath = join(workspace, "canonical.sqlite");
  cpSync(join(CORPUS_ROOT, corpusCase, "source"), source, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  });
  mkdirSync(backupDirectory);
  assert.equal(openDatabase(databasePath), true);
  if (seedExistingMilestone) {
    db().prepare(`INSERT INTO milestones (id, title, status, created_at)
      VALUES ('M001', 'Original foundation', 'active', '2026-07-18T00:00:00.000Z')`).run();
  }
  const roots = createLegacyImportCorpusSourceRoots(source);
  const previewInput = { roots };
  const base = captureCurrentLegacyImportBaseSnapshot();
  const preview = createLegacyImportPreview(previewInput);
  const backup = prepareLegacyImportBackup({
    preview,
    base,
    roots,
    destination_directory: backupDirectory,
    label: "before-forward-repair",
  });
  const applicationInput: LegacyImportApplicationInput = {
    invocation: {
      idempotencyKey: `legacy-import/forward-repair-application-${sequence}`,
      sourceTransport: "internal",
      actorType: "agent",
      actorId: "forward-repair-test",
    },
    previewInput,
    preview,
    backup,
  };
  const applicationIdentityHash = createLegacyImportApplicationIdentity(
    applicationInput,
  ).applicationIdentityHash;
  const applicationReceipt = applyLegacyImport(applicationInput);
  return {
    databasePath,
    backup,
    applicationReceipt,
    applicationIdentityHash,
  };
}

function prepareRepairInput(prepared: PreparedCase, suffix: string): {
  plan: LegacyImportForwardRepairPlan;
  input: LegacyImportForwardRepairInput;
} {
  const plan = inspectLegacyImportForwardRepair({
    applicationIdentityHash: prepared.applicationIdentityHash,
    backup: prepared.backup,
  });
  return {
    plan,
    input: {
      invocation: {
        idempotencyKey: `legacy-import/forward-repair-${sequence}-${suffix}`,
        sourceTransport: "internal",
        actorType: "agent",
        actorId: "forward-repair-test",
      },
      applicationIdentityHash: prepared.applicationIdentityHash,
      backup: prepared.backup,
      plan,
    },
  };
}

function durableRepairSnapshot(): unknown {
  return {
    base: captureCurrentLegacyImportBaseSnapshot(),
    operations: db().prepare("SELECT COUNT(*) AS count FROM workflow_operations").get()?.["count"],
    repairs: db().prepare("SELECT COUNT(*) AS count FROM workflow_import_forward_repairs").get()?.["count"],
    events: db().prepare("SELECT COUNT(*) AS count FROM workflow_domain_events").get()?.["count"],
    outbox: db().prepare("SELECT COUNT(*) AS count FROM workflow_outbox").get()?.["count"],
    projections: db().prepare("SELECT COUNT(*) AS count FROM workflow_projection_work").get()?.["count"],
  };
}

function commitLaterCanonicalRow(prepared: PreparedCase): void {
  executeDomainOperation({
    operationType: "milestone.describe",
    idempotencyKey: `legacy-import/forward-repair-later-${sequence}`,
    expectedRevision: prepared.applicationReceipt.resultingRevision,
    expectedAuthorityEpoch: prepared.applicationReceipt.resultingAuthorityEpoch,
    actorType: "agent",
    actorId: "forward-repair-test",
    sourceTransport: "internal",
    payload: { milestoneId: "M-LATER" },
  }, () => {
    db().prepare(`
      INSERT INTO milestones (id, title, status, created_at)
      VALUES ('M-LATER', 'Accepted later work', 'active', '2026-07-18T00:00:00.000Z')
    `).run();
    const evolved = db().prepare(`UPDATE milestones
      SET title = 'Accepted imported-row evolution'
      WHERE id = 'M001'`).run();
    assert.equal((evolved as { changes?: unknown }).changes, 1);
    return {
      events: [{
        eventType: "milestone.described",
        entityType: "milestone",
        entityId: "M-LATER",
        payload: { title: "Accepted later work" },
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: "milestone/m-later",
        projectionKind: "markdown",
        rendererVersion: "v1",
      }],
    };
  });
}

function baseSnapshot(revision: number, rows: readonly LegacyImportBaseRow[]): LegacyImportBaseSnapshot {
  return {
    snapshot_schema_version: 1,
    database_schema_version: SCHEMA_VERSION,
    authority: {
      singleton: 1,
      project_id: "project-1",
      project_root_realpath: "/tmp/project-1",
      revision,
      authority_epoch: 0,
      created_at: "2026-07-18T00:00:00.000Z",
      updated_at: "2026-07-18T00:00:00.000Z",
    },
    rows,
    relevant_rows_hash: hashLegacyImportValue(rows),
  };
}

afterEach(() => {
  _setDomainOperationFaultForTest(null);
  closeDatabase();
  for (const directory of tempDirectories) rmSync(directory, { recursive: true, force: true });
  tempDirectories.clear();
});

test("Forward Repair preserves accepted later work and commits one exact terminal receipt", () => {
  const prepared = prepareCase();
  commitLaterCanonicalRow(prepared);
  const backupBytes = readFileSync(prepared.backup.backup_ref);
  const { plan, input } = prepareRepairInput(prepared, "commit");
  assert.equal(plan.expectedProjectRevision, prepared.applicationReceipt.resultingRevision + 1);
  assert.equal(plan.expectedAuthorityEpoch, prepared.applicationReceipt.resultingAuthorityEpoch);
  assert.equal(plan.unresolvedCount, 0);
  assert.ok(plan.targetCount > 0);
  assert.ok(plan.mutationCount > 0);
  const evolvedTarget = plan.targets.find((entry) => entry.targetKind === "milestone" && entry.targetKey === "M001");
  assert.equal(evolvedTarget?.disposition, "later-modified");
  assert.equal(evolvedTarget?.reasonCode, "CREATED_ROW_CHANGED_LATER");
  assert.ok(Number(db().prepare(`SELECT COUNT(*) AS count FROM slice_dependencies
    WHERE milestone_id = 'M001'`).get()?.["count"]) > 0);
  assert.deepEqual(inspectLegacyImportForwardRepair({
    applicationIdentityHash: prepared.applicationIdentityHash,
    backup: prepared.backup,
  }), plan);

  const committed = applyLegacyImportForwardRepair(input);
  assert.equal(committed.status, "committed");
  assert.equal(committed.resultingRevision, plan.expectedProjectRevision + 1);
  assert.equal(committed.resultingAuthorityEpoch, plan.expectedAuthorityEpoch);
  assert.equal(committed.targetCount, plan.targetCount);
  assert.equal(committed.mutationCount, plan.mutationCount);
  assert.deepEqual(readFileSync(prepared.backup.backup_ref), backupBytes);
  assert.deepEqual(db().prepare(`
    SELECT title, status FROM milestones WHERE id = 'M-LATER'
  `).get(), { title: "Accepted later work", status: "active" });
  assert.equal(db().prepare("SELECT title FROM milestones WHERE id = 'M001'").get()?.["title"], "Accepted imported-row evolution");
  assert.equal(db().prepare(`SELECT COUNT(*) AS count FROM slice_dependencies
    WHERE milestone_id = 'M001'`).get()?.["count"], 0);
  assert.equal(db().prepare("SELECT COUNT(*) AS count FROM workflow_import_forward_repairs").get()?.["count"], 1);
  assert.equal(db().prepare(`
    SELECT COUNT(*) AS count FROM workflow_domain_events
    WHERE event_type = 'legacy-import.forward-repaired'
  `).get()?.["count"], 1);

  const replayed = applyLegacyImportForwardRepair(input);
  assert.equal(replayed.status, "replayed");
  assert.equal(replayed.operationId, committed.operationId);
  assert.equal(db().prepare("SELECT COUNT(*) AS count FROM workflow_import_forward_repairs").get()?.["count"], 1);
});

test("Forward Repair tombstones unchanged hierarchy introduced by the Import Application", () => {
  const prepared = prepareCase(false, "planning-flat-complete");
  executeDomainOperation({
    operationType: "milestone.describe",
    idempotencyKey: `legacy-import/forward-repair-unrelated-${sequence}`,
    expectedRevision: prepared.applicationReceipt.resultingRevision,
    expectedAuthorityEpoch: prepared.applicationReceipt.resultingAuthorityEpoch,
    actorType: "agent",
    sourceTransport: "internal",
    payload: { milestoneId: "M-LATER" },
  }, () => {
    db().prepare(`INSERT INTO milestones (id, title, status, created_at)
      VALUES ('M-LATER', 'Accepted later work', 'active', '2026-07-18T00:00:00.000Z')`).run();
    return {
      events: [{
        eventType: "milestone.described",
        entityType: "milestone",
        entityId: "M-LATER",
        payload: { title: "Accepted later work" },
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: "milestone/m-later",
        projectionKind: "markdown",
        rendererVersion: "v1",
      }],
    };
  });
  const { input, plan } = prepareRepairInput(prepared, "tombstone-imported-hierarchy");
  const importedLifecycles = db().prepare(`SELECT item_kind, lifecycle_status
    FROM workflow_item_lifecycles WHERE milestone_id = 'M001' ORDER BY item_kind`).all();
  assert.ok(importedLifecycles.length > 0);
  assert.ok(
    plan.targets.some((entry) => entry.mutation?.action === "cancel-imported-lifecycle"),
    JSON.stringify(plan.targets),
  );
  // #1657: the Application now mints a lifecycle for every created hierarchy
  // row, so the repair cancels those directly instead of creating cancelled
  // tombstones for lifecycle-less ancestors.
  assert.equal(
    plan.targets.filter((entry) => entry.mutation?.action === "create-cancelled-lifecycle").length,
    0,
  );
  assert.equal(
    plan.targets.filter((entry) => entry.mutation?.action === "cancel-imported-lifecycle").length,
    3,
  );

  assert.equal(applyLegacyImportForwardRepair(input).status, "committed");

  assert.deepEqual(db().prepare(`SELECT DISTINCT lifecycle_status
    FROM workflow_item_lifecycles WHERE milestone_id = 'M001'`).all(), [{ lifecycle_status: "cancelled" }]);
  assert.equal(db().prepare("SELECT COUNT(*) AS count FROM milestones WHERE id = 'M001'").get()?.["count"], 1);
  assert.equal(db().prepare("SELECT title FROM milestones WHERE id = 'M-LATER'").get()?.["title"], "Accepted later work");
});

test("Forward Repair Domain Operation rolls back mutations without its exact receipt", () => {
  const prepared = prepareCase();
  commitLaterCanonicalRow(prepared);
  const { input, plan } = prepareRepairInput(prepared, "missing-receipt");
  const before = durableRepairSnapshot();

  assert.throws(
    () => _executeImportForwardRepairDomainOperation({
      operationType: "import.forward_repair",
      idempotencyKey: input.invocation.idempotencyKey,
      expectedRevision: plan.expectedProjectRevision,
      expectedAuthorityEpoch: plan.expectedAuthorityEpoch,
      actorType: input.invocation.actorType,
      actorId: input.invocation.actorId,
      sourceTransport: input.invocation.sourceTransport,
      payload: plan,
    }, () => {
      db().prepare("UPDATE milestones SET title = 'unreceipted' WHERE id = 'M001'").run();
      return {
        events: [{
          eventType: "legacy-import.forward-repaired",
          entityType: "legacy-import",
          entityId: plan.previewId,
          payload: plan as unknown as DomainJsonValue,
          destinations: ["projection"],
        }],
        projections: [{
          projectionKey: "legacy-import/forward-repair",
          projectionKind: "markdown",
          rendererVersion: "v1",
        }],
      };
    }),
    /requires one exact receipt/i,
  );

  assert.deepEqual(durableRepairSnapshot(), before);
});

test("Forward Repair tombstones untouched import-created hierarchy instead of deleting it (#1657)", () => {
  const prepared = prepareCase();
  executeDomainOperation({
    operationType: "milestone.describe",
    idempotencyKey: `legacy-import/forward-repair-untouched-${sequence}`,
    expectedRevision: prepared.applicationReceipt.resultingRevision,
    expectedAuthorityEpoch: prepared.applicationReceipt.resultingAuthorityEpoch,
    actorType: "agent",
    actorId: "forward-repair-test",
    sourceTransport: "internal",
    payload: { milestoneId: "M-LATER" },
  }, () => {
    db().prepare(`INSERT INTO milestones (id, title, status, created_at)
      VALUES ('M-LATER', 'Unrelated later work', 'active', '2026-07-18T00:00:00.000Z')`).run();
    return {
      events: [{
        eventType: "milestone.described",
        entityType: "milestone",
        entityId: "M-LATER",
        payload: { title: "Unrelated later work" },
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: "milestone/m-later",
        projectionKind: "markdown",
        rendererVersion: "v1",
      }],
    };
  });
  const backupBytes = readFileSync(prepared.backup.backup_ref);
  const { plan, input } = prepareRepairInput(prepared, "untouched");

  assert.equal(plan.unresolvedCount, 0);
  const createdTargets = plan.targets.filter((entry) => (
    entry.targetKind === "milestone" || entry.targetKind === "slice" || entry.targetKind === "task"
  ));
  assert.ok(createdTargets.length > 0);
  // #1657: every import-created hierarchy row now carries import-minted
  // lifecycle authority, so the revert retains the rows and cancels their
  // lifecycles rather than deleting adopted lifecycle history.
  for (const entry of createdTargets) {
    assert.equal(entry.disposition, "preserve", `${entry.targetKey} must be retained for its lifecycle tombstone`);
    assert.equal(entry.reasonCode, "CREATED_ROW_RETAINED_FOR_LIFECYCLE_TOMBSTONE", `${entry.targetKey} reason`);
  }
  const lifecycleTargets = plan.targets.filter((entry) => (
    entry.mutation?.action === "cancel-imported-lifecycle"
  ));
  assert.equal(lifecycleTargets.length, createdTargets.length);

  const committed = applyLegacyImportForwardRepair(input);
  assert.equal(committed.status, "committed");
  assert.deepEqual(readFileSync(prepared.backup.backup_ref), backupBytes);
  assert.ok(Number(db().prepare(`SELECT COUNT(*) AS count FROM milestones
    WHERE id IN ('M001', 'M002', 'M003', 'M004')`).get()?.["count"]) > 0);
  assert.deepEqual(db().prepare(`SELECT DISTINCT lifecycle_status FROM workflow_item_lifecycles
    WHERE milestone_id IN ('M001', 'M002', 'M003', 'M004')`).all(), [{ lifecycle_status: "cancelled" }]);
  assert.deepEqual(db().prepare(`SELECT title, status FROM milestones WHERE id = 'M-LATER'`).get(), {
    title: "Unrelated later work",
    status: "active",
  });
});

test("Forward Repair preserves an import-created row modified only on a defaulted field", () => {
  const prepared = prepareCase();
  executeDomainOperation({
    operationType: "milestone.describe",
    idempotencyKey: `legacy-import/forward-repair-defaulted-${sequence}`,
    expectedRevision: prepared.applicationReceipt.resultingRevision,
    expectedAuthorityEpoch: prepared.applicationReceipt.resultingAuthorityEpoch,
    actorType: "agent",
    actorId: "forward-repair-test",
    sourceTransport: "internal",
    payload: { milestoneId: "M001" },
  }, () => {
    const changed = db().prepare("UPDATE milestones SET vision = 'Later accepted vision' WHERE id = 'M001'").run();
    assert.equal((changed as { changes?: unknown }).changes, 1);
    return {
      events: [{
        eventType: "milestone.described",
        entityType: "milestone",
        entityId: "M001",
        payload: { vision: "Later accepted vision" },
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: "milestone/m001",
        projectionKind: "markdown",
        rendererVersion: "v1",
      }],
    };
  });
  const { plan, input } = prepareRepairInput(prepared, "defaulted");

  const evolved = plan.targets.find((entry) => entry.targetKind === "milestone" && entry.targetKey === "M001");
  assert.equal(evolved?.disposition, "later-modified");
  assert.equal(evolved?.reasonCode, "CREATED_ROW_CHANGED_LATER");
  const untouched = plan.targets.find((entry) => entry.targetKind === "milestone" && entry.targetKey === "M002");
  // #1657: untouched import-created rows carry import-minted lifecycles, so
  // they are retained for their lifecycle tombstone instead of deleted.
  assert.equal(untouched?.disposition, "preserve");
  assert.equal(untouched?.reasonCode, "CREATED_ROW_RETAINED_FOR_LIFECYCLE_TOMBSTONE");
  assert.equal(plan.unresolvedCount, 0);

  const committed = applyLegacyImportForwardRepair(input);
  assert.equal(committed.status, "committed");
  assert.deepEqual(db().prepare("SELECT vision FROM milestones WHERE id = 'M001'").get(), {
    vision: "Later accepted vision",
  });
  assert.equal(db().prepare("SELECT COUNT(*) AS count FROM milestones WHERE id = 'M002'").get()?.["count"], 1);
  assert.deepEqual(db().prepare(`SELECT DISTINCT lifecycle_status FROM workflow_item_lifecycles
    WHERE milestone_id = 'M002'`).all(), [{ lifecycle_status: "cancelled" }]);
});

const PRECOMMIT_FAULTS = [
  "after-operation",
  "after-mutation",
  "after-events",
  "after-outbox",
  "after-projections",
  "before-cas",
] as const satisfies readonly DomainOperationFaultPoint[];

for (const fault of PRECOMMIT_FAULTS) {
  test(`Forward Repair ${fault} failure leaves no durable change after restart`, () => {
    const prepared = prepareCase();
    commitLaterCanonicalRow(prepared);
    const { input } = prepareRepairInput(prepared, fault);
    const before = durableRepairSnapshot();
    const backupBytes = readFileSync(prepared.backup.backup_ref);
    _setDomainOperationFaultForTest(fault);

    assert.throws(() => applyLegacyImportForwardRepair(input), new RegExp(fault));

    _setDomainOperationFaultForTest(null);
    closeDatabase();
    assert.equal(openDatabase(prepared.databasePath), true);
    assert.deepEqual(durableRepairSnapshot(), before);
    assert.deepEqual(readFileSync(prepared.backup.backup_ref), backupBytes);
  });
}

test("a lost response after commit reopens and replays the exact Forward Repair receipt", () => {
  const prepared = prepareCase();
  commitLaterCanonicalRow(prepared);
  const { input } = prepareRepairInput(prepared, "lost-response");
  _setDomainOperationFaultForTest("after-commit");

  assert.throws(() => applyLegacyImportForwardRepair(input), /after-commit/);

  _setDomainOperationFaultForTest(null);
  closeDatabase();
  assert.equal(openDatabase(prepared.databasePath), true);
  const replayed = applyLegacyImportForwardRepair(input);
  assert.equal(replayed.status, "replayed");
  assert.equal(db().prepare("SELECT COUNT(*) AS count FROM workflow_import_forward_repairs").get()?.["count"], 1);
  assert.equal(db().prepare(`SELECT COUNT(*) AS count FROM slice_dependencies
    WHERE milestone_id = 'M001'`).get()?.["count"], 0);
});

test("a canonical write after inspection makes the Forward Repair plan stale without residue", () => {
  const prepared = prepareCase();
  commitLaterCanonicalRow(prepared);
  const { plan, input } = prepareRepairInput(prepared, "stale");
  executeDomainOperation({
    operationType: "milestone.describe",
    idempotencyKey: `legacy-import/forward-repair-race-${sequence}`,
    expectedRevision: plan.expectedProjectRevision,
    expectedAuthorityEpoch: plan.expectedAuthorityEpoch,
    actorType: "agent",
    sourceTransport: "internal",
    payload: { milestoneId: "M-RACE" },
  }, () => {
    db().prepare(`INSERT INTO milestones (id, title, status, created_at)
      VALUES ('M-RACE', 'Accepted after inspection', 'active', '2026-07-18T00:00:00.000Z')`).run();
    return {
      events: [{
        eventType: "milestone.described",
        entityType: "milestone",
        entityId: "M-RACE",
        payload: { title: "Accepted after inspection" },
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: "milestone/m-race",
        projectionKind: "markdown",
        rendererVersion: "v1",
      }],
    };
  });
  const before = durableRepairSnapshot();

  assert.throws(() => applyLegacyImportForwardRepair(input), (error) => (
    error instanceof LegacyImportForwardRepairError
    && error.code === "LEGACY_IMPORT_FORWARD_REPAIR_PLAN_CHANGED"
  ));

  assert.deepEqual(durableRepairSnapshot(), before);
  assert.equal(db().prepare("SELECT title FROM milestones WHERE id = 'M-RACE'").get()?.["title"], "Accepted after inspection");
});

test("the generic Domain Operation seam refuses Forward Repair", () => {
  prepareCase();
  assert.throws(() => executeDomainOperation({
    operationType: "import.forward_repair",
    idempotencyKey: `legacy-import/forward-repair-generic-${sequence}`,
    expectedRevision: 1,
    expectedAuthorityEpoch: 0,
    actorType: "agent",
    sourceTransport: "internal",
    payload: {},
  }, () => ({ events: [], projections: [] })), /requires the typed Forward Repair operation/);
});

test("public Forward Repair refuses a true imported-field overlap without writing", () => {
  const prepared = prepareCase(true);
  executeDomainOperation({
    operationType: "milestone.describe",
    idempotencyKey: `legacy-import/forward-repair-overlap-${sequence}`,
    expectedRevision: prepared.applicationReceipt.resultingRevision,
    expectedAuthorityEpoch: prepared.applicationReceipt.resultingAuthorityEpoch,
    actorType: "agent",
    sourceTransport: "internal",
    payload: { milestoneId: "M001" },
  }, () => {
    const changed = db().prepare("UPDATE milestones SET title = 'Accepted later foundation' WHERE id = 'M001'").run();
    assert.equal((changed as { changes?: unknown }).changes, 1);
    return {
      events: [{
        eventType: "milestone.described",
        entityType: "milestone",
        entityId: "M001",
        payload: { title: "Accepted later foundation" },
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: "milestone/m001",
        projectionKind: "markdown",
        rendererVersion: "v1",
      }],
    };
  });
  const { plan, input } = prepareRepairInput(prepared, "overlap");
  assert.ok(plan.targets.some((entry) => entry.disposition === "choice-required"));
  const before = durableRepairSnapshot();

  assert.throws(() => applyLegacyImportForwardRepair(input), (error) => (
    error instanceof LegacyImportForwardRepairError
    && error.code === "LEGACY_IMPORT_FORWARD_REPAIR_CHOICE_REQUIRED"
  ));

  assert.deepEqual(durableRepairSnapshot(), before);
  assert.equal(db().prepare("SELECT title FROM milestones WHERE id = 'M001'").get()?.["title"], "Accepted later foundation");
});

test("an explicit reviewed overlap choice resumes Forward Repair", () => {
  const prepared = prepareCase(true);
  executeDomainOperation({
    operationType: "milestone.describe",
    idempotencyKey: `legacy-import/forward-repair-choice-${sequence}`,
    expectedRevision: prepared.applicationReceipt.resultingRevision,
    expectedAuthorityEpoch: prepared.applicationReceipt.resultingAuthorityEpoch,
    actorType: "agent",
    sourceTransport: "internal",
    payload: { milestoneId: "M001" },
  }, () => {
    db().prepare("UPDATE milestones SET title = 'Accepted later foundation' WHERE id = 'M001'").run();
    return {
      events: [{
        eventType: "milestone.described",
        entityType: "milestone",
        entityId: "M001",
        payload: { title: "Accepted later foundation" },
        destinations: ["projection"],
      }],
      projections: [{ projectionKey: "milestone/m001", projectionKind: "markdown", rendererVersion: "v1" }],
    };
  });
  const unresolved = inspectLegacyImportForwardRepair({
    applicationIdentityHash: prepared.applicationIdentityHash,
    backup: prepared.backup,
  });
  const overlap = unresolved.targets.find((entry) => entry.disposition === "choice-required");
  assert.ok(overlap);
  const choices = [{
    instructionIndex: overlap.instructionIndex,
    targetKind: overlap.targetKind,
    targetKey: overlap.targetKey,
    reviewHash: overlap.reviewHash!,
    decision: "preserve-later",
  }];
  const inspectWithChoices = inspectLegacyImportForwardRepair as unknown as (input: unknown) => typeof unresolved;
  const resolved = inspectWithChoices({
    applicationIdentityHash: prepared.applicationIdentityHash,
    backup: prepared.backup,
    choices,
  });

  assert.equal(resolved.unresolvedCount, 0);
  assert.equal(resolved.targets[overlap.instructionIndex]?.reasonCode, "EXPLICIT_CHOICE_PRESERVE_LATER");
  const applyWithChoices = applyLegacyImportForwardRepair as unknown as (input: unknown) => { status: string };
  const result = applyWithChoices({
    applicationIdentityHash: prepared.applicationIdentityHash,
    backup: prepared.backup,
    choices,
    invocation: {
      idempotencyKey: `legacy-import/forward-repair-resolved-overlap-${sequence}`,
      sourceTransport: "internal",
      actorType: "agent",
      actorId: "forward-repair-test",
    },
    plan: resolved,
  });
  assert.equal(result.status, "committed");
  assert.equal(db().prepare("SELECT title FROM milestones WHERE id = 'M001'").get()?.["title"], "Accepted later foundation");
});

test("a reviewed overlap choice is rejected after its target changes", () => {
  const prepared = prepareCase(true);
  const describe = (title: string, expectedRevision: number, id: string): void => {
    executeDomainOperation({
      operationType: "milestone.describe",
      idempotencyKey: id,
      expectedRevision,
      expectedAuthorityEpoch: prepared.applicationReceipt.resultingAuthorityEpoch,
      actorType: "agent",
      sourceTransport: "internal",
      payload: { milestoneId: "M001" },
    }, () => {
      db().prepare("UPDATE milestones SET title = :title WHERE id = 'M001'").run({ ":title": title });
      return {
        events: [{
          eventType: "milestone.described",
          entityType: "milestone",
          entityId: "M001",
          payload: { title },
          destinations: ["projection"],
        }],
        projections: [{ projectionKey: "milestone/m001", projectionKind: "markdown", rendererVersion: "v1" }],
      };
    });
  };
  describe("First later title", prepared.applicationReceipt.resultingRevision, `legacy-import/review-first-${sequence}`);
  const unresolved = inspectLegacyImportForwardRepair({
    applicationIdentityHash: prepared.applicationIdentityHash,
    backup: prepared.backup,
  });
  const overlap = unresolved.targets.find((entry) => entry.disposition === "choice-required");
  assert.ok(overlap?.reviewHash);
  const choice = {
    instructionIndex: overlap.instructionIndex,
    targetKind: overlap.targetKind,
    targetKey: overlap.targetKey,
    reviewHash: overlap.reviewHash,
    decision: "restore-backup" as const,
  };

  describe("Second later title", prepared.applicationReceipt.resultingRevision + 1, `legacy-import/review-second-${sequence}`);

  assert.throws(
    () => inspectLegacyImportForwardRepair({
      applicationIdentityHash: prepared.applicationIdentityHash,
      backup: prepared.backup,
      choices: [choice],
    }),
    /does not match its reviewed target/,
  );
  assert.equal(db().prepare("SELECT title FROM milestones WHERE id = 'M001'").get()?.["title"], "Second later title");
});

test("Forward Repair requires a choice when a field changed away from both base and import values", () => {
  const identity = hashLegacyImportValue({ id: "R001" });
  const baseRow: LegacyImportBaseRow = {
    row_set: "requirements",
    identity: JSON.stringify({ id: "R001" }),
    value: { id: "R001", description: "base" },
  };
  const currentRow: LegacyImportBaseRow = {
    row_set: "requirements",
    identity: baseRow.identity,
    value: { id: "R001", description: "later" },
  };
  const applicationPlan = {
    planSchemaVersion: 2,
    previewId: identity,
    previewHash: identity,
    baseProjectRevision: 0,
    baseAuthorityEpoch: 0,
    receiptCounts: { create: 0, update: 1, delete: 0, preserve: 0, unparsed: 0, unresolved: 0 },
    instructions: [{
      action: "update",
      targetKind: "requirement",
      targetKey: "R001",
      rowSet: "requirements",
      identity: { id: "R001" },
      values: { description: "imported" },
      changeIds: [identity],
    }],
    accounting: {
      sourceIds: [], diagnosisIds: [], resolutionIds: [], changeIds: [identity],
      preserveChangeIds: [], unparsedSourceIds: [],
    },
    mutationCounts: {
      create: 0, update: 1, delete: 0,
      replaceSliceDependencies: 0, deleteSliceDependencies: 0, adoptLifecycle: 0, seedQualityGate: 0,
    },
    affectedTargets: [{ targetKind: "requirement", targetKey: "R001" }],
    eventFacts: {
      previewId: identity,
      previewHash: identity,
      sourceSetHash: identity,
      changeSetHash: identity,
      receiptCounts: { create: 0, update: 1, delete: 0, preserve: 0, unparsed: 0, unresolved: 0 },
      mutationCounts: {
        create: 0, update: 1, delete: 0,
        replaceSliceDependencies: 0, deleteSliceDependencies: 0, adoptLifecycle: 0, seedQualityGate: 0,
      },
      affectedTargetHashes: [identity],
      sourceCount: 0, diagnosisCount: 0, resolutionCount: 0, preserveCount: 0, unparsedCount: 0,
    },
    projectionKeys: ["legacy-import/test"],
  } as LegacyImportApplicationPlan;
  const plan = compileLegacyImportForwardRepairPlan({
    applicationOperationId: "application-op",
    applicationIdentityHash: identity,
    applicationRelevantRowsHash: identity,
    previewId: identity,
    previewHash: identity,
    backupId: identity,
    applicationPlan,
    backupBase: baseSnapshot(0, [baseRow]),
    currentBase: baseSnapshot(2, [currentRow]),
  });

  assert.equal(plan.unresolvedCount, 1);
  assert.equal(plan.mutationCount, 0);
  assert.equal(plan.targets[0]?.disposition, "choice-required");
  assert.equal(plan.targets[0]?.reasonCode, "UPDATED_FIELD_CHANGED_LATER");
});

test("an imported decision already removed from a base without it is already repaired", () => {
  const identity = hashLegacyImportValue({ id: "D001" });
  const applicationPlan = {
    planSchemaVersion: 2,
    previewId: identity,
    previewHash: identity,
    baseProjectRevision: 0,
    baseAuthorityEpoch: 0,
    instructions: [{
      action: "create-decision-memory",
      targetKind: "decision",
      targetKey: "D001",
      decisionId: "D001",
      values: { decision: "Imported decision", choice: "Imported choice" },
      changeIds: [identity],
    }],
  } as unknown as LegacyImportApplicationPlan;
  const plan = compileLegacyImportForwardRepairPlan({
    applicationOperationId: "application-op",
    applicationIdentityHash: identity,
    applicationRelevantRowsHash: identity,
    previewId: identity,
    previewHash: identity,
    backupId: identity,
    applicationPlan,
    backupBase: baseSnapshot(0, []),
    currentBase: baseSnapshot(2, []),
  });

  assert.equal(plan.unresolvedCount, 0);
  assert.equal(plan.mutationCount, 0);
  assert.equal(plan.targets[0]?.disposition, "already-repaired");
  assert.equal(plan.targets[0]?.reasonCode, "DECISION_ALREADY_RESTORED");
});

test("the retain goal keeps intact Application rows instead of reverting them", () => {
  const identity = hashLegacyImportValue({ id: "R001" });
  const applicationPlan = {
    planSchemaVersion: 2,
    previewId: identity,
    previewHash: identity,
    baseProjectRevision: 0,
    baseAuthorityEpoch: 0,
    instructions: [{
      action: "create",
      targetKind: "requirement",
      targetKey: "R001",
      rowSet: "requirements",
      identity: { id: "R001" },
      values: { id: "R001", description: "imported" },
      changeIds: [identity],
    }],
  } as unknown as LegacyImportApplicationPlan;
  const unchangedRow: LegacyImportBaseRow = {
    row_set: "requirements",
    identity: JSON.stringify({ id: "R001" }),
    value: {
      id: "R001", class: "", status: "", description: "imported", why: "", source: "",
      primary_owner: "", supporting_slices: "", validation: "", notes: "",
      full_content: "", superseded_by: null,
    },
  };
  const input = {
    applicationOperationId: "application-op",
    applicationIdentityHash: identity,
    applicationRelevantRowsHash: identity,
    previewId: identity,
    previewHash: identity,
    backupId: identity,
    applicationPlan,
    backupBase: baseSnapshot(0, []),
  };

  const revert = compileLegacyImportForwardRepairPlan({
    ...input,
    currentBase: baseSnapshot(2, [unchangedRow]),
  });
  assert.equal(revert.goal, "revert");
  assert.equal(revert.targets[0]?.disposition, "safe-revert");
  assert.equal(revert.targets[0]?.mutation?.action, "delete");
  assert.equal(revert.mutationCount, 1);

  const retain = compileLegacyImportForwardRepairPlan({
    ...input,
    currentBase: baseSnapshot(2, [unchangedRow]),
    goal: "retain",
  });
  assert.equal(retain.goal, "retain");
  assert.equal(retain.targets[0]?.disposition, "already-repaired");
  assert.equal(retain.targets[0]?.reasonCode, "CREATED_ROW_UNCHANGED");
  assert.equal(retain.targets[0]?.mutation, null);
  assert.equal(retain.mutationCount, 0);

  const retainedDeletion = compileLegacyImportForwardRepairPlan({
    ...input,
    currentBase: baseSnapshot(2, []),
    goal: "retain",
  });
  assert.equal(retainedDeletion.targets[0]?.disposition, "later-modified");
  assert.equal(retainedDeletion.targets[0]?.reasonCode, "CREATED_ROW_DELETED_LATER");
  assert.equal(retainedDeletion.targets[0]?.mutation, null);
  assert.equal(retainedDeletion.mutationCount, 0);
});

function deleteTarget(
  instructionIndex: number,
  targetKind: string,
  targetKey: string,
  rowSet: string,
  identity: Record<string, string>,
): unknown {
  return {
    instructionIndex,
    targetKind,
    targetKey,
    changeIds: [],
    disposition: "safe-revert",
    reasonCode: "CREATED_ROW_UNCHANGED",
    reviewHash: null,
    review: null,
    mutation: { action: "delete", rowSet, identity, values: {} },
  };
}

function applyWriterPlan(prepared: PreparedCase, suffix: string, targets: readonly unknown[]): void {
  const typedTargets = targets as LegacyImportForwardRepairPlan["targets"];
  const relevantRowsHash = captureCurrentLegacyImportBaseSnapshot().relevant_rows_hash;
  const plan = {
    planSchemaVersion: LEGACY_IMPORT_FORWARD_REPAIR_PLAN_SCHEMA_VERSION,
    goal: "revert",
    applicationOperationId: prepared.applicationReceipt.operationId,
    applicationIdentityHash: prepared.applicationIdentityHash,
    previewId: prepared.applicationReceipt.previewId,
    previewHash: prepared.applicationReceipt.previewHash,
    backupId: prepared.backup.backup_id,
    differenceHash: hashLegacyImportValue({ suffix, targets } as unknown as DomainJsonValue),
    expectedProjectRevision: prepared.applicationReceipt.resultingRevision,
    expectedAuthorityEpoch: prepared.applicationReceipt.resultingAuthorityEpoch,
    baseRelevantRowsHash: prepared.backup.relevant_rows_hash,
    applicationRelevantRowsHash: relevantRowsHash,
    currentRelevantRowsHash: relevantRowsHash,
    targetCount: typedTargets.length,
    mutationCount: typedTargets.filter((entry) => entry.mutation !== null).length,
    preservedCount: typedTargets.filter((entry) => entry.mutation === null).length,
    rejectedCount: 0,
    unresolvedCount: 0,
    targets: typedTargets,
  } satisfies LegacyImportForwardRepairPlan;
  _executeImportForwardRepairDomainOperation({
    operationType: "import.forward_repair",
    idempotencyKey: `legacy-import/forward-repair-writer-${sequence}-${suffix}`,
    expectedRevision: prepared.applicationReceipt.resultingRevision,
    expectedAuthorityEpoch: prepared.applicationReceipt.resultingAuthorityEpoch,
    actorType: "agent",
    actorId: "forward-repair-test",
    sourceTransport: "internal",
    payload: plan,
  }, (context) => {
    applyImportForwardRepairPlan(context, plan);
    insertImportForwardRepairReceipt(context, plan);
    return {
      events: [{
        eventType: "legacy-import.forward-repaired",
        entityType: "legacy-import",
        entityId: plan.previewId,
        payload: plan as unknown as DomainJsonValue,
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: "legacy-import/forward-repair",
        projectionKind: "markdown",
        rendererVersion: "v1",
      }],
    };
  });
}

// #1657: import-created rows always carry lifecycle rows now, and the schema
// forbids deleting lifecycle history. Seed lifecycle-less hierarchy (as a
// pre-#1657 Application would have left it) so the deeper guards stay covered.
function seedLifecycleLessHierarchy(): void {
  db().prepare(`INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M900', 'Pre-lifecycle import', 'active', '2026-07-18T00:00:00.000Z')`).run();
  db().prepare(`INSERT INTO slices (milestone_id, id, title, status)
    VALUES ('M900', 'S01', 'Pre-lifecycle slice', 'pending')`).run();
  db().prepare(`INSERT INTO tasks (milestone_id, slice_id, id, title, status)
    VALUES ('M900', 'S01', 'T01', 'Pre-lifecycle task', 'pending')`).run();
}

test("the repair writer refuses to strand later artifact history on a created row", () => {
  const prepared = prepareCase();
  seedLifecycleLessHierarchy();
  db().prepare(`INSERT INTO artifacts (path, artifact_type, milestone_id, slice_id, task_id, full_content, imported_at)
    VALUES ('.gsd/later-evidence.md', 'note', 'M900', 'S01', NULL, 'later canonical evidence', '2026-07-19T00:00:00.000Z')`).run();
  const targets = [
    deleteTarget(0, "slice", "M900/S01", "slices", { milestone_id: "M900", id: "S01" }),
    deleteTarget(1, "task", "M900/S01/T01", "tasks", { milestone_id: "M900", slice_id: "S01", id: "T01" }),
  ];
  const before = durableRepairSnapshot();

  assert.throws(() => applyWriterPlan(prepared, "artifact-guard", targets), /retained artifacts history/);

  assert.deepEqual(durableRepairSnapshot(), before);
  assert.equal(db().prepare(`SELECT COUNT(*) AS count FROM artifacts
    WHERE path = '.gsd/later-evidence.md'`).get()?.["count"], 1);
  assert.equal(db().prepare(`SELECT COUNT(*) AS count FROM slices
    WHERE milestone_id = 'M900' AND id = 'S01'`).get()?.["count"], 1);
  assert.equal(db().prepare(`SELECT COUNT(*) AS count FROM tasks
    WHERE milestone_id = 'M900' AND slice_id = 'S01' AND id = 'T01'`).get()?.["count"], 1);
});

test("the repair writer refuses to delete a created row that gained unit dispatch history", () => {
  const prepared = prepareCase();
  seedLifecycleLessHierarchy();
  db().prepare(`INSERT INTO workers (worker_id, host, pid, started_at, version, last_heartbeat_at, status, project_root_realpath)
    VALUES ('worker-guard', 'localhost', 1, '2026-07-19T00:00:00.000Z', 'test', '2026-07-19T00:00:00.000Z', 'active', '/tmp/project-1')`).run();
  db().prepare(`INSERT INTO unit_dispatches (trace_id, worker_id, milestone_lease_token, milestone_id, slice_id, task_id, unit_type, unit_id, status, started_at)
    VALUES ('trace-guard', 'worker-guard', 1, 'M900', 'S01', 'T01', 'task', 'T01', 'completed', '2026-07-19T00:00:00.000Z')`).run();
  const targets = [
    deleteTarget(0, "task", "M900/S01/T01", "tasks", { milestone_id: "M900", slice_id: "S01", id: "T01" }),
  ];
  const before = durableRepairSnapshot();

  assert.throws(() => applyWriterPlan(prepared, "dispatch-guard", targets), /retained unit_dispatches history/);

  assert.deepEqual(durableRepairSnapshot(), before);
  assert.equal(db().prepare(`SELECT COUNT(*) AS count FROM tasks
    WHERE milestone_id = 'M900' AND slice_id = 'S01' AND id = 'T01'`).get()?.["count"], 1);
});

test("the repair writer reverts parent-first target lists child-first", () => {
  const prepared = prepareCase();
  seedLifecycleLessHierarchy();
  const targets = [
    deleteTarget(0, "milestone", "M900", "milestones", { id: "M900" }),
    deleteTarget(1, "slice", "M900/S01", "slices", { milestone_id: "M900", id: "S01" }),
    deleteTarget(2, "task", "M900/S01/T01", "tasks", { milestone_id: "M900", slice_id: "S01", id: "T01" }),
  ];

  applyWriterPlan(prepared, "ordering", targets);

  assert.equal(db().prepare("SELECT COUNT(*) AS count FROM tasks WHERE milestone_id = 'M900'").get()?.["count"], 0);
  assert.equal(db().prepare("SELECT COUNT(*) AS count FROM slices WHERE milestone_id = 'M900'").get()?.["count"], 0);
  assert.equal(db().prepare("SELECT COUNT(*) AS count FROM milestones WHERE id = 'M900'").get()?.["count"], 0);
});

test("a decision memory deleted after import is later-modified, not an impossible restore choice", () => {
  const identity = hashLegacyImportValue({ id: "D002" });
  const structuredFields = canonicalLegacyImportJson({
    sourceDecisionId: "D002",
    when_context: null,
    scope: "project",
    decision: "Original decision",
    choice: "Original choice",
    rationale: null,
    revisable: null,
    made_by: null,
    source: null,
    superseded_by: null,
    deleted: false,
  });
  const memoryRow: LegacyImportBaseRow = {
    row_set: "decision_memories",
    identity: canonicalLegacyImportJson({ source_decision_id: "D002" }),
    value: { id: "mem-d002", structured_fields: structuredFields },
  };
  const applicationPlan = {
    planSchemaVersion: 2,
    previewId: identity,
    previewHash: identity,
    baseProjectRevision: 0,
    baseAuthorityEpoch: 0,
    instructions: [{
      action: "update-decision-memory",
      targetKind: "decision",
      targetKey: "D002",
      decisionId: "D002",
      values: { rationale: "Imported rationale" },
      changeIds: [identity],
    }],
  } as unknown as LegacyImportApplicationPlan;
  const plan = compileLegacyImportForwardRepairPlan({
    applicationOperationId: "application-op",
    applicationIdentityHash: identity,
    applicationRelevantRowsHash: identity,
    previewId: identity,
    previewHash: identity,
    backupId: identity,
    applicationPlan,
    backupBase: baseSnapshot(0, [memoryRow]),
    currentBase: baseSnapshot(2, []),
  });

  assert.equal(plan.unresolvedCount, 0);
  assert.equal(plan.mutationCount, 0);
  assert.equal(plan.targets[0]?.disposition, "later-modified");
  assert.equal(plan.targets[0]?.reasonCode, "DECISION_MEMORY_DELETED_LATER");
});

test("Forward Repair reports idle current authority as not-required", () => {
  const prepared = prepareCase();
  assert.throws(() => inspectLegacyImportForwardRepair({
    applicationIdentityHash: prepared.applicationIdentityHash,
    backup: prepared.backup,
  }), (error) => (
    error instanceof LegacyImportForwardRepairError
    && error.code === "LEGACY_IMPORT_FORWARD_REPAIR_NOT_REQUIRED"
  ));
});
