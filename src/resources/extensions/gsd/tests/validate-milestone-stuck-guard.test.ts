// gsd-pi — Regression tests for the validate-milestone stuck-loop guard (#4094)

import { describe, test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { runPostUnitVerification, type VerificationContext } from "../auto-verification.ts";
import { AutoSession } from "../auto/session.ts";
import { readStoredUnitRetry } from "../db/unit-dispatch-retries.ts";
import { claimTestDispatch } from "./helpers/unit-dispatch.ts";
import { clearPathCache } from "../paths.ts";
import {
  openDatabase,
  closeDatabase,
  insertAssessment,
  insertMilestone,
  insertSlice,
  executeDomainOperation,
  readDomainOperationFence,
} from "../gsd-db.ts";
import { invalidateAllCaches } from "../cache.ts";
import { _clearGsdRootCache } from "../paths.ts";
import { adoptOrTransitionLifecycle } from "../db/writers/lifecycle-commands.ts";
import { validateMilestone } from "../milestone-validation-domain-operation.ts";
import { prepareMilestoneSubjectiveUat } from "../milestone-subjective-uat-domain-operation.ts";

let tempDir: string;
let dbPath: string;
let originalCwd: string;

function makeMockCtx() {
  return {
    ui: {
      notify: mock.fn(),
      setStatus: () => {},
      setWidget: () => {},
      setFooter: () => {},
    },
    model: { id: "test-model" },
  } as any;
}

function makeMockPi() {
  return {
    sendMessage: mock.fn(),
    setModel: mock.fn(async () => true),
  } as any;
}

function makeMockSession(basePath: string, unitType: string, unitId: string): AutoSession {
  const s = new AutoSession();
  s.basePath = basePath;
  s.active = true;
  s.pendingVerificationRetry = null;
  s.currentUnit = { type: unitType, id: unitId, startedAt: Date.now() };
  return s;
}

function setupTestEnvironment(): void {
  originalCwd = process.cwd();
  tempDir = join(tmpdir(), `validate-milestone-guard-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });

  const milestoneDir = join(tempDir, ".gsd", "milestones", "M001");
  mkdirSync(milestoneDir, { recursive: true });

  process.chdir(tempDir);
  _clearGsdRootCache();

  dbPath = join(tempDir, ".gsd", "gsd.db");
  openDatabase(dbPath);
  invalidateAllCaches();
}

function cleanupTestEnvironment(): void {
  try { process.chdir(originalCwd); } catch { /* ignore */ }
  try { closeDatabase(); } catch { /* ignore */ }
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function writeValidationFile(verdict: string): void {
  const path = join(tempDir, ".gsd", "milestones", "M001", "M001-VALIDATION.md");
  const content = `---
verdict: ${verdict}
remediation_round: 1
---

# Milestone Validation: M001

## Verdict Rationale
Test fixture
`;
  writeFileSync(path, content, "utf-8");
  insertAssessment({
    path,
    milestoneId: "M001",
    sliceId: null,
    taskId: null,
    status: verdict,
    scope: "milestone-validation",
    fullContent: content,
  });
  invalidateAllCaches();
}

function writeWorktreeValidationFile(verdict: string): void {
  const worktreeRoot = join(tempDir, ".gsd", "worktrees", "M001");
  const path = join(worktreeRoot, ".gsd", "milestones", "M001", "M001-VALIDATION.md");
  mkdirSync(join(worktreeRoot, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(join(worktreeRoot, ".git"), "gitdir: ../.git/worktrees/M001\n", "utf-8");
  const content = `---
verdict: ${verdict}
remediation_round: 1
---

# Milestone Validation: M001

## Verdict Rationale
Worktree fixture
`;
  writeFileSync(path, content, "utf-8");
  insertAssessment({
    path,
    milestoneId: "M001",
    sliceId: null,
    taskId: null,
    status: verdict,
    scope: "milestone-validation",
    fullContent: content,
  });
  invalidateAllCaches();
  clearPathCache();
}

function adoptMilestone(): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.milestone.adopt",
    idempotencyKey: "test/milestone/adopt",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { milestoneId: "M001" },
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone",
      milestoneId: "M001",
      lifecycleStatus: "ready",
    });
    return {
      events: [{
        eventType: "test.milestone.adopted",
        entityType: "milestone",
        entityId: "M001",
        payload: { milestoneId: "M001" },
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: "test/milestone/m001",
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}

function writeCanonicalValidation(verdict: "fail" | "inconclusive"): void {
  adoptMilestone();
  const now = new Date().toISOString();
  validateMilestone({
    invocation: {
      idempotencyKey: `test/milestone/validate/${verdict}`,
      sourceTransport: "internal",
      actorType: "agent",
    },
    milestoneId: "M001",
    testedSourceRevision: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    policyId: "test",
    policyVersion: "1",
    verdict,
    rationale: "Objective evidence is not ready.",
    outcome: verdict === "fail" ? "failed" : "interrupted",
    failureClass: "verification",
    summary: "Objective validation needs more work.",
    output: { verdict },
    criteria: [{
      criterionKey: "objective",
      evidenceClass: "artifact",
      description: "Objective evidence must pass.",
      verdict,
      rationale: "Objective evidence is not ready.",
      evidence: [{
        evidenceClass: "artifact",
        commandOrTool: "test",
        workingDirectory: tempDir,
        startedAt: now,
        endedAt: now,
        observation: verdict === "fail" ? "failed" : "inconclusive",
        durableOutputRef: "db://test/objective",
        environment: { runner: "test" },
      }],
    }],
  });
  invalidateAllCaches();
}

describe("validate-milestone stuck-loop guard (#4094)", () => {
  beforeEach(() => setupTestEnvironment());
  afterEach(() => cleanupTestEnvironment());

  test("retries when verdict=needs-remediation and all slices are closed", async () => {
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice 1", status: "complete" });
    insertSlice({ id: "S02", milestoneId: "M001", title: "Slice 2", status: "done" });
    writeValidationFile("needs-remediation");

    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, "validate-milestone", "M001");

    const result = await runPostUnitVerification({ s, ctx, pi } as VerificationContext, pauseAutoMock);

    // Remediation stays agent-owned for every milestone: the loop retries
    // until the agent queues remediation slices.
    assert.equal(result, "retry");
    assert.equal(pauseAutoMock.mock.callCount(), 0);
    assert.match(s.pendingVerificationRetry?.failureContext ?? "", /gsd_reassess_roadmap/i);
  });

  test("retries the first needs-attention occurrence for any milestone", async () => {
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice 1", status: "complete" });
    writeValidationFile("needs-attention");

    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, "validate-milestone", "M001");

    const result = await runPostUnitVerification({ s, ctx, pi } as VerificationContext, pauseAutoMock);

    // The bounded objective re-validation applies to every milestone; the
    // human pause happens only when the verdict recurs (covered below).
    assert.equal(result, "retry");
    assert.equal(pauseAutoMock.mock.callCount(), 0);
    assert.match(s.pendingVerificationRetry?.failureContext ?? "", /objective evidence/i);
  });

  test("retries adopted objective needs-attention without pausing for a user", async () => {
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice 1", status: "complete" });
    writeCanonicalValidation("inconclusive");
    writeValidationFile("needs-attention");
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, "validate-milestone", "M001");

    const result = await runPostUnitVerification({ s, ctx, pi } as VerificationContext, pauseAutoMock);

    assert.equal(result, "retry");
    assert.equal(pauseAutoMock.mock.callCount(), 0);
    assert.match(s.pendingVerificationRetry?.failureContext ?? "", /objective evidence/i);
  });

  test("a restart does not grant the bounded needs-attention retry again: the count is on the dispatch row", async (t) => {
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice 1", status: "complete" });
    writeCanonicalValidation("inconclusive");
    writeValidationFile("needs-attention");
    const dispatch = claimTestDispatch(tempDir, { milestoneId: "M001", unitType: "validate-milestone", unitId: "M001" });
    const pauseAutoMock = mock.fn(async () => {});
    const stderrWrite = mock.method(process.stderr, "write", () => true);
    t.after(() => stderrWrite.mock.restore());

    const first = makeMockSession(tempDir, "validate-milestone", "M001");
    assert.equal(
      await runPostUnitVerification({ s: first, ctx: makeMockCtx(), pi: makeMockPi() } as VerificationContext, pauseAutoMock),
      "retry",
    );
    const stored = readStoredUnitRetry("validate-milestone", "M001");
    assert.equal(stored?.attempt, 1);
    assert.match(stored?.failureContext ?? "", /objective evidence/i);

    // The process is killed. The next one has a new session and a new dispatch.
    dispatch.claimNext();
    const restarted = makeMockSession(tempDir, "validate-milestone", "M001");
    assert.equal(
      await runPostUnitVerification({ s: restarted, ctx: makeMockCtx(), pi: makeMockPi() } as VerificationContext, pauseAutoMock),
      "pause",
      "the retry the last process used must count",
    );

    assert.equal(pauseAutoMock.mock.callCount(), 1);
    assert.equal(readStoredUnitRetry("validate-milestone", "M001"), null, "the pause releases the stored retry");
  });

  test("pauses with a manual-attention gate when adopted needs-attention recurs after the bounded retry", async () => {
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice 1", status: "complete" });
    writeCanonicalValidation("inconclusive");
    writeValidationFile("needs-attention");
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, "validate-milestone", "M001");
    const stderrWrites: string[] = [];
    const stderrWrite = mock.method(process.stderr, "write", (chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    });

    try {
      const first = await runPostUnitVerification({ s, ctx, pi } as VerificationContext, pauseAutoMock);
      assert.equal(first, "retry");

      const second = await runPostUnitVerification({ s, ctx, pi } as VerificationContext, pauseAutoMock);
      assert.equal(second, "pause");
    } finally {
      stderrWrite.mock.restore();
    }

    assert.equal(pauseAutoMock.mock.callCount(), 1);
    assert.equal(s.pendingVerificationRetry, null);
    assert.match(ctx.ui.notify.mock.calls.at(-1)?.arguments[0] ?? "", /needs-attention/);
    const guidance = stderrWrites.join("");
    assert.match(guidance, /\/gsd validate-milestone/);
    assert.match(guidance, /\/gsd park M001/);
    assert.doesNotMatch(guidance, /\/gsd verdict pass/);
  });

  test("pauses adopted validation only for a pending subjective UAT decision", async () => {
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice 1", status: "complete" });
    adoptMilestone();
    prepareMilestoneSubjectiveUat({
      invocation: {
        idempotencyKey: "test/milestone/subjective/prepare",
        sourceTransport: "internal",
        actorType: "agent",
      },
      milestoneId: "M001",
      criterionKey: "guided-flow",
      description: "The guided flow feels clear.",
      focusedPrompt: "Does the guided flow feel clear?",
      recommendedDisposition: "accepted",
      recommendationRationale: "Automated checks passed.",
      recommendationEvidence: "Current objective evidence.",
      testedSourceRevision: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, "validate-milestone", "M001");

    const result = await runPostUnitVerification({ s, ctx, pi } as VerificationContext, pauseAutoMock);

    assert.equal(result, "pause");
    assert.equal(pauseAutoMock.mock.callCount(), 1);
    assert.equal(s.pendingVerificationRetry, null);
  });

  test("retries adopted remediation until the agent queues remediation work", async () => {
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice 1", status: "complete" });
    writeCanonicalValidation("fail");
    writeValidationFile("needs-remediation");
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, "validate-milestone", "M001");

    const result = await runPostUnitVerification({ s, ctx, pi } as VerificationContext, pauseAutoMock);

    assert.equal(result, "retry");
    assert.equal(pauseAutoMock.mock.callCount(), 0);
    assert.match(s.pendingVerificationRetry?.failureContext ?? "", /gsd_reassess_roadmap/i);
  });

  test("treats skipped slices as closed", async () => {
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice 1", status: "complete" });
    insertSlice({ id: "S02", milestoneId: "M001", title: "Slice 2", status: "skipped" });
    writeValidationFile("needs-remediation");

    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, "validate-milestone", "M001");

    const result = await runPostUnitVerification({ s, ctx, pi } as VerificationContext, pauseAutoMock);

    assert.equal(result, "retry");
    assert.equal(pauseAutoMock.mock.callCount(), 0);
  });

  test("does not count a deferred slice as queued remediation work", async () => {
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice 1", status: "complete" });
    insertSlice({ id: "S02", milestoneId: "M001", title: "Slice 2", status: "deferred" });
    writeValidationFile("needs-remediation");

    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, "validate-milestone", "M001");

    const result = await runPostUnitVerification({ s, ctx, pi } as VerificationContext, pauseAutoMock);

    assert.equal(result, "retry");
    assert.equal(pauseAutoMock.mock.callCount(), 0);
  });

  test("continues when verdict=needs-remediation but a queued remediation slice exists", async () => {
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice 1", status: "complete" });
    insertSlice({ id: "S02", milestoneId: "M001", title: "Remediation", status: "queued" });
    writeValidationFile("needs-remediation");

    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, "validate-milestone", "M001");

    const result = await runPostUnitVerification({ s, ctx, pi } as VerificationContext, pauseAutoMock);

    assert.equal(result, "continue");
    assert.equal(pauseAutoMock.mock.callCount(), 0);
  });

  test("continues when verdict is pass", async () => {
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice 1", status: "complete" });
    writeValidationFile("pass");

    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, "validate-milestone", "M001");

    const result = await runPostUnitVerification({ s, ctx, pi } as VerificationContext, pauseAutoMock);

    assert.equal(result, "continue");
    assert.equal(pauseAutoMock.mock.callCount(), 0);
  });

  test("continues when DB pass references the canonical worktree projection", async () => {
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice 1", status: "complete" });
    writeWorktreeValidationFile("pass");

    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, "validate-milestone", "M001");

    const result = await runPostUnitVerification({ s, ctx, pi } as VerificationContext, pauseAutoMock);

    assert.equal(result, "continue");
    assert.equal(pauseAutoMock.mock.callCount(), 0);
    assert.equal(s.pendingVerificationRetry, null);
  });

  test("continues when DB pass is current and the validation projection is empty", async () => {
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice 1", status: "complete" });
    const path = join(tempDir, ".gsd", "milestones", "M001", "M001-VALIDATION.md");
    writeFileSync(path, "", "utf-8");
    insertAssessment({
      path,
      milestoneId: "M001",
      sliceId: null,
      taskId: null,
      status: "pass",
      scope: "milestone-validation",
      fullContent: "---\nverdict: pass\n---\n",
    });
    invalidateAllCaches();

    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, "validate-milestone", "M001");

    const result = await runPostUnitVerification({ s, ctx, pi } as VerificationContext, pauseAutoMock);

    assert.equal(result, "continue");
    assert.equal(pauseAutoMock.mock.callCount(), 0);
    assert.equal(s.pendingVerificationRetry, null);
  });

  test("continues when DB pass overrides stale worktree needs-attention after /gsd verdict", async () => {
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice 1", status: "complete" });
    writeWorktreeValidationFile("needs-attention");

    const worktreeValidationPath = join(
      tempDir,
      ".gsd",
      "worktrees",
      "M001",
      ".gsd",
      "milestones",
      "M001",
      "M001-VALIDATION.md",
    );
    insertAssessment({
      path: worktreeValidationPath,
      milestoneId: "M001",
      sliceId: null,
      taskId: null,
      status: "pass",
      scope: "milestone-validation",
      fullContent: "---\nverdict: pass\n---\n\n# Validation\nManually overridden via /gsd verdict\n",
    });
    invalidateAllCaches();

    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, "validate-milestone", "M001");

    const result = await runPostUnitVerification({ s, ctx, pi } as VerificationContext, pauseAutoMock);

    assert.equal(result, "continue");
    assert.equal(pauseAutoMock.mock.callCount(), 0);
    assert.equal(ctx.ui.notify.mock.callCount(), 0);
  });

  test("retries when no VALIDATION file exists yet", async () => {
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice 1", status: "complete" });

    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, "validate-milestone", "M001");

    const result = await runPostUnitVerification({ s, ctx, pi } as VerificationContext, pauseAutoMock);

    assert.equal(result, "retry");
    assert.equal(pauseAutoMock.mock.callCount(), 0);
    assert.ok(s.pendingVerificationRetry);
    assert.equal(s.pendingVerificationRetry!.unitId, "M001");
    assert.match(s.pendingVerificationRetry!.failureContext, /gsd_validate_milestone/);
    assert.equal(s.pendingVerificationRetry!.attempt, 1);
  });

  test("retries when VALIDATION file exists but is empty", async () => {
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice 1", status: "complete" });

    const path = join(tempDir, ".gsd", "milestones", "M001", "M001-VALIDATION.md");
    writeFileSync(path, "", "utf-8");
    invalidateAllCaches();

    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, "validate-milestone", "M001");

    const result = await runPostUnitVerification({ s, ctx, pi } as VerificationContext, pauseAutoMock);

    assert.equal(result, "retry");
    assert.equal(pauseAutoMock.mock.callCount(), 0);
    assert.ok(s.pendingVerificationRetry);
    assert.equal(s.pendingVerificationRetry!.unitId, "M001");
    assert.match(s.pendingVerificationRetry!.failureContext, /canonical validation result/i);
    assert.equal(s.pendingVerificationRetry!.attempt, 1);
  });

  /** The row that gsd_reassess_roadmap records. */
  function recordRoadmapReassessment(createdAt?: string): void {
    insertAssessment({
      path: ".gsd/milestones/M001/M001-ROADMAP-ASSESSMENT.md",
      milestoneId: "M001",
      sliceId: "S01",
      status: "roadmap-changed",
      scope: "roadmap",
      fullContent: "Added a remediation slice.",
      ...(createdAt ? { createdAt } : {}),
    });
  }

  test("continues when a roadmap reassessment recorded in this unit left open slices", async () => {
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice 1", status: "complete" });
    insertSlice({ id: "S02", milestoneId: "M001", title: "Remediation", status: "queued" });

    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, "validate-milestone", "M001");
    recordRoadmapReassessment();

    const result = await runPostUnitVerification({ s, ctx, pi } as VerificationContext, pauseAutoMock);

    assert.equal(result, "continue");
    assert.equal(pauseAutoMock.mock.callCount(), 0);
    assert.equal(s.pendingVerificationRetry, null);
  });

  test("retries when the reassessment is only named in messages, an activity log or an ASSESSMENT file", async () => {
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice 1", status: "complete" });
    insertSlice({ id: "S02", milestoneId: "M001", title: "Remediation", status: "queued" });

    const sliceDir = join(tempDir, ".gsd", "milestones", "M001", "slices", "S01");
    mkdirSync(sliceDir, { recursive: true });
    writeFileSync(join(sliceDir, "S01-ASSESSMENT.md"), "# Assessment\n", "utf-8");
    mkdirSync(join(tempDir, ".gsd", "activity"), { recursive: true });
    writeFileSync(
      join(tempDir, ".gsd", "activity", "001-validate-milestone-M001.jsonl"),
      JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "gsd_reassess_roadmap" } }) + "\n",
      "utf-8",
    );

    const s = makeMockSession(tempDir, "validate-milestone", "M001");
    s.lastUnitAgentEndMessages = [
      { role: "assistant", content: [{ type: "toolCall", name: "gsd_reassess_roadmap" }] },
      { role: "toolResult", toolName: "gsd_reassess_roadmap", isError: false },
    ];

    const result = await runPostUnitVerification(
      { s, ctx: makeMockCtx(), pi: makeMockPi() } as VerificationContext,
      mock.fn(async () => {}),
    );

    assert.equal(result, "retry", "with no roadmap assessment row the unit recorded no outcome");
  });

  test("retries when the only roadmap reassessment was recorded before this unit started", async () => {
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice 1", status: "complete" });
    insertSlice({ id: "S02", milestoneId: "M001", title: "Remediation", status: "queued" });
    recordRoadmapReassessment("2020-01-01T00:00:00.000Z");

    const s = makeMockSession(tempDir, "validate-milestone", "M001");

    const result = await runPostUnitVerification(
      { s, ctx: makeMockCtx(), pi: makeMockPi() } as VerificationContext,
      mock.fn(async () => {}),
    );

    assert.equal(result, "retry");
  });
});
