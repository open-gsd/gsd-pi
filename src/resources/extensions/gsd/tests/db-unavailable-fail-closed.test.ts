// Project/App: gsd-pi
// File Purpose: Behavior gates for ADR-046 "fail closed when the DB is unavailable".

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerDbTools } from "../bootstrap/db-tools.ts";
import { handleStatus } from "../commands/handlers/core.ts";
import { withCommandCwd } from "../commands/context.ts";
import { closeDatabase, insertAuditEvent, openDatabase, setTaskBlockerDiscovered } from "../gsd-db.ts";
import { inlineDecisionsFromDb, inlineProjectFromDb, inlineRequirementsFromDb } from "../auto-prompts.ts";
import { buildTurnTimeline } from "../uok/timeline.ts";
import { clearReservedMilestoneIds } from "../milestone-ids.ts";
import { UokGateRunner } from "../uok/gate-runner.ts";
import {
  markActiveForWorkerCanceled,
  markCanceled,
  markCompleted,
  markFailed,
  markPaused,
  markRunning,
  markStuck,
} from "../db/unit-dispatches.ts";
import { deleteRuntimeKv, setRuntimeKv } from "../db/runtime-kv.ts";
import { forceReleaseLeasesForWorker, refreshMilestoneLease, releaseMilestoneLease } from "../db/milestone-leases.ts";
import { heartbeatAutoWorker, markWorkerCrashed, markWorkerStopping, markWorkerStoppingByPid } from "../db/auto-workers.ts";
import { clearAbandonedCloseoutSignatures } from "../auto-liveness-backstop.ts";
import { insertMilestoneValidationGates } from "../milestone-validation-gates.ts";
import { clearLock, clearStaleWorkerLock, writeLock } from "../crash-recovery.ts";
import { acquireSessionLock, releaseSessionLock } from "../session-lock.ts";
import { postUnitPreVerification } from "../auto-post-unit.ts";
import { runPostUnitVerification } from "../auto-verification.ts";
import { AutoSession } from "../auto/session.ts";
import { _resetLogs, drainLogs, logWarning, setLogBasePath, setStderrLoggingEnabled } from "../workflow-logger.ts";

type RegisteredPiTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    context?: { cwd: string },
  ) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
};

function generateIdTool(): RegisteredPiTool {
  const tools: RegisteredPiTool[] = [];
  registerDbTools({ registerTool: (tool: RegisteredPiTool) => tools.push(tool) } as never);
  const tool = tools.find((t) => t.name === "gsd_milestone_generate_id");
  assert.ok(tool, "gsd_milestone_generate_id is registered");
  return tool;
}

/** A project whose gsd.db exists but cannot be opened (not a SQLite file). */
function makeProjectWithUnopenableDb(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-db-unavailable-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-CONTEXT.md"), "# M001\n", "utf-8");
  writeFileSync(join(base, ".gsd", "gsd.db"), "this is not a sqlite database\n".repeat(64), "utf-8");
  return base;
}

describe("DB unavailable: fail closed", () => {
  let base: string;

  beforeEach(() => {
    closeDatabase();
    clearReservedMilestoneIds();
    base = makeProjectWithUnopenableDb();
  });

  afterEach(() => {
    closeDatabase();
    clearReservedMilestoneIds();
    rmSync(base, { recursive: true, force: true });
  });

  test("gsd_milestone_generate_id returns an error and creates no milestone", async () => {
    const result = await generateIdTool().execute("call-1", {}, undefined, undefined, { cwd: base });

    assert.match(result.content[0]!.text, /^Error generating milestone ID: workflow DB is unavailable/);
    assert.equal(result.details.error, "workflow DB is unavailable");
    assert.deepEqual(readdirSync(join(base, ".gsd", "milestones")), ["M001"], "no milestone dir is created");
  });

  test("/gsd status reports the open failure, not 'no milestones'", async () => {
    const notes: Array<{ message: string; level: string }> = [];
    const ctx = { ui: { notify: (message: string, level: string) => notes.push({ message, level }) } };

    await withCommandCwd(base, () => handleStatus(ctx as never));

    assert.equal(notes.length, 1);
    assert.equal(notes[0]!.level, "error");
    assert.match(notes[0]!.message, /^Cannot read GSD status: ensureDbOpen failed/);
    assert.doesNotMatch(notes[0]!.message, /No GSD milestones found/);
  });

  test("store writers throw instead of silently doing nothing", () => {
    assert.throws(() => setTaskBlockerDiscovered("M001", "S01", "T01", true), /No database open/);
    assert.throws(
      () => insertAuditEvent({
        eventId: "evt-1",
        traceId: "trace-1",
        category: "orchestration",
        type: "test",
        ts: new Date().toISOString(),
        payload: {},
      }),
      /No database open/,
    );
  });

  test("coordination store writers throw instead of silently doing nothing", () => {
    const writers: Record<string, () => unknown> = {
      markRunning: () => markRunning(1),
      markCompleted: () => markCompleted(1),
      markFailed: () => markFailed(1, { errorSummary: "boom" }),
      markStuck: () => markStuck(1, "stuck"),
      markPaused: () => markPaused(1),
      markCanceled: () => markCanceled(1, "canceled"),
      markActiveForWorkerCanceled: () => markActiveForWorkerCanceled("worker-1", "signal-exit"),
      setRuntimeKv: () => setRuntimeKv("global", "", "k", { v: 1 }),
      deleteRuntimeKv: () => deleteRuntimeKv("global", "", "k"),
      refreshMilestoneLease: () => refreshMilestoneLease("worker-1", "M001", 1),
      releaseMilestoneLease: () => releaseMilestoneLease("worker-1", "M001", 1),
      forceReleaseLeasesForWorker: () => forceReleaseLeasesForWorker("worker-1"),
      heartbeatAutoWorker: () => heartbeatAutoWorker("worker-1"),
      markWorkerCrashed: () => markWorkerCrashed("worker-1"),
      markWorkerStopping: () => markWorkerStopping("worker-1"),
      markWorkerStoppingByPid: () => markWorkerStoppingByPid(base, 4242),
      clearAbandonedCloseoutSignatures: () => clearAbandonedCloseoutSignatures(base, "complete-slice", "M001/S01"),
      insertMilestoneValidationGates: () => insertMilestoneValidationGates("M001", "S01", "pass", new Date().toISOString()),
    };

    for (const [name, write] of Object.entries(writers)) {
      assert.throws(write, /No database open/, `${name} must throw with no open DB`);
    }
  });

  test("lock writers log that their DB half was skipped", (t) => {
    const previousStderr = setStderrLoggingEnabled(false);
    t.after(() => {
      setStderrLoggingEnabled(previousStderr);
      _resetLogs();
    });
    _resetLogs();

    writeLock(base, "execute-task", "M001/S01/T01", "/tmp/session.jsonl");
    clearLock(base);
    clearStaleWorkerLock(base);

    assert.deepEqual(
      drainLogs().filter((entry) => entry.component === "recovery").map((entry) => `${entry.severity}: ${entry.message}`),
      [
        "warn: session file pointer not recorded: workflow DB is unavailable",
        "warn: worker row not released: workflow DB is unavailable",
        "warn: stale worker row not cleared: workflow DB is unavailable",
      ],
    );
  });

  test("session lock over a dead holder is still acquired, and the unmarked worker row is logged", (t) => {
    const previousStderr = setStderrLoggingEnabled(false);
    t.after(() => {
      releaseSessionLock(base);
      setStderrLoggingEnabled(previousStderr);
      _resetLogs();
    });
    _resetLogs();
    const deadPid = 99999999;
    writeFileSync(
      join(base, ".gsd", "auto.lock"),
      JSON.stringify({ pid: deadPid, startedAt: new Date().toISOString(), unitType: "execute-task", unitId: "M001/S01/T01" }),
      "utf-8",
    );

    const result = acquireSessionLock(base);

    assert.equal(result.acquired, true);
    assert.ok(
      drainLogs().some((entry) =>
        entry.severity === "warn" && entry.message === `dead worker ${deadPid} not marked stopping: gsd-db: No database open`),
      "the skipped worker-row update is logged",
    );
  });

  test("post-unit pauses auto when the unit artifact is missing and no DB is open", async () => {
    mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
    const s = new AutoSession();
    s.active = true;
    s.basePath = base;
    s.currentUnit = { type: "complete-slice", id: "M001/S01", startedAt: Date.now() };
    const notifications: string[] = [];
    let pauseCalls = 0;

    const result = await postUnitPreVerification(
      {
        s,
        ctx: { ui: { notify: (message: string) => notifications.push(message) } } as never,
        pi: {} as never,
        buildSnapshotOpts: () => ({}) as never,
        lockBase: () => base,
        stopAuto: async () => {},
        pauseAuto: async () => { pauseCalls += 1; },
        updateProgressWidget: () => {},
      },
      { skipSettleDelay: true, skipWorktreeSync: true },
    );

    assert.equal(result, "dispatched");
    assert.equal(pauseCalls, 1, "auto is paused, not continued to the next unit");
    assert.ok(
      notifications.some((message) => /^Artifact missing for complete-slice M001\/S01 — workflow DB is unavailable/.test(message)),
      `expected the DB-unavailable pause notice, got: ${notifications.join("\n")}`,
    );
  });

  test("host verification does not run the gate without the Task row", async () => {
    let gateRuns = 0;
    const notifications: string[] = [];

    const result = await runPostUnitVerification({
      s: {
        basePath: base,
        canonicalProjectRoot: base,
        currentUnit: { type: "execute-task", id: "M001/S01/T01" },
        lastTaskRecoveryAbortId: null,
        pendingVerificationRetry: null,
        unclaimedUnitBudgets: new Map<string, number>(),
      },
      ctx: { ui: { notify: (message: string) => notifications.push(message) } },
      pi: {},
      taskAuthority: {
        readLatestTaskAttempt: () => ({
          attemptId: "attempt-1",
          resultId: "result-1",
          state: "settled",
          outcome: "succeeded",
          nextStage: "verify",
        }),
        readTaskTechnicalVerdict: () => null,
        recordTaskTechnicalVerdict: () => ({ verdictId: "verdict-1", evidenceId: "evidence-1" }),
        invalidateTaskTechnicalPass: () => { throw new Error("must not invalidate"); },
        routeTaskFailure: () => ({ action: "remediate", status: "applied", recoveryActionId: "ra-1" }),
      },
      runVerificationGate: () => {
        gateRuns += 1;
        return { passed: true, checks: [], discoverySource: "none", timestamp: Date.now() };
      },
    } as never, async () => {});

    assert.equal(gateRuns, 0, "the gate must not run without the Task verify command");
    assert.equal(result, "retry", "the gate error is routed as an inconclusive verdict, never a pass");
    assert.ok(
      notifications.some((message) => message.includes("Host verification requires the workflow DB")),
      `expected the DB-unavailable gate error, got: ${notifications.join("\n")}`,
    );
  });

  test("gate runner returns the gate result and logs an error instead of silently skipping its record", async (t) => {
    const previousStderr = setStderrLoggingEnabled(false);
    t.after(() => {
      setStderrLoggingEnabled(previousStderr);
      _resetLogs();
    });
    _resetLogs();
    const runner = new UokGateRunner();
    runner.register({ id: "g1", type: "policy", execute: async () => ({ outcome: "pass" }) });

    const result = await runner.run("g1", { basePath: base, traceId: "trace-g1", turnId: "turn-g1" });

    assert.equal(result.outcome, "pass");
    assert.ok(
      drainLogs().some((entry) =>
        entry.severity === "error" && entry.message === "gate g1 result not recorded: workflow DB is unavailable"),
      "the unrecorded gate result is logged as an error",
    );
  });

  test("prompt builders give an explicit unavailable block, never the markdown file", async () => {
    writeFileSync(join(base, ".gsd", "DECISIONS.md"), "# Decisions\n\nFILE DECISION D001\n", "utf-8");
    writeFileSync(join(base, ".gsd", "REQUIREMENTS.md"), "# Requirements\n\nFILE REQUIREMENT R001\n", "utf-8");
    writeFileSync(join(base, ".gsd", "PROJECT.md"), "# Project\n\nFILE PROJECT BODY\n", "utf-8");

    const blocks = [
      await inlineDecisionsFromDb(base, "M001"),
      await inlineRequirementsFromDb(base, "M001"),
      await inlineProjectFromDb(base),
    ];

    for (const block of blocks) {
      assert.match(String(block), /unavailable: workflow DB is unavailable/);
      assert.doesNotMatch(String(block), /FILE (DECISION|REQUIREMENT|PROJECT)/);
    }
  });

  test("project prompt uses the PROJECT.md file when the open DB has no project row", async () => {
    const openBase = mkdtempSync(join(tmpdir(), "gsd-db-open-"));
    try {
      mkdirSync(join(openBase, ".gsd"), { recursive: true });
      writeFileSync(join(openBase, ".gsd", "PROJECT.md"), "# Project\n\nFILE PROJECT BODY\n", "utf-8");
      assert.equal(openDatabase(join(openBase, ".gsd", "gsd.db")), true);

      assert.match(String(await inlineProjectFromDb(openBase)), /FILE PROJECT BODY/);
    } finally {
      closeDatabase();
      rmSync(openBase, { recursive: true, force: true });
    }
  });

  test("a warning logged with the DB closed is recorded once, not in a logging loop", (t) => {
    const previousStderr = setStderrLoggingEnabled(false);
    t.after(() => {
      setStderrLoggingEnabled(previousStderr);
      _resetLogs();
    });
    _resetLogs();
    setLogBasePath(base);

    logWarning("engine", "warning with no DB");

    assert.deepEqual(
      drainLogs().map((entry) => `${entry.severity}: ${entry.message}`),
      ["warn: warning with no DB"],
    );
  });

  test("turn timeline refuses to read the JSONL projection", () => {
    mkdirSync(join(base, ".gsd", "audit"), { recursive: true });
    writeFileSync(join(base, ".gsd", "audit", "events.jsonl"), JSON.stringify({ ts: "2026-01-01T00:00:00Z", type: "x" }) + "\n");

    assert.throws(() => buildTurnTimeline(base), /Cannot build turn timeline: workflow DB is unavailable/);
    assert.ok(existsSync(join(base, ".gsd", "gsd.db")), "the unopenable DB file is left in place");
  });
});
