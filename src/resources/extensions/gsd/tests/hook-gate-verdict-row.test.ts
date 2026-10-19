// gsd-pi + The post-unit hook gate verdict is a database row (P18d)
//
// The owner default: a gate's outcome arrives as a tool call that writes a
// database row; the hook's artifact file is a render for the operator. These
// tests prove the row replaced the file: recording the verdict through the
// save executor routes the gate, deleting the artifact file changes nothing,
// an unrecorded gate fails loud with the tool named, an unknown recorded
// verdict fails loud, and a re-dispatch invalidates the previous attempt's
// row so a hook that never records cannot inherit its verdict.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { closeDatabase, insertMilestone, insertSlice, openDatabase } from "../gsd-db.ts";
import { invalidateAllCaches } from "../cache.ts";
import { executeHookVerdictSave } from "../tools/workflow-tool-executors.ts";
import { getHookGateVerdict, hookGateVerdictPath } from "../db/hook-verdicts.ts";
import { getDbOrNull } from "../db/engine.ts";
import {
  checkPostUnitHooks,
  consumeGateBlock,
  resetHookState,
  resolveHookArtifactPath,
} from "../post-unit-hooks.ts";
import { internalPlanningInvocation } from "../planning-invocation.ts";

function writeHookPreferences(base: string, hookYaml: string): void {
  writeFileSync(join(base, ".gsd", "PREFERENCES.md"), `---\npost_unit_hooks:\n${hookYaml}\n---\n`, "utf-8");
  invalidateAllCaches();
}

function openFixture(hookYaml: string): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-hook-verdict-row-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  closeDatabase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice" });
  writeHookPreferences(base, hookYaml);
  return base;
}

function closeFixture(base: string): void {
  resetHookState();
  invalidateAllCaches();
  closeDatabase();
  rmSync(base, { recursive: true, force: true });
}

test("the tool call writes the verdict row the registry reads", async () => {
  const base = openFixture(
    `  - name: security-review
    after:
      - plan-slice
    prompt: Review security
    artifact: SECURITY-REVIEW.md
    criticality: blocking
`,
  );
  try {
    const result = await executeHookVerdictSave(
      { hookName: "security-review", unitId: "M001/S01/T01", verdict: "pass", rationale: "No blocking findings." },
      base,
      internalPlanningInvocation(),
    );
    assert.equal(result.isError, undefined, "the save succeeds");

    // The row is readable through the canonical seam...
    assert.deepEqual(getHookGateVerdict("security-review", "M001/S01/T01"), {
      verdict: "pass",
      rationale: "No blocking findings.",
    });
    // ...and it lives in the assessments table under the hook-gate scope.
    const row = getDbOrNull()!.prepare(
      "SELECT scope FROM assessments WHERE path = :path",
    ).get({ ":path": hookGateVerdictPath("security-review", "M001/S01/T01") });
    assert.equal(row?.["scope"], "hook-gate");
  } finally {
    closeFixture(base);
  }
});

test("the recorded verdict routes the gate; the artifact file is a render", async () => {
  const base = openFixture(
    `  - name: security-review
    after:
      - plan-slice
    prompt: Review security
    artifact: SECURITY-REVIEW.md
    criticality: blocking
`,
  );
  try {
    // The hook ran and rendered its report...
    const artifactPath = resolveHookArtifactPath(base, "M001/S01/T01", "SECURITY-REVIEW.md");
    writeFileSync(artifactPath, "---\nverdict: pass\n---\n\nFile verdict: pass.\n", "utf-8");
    checkPostUnitHooks("plan-slice", "M001/S01/T01", base);
    resetHookState();

    const saved = await executeHookVerdictSave(
      { hookName: "security-review", unitId: "M001/S01/T01", verdict: "pass", rationale: "Clean." },
      base,
      internalPlanningInvocation(),
    );
    assert.equal(saved.isError, undefined);

    // The existing artifact makes the gate idempotent; the ROW routes it.
    const result = checkPostUnitHooks("plan-slice", "M001/S01/T01", base);
    assert.deepEqual(result, null, "the recorded pass is idempotent despite the file");

    // Flip the recorded verdict WITHOUT touching the file: the routing follows
    // the row, not the render.
    const flipped = await executeHookVerdictSave(
      { hookName: "security-review", unitId: "M001/S01/T01", verdict: "needs-rework", rationale: "Rework requested." },
      base,
      internalPlanningInvocation(),
    );
    assert.equal(flipped.isError, undefined);
    resetHookState();

    const afterFlip = checkPostUnitHooks("plan-slice", "M001/S01/T01", base);
    assert.deepEqual(afterFlip, null, "needs-rework routes as a gate finding, not a fresh dispatch");
    const block = consumeGateBlock();
    assert.ok(block, "the recorded needs-rework gates the trigger");
    assert.equal(block?.verdict, "needs-rework", "the routing followed the row, not the file");
  } finally {
    resetHookState();
  }
});

test("a gate with no recorded verdict reruns and blocks, naming the tool", () => {
  const base = openFixture(
    `  - name: security-review
    after:
      - plan-slice
    prompt: Review security
    artifact: SECURITY-REVIEW.md
    criticality: blocking
`,
  );
  try {
    // The hook rendered a report but never recorded a verdict row.
    writeFileSync(
      resolveHookArtifactPath(base, "M001/S01/T01", "SECURITY-REVIEW.md"),
      "---\nverdict: pass\n---\n\nA file verdict decides nothing.\n",
      "utf-8",
    );

    const result = checkPostUnitHooks("plan-slice", "M001/S01/T01", base);
    assert.ok(result, "the gate re-runs to record its verdict");
    assert.equal(result.unitType, "hook/security-review");

    // Cycle budget spent: the block names the missing verdict, not the file.
    const afterHook = checkPostUnitHooks("hook/security-review", "M001/S01/T01", base);
    assert.deepEqual(afterHook, null);
    const block = consumeGateBlock();
    assert.ok(block, "the gate blocks");
    assert.match(block!.reason ?? "", /no recorded verdict for gate security-review/);
    assert.match(block!.reason ?? "", /gsd_hook_verdict_save/);
  } finally {
    closeFixture(base);
  }
});

test("an unsupported recorded verdict fails loud", async () => {
  const base = openFixture(
    `  - name: security-review
    after:
      - plan-slice
    prompt: Review security
    artifact: SECURITY-REVIEW.md
    criticality: blocking
`,
  );
  try {
    const saved = getHookGateVerdict("security-review", "M001/S01/T01");
    assert.equal(saved, null);
    writeFileSync(
      resolveHookArtifactPath(base, "M001/S01/T01", "SECURITY-REVIEW.md"),
      "report\n",
      "utf-8",
    );
    const dispatch = checkPostUnitHooks("plan-slice", "M001/S01/T01", base);
    assert.ok(dispatch, "the gate dispatches");

    const bad = await executeHookVerdictSave(
      { hookName: "security-review", unitId: "M001/S01/T01", verdict: "approved", rationale: "x" },
      base,
      internalPlanningInvocation(),
    );
    assert.equal(bad.isError, true, "an out-of-vocabulary verdict is refused");

    // A row with an unsupported status (e.g. left by an older build) fails
    // loud instead of deciding. The row is read by the in-flight hook's
    // completion — a re-dispatch would invalidate it as a previous attempt's
    // verdict, so the budget is exhausted here and the block names it.
    const { upsertHookGateVerdict } = await import("../db/writers/hook-verdicts.ts");
    upsertHookGateVerdict({
      hookName: "security-review",
      unitId: "M001/S01/T01",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      verdict: "maybe",
      rationale: "legacy row",
    });
    const afterHook = checkPostUnitHooks("hook/security-review", "M001/S01/T01", base);
    assert.deepEqual(afterHook, null);
    const block = consumeGateBlock();
    assert.ok(block, "the unsupported verdict blocks instead of deciding");
    assert.match(block?.reason ?? "", /unsupported verdict=maybe/);
  } finally {
    resetHookState();
  }
});

const TWO_CYCLE_HOOK = `  - name: security-review
    after:
      - plan-slice
    prompt: Review security
    artifact: SECURITY-REVIEW.md
    criticality: blocking
    max_cycles: 2
`;

test("a re-dispatch invalidates the previous verdict row", async () => {
  const base = openFixture(TWO_CYCLE_HOOK);
  try {
    // Attempt 1: the gate dispatches, the hook records a pass, the gate
    // passes on that fresh row.
    const first = checkPostUnitHooks("plan-slice", "M001/S01/T01", base);
    assert.ok(first, "attempt 1 dispatches the gate");
    const saved = await executeHookVerdictSave(
      { hookName: "security-review", unitId: "M001/S01/T01", verdict: "pass", rationale: "Clean." },
      base,
      internalPlanningInvocation(),
    );
    assert.equal(saved.isError, undefined);
    const completed = checkPostUnitHooks("hook/security-review", "M001/S01/T01", base);
    assert.deepEqual(completed, null, "attempt 1 passes on its fresh row");

    // Attempt 2: the trigger re-runs and the gate re-dispatches. The previous
    // attempt's row must be gone — the verdict belongs to one attempt.
    const again = checkPostUnitHooks("plan-slice", "M001/S01/T01", base);
    assert.ok(again, "attempt 2 re-dispatches the gate");
    assert.equal(
      getHookGateVerdict("security-review", "M001/S01/T01"),
      null,
      "the re-dispatch invalidated the previous attempt's verdict row",
    );

    // The hook never records again: the gate must not pass on the old row.
    // It reruns to budget and blocks naming the tool.
    const afterHook = checkPostUnitHooks("hook/security-review", "M001/S01/T01", base);
    assert.deepEqual(afterHook, null);
    const block = consumeGateBlock();
    assert.ok(block, "the gate blocks instead of accepting the stale pass");
    assert.match(block!.reason ?? "", /no recorded verdict for gate security-review/);
    assert.match(block!.reason ?? "", /gsd_hook_verdict_save/);
  } finally {
    closeFixture(base);
  }
});

test("a re-dispatched hook passes on its fresh verdict, not the stale row", async () => {
  const base = openFixture(TWO_CYCLE_HOOK);
  try {
    // Attempt 1: dispatch, record a pass, gate passes.
    const first = checkPostUnitHooks("plan-slice", "M001/S01/T01", base);
    assert.ok(first, "attempt 1 dispatches the gate");
    const saved = await executeHookVerdictSave(
      { hookName: "security-review", unitId: "M001/S01/T01", verdict: "pass", rationale: "Attempt one." },
      base,
      internalPlanningInvocation(),
    );
    assert.equal(saved.isError, undefined);
    const completed = checkPostUnitHooks("hook/security-review", "M001/S01/T01", base);
    assert.deepEqual(completed, null, "attempt 1 passes");

    // Attempt 2: the re-dispatch invalidates the stale row...
    const again = checkPostUnitHooks("plan-slice", "M001/S01/T01", base);
    assert.ok(again, "attempt 2 re-dispatches the gate");
    assert.equal(getHookGateVerdict("security-review", "M001/S01/T01"), null);

    // ...the hook records pass again, and the gate passes on the FRESH row.
    const resaved = await executeHookVerdictSave(
      { hookName: "security-review", unitId: "M001/S01/T01", verdict: "pass", rationale: "Attempt two." },
      base,
      internalPlanningInvocation(),
    );
    assert.equal(resaved.isError, undefined);
    const afterHook = checkPostUnitHooks("hook/security-review", "M001/S01/T01", base);
    assert.deepEqual(afterHook, null, "the gate passes on the fresh row");
    assert.equal(consumeGateBlock(), null, "no gate block when the fresh verdict passes");
    assert.deepEqual(getHookGateVerdict("security-review", "M001/S01/T01"), {
      verdict: "pass",
      rationale: "Attempt two.",
    });
  } finally {
    closeFixture(base);
  }
});
