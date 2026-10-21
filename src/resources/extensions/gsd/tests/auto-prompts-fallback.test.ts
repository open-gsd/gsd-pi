import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildSourceFilePaths,
  checkNeedsReassessment,
  inlineDependencySummaries,
  loadRoadmapCompletedSliceCandidates,
} from "../auto-prompts.ts";
import {
  closeDatabase,
  insertMilestone,
  insertSlice,
  openDatabase,
} from "../gsd-db.ts";
import { relSliceFile } from "../paths.ts";

// Regression test for #4416: the fallback string must not mention `rg` because
// auto-mode runs on systems where ripgrep is not installed (e.g. Windows).
test("buildSourceFilePaths fallback does not reference rg or ripgrep", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-prompts-fallback-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  // No GSD files exist in tmp — forces the fallback branch.
  const result = buildSourceFilePaths(tmp, "M001");

  assert.ok(
    !result.includes("rg ") && !result.includes("`rg`") && !result.includes("ripgrep"),
    `Fallback string must not reference rg/ripgrep. Got: ${result}`,
  );
  assert.ok(result.length > 0, "Fallback string must not be empty");
});

test("buildSourceFilePaths with sid also produces rg-free fallback", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-prompts-fallback-sid-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const result = buildSourceFilePaths(tmp, "M001", "S01");

  assert.ok(
    !result.includes("rg ") && !result.includes("`rg`") && !result.includes("ripgrep"),
    `Fallback string must not reference rg/ripgrep. Got: ${result}`,
  );
});

// Post-cutover prompt context is sourced from DB rows; these tests pin the
// emitted prompt text for a DB-seeded project state.

function seedDb(base: string): void {
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
}

test("inlineDependencySummaries sources depends from DB rows and inlines the dep summary", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-prompts-db-deps-"));
  t.after(() => {
    closeDatabase();
    rmSync(tmp, { recursive: true, force: true });
  });
  seedDb(tmp);
  insertMilestone({ id: "M001", title: "M001: Deps", status: "active" });
  insertSlice({ milestoneId: "M001", id: "S01", title: "Foundation", status: "complete", sequence: 1 });
  insertSlice({ milestoneId: "M001", id: "S02", title: "Build", status: "pending", depends: ["S01"], sequence: 2 });

  const summaryDir = join(tmp, ".gsd", "milestones", "M001", "slices", "S01");
  mkdirSync(summaryDir, { recursive: true });
  writeFileSync(join(summaryDir, "S01-SUMMARY.md"), "# S01 Summary\n\nDid things.\n");

  const rel = relSliceFile(tmp, "M001", "S01", "SUMMARY");
  const result = await inlineDependencySummaries("M001", "S02", tmp);
  assert.equal(
    result,
    `#### S01 Summary\nSource: \`${rel}\`\n\n# S01 Summary\n\nDid things.`,
  );
});

test("inlineDependencySummaries points at the dep summary path when the file is missing", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-prompts-db-deps-missing-"));
  t.after(() => {
    closeDatabase();
    rmSync(tmp, { recursive: true, force: true });
  });
  seedDb(tmp);
  insertMilestone({ id: "M001", title: "M001: Deps", status: "active" });
  insertSlice({ milestoneId: "M001", id: "S01", title: "Foundation", status: "complete", sequence: 1 });
  insertSlice({ milestoneId: "M001", id: "S02", title: "Build", status: "pending", depends: ["S01"], sequence: 2 });

  const rel = relSliceFile(tmp, "M001", "S01", "SUMMARY");
  const result = await inlineDependencySummaries("M001", "S02", tmp);
  assert.equal(result, `- \`${rel}\` _(not found)_`);
});

test("inlineDependencySummaries reports no dependencies from an empty DB depends list", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-prompts-db-no-deps-"));
  t.after(() => {
    closeDatabase();
    rmSync(tmp, { recursive: true, force: true });
  });
  seedDb(tmp);
  insertMilestone({ id: "M001", title: "M001: Deps", status: "active" });
  insertSlice({ milestoneId: "M001", id: "S01", title: "Foundation", status: "pending", sequence: 1 });

  const result = await inlineDependencySummaries("M001", "S01", tmp);
  assert.equal(result, "- (no dependencies)");
});

test("loadRoadmapCompletedSliceCandidates reads completed slices from DB rows", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-prompts-db-uat-"));
  t.after(() => {
    closeDatabase();
    rmSync(tmp, { recursive: true, force: true });
  });
  seedDb(tmp);
  insertMilestone({ id: "M001", title: "M001: UAT", status: "active" });
  insertSlice({ milestoneId: "M001", id: "S01", title: "One", status: "complete", sequence: 1 });
  insertSlice({ milestoneId: "M001", id: "S02", title: "Two", status: "pending", sequence: 2 });
  insertSlice({ milestoneId: "M001", id: "S03", title: "Three", status: "complete", sequence: 3 });

  const candidates = await loadRoadmapCompletedSliceCandidates(tmp, "M001");
  assert.deepEqual(candidates, [{ sliceId: "S03" }, { sliceId: "S01" }]);
});

// Regression: the DB status column is free-form, so migrated/imported projects
// still store closed slices as "done" or "closed". The roadmap checkbox this
// read replaced rendered those `[x]`, so they must stay UAT candidates — an
// equality check against "complete" silently drops them and run-uat never
// dispatches. "skipped" is closed but produced no work, so it stays excluded.
test("loadRoadmapCompletedSliceCandidates treats legacy done/closed rows as candidates", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-prompts-db-uat-legacy-"));
  t.after(() => {
    closeDatabase();
    rmSync(tmp, { recursive: true, force: true });
  });
  seedDb(tmp);
  insertMilestone({ id: "M001", title: "M001: UAT", status: "active" });
  insertSlice({ milestoneId: "M001", id: "S01", title: "One", status: "done", sequence: 1 });
  insertSlice({ milestoneId: "M001", id: "S02", title: "Two", status: "closed", sequence: 2 });
  insertSlice({ milestoneId: "M001", id: "S03", title: "Three", status: "skipped", sequence: 3 });
  insertSlice({ milestoneId: "M001", id: "S04", title: "Four", status: "pending", sequence: 4 });
  insertSlice({ milestoneId: "M001", id: "S05", title: "Five", status: "complete", sequence: 5 });

  const candidates = await loadRoadmapCompletedSliceCandidates(tmp, "M001");
  assert.deepEqual(candidates, [{ sliceId: "S05" }, { sliceId: "S02" }, { sliceId: "S01" }]);
});

test("checkNeedsReassessment treats a legacy done slice as the last completed slice", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-prompts-db-reassess-legacy-"));
  t.after(() => {
    closeDatabase();
    rmSync(tmp, { recursive: true, force: true });
  });
  seedDb(tmp);
  insertMilestone({ id: "M001", title: "M001: Reassess", status: "active" });
  insertSlice({ milestoneId: "M001", id: "S01", title: "One", status: "done", sequence: 1 });
  insertSlice({ milestoneId: "M001", id: "S02", title: "Two", status: "pending", sequence: 2 });

  const summaryDir = join(tmp, ".gsd", "milestones", "M001", "slices", "S01");
  mkdirSync(summaryDir, { recursive: true });
  writeFileSync(join(summaryDir, "S01-SUMMARY.md"), "# S01 Summary\n\nDid things.\n");

  const result = await checkNeedsReassessment(tmp, "M001", {} as never);
  assert.deepEqual(result, { sliceId: "S01" });
});

test("checkNeedsReassessment returns null when every slice is closed, including legacy aliases", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-prompts-db-reassess-all-closed-"));
  t.after(() => {
    closeDatabase();
    rmSync(tmp, { recursive: true, force: true });
  });
  seedDb(tmp);
  insertMilestone({ id: "M001", title: "M001: Reassess", status: "active" });
  insertSlice({ milestoneId: "M001", id: "S01", title: "One", status: "done", sequence: 1 });
  insertSlice({ milestoneId: "M001", id: "S02", title: "Two", status: "skipped", sequence: 2 });

  const summaryDir = join(tmp, ".gsd", "milestones", "M001", "slices", "S01");
  mkdirSync(summaryDir, { recursive: true });
  writeFileSync(join(summaryDir, "S01-SUMMARY.md"), "# S01 Summary\n\nDid things.\n");

  const result = await checkNeedsReassessment(tmp, "M001", {} as never);
  assert.equal(result, null);
});

test("loadRoadmapCompletedSliceCandidates ignores roadmap markdown when no DB is open", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-prompts-no-db-uat-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  closeDatabase();
  const msDir = join(tmp, ".gsd", "milestones", "M001");
  mkdirSync(msDir, { recursive: true });
  writeFileSync(
    join(msDir, "M001-ROADMAP.md"),
    "# M001: UAT\n\n## Slices\n- [x] **S01: One** `risk:low` `depends:[]`\n",
  );

  const candidates = await loadRoadmapCompletedSliceCandidates(tmp, "M001");
  assert.deepEqual(candidates, []);
});
