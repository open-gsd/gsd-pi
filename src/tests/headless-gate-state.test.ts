// Project/App: gsd-pi + honest headless completion for gate parks (#2987)
//
// `gsd headless` runs reported `Status: complete` / exit 0 while the run had
// actually parked on an unanswered discussion write gate: the durable pending
// gate lives in the project database, survives the run, and nothing in the
// wrapper looked at it. These tests cover the two seams of the fix:
//
//   1. `readPendingWriteGateState` — the wrapper-side read of the durable gate
//      rows (missing DB reads as "no gate"; an unreadable DB is surfaced as
//      readError, never silently as "no gate").
//   2. `applyPendingGateBlock` — a would-be-successful workflow run that ends
//      with a pending gate is reclassified as blocked (exit 10); quick
//      commands and runs already blocked/error keep their outcome.

import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openDatabase, closeDatabase } from "../resources/extensions/gsd/gsd-db.ts";
import {
  clearDiscussionFlowState,
  setPendingGate,
  clearPendingGate,
  markApprovalGateVerified,
} from "../resources/extensions/gsd/bootstrap/write-gate.ts";
import { readPendingWriteGateState } from "../headless-gate-state.ts";
import { applyPendingGateBlock, EXIT_BLOCKED, EXIT_SUCCESS } from "../headless-events.ts";

function makeProject(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-headless-gate-state-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

test("readPendingWriteGateState returns the pending gate id from the project database", (t) => {
  const base = makeProject();
  t.after(() => {
    clearDiscussionFlowState(base);
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });

  openDatabase(join(base, ".gsd", "gsd.db"));
  setPendingGate("depth_verification_M001_confirm", base);
  closeDatabase();

  // Reopen-fresh read: the gate is durable state, not session memory.
  assert.deepEqual(readPendingWriteGateState(base), {
    gateId: "depth_verification_M001_confirm",
    readError: null,
  });
});

test("readPendingWriteGateState reads as no gate once the gate is verified or cleared", (t) => {
  const verified = makeProject();
  t.after(() => {
    clearDiscussionFlowState(verified);
    closeDatabase();
    rmSync(verified, { recursive: true, force: true });
  });

  openDatabase(join(verified, ".gsd", "gsd.db"));
  setPendingGate("depth_verification_M002_confirm", verified);
  markApprovalGateVerified("depth_verification_M002_confirm", verified);
  closeDatabase();

  assert.deepEqual(readPendingWriteGateState(verified), {
    gateId: null,
    readError: null,
  });
});

test("readPendingWriteGateState reads as no gate after an explicit clear", (t) => {
  const cleared = makeProject();
  t.after(() => {
    clearDiscussionFlowState(cleared);
    closeDatabase();
    rmSync(cleared, { recursive: true, force: true });
  });

  openDatabase(join(cleared, ".gsd", "gsd.db"));
  setPendingGate("depth_verification_M003_confirm", cleared);
  clearPendingGate(cleared);
  closeDatabase();

  assert.deepEqual(readPendingWriteGateState(cleared), { gateId: null, readError: null });
});

test("readPendingWriteGateState reads a missing database as no gate", (t) => {
  const base = makeProject();
  t.after(() => {
    rmSync(base, { recursive: true, force: true });
  });

  assert.deepEqual(readPendingWriteGateState(base), { gateId: null, readError: null });
});

test("readPendingWriteGateState surfaces an unreadable database instead of no gate", (t) => {
  const base = makeProject();
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });

  // A .gsd directory whose gsd.db path cannot be opened as a database: the
  // read must not report a quiet "no gate" for a project whose gate state is
  // unverifiable.
  mkdirSync(join(base, ".gsd", "gsd.db"), { recursive: true });

  const read = readPendingWriteGateState(base);
  assert.equal(read.gateId, null);
  assert.match(read.readError ?? "", /could not be opened/);
});

test("readPendingWriteGateState reports an inaccessible database file as a read error", (t) => {
  if (process.platform === "win32") return; // chmod-based: POSIX-only fixture
  if (typeof process.getuid === "function" && process.getuid() === 0) return; // root ignores modes
  const base = makeProject();
  const gsdDir = join(base, ".gsd");
  const dbPath = join(gsdDir, "gsd.db");
  t.after(() => {
    chmodSync(gsdDir, 0o755);
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });

  // existsSync returns false when the .gsd directory cannot be traversed, so
  // the reader would otherwise report a quiet "no gate" for a project whose
  // gate state is merely unreadable.
  openDatabase(dbPath);
  setPendingGate("depth_verification_M004_confirm", base);
  closeDatabase();
  chmodSync(gsdDir, 0o000);

  const read = readPendingWriteGateState(base);
  assert.equal(read.gateId, null);
  assert.match(read.readError ?? "", /not accessible/);
});

test("applyPendingGateBlock reclassifies a successful workflow run parked on a gate", () => {
  const verdict = applyPendingGateBlock({
    blocked: false,
    exitCode: EXIT_SUCCESS,
    pendingGateId: "depth_verification_M001_confirm",
    isWorkflowRun: true,
  });
  assert.deepEqual(verdict, { blocked: true, exitCode: EXIT_BLOCKED });
});

test("applyPendingGateBlock keeps the outcome of non-workflow, blocked, or failing runs", () => {
  assert.equal(
    applyPendingGateBlock({
      blocked: false,
      exitCode: EXIT_SUCCESS,
      pendingGateId: "depth_verification_M001_confirm",
      isWorkflowRun: false,
    }),
    null,
    "quick commands never report a workflow gate park",
  );
  assert.equal(
    applyPendingGateBlock({
      blocked: true,
      exitCode: EXIT_SUCCESS,
      pendingGateId: "depth_verification_M001_confirm",
      isWorkflowRun: true,
    }),
    null,
    "a run already classified blocked keeps that classification",
  );
  assert.equal(
    applyPendingGateBlock({
      blocked: false,
      exitCode: 1,
      pendingGateId: "depth_verification_M001_confirm",
      isWorkflowRun: true,
    }),
    null,
    "a failing run keeps its error exit",
  );
  assert.equal(
    applyPendingGateBlock({
      blocked: false,
      exitCode: EXIT_SUCCESS,
      pendingGateId: null,
      isWorkflowRun: true,
    }),
    null,
    "no pending gate — the run keeps its success",
  );
});
