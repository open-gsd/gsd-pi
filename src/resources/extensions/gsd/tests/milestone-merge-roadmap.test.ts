// Project/App: gsd-pi
// File Purpose: Tests for milestone merge ROADMAP resolution fallback.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  closeDatabase,
  insertMilestone,
  insertSlice,
  openDatabase,
} from "../gsd-db.ts";
import { resolveRoadmapForMilestoneMerge } from "../milestone-merge-roadmap.ts";
import { cleanup, makeTempRepo } from "./test-utils.ts";

test("resolveRoadmapForMilestoneMerge reads an existing ROADMAP projection", () => {
  const base = makeTempRepo("gsd-merge-roadmap-existing-");
  try {
    const roadmapDir = join(base, ".gsd", "milestones", "M010");
    mkdirSync(roadmapDir, { recursive: true });
    const roadmapPath = join(roadmapDir, "M010-ROADMAP.md");
    writeFileSync(roadmapPath, "# M010: Existing roadmap\n");

    const resolution = resolveRoadmapForMilestoneMerge(
      [base],
      "M010",
      (path) => readFileSync(path, "utf-8"),
    );

    assert.ok(resolution);
    assert.equal(resolution.synthesized, false);
    assert.match(resolution.content, /Existing roadmap/);
  } finally {
    cleanup(base);
  }
});

test("resolveRoadmapForMilestoneMerge synthesizes ROADMAP from DB slice rows", () => {
  const base = makeTempRepo("gsd-merge-roadmap-synth-");
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M010", title: "Search and Filters", status: "complete" });
    insertSlice({
      id: "S01",
      milestoneId: "M010",
      title: "Task Editing",
      status: "complete",
    });
    insertSlice({
      id: "S02",
      milestoneId: "M010",
      title: "Search Bar",
      status: "complete",
    });

    const resolution = resolveRoadmapForMilestoneMerge(
      [base],
      "M010",
      (path) => readFileSync(path, "utf-8"),
    );

    assert.ok(resolution);
    assert.equal(resolution.synthesized, true);
    assert.match(resolution.content, /M010: Search and Filters/);
    assert.match(resolution.content, /Task Editing/);
    assert.match(resolution.content, /Search Bar/);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});
