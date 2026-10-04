// gsd-pi + Paused session via the auto_pauses row
//
// The pause that resume routing reads is the open auto_pauses row of the worker
// scope. readPausedSessionMetadata reads the row; pauseAuto writes it; a resume
// or a discard closes it. The runtime_kv key that held the pause before is
// retired (see pause-row-resume.test.ts for the legacy read).
//
// These tests verify the round-trip via the storage layer directly.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  _getAdapter,
  openDatabase,
  closeDatabase,
} from "../gsd-db.ts";
import { openAutoPause } from "../db/writers/auto-pauses.ts";
import {
  clearPausedSession,
  readPausedSessionMetadata,
} from "../interrupted-session.ts";

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-paused-session-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

function openPauseCount(): number {
  const row = _getAdapter()!.prepare(
    "SELECT count(*) AS open FROM auto_pauses WHERE closed_at IS NULL",
  ).get() as { open: number };
  return row.open;
}

test("readPausedSessionMetadata returns null when no row exists", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  assert.equal(readPausedSessionMetadata(base), null);
});

test("readPausedSessionMetadata round-trips every field of the pause row", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));

  const pausedAt = new Date().toISOString();
  const autoStartTime = Date.now();
  openAutoPause({
    blockerKind: "subjective_uat",
    dispatchId: null,
    milestoneId: "M001",
    worktreePath: "/tmp/wt",
    originalBasePath: base,
    stepMode: true,
    pausedAt,
    sessionFile: "/tmp/session.jsonl",
    unitType: "plan-slice",
    unitId: "M001/S01",
    activeEngineId: "dev",
    activeRunDir: "/tmp/run",
    autoStartTime,
    milestoneLock: "M001",
    pauseReason: "Blocked: waiting for UAT",
  });

  assert.deepEqual(readPausedSessionMetadata(base), {
    blockerKind: "subjective_uat",
    dispatchId: null,
    milestoneId: "M001",
    worktreePath: "/tmp/wt",
    originalBasePath: base,
    stepMode: true,
    pausedAt,
    sessionFile: "/tmp/session.jsonl",
    unitType: "plan-slice",
    unitId: "M001/S01",
    activeEngineId: "dev",
    activeRunDir: "/tmp/run",
    autoStartTime,
    milestoneLock: "M001",
    pauseReason: "Blocked: waiting for UAT",
  });
});

test("readPausedSessionMetadata closes a stale pseudo-milestone pause", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));

  // discuss-milestone with a non-MID-shaped unitId triggers
  // isStalePseudoMilestonePause → returns null and closes the row.
  openAutoPause({
    blockerKind: "user_request",
    milestoneId: "M001",
    unitType: "discuss-milestone",
    unitId: "PROJECT-thing",
    activeEngineId: "dev",
  });

  assert.equal(readPausedSessionMetadata(base), null);
  assert.equal(openPauseCount(), 0, "the stale pause was closed by readPausedSessionMetadata");
});

test("clearPausedSession closes the pause and is idempotent", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));

  openAutoPause({ blockerKind: "user_request", milestoneId: "M001" });
  clearPausedSession();
  clearPausedSession(); // idempotent — no throw
  assert.equal(readPausedSessionMetadata(base), null);
});

test("readPausedSessionMetadata returns null when DB is unavailable", () => {
  // No openDatabase call — DB is closed.
  try { closeDatabase(); } catch { /* noop */ }
  // Use a tmpdir-style base; the function should handle DB-unavailable gracefully.
  const base = mkdtempSync(join(tmpdir(), "gsd-paused-no-db-"));
  try {
    assert.equal(readPausedSessionMetadata(base), null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
