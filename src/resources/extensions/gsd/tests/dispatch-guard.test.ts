import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveDispatch } from "../auto-dispatch.ts";
import { invalidateAllCaches } from "../cache.ts";
import { getPriorSliceCompletionBlocker } from "../dispatch-guard.ts";
import {
  openDatabase,
  closeDatabase,
  insertAssessment,
  insertMilestone,
  insertSlice,
  setSliceUatMd,
} from "../gsd-db.ts";
import { checkNeedsRunUat } from "../uat-dispatch.ts";

/** Helper: create temp dir and open an in-dir DB for dispatch-guard tests */
function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "gsd-dispatch-guard-"));
  mkdirSync(join(repo, ".gsd"), { recursive: true });
  openDatabase(join(repo, ".gsd", "gsd.db"));
  return repo;
}

/** Helper: tear down repo (close DB then remove dir) */
function teardownRepo(repo: string): void {
  closeDatabase();
  rmSync(repo, { recursive: true, force: true });
}

test("dispatch guard blocks when prior milestone has incomplete slices", (t) => {
  const repo = setupRepo();
  t.after(() => teardownRepo(repo));

  mkdirSync(join(repo, ".gsd", "milestones", "M002"), { recursive: true });
  mkdirSync(join(repo, ".gsd", "milestones", "M003"), { recursive: true });

  // Seed DB: M002 with S01 complete, S02 pending
  insertMilestone({ id: "M002", title: "Previous" });
  insertSlice({ id: "S01", milestoneId: "M002", title: "Done", status: "complete", depends: [], sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M002", title: "Pending", status: "pending", depends: ["S01"], sequence: 2 });

  // M003 with two pending slices
  insertMilestone({ id: "M003", title: "Current" });
  insertSlice({ id: "S01", milestoneId: "M003", title: "First", status: "pending", depends: [] });
  insertSlice({ id: "S02", milestoneId: "M003", title: "Second", status: "pending", depends: ["S01"] });

  // Projections may exist, but DB rows determine dispatch order.
  writeFileSync(join(repo, ".gsd", "milestones", "M002", "M002-ROADMAP.md"), "# M002\n");
  writeFileSync(join(repo, ".gsd", "milestones", "M003", "M003-ROADMAP.md"), "# M003\n");

  assert.equal(
    getPriorSliceCompletionBlocker(repo, "main", "plan-slice", "M003/S01"),
    "Cannot dispatch plan-slice M003/S01: earlier slice M002/S02 is not complete.",
  );
});

test("dispatch guard uses legacy DB ordering even when projections omit an earlier milestone", (t) => {
  const repo = setupRepo();
  t.after(() => teardownRepo(repo));
  mkdirSync(join(repo, ".gsd", "milestones", "M002"), { recursive: true });

  insertMilestone({ id: "M001", title: "Previous", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Pending", status: "pending", depends: [] });
  insertMilestone({ id: "M002", title: "Current", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M002", title: "Target", status: "pending", depends: [] });
  writeFileSync(join(repo, ".gsd", "milestones", "M002", "M002-ROADMAP.md"), "# M002\n");

  assert.equal(
    getPriorSliceCompletionBlocker(repo, "main", "plan-slice", "M002/S01"),
    "Cannot dispatch plan-slice M002/S01: earlier slice M001/S01 is not complete.",
  );
});

test("dispatch guard fails closed on missing legacy DB routing rows", (t) => {
  const repo = setupRepo();
  t.after(() => teardownRepo(repo));
  mkdirSync(join(repo, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(join(repo, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "# M001\n");

  assert.match(
    getPriorSliceCompletionBlocker(repo, "main", "plan-slice", "M001/S01") ?? "",
    /milestone M001 is missing from the workflow DB/i,
  );

  insertMilestone({ id: "M001", title: "Current", status: "active" });
  assert.match(
    getPriorSliceCompletionBlocker(repo, "main", "plan-slice", "M001/S01") ?? "",
    /has no slice rows in the workflow DB/i,
  );

  insertSlice({ id: "S02", milestoneId: "M001", title: "Other", status: "pending", depends: [] });
  assert.match(
    getPriorSliceCompletionBlocker(repo, "main", "plan-slice", "M001/S01") ?? "",
    /slice M001\/S01 is missing from the workflow DB/i,
  );
});

test("dispatch guard skips an earlier placeholder milestone with no slice rows (#1947)", (t) => {
  const repo = setupRepo();
  t.after(() => teardownRepo(repo));

  insertMilestone({ id: "M001", title: "Placeholder", status: "queued" });
  insertMilestone({ id: "M002", title: "Current", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M002", title: "Target", status: "pending", depends: [] });

  assert.equal(getPriorSliceCompletionBlocker(repo, "main", "plan-slice", "M002/S01"), null);
  assert.equal(getPriorSliceCompletionBlocker(repo, "main", "research-slice", "M002/parallel-research"), null);

  // The target milestone itself having no slice rows still fails closed.
  assert.match(
    getPriorSliceCompletionBlocker(repo, "main", "plan-slice", "M001/S01") ?? "",
    /milestone M001 has no slice rows in the workflow DB/i,
  );
});

test("dispatch guard fails closed when a declared dependency row is missing", (t) => {
  const repo = setupRepo();
  t.after(() => teardownRepo(repo));
  insertMilestone({ id: "M001", title: "Current", status: "active" });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Target", status: "pending", depends: ["S01"] });

  assert.match(
    getPriorSliceCompletionBlocker(repo, "main", "execute-task", "M001/S02/T01") ?? "",
    /dependency slice M001\/S01 is missing from the workflow DB/i,
  );
});

test("dispatch guard skips prior DB parked or deferred milestones without marker files", (t) => {
  const repo = setupRepo();
  t.after(() => teardownRepo(repo));

  mkdirSync(join(repo, ".gsd", "milestones", "M001"), { recursive: true });
  mkdirSync(join(repo, ".gsd", "milestones", "M002"), { recursive: true });
  mkdirSync(join(repo, ".gsd", "milestones", "M003"), { recursive: true });

  insertMilestone({ id: "M001", title: "Parked", status: "parked" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Incomplete", status: "pending", depends: [], sequence: 1 });

  insertMilestone({ id: "M002", title: "Deferred", status: "deferred" });
  insertSlice({ id: "S01", milestoneId: "M002", title: "Incomplete", status: "pending", depends: [], sequence: 1 });

  insertMilestone({ id: "M003", title: "Current", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M003", title: "First", status: "pending", depends: [], sequence: 1 });

  writeFileSync(join(repo, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "# M001\n");
  writeFileSync(join(repo, ".gsd", "milestones", "M002", "M002-ROADMAP.md"), "# M002\n");
  writeFileSync(join(repo, ".gsd", "milestones", "M003", "M003-ROADMAP.md"), "# M003\n");

  assert.equal(
    getPriorSliceCompletionBlocker(repo, "main", "plan-slice", "M003/S01"),
    null,
  );
});

test("dispatch guard blocks later slice in same milestone when earlier incomplete", (t) => {
  const repo = setupRepo();
  t.after(() => teardownRepo(repo));

  mkdirSync(join(repo, ".gsd", "milestones", "M002"), { recursive: true });
  mkdirSync(join(repo, ".gsd", "milestones", "M003"), { recursive: true });

  insertMilestone({ id: "M002", title: "Previous" });
  insertSlice({ id: "S01", milestoneId: "M002", title: "Done", status: "complete", depends: [], sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M002", title: "Done", status: "complete", depends: ["S01"], sequence: 2 });

  insertMilestone({ id: "M003", title: "Current" });
  insertSlice({ id: "S01", milestoneId: "M003", title: "First", status: "pending", depends: [], sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M003", title: "Second", status: "pending", depends: ["S01"], sequence: 2 });

  writeFileSync(join(repo, ".gsd", "milestones", "M002", "M002-ROADMAP.md"), "# M002\n");
  writeFileSync(join(repo, ".gsd", "milestones", "M003", "M003-ROADMAP.md"), "# M003\n");

  assert.equal(
    getPriorSliceCompletionBlocker(repo, "main", "execute-task", "M003/S02/T01"),
    "Cannot dispatch execute-task M003/S02/T01: dependency slice M003/S01 is not complete.",
  );
});

test("dispatch guard allows dispatch when all earlier slices complete", (t) => {
  const repo = setupRepo();
  t.after(() => teardownRepo(repo));

  mkdirSync(join(repo, ".gsd", "milestones", "M003"), { recursive: true });

  insertMilestone({ id: "M003", title: "Current" });
  insertSlice({ id: "S01", milestoneId: "M003", title: "First", status: "complete", depends: [], sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M003", title: "Second", status: "pending", depends: ["S01"], sequence: 2 });

  writeFileSync(join(repo, ".gsd", "milestones", "M003", "M003-ROADMAP.md"), "# M003\n");

  assert.equal(getPriorSliceCompletionBlocker(repo, "main", "execute-task", "M003/S02/T01"), null);
  assert.equal(getPriorSliceCompletionBlocker(repo, "main", "plan-milestone", "M003"), null);
});

test("dispatch guard exempts the parallel-research sentinel from slice DB presence (#1616)", (t) => {
  const repo = setupRepo();
  t.after(() => teardownRepo(repo));

  mkdirSync(join(repo, ".gsd", "milestones", "M042"), { recursive: true });
  mkdirSync(join(repo, ".gsd", "milestones", "M043"), { recursive: true });

  insertMilestone({ id: "M042", title: "Previous" });
  insertSlice({ id: "S01", milestoneId: "M042", title: "Done", status: "complete", depends: [], sequence: 1 });

  // M043 has real slices S01-S02; "parallel-research" is never inserted by design.
  insertMilestone({ id: "M043", title: "Current" });
  insertSlice({ id: "S01", milestoneId: "M043", title: "First", status: "pending", depends: [], sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M043", title: "Second", status: "pending", depends: [], sequence: 2 });

  writeFileSync(join(repo, ".gsd", "milestones", "M042", "M042-ROADMAP.md"), "# M042\n");
  writeFileSync(join(repo, ".gsd", "milestones", "M043", "M043-ROADMAP.md"), "# M043\n");

  assert.equal(
    getPriorSliceCompletionBlocker(repo, "main", "research-slice", "M043/parallel-research"),
    null,
  );

  // Real slice ids are still checked against the DB.
  assert.match(
    getPriorSliceCompletionBlocker(repo, "main", "research-slice", "M043/S99") ?? "",
    /slice M043\/S99 is missing from the workflow DB/i,
  );
});

test("dispatch guard still blocks parallel-research when an earlier milestone is incomplete (#1616)", (t) => {
  const repo = setupRepo();
  t.after(() => teardownRepo(repo));

  mkdirSync(join(repo, ".gsd", "milestones", "M042"), { recursive: true });
  mkdirSync(join(repo, ".gsd", "milestones", "M043"), { recursive: true });

  insertMilestone({ id: "M042", title: "Previous" });
  insertSlice({ id: "S01", milestoneId: "M042", title: "Pending", status: "pending", depends: [], sequence: 1 });

  insertMilestone({ id: "M043", title: "Current" });
  insertSlice({ id: "S01", milestoneId: "M043", title: "First", status: "pending", depends: [], sequence: 1 });

  writeFileSync(join(repo, ".gsd", "milestones", "M042", "M042-ROADMAP.md"), "# M042\n");
  writeFileSync(join(repo, ".gsd", "milestones", "M043", "M043-ROADMAP.md"), "# M043\n");

  assert.equal(
    getPriorSliceCompletionBlocker(repo, "main", "research-slice", "M043/parallel-research"),
    "Cannot dispatch research-slice M043/parallel-research: earlier slice M042/S01 is not complete.",
  );
});

test("dispatch guard unblocks slice when positionally-earlier slice depends on it (#1638)", (t) => {
  // S05 depends on S06, but S05 appears first positionally.
  // Old behavior: S06 blocked because S05 (positionally earlier) is incomplete.
  // Fixed behavior: S06 has no unmet dependencies, so it can dispatch.
  const repo = setupRepo();
  t.after(() => teardownRepo(repo));

  mkdirSync(join(repo, ".gsd", "milestones", "M001"), { recursive: true });

  insertMilestone({ id: "M001", title: "Test" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Setup", status: "complete", depends: [], sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Core", status: "complete", depends: ["S01"], sequence: 2 });
  insertSlice({ id: "S03", milestoneId: "M001", title: "API", status: "complete", depends: ["S02"], sequence: 3 });
  insertSlice({ id: "S04", milestoneId: "M001", title: "Auth", status: "complete", depends: ["S03"], sequence: 4 });
  insertSlice({ id: "S05", milestoneId: "M001", title: "Integration", status: "pending", depends: ["S04", "S06"], sequence: 5 });
  insertSlice({ id: "S06", milestoneId: "M001", title: "Data Layer", status: "pending", depends: ["S04"], sequence: 6 });

  writeFileSync(join(repo, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "# M001\n");

  // S06 depends only on S04 (complete) — should be unblocked
  assert.equal(
    getPriorSliceCompletionBlocker(repo, "main", "plan-slice", "M001/S06"),
    null,
  );

  // S05 depends on S04 (complete) and S06 (incomplete) — should be blocked
  assert.equal(
    getPriorSliceCompletionBlocker(repo, "main", "plan-slice", "M001/S05"),
    "Cannot dispatch plan-slice M001/S05: dependency slice M001/S06 is not complete.",
  );
});

test("dispatch guard falls back to positional ordering when no dependencies declared", (t) => {
  const repo = setupRepo();
  t.after(() => teardownRepo(repo));

  mkdirSync(join(repo, ".gsd", "milestones", "M001"), { recursive: true });

  insertMilestone({ id: "M001", title: "Test" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "First", status: "complete", depends: [], sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Second", status: "pending", depends: [], sequence: 2 });
  insertSlice({ id: "S03", milestoneId: "M001", title: "Third", status: "pending", depends: [], sequence: 3 });

  writeFileSync(join(repo, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "# M001\n");

  // S03 has no dependencies — positional fallback blocks on S02
  assert.equal(
    getPriorSliceCompletionBlocker(repo, "main", "plan-slice", "M001/S03"),
    "Cannot dispatch plan-slice M001/S03: earlier slice M001/S02 is not complete.",
  );

  // S02 has no dependencies — positional fallback: S01 is done, so unblocked
  assert.equal(
    getPriorSliceCompletionBlocker(repo, "main", "plan-slice", "M001/S02"),
    null,
  );
});

test("dispatch guard ignores positionally-earlier reverse dependents for zero-dependency slices (#3720)", (t) => {
  const repo = setupRepo();
  t.after(() => teardownRepo(repo));

  mkdirSync(join(repo, ".gsd", "milestones", "M015"), { recursive: true });

  insertMilestone({ id: "M015", title: "Reverse dependency fallback" });
  insertSlice({ id: "S03", milestoneId: "M015", title: "Complete prerequisite", status: "complete", depends: [], sequence: 0 });
  insertSlice({ id: "S04", milestoneId: "M015", title: "Depends on S04A", status: "pending", depends: ["S03", "S04A"], sequence: 0 });
  insertSlice({ id: "S04A", milestoneId: "M015", title: "No explicit deps", status: "pending", depends: [], sequence: 0 });

  writeFileSync(join(repo, ".gsd", "milestones", "M015", "M015-ROADMAP.md"), "# M015\n");

  // S04A has no declared dependencies and should not be blocked by S04, because
  // S04 itself depends on S04A. With sequence=0, DB ordering falls back to id.
  assert.equal(
    getPriorSliceCompletionBlocker(repo, "main", "execute-task", "M015/S04A/T02"),
    null,
  );

  // The reverse direction is still blocked normally.
  assert.equal(
    getPriorSliceCompletionBlocker(repo, "main", "execute-task", "M015/S04/T01"),
    "Cannot dispatch execute-task M015/S04/T01: dependency slice M015/S04A is not complete.",
  );
});

test("dispatch guard treats zero-dependency slices as independent when a milestone uses explicit deps (#3998)", (t) => {
  const repo = setupRepo();
  t.after(() => teardownRepo(repo));

  mkdirSync(join(repo, ".gsd", "milestones", "M022"), { recursive: true });

  insertMilestone({ id: "M022", title: "Mixed dependency milestone" });
  insertSlice({ id: "S02", milestoneId: "M022", title: "Core A", status: "complete", depends: [], sequence: 2 });
  insertSlice({ id: "S03", milestoneId: "M022", title: "Core B", status: "complete", depends: [], sequence: 3 });
  insertSlice({ id: "S05", milestoneId: "M022", title: "Blocked integration", status: "pending", depends: ["S02", "S03", "S07"], sequence: 5 });
  insertSlice({ id: "S06", milestoneId: "M022", title: "Independent zero-dep slice", status: "pending", depends: [], sequence: 6 });
  insertSlice({ id: "S07", milestoneId: "M022", title: "Late prerequisite", status: "pending", depends: ["S02"], sequence: 7 });

  writeFileSync(join(repo, ".gsd", "milestones", "M022", "M022-ROADMAP.md"), "# M022\n");

  assert.equal(
    getPriorSliceCompletionBlocker(repo, "main", "execute-task", "M022/S06/T02"),
    null,
  );

  assert.equal(
    getPriorSliceCompletionBlocker(repo, "main", "execute-task", "M022/S05/T01"),
    "Cannot dispatch execute-task M022/S05/T01: dependency slice M022/S07 is not complete.",
  );
});

test("dispatch guard allows slice with all declared dependencies complete", (t) => {
  const repo = setupRepo();
  t.after(() => teardownRepo(repo));

  mkdirSync(join(repo, ".gsd", "milestones", "M001"), { recursive: true });

  insertMilestone({ id: "M001", title: "Test" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Setup", status: "complete", depends: [], sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Core", status: "complete", depends: ["S01"], sequence: 2 });
  insertSlice({ id: "S03", milestoneId: "M001", title: "Feature A", status: "pending", depends: ["S01", "S02"], sequence: 3 });
  insertSlice({ id: "S04", milestoneId: "M001", title: "Feature B", status: "pending", depends: ["S01"], sequence: 4 });

  writeFileSync(join(repo, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "# M001\n");

  // S03 depends on S01 (done) and S02 (done) — unblocked
  assert.equal(
    getPriorSliceCompletionBlocker(repo, "main", "plan-slice", "M001/S03"),
    null,
  );

  // S04 depends only on S01 (done) — unblocked even though S03 is incomplete
  assert.equal(
    getPriorSliceCompletionBlocker(repo, "main", "plan-slice", "M001/S04"),
    null,
  );
});

test("dispatch guard does not skip prior milestone from SUMMARY projection when DB is not closed", (t) => {
  const repo = setupRepo();
  t.after(() => teardownRepo(repo));

  mkdirSync(join(repo, ".gsd", "milestones", "M001"), { recursive: true });
  mkdirSync(join(repo, ".gsd", "milestones", "M002"), { recursive: true });

  // M001 has a successful SUMMARY projection but is not closed in the DB.
  insertMilestone({ id: "M001", title: "Previous" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Core", status: "complete", depends: [], sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Tests", status: "complete", depends: ["S01"], sequence: 2 });
  insertSlice({ id: "S03-R", milestoneId: "M001", title: "Remediation", status: "pending", depends: ["S02"], sequence: 3 });
  insertSlice({ id: "S04-R", milestoneId: "M001", title: "Remediation 2", status: "pending", depends: ["S02"], sequence: 4 });

  insertMilestone({ id: "M002", title: "Current" });
  insertSlice({ id: "S01", milestoneId: "M002", title: "Start", status: "pending", depends: [], sequence: 1 });

  // M001 SUMMARY on disk must not trigger skip while DB remains open/active.
  writeFileSync(join(repo, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "# M001\n");
  writeFileSync(join(repo, ".gsd", "milestones", "M001", "M001-SUMMARY.md"),
    "---\nstatus: complete\n---\n# M001 Summary\nDone.\n");
  writeFileSync(join(repo, ".gsd", "milestones", "M002", "M002-ROADMAP.md"), "# M002\n");

  assert.equal(
    getPriorSliceCompletionBlocker(repo, "main", "plan-slice", "M002/S01"),
    "Cannot dispatch plan-slice M002/S01: earlier slice M001/S03-R is not complete.",
  );
});

test("dispatch guard does not skip failed milestone SUMMARY without blocker prose", (t) => {
  const repo = setupRepo();
  t.after(() => teardownRepo(repo));

  mkdirSync(join(repo, ".gsd", "milestones", "M001"), { recursive: true });
  mkdirSync(join(repo, ".gsd", "milestones", "M002"), { recursive: true });

  insertMilestone({ id: "M001", title: "Previous" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Core", status: "complete", depends: [], sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Unfinished", status: "pending", depends: ["S01"], sequence: 2 });

  insertMilestone({ id: "M002", title: "Current" });
  insertSlice({ id: "S01", milestoneId: "M002", title: "Start", status: "pending", depends: [], sequence: 1 });

  writeFileSync(join(repo, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "# M001\n");
  writeFileSync(join(repo, ".gsd", "milestones", "M001", "M001-SUMMARY.md"),
    "---\nstatus: failed\n---\n# M001 Summary\nRecovery stopped.\n");
  writeFileSync(join(repo, ".gsd", "milestones", "M002", "M002-ROADMAP.md"), "# M002\n");

  assert.equal(
    getPriorSliceCompletionBlocker(repo, "main", "plan-slice", "M002/S01"),
    "Cannot dispatch plan-slice M002/S01: earlier slice M001/S02 is not complete.",
  );
});

test("dispatch guard works without git repo", (t) => {
  const repo = setupRepo();
  t.after(() => teardownRepo(repo));

  mkdirSync(join(repo, ".gsd", "milestones", "M001"), { recursive: true });

  insertMilestone({ id: "M001", title: "Test" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Done", status: "complete", depends: [], sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Pending", status: "pending", depends: ["S01"], sequence: 2 });

  writeFileSync(join(repo, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "# M001\n");

  assert.equal(getPriorSliceCompletionBlocker(repo, "main", "plan-slice", "M001/S02"), null);
});

test("dispatch guard skips cross-milestone check when GSD_MILESTONE_LOCK is set (#2797)", (t) => {
  const repo = setupRepo();
  t.after(() => {
    delete process.env.GSD_MILESTONE_LOCK;
    teardownRepo(repo);
  });

  mkdirSync(join(repo, ".gsd", "milestones", "M010"), { recursive: true });
  mkdirSync(join(repo, ".gsd", "milestones", "M011"), { recursive: true });
  mkdirSync(join(repo, ".gsd", "milestones", "M012"), { recursive: true });

  // M010 and M011 have incomplete slices
  insertMilestone({ id: "M010", title: "Analytics" });
  insertSlice({ id: "S01", milestoneId: "M010", title: "Data Quality", status: "pending", depends: [], sequence: 1 });

  insertMilestone({ id: "M011", title: "Builder Onboarding" });
  insertSlice({ id: "S01", milestoneId: "M011", title: "Schema", status: "pending", depends: [], sequence: 1 });

  insertMilestone({ id: "M012", title: "Shared Components" });
  insertSlice({ id: "S01", milestoneId: "M012", title: "Foundation", status: "pending", depends: [], sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M012", title: "Migrate Pages", status: "pending", depends: ["S01"], sequence: 2 });

  writeFileSync(join(repo, ".gsd", "milestones", "M010", "M010-ROADMAP.md"), "# M010\n");
  writeFileSync(join(repo, ".gsd", "milestones", "M011", "M011-ROADMAP.md"), "# M011\n");
  writeFileSync(join(repo, ".gsd", "milestones", "M012", "M012-ROADMAP.md"), "# M012\n");

  // Without lock: M012 blocked by M010's incomplete S01
  delete process.env.GSD_MILESTONE_LOCK;
  assert.match(
    getPriorSliceCompletionBlocker(repo, "main", "execute-task", "M012/S01/T01") ?? "",
    /earlier slice M010\/S01 is not complete/,
  );

  // With lock: M012 only checks its own intra-milestone deps — S01 has none, so unblocked
  process.env.GSD_MILESTONE_LOCK = "M012";
  assert.equal(
    getPriorSliceCompletionBlocker(repo, "main", "execute-task", "M012/S01/T01"),
    null,
  );

  // With lock: M012/S02 still blocked by M012/S01 (intra-milestone dep preserved)
  assert.equal(
    getPriorSliceCompletionBlocker(repo, "main", "execute-task", "M012/S02/T01"),
    "Cannot dispatch execute-task M012/S02/T01: dependency slice M012/S01 is not complete.",
  );
});

// ─── G6: UAT evidence before dependency unlock ────────────────────────────

const RUNTIME_UAT = ["# S01 UAT", "", "## UAT Type", "- UAT mode: runtime-executable"].join("\n");
const ARTIFACT_UAT = ["# S01 UAT", "", "## UAT Type", "- UAT mode: artifact-driven"].join("\n");

function writeProjectPreferences(repo: string, uatDispatch: boolean): void {
  writeFileSync(join(repo, ".gsd", "PREFERENCES.md"), `---\nuat_dispatch: ${uatDispatch}\n---\n`);
  invalidateAllCaches();
}

function saveUatVerdict(status: string): void {
  insertAssessment({
    path: ".gsd/milestones/M001/slices/S01/S01-ASSESSMENT.md",
    milestoneId: "M001",
    sliceId: "S01",
    status,
    scope: "run-uat",
    fullContent: `verdict: ${status.toUpperCase()}`,
  });
}

test("a dependent slice stays blocked until its dependency has a UAT verdict (G6)", async (t) => {
  const repo = setupRepo();
  t.after(() => teardownRepo(repo));
  writeProjectPreferences(repo, false);

  insertMilestone({ id: "M001", title: "Test" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Runtime", status: "complete", depends: [], sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Dependent", status: "pending", depends: ["S01"], sequence: 2 });
  setSliceUatMd("M001", "S01", RUNTIME_UAT);

  assert.equal(
    getPriorSliceCompletionBlocker(repo, "main", "execute-task", "M001/S02/T01"),
    "Cannot dispatch execute-task M001/S02/T01: dependency slice M001/S01 has no UAT verdict.",
  );
  // The blocked slice is not stuck: the run-uat rule has a UAT run to dispatch for S01.
  assert.deepEqual(
    await checkNeedsRunUat(repo, "M001", { uat_dispatch: false }),
    { sliceId: "S01", uatType: "runtime-executable" },
  );

  saveUatVerdict("pass");

  assert.equal(getPriorSliceCompletionBlocker(repo, "main", "execute-task", "M001/S02/T01"), null);
});

test("a later slice in positional order stays blocked until the earlier slice has a UAT verdict (G6)", (t) => {
  const repo = setupRepo();
  t.after(() => teardownRepo(repo));
  writeProjectPreferences(repo, false);

  insertMilestone({ id: "M001", title: "Test" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Runtime", status: "complete", depends: [], sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Next", status: "pending", depends: [], sequence: 2 });
  setSliceUatMd("M001", "S01", RUNTIME_UAT);

  assert.equal(
    getPriorSliceCompletionBlocker(repo, "main", "plan-slice", "M001/S02"),
    "Cannot dispatch plan-slice M001/S02: earlier slice M001/S01 has no UAT verdict.",
  );

  // A saved verdict releases the next slice. Milestone closeout judges whether it is acceptable.
  saveUatVerdict("fail");

  assert.equal(getPriorSliceCompletionBlocker(repo, "main", "plan-slice", "M001/S02"), null);
});

test("a slice whose UAT is not dispatched releases its dependents; uat_dispatch makes it hold them (G6)", (t) => {
  const repo = setupRepo();
  t.after(() => teardownRepo(repo));
  writeProjectPreferences(repo, false);

  insertMilestone({ id: "M001", title: "Test" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Artifact", status: "complete", depends: [], sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Dependent", status: "pending", depends: ["S01"], sequence: 2 });
  setSliceUatMd("M001", "S01", ARTIFACT_UAT);

  assert.equal(getPriorSliceCompletionBlocker(repo, "main", "plan-slice", "M001/S02"), null);

  writeProjectPreferences(repo, true);

  assert.equal(
    getPriorSliceCompletionBlocker(repo, "main", "plan-slice", "M001/S02"),
    "Cannot dispatch plan-slice M001/S02: dependency slice M001/S01 has no UAT verdict.",
  );
});

for (const depends of [["S01"], []]) {
  const order = depends.length > 0 ? "a dependency" : "an earlier slice";
  test(`a summarizing slice gets a dispatchable unit while ${order} awaits its UAT verdict (G6)`, async (t) => {
    const repo = setupRepo();
    t.after(() => teardownRepo(repo));
    writeProjectPreferences(repo, false);

    insertMilestone({ id: "M001", title: "Test", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Runtime", status: "complete", depends: [], sequence: 1 });
    insertSlice({ id: "S02", milestoneId: "M001", title: "Summarizing", status: "in_progress", depends, sequence: 2 });
    setSliceUatMd("M001", "S01", RUNTIME_UAT);

    // The same two steps as the auto loop: the rule table picks the unit, then the guard judges it.
    const action = await resolveDispatch({
      basePath: repo,
      mid: "M001",
      midTitle: "Test",
      state: {
        activeMilestone: { id: "M001", title: "Test" },
        activeSlice: { id: "S02", title: "Summarizing" },
        activeTask: null,
        phase: "summarizing",
        recentDecisions: [],
        blockers: [],
        nextAction: "",
        registry: [],
      },
      prefs: { uat_dispatch: false },
    });

    assert.ok(action.action === "dispatch", `expected a unit, got ${action.action}`);
    assert.equal(getPriorSliceCompletionBlocker(repo, "main", action.unitType, action.unitId), null);
    // The hold stays on new work for the slice.
    assert.match(
      getPriorSliceCompletionBlocker(repo, "main", "execute-task", "M001/S02/T01") ?? "",
      /M001\/S01 has no UAT verdict\.$/,
    );
  });
}
