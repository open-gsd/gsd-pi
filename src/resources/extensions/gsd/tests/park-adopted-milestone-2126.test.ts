// Project/App: gsd-pi
// File Purpose: Adopted milestones park through canonical pause, not legacy-only writes (#2126).

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { adoptOrTransitionLifecycle } from "../db/writers/lifecycle-commands.ts";
import {
  _getAdapter,
  closeDatabase,
  executeDomainOperation,
  getMilestone,
  insertMilestone,
  openDatabase,
  readDomainOperationFence,
} from "../gsd-db.ts";
import { parkMilestone, unparkMilestone } from "../milestone-actions.ts";

const tempDirs = new Set<string>();

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function row(sql: string): Record<string, unknown> {
  return db().prepare(sql).get() ?? {};
}

function createBase(): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-park-adopted-2126-"));
  tempDirs.add(basePath);
  mkdirSync(join(basePath, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(join(basePath, ".gsd", "milestones", "M001", "M001-CONTEXT.md"), "# M001\n");
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Adopted milestone", status: "active" });
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.fixture.adopt-milestone",
    idempotencyKey: "test/fixture/adopt-milestone",
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
        eventType: "test.fixture.adopted",
        entityType: "milestone",
        entityId: "M001",
        payload: {},
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: "test/adopted/m001",
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
  return basePath;
}

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("parkMilestone parks an adopted milestone through canonical pause (#2126)", async () => {
  const basePath = createBase();

  const parked = await parkMilestone(basePath, "M001", "deprioritized");

  assert.ok(parked, "parkMilestone should succeed for adopted milestones");
  assert.equal(getMilestone("M001")?.status, "parked");
  assert.equal(
    row(`
      SELECT lifecycle_status FROM workflow_item_lifecycles
      WHERE item_kind = 'milestone' AND milestone_id = 'M001'
    `).lifecycle_status,
    "paused",
  );
  assert.ok(
    existsSync(join(basePath, ".gsd", "milestones", "M001", "M001-PARKED.md")),
    "PARKED.md marker should be written",
  );
});

test("unparkMilestone restores an adopted milestone from canonical pause (#2126)", async () => {
  const basePath = createBase();

  assert.ok(await parkMilestone(basePath, "M001", "deprioritized"));
  assert.ok(await unparkMilestone(basePath, "M001"));

  assert.equal(getMilestone("M001")?.status, "active");
  assert.equal(
    row(`
      SELECT lifecycle_status FROM workflow_item_lifecycles
      WHERE item_kind = 'milestone' AND milestone_id = 'M001'
    `).lifecycle_status,
    "in_progress",
  );
  assert.equal(
    existsSync(join(basePath, ".gsd", "milestones", "M001", "M001-PARKED.md")),
    false,
    "PARKED.md marker should be removed",
  );
});
