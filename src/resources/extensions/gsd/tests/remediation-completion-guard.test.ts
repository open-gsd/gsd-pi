/**
 * Regression tests for non-passing milestone validation verdicts:
 * completing-milestone dispatch must block completion when the validation
 * needs remediation or attention.
 *
 * Without this guard, needs-remediation + allSlicesDone causes a loop:
 * complete-milestone dispatched → agent refuses (correct) → no completion
 * → re-dispatch → repeat until the liveness backstop trips.
 *
 * The verdict is the canonical validation receipt in the workflow DB.
 * VALIDATION.md is a projection: its verdict line decides nothing.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DISPATCH_RULES, type DispatchAction } from "../auto-dispatch.ts";
import { closeDatabase, insertMilestone, openDatabase } from "../gsd-db.ts";
import { seedCanonicalMilestoneValidation } from "./merge-ready-fixture.ts";

/** Find the completing-milestone dispatch rule */
const completingRule = DISPATCH_RULES.find(r => r.name === "completing-milestone → complete-milestone");

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "gsd-remediation-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  // The canonical receipt binds to the fixture repo's source revision.
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: base, stdio: "ignore" });
  writeFileSync(join(base, ".gitkeep"), "");
  execFileSync("git", ["add", ".gitkeep"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: base, stdio: "ignore" });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
});

afterEach(() => {
  closeDatabase();
  rmSync(base, { recursive: true, force: true });
});

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
    // Preview: the git preflight commit is out of scope here; the verdict
    // guard decision is identical to the real turn's.
    preview: true,
  } as any);
}

for (const [recordedVerdict, reasonVerdict] of [
  ["fail", "fail"],
  ["inconclusive", "inconclusive"],
] as const) {
  test(`completing-milestone blocks when the recorded validation verdict is ${recordedVerdict} (#2675, #5747, #5920)`, async () => {
    seedCanonicalMilestoneValidation(base, "M001", recordedVerdict);
    openDatabase(join(base, ".gsd", "gsd.db"));

    const result = await matchCompletingRule();

    assert.ok(result !== null, "rule should match");
    assert.equal(result.action, "stop", "should return stop action");
    if (result.action === "stop") {
      assert.equal(result.level, "warning", "should be warning level (pausable)");
      assert.ok(
        result.reason.includes(`verdict is ${reasonVerdict}`),
        `reason should name the ${reasonVerdict} verdict, got: ${result.reason}`,
      );
    }
  });
}

test("a pass verdict edited into VALIDATION.md does not lift a recorded fail verdict", async () => {
  seedCanonicalMilestoneValidation(base, "M001", "fail");
  openDatabase(join(base, ".gsd", "gsd.db"));
  writeValidationFile("pass");

  const result = await matchCompletingRule();

  assert.equal(result?.action, "stop");
  assert.match(result?.action === "stop" ? result.reason : "", /verdict is fail/);
});

test("a fail verdict in VALIDATION.md does not block a recorded pass verdict", async () => {
  seedCanonicalMilestoneValidation(base, "M001", "pass", { withClosedSlice: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  writeValidationFile("fail");

  const result = await matchCompletingRule();

  assert.ok(result !== null, "rule should match");
  assert.equal(result.action, "dispatch", "the canonical pass receipt completes");
  if (result.action === "dispatch") {
    assert.equal(result.unitType, "complete-milestone");
  }
});
