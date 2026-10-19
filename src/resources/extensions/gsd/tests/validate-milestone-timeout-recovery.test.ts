// Project/App: gsd-pi
// File Purpose: Regression coverage for validate-milestone timeout recovery steering (#1919).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { diagnoseExpectedArtifact } from "../auto-recovery.ts";
import { recoverTimedOutUnit, type RecoveryContext } from "../auto-timeout-recovery.ts";
import { resolveDispatchRecoveryAttempts } from "../auto/unit-phase.ts";
import { closeDatabase, insertMilestone, openDatabase } from "../gsd-db.ts";
import { claimTestDispatch } from "./helpers/unit-dispatch.ts";

function recoveryContext(base: string, startedAt: number): RecoveryContext {
  return {
    basePath: base,
    verbose: false,
    currentUnitStartedAt: startedAt,
    unclaimedUnitBudgets: new Map(),
  };
}

function recordingHarness() {
  const messages: Array<{ content?: string }> = [];
  const notifications: string[] = [];
  return {
    ctx: { ui: { notify: (message: string) => notifications.push(message) } } as any,
    pi: { sendMessage: (message: { content?: string }) => messages.push(message) } as any,
    messages,
    notifications,
  };
}

test("validate-milestone expected artifact describes canonical persistence, not a hand-written file", () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-validate-timeout-recovery-"));
  try {
    const expected = diagnoseExpectedArtifact("validate-milestone", "M001", base) ?? "";
    assert.match(expected, /gsd_validate_milestone/);
    assert.match(expected, /projected to .*VALIDATION\.md/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("validate-milestone recovery steers to gsd_validate_milestone instead of writing VALIDATION.md", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-validate-timeout-recovery-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  try {
    const harness = recordingHarness();
    const result = await recoverTimedOutUnit(
      harness.ctx,
      harness.pi,
      "validate-milestone",
      "M001",
      "idle",
      recoveryContext(base, Date.now()),
    );

    assert.equal(result, "recovered");
    assert.equal(harness.messages.length, 1);
    const steering = harness.messages[0].content ?? "";
    assert.match(steering, /finish reviewer aggregation/i);
    assert.match(steering, /call `gsd_validate_milestone`/i);
    assert.match(steering, /do not manually write VALIDATION\.md/i);
    assert.doesNotMatch(steering, /write the (?:required )?artifact/i);
    assert.ok(
      harness.notifications.every((message) => !/produce .*VALIDATION\.md/i.test(message)),
      "recovery notification must not direct validation toward the projected artifact",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a timeout recovery survives a restart: the count is on the dispatch row", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-validate-timeout-restart-"));
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  claimTestDispatch(base, { milestoneId: "M001", unitType: "validate-milestone", unitId: "M001" });
  const harness = recordingHarness();
  const beforeKill = recoveryContext(base, Date.now());

  assert.equal(
    await recoverTimedOutUnit(harness.ctx, harness.pi, "validate-milestone", "M001", "idle", beforeKill),
    "recovered",
  );

  assert.equal(beforeKill.unclaimedUnitBudgets.size, 0, "a claimed unit keeps nothing in session memory");
  // A new process has an empty session map. The next dispatch of the unit must
  // still see that a recovery ran, as it does in the process that ran it.
  assert.equal(resolveDispatchRecoveryAttempts(new Map(), "validate-milestone", "M001"), 0);
  assert.equal(resolveDispatchRecoveryAttempts(new Map(), "validate-milestone", "M002"), undefined);
});

test("research-slice recovery names the save tool instead of telling the agent to write the file", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-research-timeout-recovery-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });

  const harness = recordingHarness();
  const context = recoveryContext(base, Date.now());
  // First attempt, then the final (escalated) attempt.
  for (const attempt of [1, 2]) {
    await recoverTimedOutUnit(harness.ctx, harness.pi, "research-slice", "M001/S01", "idle", context);
    const steering = harness.messages[attempt - 1]?.content ?? "";
    assert.match(steering, /S01-RESEARCH\.md are blocked/);
    assert.match(steering, /gsd_summary_save/);
    assert.doesNotMatch(steering, /write the (?:required )?(?:artifact|file)/i);
  }
});

test("execute-task and complete-slice expected output is the tool call, not a checkbox edit", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-completion-diagnosis-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const task = diagnoseExpectedArtifact("execute-task", "M001/S01/T01", base) ?? "";
  const slice = diagnoseExpectedArtifact("complete-slice", "M001/S01", base) ?? "";
  assert.match(task, /gsd_task_complete/);
  assert.match(slice, /gsd_slice_complete/);
  assert.doesNotMatch(`${task} ${slice}`, /marked \[x\]/);
});
