/**
 * Regression test for #3698 — allow milestone completion when validation
 * was skipped by preference.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DISPATCH_RULES, type DispatchContext } from "../auto-dispatch.ts";
import {
  closeDatabase,
  insertMilestone,
  insertSlice,
  openDatabase,
  upsertMilestonePlanning,
} from "../gsd-db.ts";
import { seedLifecycles } from "./helpers/authority-cutover.ts";
import { grantMilestoneValidationWaiver } from "../milestone-validation-waiver-domain-operation.ts";
import { captureMilestoneVerificationSourceRevision } from "../verification-source-integrity.ts";
import { internalExecutionInvocation } from "../execution-invocation.ts";
import { invalidateAllCaches } from "../cache.ts";
import type { GSDPreferences } from "../preferences.ts";
import type { GSDState } from "../types.ts";

const COMPLETE_RULE = "completing-milestone → complete-milestone";

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-skipped-validation-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  writeFileSync(join(base, "app.js"), "export const shipped = true;\n");
  // The canonical validation waiver binds to the fixture repo's source revision.
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: base, stdio: "ignore" });
  writeFileSync(join(base, ".gitignore"), ".gsd/\n");
  execFileSync("git", ["add", ".gitignore", "app.js"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: base, stdio: "ignore" });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  invalidateAllCaches();
  rmSync(base, { recursive: true, force: true });
}

function seedMilestone(base: string): void {
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({
    id: "M001",
    title: "Preference-skipped validation milestone",
    status: "active",
    depends_on: [],
  });
  upsertMilestonePlanning("M001", {
    title: "Preference-skipped validation milestone",
        vision: "Ship a small implementation with a documented validation skip.",
    successCriteria: ["Completion remains unblocked when validation was intentionally skipped."],
    keyRisks: [],
    proofStrategy: [],
    verificationContract: "",
    verificationIntegration: "",
    verificationOperational: "Smoke-test the shipped workflow before completion.",
    verificationUat: "",
    definitionOfDone: [],
    requirementCoverage: "",
    boundaryMapMarkdown: "",
  });
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "First",
    status: "done",
    risk: "low",
    depends: [],
    demo: "",
    sequence: 1,
  });
  // The canonical validation waiver grant requires an adopted, open lifecycle.
  seedLifecycles("skipped-validation-completion/adopt", [
    { itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "ready" },
    { itemKind: "slice", milestoneId: "M001", sliceId: "S01", lifecycleStatus: "completed" },
  ]);
}

function writeFixtureFiles(base: string): void {
  const milestoneDir = join(base, ".gsd", "milestones", "M001");
  writeFileSync(
    join(milestoneDir, "M001-ROADMAP.md"),
    [
      "# M001",
      "## Slices",
      "- [x] **S01: First** `risk:low` `depends:[]`",
    ].join("\n"),
  );
  writeFileSync(
    join(milestoneDir, "slices", "S01", "S01-SUMMARY.md"),
    "# S01\n\nImplemented the shipped workflow.\n",
  );
}

function findRule(name: string) {
  const rule = DISPATCH_RULES.find(candidate => candidate.name === name);
  assert.ok(rule, `rule "${name}" must exist`);
  return rule!;
}

function makeCtx(base: string): DispatchContext {
  const state: GSDState = {
    phase: "completing-milestone",
    activeMilestone: { id: "M001", title: "Preference-skipped validation milestone" },
    activeSlice: null,
    activeTask: null,
    recentDecisions: [],
    blockers: [],
    nextAction: "",
    registry: [{ id: "M001", title: "Preference-skipped validation milestone", status: "active" }],
  };
  return {
    basePath: base,
    mid: "M001",
    midTitle: "Preference-skipped validation milestone",
    state,
    // The canonical skip path: the preference records the validation waiver.
    prefs: { phases: { skip_milestone_validation: true } } as GSDPreferences,
    // Preview: the git preflight commit is out of scope here; the guarded
    // dispatch decision is identical to the real turn's.
    preview: true,
  };
}

test("#3698: completing-milestone dispatch accepts skipped validation fixture", async (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));

  seedMilestone(base);
  writeFixtureFiles(base);

  // The preference skip path records the canonical validation waiver in the
  // validating phase; the completion guard then dispatches on the waiver.
  const source = captureMilestoneVerificationSourceRevision(base, undefined);
  assert.ok(source.ok, `verification source snapshot failed: ${source.ok ? "" : source.error}`);
  openDatabase(join(base, ".gsd", "gsd.db"));
  grantMilestoneValidationWaiver({
    invocation: internalExecutionInvocation("skipped-validation-completion/waive", { actorId: "fixture" }),
    milestoneId: "M001",
    testedSourceRevision: source.sourceRevision,
    reason: "preference",
    policyId: "milestone-validation-waiver",
    policyVersion: "1",
  });

  const result = await findRule(COMPLETE_RULE).match(makeCtx(base));

  assert.ok(result, "rule must return a result");
  assert.strictEqual(result!.action, "dispatch", "skipped validation should still allow completion dispatch");
  if (result!.action === "dispatch") {
    assert.strictEqual(result.unitType, "complete-milestone");
  }
});
