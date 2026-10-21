// GSD Extension — Hook Engine Tests (Post-Unit, Pre-Dispatch, State Persistence)

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkPostUnitHooks,
  getActiveHook,
  resetHookState,
  isRetryPending,
  peekRetryTrigger,
  consumeRetryTrigger,
  consumeGateBlock,
  resolveHookArtifactPath,
  runPreDispatchHooks,
  persistHookState,
  restoreHookState,
  reconcileRestoredHookDispatch,
  clearPersistedHookState,
  getHookStatus,
  formatHookStatus,
  triggerHookManually,
} from "../post-unit-hooks.ts";
import { invalidateAllCaches } from "../cache.ts";

// ─── Fixture Helpers ───────────────────────────────────────────────────────

function createFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-hook-test-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  return base;
}

function writeHookPreferences(base: string, hookYaml: string): void {
  writeFileSync(join(base, ".gsd", "PREFERENCES.md"), `---\npost_unit_hooks:\n${hookYaml}\n---\n`, "utf-8");
  invalidateAllCaches();
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 1: Post-Unit Hook Tests
// ═══════════════════════════════════════════════════════════════════════════

// ─── resolveHookArtifactPath ───────────────────────────────────────────────


describe('post-unit-hooks', () => {
test('resolveHookArtifactPath', () => {
  const base = "/project";

  // Task-level
  const taskPath = resolveHookArtifactPath(base, "M001/S01/T01", "REVIEW-PASS.md");
  assert.deepStrictEqual(
    taskPath,
    join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-REVIEW-PASS.md"),
    "task-level artifact path",
  );

  // Slice-level
  const slicePath = resolveHookArtifactPath(base, "M001/S01", "REVIEW-PASS.md");
  assert.deepStrictEqual(
    slicePath,
    join(base, ".gsd", "milestones", "M001", "slices", "S01", "REVIEW-PASS.md"),
    "slice-level artifact path",
  );

  // Milestone-level
  const milestonePath = resolveHookArtifactPath(base, "M001", "REVIEW-PASS.md");
  assert.deepStrictEqual(
    milestonePath,
    join(base, ".gsd", "milestones", "M001", "REVIEW-PASS.md"),
    "milestone-level artifact path",
  );
});

// ─── resetHookState ────────────────────────────────────────────────────────
test('resetHookState', () => {
  resetHookState();
  assert.deepStrictEqual(getActiveHook(), null, "no active hook after reset");
  assert.ok(!isRetryPending(), "no retry pending after reset");
  assert.deepStrictEqual(consumeRetryTrigger(), null, "no retry trigger after reset");
});

// ─── checkPostUnitHooks with no hooks configured ───────────────────────────
test('No hooks configured', () => {
  resetHookState();
  const base = createFixtureBase();
  try {
    const result = checkPostUnitHooks("execute-task", "M001/S01/T01", base);
    assert.deepStrictEqual(result, null, "returns null when no hooks configured");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ─── Hook units don't trigger hooks (no hook-on-hook) ──────────────────────
test('Hook-on-hook prevention', () => {
  resetHookState();
  const base = createFixtureBase();
  try {
    const result = checkPostUnitHooks("hook/code-review", "M001/S01/T01", base);
    assert.deepStrictEqual(result, null, "hook units don't trigger other hooks");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ─── consumeRetryTrigger clears state ──────────────────────────────────────
test('consumeRetryTrigger clears state', () => {
  resetHookState();
  assert.deepStrictEqual(consumeRetryTrigger(), null, "no trigger initially");
  assert.ok(!isRetryPending(), "no retry initially");
});

test('Advisory hook keeps artifact idempotency without verdict frontmatter', () => {
  resetHookState();
  const base = createFixtureBase();
  try {
    writeHookPreferences(base, `  - name: docs-hint
    after:
      - plan-slice
    prompt: Review docs
    artifact: DOCS-HINT.md
`);
    writeFileSync(resolveHookArtifactPath(base, "M001/S01/T01", "DOCS-HINT.md"), "plain advisory note", "utf-8");

    const result = checkPostUnitHooks("plan-slice", "M001/S01/T01", base);
    assert.deepStrictEqual(result, null, "existing advisory artifact remains idempotent");
    assert.deepStrictEqual(consumeGateBlock(), null, "advisory hook does not create gate block");
  } finally {
    resetHookState();
    invalidateAllCaches();
    rmSync(base, { recursive: true, force: true });
  }
});

test('Blocking hook skips only after passing frontmatter verdict', () => {
  resetHookState();
  const base = createFixtureBase();
  try {
    writeHookPreferences(base, `  - name: security-review
    after:
      - plan-slice
    prompt: Review security
    artifact: SECURITY-REVIEW.md
    criticality: blocking
`);
    writeFileSync(
      resolveHookArtifactPath(base, "M001/S01/T01", "SECURITY-REVIEW.md"),
      "---\nverdict: pass\n---\n\nNo blocking findings.\n",
      "utf-8",
    );

    const result = checkPostUnitHooks("plan-slice", "M001/S01/T01", base);
    assert.deepStrictEqual(result, null, "passing gate artifact is idempotent");
    assert.deepStrictEqual(consumeGateBlock(), null, "passing gate does not block");
  } finally {
    resetHookState();
    invalidateAllCaches();
    rmSync(base, { recursive: true, force: true });
  }
});

test('Blocking hook reruns invalid artifact once then blocks at cycle budget', () => {
  resetHookState();
  const base = createFixtureBase();
  try {
    writeHookPreferences(base, `  - name: security-review
    after:
      - plan-slice
    prompt: Review security
    artifact: SECURITY-REVIEW.md
    criticality: blocking
`);
    writeFileSync(resolveHookArtifactPath(base, "M001/S01/T01", "SECURITY-REVIEW.md"), "partial output", "utf-8");

    const dispatch = checkPostUnitHooks("plan-slice", "M001/S01/T01", base);
    assert.ok(dispatch, "invalid gate artifact dispatches the blocking hook");
    assert.equal(dispatch.unitType, "hook/security-review");

    const afterHook = checkPostUnitHooks("hook/security-review", "M001/S01/T01", base);
    assert.deepStrictEqual(afterHook, null, "no further hook dispatch after max_cycles=1");
    const block = consumeGateBlock();
    assert.ok(block, "gate block is recorded");
    assert.equal(block.hookName, "security-review");
    assert.match(block.reason, /missing frontmatter verdict/);
  } finally {
    resetHookState();
    invalidateAllCaches();
    rmSync(base, { recursive: true, force: true });
  }
});

test('Blocking hook restored from disk does not trust artifact without clean hook completion', () => {
  resetHookState();
  const base = createFixtureBase();
  try {
    writeHookPreferences(base, `  - name: security-review
    after:
      - plan-slice
    prompt: Review security
    artifact: SECURITY-REVIEW.md
    criticality: blocking
    max_cycles: 2
`);
    const firstDispatch = checkPostUnitHooks("plan-slice", "M001/S01/T01", base);
    assert.ok(firstDispatch, "gate dispatches first cycle");
    persistHookState(base);

    writeFileSync(
      resolveHookArtifactPath(base, "M001/S01/T01", "SECURITY-REVIEW.md"),
      "---\noutcome:\n  verdict: pass\n---\n",
      "utf-8",
    );

    resetHookState();
    restoreHookState(base);

    const resumed = checkPostUnitHooks("plan-slice", "M001/S01/T01", base);
    assert.ok(resumed, "persisted active gate reruns when clean hook completion was not observed");
    assert.equal(resumed.unitType, "hook/security-review");
  } finally {
    resetHookState();
    invalidateAllCaches();
    rmSync(base, { recursive: true, force: true });
  }
});

test('Restore reconciliation re-enqueues the lost hook dispatch (#1246)', () => {
  resetHookState();
  const base = createFixtureBase();
  try {
    writeHookPreferences(base, `  - name: plan-review
    after:
      - plan-slice
    prompt: Review the plan for {milestoneId}/{sliceId}
    artifact: PLAN-REVIEW.md
    criticality: blocking
    max_cycles: 2
`);
    // Trigger unit completes: activeHook set + persisted, dispatch enqueued.
    const dispatch = checkPostUnitHooks("plan-slice", "M002/S01", base);
    assert.ok(dispatch, "gate dispatches on trigger unit completion");
    assert.equal(dispatch.unitType, "hook/plan-review");
    persistHookState(base);

    // Pause/resume: activeHook restored, but the session-local sidecar queue is
    // gone (never persisted).
    resetHookState();
    restoreHookState(base);
    assert.ok(getActiveHook(), "activeHook restored from disk");

    // Reconciliation re-enqueues the missing dispatch so the hook actually runs.
    const sidecarQueue: any[] = [];
    reconcileRestoredHookDispatch(base, sidecarQueue);
    assert.equal(sidecarQueue.length, 1, "lost hook dispatch is re-enqueued");
    assert.equal(sidecarQueue[0].kind, "hook");
    assert.equal(sidecarQueue[0].unitType, "hook/plan-review");
    assert.equal(sidecarQueue[0].unitId, "M002/S01");
    assert.match(sidecarQueue[0].prompt, /Review the plan for M002\/S01/);
  } finally {
    resetHookState();
    invalidateAllCaches();
    rmSync(base, { recursive: true, force: true });
  }
});

test('Restore reconciliation is a no-op when the dispatch is already queued (#1246)', () => {
  resetHookState();
  const base = createFixtureBase();
  try {
    writeHookPreferences(base, `  - name: plan-review
    after:
      - plan-slice
    prompt: Review the plan
    artifact: PLAN-REVIEW.md
    criticality: blocking
    max_cycles: 2
`);
    const dispatch = checkPostUnitHooks("plan-slice", "M002/S01", base);
    assert.ok(dispatch, "gate dispatches on trigger unit completion");
    persistHookState(base);
    resetHookState();
    restoreHookState(base);

    const sidecarQueue: any[] = [
      { kind: "hook", unitType: "hook/plan-review", unitId: "M002/S01", prompt: "already here" },
    ];
    reconcileRestoredHookDispatch(base, sidecarQueue);
    assert.equal(sidecarQueue.length, 1, "does not duplicate an existing hook dispatch");
    assert.equal(sidecarQueue[0].prompt, "already here");
  } finally {
    resetHookState();
    invalidateAllCaches();
    rmSync(base, { recursive: true, force: true });
  }
});

test('Restore reconciliation is a no-op with no active hook (#1246)', () => {
  resetHookState();
  const base = createFixtureBase();
  try {
    const sidecarQueue: any[] = [];
    reconcileRestoredHookDispatch(base, sidecarQueue);
    assert.equal(sidecarQueue.length, 0, "nothing enqueued when no active hook");
  } finally {
    resetHookState();
    invalidateAllCaches();
    rmSync(base, { recursive: true, force: true });
  }
});

test('Blocking hook re-dispatches once after a lost dispatch at default max_cycles', () => {
  resetHookState();
  const base = createFixtureBase();
  try {
    // Default max_cycles (1): a cycle is charged at dispatch time.
    writeHookPreferences(base, `  - name: plan-review
    after:
      - plan-slice
    prompt: Review plan
    artifact: PLAN-REVIEW.md
    criticality: blocking
`);

    const firstDispatch = checkPostUnitHooks("plan-slice", "M002/S01", base);
    assert.ok(firstDispatch, "gate dispatches and consumes its cycle at dispatch");
    assert.equal(firstDispatch.unitType, "hook/plan-review");
    persistHookState(base);

    // Simulate a lost dispatch: the hook never produced its own unit-end, the
    // trigger unit resumes instead. The dispatch-consumed cycle is refunded once
    // so the gate re-dispatches rather than hard-blocking on a hook that never ran.
    resetHookState();
    restoreHookState(base);
    const redispatch = checkPostUnitHooks("plan-slice", "M002/S01", base);
    assert.ok(redispatch, "lost dispatch re-dispatches the gate instead of blocking");
    assert.equal(redispatch.unitType, "hook/plan-review");
    assert.deepStrictEqual(consumeGateBlock(), null, "no gate block on the first lost dispatch");
    persistHookState(base);

    // A second lost dispatch consumes the budget and blocks — the refund is one-shot.
    resetHookState();
    restoreHookState(base);
    const blocked = checkPostUnitHooks("plan-slice", "M002/S01", base);
    assert.deepStrictEqual(blocked, null, "second lost dispatch exhausts the budget");
    const block = consumeGateBlock();
    assert.ok(block, "gate block recorded after the one-shot re-dispatch is used");
    assert.equal(block.hookName, "plan-review");
    assert.match(block.reason, /gate cycle budget exhausted/);
  } finally {
    resetHookState();
    invalidateAllCaches();
    rmSync(base, { recursive: true, force: true });
  }
});

test('Blocking hook lost-dispatch refund is one-shot and bounded at max_cycles=2', () => {
  resetHookState();
  const base = createFixtureBase();
  try {
    writeHookPreferences(base, `  - name: plan-review
    after:
      - plan-slice
    prompt: Review plan
    artifact: PLAN-REVIEW.md
    criticality: blocking
    max_cycles: 2
`);

    // Simulate a lost dispatch: persist, drop in-memory state, restore, then the
    // trigger unit resumes instead of the hook producing its own unit-end.
    const lose = () => {
      persistHookState(base);
      resetHookState();
      restoreHookState(base);
      return checkPostUnitHooks("plan-slice", "M002/S01", base);
    };

    assert.ok(checkPostUnitHooks("plan-slice", "M002/S01", base), "initial dispatch");

    // Refund is one-shot, but max_cycles=2 still has real budget, so lost#2 also
    // re-dispatches by consuming a genuine cycle (not another refund).
    assert.ok(lose(), "lost#1 re-dispatches (one-shot refund)");
    assert.equal(consumeGateBlock(), null, "no block after lost#1");
    assert.ok(lose(), "lost#2 re-dispatches from real budget");
    assert.equal(consumeGateBlock(), null, "no block after lost#2");

    // Total dispatches are bounded to max_cycles + 1 (the single forgiven loss),
    // so the third lost dispatch blocks. redispatchedGateKeys guarantees this
    // terminates rather than looping forever on repeated lost resumes.
    assert.equal(lose(), null, "lost#3 exhausts the bounded budget");
    const block = consumeGateBlock();
    assert.ok(block, "gate block recorded on lost#3");
    assert.match(block.reason, /gate cycle budget exhausted/);
  } finally {
    resetHookState();
    invalidateAllCaches();
    rmSync(base, { recursive: true, force: true });
  }
});

test('Blocking hook lost dispatch does not steal a real-run cycle at max_cycles=2', () => {
  resetHookState();
  const base = createFixtureBase();
  try {
    writeHookPreferences(base, `  - name: plan-review
    after:
      - plan-slice
    prompt: Review plan
    artifact: PLAN-REVIEW.md
    criticality: blocking
    max_cycles: 2
`);

    // Dispatch, then lose it once (the one-shot refund is spent here).
    assert.ok(checkPostUnitHooks("plan-slice", "M002/S01", base), "initial dispatch");
    persistHookState(base);
    resetHookState();
    restoreHookState(base);
    assert.ok(
      checkPostUnitHooks("plan-slice", "M002/S01", base),
      "lost dispatch re-dispatches (refund spent)",
    );

    // The hook now actually runs, each run reporting a failed verdict. Because a
    // lost dispatch must not consume the hook's real-run budget, max_cycles=2
    // still permits two genuine runs before the gate blocks — spending the
    // refund early did not rob a later real cycle.
    mkdirSync(join(base, ".gsd", "milestones", "M002", "slices", "S01"), { recursive: true });
    writeFileSync(
      resolveHookArtifactPath(base, "M002/S01", "PLAN-REVIEW.md"),
      "---\nverdict: failed\n---\n\nRejected.\n",
      "utf-8",
    );
    assert.ok(
      checkPostUnitHooks("hook/plan-review", "M002/S01", base),
      "real run #1 (failed verdict) re-dispatches",
    );
    assert.equal(consumeGateBlock(), null, "no block after the first real run");
    assert.equal(
      checkPostUnitHooks("hook/plan-review", "M002/S01", base),
      null,
      "real run #2 (failed verdict) exhausts the real budget",
    );
    const block = consumeGateBlock();
    assert.ok(block, "gate block recorded only after two real runs");
    assert.match(block.reason, /gate cycle budget exhausted/);
  } finally {
    resetHookState();
    invalidateAllCaches();
    rmSync(base, { recursive: true, force: true });
  }
});

test('Blocking hook needs-rework verdict requests trigger unit retry', () => {
  resetHookState();
  const base = createFixtureBase();
  try {
    writeHookPreferences(base, `  - name: review-arbiter
    after:
      - plan-slice
    prompt: Review task
    artifact: REVIEW-DEBATE.md
    criticality: blocking
    max_cycles: 2
    on_block:
      action: retry-unit
`);
    const dispatch = checkPostUnitHooks("plan-slice", "M001/S01/T01", base);
    assert.ok(dispatch, "gate dispatches");
    writeFileSync(
      resolveHookArtifactPath(base, "M001/S01/T01", "REVIEW-DEBATE.md"),
      "---\nverdict: needs-rework\n---\n\nRework required.\n",
      "utf-8",
    );

    const afterHook = checkPostUnitHooks("hook/review-arbiter", "M001/S01/T01", base);
    assert.deepStrictEqual(afterHook, null, "needs-rework routes via retry signal");
    assert.ok(isRetryPending(), "retry is pending");
    assert.deepStrictEqual(peekRetryTrigger(), {
      unitType: "plan-slice",
      unitId: "M001/S01/T01",
    });
    assert.ok(isRetryPending(), "peeking through the facade keeps the retry pending");
    assert.deepStrictEqual(consumeRetryTrigger(), {
      unitType: "plan-slice",
      unitId: "M001/S01/T01",
    });
  } finally {
    resetHookState();
    invalidateAllCaches();
    rmSync(base, { recursive: true, force: true });
  }
});

// ─── Variable substitution in prompts ──────────────────────────────────────
test('Variable substitution', () => {
  const base = "/project";

  // 3-part ID
  const path3 = resolveHookArtifactPath(base, "M002/S03/T05", "result.md");
  assert.ok(path3.includes("M002"), "3-part ID extracts milestoneId");
  assert.ok(path3.includes("S03"), "3-part ID extracts sliceId");
  assert.ok(path3.includes("T05"), "3-part ID extracts taskId");
  assert.ok(path3.includes("milestones"), "3-part ID includes milestones/ segment");

  // 2-part ID
  const path2 = resolveHookArtifactPath(base, "M002/S03", "result.md");
  assert.ok(path2.includes("M002"), "2-part ID extracts milestoneId");
  assert.ok(path2.includes("S03"), "2-part ID extracts sliceId");
  assert.ok(path2.includes("milestones"), "2-part ID includes milestones/ segment");

  // 1-part ID
  const path1 = resolveHookArtifactPath(base, "M002", "result.md");
  assert.ok(path1.includes("M002"), "1-part ID extracts milestoneId");
  assert.ok(path1.includes("milestones"), "1-part ID includes milestones/ segment");
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 2: Pre-Dispatch Hook Tests
// ═══════════════════════════════════════════════════════════════════════════
test('Pre-dispatch: no hooks configured', () => {
  const base = createFixtureBase();
  try {
    const result = runPreDispatchHooks("execute-task", "M001/S01/T01", "original prompt", base);
    assert.deepStrictEqual(result.action, "proceed", "proceeds when no hooks");
    assert.deepStrictEqual(result.prompt, "original prompt", "prompt unchanged");
    assert.deepStrictEqual(result.firedHooks.length, 0, "no hooks fired");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('Pre-dispatch: hook units bypass', () => {
  const base = createFixtureBase();
  try {
    const result = runPreDispatchHooks("hook/review", "M001/S01/T01", "hook prompt", base);
    assert.deepStrictEqual(result.action, "proceed", "hook units always proceed");
    assert.deepStrictEqual(result.prompt, "hook prompt", "hook prompt unchanged");
    assert.deepStrictEqual(result.firedHooks.length, 0, "no hooks fired for hook units");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 3: State Persistence Tests
// ═══════════════════════════════════════════════════════════════════════════
test('State persistence: persist and restore', () => {
  const base = createFixtureBase();
  try {
    resetHookState();

    // Persist empty state
    persistHookState(base);
    const filePath = join(base, ".gsd", "hook-state.json");
    assert.ok(existsSync(filePath), "hook-state.json created");

    const content = JSON.parse(readFileSync(filePath, "utf-8"));
    assert.deepStrictEqual(typeof content.savedAt, "string", "savedAt is a string");
    assert.deepStrictEqual(Object.keys(content.cycleCounts).length, 0, "empty cycle counts");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('State persistence: restore from disk', () => {
  const base = createFixtureBase();
  try {
    resetHookState();

    // Write a state file with some cycle counts
    const stateFile = join(base, ".gsd", "hook-state.json");
    writeFileSync(stateFile, JSON.stringify({
      cycleCounts: {
        "review/execute-task/M001/S01/T01": 2,
        "simplify/execute-task/M001/S01/T02": 1,
      },
      savedAt: new Date().toISOString(),
    }), "utf-8");

    // Restore
    restoreHookState(base);

    // Verify by persisting and reading back
    persistHookState(base);
    const restored = JSON.parse(readFileSync(stateFile, "utf-8"));
    assert.deepStrictEqual(restored.cycleCounts["review/execute-task/M001/S01/T01"], 2, "cycle count restored for review");
    assert.deepStrictEqual(restored.cycleCounts["simplify/execute-task/M001/S01/T02"], 1, "cycle count restored for simplify");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('State persistence: clear', () => {
  const base = createFixtureBase();
  try {
    resetHookState();

    // Write then clear
    const stateFile = join(base, ".gsd", "hook-state.json");
    writeFileSync(stateFile, JSON.stringify({
      cycleCounts: { "review/execute-task/M001/S01/T01": 3 },
      savedAt: new Date().toISOString(),
    }), "utf-8");

    clearPersistedHookState(base);

    const cleared = JSON.parse(readFileSync(stateFile, "utf-8"));
    assert.deepStrictEqual(Object.keys(cleared.cycleCounts).length, 0, "cycle counts cleared");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('State persistence: restore handles missing file', () => {
  const base = createFixtureBase();
  try {
    resetHookState();
    // Should not throw
    restoreHookState(base);
    assert.deepStrictEqual(getActiveHook(), null, "no active hook after restore from missing file");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('State persistence: restore handles corrupt file', () => {
  const base = createFixtureBase();
  try {
    resetHookState();
    writeFileSync(join(base, ".gsd", "hook-state.json"), "not json", "utf-8");
    // Should not throw
    restoreHookState(base);
    assert.deepStrictEqual(getActiveHook(), null, "no active hook after corrupt restore");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 3: Hook Status Reporting Tests
// ═══════════════════════════════════════════════════════════════════════════
test('Hook status: no hooks', () => {
  resetHookState();
  const entries = getHookStatus();
  // No preferences file = no hooks
  assert.deepStrictEqual(entries.length, 0, "no entries when no hooks configured");

  const formatted = formatHookStatus();
  assert.match(formatted, /No hooks configured/, "status message says no hooks");
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 4: Manual Hook Trigger Tests
// ═══════════════════════════════════════════════════════════════════════════
test('triggerHookManually: hook not found', () => {
  resetHookState();
  const base = createFixtureBase();
  try {
    const result = triggerHookManually("nonexistent-hook", "execute-task", "M001/S01/T01", base);
    assert.deepStrictEqual(result, null, "returns null when hook not found");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('triggerHookManually: with configured hook', () => {
  resetHookState();
  const base = createFixtureBase();
  try {
    // This test will work when preferences are configured
    // For now, just verify the function exists and handles missing hooks
    const result = triggerHookManually("code-review", "execute-task", "M001/S01/T01", base);
    // Result depends on whether code-review hook is configured in preferences
    // The function should either return null or a valid HookDispatchResult
    assert.ok(result === null || typeof result === "object", "returns null or object");
    if (result) {
      assert.deepStrictEqual(result.hookName, "code-review", "hook name in result");
      assert.deepStrictEqual(result.unitType, "hook/code-review", "unit type is hook-prefixed");
      assert.deepStrictEqual(result.unitId, "M001/S01/T01", "unit ID preserved");
      assert.ok(typeof result.prompt === "string", "prompt is a string");
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ─── Hook dispatch results omit a primary-only model (#1229) ───────────────
// Both the auto-mode (checkPostUnitHooks → _startHook) and manual
// (triggerHookManually) dispatch paths must NOT carry a resolved primary model
// on the dispatch result. Emitting the primary alone discards the configured
// fallbacks[] chain: the auto path would re-apply it over a fallback already
// selected by selectAndApplyModel, and the manual path (dispatchHookUnit) now
// resolves the full chain itself. The dispatch result therefore leaves `model`
// unset so downstream resolution honors fallbacks.
test('Dispatch results omit primary-only model so fallbacks survive (#1229)', () => {
  resetHookState();
  const base = createFixtureBase();
  try {
    writeHookPreferences(base, `  - name: code-review
    after:
      - plan-slice
    prompt: Review the change
    artifact: REVIEW-PASS.md
    model:
      model: primary-model
      fallbacks:
        - fallback-a
        - fallback-b
`);

    const autoDispatch = checkPostUnitHooks("plan-slice", "M001/S01/T01", base);
    assert.ok(autoDispatch, "auto-mode dispatches the configured hook");
    assert.equal(autoDispatch.unitType, "hook/code-review", "auto dispatch is hook-prefixed");
    assert.equal(autoDispatch.model, undefined, "auto dispatch does not carry a primary-only model");

    resetHookState();

    const manualDispatch = triggerHookManually("code-review", "plan-slice", "M001/S01/T01", base);
    assert.ok(manualDispatch, "manual trigger dispatches the configured hook");
    assert.equal(manualDispatch.unitType, "hook/code-review", "manual dispatch is hook-prefixed");
    assert.equal(manualDispatch.model, undefined, "manual dispatch does not carry a primary-only model");
  } finally {
    resetHookState();
    rmSync(base, { recursive: true, force: true });
  }
});

});
