// Project/App: gsd-pi
// File Purpose: Regression tests that getTaskVerificationEvidence never reports an
// unknown (NULL / non-numeric) exit_code as a passing zero (#1591).
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  openDatabase,
  closeDatabase,
  isDbAvailable,
  transaction,
  _getAdapter,
  insertMilestone,
  insertSlice,
  insertTask,
  insertVerificationEvidence,
  getTaskVerificationEvidence,
} from "../gsd-db.ts";
import { hasQualifyingTaskEvidence } from "../verification-gate.ts";
import type { TaskVerificationEvidence } from "../verification-gate.ts";

const MID = "m1";
const SID = "s1";
const TID = "t1";

/** Insert an evidence row with raw column values the typed API cannot express. */
function insertRawEvidence(values: {
  command: string;
  exitCode: unknown;
  verdict: string;
  durationMs: unknown;
}): void {
  transaction(() =>
    _getAdapter()!.prepare(
      `INSERT INTO verification_evidence
         (task_id, slice_id, milestone_id, command, exit_code, verdict, duration_ms, created_at)
       VALUES (:task_id, :slice_id, :milestone_id, :command, :exit_code, :verdict, :duration_ms, :created_at)`,
    ).run({
      ":task_id": TID,
      ":slice_id": SID,
      ":milestone_id": MID,
      ":command": values.command,
      ":exit_code": values.exitCode,
      ":verdict": values.verdict,
      ":duration_ms": values.durationMs,
      ":created_at": new Date().toISOString(),
    }),
  );
}

describe("getTaskVerificationEvidence: unknown exit codes", () => {
  beforeEach(() => {
    openDatabase(":memory:");
    if (!isDbAvailable()) return;
    // verification_evidence carries foreign keys onto the engine hierarchy.
    insertMilestone({ id: MID });
    insertSlice({ id: SID, milestoneId: MID });
    insertTask({ id: TID, sliceId: SID, milestoneId: MID });
  });

  afterEach(() => {
    closeDatabase();
  });

  test("a NULL exit_code is reported as non-zero, not as a passing 0", () => {
    if (!isDbAvailable()) return; // no native driver on this host
    insertRawEvidence({ command: "pnpm test", exitCode: null, verdict: "pass", durationMs: null });

    const [evidence] = getTaskVerificationEvidence(MID, SID, TID);

    assert.notEqual(evidence.exitCode, 0);
    assert.equal(evidence.command, "pnpm test");
    // A NULL duration must be omitted rather than coerced to 0.
    assert.equal(evidence.durationMs, undefined);
  });

  test("a non-numeric exit_code is reported as non-zero", () => {
    if (!isDbAvailable()) return;
    insertRawEvidence({ command: "pnpm lint", exitCode: "unknown", verdict: "pass", durationMs: "n/a" });

    const [evidence] = getTaskVerificationEvidence(MID, SID, TID);

    assert.notEqual(evidence.exitCode, 0);
    assert.equal(evidence.durationMs, undefined);
  });

  test("evidence with an unknown exit_code qualifies via its staged verdict (#2213)", () => {
    if (!isDbAvailable()) return;
    // #2213: the executor's staged verdict is authoritative when present —
    // exit_code is only the fallback for verdictless records. A NULL exit_code
    // with an explicit "pass" verdict (e.g. a negated idiom whose code the
    // harness could not capture) now qualifies.
    insertRawEvidence({ command: "pnpm test", exitCode: null, verdict: "pass", durationMs: null });

    assert.equal(hasQualifyingTaskEvidence(getTaskVerificationEvidence(MID, SID, TID)), true);
  });

  test("a genuinely passing row still qualifies", () => {
    if (!isDbAvailable()) return;
    insertVerificationEvidence({
      taskId: TID,
      sliceId: SID,
      milestoneId: MID,
      command: "pnpm test",
      exitCode: 0,
      verdict: "pass",
      durationMs: 1200,
    });

    const [evidence] = getTaskVerificationEvidence(MID, SID, TID);

    assert.equal(evidence.exitCode, 0);
    assert.equal(evidence.durationMs, 1200);
    assert.equal(hasQualifyingTaskEvidence(getTaskVerificationEvidence(MID, SID, TID)), true);
  });

  test("one unknown exit_code no longer disqualifies an otherwise passing set (#2213)", () => {
    if (!isDbAvailable()) return;
    insertVerificationEvidence({
      taskId: TID,
      sliceId: SID,
      milestoneId: MID,
      command: "pnpm test",
      exitCode: 0,
      verdict: "pass",
      durationMs: 10,
    });
    insertRawEvidence({ command: "pnpm lint", exitCode: null, verdict: "pass", durationMs: null });

    const evidence = getTaskVerificationEvidence(MID, SID, TID);

    assert.equal(evidence.length, 2);
    // #2213: the staged verdict is authoritative when present, so an unknown
    // exit_code on an explicitly passing record no longer poisons the set.
    assert.equal(hasQualifyingTaskEvidence(evidence), true);
  });
});

// ─── Negated-idiom evidence: deliberate non-zero exits (#2213) ──────────────
describe("hasQualifyingTaskEvidence: negated verify idioms", () => {
  beforeEach(() => {
    openDatabase(":memory:");
    if (!isDbAvailable()) return;
    insertMilestone({ id: MID });
    insertSlice({ id: SID, milestoneId: MID });
    insertTask({ id: TID, sliceId: SID, milestoneId: MID });
  });

  test("a negated-idiom record (exit 1 = pass, verdict pass) qualifies", () => {
    if (!isDbAvailable()) return;
    insertVerificationEvidence({
      taskId: TID,
      sliceId: SID,
      milestoneId: MID,
      // `! grep -q "X" file` exits 1 when the absence check PASSES.
      command: '! grep -q "VBA" src/lib/content/service-pages.ts',
      exitCode: 1,
      verdict: "pass",
      durationMs: 400,
    });

    assert.equal(hasQualifyingTaskEvidence(getTaskVerificationEvidence(MID, SID, TID)), true);
  });

  test("a mixed set (exit-0 pass + deliberate exit-1 pass) qualifies", () => {
    if (!isDbAvailable()) return;
    insertVerificationEvidence({
      taskId: TID,
      sliceId: SID,
      milestoneId: MID,
      command: "npx tsc --noEmit",
      exitCode: 0,
      verdict: "pass",
      durationMs: 900,
    });
    insertVerificationEvidence({
      taskId: TID,
      sliceId: SID,
      milestoneId: MID,
      command: '! grep -q "VBA" src/lib/content/service-pages.ts',
      exitCode: 1,
      verdict: "pass",
      durationMs: 300,
    });

    assert.equal(hasQualifyingTaskEvidence(getTaskVerificationEvidence(MID, SID, TID)), true);
  });

  test("a record the executor marked fail still disqualifies the set", () => {
    if (!isDbAvailable()) return;
    insertVerificationEvidence({
      taskId: TID,
      sliceId: SID,
      milestoneId: MID,
      command: "npx tsc --noEmit",
      exitCode: 0,
      verdict: "pass",
      durationMs: 900,
    });
    insertVerificationEvidence({
      taskId: TID,
      sliceId: SID,
      milestoneId: MID,
      command: "npx playwright test",
      exitCode: 1,
      verdict: "fail",
      durationMs: 400,
    });

    assert.equal(hasQualifyingTaskEvidence(getTaskVerificationEvidence(MID, SID, TID)), false);
  });
});

// ─── Lenient verdict matching at the gate (#2014) ───────────────────────────
describe("hasQualifyingTaskEvidence: lenient verdict matching (#2014)", () => {
  const record = (verdict: string, exitCode = 0): TaskVerificationEvidence => ({
    command: "pnpm test",
    exitCode,
    verdict,
    durationMs: 10,
  });

  test("bare pass/passed verdicts still qualify (case-insensitive)", () => {
    assert.equal(hasQualifyingTaskEvidence([record("pass")]), true);
    assert.equal(hasQualifyingTaskEvidence([record("passed")]), true);
    assert.equal(hasQualifyingTaskEvidence([record("PASS")]), true);
    assert.equal(hasQualifyingTaskEvidence([record("Passed")]), true);
  });

  test("bare fail/failed verdicts still disqualify", () => {
    assert.equal(hasQualifyingTaskEvidence([record("fail")]), false);
    assert.equal(hasQualifyingTaskEvidence([record("failed")]), false);
    assert.equal(hasQualifyingTaskEvidence([record("FAIL")]), false);
  });

  test("decorated verdicts qualify (#2014)", () => {
    assert.equal(hasQualifyingTaskEvidence([record("✅ pass")]), true);
    assert.equal(hasQualifyingTaskEvidence([record("✅ Passed")]), true);
    assert.equal(hasQualifyingTaskEvidence([record("❌ fail")]), false);
    assert.equal(hasQualifyingTaskEvidence([record("❌ failed")]), false);
  });

  test("descriptive 'verdict: details' forms qualify on the leading token (#2014)", () => {
    assert.equal(hasQualifyingTaskEvidence([record("pass: all checks green")]), true);
    assert.equal(hasQualifyingTaskEvidence([record("✅ pass: all checks green")]), true);
    assert.equal(hasQualifyingTaskEvidence([record("failed: x")]), false);
  });

  test("em/en-dash and spaced-hyphen description separators evaluate the leading token (#2014)", () => {
    assert.equal(hasQualifyingTaskEvidence([record("pass — all checks green")]), true);
    assert.equal(hasQualifyingTaskEvidence([record("pass – all checks green")]), true);
    assert.equal(hasQualifyingTaskEvidence([record("pass - all checks green")]), true);
    assert.equal(hasQualifyingTaskEvidence([record("failed — suite B")]), false);
  });

  test("unknown verdict tokens fail closed even with exit 0 (#2014)", () => {
    assert.equal(hasQualifyingTaskEvidence([record("partial")]), false);
    assert.equal(hasQualifyingTaskEvidence([record("failure")]), false);
    assert.equal(hasQualifyingTaskEvidence([record("ok")]), false);
    assert.equal(hasQualifyingTaskEvidence([record("✅")]), false);
  });

  test("verdict-less records still fall back to exitCode === 0 (#2213)", () => {
    assert.equal(hasQualifyingTaskEvidence([record("", 0)]), true);
    assert.equal(hasQualifyingTaskEvidence([record("", 1)]), false);
  });

  test("one decorated failing record disqualifies an otherwise passing set", () => {
    assert.equal(
      hasQualifyingTaskEvidence([record("✅ pass"), record("❌ fail")]),
      false,
    );
  });
});
