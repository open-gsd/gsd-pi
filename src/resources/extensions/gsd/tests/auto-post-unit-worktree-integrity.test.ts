// Regression tests for #2442: worktree integrity gates task publication.
//
// An execute-task dispatched into a GSD worktree whose directory is not a
// registered git worktree must never publish — even when its verification
// evidence is present. A fabricated SUMMARY (or fabricated DB evidence)
// inside a non-worktree directory used to verify cleanly when the integrity
// check only ran for missing artifacts, which is exactly the #2442 incident:
// 11 tasks reported passing verification for code that does not exist.

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { AutoSession } from "../auto/session.ts";
import { _setAutoActiveForTest } from "../auto.ts";
import { gsdRoot } from "../paths.ts";
import { clearPathCache } from "../paths.ts";
import {
  closeDatabase,
  insertArtifact,
  openDatabase,
  _getAdapter,
} from "../gsd-db.ts";
import { isTaskExecutionReadyForHostVerification } from "../auto/task-execution-cutover.ts";
import { claimTaskAttempt, settleTaskAttempt } from "../task-execution-domain-operation.ts";
import { checkLifecycleShadowObservationLoss } from "../doctor-engine-checks.ts";
import type { DoctorIssue } from "../doctor-types.ts";

const tmpDirs: string[] = [];

function makeTmpBase(): string {
  const base = mkdtempSync(join(tmpdir(), `gsd-test-2442-${randomUUID().slice(0, 8)}-`));
  tmpDirs.push(base);
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  return base;
}

function makeBrokenWorktree(base: string): string {
  // The #2442 incident shape: the directory exists, carries GSD audit state
  // and even a plausible SUMMARY, but git never registered it (no .git).
  const worktree = join(base, ".gsd-worktrees", "M001");
  mkdirSync(join(worktree, ".gsd", "audit"), { recursive: true });
  mkdirSync(join(worktree, ".gsd", "phases", "01-slice"), { recursive: true });
  writeFileSync(join(worktree, ".gsd", "audit", "events.jsonl"), "");
  writeFileSync(
    join(worktree, ".gsd", "phases", "01-slice", "T01-SUMMARY.md"),
    "# T01 Summary\n\nFabricated completion evidence for code that does not exist.\n",
  );
  return worktree;
}

function seedDurableAttempt(base: string): string {
  // Mirrors the canonical attempt fixture used by the completion adapter
  // suite: a held milestone lease, a claimed attempt, and a staged successful
  // completion whose Attempt is settled at the verify stage — the exact state
  // that makes DB-authoritative verification report the task as verified.
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  const db = _getAdapter()!;
  db.exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M001', 'Worktree integrity', 'active', '2026-07-12T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, created_at)
    VALUES ('M001', 'S01', 'Integrity', 'active', '2026-07-12T00:00:00.000Z');
    INSERT INTO tasks (
      milestone_id, slice_id, id, title, status, verify, sequence
    ) VALUES (
      'M001', 'S01', 'T01', 'Broken worktree task', 'in_progress', 'npm test', 1
    );
    INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status,
      project_root_realpath
    ) VALUES (
      'worker-1', 'test-host', 1, '2026-07-12T00:00:00.000Z', 'test',
      '2026-07-12T00:00:00.000Z', 'active', '${base.replaceAll("'", "''")}'
    );
    INSERT INTO milestone_leases (
      milestone_id, worker_id, fencing_token, acquired_at, expires_at, status
    ) VALUES (
      'M001', 'worker-1', 7, '2026-07-12T00:00:00.000Z',
      '2099-07-12T00:00:00.000Z', 'held'
    );
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES (
      'trace-dispatch-2442', 'turn-dispatch-2442', 'worker-1', 7,
      'M001', 'S01', 'T01', 'execute-task', 'M001/S01/T01',
      'claimed', 1, '2026-07-12T00:00:00.000Z'
    );
  `);
  const dispatchId = Number((db.prepare("SELECT id FROM unit_dispatches").get() as Record<string, unknown>).id);
  const claim = claimTaskAttempt({
    invocation: {
      idempotencyKey: "worktree-integrity/claim",
      sourceTransport: "pi-tool",
      actorType: "agent",
      actorId: "worktree-integrity-test",
      traceId: "worktree-integrity",
      turnId: "turn-worktree-integrity",
    },
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: dispatchId,
  });
  settleTaskAttempt({
    invocation: {
      idempotencyKey: "worktree-integrity/stage",
      sourceTransport: "pi-tool",
      actorType: "agent",
      actorId: "worktree-integrity-test",
      traceId: "worktree-integrity",
      turnId: "turn-worktree-integrity",
    },
    attemptId: claim.attemptId,
    outcome: "succeeded",
    failureClass: "none",
    summary: "The executor staged a verified-looking completion.",
    output: { verification: "Agent reported npm test passed." },
  });
  return claim.attemptId;
}

interface PostUnitHarness {
  result: Promise<string>;
  s: AutoSession;
  pauseCalls: number;
  notifications: string[];
}

function buildPostUnitHarness(base: string, worktree: string): PostUnitHarness {
  const s = new AutoSession();
  s.active = true;
  s.basePath = base;
  s.currentUnit = {
    type: "execute-task",
    id: "M001/S01/T01",
    startedAt: Date.now(),
    workspaceRoot: worktree,
  };
  const pauseCalls = { count: 0 };
  const notifications: string[] = [];
  const ctx = {
    ui: { notify: (message: string) => { notifications.push(message); } },
  } as any;
  const pi = {} as any;
  const pctx = {
    s,
    ctx,
    pi,
    buildSnapshotOpts: () => ({}) as any,
    lockBase: () => base,
    stopAuto: async () => {},
    pauseAuto: async () => { pauseCalls.count += 1; },
    updateProgressWidget: () => {},
  } as any;
  const { postUnitPreVerification } = require("../auto-post-unit.ts") as {
    postUnitPreVerification: (pctx: unknown, opts?: unknown) => Promise<string>;
  };
  return {
    result: postUnitPreVerification(pctx, { skipSettleDelay: true }),
    s,
    get pauseCalls() { return pauseCalls.count; },
    notifications,
  };
}

beforeEach(() => {
  _setAutoActiveForTest(true);
});

afterEach(() => {
  _setAutoActiveForTest(false);
  closeDatabase();
  clearPathCache();
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

describe("#2442 worktree integrity gates task publication", () => {
  test("a DB-verified execute-task in a broken worktree pauses before publication", async () => {
    const { postUnitPreVerification } = await import("../auto-post-unit.ts");
    const base = makeTmpBase();
    const worktree = makeBrokenWorktree(base);
    seedDurableAttempt(base);
    clearPathCache();
    // The fixture must reproduce the incident exactly: DB-authoritative
    // verification reports the task as verified (a settled, succeeded Attempt
    // at the verify stage) even though its worktree is not a git worktree.
    // Without this the pre-fix path never "verified" and the regression would
    // not be specific to the unconditional gate.
    assert.equal(
      isTaskExecutionReadyForHostVerification("execute-task", "M001/S01/T01"),
      true,
      "fixture: the staged Attempt must satisfy host-verification readiness",
    );

    const s = new AutoSession();
    s.active = true;
    s.basePath = base;
    s.currentUnit = {
      type: "execute-task",
      id: "M001/S01/T01",
      startedAt: Date.now(),
      workspaceRoot: worktree,
    };
    let pauseCalls = 0;
    const notifications: string[] = [];
    const ctx = {
      ui: { notify: (message: string) => { notifications.push(message); } },
    } as any;
    const pi = {} as any;
    const pctx = {
      s,
      ctx,
      pi,
      buildSnapshotOpts: () => ({}) as any,
      lockBase: () => base,
      stopAuto: async () => {},
      pauseAuto: async () => { pauseCalls += 1; },
      updateProgressWidget: () => {},
    } as any;

    const result = await postUnitPreVerification(pctx, { skipSettleDelay: true });

    assert.equal(result, "dispatched", "the run must pause (dispatched) on a broken worktree");
    assert.equal(pauseCalls, 1, "auto-mode must pause for operator repair");
    const integrityNotice = notifications.find((message) => message.includes("Worktree integrity failure"));
    assert.ok(integrityNotice, `a worktree integrity failure must be surfaced, got: ${JSON.stringify(notifications)}`);
    assert.match(integrityNotice!, /is not a valid git worktree/);
    // The fabricated evidence must not be consumed: the task stays unverified
    // and its staged summary projection stays on disk untouched for forensics.
    assert.equal(
      existsSync(join(worktree, ".gsd", "phases", "01-slice", "T01-SUMMARY.md")),
      true,
      "the refusal must not delete evidence",
    );
  });

  test("a healthy worktree does not pause a verified execute-task", async () => {
    const { postUnitPreVerification } = await import("../auto-post-unit.ts");
    const base = makeTmpBase();
    // A real git worktree registration is what the integrity probe validates;
    // here a plain healthy project root also proves the no-op path: a unit
    // whose workspaceRoot is the (non-worktree) base must never pause.
    const s = new AutoSession();
    s.active = true;
    s.basePath = base;
    s.currentUnit = {
      type: "execute-task",
      id: "M001/S01/T01",
      startedAt: Date.now(),
      workspaceRoot: base,
    };
    let pauseCalls = 0;
    const ctx = {
      ui: { notify: () => {} },
    } as any;
    const pi = {} as any;
    const pctx = {
      s,
      ctx,
      pi,
      buildSnapshotOpts: () => ({}) as any,
      lockBase: () => base,
      stopAuto: async () => {},
      pauseAuto: async () => { pauseCalls += 1; },
      updateProgressWidget: () => {},
    } as any;

    await postUnitPreVerification(pctx, { skipSettleDelay: true });

    assert.equal(pauseCalls, 0, "a project-root execute-task must not trip the worktree integrity gate");
  });
});

describe("#2442 doctor surfaces primary_sink_failed observation loss", () => {
  function lossEvent(reason: string): Record<string, unknown> {
    return {
      eventId: `evt-${reason}-${Math.random().toString(36).slice(2, 8)}`,
      type: "lifecycle-shadow-observation-loss",
      ts: "2026-07-12T00:00:00.000Z",
      payload: {
        observationLossAccounting: { lossCount: 1, persistedCount: 0, reason },
      },
    };
  }

  function writeLossEvent(base: string, reason: string): void {
    const gsdDir = join(base, ".gsd");
    mkdirSync(join(gsdDir, "audit"), { recursive: true });
    writeFileSync(join(gsdDir, "audit", "events.jsonl"), `${JSON.stringify(lossEvent(reason))}\n`);
  }

  test("reports a primary_sink_failed loss event from the audit projection", () => {
    const base = makeTmpBase();
    writeLossEvent(base, "primary_sink_failed");
    const issues: DoctorIssue[] = [];

    checkLifecycleShadowObservationLoss(base, issues);

    const loss = issues.find((issue) => issue.code === "lifecycle_shadow_observation_loss");
    assert.ok(loss, "doctor must surface the primary_sink_failed observation loss");
    assert.equal(loss!.severity, "error", "lost canonical shadow observations must fail doctor");
    assert.match(loss!.message, /1 lifecycle-shadow observation was lost/);
    assert.match(loss!.message, /primary sink/);
    // gsdRoot resolves through realpath, so the pointer carries the /private
    // prefix on macOS even though the fixture wrote via /var/folders.
    assert.equal(loss!.file, join(gsdRoot(base), "audit", "events.jsonl"));
    assert.equal(loss!.fixable, false);
  });

  test("reports the loss from the incident's worktree-local audit projection", () => {
    const base = makeTmpBase();
    // The #2442 incident recorded its loss event inside the milestone
    // worktree's own audit projection, not the project root's.
    const worktreeAuditDir = join(base, ".gsd-worktrees", "M035", ".gsd", "audit");
    mkdirSync(worktreeAuditDir, { recursive: true });
    writeFileSync(
      join(worktreeAuditDir, "events.jsonl"),
      `${JSON.stringify(lossEvent("primary_sink_failed"))}\n`,
    );
    const issues: DoctorIssue[] = [];

    checkLifecycleShadowObservationLoss(base, issues);

    const loss = issues.find((issue) => issue.code === "lifecycle_shadow_observation_loss");
    assert.ok(loss, "the worktree-local loss event must be surfaced");
    assert.match(loss!.message, /worktree M035 audit projection/);
    assert.equal(loss!.file, join(base, ".gsd-worktrees", "M035", ".gsd", "audit", "events.jsonl"));
  });

  test("attributes spool-only evidence to the spool, not the projection", () => {
    const base = makeTmpBase();
    const spoolDir = join(base, ".gsd", "runtime");
    mkdirSync(spoolDir, { recursive: true });
    writeFileSync(
      join(spoolDir, "lifecycle-shadow-observation-loss.jsonl"),
      `${JSON.stringify(lossEvent("primary_sink_failed"))}\n`,
    );
    const issues: DoctorIssue[] = [];

    checkLifecycleShadowObservationLoss(base, issues);

    const loss = issues.find((issue) => issue.code === "lifecycle_shadow_observation_loss");
    assert.ok(loss, "the spool-only loss event must be surfaced");
    assert.match(loss!.message, /1 lifecycle-shadow observation was lost/);
    assert.equal(loss!.file, join(gsdRoot(base), "runtime", "lifecycle-shadow-observation-loss.jsonl"));
  });

  test("dedupes mirrored event ids across the projection and the spool", () => {
    const base = makeTmpBase();
    const spoolDir = join(base, ".gsd", "runtime");
    mkdirSync(spoolDir, { recursive: true });
    const auditDir = join(base, ".gsd", "audit");
    mkdirSync(auditDir, { recursive: true });
    const event = lossEvent("primary_sink_failed");
    // The audit projection mirrors the same eventId — it must not double-count.
    writeFileSync(join(auditDir, "events.jsonl"), `${JSON.stringify(event)}\n`);
    writeFileSync(join(spoolDir, "lifecycle-shadow-observation-loss.jsonl"), `${JSON.stringify(event)}\n`);
    const issues: DoctorIssue[] = [];

    checkLifecycleShadowObservationLoss(base, issues);

    const loss = issues.find((issue) => issue.code === "lifecycle_shadow_observation_loss");
    assert.ok(loss, "the mirrored loss event must be surfaced");
    assert.match(loss!.message, /1 lifecycle-shadow observation was lost/, "mirrored event ids count once");
    // The event was first seen in the projection surface, so that is where the
    // evidence pointer leads (both surfaces are listed in the message).
    assert.equal(loss!.file, join(gsdRoot(base), "audit", "events.jsonl"));
  });

  test("matches the loss accounting structurally, not by substring", () => {
    const base = makeTmpBase();
    const auditDir = join(base, ".gsd", "audit");
    mkdirSync(auditDir, { recursive: true });
    const unrelated = {
      ...lossEvent("none"),
      payload: { note: "the operator quoted the string primary_sink_failed in prose" },
    };
    const viaCause = lossEvent("shadow_query_failed");
    (viaCause.payload as { observationLossAccounting: { causes: Array<{ reason: string }> } })
      .observationLossAccounting.causes = [{ reason: "primary_sink_failed" }];
    writeFileSync(
      join(auditDir, "events.jsonl"),
      `${JSON.stringify(unrelated)}\n${JSON.stringify(viaCause)}\n`,
    );
    const issues: DoctorIssue[] = [];

    checkLifecycleShadowObservationLoss(base, issues);

    const loss = issues.find((issue) => issue.code === "lifecycle_shadow_observation_loss");
    assert.ok(loss, "a recorded primary-sink cause must surface");
    assert.match(loss!.message, /1 lifecycle-shadow observation was lost/, "unrelated mentions must not count");
  });

  test("ignores projection_sink_failed losses and clean projects", () => {
    const withOtherReason = makeTmpBase();
    writeLossEvent(withOtherReason, "projection_sink_failed");
    const otherIssues: DoctorIssue[] = [];
    checkLifecycleShadowObservationLoss(withOtherReason, otherIssues);
    assert.equal(
      otherIssues.find((issue) => issue.code === "lifecycle_shadow_observation_loss"),
      undefined,
      "projection-sink losses are not primary-sink losses",
    );

    const clean = makeTmpBase();
    const cleanIssues: DoctorIssue[] = [];
    checkLifecycleShadowObservationLoss(clean, cleanIssues);
    assert.equal(
      cleanIssues.find((issue) => issue.code === "lifecycle_shadow_observation_loss"),
      undefined,
      "a project with no loss events must stay clean",
    );
  });
});
