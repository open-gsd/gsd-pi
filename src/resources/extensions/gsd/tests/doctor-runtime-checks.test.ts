import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runGSDDoctor } from "../doctor.ts";
import { checkRuntimeHealth } from "../doctor-runtime-checks.ts";
import { invalidateAllCaches } from "../cache.ts";
import {
  closeDatabase,
  insertAssessment,
  insertMilestone,
  insertSlice,
  openDatabase,
  setMilestoneQueueOrder,
} from "../gsd-db.ts";
import { getRuntimeKv, setRuntimeKv } from "../db/runtime-kv.ts";
import {
  getUatRetryAttempts,
  incrementUatRetryAttempts,
  readHookStateJson,
  writeHookStateJson,
} from "../db/writers/runtime-control.ts";
import { hookStateScope } from "../rule-registry.ts";
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
  t.after(() => {
    closeDatabase();
    invalidateAllCaches();
    rmSync(dir, { recursive: true, force: true });
  });

  mkdirSync(join(dir, ".gsd"), { recursive: true });
  openDatabase(join(dir, ".gsd", "gsd.db"));
  for (let attempt = 1; attempt <= 3; attempt++) incrementUatRetryAttempts("M002", "S01");
  // An ASSESSMENT.md verdict with no assessment row is not a verdict.
  mkdirSync(join(dir, ".gsd", "milestones", "M002", "slices", "S01"), { recursive: true });
  writeFileSync(
    join(dir, ".gsd", "milestones", "M002", "slices", "S01", "S01-ASSESSMENT.md"),
    "---\nverdict: PASS\n---\n",
    "utf-8",
  );
  // A run-uat assessment row is a verdict: the slice is not reported.
  for (let attempt = 1; attempt <= 3; attempt++) incrementUatRetryAttempts("M002", "S02");
  insertMilestone({ id: "M002", title: "Milestone", status: "active" });
  insertSlice({ id: "S02", milestoneId: "M002", title: "Slice with a verdict" });
  insertAssessment({
    path: "milestones/M002/slices/S02/S02-ASSESSMENT.md",
    milestoneId: "M002",
    sliceId: "S02",
    status: "pass",
    scope: "run-uat",
    fullContent: "verdict: PASS",
  });
  // A counter file from an older build is not a counter: it is never reported.
  mkdirSync(join(dir, ".gsd", "runtime"), { recursive: true });
  writeFileSync(
    join(dir, ".gsd", "runtime", "uat-count-M009-S09.json"),
    JSON.stringify({ count: 3, updatedAt: "2026-06-02T19:40:23.289Z" }) + "\n",
    "utf-8",
  );

  const issues: DoctorIssue[] = [];
  const fixesApplied: string[] = [];
  await checkRuntimeHealth(dir, issues, fixesApplied, () => false);
  const exhausted = issues.filter((candidate) => candidate.code === "uat_retry_exhausted");
  assert.deepEqual(exhausted.map((issue) => issue.unitId), ["M002/S01"]);
  assert.match(exhausted[0]!.message, /3 attempt\(s\)/);
  assert.equal(getUatRetryAttempts("M002", "S01"), 3, "read-only doctor keeps the counter");

  await checkRuntimeHealth(dir, [], fixesApplied, (code) => code === "uat_retry_exhausted");
  assert.ok(
    fixesApplied.some((fix) => fix.includes("reset exhausted run-uat retry counter for M002/S01")),
  );
  assert.equal(getUatRetryAttempts("M002", "S01"), 0);
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

test("doctor ignores a leftover completed-units.json file", async (t) => {
  const dir = createGitProject();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Keys with no matching artifact: the removed check reported these as
  // orphaned completed units and pruned them on fix.
  const completedUnitsPath = join(dir, ".gsd", "completed-units.json");
  const content = JSON.stringify(["execute-task/M001/S01/T01", "complete-slice/M001/S01"]);
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  writeFileSync(completedUnitsPath, content, "utf-8");

  const report = await runGSDDoctor(dir, { fix: true });

  const mentions = (text: string | undefined): boolean => /completed[- ]unit/i.test(text ?? "");
  assert.deepEqual(
    report.issues.filter((issue) => mentions(issue.code) || mentions(issue.message) || mentions(issue.file)),
    [],
  );
  assert.deepEqual(report.fixesApplied.filter(mentions), []);
  assert.equal(readFileSync(completedUnitsPath, "utf-8"), content);
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

test("doctor fix preserves a pending gate block in the hook state (#2194)", async (t) => {
  const dir = createGitProject();
  t.after(() => {
    closeDatabase();
    invalidateAllCaches();
    rmSync(dir, { recursive: true, force: true });
  });

  mkdirSync(join(dir, ".gsd"), { recursive: true });
  openDatabase(join(dir, ".gsd", "gsd.db"));
  const scope = hookStateScope(dir);
  const runFix = async (): Promise<void> => {
    await checkRuntimeHealth(dir, [], [], (code) => code === "stale_hook_state");
  };
  const writeHookState = (gateBlockPending: unknown): void => {
    writeHookStateJson(scope, JSON.stringify({
      cycleCounts: { "slice-plan-review/plan-slice/M001/S01": 1 },
      redispatchedGateKeys: [],
      activeHook: null,
      hookQueue: [],
      retryPending: false,
      retryTrigger: null,
      gateBlockPending,
      savedAt: new Date().toISOString(),
    }));
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
  await runFix();
  const preserved = JSON.parse(readHookStateJson(scope)!);
  assert.equal(preserved.gateBlockPending?.hookName, "slice-plan-review");
  assert.equal(preserved.gateBlockPending?.triggerUnitId, "M001/S01");

  // Without a pending block the same residual state is still stale and cleared.
  writeHookState(null);
  await runFix();
  const cleared = JSON.parse(readHookStateJson(scope)!);
  assert.deepEqual(cleared.cycleCounts, {});
});

test("doctor reports a hook-state.json with no hook state row and fix removes it", async (t) => {
  const dir = createGitProject();
  t.after(() => {
    closeDatabase();
    invalidateAllCaches();
    rmSync(dir, { recursive: true, force: true });
  });

  mkdirSync(join(dir, ".gsd"), { recursive: true });
  openDatabase(join(dir, ".gsd", "gsd.db"));
  const filePath = join(dir, ".gsd", "hook-state.json");
  const legacyIssues = async (fix: boolean, fixesApplied: string[] = []): Promise<DoctorIssue[]> => {
    const issues: DoctorIssue[] = [];
    await checkRuntimeHealth(dir, issues, fixesApplied, (code) => fix && code === "legacy_hook_state_file");
    return issues.filter((candidate) => candidate.code === "legacy_hook_state_file");
  };
  writeFileSync(filePath, JSON.stringify({ cycleCounts: { "review/plan-slice/M001/S01": 1 } }), "utf-8");

  const [issue] = await legacyIssues(false);
  assert.equal(issue?.severity, "info");
  assert.equal(issue?.file, ".gsd/hook-state.json");
  assert.equal(issue?.fixable, true);
  assert.ok(existsSync(filePath), "a report without fix keeps the file");

  const fixesApplied: string[] = [];
  await legacyIssues(true, fixesApplied);
  assert.equal(existsSync(filePath), false, "fix removes the file");
  assert.deepEqual(fixesApplied.filter((fix) => fix.includes("hook-state.json")), ["removed legacy hook-state.json"]);
  assert.equal(readHookStateJson(hookStateScope(dir)), null, "fix creates no hook state row");
  assert.deepEqual(await legacyIssues(false), []);

  // With a row, the file is the diagnostic copy of that row: not reported, not removed.
  writeHookStateJson(hookStateScope(dir), JSON.stringify({ cycleCounts: {} }));
  writeFileSync(filePath, JSON.stringify({ cycleCounts: {} }), "utf-8");
  assert.deepEqual(await legacyIssues(true), []);
  assert.ok(existsSync(filePath));
});

test("doctor lists stale control-publication intents without opening the projection lock (#2154)", async (t) => {
  const dir = createGitProject();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const journalDir = join(dir, ".gsd", "migration", "projection-mutations");
  mkdirSync(journalDir, { recursive: true });
  const intentPath = join(journalDir, ".gsd-control-00000000-0000-0000-0000-000000000001.json.intent");
  writeFileSync(intentPath, JSON.stringify({ sequence: 1, phase: "temporary-durable" }));
  const stale = new Date(Date.now() - 200_000);
  utimesSync(intentPath, stale, stale);
  // Non-intent journal content must not be reported.
  writeFileSync(join(journalDir, "00000000-0000-0000-0000-000000000002.json"), "{}\n");

  const report = await runGSDDoctor(dir);
  const issue = report.issues.find((candidate) => candidate.code === "stale_control_publication_intent");
  assert.ok(issue, "doctor lists the stale prepared intent");
  assert.match(issue.message, /\.gsd-control-00000000-0000-0000-0000-000000000001\.json\.intent/u);
  assert.match(issue.message, /quarantined-control-publications/u);
  assert.equal(issue.fixable, false);
  assert.equal(
    report.issues.filter((candidate) => candidate.code === "stale_control_publication_intent").length,
    1,
  );
});

test("doctor lists only aged control-publication intents plus quarantined artifacts (#2154)", async (t) => {
  const dir = createGitProject();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const journalDir = join(dir, ".gsd", "migration", "projection-mutations");
  const quarantineDir = join(dir, ".gsd", "migration", "quarantined-control-publications");
  mkdirSync(journalDir, { recursive: true });
  mkdirSync(quarantineDir, { recursive: true });
  const staleIntentPath = join(journalDir, ".gsd-control-00000000-0000-0000-0000-000000000001.json.intent");
  const freshIntentPath = join(journalDir, ".gsd-control-00000000-0000-0000-0000-000000000003.json.intent");
  writeFileSync(staleIntentPath, JSON.stringify({ sequence: 1, phase: "temporary-durable" }));
  writeFileSync(freshIntentPath, JSON.stringify({ sequence: 1, phase: "temporary-durable" }));
  const stale = new Date(Date.now() - 200_000);
  utimesSync(staleIntentPath, stale, stale);
  writeFileSync(
    join(quarantineDir, ".gsd-control-00000000-0000-0000-0000-000000000002.json.intent.11111111-2222-4333-8444-555555555555.quarantined"),
    "{}",
  );
  writeFileSync(
    join(quarantineDir, ".gsd-control-00000000-0000-0000-0000-000000000002.json.intent.11111111-2222-4333-8444-555555555555.quarantined.json"),
    JSON.stringify({ reason: "stale-control-publication-intent" }),
  );

  const report = await runGSDDoctor(dir);
  const issues = report.issues.filter((candidate) => candidate.code === "stale_control_publication_intent");
  // The aged in-journal intent lists as an error...
  assert.ok(issues.some((candidate) => candidate.severity === "error"
    && /\.gsd-control-00000000-0000-0000-0000-000000000001\.json\.intent/u.test(candidate.message)));
  // ...the fresh (possibly in-flight) intent does not list at all...
  assert.ok(!issues.some((candidate) => /\.gsd-control-00000000-0000-0000-0000-000000000003/u.test(candidate.message)));
  // ...and the already-quarantined artifact lists as reviewable, without its sidecar.
  assert.ok(issues.some((candidate) => candidate.severity === "warning"
    && /00000000-0000-0000-0000-000000000002\.json\.intent\.11111111[^\n]*\.quarantined\b/u.test(candidate.message)));
  assert.ok(!issues.some((candidate) => candidate.file?.endsWith(".quarantined.json") ?? false));
});
