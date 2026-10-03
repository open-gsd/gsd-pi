// Project/App: gsd-pi
// File Purpose: Tests for milestone merge ROADMAP resolution from database rows.

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  closeDatabase,
  insertMilestone,
  insertSlice,
  openDatabase,
} from "../gsd-db.ts";
import { resolveRoadmapForMilestoneMerge } from "../milestone-merge-roadmap.ts";
import { cleanup, makeTempRepo } from "./test-utils.ts";

function makeBase(t: TestContext, prefix: string): string {
  const base = makeTempRepo(prefix);
  t.after(() => {
    closeDatabase();
    cleanup(base);
  });
  return base;
}

function seedCompleteMilestone(base: string): void {
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M010", title: "Search and Filters", status: "complete" });
  insertSlice({ id: "S01", milestoneId: "M010", title: "Task Editing", status: "complete" });
  insertSlice({ id: "S02", milestoneId: "M010", title: "Search Bar", status: "complete" });
}

test("resolveRoadmapForMilestoneMerge renders from DB slice rows and reads no ROADMAP file", (t) => {
  const base = makeBase(t, "gsd-merge-roadmap-db-");
  seedCompleteMilestone(base);
  const roadmapDir = join(base, ".gsd", "milestones", "M010");
  mkdirSync(roadmapDir, { recursive: true });
  writeFileSync(
    join(roadmapDir, "M010-ROADMAP.md"),
    "# M010: File that contradicts the database\n\n- [ ] **S09: Not in the database**\n",
  );

  const reads: string[] = [];
  const content = resolveRoadmapForMilestoneMerge([base], "M010", (path) => {
    reads.push(path);
    return readFileSync(path, "utf-8");
  });

  assert.deepEqual(reads, [], "the ROADMAP file is not read when the database has the slices");
  assert.ok(content);
  assert.match(content, /^# M010: Search and Filters$/m);
  assert.match(content, /- \[x\] \*\*S01: Task Editing\*\*/);
  assert.match(content, /- \[x\] \*\*S02: Search Bar\*\*/);
  assert.doesNotMatch(content, /S09/);
});

test("resolveRoadmapForMilestoneMerge writes no ROADMAP file", (t) => {
  const base = makeBase(t, "gsd-merge-roadmap-no-write-");
  seedCompleteMilestone(base);

  assert.ok(resolveRoadmapForMilestoneMerge([base], "M010", (path) => readFileSync(path, "utf-8")));

  assert.equal(
    existsSync(join(base, ".gsd", "milestones")),
    false,
    "resolving merge content does not write a ROADMAP to the legacy path",
  );
});

test("resolveRoadmapForMilestoneMerge uses a ROADMAP file only when the database has no slice rows", (t) => {
  const base = makeBase(t, "gsd-merge-roadmap-existing-");
  const roadmapDir = join(base, ".gsd", "milestones", "M010");
  mkdirSync(roadmapDir, { recursive: true });
  writeFileSync(join(roadmapDir, "M010-ROADMAP.md"), "# M010: Existing roadmap\n");

  const content = resolveRoadmapForMilestoneMerge([base], "M010", (path) => readFileSync(path, "utf-8"));

  assert.equal(content, "# M010: Existing roadmap\n");
  assert.equal(resolveRoadmapForMilestoneMerge([base], "M011", (path) => readFileSync(path, "utf-8")), null);
});
