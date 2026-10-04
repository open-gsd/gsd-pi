// Regression: complete-slice reopen/replan handoff must not artifact-retry (#183).
// The handoff is read from database rows: an open Task in the open Slice, or a
// replan row recorded during the unit. A transcript, an activity log and a
// REPLAN file are not evidence.

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { postUnitPreVerification } from "../auto-post-unit.ts";
import { AutoSession } from "../auto/session.ts";
import { MAX_ARTIFACT_VERIFICATION_RETRIES } from "../auto-post-unit.ts";
import { readStoredUnitRetry } from "../db/unit-dispatch-retries.ts";
import { usedUnitBudget, useUnitBudget } from "./helpers/unit-budgets.ts";
import { claimTestDispatch } from "./helpers/unit-dispatch.ts";
import {
  decideVerificationRetry,
  hashVerificationFailureContext,
} from "../auto/verification-retry-policy.ts";
import { invalidateAllCaches } from "../cache.ts";
import {
  closeDatabase,
  insertMilestone,
  insertReplanHistory,
  insertSlice,
  insertTask,
  openDatabase,
} from "../gsd-db.ts";
import { cleanup, makeTempRepo } from "./test-utils.ts";

function makePostUnitContext(base: string, s: AutoSession, notifications: string[]) {
  return {
    s,
    ctx: { ui: { notify: (message: string) => notifications.push(message) } } as any,
    pi: {} as any,
    buildSnapshotOpts: () => ({}) as any,
    lockBase: () => base,
    stopAuto: async () => {},
    pauseAuto: async () => {},
    updateProgressWidget: () => {},
  };
}

/** M001/S01 is open and has one Task row per entry. */
function seedSlice(base: string, tasks: Record<string, string>): void {
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "in_progress" });
  for (const [id, status] of Object.entries(tasks)) {
    insertTask({ id, sliceId: "S01", milestoneId: "M001", title: id, status });
  }
  invalidateAllCaches();
}

function completeSliceSession(base: string, startedAt = Date.now()): AutoSession {
  const s = new AutoSession();
  s.active = true;
  s.basePath = base;
  s.currentUnit = { type: "complete-slice", id: "M001/S01", startedAt };
  return s;
}

let base: string;

afterEach(() => {
  closeDatabase();
  invalidateAllCaches();
  cleanup(base);
});

const opts = { skipSettleDelay: true, skipWorktreeSync: true };

test("complete-slice that left an open Task continues instead of artifact-retrying", async () => {
  base = makeTempRepo("gsd-complete-slice-reopen-");
  seedSlice(base, { T01: "pending", T02: "complete" });
  const s = completeSliceSession(base);
  useUnitBudget(s, "complete-slice", "M001/S01", 2);
  s.pendingVerificationRetry = {
    unitId: "M001/S01",
    failureContext: "Missing expected artifact (attempt 2/3).",
    attempt: 2,
  };

  const notifications: string[] = [];
  const result = await postUnitPreVerification(makePostUnitContext(base, s, notifications), opts);

  assert.equal(result, "continue");
  assert.equal(s.pendingVerificationRetry, null);
  assert.equal(usedUnitBudget(s, "complete-slice", "M001/S01"), 0);
  assert.ok(
    notifications.some((message) => message.includes("handed off via reopen/replan")),
    `expected handoff notification, got: ${notifications.join("\n")}`,
  );
});

test("complete-slice with a replan row recorded during the unit continues", async () => {
  base = makeTempRepo("gsd-complete-slice-replan-");
  seedSlice(base, { T01: "complete" });
  const s = completeSliceSession(base, Date.now() - 1_000);
  useUnitBudget(s, "complete-slice", "M001/S01", 1);
  insertReplanHistory({ milestoneId: "M001", sliceId: "S01", summary: "Closeout found missing work." });

  const notifications: string[] = [];
  const result = await postUnitPreVerification(makePostUnitContext(base, s, notifications), opts);

  assert.equal(result, "continue");
  assert.equal(usedUnitBudget(s, "complete-slice", "M001/S01"), 0);
  assert.ok(
    notifications.some((message) => message.includes("handed off via reopen/replan")),
    `expected handoff notification, got: ${notifications.join("\n")}`,
  );
});

test("a replan row from before the unit is not a handoff", async () => {
  base = makeTempRepo("gsd-complete-slice-old-replan-");
  seedSlice(base, { T01: "complete" });
  insertReplanHistory({ milestoneId: "M001", sliceId: "S01", summary: "An earlier replan." });
  const s = completeSliceSession(base, Date.now() + 60_000);

  const notifications: string[] = [];
  const result = await postUnitPreVerification(makePostUnitContext(base, s, notifications), opts);

  assert.equal(result, "retry");
  assert.equal(s.pendingVerificationRetry?.unitId, "M001/S01");
});

test("a transcript, an activity log and a REPLAN file with no rows are not a handoff", async () => {
  base = makeTempRepo("gsd-complete-slice-no-rows-");
  seedSlice(base, { T01: "complete" });
  writeFileSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-REPLAN.md"), "# Replan\n");
  mkdirSync(join(base, ".gsd", "activity"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "activity", "001-complete-slice-M001-S01.jsonl"),
    ["gsd_task_reopen", "gsd_replan_slice"].map((name) => JSON.stringify({
      type: "message",
      message: { role: "assistant", content: [{ type: "toolCall", name, id: "call_1", arguments: {} }] },
    })).join("\n"),
  );
  const s = completeSliceSession(base);

  const notifications: string[] = [];
  const result = await postUnitPreVerification(makePostUnitContext(base, s, notifications), {
    ...opts,
    agentEndMessages: [
      { role: "assistant", content: [{ type: "toolCall", name: "gsd_task_reopen", arguments: { taskId: "T01" } }] },
      { role: "toolResult", toolName: "gsd_replan_slice", isError: false, content: "Slice replanned." },
    ],
  });

  assert.equal(result, "retry");
  assert.equal(s.pendingVerificationRetry?.unitId, "M001/S01");
  assert.ok(
    notifications.every((message) => !message.includes("handed off via reopen/replan")),
    `no rows means no handoff, got: ${notifications.join("\n")}`,
  );
});

test("complete-slice with no database pauses and never reads a handoff from the transcript", async () => {
  base = makeTempRepo("gsd-complete-slice-no-db-");
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
  const s = completeSliceSession(base);

  const notifications: string[] = [];
  const result = await postUnitPreVerification(makePostUnitContext(base, s, notifications), {
    ...opts,
    agentEndMessages: [
      { role: "assistant", content: [{ type: "toolCall", name: "gsd_task_reopen", arguments: { taskId: "T01" } }] },
    ],
  });

  assert.equal(result, "dispatched");
  assert.equal(s.pendingVerificationRetry, null);
  assert.ok(
    notifications.some((message) => message.includes("workflow DB is unavailable")),
    `expected the DB-unavailable pause, got: ${notifications.join("\n")}`,
  );
});

test("artifact retry context stays stable across attempts while notifications show attempt count", async () => {
  base = makeTempRepo("gsd-artifact-retry-stable-context-");
  seedSlice(base, { T01: "complete" });
  const s = completeSliceSession(base);

  const notifications: string[] = [];
  const pctx = makePostUnitContext(base, s, notifications);

  assert.equal(await postUnitPreVerification(pctx, opts), "retry");
  const firstRetry = s.pendingVerificationRetry;
  assert.ok(firstRetry);
  assert.equal(firstRetry.attempt, 1);
  assert.doesNotMatch(firstRetry.failureContext, /\(attempt \d\/3\)\.$/);
  const firstFailureHash = hashVerificationFailureContext(firstRetry.failureContext);

  assert.equal(await postUnitPreVerification(pctx, opts), "retry");
  const secondRetry = s.pendingVerificationRetry;
  assert.ok(secondRetry);
  assert.equal(secondRetry.attempt, 2);
  assert.equal(secondRetry.failureContext, firstRetry.failureContext);
  assert.equal(hashVerificationFailureContext(secondRetry.failureContext), firstFailureHash);
  assert.deepEqual(
    decideVerificationRetry({
      unitType: "complete-slice",
      retryInfo: secondRetry,
      previousFailureHash: firstFailureHash,
      random: () => 0.5,
    }),
    {
      action: "pause",
      reason: "duplicate-failure-context",
      key: "complete-slice:M001/S01",
      failureHash: firstFailureHash,
    },
  );
  assert.ok(
    notifications.some((message) => message.includes("Retrying (attempt 1/3).")),
    `expected first attempt notification, got: ${notifications.join("\n")}`,
  );
  assert.ok(
    notifications.some((message) => message.includes("Retrying (attempt 2/3).")),
    `expected second attempt notification, got: ${notifications.join("\n")}`,
  );
});

test("a failed artifact verification survives a restart: context, count and exhaustion are on the dispatch row", async () => {
  base = makeTempRepo("gsd-artifact-retry-restart-");
  seedSlice(base, { T01: "complete" });
  const dispatch = claimTestDispatch(base, {
    milestoneId: "M001",
    sliceId: "S01",
    unitType: "complete-slice",
    unitId: "M001/S01",
  });

  // Every run is a new process: a new session that holds nothing about the unit.
  for (let attempt = 1; attempt <= MAX_ARTIFACT_VERIFICATION_RETRIES; attempt++) {
    const s = completeSliceSession(base);
    assert.equal(await postUnitPreVerification(makePostUnitContext(base, s, []), opts), "retry");

    const restarted = completeSliceSession(base);
    const stored = readStoredUnitRetry("complete-slice", "M001/S01");
    assert.equal(stored?.attempt, attempt, "the count goes on from the last process, it does not start again");
    assert.equal(stored?.failureContext, s.pendingVerificationRetry?.failureContext);
    assert.equal(usedUnitBudget(restarted, "complete-slice", "M001/S01"), attempt);
    assert.equal(usedUnitBudget(restarted, "complete-slice", "M001/S01", "exhausted"), 0);
    dispatch.claimNext();
  }

  let paused = false;
  const last = completeSliceSession(base);
  const result = await postUnitPreVerification(
    { ...makePostUnitContext(base, last, []), pauseAuto: async () => { paused = true; } },
    opts,
  );

  assert.equal(result, "dispatched");
  assert.equal(paused, true);
  assert.equal(
    usedUnitBudget(completeSliceSession(base), "complete-slice", "M001/S01", "exhausted"),
    1,
    "a restarted process must see that the unit used all its retries",
  );
});
