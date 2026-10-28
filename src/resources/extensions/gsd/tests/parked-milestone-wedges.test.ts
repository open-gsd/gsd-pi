// #2991 — parking a milestone must clear (or ignore) the liveness wedge for
// that milestone's units: the dispatcher skips parked milestones, so a wedge
// scoped to a parked unit can no longer protect anything while it still gates
// /gsd auto project-wide. Park is the documented "unblock the queue" path.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { parkMilestone } from "../milestone-actions.ts";
import { startAuto } from "../auto.ts";
import { autoSession } from "../auto-runtime-state.ts";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  _getAdapter,
} from "../gsd-db.ts";
import {
  acknowledgeWedgesForParkedMilestones,
  COMPLETED_NO_ADVANCE_GUARD_ID,
  snapshotUnitTargetRows,
} from "../auto-liveness-backstop.ts";
import { insertLivenessWedgeRecord } from "../db/writers/liveness-backstop.ts";
import { normalizeRealPath } from "../paths.ts";

function makeBase(): string {
  const base = join(tmpdir(), `gsd-parked-wedges-${randomUUID()}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* best-effort */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* best-effort */ }
}

const SCOPE_PARK_TEST = "/tmp/parked-wedges-scope";

let wedgeSeq = 0;

function insertOpenWedge(scopeId: string, unitType: string, unitId: string): string {
  wedgeSeq += 1;
  const wedgeId = `W-park-${wedgeSeq}`;
  insertLivenessWedgeRecord({
    wedgeId,
    scopeId,
    guardId: "dispatch-rule-stop",
    unitType,
    unitId,
    inputHash: `hash-${wedgeSeq}`,
    occurrenceCount: 2,
    sanctionedExit: "task-recovery-resumed-claim-grace",
    forensicsPath: null,
    createdAt: new Date().toISOString(),
  });
  return wedgeId;
}

function wedgeAckState(wedgeId: string): string | null {
  const row = _getAdapter()!.prepare(
    "SELECT acknowledged_at FROM liveness_wedge_records WHERE wedge_id = :wid",
  ).get({ ":wid": wedgeId }) as { acknowledged_at: string | null } | undefined;
  assert.ok(row, `wedge ${wedgeId} must exist`);
  return row.acknowledged_at;
}

test("parkMilestone acknowledges the parked milestone's open wedge and leaves others (#2991)", async () => {
  const base = makeBase();
  try {
    openDatabase(":memory:");
    insertMilestone({ id: "M007", title: "Stuck", status: "active" });
    insertMilestone({ id: "M009", title: "Next", status: "active" });
    const scopeId = normalizeRealPath(base);
    const stuckWedge = insertOpenWedge(scopeId, "execute-task", "M007/S07/T02");
    const nextWedge = insertOpenWedge(scopeId, "execute-task", "M009/S01/T01");

    const parked = await parkMilestone(base, "M007", "unblock the queue");
    assert.equal(parked, true, "park must succeed");

    assert.ok(wedgeAckState(stuckWedge), "park must acknowledge the stuck unit's wedge");
    assert.equal(wedgeAckState(nextWedge), null, "park must not touch other milestones' wedges");
  } finally {
    cleanup(base);
  }
});

test("suffixed (team-mode) milestone IDs are swept by the canonical grammar (#2991)", async () => {
  const base = makeBase();
  try {
    openDatabase(":memory:");
    insertMilestone({ id: "M007-abc123", title: "Stuck suffixed", status: "parked" });
    const scopeId = SCOPE_PARK_TEST;
    const suffixedWedge = insertOpenWedge(scopeId, "execute-task", "M007-abc123/S07/T02");

    const sweep = acknowledgeWedgesForParkedMilestones(scopeId);
    assert.ok(sweep.ok, `sweep must succeed: ${!sweep.ok ? sweep.error : ""}`);
    if (!sweep.ok) return;
    assert.deepEqual(
      sweep.acknowledged.map((w) => w.wedgeId),
      [suffixedWedge],
      "suffixed milestone id must be recognized, not skipped",
    );
    assert.ok(wedgeAckState(suffixedWedge), "suffixed milestone's wedge acknowledged");
  } finally {
    cleanup(base);
  }
});

test("acknowledgeWedgesForParkedMilestones sweeps parked-milestone wedges only (#2991)", async () => {
  const base = makeBase();
  try {
    openDatabase(":memory:");
    insertMilestone({ id: "M007", title: "Parked already", status: "parked" });
    insertMilestone({ id: "M009", title: "Active", status: "active" });
    const scopeId = SCOPE_PARK_TEST;
    const parkedWedge = insertOpenWedge(scopeId, "execute-task", "M007/S07/T02");
    const liveWedge = insertOpenWedge(scopeId, "execute-task", "M009/S01/T01");
    const nonMilestoneWedge = insertOpenWedge(scopeId, "adhoc", "misc-loop");

    const sweep = acknowledgeWedgesForParkedMilestones(scopeId);
    assert.ok(sweep.ok, `sweep must succeed: ${!sweep.ok ? sweep.error : ""}`);
    if (!sweep.ok) return;
    assert.deepEqual(
      sweep.acknowledged.map((w) => w.wedgeId).sort(),
      [parkedWedge].sort(),
      "only the parked milestone's wedge is acknowledged",
    );
    assert.ok(wedgeAckState(parkedWedge), "parked-milestone wedge acknowledged");
    assert.equal(wedgeAckState(liveWedge), null, "active-milestone wedge untouched");
    assert.equal(wedgeAckState(nonMilestoneWedge), null, "non-milestone unit wedge untouched");

    const filtered = acknowledgeWedgesForParkedMilestones(scopeId, "M009");
    assert.ok(filtered.ok);
    assert.equal(filtered.ok && filtered.acknowledged.length, 0, "filter excludes parked milestone's already-acked wedge");
    assert.equal(wedgeAckState(liveWedge), null, "filtered sweep still leaves the active wedge (M009 not parked)");
  } finally {
    cleanup(base);
  }
});

test("/gsd auto proceeds past the wedge gate when the wedged milestone is parked (#2991)", async (t) => {
  const base = makeBase();
  const priorProjectId = process.env.GSD_PROJECT_ID;
  // Bootstrap tripwire (same pattern as resume-wedge-refusal-render.test.ts):
  // if startAuto gets past the wedge gate, bootstrap emits this distinctive
  // error — the positive signal that the gate opened.
  process.env.GSD_PROJECT_ID = "invalid project id";
  t.after(() => {
    if (priorProjectId === undefined) delete process.env.GSD_PROJECT_ID;
    else process.env.GSD_PROJECT_ID = priorProjectId;
    autoSession.reset();
    cleanup(base);
  });

  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M007", title: "Stuck", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M007", title: "Stuck slice", status: "active", depends: [] });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M007", title: "task", status: "pending" });
  insertMilestone({ id: "M009", title: "Next", status: "active" });

  // A blocking completed-no-advance wedge on M007/S01 — GC at startup rechecks
  // it, the target rows never move, so it would block forever without park.
  const snapshot = snapshotUnitTargetRows("complete-slice", "M007/S01");
  assert.ok(snapshot.ok && snapshot.hash, "target-row snapshot requires fixture rows");
  let legacyWedge: string | null = null;
  {
    const { recordNonAdvancingOutcome } = await import("../auto-liveness-backstop.ts");
    recordNonAdvancingOutcome({
      scopeId: normalizeRealPath(base),
      guardId: COMPLETED_NO_ADVANCE_GUARD_ID,
      unitType: "complete-slice",
      unitId: "M007/S01",
      inputPayload: snapshot.hash!,
    });
    const tripped = recordNonAdvancingOutcome({
      scopeId: normalizeRealPath(base),
      guardId: COMPLETED_NO_ADVANCE_GUARD_ID,
      unitType: "complete-slice",
      unitId: "M007/S01",
      inputPayload: snapshot.hash!,
    });
    assert.equal(tripped.tripped, true, "wedge must trip on the second identical outcome");
    legacyWedge = tripped.wedge.wedgeId;
  }

  assert.equal(await parkMilestone(base, "M007", "unblock the queue"), true);
  assert.ok(wedgeAckState(legacyWedge!), "park acknowledges the wedge at park time");

  // A wedge recorded AFTER the park (a project that parked before this rule
  // existed) must be reconciled by the auto-start sweep, not gate the queue.
  const postParkWedge = insertOpenWedge(normalizeRealPath(base), "execute-task", "M007/S07/T02");

  const notifications: string[] = [];
  const ctx = {
    ui: { notify: (message: string) => notifications.push(message) },
    sessionManager: { getSessionId: () => "parked-wedge-auto-start-test" },
    modelRegistry: { getAvailable: () => [], isProviderRequestReady: () => false },
    model: undefined,
  } as unknown as Parameters<typeof startAuto>[0];
  const pi = { getThinkingLevel: () => "off" } as unknown as Parameters<typeof startAuto>[1];

  await startAuto(ctx, pi, base, false, {});

  assert.ok(
    wedgeAckState(postParkWedge),
    "the auto-start sweep must acknowledge wedges parked before it ran",
  );
  assert.equal(
    notifications.some((m) => m.startsWith("Auto-mode blocked —")),
    false,
    `the parked milestone's wedge must not refuse auto entry, got: ${JSON.stringify(notifications)}`,
  );
  assert.ok(
    notifications.some((m) => m.includes("GSD_PROJECT_ID must contain only")),
    "startAuto must proceed past the wedge gate into bootstrap (tripwire error expected)",
  );
});
