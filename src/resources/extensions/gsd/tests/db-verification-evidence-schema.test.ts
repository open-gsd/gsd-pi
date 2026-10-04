// Project/App: gsd-pi
// File Purpose: Tests for verification evidence schema helpers.

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDatabase, openDatabase, _getAdapter } from "../gsd-db.ts";

const INSERT_CLAIM = `
  INSERT OR IGNORE INTO verification_evidence (
    task_id, slice_id, milestone_id, attempt_ref, command, exit_code, verdict, duration_ms, created_at
  ) VALUES ('T01', 'S01', 'M001', :attempt_ref, 'npm test', 0, 'pass', 5, '2026-04-12T00:00:00.000Z')
`;

function claims(): Array<Record<string, unknown>> {
  return _getAdapter()!.prepare("SELECT attempt_ref, command FROM verification_evidence ORDER BY id").all()
    .map((row) => ({ ...row }));
}

describe("db-verification-evidence-schema", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gsd-evidence-schema-"));
    dbPath = join(dir, "gsd.db");
    openDatabase(dbPath);
    const adapter = _getAdapter()!;
    adapter.prepare("INSERT INTO milestones (id, created_at) VALUES ('M001', '')").run();
    adapter.prepare("INSERT INTO slices (milestone_id, id, created_at) VALUES ('M001', 'S01', '')").run();
    adapter.prepare("INSERT INTO tasks (milestone_id, slice_id, id) VALUES ('M001', 'S01', 'T01')").run();
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  test("the same claim is stored one time for each Attempt", () => {
    const insert = _getAdapter()!.prepare(INSERT_CLAIM);
    insert.run({ ":attempt_ref": "attempt-1" });
    insert.run({ ":attempt_ref": "attempt-1" });
    insert.run({ ":attempt_ref": "attempt-2" });

    assert.deepEqual(claims(), [
      { attempt_ref: "attempt-1", command: "npm test" },
      { attempt_ref: "attempt-2", command: "npm test" },
    ]);
  });

  test("a database with the dedup index that has no Attempt is upgraded on open and keeps its claims", () => {
    const adapter = _getAdapter()!;
    adapter.exec("DROP INDEX idx_verification_evidence_dedup");
    adapter.exec("ALTER TABLE verification_evidence DROP COLUMN attempt_ref");
    adapter.exec("CREATE UNIQUE INDEX idx_verification_evidence_dedup ON verification_evidence(task_id, slice_id, milestone_id, command, verdict)");
    adapter.exec(`
      INSERT INTO verification_evidence (task_id, slice_id, milestone_id, command, exit_code, verdict, duration_ms, created_at)
      VALUES ('T01', 'S01', 'M001', 'npm test', 0, 'pass', 5, '2026-04-12T00:00:00.000Z')
    `);
    closeDatabase();

    assert.equal(openDatabase(dbPath), true);
    _getAdapter()!.prepare(INSERT_CLAIM).run({ ":attempt_ref": "attempt-2" });

    assert.deepEqual(claims(), [
      { attempt_ref: "", command: "npm test" },
      { attempt_ref: "attempt-2", command: "npm test" },
    ]);
  });
});
