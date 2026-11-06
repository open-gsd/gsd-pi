// #3108 — step-mode pre-flight: artifact/DB drift inside a PARKED milestone
// must not block planning/dispatch of a different active milestone. The drift
// scan only skipped `closed` milestones, so ~150 legacy drift records across
// 23 parked milestones fenced the whole queue. Parked milestones are exempt
// from this class of automated passes, same as the orphan-audit parked
// exemptions (#2991/#3001): parking is the user's explicit deferral, and the
// parked history's internal artifact/lifecycle disagreement must not gate the
// active pipeline.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  insertArtifact,
} from "../gsd-db.ts";
import { detectArtifactDbDrift } from "../state-reconciliation/drift/artifact-db.ts";
import { reconcileBeforeDispatch } from "../state-reconciliation.ts";
import type { DriftContext } from "../state-reconciliation/types.ts";
import type { GSDState } from "../types.ts";

function stubState(): GSDState {
  return {
    activeMilestone: { id: "M002", title: "Next" },
    activeSlice: null,
    activeTask: null,
    phase: "planning",
    recentDecisions: [],
    blockers: [],
    nextAction: "Plan milestone",
    registry: [],
    requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 1 },
    progress: { milestones: { done: 0, total: 2 } },
  };
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

/**
 * Legacy-cutover drift shape (#3108): the parked milestone has SUMMARY
 * artifact rows while its DB lifecycle rows are still pending, and the active
 * milestone being planned is clean. Mirrors the issue's reproduction:
 * `/gsd db adopt --apply` demoted legacy `complete` rows, then the milestones
 * were parked.
 */
function makeFixture(milestoneStatus: "parked" | "active"): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-parked-drift-"));
  mkdirSync(join(base, ".gsd", "phases", "01-legacy"), { recursive: true });
  mkdirSync(join(base, ".gsd", "phases", "02-next"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Legacy", status: milestoneStatus });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Legacy slice", status: "pending" });
  insertTask({ id: "T02", sliceId: "S02", milestoneId: "M001", title: "Legacy task", status: "pending" });
  insertArtifact({
    path: join(base, ".gsd", "phases", "01-legacy", "T02-SUMMARY.md"),
    artifact_type: "SUMMARY",
    milestone_id: "M001",
    slice_id: "S02",
    task_id: "T02",
    full_content: "# T02 Summary\n",
  });
  insertMilestone({ id: "M002", title: "Next", status: "active" });
  return base;
}

function driftContext(base: string, state: GSDState): DriftContext {
  return { basePath: base, state };
}

test("parked milestone's artifact/DB drift does not block reconciliation of a different active milestone (#3108)", async (t) => {
  const base = makeFixture("parked");
  t.after(() => cleanup(base));

  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => stubState(),
  });

  assert.equal(result.ok, true);
  const message = result.blockers.join("\n");
  assert.doesNotMatch(
    message,
    /Artifact\/DB status drift in M001/,
    `parked milestone's drift must not block the active milestone's planning, got: ${JSON.stringify(result.blockers)}`,
  );
  assert.equal(
    result.blockers.length,
    0,
    `a clean active milestone must reconcile without blockers, got: ${JSON.stringify(result.blockers)}`,
  );
});

test("drift detector skips parked milestones but still reports closed-status-free active ones (#3108)", () => {
  const parkedBase = makeFixture("parked");
  try {
    const state = stubState();
    const parked = detectArtifactDbDrift(state, driftContext(parkedBase, state));
    assert.deepEqual(
      parked.filter((record) => record.milestoneId === "M001"),
      [],
      "no drift records may be collected for a parked milestone",
    );
    assert.equal(parked.length, 0, "the rest of the fixture is clean");
  } finally {
    cleanup(parkedBase);
  }

  const activeBase = makeFixture("active");
  try {
    const state = stubState();
    const active = detectArtifactDbDrift(state, driftContext(activeBase, state));
    assert.ok(
      active.some((record) => record.milestoneId === "M001"),
      "the same drift on an unparked milestone must still be detected",
    );
  } finally {
    cleanup(activeBase);
  }
});

test("an active sibling's artifact/DB drift still blocks reconciliation (#3108)", async (t) => {
  const base = makeFixture("active");
  t.after(() => cleanup(base));

  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => stubState(),
  });

  assert.equal(result.ok, true);
  assert.match(
    result.blockers.join("\n"),
    /Artifact\/DB status drift in M001/,
    "the parked exemption must not mask genuine drift on an active milestone",
  );
});

test("parked milestone's disk-only slice divergence does not block the active milestone (#3108)", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-parked-disk-slice-"));
  t.after(() => cleanup(base));

  mkdirSync(join(base, ".gsd", "phases", "01-legacy"), { recursive: true });
  // Meaningful disk-only slice plan in the parked milestone's phase dir — the
  // same fence class as the artifact/DB status drift, collected by the same
  // computeArtifactDbDrift loop.
  writeFileSync(join(base, ".gsd", "phases", "01-legacy", "01-99-PLAN.md"), "# Disk-only plan\n\nWork to review.\n");
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Legacy", status: "parked" });
  insertMilestone({ id: "M002", title: "Next", status: "active" });

  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => stubState(),
  });

  assert.equal(result.ok, true);
  assert.doesNotMatch(
    result.blockers.join("\n"),
    /Slice ID drift in M001/,
    `parked milestone's disk-only slice divergence must not block, got: ${JSON.stringify(result.blockers)}`,
  );
});
