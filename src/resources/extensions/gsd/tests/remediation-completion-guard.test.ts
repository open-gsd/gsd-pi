/**
 * Regression tests for non-passing milestone validation verdicts:
 * completing-milestone dispatch must block completion when the validation
 * needs remediation or attention.
 *
 * Without this guard, needs-remediation + allSlicesDone causes a loop:
 * complete-milestone dispatched → agent refuses (correct) → no completion
 * → re-dispatch → repeat until the liveness backstop trips.
 *
 * The verdict is the `milestone-validation` assessment row. VALIDATION.md is a
 * projection: its verdict line decides nothing.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DISPATCH_RULES, type DispatchAction } from "../auto-dispatch.ts";
import { closeDatabase, insertAssessment, insertMilestone, openDatabase } from "../gsd-db.ts";

/** Find the completing-milestone dispatch rule */
const completingRule = DISPATCH_RULES.find(r => r.name === "completing-milestone → complete-milestone");

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "gsd-remediation-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
});

afterEach(() => {
  closeDatabase();
  rmSync(base, { recursive: true, force: true });
});

function recordValidation(verdict: string): void {
  insertAssessment({
    path: "milestones/M001/M001-VALIDATION.md",
    milestoneId: "M001",
    status: verdict,
    scope: "milestone-validation",
    fullContent: ["---", `verdict: ${verdict}`, "---", "", "# Validation Report"].join("\n"),
  });
}

function writeValidationFile(verdict: string): void {
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "M001-VALIDATION.md"),
    ["---", `verdict: ${verdict}`, "remediation_round: 0", "---", "", "# Validation Report"].join("\n"),
  );
}

async function matchCompletingRule(): Promise<DispatchAction | null> {
  assert.ok(completingRule, "rule should exist in DISPATCH_RULES");
  return completingRule.match({
    mid: "M001",
    midTitle: "Test Milestone",
    basePath: base,
    state: { phase: "completing-milestone" } as any,
    prefs: {} as any,
    session: undefined,
  });
}

for (const verdict of ["needs-remediation", "needs-attention", "fail"]) {
  test(`completing-milestone blocks when the recorded validation verdict is ${verdict} (#2675, #5747, #5920)`, async () => {
    recordValidation(verdict);

    const result = await matchCompletingRule();

    assert.ok(result !== null, "rule should match");
    assert.equal(result.action, "stop", "should return stop action");
    if (result.action === "stop") {
      assert.equal(result.level, "warning", "should be warning level (pausable)");
      assert.ok(result.reason.includes(`verdict is "${verdict}"`), `reason should name the ${verdict} verdict`);
    }
  });
}

test("a pass verdict edited into VALIDATION.md does not lift a recorded needs-remediation verdict", async () => {
  recordValidation("needs-remediation");
  writeValidationFile("pass");

  const result = await matchCompletingRule();

  assert.equal(result?.action, "stop");
  assert.match(result?.action === "stop" ? result.reason : "", /needs-remediation/);
});

test("a needs-remediation verdict in VALIDATION.md does not block a recorded pass verdict", async () => {
  recordValidation("pass");
  writeValidationFile("needs-remediation");

  const result = await matchCompletingRule();

  assert.ok(result !== null, "rule should match");
  if (result.action === "stop") {
    assert.ok(
      !result.reason.includes("needs-remediation"),
      "the validation guard must read the recorded pass verdict, not the file",
    );
  }
});
