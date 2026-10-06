// GSD Web — web undo runs the DB-backed /gsd undo path
// Proves /api/undo selects the last completed unit from the DB ledger and reopens it in the DB.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = process.cwd();
const db = await import("../../resources/extensions/gsd/gsd-db.ts");
const undoService = await import("../../web/undo-service.ts");

test("web undo of complete-slice reopens the slice in the DB", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-web-undo-"));
  const previousRoot = process.env.GSD_WEB_PACKAGE_ROOT;
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    db.openDatabase(join(base, ".gsd", "gsd.db"));
    db.insertMilestone({ id: "M001", title: "Test", status: "active" });
    db.insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "complete", risk: "low", depends: [] });
    db.insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Task", status: "complete" });
    const adapter = db._getAdapter();
    assert.ok(adapter);
    adapter.prepare(`
      INSERT INTO workers (
        worker_id, host, pid, started_at, version, last_heartbeat_at, status, project_root_realpath
      ) VALUES ('web-undo', 'host', 1, '2026-07-13T00:00:00.000Z', 'test', '2026-07-13T00:00:00.000Z', 'active', '/tmp')
    `).run();
    adapter.prepare(`
      INSERT INTO unit_dispatches (
        trace_id, worker_id, milestone_lease_token, milestone_id, slice_id,
        unit_type, unit_id, status, started_at, ended_at
      ) VALUES ('trace-web-undo', 'web-undo', 1, 'M001', 'S01',
        'complete-slice', 'M001/S01', 'completed', '2026-07-13T00:00:00.000Z', '2026-07-13T01:00:00.000Z')
    `).run();
    db.closeDatabase();

    process.env.GSD_WEB_PACKAGE_ROOT = repoRoot;
    const info = await undoService.collectUndoInfo(base);
    assert.equal(info.lastUnitKey, "complete-slice/M001/S01");
    assert.equal(info.completedCount, 1);
    assert.ok(
      info.effects.includes("Reset 1 task(s) of the slice to pending"),
      "the web confirm payload states the task reset",
    );
    assert.ok(info.effects.includes("Clear the slice summary and UAT in the database"));

    const result = await undoService.executeUndo(base);
    assert.equal(result.success, true, result.message);
    assert.match(result.message, /Reopened slice M001\/S01 in the database/);

    db.openDatabase(join(base, ".gsd", "gsd.db"));
    assert.equal(db.getSlice("M001", "S01")?.status, "in_progress");
    assert.equal(db.getTask("M001", "S01", "T01")?.status, "pending");
  } finally {
    if (previousRoot === undefined) delete process.env.GSD_WEB_PACKAGE_ROOT;
    else process.env.GSD_WEB_PACKAGE_ROOT = previousRoot;
    db.closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});
