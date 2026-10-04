/**
 * Regression test for MCP tool-availability race.
 *
 * When the MCP workflow server is still connecting, tool calls fail with
 * "No such tool available". The tool-unavailable budget on the unit's dispatch
 * row caps retries at 3 with escalating delay, then auto-mode pauses.
 */
import { describe, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { _setAutoActiveForTest } from "../auto.ts";
import { postUnitPreVerification } from "../auto-post-unit.ts";
import { AutoSession } from "../auto/session.ts";
import { closeDatabase, insertArtifact, insertMilestone, openDatabase } from "../gsd-db.ts";
import { registerAutoWorker } from "../db/auto-workers.ts";
import { claimMilestoneLease } from "../db/milestone-leases.ts";
import { recordDispatchClaim } from "../db/unit-dispatches.ts";
import { readUnitBudget, spendUnitBudget } from "../db/unit-dispatch-budgets.ts";

const BUDGET = { unitType: "research-milestone", unitId: "M001", kind: "tool-unavailable" } as const;

/** Open a project database and claim the research-milestone unit of M001. */
function claimResearchMilestone(t: TestContext): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-tool-unavailable-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  _setAutoActiveForTest(true);
  t.after(() => {
    _setAutoActiveForTest(false);
    try { closeDatabase(); } catch { /* noop */ }
    rmSync(base, { recursive: true, force: true });
  });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  const workerId = registerAutoWorker({ projectRootRealpath: base });
  const lease = claimMilestoneLease(workerId, "M001");
  if (!lease.ok) throw new Error("expected test lease");
  const claim = recordDispatchClaim({
    traceId: "trace-tool-unavailable",
    workerId,
    milestoneLeaseToken: lease.token,
    milestoneId: "M001",
    unitType: "research-milestone",
    unitId: "M001",
  });
  assert.equal(claim.ok, true);
  return base;
}

/** Run post-unit pre-verification for the unit in a new session. */
async function runPreVerification(base: string, lastToolInvocationError: string | null) {
  const s = new AutoSession();
  s.active = true;
  s.basePath = base;
  s.currentUnit = { type: "research-milestone", id: "M001", startedAt: Date.now() };
  s.lastToolInvocationError = lastToolInvocationError;
  const notifications: string[] = [];
  let pauseCalled = false;

  const result = await postUnitPreVerification({
    s,
    ctx: { ui: { notify: (message: string) => notifications.push(message) } },
    pi: {},
    buildSnapshotOpts: () => ({}),
    lockBase: () => base,
    stopAuto: async () => {},
    pauseAuto: async () => { pauseCalled = true; },
    updateProgressWidget: () => {},
  } as any, { skipSettleDelay: true, skipWorktreeSync: true });
  return { result, pauseCalled, notifications };
}

describe("tool-unavailable budget on the dispatch row", () => {
  test("a restart does not give a claimed unit a new tool-unavailable budget", async (t) => {
    const base = claimResearchMilestone(t);
    // The process that died used all three retries. Its session memory is
    // gone; only the dispatch row still holds the count.
    spendUnitBudget(new Map(), BUDGET);
    spendUnitBudget(new Map(), BUDGET);
    spendUnitBudget(new Map(), BUDGET);

    const { result, pauseCalled, notifications } = await runPreVerification(
      base,
      "No such tool available: mcp__gsd-workflow__gsd_summary_save",
    );

    assert.equal(result, "dispatched");
    assert.equal(pauseCalled, true, "the fourth tool-unavailable failure must pause, not retry");
    assert.ok(notifications.some((message) => message.includes("after 3 retries")));
    assert.equal(readUnitBudget(new Map(), BUDGET), 0, "the resume after this pause starts a new budget");
  });

  test("a verified unit gets a full tool-unavailable budget again", async (t) => {
    const base = claimResearchMilestone(t);
    // Two turns lost the race with MCP startup. The third turn saved the research.
    spendUnitBudget(new Map(), BUDGET);
    spendUnitBudget(new Map(), BUDGET);
    insertArtifact({
      path: "milestones/M001/M001-RESEARCH.md",
      artifact_type: "RESEARCH",
      milestone_id: "M001",
      slice_id: null,
      task_id: null,
      full_content: "# Research\n",
    });

    const { result, pauseCalled } = await runPreVerification(base, null);

    assert.equal(result, "continue");
    assert.equal(pauseCalled, false);
    closeDatabase();
    openDatabase(join(base, ".gsd", "gsd.db"));
    assert.equal(readUnitBudget(new Map(), BUDGET), 0, "the stored count must not outlive the pass");
  });
});

describe("tool-unavailable retry backoff (#817)", () => {
  // Mirrors the delay formula in auto-post-unit.ts. The MCP workflow server can
  // take tens of seconds to finish connecting, so the backoff must start high
  // enough that re-dispatch does not land before the server is ready.
  const backoffMs = (retry: number) =>
    Math.min(10_000 * Math.pow(2, retry - 1), 45_000);

  test("starts at 10s, doubles, and caps at 45s", () => {
    assert.equal(backoffMs(1), 10_000);
    assert.equal(backoffMs(2), 20_000);
    assert.equal(backoffMs(3), 40_000);
  });

  test("never exceeds the 45s cap", () => {
    assert.equal(backoffMs(4), 45_000);
    assert.equal(backoffMs(10), 45_000);
  });

  test("first retry survives a multi-second MCP startup (regression for 1s delay)", () => {
    assert.ok(backoffMs(1) >= 10_000, "first retry must wait at least 10s");
  });
});
