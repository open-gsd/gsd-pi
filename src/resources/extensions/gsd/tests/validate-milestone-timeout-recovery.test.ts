// Project/App: gsd-pi
// File Purpose: Regression coverage for validate-milestone timeout recovery steering (#1919).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { diagnoseExpectedArtifact } from "../auto-recovery.ts";
import { recoverTimedOutUnit, type RecoveryContext } from "../auto-timeout-recovery.ts";

function recoveryContext(base: string, startedAt: number): RecoveryContext {
  return {
    basePath: base,
    verbose: false,
    currentUnitStartedAt: startedAt,
    unitRecoveryCount: new Map(),
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
