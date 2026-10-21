import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runGSDDoctor } from "../doctor.ts";
import { checkRuntimeHealth } from "../doctor-runtime-checks.ts";
import { invalidateAllCaches } from "../cache.ts";
import {
  closeDatabase,
  insertMilestone,
  openDatabase,
  setMilestoneQueueOrder,
} from "../gsd-db.ts";
import { getRuntimeKv, setRuntimeKv } from "../db/runtime-kv.ts";
import {
  PAUSED_SESSION_KV_KEY,
  type PausedSessionMetadata,
} from "../interrupted-session.ts";
import type { DoctorIssue } from "../doctor-types.ts";

function runGit(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function createGitProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-doctor-runtime-checks-"));
  runGit(dir, ["init"]);
  runGit(dir, ["config", "user.email", "test@test.com"]);
  runGit(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "README.md"), "# test\n", "utf-8");
  runGit(dir, ["add", "."]);
  runGit(dir, ["commit", "-m", "init"]);
  return dir;
}

test("doctor fix respects git.manage_gitignore false (#4161)", async (t) => {
  const dir = createGitProject();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  mkdirSync(join(dir, ".gsd"), { recursive: true });
  writeFileSync(
    join(dir, ".gsd", "PREFERENCES.md"),
    "---\nversion: 1\ngit:\n  manage_gitignore: false\n---\n",
    "utf-8",
  );
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n", "utf-8");

  const detect = await runGSDDoctor(dir);
  assert.ok(
    detect.issues.some((issue) => issue.code === "gitignore_missing_patterns"),
    "doctor still reports missing runtime ignore patterns so users can decide how to handle them",
  );

  await runGSDDoctor(dir, { fix: true });

  assert.equal(readFileSync(join(dir, ".gitignore"), "utf-8"), "node_modules/\n");
  assert.equal(existsSync(join(dir, ".gsd", "PREFERENCES.md")), true);
});

test("doctor fix resets run-uat counters at the dispatch cap", async (t) => {
  const dir = createGitProject();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const runtimeDir = join(dir, ".gsd", "runtime");
  mkdirSync(runtimeDir, { recursive: true });
  const counterPath = join(runtimeDir, "uat-count-M002-S01.json");
  writeFileSync(
    counterPath,
    JSON.stringify({ count: 3, updatedAt: "2026-06-02T19:40:23.289Z" }) + "\n",
    "utf-8",
  );

  const detect = await runGSDDoctor(dir);
  const issue = detect.issues.find((candidate) => candidate.code === "uat_retry_exhausted");
  assert.ok(issue, "doctor reports the exhausted UAT retry counter at the dispatch cap");
  assert.equal(issue.unitId, "M002/S01");
  assert.match(issue.message, /3 attempt\(s\)/);

  const fixed = await runGSDDoctor(dir, { fix: true, scope: "M002/S02" });
  assert.ok(
    fixed.fixesApplied.some((fix) => fix.includes("reset exhausted run-uat retry counter for M002/S01")),
    "doctor --fix resets the blocked counter even when the current displayed scope has advanced",
  );
  assert.equal(existsSync(counterPath), false);
});

test("doctor reports and repairs a paused session superseded by the active milestone", async (t) => {
  const dir = createGitProject();
  t.after(() => {
    closeDatabase();
    invalidateAllCaches();
    rmSync(dir, { recursive: true, force: true });
  });

  const pausedMilestoneId = "M016-5b17xo";
  const activeMilestoneId = "M018-6b0xxe";
  for (const milestoneId of [pausedMilestoneId, activeMilestoneId]) {
    const milestoneDir = join(dir, ".gsd", "milestones", milestoneId);
    mkdirSync(milestoneDir, { recursive: true });
    writeFileSync(join(milestoneDir, `${milestoneId}-CONTEXT.md`), `# ${milestoneId}\n`);
  }

  openDatabase(join(dir, ".gsd", "gsd.db"));
  insertMilestone({ id: pausedMilestoneId, title: "Superseded milestone", status: "active" });
  insertMilestone({ id: activeMilestoneId, title: "Current milestone", status: "active" });
  setMilestoneQueueOrder([activeMilestoneId, pausedMilestoneId]);
  setRuntimeKv("global", "", PAUSED_SESSION_KV_KEY, {
    milestoneId: pausedMilestoneId,
    originalBasePath: dir,
  } satisfies PausedSessionMetadata);
  invalidateAllCaches();

  const issues: DoctorIssue[] = [];
  const fixesApplied: string[] = [];
  await checkRuntimeHealth(dir, issues, fixesApplied, () => false);

  const issue = issues.find((candidate) => candidate.code === "stale_paused_session");
  assert.ok(issue, "doctor reports the stale paused-session row");
  assert.equal(issue.severity, "error");
  assert.equal(issue.fixable, true);
  assert.match(issue.message, new RegExp(pausedMilestoneId));
  assert.match(issue.message, new RegExp(activeMilestoneId));
  assert.ok(
    getRuntimeKv("global", "", PAUSED_SESSION_KV_KEY),
    "read-only doctor preserves paused-session metadata",
  );

  const fixIssues: DoctorIssue[] = [];
  await checkRuntimeHealth(
    dir,
    fixIssues,
    fixesApplied,
    (code) => code === "stale_paused_session",
  );

  assert.equal(getRuntimeKv("global", "", PAUSED_SESSION_KV_KEY), null);
  assert.ok(
    fixesApplied.some((fix) => fix.includes(`cleared stale paused session for ${pausedMilestoneId}`)),
  );
  assert.equal(fixIssues.some((candidate) => candidate.code === "stale_paused_session"), false);

  setRuntimeKv("global", "", PAUSED_SESSION_KV_KEY, {
    activeEngineId: "custom-workflow",
    milestoneId: pausedMilestoneId,
    originalBasePath: dir,
  } satisfies PausedSessionMetadata);
  const customWorkflowIssues: DoctorIssue[] = [];
  await checkRuntimeHealth(
    dir,
    customWorkflowIssues,
    fixesApplied,
    (code) => code === "stale_paused_session",
  );
  assert.equal(
    customWorkflowIssues.some((candidate) => candidate.code === "stale_paused_session"),
    false,
    "doctor leaves custom-workflow pause metadata to its dedicated resume path",
  );
  assert.ok(getRuntimeKv("global", "", PAUSED_SESSION_KV_KEY));
});

test("doctor surfaces unresolved projection evidence with recovery instructions", async (t) => {
  const dir = createGitProject();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const evidencePath = "notes/my notes/.gsd-projection-remove-00000000-0000-0000-0000-000000000001";
  mkdirSync(join(dir, ".gsd", evidencePath), { recursive: true });
  mkdirSync(join(dir, ".gsd", "migration"), { recursive: true });
  writeFileSync(join(dir, ".gsd", evidencePath, "later.md"), "later accepted work\n");
  writeFileSync(
    join(dir, ".gsd", "migration", "unbound-projection-evidence.json"),
    `${JSON.stringify([{
      evidencePath,
      evidenceIdentity: null,
      kind: "quarantine",
      logicalPath: "notes/my notes/result.md",
      scope: "tree",
      transition: "retained",
    }])}\n`,
  );

  const report = await runGSDDoctor(dir);
  const issue = report.issues.find(candidate => candidate.code === "unresolved_projection_evidence");
  assert.ok(issue);
  assert.match(issue.message, /notes\/my notes\/result\.md/);
  assert.match(issue.message, /\.gsd\/notes\/my notes\/\.gsd-projection-remove/);
  assert.match(issue.message, /\/gsd doctor resolve-evidence/u);
  assert.match(issue.message, /evidence:sha256:[0-9a-f]+ --action=discard --consent=discard:sha256:/u);
  assert.match(issue.message, /--action=preserve/u);
  assert.match(issue.message, /--action=restore/u);
  assert.equal(issue.fixable, false);
});

test("doctor fix preserves a pending gate block in hook-state.json (#2194)", async (t) => {
  const dir = createGitProject();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  mkdirSync(join(dir, ".gsd"), { recursive: true });
  const hookStatePath = join(dir, ".gsd", "hook-state.json");
  const writeHookState = (gateBlockPending: unknown): void => {
    writeFileSync(hookStatePath, JSON.stringify({
      cycleCounts: { "slice-plan-review/plan-slice/M001/S01": 1 },
      redispatchedGateKeys: [],
      activeHook: null,
      hookQueue: [],
      retryPending: false,
      retryTrigger: null,
      gateBlockPending,
      savedAt: new Date().toISOString(),
    }), "utf-8");
  };
  writeHookState({
    hookName: "slice-plan-review",
    triggerUnitType: "plan-slice",
    triggerUnitId: "M001/S01",
    artifact: "SLICE-REVIEW.md",
    action: "pause",
    reason: "gate cycle budget exhausted before slice-plan-review produced a passing outcome",
    cycle: 1,
    maxCycles: 1,
  });

  // A pending block re-arms a failed gate on resume; the stale-state fix
  // must not erase it.
  await runGSDDoctor(dir, { fix: true });
  const preserved = JSON.parse(readFileSync(hookStatePath, "utf-8"));
  assert.equal(preserved.gateBlockPending?.hookName, "slice-plan-review");
  assert.equal(preserved.gateBlockPending?.triggerUnitId, "M001/S01");

  // Without a pending block the same residual state is still stale and cleared.
  writeHookState(null);
  await runGSDDoctor(dir, { fix: true });
  const cleared = JSON.parse(readFileSync(hookStatePath, "utf-8"));
  assert.deepEqual(cleared.cycleCounts, {});
});
