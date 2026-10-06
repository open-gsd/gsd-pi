/**
 * auto-paused-superseded-milestone-1643.test.ts — #1643 / wayfinder #1654.
 *
 * A paused_session runtime_kv row pinning a milestone that is still open but
 * no longer the project's active milestone (superseded) must NOT be restored:
 * the stale pin makes every dispatch iteration stop on the milestone-mismatch
 * guard with no field escape. The resume path routes through
 * routePausedSessionResume, which adopts the current active milestone and
 * clears the stale row instead (ADR-047: the guard stays, the exit becomes
 * reachable).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { routePausedSessionResume } from "../auto.ts";

// ─── (a) superseded-but-open paused milestone → adopt the active one ────────

test("#1643: paused milestone open but superseded by a different active milestone routes to adopt-active", () => {
  const route = routePausedSessionResume({
    milestoneExists: true,
    summaryIsTerminal: false,
    pausedMilestoneId: "M016-5b17xo",
    activeMilestoneId: "M018-6b0xxe",
  });
  assert.deepEqual(route, { route: "adopt-active", activeMilestoneId: "M018-6b0xxe" });
});

test("#1643: adopt-active is skipped when derived state has no active milestone (restore as before)", () => {
  const route = routePausedSessionResume({
    milestoneExists: true,
    summaryIsTerminal: false,
    pausedMilestoneId: "M016-5b17xo",
    activeMilestoneId: null,
  });
  assert.deepEqual(route, { route: "restore" });
});

// ─── (b) paused milestone still active → restored exactly as before ─────────

test("#1643: paused milestone identical to active milestone routes to restore", () => {
  const route = routePausedSessionResume({
    milestoneExists: true,
    summaryIsTerminal: false,
    pausedMilestoneId: "M016-5b17xo",
    activeMilestoneId: "M016-5b17xo",
  });
  assert.deepEqual(route, { route: "restore" });
});

// #1317 composition: bare-vs-suffixed aliases of the same milestone must not
// false-mismatch — the same normalization the dispatch guard applies.
test("#1643/#1317: bare paused id vs suffixed active id of the same milestone routes to restore", () => {
  const route = routePausedSessionResume({
    milestoneExists: true,
    summaryIsTerminal: false,
    pausedMilestoneId: "M016",
    activeMilestoneId: "M016-5b17xo",
  });
  assert.deepEqual(route, { route: "restore" });
});

test("#1643/#1317: suffixed paused id vs bare active id of the same milestone routes to restore", () => {
  const route = routePausedSessionResume({
    milestoneExists: true,
    summaryIsTerminal: false,
    pausedMilestoneId: "M016-5b17xo",
    activeMilestoneId: "M016",
  });
  assert.deepEqual(route, { route: "restore" });
});

// ─── (c) closed / missing paused milestone → existing behavior unchanged ─

test("#1643: a milestone with no row still routes to discard(missing), even when superseded", () => {
  const route = routePausedSessionResume({
    milestoneExists: false,
    summaryIsTerminal: false,
    pausedMilestoneId: "M016-5b17xo",
    activeMilestoneId: "M018-6b0xxe",
  });
  assert.deepEqual(route, { route: "discard", reason: "missing" });
});

test("#1643: terminal (closed) paused milestone still routes to discard(terminal), even when superseded", () => {
  const route = routePausedSessionResume({
    milestoneExists: true,
    summaryIsTerminal: true,
    pausedMilestoneId: "M016-5b17xo",
    activeMilestoneId: "M018-6b0xxe",
  });
  assert.deepEqual(route, { route: "discard", reason: "terminal" });
});

// ─── (d) the recorded Recovery Classifier route of a machine_fixable pause ──

test("a machine_fixable pause whose recorded route is retry routes to machine-retry", () => {
  const route = routePausedSessionResume({
    milestoneExists: true,
    summaryIsTerminal: false,
    pausedMilestoneId: "M016-5b17xo",
    activeMilestoneId: "M016-5b17xo",
    machineAction: "retry",
  });
  assert.deepEqual(route, { route: "machine-retry" });
});

test("a recorded escalate route stays a human restore", () => {
  const route = routePausedSessionResume({
    milestoneExists: true,
    summaryIsTerminal: false,
    pausedMilestoneId: "M016-5b17xo",
    activeMilestoneId: "M016-5b17xo",
    machineAction: "escalate",
  });
  assert.deepEqual(route, { route: "restore" });
});

test("no recorded route (a human pause or an older row) stays a human restore", () => {
  const route = routePausedSessionResume({
    milestoneExists: true,
    summaryIsTerminal: false,
    pausedMilestoneId: "M016-5b17xo",
    activeMilestoneId: "M016-5b17xo",
    machineAction: null,
  });
  assert.deepEqual(route, { route: "restore" });
});

test("the machine retry does not outrank the stale-pin exits", () => {
  assert.deepEqual(
    routePausedSessionResume({
      milestoneExists: false,
      summaryIsTerminal: false,
      pausedMilestoneId: "M016-5b17xo",
      activeMilestoneId: null,
      machineAction: "retry",
    }),
    { route: "discard", reason: "missing" },
  );
  assert.deepEqual(
    routePausedSessionResume({
      milestoneExists: true,
      summaryIsTerminal: true,
      pausedMilestoneId: "M016-5b17xo",
      activeMilestoneId: null,
      machineAction: "retry",
    }),
    { route: "discard", reason: "terminal" },
  );
  assert.deepEqual(
    routePausedSessionResume({
      milestoneExists: true,
      summaryIsTerminal: false,
      pausedMilestoneId: "M016-5b17xo",
      activeMilestoneId: "M018-6b0xxe",
      machineAction: "retry",
    }),
    { route: "adopt-active", activeMilestoneId: "M018-6b0xxe" },
  );
});

// ─── Wiring: the resume path in auto.ts consumes the route ──────────────────
// Source-shape assertions follow the precedent set in
// interrupted-session-auto.test.ts ("source only resumes paused-session..."):
// the adopt-active branch must clear the stale runtime_kv row, adopt the
// active milestone onto the session, drop the lease token, and surface a
// notification naming both milestone ids.

test("#1643: auto.ts resume path wires adopt-active — clears stale row, adopts milestone, notifies with both ids", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../auto.ts", import.meta.url), "utf-8"),
  );
  assert.ok(source.includes("const resumeRoute = routePausedSessionResume({"));
  assert.ok(source.includes("machineAction: recordedMachinePauseAction(meta),"));
  assert.ok(source.includes("activeMilestoneId: freshStartAssessment.state?.activeMilestone?.id ?? null"));
  assert.ok(source.includes('clearPausedSession("paused-session DB cleanup failed (milestone superseded)")'));
  assert.ok(source.includes("s.currentMilestoneId = resumeRoute.activeMilestoneId;"));
  assert.ok(source.includes("s.milestoneLeaseToken = null;"));
  assert.ok(source.includes("was superseded — ${resumeRoute.activeMilestoneId} is now the project's active milestone."));
  assert.ok(source.includes("${meta.milestoneId} remains open for later dispatch."));
});
