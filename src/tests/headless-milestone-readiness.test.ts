// Project/App Name: gsd-pi + DB-authoritative milestone readiness tests (#1295)
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>
//
// Verifies the `--auto` chain fallback: after new-milestone planning writes
// slices, the milestone is executable in the DB even when the "Milestone <id>
// ready." notify string was never emitted. This is the signal that keeps the
// chain firing when the notify-text regex misses.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
} from "../resources/extensions/gsd/gsd-db.ts";
import { registerMilestones } from "../resources/extensions/gsd/milestone-registration.ts";
import { addLegacyCompletionEvidence } from "../resources/extensions/gsd/tests/helpers/legacy-completion-evidence.ts";
import { insertPlannedSlice } from "../resources/extensions/gsd/tests/helpers/planned-slice.ts";
import {
  captureMilestoneExecutionSnapshot,
  isMilestoneExecutableInDb,
} from "../headless-milestone-readiness.ts";

function makeProject(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-milestone-readiness-"));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  return base;
}

test("executable when an active milestone has slices (chain fires)", () => {
  const base = makeProject();
  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "m1", title: "New milestone", status: "queued" });
    insertSlice({ id: "S01", milestoneId: "m1", title: "Slice one" });
    closeDatabase();

    assert.equal(isMilestoneExecutableInDb(base), true);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("not executable when the milestone has no slices (planning incomplete)", () => {
  const base = makeProject();
  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "m1", title: "Shell", status: "queued" });
    closeDatabase();

    assert.equal(isMilestoneExecutableInDb(base), false);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("not executable when the only milestone is terminal", () => {
  const base = makeProject();
  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "m1", title: "Done", status: "complete" });
    insertSlice({ id: "S01", milestoneId: "m1", title: "Slice one", status: "complete" });
    addLegacyCompletionEvidence();
    closeDatabase();

    assert.equal(isMilestoneExecutableInDb(base), false);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("changed-since fallback skips queued shells and sees a newly planned milestone", () => {
  const base = makeProject();
  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "m1", title: "Leftover shell", status: "queued" });
    closeDatabase();

    // The snapshot is the first open of the existing database: it cuts the
    // project over, so later rows come from Domain Operations.
    const before = captureMilestoneExecutionSnapshot(base);
    assert.ok(before);

    openDatabase(join(base, ".gsd", "gsd.db"));
    registerMilestones([{ id: "m2", title: "New executable milestone" }], "test");
    insertPlannedSlice("m2", "S01", "Slice one");
    closeDatabase();

    assert.equal(isMilestoneExecutableInDb(base, { changedSince: before }), true);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("changed-since fallback does not reuse an older active milestone for a new shell", () => {
  const base = makeProject();
  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "m1", title: "Existing active milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "m1", title: "Existing slice" });
    closeDatabase();

    const before = captureMilestoneExecutionSnapshot(base);
    assert.ok(before);

    openDatabase(join(base, ".gsd", "gsd.db"));
    registerMilestones([{ id: "m2", title: "New shell" }], "test");
    closeDatabase();

    assert.equal(isMilestoneExecutableInDb(base, { changedSince: before }), false);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("returns false (no throw) when no DB exists", () => {
  const base = makeProject();
  try {
    assert.equal(isMilestoneExecutableInDb(base), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
