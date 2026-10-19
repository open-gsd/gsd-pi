// Project/App: gsd-pi
// File Purpose: The gsd_progress fallback parser reads back every line the one STATE.md renderer writes.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { readProgress } from "../../../../../packages/mcp-server/src/readers/state.ts";
import type { GSDState } from "../types.ts";
import { renderStateContent } from "../workflow-projections.ts";

/** Render `state` to STATE.md in a fresh project and read it back through the fallback parser. */
function roundTrip(t: TestContext, state: GSDState): ReturnType<typeof readProgress> {
  const projectDir = mkdtempSync(join(tmpdir(), "gsd-state-md-round-trip-"));
  t.after(() => rmSync(projectDir, { recursive: true, force: true }));
  mkdirSync(join(projectDir, ".gsd"), { recursive: true });
  writeFileSync(join(projectDir, ".gsd", "STATE.md"), renderStateContent(state));
  return readProgress(projectDir);
}

test("an active project with parked and suffix-id milestones round-trips", (t) => {
  const progress = roundTrip(t, {
    activeMilestone: { id: "M002-ab12cd", title: "Payments platform" },
    activeSlice: { id: "S03", title: "Refund flow" },
    activeTask: { id: "T01", title: "Not written to STATE.md" },
    phase: "completing-milestone",
    recentDecisions: [],
    blockers: ["Waiting on the provider sandbox"],
    nextAction: "Complete milestone M002-ab12cd.",
    registry: [
      { id: "M001", title: "Core setup", status: "complete" },
      { id: "M002-ab12cd", title: "Payments platform", status: "active" },
      { id: "M003", title: "Reporting", status: "parked" },
      { id: "M004-zz99yy", title: "Dashboard", status: "pending" },
    ],
    requirements: { active: 5, validated: 2, deferred: 1, outOfScope: 3, blocked: 0, total: 11 },
  });

  assert.deepEqual(progress.activeMilestone, { id: "M002-ab12cd", title: "Payments platform" });
  assert.deepEqual(progress.activeSlice, { id: "S03", title: "Refund flow" });
  assert.equal(progress.activeTask, null, "STATE.md carries no task line");
  assert.equal(progress.phase, "completing-milestone", "the phase is read as written");
  assert.deepEqual(progress.milestones, { total: 4, done: 1, active: 1, pending: 1, parked: 1 });
  assert.deepEqual(progress.requirements, { active: 5, validated: 2, deferred: 1, outOfScope: 3 });
  assert.deepEqual(progress.blockers, ["Waiting on the provider sandbox"]);
  assert.equal(progress.nextAction, "Complete milestone M002-ab12cd.");
});

test("a complete project round-trips with no active milestone", (t) => {
  const progress = roundTrip(t, {
    activeMilestone: null,
    activeSlice: null,
    activeTask: null,
    phase: "complete",
    recentDecisions: [],
    blockers: [],
    nextAction: "",
    registry: [
      { id: "M001", title: "Core setup", status: "complete" },
      { id: "M002-ab12cd", title: "Payments platform", status: "complete" },
    ],
    lastCompletedMilestone: { id: "M002-ab12cd", title: "Payments platform" },
  });

  assert.equal(progress.activeMilestone, null, "a Last Completed Milestone line is not an active milestone");
  assert.equal(progress.activeSlice, null);
  assert.equal(progress.phase, "complete");
  assert.deepEqual(progress.milestones, { total: 2, done: 2, active: 0, pending: 0, parked: 0 });
  assert.equal(progress.requirements, null);
  assert.deepEqual(progress.blockers, [], "the rendered '- None' is an empty list");
  assert.equal(progress.nextAction, "", "the rendered 'None' is an empty next action");
});
