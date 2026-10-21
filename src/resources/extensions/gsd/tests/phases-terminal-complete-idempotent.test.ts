/**
 * phases-terminal-complete-idempotent.test.ts — Regression test for the
 * milestone-completion double-closeout guard in `runPreDispatch`.
 *
 * When `runPreDispatch` observes that the active milestone (or the last one
 * the session was working on) has already been closed by another session,
 * the loop must exit cleanly with `{ action: "break", reason:
 * "milestone-complete" }` and must NOT replay merge, desktop / cmux
 * notifications, unit closeout, or `stopAuto`.
 *
 * There are two `deriveState` shapes the guard must cover, and both are
 * exercised below because the canonical one is easy to miss:
 *
 *   1. `state.phase === "complete"` with `activeMilestone` set, so the
 *      loop computes a non-null `mid` from `state.activeMilestone.id`.
 *
 *   2. `state.phase === "complete"` with `activeMilestone: null` — the
 *      canonical "all milestones complete" return from `deriveState`
 *      (state.ts:613, state.ts:1293). `mid` is undefined here, so the
 *      guard must consult `s.currentMilestoneId` (the milestone this
 *      session was working on) instead. Without coverage for this case,
 *      a guard that only inspects `mid` is unreachable in production and
 *      the loop replays `_runMilestoneMergeOnceWithStashRestore`,
 *      `sendDesktopNotification("All milestones complete!")`,
 *      `logCmuxEvent`, and `stopAuto` — exactly the duplicate side
 *      effects this fix exists to prevent.
 *
 * Both fire-paths of the guard (`completionStopInProgress` and a
 * DB-already-closed milestone) are exercised against each shape.
 */

import { createTestContext } from "./test-helpers.ts";
import { runPreDispatch } from "../auto/pre-dispatch.ts";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  isDbAvailable,
} from "../gsd-db.ts";

const { assertTrue, report } = createTestContext();

type SideEffect = string;

interface ScenarioOverrides {
  completionStopInProgress: boolean;
  sideEffects: SideEffect[];
  notifications: Array<{ message: string; level?: string }>;
  // When `null`, deriveState returns activeMilestone: null (canonical
  // all-complete path). Otherwise, returns an activeMilestone with this id.
  activeMilestone: { id: string; title: string } | null;
}

function makeIterationContext(overrides: ScenarioOverrides): any {
  const basePath = "/tmp/gsd-test-terminal-complete";
  const recordSideEffect = (label: string) => {
    overrides.sideEffects.push(label);
  };
  return {
    ctx: {
      ui: {
        notify(message: string, level?: string) {
          overrides.notifications.push({ message, level });
        },
      },
    },
    pi: {},
    s: {
      basePath,
      originalBasePath: basePath,
      canonicalProjectRoot: basePath,
      resourceVersionOnStart: "test",
      // Critical for the `!mid` canonical path: even when deriveState returns
      // activeMilestone: null, the session still remembers the milestone it
      // was working on, and we use that to look up DB status.
      currentMilestoneId: "M001",
      currentUnit: null,
      milestoneMergedInPhases: false,
      completionStopInProgress: overrides.completionStopInProgress,
    },
    prefs: undefined,
    iteration: 1,
    flowId: "test-flow",
    nextSeq: () => 1,
    deps: {
      checkResourcesStale() {
        return null;
      },
      invalidateAllCaches() {},
      async preDispatchHealthGate() {
        return { proceed: true, fixesApplied: [] };
      },
      async deriveState() {
        return {
          phase: "complete",
          activeMilestone: overrides.activeMilestone,
          activeSlice: null,
          activeTask: null,
          // Registry says M001 is complete and no other milestones exist, so
          // `incomplete.length === 0 && state.registry.length > 0` evaluates
          // true in the `!mid` branch.
          registry: [{ id: "M001", status: "complete" }],
          nextAction: "complete",
        };
      },
      syncCmuxSidebar() {},
      setActiveMilestoneId() {},
      reconcileMergeState() {
        return "clean";
      },
      // Anything below this point MUST NOT be reached when the guard fires.
      preflightCleanRoot() {
        recordSideEffect("preflight");
        return { ok: true, stashPushed: false, stashMarker: null };
      },
      postflightPopStash() {
        recordSideEffect("postflight");
        return { ok: true, needsManualRecovery: false };
      },
      lifecycle: {
        exitMilestone() {
          recordSideEffect("merge");
          return { ok: true };
        },
      },
      sendDesktopNotification() {
        recordSideEffect("desktop-notify");
      },
      logCmuxEvent() {
        recordSideEffect("cmux-event");
      },
      async closeoutUnit() {
        recordSideEffect("closeout-unit");
      },
      buildSnapshotOpts() {
        return {};
      },
      async stopAuto(_ctx: unknown, _pi: unknown, reason?: string) {
        recordSideEffect(`stop:${reason ?? ""}`);
      },
      async pauseAuto() {
        recordSideEffect("pause");
      },
      emitJournalEvent() {
        recordSideEffect("journal-event");
      },
    },
  };
}

async function runScenario(opts: {
  label: string;
  completionStopInProgress: boolean;
  activeMilestone: { id: string; title: string } | null;
  // When true, the test opens an in-memory DB and inserts M001 with status
  // "complete" so the DB-closed branch of the guard can fire.
  dbAlreadyClosed: boolean;
}): Promise<void> {
  if (isDbAvailable()) {
    closeDatabase();
  }
  if (opts.dbAlreadyClosed) {
    openDatabase(":memory:");
    insertMilestone({ id: "M001", title: "Milestone one", status: "complete" });
  }

  try {
    const sideEffects: SideEffect[] = [];
    const notifications: Array<{ message: string; level?: string }> = [];
    const ic = makeIterationContext({
      completionStopInProgress: opts.completionStopInProgress,
      sideEffects,
      notifications,
      activeMilestone: opts.activeMilestone,
    });

    const result = await runPreDispatch(ic, {
      consecutiveFinalizeTimeouts: 0,
    });

    assertTrue(
      result.action === "break",
      `${opts.label}: returns break instead of next`,
    );
    if (result.action === "break") {
      assertTrue(
        result.reason === "milestone-complete",
        `${opts.label}: reason is milestone-complete (got "${result.reason}")`,
      );
    }
    assertTrue(
      sideEffects.length === 0,
      `${opts.label}: no closeout side effects replayed (saw [${sideEffects.join(", ")}])`,
    );
    assertTrue(
      notifications.length === 0,
      `${opts.label}: no user notifications emitted (saw ${notifications.length})`,
    );
  } finally {
    if (isDbAvailable()) {
      closeDatabase();
    }
  }
}

console.log("\n=== Terminal complete is idempotent across both observer paths ===");

// ── state.phase === "complete" branch (activeMilestone non-null) ────────────
await runScenario({
  label: "phase=complete + mid set + completionStopInProgress",
  completionStopInProgress: true,
  activeMilestone: { id: "M001", title: "Milestone one" },
  dbAlreadyClosed: false,
});

await runScenario({
  label: "phase=complete + mid set + DB closed",
  completionStopInProgress: false,
  activeMilestone: { id: "M001", title: "Milestone one" },
  dbAlreadyClosed: true,
});

// ── Canonical !mid "all milestones complete" sub-branch ────────────────────
// deriveState returns phase: "complete" with activeMilestone: null. The
// session's s.currentMilestoneId (M001) is what the guard consults.
await runScenario({
  label: "phase=complete + activeMilestone=null + completionStopInProgress",
  completionStopInProgress: true,
  activeMilestone: null,
  dbAlreadyClosed: false,
});

await runScenario({
  label: "phase=complete + activeMilestone=null + DB closed",
  completionStopInProgress: false,
  activeMilestone: null,
  dbAlreadyClosed: true,
});

report();
