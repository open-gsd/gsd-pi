/**
 * verifyExpectedArtifact behaviour after the DB cutover (ADR-017).
 *
 * Task completion is DB-authoritative: for `execute-task`, verification reads
 * the latest Task Attempt and nothing else. There is no longer a legacy branch
 * that reads a slice PLAN — with the DB open the Attempt decides, and with the
 * DB unavailable the unit fails closed. The #3607 checkbox-discrimination
 * tests that used to live here were retired for that reason (see
 * `docs/dev/state-db-cutover-milestone-decision.md`); a test that asserts
 * against an unreachable branch reads as protection that does not exist.
 *
 * What remains here:
 * - `execute-task` fails closed with a `recovery` warning when the DB is
 *   unavailable, and does not accept projection evidence when the DB is open
 *   but carries no settled Attempt Result.
 * - Artifact PATH resolution for the unit types that still resolve one:
 *   sibling/team-suffix phase dirs (#1500) and the worktree→project-root
 *   fallback (#852, #870).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { verifyExpectedArtifact } from "../auto-recovery.ts";
import { closeDatabase, insertMilestone, insertSlice, insertTask, isDbAvailable, openDatabase } from "../gsd-db.ts";
import { drainLogs, setStderrLoggingEnabled, _resetLogs, type LogEntry } from "../workflow-logger.ts";

/**
 * Run `verifyExpectedArtifact` with stderr suppressed, returning both the
 * result and the log entries the call emitted. The workflow-logger buffer is a
 * process-wide singleton, so it must be drained inside this scope.
 */
function verifyAndCaptureLogs(
  unitType: string,
  unitId: string,
  base: string,
): { result: boolean; logs: LogEntry[] } {
  const previous = setStderrLoggingEnabled(false);
  _resetLogs();
  try {
    const result = verifyExpectedArtifact(unitType, unitId, base);
    return { result, logs: drainLogs() };
  } finally {
    _resetLogs();
    setStderrLoggingEnabled(previous);
  }
}

/** Scaffold .gsd/milestones/M001/slices/S01/ with tasks/ and a T01-SUMMARY.md. */
function scaffoldProject(t: { after: (fn: () => void) => void }): {
  base: string;
  planPath: string;
} {
  const base = mkdtempSync(join(tmpdir(), "gsd-verify-artifact-"));
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });

  const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
  mkdirSync(join(sliceDir, "tasks"), { recursive: true });
  // Summary file must exist so verifyExpectedArtifact reaches the legacy branch
  writeFileSync(join(sliceDir, "tasks", "T01-SUMMARY.md"), "# T01 summary\n");
  return { base, planPath: join(sliceDir, "S01-PLAN.md") };
}

test("execute-task with the DB unavailable — checked checkbox [x] fails closed", (t) => {
  closeDatabase();
  assert.equal(isDbAvailable(), false, "DB must be closed to exercise the DB-unavailable path");

  const { base, planPath } = scaffoldProject(t);
  writeFileSync(
    planPath,
    [
      "# S01 plan",
      "",
      "- [x] **T01: Implement feature**",
      "",
    ].join("\n"),
  );

  const { result, logs } = verifyAndCaptureLogs("execute-task", "M001/S01/T01", base);

  assert.equal(
    result,
    false,
    "a checked checkbox is a projection, not authority — it must not verify completion",
  );
  const recovery = logs.find((e) => e.component === "recovery" && /verify-fail execute-task M001\/S01\/T01/u.test(e.message));
  assert.ok(recovery, "a recovery warning must name why completion could not be confirmed");
  assert.match(recovery!.message, /DB unavailable/u);
  assert.match(recovery!.message, /cannot confirm task completion/u);
});

test("execute-task with the DB unavailable — checked checkbox [X] (uppercase) also fails closed", (t) => {
  closeDatabase();
  const { base, planPath } = scaffoldProject(t);
  writeFileSync(
    planPath,
    [
      "# S01 plan",
      "",
      "- [X] **T01: Implement feature**",
    ].join("\n"),
  );

  const { result, logs } = verifyAndCaptureLogs("execute-task", "M001/S01/T01", base);

  assert.equal(result, false, "uppercase [X] is no more authoritative than lowercase [x]");
  const recovery = logs.find((e) => e.component === "recovery" && /verify-fail execute-task M001\/S01\/T01/u.test(e.message));
  assert.ok(recovery, "a recovery warning must be logged");
  assert.match(recovery!.message, /DB unavailable/u);
});

// The four #3607 negatives that stood here (unchecked `[ ]`, bare heading,
// missing plan, wrong task id) were deleted by T036. Each opened
// `closeDatabase()` and asserted `false`, but DB-closed `execute-task`
// verification now returns `false` unconditionally, so no fixture could make
// them fail. Checkbox discrimination is not a behaviour this codebase has any
// more; see the milestone decision doc's accepted residual risks.

test("execute-task DB branch ignores checked plan and summary without an Attempt Result", (t) => {
  closeDatabase();
  const { base, planPath } = scaffoldProject(t);
  openDatabase(join(base, ".gsd", "gsd.db"));
  assert.equal(isDbAvailable(), true, "DB must be open to hit the DB-lag branch");

  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Implement feature", status: "pending" });

  writeFileSync(
    planPath,
    [
      "# S01 plan",
      "",
      "- [x] **T01: Implement feature**",
    ].join("\n"),
  );

  assert.equal(
    verifyExpectedArtifact("execute-task", "M001/S01/T01", base),
    false,
    "DB-backed verification must not accept projection evidence without an Attempt Result",
  );
});

test("execute-task DB branch ignores legacy complete Task status without an Attempt Result", (t) => {
  closeDatabase();
  const { base, planPath } = scaffoldProject(t);
  openDatabase(join(base, ".gsd", "gsd.db"));

  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Implement feature", status: "complete" });
  writeFileSync(planPath, "- [x] **T01: Implement feature**\n");

  assert.equal(
    verifyExpectedArtifact("execute-task", "M001/S01/T01", base),
    false,
    "legacy Task completion and projections cannot replace canonical Attempt readiness",
  );
});

test("execute-task DB lag branch — summary without checked plan still fails", (t) => {
  closeDatabase();
  const { base, planPath } = scaffoldProject(t);
  openDatabase(join(base, ".gsd", "gsd.db"));

  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Implement feature", status: "pending" });

  writeFileSync(
    planPath,
    [
      "# S01 plan",
      "",
      "- [ ] **T01: Implement feature**",
    ].join("\n"),
  );

  assert.equal(
    verifyExpectedArtifact("execute-task", "M001/S01/T01", base),
    false,
    "pending DB status plus summary is insufficient without a checked task checkbox",
  );
});

// Two more #1500 fixtures stood here and were deleted by T036 for the same
// reason: both went through `verifyExpectedArtifact("execute-task", …)`, whose
// outcome no longer depends on any file on disk. The reseeded "SUMMARY in a
// stale sibling flat-phase dir" positive stayed green with the SUMMARY deleted
// (it only proved that a settled Attempt verifies), and the
// "does NOT borrow a summary from a different-milestone same-phase dir"
// negative asserted a `false` that is now unconditional. Sibling-dir
// resolution for execute-task is unreachable in both directions, so the
// team-suffix fallback it exercised was removed from
// `findExistingSiblingPhaseArtifact` too.

test("#1500: plan-milestone does NOT borrow a roadmap from a team-suffix sibling projection", (t) => {
  closeDatabase();
  const base = mkdtempSync(join(tmpdir(), "gsd-sibling-plan-milestone-"));
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });

  const phasesDir = join(base, ".gsd", "phases");
  // Canonical (non-team-suffix) phase dir the resolver picks lacks the roadmap;
  // only a deprioritized team-suffix projection dir carries a valid roadmap.
  const canonicalDir = join(phasesDir, "09-web-api");
  const teamSuffixDir = join(phasesDir, "09-obg27g-web-api");
  mkdirSync(canonicalDir, { recursive: true });
  mkdirSync(teamSuffixDir, { recursive: true });

  writeFileSync(
    join(teamSuffixDir, "09-ROADMAP.md"),
    [
      "# M009: Roadmap",
      "",
      "## Slices",
      "",
      "- [ ] **S01: First slice** `risk:low` `depends:[]`",
      "  > After this: a real slice exists.",
      "",
    ].join("\n"),
  );

  // The team-suffix fallback is reserved for execute-task recovery; plan-milestone
  // must not pass verification off a stale team-suffix projection's roadmap.
  assert.equal(
    verifyExpectedArtifact("plan-milestone", "M009", base),
    false,
    "plan-milestone must not accept a roadmap from a team-suffix sibling projection",
  );
});

// ── #852 follow-up: worktree→project-root artifact fallback ──────────────────
//
// A milestone running in a worktree may not have its CONTEXT projected into the
// worktree (the worktree only has the META dir until planning writes its
// projections). When verifyExpectedArtifact can't find the artifact at the
// worktree base, it must fall back to the project root — where the artifact
// genuinely lives. Without this, discuss-milestone verification returned false
// ("resolveExpectedArtifactPath returned null") and trapped the unit in a
// finalize-retry loop.

test("#852: discuss-milestone falls back to project root when CONTEXT not in worktree", () => {
  closeDatabase();
  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-wt-fallback-proj-"));
  try {
    // Flat-phase CONTEXT lives at the project root.
    const phaseDir = join(projectRoot, ".gsd", "phases", "15-m015");
    mkdirSync(phaseDir, { recursive: true });
    writeFileSync(join(phaseDir, "15-CONTEXT.md"), "# M015 context\n");

    // Simulate the worktree: exists, registered with git (.git file), but has
    // NO phases/ dir and no real CONTEXT — only the META dir git-service.ts
    // created. resolveCanonicalMilestoneRoot redirects here.
    const wtRoot = join(projectRoot, ".gsd", "worktrees", "M015");
    const wtGsd = join(wtRoot, ".gsd");
    mkdirSync(join(wtGsd, "milestones", "M015"), { recursive: true });
    writeFileSync(join(wtGsd, "milestones", "M015", "M015-META.json"), '{"branch":"milestone/M015"}');
    writeFileSync(join(wtRoot, ".git"), "gitdir: /fake/path");

    // Verification with the worktree as base must fall back to the project root
    // and find 15-CONTEXT.md there.
    assert.equal(
      verifyExpectedArtifact("discuss-milestone", "M015", projectRoot),
      true,
      "must fall back to project root when CONTEXT is not in the worktree",
    );
  } finally {
    closeDatabase();
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("#852: discuss-milestone passes when CONTEXT is in the worktree (no fallback needed)", () => {
  closeDatabase();
  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-wt-present-"));
  try {
    // CONTEXT lives in BOTH the project root AND the worktree.
    const projPhase = join(projectRoot, ".gsd", "phases", "15-m015");
    mkdirSync(projPhase, { recursive: true });
    writeFileSync(join(projPhase, "15-CONTEXT.md"), "# project context\n");

    const wtRoot = join(projectRoot, ".gsd", "worktrees", "M015");
    const wtGsd = join(wtRoot, ".gsd");
    const wtPhase = join(wtGsd, "phases", "15-m015");
    mkdirSync(wtPhase, { recursive: true });
    writeFileSync(join(wtPhase, "15-CONTEXT.md"), "# worktree context\n");
    writeFileSync(join(wtRoot, ".git"), "gitdir: /fake/path");

    assert.equal(
      verifyExpectedArtifact("discuss-milestone", "M015", projectRoot),
      true,
      "must pass when CONTEXT is in the worktree",
    );
  } finally {
    closeDatabase();
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("#852: discuss-milestone fails when CONTEXT is in neither worktree nor project root", () => {
  // If the artifact genuinely doesn't exist anywhere, verification must still
  // fail (fail-closed) — the fallback must not mask a real absence.
  closeDatabase();
  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-wt-absent-"));
  try {
    const wtRoot = join(projectRoot, ".gsd", "worktrees", "M015");
    mkdirSync(join(wtRoot, ".gsd", "milestones", "M015"), { recursive: true });
    writeFileSync(join(wtRoot, ".git"), "gitdir: /fake/path");
    // No phases/ anywhere, no CONTEXT anywhere.

    assert.equal(
      verifyExpectedArtifact("discuss-milestone", "M015", projectRoot),
      false,
      "must fail when CONTEXT exists in neither root",
    );
  } finally {
    closeDatabase();
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// #870: discuss-milestone verify-fail when the unit runs IN the worktree.
//
// The #852 tests above all pass `projectRoot` as the base. But the real call
// site (auto-post-unit.ts:1726) passes `s.currentUnit.workspaceRoot ?? s.basePath`
// — i.e. the WORKTREE path when the unit executed in a worktree. In the
// canonical layout (`<root>/.gsd-worktrees/<MID>/`) resolveCanonicalMilestoneRoot
// round-trips the worktree path back to itself, so `artifactBase === base` and
// the worktree→project-root fallback (guarded by `artifactBase !== base`) is
// skipped. CONTEXT is written to the project root, not projected into the
// worktree, so verification finds nothing → "existsSync false" → re-dispatch
// 3× → stuck-loop stop. These tests pin the real call site.
// ---------------------------------------------------------------------------

test("#870: discuss-milestone falls back to project root when base IS the canonical-layout worktree", () => {
  closeDatabase();
  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-canonical-wt-"));
  try {
    // CONTEXT lives ONLY at the project root (flat-phase layout).
    const phaseDir = join(projectRoot, ".gsd", "phases", "15-m015");
    mkdirSync(phaseDir, { recursive: true });
    writeFileSync(join(phaseDir, "15-CONTEXT.md"), "# M015 context\n");

    // Canonical-layout worktree: <root>/.gsd-worktrees/<MID>/. Registered
    // with git (.git file) so resolveCanonicalMilestoneRoot treats it as the
    // canonical milestone root — but it has NO phases/ projection.
    const wtRoot = join(projectRoot, ".gsd-worktrees", "M015");
    mkdirSync(join(wtRoot, ".gsd", "milestones", "M015"), { recursive: true });
    writeFileSync(join(wtRoot, ".gsd", "milestones", "M015", "M015-META.json"), '{"branch":"milestone/M015"}');
    writeFileSync(join(wtRoot, ".git"), "gitdir: /fake/path");

    // Real call site: base = worktree path (workspaceRoot).
    assert.equal(
      verifyExpectedArtifact("discuss-milestone", "M015", wtRoot),
      true,
      "must fall back to project root when base is the canonical-layout worktree",
    );
  } finally {
    closeDatabase();
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("#870: discuss-milestone also falls back when base is the legacy-layout worktree", () => {
  closeDatabase();
  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-legacy-wt-"));
  try {
    const phaseDir = join(projectRoot, ".gsd", "phases", "15-m015");
    mkdirSync(phaseDir, { recursive: true });
    writeFileSync(join(phaseDir, "15-CONTEXT.md"), "# M015 context\n");

    const wtRoot = join(projectRoot, ".gsd", "worktrees", "M015");
    mkdirSync(join(wtRoot, ".gsd", "milestones", "M015"), { recursive: true });
    writeFileSync(join(wtRoot, ".git"), "gitdir: /fake/path");

    assert.equal(
      verifyExpectedArtifact("discuss-milestone", "M015", wtRoot),
      true,
      "must fall back to project root when base is the legacy-layout worktree",
    );
  } finally {
    closeDatabase();
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
