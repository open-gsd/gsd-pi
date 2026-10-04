// Project/App: gsd-pi
// File Purpose: ADR-046 gate G1 for runtime control files. Deleting .gsd/runtime,
// .gsd/journal, hook-state.json and auto.lock between units must not change the
// retry budget, the harness-abort tool block, a hook unit outcome or a pending
// gate block. A file or journal line written by hand must not create one.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { autoSession } from "../auto-runtime-state.ts";
import { recoverTimedOutUnit } from "../auto-timeout-recovery.ts";
import { invalidateAllCaches } from "../cache.ts";
import {
  closeDatabase,
  getPendingGates,
  insertGateRow,
  insertMilestone,
  insertSlice,
  openDatabase,
} from "../gsd-db.ts";
import { getDatabaseReplacementPaths } from "../database-replacement-paths.ts";
import {
  deleteUatRetryCounter,
  getUatRetryAttempts,
  incrementUatRetryAttempts,
  readHookStateJson,
  writeHookStateJson,
} from "../db/writers/runtime-control.ts";
import { emitCrashRecoveredUnitEnd } from "../crash-recovery.ts";
import { emitJournalEvent } from "../journal.ts";
import {
  checkPostUnitHooks,
  consumeGateBlock,
  consumeHookFailure,
  isGateBlockPending,
  isRetryPending,
  peekRetryTrigger,
  persistHookState,
  reconcileRestoredGateBlock,
  resetHookState,
  resolveHookArtifactPath,
  restoreHookState,
} from "../post-unit-hooks.ts";
import { hookStateScope } from "../rule-registry.ts";
import { executeSaveGateResult } from "../tools/workflow-tool-executors.ts";
import {
  clearUnitRuntimeRecord,
  listUnitRuntimeRecords,
  readUnitRuntimeRecord,
  recordUnitEnd,
  recordUnitHarnessAbort,
  writeUnitRuntimeRecord,
} from "../unit-runtime.ts";
import { _selfHealRuntimeRecordsForTest } from "../guided-flow.ts";

function makeProject(t: TestContext, preferences = ""): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-runtime-control-gate-"));
  const home = mkdtempSync(join(tmpdir(), "gsd-runtime-control-home-"));
  const previousHome = process.env.GSD_HOME;
  process.env.GSD_HOME = home;
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  if (preferences) writeFileSync(join(base, ".gsd", "PREFERENCES.md"), preferences, "utf-8");
  invalidateAllCaches();
  resetHookState();
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "active" });
  t.after(() => {
    closeDatabase();
    autoSession.reset();
    resetHookState();
    if (previousHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = previousHome;
    invalidateAllCaches();
    rmSync(base, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
  return base;
}

/** What a crash, a cleanup or an agent can remove between two units. */
function deleteRuntimeControlFiles(base: string): void {
  for (const name of ["runtime", "journal", "hook-state.json", "auto.lock"]) {
    rmSync(join(base, ".gsd", name), { recursive: true, force: true });
  }
}

/** One hard-timeout recovery in a fresh process: the in-memory counter is empty. */
async function recoverPlanSlice(base: string, startedAt: number): Promise<{ result: string; steering: number }> {
  const messages: unknown[] = [];
  const result = await recoverTimedOutUnit(
    { ui: { notify: () => {} } } as any,
    { sendMessage: (message: unknown) => { messages.push(message); } } as any,
    "plan-slice",
    "M001/S01",
    "hard",
    { basePath: base, verbose: false, currentUnitStartedAt: startedAt, unitRecoveryCount: new Map() },
  );
  return { result, steering: messages.length };
}

test("G1: the timeout retry budget is unchanged after the runtime files are deleted", async (t) => {
  const base = makeProject(t);
  const startedAt = Date.now();

  // A runtime file that claims the budget is spent must not spend it.
  mkdirSync(join(base, ".gsd", "runtime", "units"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "runtime", "units", "plan-slice-M001-S01.json"),
    JSON.stringify({ version: 1, unitType: "plan-slice", unitId: "M001/S01", startedAt, phase: "recovered", recoveryAttempts: 9 }),
    "utf-8",
  );

  const first = await recoverPlanSlice(base, startedAt);
  assert.deepEqual(first, { result: "recovered", steering: 1 }, "the first hard timeout gets its one steering retry");

  deleteRuntimeControlFiles(base);

  const second = await recoverPlanSlice(base, startedAt);
  assert.deepEqual(
    second,
    { result: "paused", steering: 0 },
    "the retry is already spent: deleting the runtime files must not grant a second one",
  );
});

test("G1: the harness-abort tool block is unchanged after the runtime files are deleted", async (t) => {
  const base = makeProject(t);
  const startedAt = Date.now();
  insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q3", scope: "slice" });
  autoSession.reset();
  autoSession.active = true;
  autoSession.basePath = base;
  autoSession.setCurrentUnit({ type: "gate-evaluate", id: "M001/S01/gates+Q3", startedAt, workspaceRoot: base });
  recordUnitHarnessAbort(base, "gate-evaluate", "M001/S01/gates+Q3", startedAt, {
    kind: "tool-loop-guard",
    reason: "Tool loop detected.",
    toolName: "browser_click",
    count: 7,
  });

  deleteRuntimeControlFiles(base);

  const result = await executeSaveGateResult(
    { milestoneId: "M001", sliceId: "S01", gateId: "Q3", verdict: "pass", rationale: "looks fine" },
    base,
  );

  assert.equal(result.isError, true);
  assert.equal(result.details.error, "harness_aborted_needs_retry");
  assert.equal(result.details.harnessAbortKind, "tool-loop-guard");
  assert.deepEqual(
    getPendingGates("M001", "S01").map((gate) => gate.gate_id),
    ["Q3"],
    "the gate stays pending for the rerun",
  );
});

const REVIEW_HOOKS = [
  "---",
  "version: 1",
  "post_unit_hooks:",
  "  - name: review-arbiter",
  "    after: [plan-slice]",
  "    prompt: Review {sliceId}",
  "    artifact: REVIEW.md",
  "    max_cycles: 1",
  "  - name: follow-up-review",
  "    after: [plan-slice]",
  "    prompt: Follow-up review {sliceId}",
  "---",
  "",
].join("\n");

test("G1: a failed hook unit stays failed after its files are deleted, and a journal line cannot pass it", (t) => {
  const base = makeProject(t, REVIEW_HOOKS);
  const unitId = "M001/S01";

  assert.equal(checkPostUnitHooks("plan-slice", unitId, base)?.hookName, "review-arbiter");
  // The hook unit is dispatched, then cancelled by a provider error.
  writeUnitRuntimeRecord(base, "hook/review-arbiter", unitId, 1, { phase: "dispatched" });
  recordUnitEnd(base, "hook/review-arbiter", unitId, {
    status: "cancelled",
    artifactVerified: false,
    error: "Provider error",
  });

  deleteRuntimeControlFiles(base);
  // The guided-flow self-heal clears stale unit records; the hook outcome must stay.
  writeUnitRuntimeRecord(base, "plan-slice", unitId, 1, { phase: "dispatched" });
  assert.deepEqual(
    _selfHealRuntimeRecordsForTest(base, { ui: { notify: () => {} } } as any),
    { cleared: 1 },
    "self-heal clears the stale plan-slice record only",
  );

  // The hook left a partial artifact, and the journal now says it completed.
  writeFileSync(resolveHookArtifactPath(base, unitId, "REVIEW.md"), "partial review output", "utf-8");
  emitJournalEvent(base, {
    ts: new Date().toISOString(),
    flowId: "flow-injected",
    seq: 1,
    eventType: "unit-end",
    data: { unitType: "hook/review-arbiter", unitId, status: "completed", artifactVerified: true },
  });

  assert.equal(
    checkPostUnitHooks("hook/review-arbiter", unitId, base),
    null,
    "a failed hook must not let the next hook run",
  );
  const failure = consumeHookFailure();
  assert.equal(failure?.hookName, "review-arbiter");
  assert.match(failure?.reason ?? "", /status cancelled/);
});

test("G1: a hook unit with no database outcome is not failed by a journal line", (t) => {
  const base = makeProject(t, REVIEW_HOOKS);
  const unitId = "M001/S01";

  assert.equal(checkPostUnitHooks("plan-slice", unitId, base)?.hookName, "review-arbiter");
  emitJournalEvent(base, {
    ts: new Date().toISOString(),
    flowId: "flow-injected",
    seq: 1,
    eventType: "unit-end",
    data: { unitType: "hook/review-arbiter", unitId, status: "cancelled", artifactVerified: false },
  });

  assert.equal(
    checkPostUnitHooks("hook/review-arbiter", unitId, base)?.hookName,
    "follow-up-review",
    "the journal line is not an outcome, so the hook queue continues",
  );
  assert.equal(consumeHookFailure(), null);
});

const BLOCKING_GATE = [
  "---",
  "version: 1",
  "post_unit_hooks:",
  "  - name: security-review",
  "    after: [plan-slice]",
  "    prompt: Review security",
  "    artifact: SECURITY-REVIEW.md",
  "    criticality: blocking",
  "---",
  "",
].join("\n");

test("G1: a pending gate block is unchanged after hook-state.json is deleted", (t) => {
  const base = makeProject(t, BLOCKING_GATE);
  const unitId = "M001/S01";

  // The gate hook runs once and leaves an artifact with no verdict: the gate blocks.
  writeFileSync(resolveHookArtifactPath(base, unitId, "SECURITY-REVIEW.md"), "partial output", "utf-8");
  assert.equal(checkPostUnitHooks("plan-slice", unitId, base)?.unitType, "hook/security-review");
  assert.equal(checkPostUnitHooks("hook/security-review", unitId, base), null);
  assert.equal(isGateBlockPending(), true);
  persistHookState(base);

  deleteRuntimeControlFiles(base);

  // A new process restores the block from the database.
  resetHookState();
  assert.equal(isGateBlockPending(), false);
  restoreHookState(base);

  const block = consumeGateBlock();
  assert.equal(block?.hookName, "security-review");
  assert.equal(block?.triggerUnitId, unitId);
});

test("a hook-state.json from an older build with no hook state row restores nothing", (t) => {
  const base = makeProject(t, BLOCKING_GATE);
  const unitId = "M001/S01";
  writeFileSync(join(base, ".gsd", "hook-state.json"), JSON.stringify({
    cycleCounts: { "security-review/plan-slice/M001/S01": 1 },
    redispatchedGateKeys: [],
    activeHook: null,
    hookQueue: [],
    retryPending: true,
    retryTrigger: { unitType: "plan-slice", unitId },
    gateBlockPending: { hookName: "security-review", triggerUnitType: "plan-slice", triggerUnitId: unitId },
    gateBlockQueue: [],
    savedAt: new Date().toISOString(),
  }), "utf-8");

  restoreHookState(base);

  assert.equal(readHookStateJson(hookStateScope(base)), null, "the file is not stored as the hook state row");
  assert.equal(isGateBlockPending(), false, "the file creates no gate block");
  assert.equal(isRetryPending(), false, "the file creates no retry");
  assert.equal(peekRetryTrigger(), null);
  const sidecarQueue: Array<{ unitType: string }> = [];
  reconcileRestoredGateBlock(base, sidecarQueue as any);
  assert.deepEqual(sidecarQueue, [], "no gate hook is re-armed");
  // The first hook cycle is not counted as already spent.
  persistHookState(base);
  assert.deepEqual(JSON.parse(readHookStateJson(hookStateScope(base))!).cycleCounts, {});
});

test("/gsd at the project root keeps the record of a unit that auto-mode runs in a worktree", (t) => {
  const base = makeProject(t);
  const worktree = join(base, ".gsd", "worktrees", "M001");
  mkdirSync(worktree, { recursive: true });
  const unitId = "M001/S01/T01";

  // Terminal 1: auto-mode runs execute-task in the worktree. One timeout
  // recovery is spent and the harness aborted the turn.
  writeUnitRuntimeRecord(worktree, "execute-task", unitId, 1, { phase: "dispatched", recoveryAttempts: 1 });
  recordUnitHarnessAbort(worktree, "execute-task", unitId, 1, { kind: "tool-loop-guard", reason: "loop" });
  // A stale record of an earlier session at the project root.
  writeUnitRuntimeRecord(base, "plan-slice", "M001/S01", 1, { phase: "dispatched" });

  // Terminal 2: /gsd at the project root runs the self-heal.
  assert.deepEqual(
    _selfHealRuntimeRecordsForTest(base, { ui: { notify: () => {} } } as any),
    { cleared: 1 },
    "self-heal clears the project-root record only",
  );

  const live = readUnitRuntimeRecord(worktree, "execute-task", unitId);
  assert.equal(live?.phase, "dispatched", "the idle watchdog still has its record");
  assert.equal(live?.recoveryAttempts, 1, "the recovery budget is not reset");
  assert.equal(live?.harnessAbort?.kind, "tool-loop-guard", "the harness abort still blocks result-save tools");
  assert.deepEqual(listUnitRuntimeRecords(worktree).map((record) => record.unitId), [unitId]);
  assert.deepEqual(listUnitRuntimeRecords(base), []);
  assert.equal(readUnitRuntimeRecord(base, "execute-task", unitId), null, "the project root does not read the worktree record");
});

test("crash recovery at the project root records the outcome of a unit that ran in a worktree", (t) => {
  const base = makeProject(t);
  const worktree = join(base, ".gsd", "worktrees", "M001");
  mkdirSync(worktree, { recursive: true });
  writeUnitRuntimeRecord(worktree, "hook/review-arbiter", "M001/S01", 1, { phase: "dispatched" });

  emitCrashRecoveredUnitEnd(base, { unitType: "hook/review-arbiter", unitId: "M001/S01" } as any);

  assert.deepEqual(
    readUnitRuntimeRecord(worktree, "hook/review-arbiter", "M001/S01")?.unitEnd,
    { status: "crash-recovered", artifactVerified: false },
  );
  assert.deepEqual(listUnitRuntimeRecords(base), [], "no record is created at the project root");
});

test("the database replacement fence rejects every runtime-control write", (t) => {
  const base = makeProject(t);
  const unitId = "M001/S01/T01";
  const scope = hookStateScope(base);
  writeUnitRuntimeRecord(base, "execute-task", unitId, 1, { phase: "dispatched" });
  assert.equal(incrementUatRetryAttempts("M001", "S01"), 1);
  writeHookStateJson(scope, JSON.stringify({
    cycleCounts: {},
    retryPending: true,
    retryTrigger: { unitType: "execute-task", unitId },
  }));
  restoreHookState(base);
  assert.equal(isRetryPending(), true);
  const storedBefore = readHookStateJson(scope);

  // An import or restore is replacing the database: a write accepted now is lost.
  const replacement = getDatabaseReplacementPaths(join(base, ".gsd", "gsd.db"));
  mkdirSync(replacement.recoveryDirectory);
  writeFileSync(replacement.activeIntentPath, "{}");
  try {
    const fenced = /Database writes are fenced while replacement intent exists/;
    assert.throws(() => persistHookState(base), fenced, "a pending retry must not be reported as persisted");
    assert.throws(() => clearUnitRuntimeRecord(base, "execute-task", unitId), fenced);
    assert.throws(() => deleteUatRetryCounter("M001", "S01"), fenced);
  } finally {
    rmSync(replacement.recoveryDirectory, { recursive: true, force: true });
  }

  assert.equal(readHookStateJson(scope), storedBefore, "the fenced hook state write stored nothing");
  assert.equal(readUnitRuntimeRecord(base, "execute-task", unitId)?.phase, "dispatched", "the fenced delete kept the unit row");
  assert.equal(getUatRetryAttempts("M001", "S01"), 1, "the fenced delete kept the retry counter");
});
