import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isProjectionRootIdentityLockAvailable, acquireProjectionRootIdentityLock, _latchProjectionRootIdentityLockForTest, _resetProjectionRootIdentityLockHealthForTest } from "@gsd/native/file-identity";

import { runGSDDoctor } from "../doctor.ts";
import { checkRuntimeHealth } from "../doctor-runtime-checks.ts";
import {
  loadUnboundProjectionEvidence,
  previewUnboundProjectionEvidenceResolution,
  resolveUnboundProjectionEvidence,
} from "../managed-projection-history.ts";
import { invalidateAllCaches } from "../cache.ts";
import {
  closeDatabase,
  insertAssessment,
  insertMilestone,
  insertSlice,
  openDatabase,
  setMilestoneQueueOrder,
} from "../gsd-db.ts";
import {
  getUatRetryAttempts,
  incrementUatRetryAttempts,
  readHookStateJson,
  writeHookStateJson,
} from "../db/writers/runtime-control.ts";
import { hookStateScope } from "../rule-registry.ts";
import { readPausedSessionMetadata } from "../interrupted-session.ts";
import { openAutoPause } from "../db/writers/auto-pauses.ts";
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
  openAutoPause({
    blockerKind: "user_request",
    milestoneId: pausedMilestoneId,
    originalBasePath: dir,
  });
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
    readPausedSessionMetadata(dir),
    "read-only doctor preserves the pause row",
  );

  const fixIssues: DoctorIssue[] = [];
  await checkRuntimeHealth(
    dir,
    fixIssues,
    fixesApplied,
    (code) => code === "stale_paused_session",
  );

  assert.equal(readPausedSessionMetadata(dir), null);
  assert.ok(
    fixesApplied.some((fix) => fix.includes(`cleared stale paused session for ${pausedMilestoneId}`)),
  );
  assert.equal(fixIssues.some((candidate) => candidate.code === "stale_paused_session"), false);

  openAutoPause({
    blockerKind: "user_request",
    activeEngineId: "custom-workflow",
    milestoneId: pausedMilestoneId,
    originalBasePath: dir,
  });
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
  assert.ok(readPausedSessionMetadata(dir));
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
  const evidenceStat = lstatSync(join(dir, ".gsd", evidencePath));
  writeFileSync(
    join(dir, ".gsd", "migration", "unbound-projection-evidence.json"),
    `${JSON.stringify([{
      evidenceId: `evidence:sha256:${createHash("sha256").update(JSON.stringify({
        evidencePath,
        kind: "quarantine",
        logicalPath: "notes/my notes/result.md",
        scope: "tree",
      })).digest("hex")}`,
      evidencePath,
      evidenceIdentity: `${evidenceStat.dev}:${evidenceStat.ino}`,
      contentDigest: `sha256:${createHash("sha256").update("later accepted work\n").digest("hex")}`,
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
  assert.match(issue.message, /--consent=discard:sha256:[0-9a-f]{64} deletes \.gsd\/notes\/my notes\/\.gsd-projection-remove-/u);
  assert.doesNotMatch(issue.message, /the projection itself/u);
  assert.equal(issue.fixable, false);
});

test("doctor says that discarding canonical evidence deletes the projection itself (#2846)", async (t) => {
  const dir = createGitProject();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Canonical evidence is the projection file: discard removes it, which the
  // printed command must say so an operator does not lose a merely stale
  // projection by picking the first option.
  mkdirSync(join(dir, ".gsd", "notes"), { recursive: true });
  mkdirSync(join(dir, ".gsd", "migration"), { recursive: true });
  writeFileSync(join(dir, ".gsd", "notes", "result.md"), "stale ledger\n");
  const evidenceStat = lstatSync(join(dir, ".gsd", "notes", "result.md"));
  writeFileSync(
    join(dir, ".gsd", "migration", "unbound-projection-evidence.json"),
    `${JSON.stringify([{
      evidenceId: `evidence:sha256:${createHash("sha256").update(JSON.stringify({
        evidencePath: "notes/result.md",
        kind: "canonical",
        logicalPath: "notes/result.md",
        scope: "file",
      })).digest("hex")}`,
      evidencePath: "notes/result.md",
      evidenceIdentity: `${evidenceStat.dev}:${evidenceStat.ino}`,
      contentDigest: `sha256:${createHash("sha256").update("stale ledger\n").digest("hex")}`,
      kind: "canonical",
      logicalPath: "notes/result.md",
      scope: "file",
      transition: "retained",
    }])}\n`,
  );

  const report = await runGSDDoctor(dir);
  const issue = report.issues.find(candidate => candidate.code === "unresolved_projection_evidence");
  assert.ok(issue);
  assert.match(
    issue.message,
    /--action=discard --consent=discard:sha256:[0-9a-f]{64} deletes \.gsd\/notes\/result\.md \(the projection itself; --action=restore keeps it in place\)/u,
  );
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

// #2648: a structural rejection used to surface as a bare "projection root
// contains an unsupported node" against a hard-coded path, leaving the
// rejected node unidentifiable and the doctor without anything to act on.
test("doctor names a directory occupying the evidence index (#2648)", async (t) => {
  const dir = createGitProject();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  mkdirSync(join(dir, ".gsd", "migration", "unbound-projection-evidence.json"), { recursive: true });

  const report = await runGSDDoctor(dir);
  const assessment = report.issues.find((candidate) => candidate.code === "unresolved_projection_evidence");
  assert.ok(assessment, "the failed assessment is still reported");
  assert.match(
    assessment.message,
    /obstructed by a directory: migration\/unbound-projection-evidence\.json/u,
  );
  const rejected = report.issues.filter((candidate) => candidate.code === "unsupported_projection_root_node");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]!.file, ".gsd/migration/unbound-projection-evidence.json");
  assert.equal(rejected[0]!.severity, "error");
  assert.equal(rejected[0]!.fixable, false);
  assert.match(rejected[0]!.message, /a directory where the projection protocol requires a regular file/u);
  assert.match(rejected[0]!.message, /move it out of \.gsd/u);
});

test("doctor keeps listing resolvable evidence beside a record that cannot be reviewed (#2815)", async (t) => {
  // With the addon present, trip the real health latch so the assessment takes
  // the same degraded path a tripped #2489 latch produces; without it the
  // store is already degraded.
  if (isProjectionRootIdentityLockAvailable()) _latchProjectionRootIdentityLockForTest();
  t.after(() => _resetProjectionRootIdentityLockHealthForTest());

  const dir = createGitProject();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const rootPath = join(dir, ".gsd");
  mkdirSync(join(rootPath, "notes"), { recursive: true });
  mkdirSync(join(rootPath, "migration"), { recursive: true });

  const healthy = "notes/.gsd-projection-remove-00000000-0000-0000-0000-000000000001";
  writeFileSync(join(rootPath, healthy), "reviewed bytes\n");
  const healthyStat = lstatSync(join(rootPath, healthy), { bigint: true });
  const healthyId = `evidence:sha256:${createHash("sha256")
    .update(JSON.stringify({ evidencePath: healthy, kind: "quarantine", logicalPath: "notes/result.md", scope: "file" }))
    .digest("hex")}`;
  // This record's evidence file is gone (a crash mid-resolution): its preview
  // throws and must not blank the assessment of the other records.
  const missing = "notes/.gsd-projection-remove-00000000-0000-0000-0000-000000000002";
  const missingId = `evidence:sha256:${createHash("sha256")
    .update(JSON.stringify({ evidencePath: missing, kind: "quarantine", logicalPath: "notes/other.md", scope: "file" }))
    .digest("hex")}`;
  writeFileSync(join(rootPath, "migration", "unbound-projection-evidence.json"), `${JSON.stringify([
    {
      evidenceId: healthyId,
      evidencePath: healthy,
      evidenceIdentity: `${healthyStat.dev}:${healthyStat.ino}`,
      contentDigest: `sha256:${createHash("sha256").update("reviewed bytes\n").digest("hex")}`,
      kind: "quarantine",
      logicalPath: "notes/result.md",
      scope: "file",
      transition: "retained",
    },
    {
      evidenceId: missingId,
      evidencePath: missing,
      evidenceIdentity: "1:1",
      contentDigest: `sha256:${createHash("sha256").update("gone\n").digest("hex")}`,
      kind: "quarantine",
      logicalPath: "notes/other.md",
      scope: "file",
      transition: "resolving",
      resolution: {
        action: "discard",
        currentIdentity: "1:1",
        contentDigest: `sha256:${createHash("sha256").update("gone\n").digest("hex")}`,
        destinationPath: null,
        guardPath: "notes/.gsd-projection-remove-11111111-2222-4333-8444-555555555555",
        guardIdentity: null,
        stagingPath: null,
        stagingIdentity: null,
        exchangePath: "notes/.gsd-projection-exchange-11111111-2222-4333-8444-555555555555",
        exchangeIdentity: null,
        phase: "prepared",
      },
    },
  ])}\n`);

  const report = await runGSDDoctor(dir);
  const issues = report.issues.filter((candidate) => candidate.code === "unresolved_projection_evidence");
  assert.ok(
    issues.some((candidate) => candidate.file === `.gsd/${healthy}`
      && /--action=discard --consent=discard:sha256:/u.test(candidate.message)),
    "the resolvable record still lists its resolution commands",
  );
  const unreviewable = issues.find((candidate) => candidate.file === `.gsd/${missing}`);
  assert.ok(unreviewable, "the unreviewable record is still reported");
  assert.match(unreviewable.message, /could not be reviewed/u);
});

test(
  "doctor keeps retained evidence listed when the lock rejects the projection root (#2648)",
  // The rejection comes from the native journal replay; the plain-fs fallback
  // never reads the journal, so there is nothing to degrade from without it.
  { skip: !isProjectionRootIdentityLockAvailable() },
  async (t) => {
    const dir = createGitProject();
    t.after(() => rmSync(dir, { recursive: true, force: true }));

    const evidencePath = "notes/.gsd-projection-remove-00000000-0000-0000-0000-000000000001";
    const obstructedEntry = "migration/projection-mutations/00000000-0000-0000-0000-000000000002.json";
    const indexPath = join(dir, ".gsd", "migration", "unbound-projection-evidence.json");
    mkdirSync(join(dir, ".gsd", evidencePath), { recursive: true });
    mkdirSync(join(dir, ".gsd", "migration"), { recursive: true });
    writeFileSync(join(dir, ".gsd", evidencePath, "later.md"), "later accepted work\n");
    writeFileSync(indexPath, `${JSON.stringify([{
      evidencePath,
      evidenceIdentity: null,
      kind: "quarantine",
      logicalPath: "notes/result.md",
      scope: "tree",
      transition: "retained",
    }])}\n`);
    // Persist the entry in the shape the engine records it (id, identity,
    // digest), which is what the lock-free reader requires.
    const [recorded] = loadUnboundProjectionEvidence(dir);
    assert.ok(recorded);
    const identity = lstatSync(join(dir, ".gsd", evidencePath), { bigint: true });
    writeFileSync(
      indexPath,
      `${JSON.stringify([{ ...recorded, evidenceIdentity: `${identity.dev}:${identity.ino}` }])}\n`,
    );
    // A directory where a journal entry belongs: every managed open replays
    // the journal first, so every managed open is rejected.
    const obstruction = join(dir, ".gsd", obstructedEntry);
    mkdirSync(obstruction, { recursive: true });

    const report = await runGSDDoctor(dir);
    const rejected = report.issues.filter((candidate) => candidate.code === "unsupported_projection_root_node");
    assert.deepEqual(rejected.map((candidate) => candidate.file), [`.gsd/${obstructedEntry}`]);
    const evidence = report.issues.filter((candidate) => candidate.code === "unresolved_projection_evidence");
    assert.ok(evidence.some((candidate) => candidate.message.includes(`obstructed by a directory: ${obstructedEntry}`)));
    const listed = evidence.find((candidate) => candidate.file === `.gsd/${evidencePath}`);
    assert.ok(listed, "retained evidence stays enumerable without the lock");
    assert.match(listed.message, /Listed without the native projection lock/u);
    assert.match(listed.message, /evidence:sha256:[0-9a-f]+ --action=discard --consent=discard:sha256:/u);
    assert.match(listed.message, /--action=preserve/u);
    assert.match(listed.message, /--action=restore/u);

    // Once the rejected node is gone the same commands are served by the lock.
    rmSync(obstruction, { recursive: true });
    const repaired = await runGSDDoctor(dir);
    assert.deepEqual(
      repaired.issues.filter((candidate) => candidate.code === "unsupported_projection_root_node"),
      [],
    );
    const relisted = repaired.issues.find((candidate) => candidate.file === `.gsd/${evidencePath}`);
    assert.ok(relisted);
    assert.equal(relisted.message, listed.message.replace(/ Listed without the native projection lock[^.]*\./u, ""));
  },
);

// Seeds pending journaled write exchanges whose targets were rewritten after
// journaling, so the journaled left identity no longer matches — the reported
// #2879 store. The lock closes before recovery runs.
function seedDriftedExchangeJournals(rootPath: string): void {
  mkdirSync(join(rootPath, "notes"), { recursive: true });
  mkdirSync(join(rootPath, "migration", "projection-mutations"), { recursive: true });
  const stat = lstatSync(rootPath, { bigint: true });
  const handle = acquireProjectionRootIdentityLock(rootPath, stat.dev.toString(), stat.ino.toString());
  try {
    for (const [slot, target] of [["a", "notes/result.md"], ["b", "notes/other.md"]] as const) {
      const uuid = `00000000-0000-0000-0000-0000000000${slot}`;
      const temporaryPath = `notes/.gsd-projection-tmp-${uuid}1`;
      const guardPath = `notes/.gsd-projection-exchange-${uuid}2`;
      const placeholderIdentity = handle.prepareFileTemporary(target, Buffer.alloc(0));
      const temporaryIdentity = handle.prepareFileTemporary(temporaryPath, Buffer.from(`replacement ${slot}\n`));
      const guardIdentity = handle.prepareFileTemporary(guardPath, Buffer.alloc(0));
      // Replace the target so the journaled left identity drifts on every
      // filesystem (an in-place rewrite keeps the inode on Linux).
      const rewritten = join(rootPath, `notes/.gsd-projection-tmp-${uuid}3`);
      writeFileSync(rewritten, `rewritten ${slot}\n`);
      rmSync(join(rootPath, target));
      renameSync(rewritten, join(rootPath, target));
      writeFileSync(join(rootPath, "migration", "projection-mutations", `${uuid.slice(0, -1)}0${slot}.json`), `${JSON.stringify({
        logicalPath: target,
        operation: "write",
        legacyCleanup: false,
        content: Buffer.from(`replacement ${slot}\n`).toString("base64"),
        encoding: "base64",
        temporaryPath,
        temporaryIdentity,
        replacementPath: `${temporaryPath}.replaced`,
        replacementIdentity: null,
        quarantinePath: null,
        quarantineIdentity: null,
        placeholderIdentity,
        exchangeGuardPath: guardPath,
        exchangeGuardIdentity: guardIdentity,
        exchangeState: {
          leftPath: target,
          rightPath: temporaryPath,
          leftIdentity: placeholderIdentity,
          rightIdentity: temporaryIdentity,
          guardPath,
          guardIdentity,
        },
      })}\n`);
    }
  } finally {
    handle.close();
  }
}

test(
  "doctor lists resolve commands for evidence a pending exchange retirement used to blank (#2879)",
  // The retirement comes from the native journal replay; without the lock the
  // load takes the lock-free path that never replays.
  { skip: !isProjectionRootIdentityLockAvailable() },
  async (t) => {
    const dir = createGitProject();
    t.after(() => {
      closeDatabase();
      rmSync(dir, { recursive: true, force: true });
    });
    const rootPath = join(dir, ".gsd");
    // The reported store: every managed open retired one entry per pass and
    // re-threw, so the assessment never got past the retirement error to list
    // the retained evidence.
    seedDriftedExchangeJournals(rootPath);
    assert.equal(openDatabase(join(rootPath, "gsd.db")), true);

    const report = await runGSDDoctor(dir);
    // The pass that retires the entries still assesses the evidence: every
    // retained row — including the ones this very pass retired — lists its
    // review commands instead of a single unassessable line.
    assert.equal(
      report.issues.some((candidate) => /could not be assessed/u.test(candidate.message)),
      false,
      "the retirement converges the entry instead of failing the assessment",
    );
    const evidence = loadUnboundProjectionEvidence(dir);
    assert.equal(evidence.length, 6);
    for (const record of evidence) {
      assert.equal(record.transition, "retained");
      assert.equal(record.resolution, undefined);
      const issue = report.issues.find((candidate) => candidate.code === "unresolved_projection_evidence"
        && candidate.message.includes(record.evidenceId));
      assert.ok(issue, `the row at .gsd/${record.evidencePath} lists its resolution commands`);
      assert.ok(
        issue.message.includes(`/gsd doctor resolve-evidence ${record.evidenceId} --action=discard --consent=`),
      );
    }

    // The rows settle under the reviewed consent, and a second pass adds
    // nothing: the growth loop is gone.
    for (const record of evidence) {
      const action = record.kind === "canonical" ? "preserve" : "discard";
      const { consent } = previewUnboundProjectionEvidenceResolution(dir, record.evidenceId, action);
      resolveUnboundProjectionEvidence(dir, record.evidenceId, action, consent);
    }
    assert.deepEqual(loadUnboundProjectionEvidence(dir), []);
    const second = await runGSDDoctor(dir);
    assert.deepEqual(
      second.issues.filter((candidate) => candidate.code === "unresolved_projection_evidence"),
      [],
    );
  },
);

test(
  "doctor names a junction the lock rejects inside the projection root (#2648)",
  // Junctions need no privilege on Windows, and only the Windows lock raises
  // the structural reparse-point rejection this scan answers.
  { skip: process.platform !== "win32" || !isProjectionRootIdentityLockAvailable() },
  async (t) => {
    const dir = createGitProject();
    const outside = mkdtempSync(join(tmpdir(), "gsd-doctor-runtime-checks-outside-"));
    t.after(() => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    });

    mkdirSync(join(dir, ".gsd"), { recursive: true });
    symlinkSync(outside, join(dir, ".gsd", "migration"), "junction");

    const report = await runGSDDoctor(dir);
    const rejected = report.issues.filter((candidate) => candidate.code === "unsupported_projection_root_node");
    assert.deepEqual(rejected.map((candidate) => candidate.file), [".gsd/migration"]);
    assert.match(rejected[0]!.message, /a symbolic link or junction/u);
  },
);
