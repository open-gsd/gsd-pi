// Project/App: gsd-pi
// File Purpose: A process that holds a receipt of the Authority Epoch cutover refuses an older copy of the database.

import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { _executeAuthorityCutoverDomainOperation } from "../db/domain-operation.ts";
import { snapshotDatabaseFile } from "../db/engine.ts";
import { insertAuthorityCutoverReceipt } from "../db/writers/authority-recovery.ts";
import { readDomainOperationFence } from "../db/writers/lifecycle-commands.ts";
import { closeDatabase, getMilestone, isDbAvailable, openDatabase } from "../gsd-db.ts";
import { registerMilestones } from "../milestone-registration.ts";

const tempDirs = new Set<string>();

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-epoch-receipt-fence-"));
  tempDirs.add(dir);
  return join(dir, "gsd.db");
}

/** Advance the Authority Epoch of the open Project from 0 to 1. This process gets the receipt. */
function cutOver(): void {
  const fence = readDomainOperationFence();
  const evidenceHash = `sha256:${"3".repeat(64)}`;
  const consentHash = `sha256:${"4".repeat(64)}`;
  const receipt = _executeAuthorityCutoverDomainOperation({
    operationType: "authority.cutover",
    idempotencyKey: "authority-epoch-receipt-fence/cutover",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "agent",
    sourceTransport: "internal",
    payload: { authorityContractVersion: 1, evidenceHash, consentHash },
  }, (context) => {
    insertAuthorityCutoverReceipt(context, { authorityContractVersion: 1, evidenceHash, consentHash });
    return {
      events: [{ eventType: "test.cutover", entityType: "project", entityId: "test", payload: {}, destinations: ["db"] }],
      projections: [{ projectionKey: "state", projectionKind: "state", rendererVersion: "1" }],
    };
  });
  assert.equal(receipt.resultingAuthorityEpoch, 1);
}

test("a process that holds a cutover receipt refuses an older copy of the database", () => {
  const databasePath = tempDbPath();
  assert.equal(openDatabase(databasePath), true);
  registerMilestones([{ id: "M001", title: "Milestone" }], "test");
  closeDatabase();
  const backupPath = `${databasePath}.pre-cutover`;
  snapshotDatabaseFile(databasePath, backupPath);

  assert.equal(openDatabase(databasePath), true);
  cutOver();
  closeDatabase();
  assert.equal(openDatabase(databasePath), true, "the database at the receipt epoch opens");
  closeDatabase();

  copyFileSync(backupPath, databasePath);
  rmSync(`${databasePath}-wal`, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });

  const refused = /is at Authority Epoch 0, lower than Authority Epoch 1 of the last Domain Operation receipt/;
  assert.throws(() => openDatabase(databasePath), refused);
  assert.equal(isDbAvailable(), false, "the older copy must not become the open database");
  assert.throws(() => openDatabase(databasePath), refused, "a retry is refused too");
});

test("a cutover receipt of one Project does not fence another Project", () => {
  assert.equal(openDatabase(tempDbPath()), true);
  registerMilestones([{ id: "M001", title: "Cut over" }], "test");
  cutOver();
  closeDatabase();

  const otherPath = tempDbPath();
  assert.equal(openDatabase(otherPath), true);
  registerMilestones([{ id: "M001", title: "Other project" }], "test");
  closeDatabase();
  assert.equal(openDatabase(otherPath), true);
  assert.equal(getMilestone("M001")?.title, "Other project");
});
