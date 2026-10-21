// Project/App: gsd-pi
// File Purpose: Contract tests for bounded, atomic orphan milestone reservation discard.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import {
  closeDatabase,
  getDbOrNull,
  getMilestone,
  insertMilestone,
  insertSlice,
  openDatabase,
} from "../gsd-db.ts";
import { discardOrphanMilestoneReservations } from "../orphan-milestone-discard.ts";

let base = "";

function makeBase(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-orphan-discard-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "# Test\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "test: initialize fixture"], { cwd: dir, stdio: "ignore" });
  openDatabase(join(dir, ".gsd", "gsd.db"));
  return dir;
}

afterEach(() => {
  closeDatabase();
  if (base) rmSync(base, { recursive: true, force: true });
  base = "";
});

describe("discardOrphanMilestoneReservations", () => {
  test("preflights and deletes every orphan target in one bounded operation", () => {
    base = makeBase();
    insertMilestone({ id: "M001", title: "M001", status: "queued" });
    insertMilestone({ id: "M002", status: "active" });

    const result = discardOrphanMilestoneReservations(base, ["M001", "M002"]);

    assert.equal(result.ok, true);
    assert.deepEqual(result.before.map((entry) => entry.id), ["M001", "M002"]);
    assert.ok(result.before.every((entry) => entry.dbRow && entry.orphan));
    assert.ok(result.after.every((entry) => !entry.dbRow));
    assert.equal(getMilestone("M001"), null);
    assert.equal(getMilestone("M002"), null);
  });

  test("refuses the entire set when any target owns hierarchy rows", () => {
    base = makeBase();
    insertMilestone({ id: "M001", status: "queued" });
    insertMilestone({ id: "M002", status: "queued" });
    insertSlice({ milestoneId: "M002", id: "S01", title: "Started", status: "pending" });

    const result = discardOrphanMilestoneReservations(base, ["M001", "M002"]);

    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /M002.*slices/i);
    assert.ok(getMilestone("M001"), "the clean target must not be partially deleted");
    assert.ok(getMilestone("M002"), "the rejected target must remain");
  });

  test("refuses dependent milestone references", () => {
    base = makeBase();
    insertMilestone({ id: "M001", status: "queued" });
    insertMilestone({ id: "M002", status: "queued", depends_on: ["M001"] });

    const result = discardOrphanMilestoneReservations(base, ["M001"]);

    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /M002.*depends on M001/i);
    assert.ok(getMilestone("M001"));
  });

  test("refuses disk projections, worktrees, and milestone branches", () => {
    base = makeBase();
    insertMilestone({ id: "M001", status: "queued" });
    mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
    mkdirSync(join(base, ".gsd-worktrees", "M001"), { recursive: true });
    execFileSync("git", ["branch", "milestone/M001"], { cwd: base, stdio: "ignore" });

    const result = discardOrphanMilestoneReservations(base, ["M001"]);

    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /disk projection/i);
    assert.match(result.errors.join("\n"), /worktree exists/i);
    assert.match(result.errors.join("\n"), /milestone branch/i);
    assert.ok(getMilestone("M001"));
  });

  test("refuses queue references and live worker status files", () => {
    base = makeBase();
    insertMilestone({ id: "M001", status: "queued" });
    writeFileSync(join(base, ".gsd", "QUEUE-ORDER.json"), JSON.stringify({
      order: ["M001"],
      updatedAt: new Date().toISOString(),
    }), "utf8");
    mkdirSync(join(base, ".gsd", "parallel"), { recursive: true });
    writeFileSync(join(base, ".gsd", "parallel", "M001.status.json"), JSON.stringify({
      milestoneId: "M001",
      pid: process.pid,
      state: "running",
      currentUnit: null,
      completedUnits: 0,
      cost: 0,
      lastHeartbeat: Date.now(),
      startedAt: Date.now(),
      worktreePath: "",
    }), "utf8");

    const result = discardOrphanMilestoneReservations(base, ["M001"]);

    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /queue order reference/i);
    assert.match(result.errors.join("\n"), /active worker/i);
    assert.ok(getMilestone("M001"));
  });

  test("fails closed when an external state file is malformed", () => {
    base = makeBase();
    insertMilestone({ id: "M001", status: "queued" });
    writeFileSync(join(base, ".gsd", "QUEUE-ORDER.json"), "not json", "utf8");

    const result = discardOrphanMilestoneReservations(base, ["M001"]);

    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /external preflight failed/i);
    assert.ok(getMilestone("M001"));
  });

  test("fails closed when a pending command has malformed arguments", () => {
    base = makeBase();
    insertMilestone({ id: "M001", status: "queued" });
    getDbOrNull()!.prepare(
      "INSERT INTO command_queue(command, args_json, enqueued_at) VALUES ('run', 'not json', 'now')",
    ).run();

    const result = discardOrphanMilestoneReservations(base, ["M001"]);

    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /command_queue_malformed/i);
    assert.ok(getMilestone("M001"));
  });

  test("refuses an active lease but removes an expired lease with its reservation", () => {
    base = makeBase();
    insertMilestone({ id: "M001", status: "queued" });
    const db = getDbOrNull()!;
    db.prepare(`INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status, project_root_realpath
    ) VALUES ('worker-1', 'local', 1, 'now', 'test', 'now', 'active', :root)`).run({ ":root": base });
    db.prepare(`INSERT INTO milestone_leases (
      milestone_id, worker_id, fencing_token, acquired_at, expires_at, status
    ) VALUES ('M001', 'worker-1', 1, 'now', '2999-01-01T00:00:00.000Z', 'held')`).run();

    const held = discardOrphanMilestoneReservations(base, ["M001"]);
    assert.equal(held.ok, false);
    assert.match(held.errors.join("\n"), /milestone_leases/i);
    assert.ok(getMilestone("M001"));

    db.prepare("UPDATE milestone_leases SET expires_at = 'not a date'").run();
    const malformed = discardOrphanMilestoneReservations(base, ["M001"]);
    assert.equal(malformed.ok, false);
    assert.match(malformed.errors.join("\n"), /milestone_leases/i);
    assert.ok(getMilestone("M001"));

    db.prepare("UPDATE milestone_leases SET status = 'expired', expires_at = '2000-01-01T00:00:00.000Z'").run();
    const expired = discardOrphanMilestoneReservations(base, ["M001"]);
    assert.equal(expired.ok, true);
    assert.equal(getMilestone("M001"), null);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM milestone_leases").get()?.["count"], 0);
  });

  test("refuses missing, duplicate, and invalid IDs before mutation", () => {
    base = makeBase();
    insertMilestone({ id: "M001", status: "queued" });

    for (const ids of [["M001", "M001"], ["M001", "not-an-id"], ["M001", "M002"]]) {
      const result = discardOrphanMilestoneReservations(base, ids);
      assert.equal(result.ok, false);
      assert.ok(getMilestone("M001"));
    }
  });
});
