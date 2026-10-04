// Project/App: gsd-pi
// File Purpose: Tests for run-uat dispatch discovery boundaries.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { checkNeedsRunUat as checkNeedsRunUatFromPrompts } from "../auto-prompts.ts";
import type { DomainOperationContext, DomainOperationResult } from "../db/domain-operation.ts";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
} from "../db/writers/lifecycle-commands.ts";
import {
  closeDatabase,
  executeDomainOperation,
  insertAssessment,
  insertMilestone,
  insertSlice,
  isDbAvailable,
  openDatabase,
  setSliceSummaryMd,
  setSliceUatMd,
} from "../gsd-db.ts";
import { validateMilestone, type ValidateMilestoneReceipt } from "../milestone-validation-domain-operation.ts";
import { checkNeedsRunUat } from "../uat-dispatch.ts";
import type { GSDState } from "../types.ts";

function createFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-uat-dispatch-test-"));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  return base;
}

/** Open an in-memory DB with M001 and a completed S01. */
function openCompletedSliceDb(): void {
  openDatabase(":memory:");
  insertMilestone({ id: "M001", title: "UAT dispatch", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "First slice", status: "complete", risk: "low", depends: [] });
}

/** Record a run-uat verdict row for S01, as gsd_uat_result_save does. */
function recordUatVerdict(status: string): void {
  insertAssessment({
    path: ".gsd/milestones/M001/slices/S01/S01-ASSESSMENT.md",
    milestoneId: "M001",
    sliceId: "S01",
    status,
    scope: "run-uat",
    fullContent: `verdict: ${status.toUpperCase()}`,
  });
}

function writeSliceFile(
  base: string,
  milestoneId: string,
  sliceId: string,
  suffix: string,
  content: string,
): void {
  const dir = join(base, ".gsd", "milestones", milestoneId, "slices", sliceId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sliceId}-${suffix}.md`), content);
}

test("checkNeedsRunUat resolves runtime harness dispatch from the stored UAT spec plus summary", async (t) => {
  const base = createFixtureBase();
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });

  openCompletedSliceDb();
  setSliceSummaryMd(
    "M001",
    "S01",
    [
      "# S01 Summary",
      "",
      "Verification: `npm run test:uat` passed and exercises the browser harness end-to-end.",
    ].join("\n"),
    [
      "# S01 UAT",
      "",
      "## UAT Type",
      "- UAT mode: browser-executable",
      "",
      "## Preconditions",
      "- Start the dev server with `npm run test:server`.",
    ].join("\n"),
  );

  // No UAT or SUMMARY file exists: the spec and its context come from the slice row.
  assert.deepEqual(await checkNeedsRunUat(base, "M001", { uat_dispatch: true }, [{ sliceId: "S01" }]), {
    sliceId: "S01",
    uatType: "runtime-executable",
  });
});

test("checkNeedsRunUat skips slices that already have a recorded UAT verdict", async (t) => {
  const base = createFixtureBase();
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });

  openCompletedSliceDb();
  setSliceUatMd("M001", "S01", ["# S01 UAT", "", "## UAT Type", "- UAT mode: artifact-driven"].join("\n"));
  recordUatVerdict("pass");

  assert.equal(await checkNeedsRunUat(base, "M001", { uat_dispatch: true }, [{ sliceId: "S01" }]), null);
});

test("checkNeedsRunUat dispatches when only an ASSESSMENT file carries a PASS verdict", async (t) => {
  const base = createFixtureBase();
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });

  openCompletedSliceDb();
  setSliceUatMd("M001", "S01", ["# S01 UAT", "", "## UAT Type", "- UAT mode: runtime-executable"].join("\n"));
  // A hand-edited verdict line is not a recorded verdict.
  writeSliceFile(base, "M001", "S01", "ASSESSMENT", "---\nverdict: PASS\n---\n# UAT Assessment\n");
  writeSliceFile(base, "M001", "S01", "UAT", "---\nverdict: PASS\n---\n# UAT\n");

  assert.deepEqual(
    await checkNeedsRunUat(base, "M001", { uat_dispatch: true }, [{ sliceId: "S01" }]),
    { sliceId: "S01", uatType: "runtime-executable" },
  );
});

test("checkNeedsRunUat retries a recorded FAIL verdict only during milestone closeout", async (t) => {
  const base = createFixtureBase();
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });

  openCompletedSliceDb();
  setSliceUatMd("M001", "S01", ["# S01 UAT", "", "## UAT Type", "- UAT mode: runtime-executable"].join("\n"));
  recordUatVerdict("fail");

  assert.equal(
    await checkNeedsRunUat(base, "M001", { uat_dispatch: true }, [{ sliceId: "S01" }]),
    null,
    "a failed UAT must not prevent later remediation slices from running",
  );
  assert.deepEqual(
    await checkNeedsRunUat(
      base,
      "M001",
      { uat_dispatch: true },
      [{ sliceId: "S01" }],
      { retryNonPass: true },
    ),
    { sliceId: "S01", uatType: "runtime-executable" },
    "closeout must make the documented failed-UAT recovery path reachable",
  );
});

test("checkNeedsRunUat does not read a roadmap-scoped assessment as a UAT verdict", async (t) => {
  const base = createFixtureBase();
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  openCompletedSliceDb();
  setSliceUatMd("M001", "S01", "# UAT\n\n## UAT Type\n- UAT mode: runtime-executable\n");
  recordUatVerdict("pass");
  insertAssessment({
    path: ".gsd/milestones/M001/M001-ROADMAP-ASSESSMENT.md",
    milestoneId: "M001",
    sliceId: "S01",
    status: "fail",
    scope: "roadmap",
    fullContent: "verdict: FAIL",
  });

  // The run-uat row says PASS; the roadmap row's FAIL is not a UAT verdict to retry.
  assert.equal(
    await checkNeedsRunUat(base, "M001", { uat_dispatch: true }, [], { retryNonPass: true }),
    null,
  );
});

test("auto-prompts keeps the compatibility checkNeedsRunUat wrapper", async (t) => {
  const base = createFixtureBase();
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });

  // The wrapper derives its own candidates from DB rows (the roadmap checkbox
  // read it replaced is gone), so S01 must be a completed row for the wrapper
  // to have anything to dispatch.
  openDatabase(":memory:");
  assert.ok(isDbAvailable());
  insertMilestone({ id: "M001", title: "UAT dispatch", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "First slice", status: "complete", risk: "low", depends: [] });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Next slice", status: "pending", risk: "low", depends: ["S01"] });

  setSliceUatMd("M001", "S01", ["# S01 UAT", "", "## UAT Type", "- UAT mode: human-experience"].join("\n"));

  const legacyState: GSDState = {
    activeMilestone: { id: "M001", title: "UAT dispatch" },
    activeSlice: { id: "S02", title: "Next slice" },
    activeTask: null,
    phase: "planning",
    recentDecisions: [],
    blockers: [],
    nextAction: "Plan S02",
    registry: [],
  };

  assert.deepEqual(
    await checkNeedsRunUatFromPrompts(base, "M001", legacyState, { uat_dispatch: true }),
    { sliceId: "S01", uatType: "human-experience" },
  );
});

test("checkNeedsRunUat treats the DB as authoritative and ignores roadmap fallback when DB slices exist but none are complete", async (t) => {
  const base = createFixtureBase();
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });

  // DB knows this milestone's slices, but none are complete.
  openDatabase(":memory:");
  assert.ok(isDbAvailable());
  insertMilestone({ id: "M001", title: "UAT dispatch", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "First slice", status: "active", risk: "low", depends: [] });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Next slice", status: "pending", risk: "low", depends: [] });

  // S01 has a dispatchable UAT spec, so the fallback candidate *would*
  // dispatch S01 if it were (incorrectly) consulted.
  setSliceUatMd("M001", "S01", ["# S01 UAT", "", "## UAT Type", "- UAT mode: human-experience"].join("\n"));

  // DB is authoritative: no completed slices means no dispatch, and the roadmap
  // fallback candidate must NOT be consulted (regression for #1268).
  assert.equal(
    await checkNeedsRunUat(base, "M001", { uat_dispatch: true }, [{ sliceId: "S01" }]),
    null,
  );
});

test("checkNeedsRunUat dispatches nothing for a candidate that has no slice row", async (t) => {
  const base = createFixtureBase();
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });

  // DB is available but has no rows for M001. A UAT file on disk is not a UAT
  // spec: the spec is read from the slice row, and there is none.
  openDatabase(":memory:");
  assert.ok(isDbAvailable());
  writeSliceFile(
    base,
    "M001",
    "S01",
    "UAT",
    ["# S01 UAT", "", "## UAT Type", "- UAT mode: human-experience"].join("\n"),
  );

  assert.equal(
    await checkNeedsRunUat(base, "M001", { uat_dispatch: true }, [{ sliceId: "S01" }]),
    null,
  );
});

// ── #2347: retryNonPass must not re-dispatch UAT the validator already saw ──

const SLICE_UAT_RECORDED_AT = "2020-01-01T00:00:00.000Z";

function executeFixtureOp(
  operationType: string,
  write: (context: Readonly<DomainOperationContext>) => void = () => {},
): DomainOperationResult {
  const fence = readDomainOperationFence();
  return executeDomainOperation({
    operationType,
    idempotencyKey: `test/${operationType}/${fence.revision}`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { operationType, revision: fence.revision },
  }, (context) => {
    write(context);
    return {
      events: [{
        eventType: operationType,
        entityType: "milestone",
        entityId: "M001",
        payload: { operationType },
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: `test/${operationType}/${context.resultingRevision}`,
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}

/** Completed slice with a runtime-executable UAT spec (#2347 scenario). */
function storeRuntimeUatSpec(): void {
  setSliceUatMd("M001", "S01", ["# S01 UAT", "", "## UAT Type", "- UAT mode: runtime-executable"].join("\n"));
}

function insertPartialUatAssessmentRow(createdAt: string): void {
  insertAssessment({
    path: ".gsd/milestones/M001/slices/S01/S01-ASSESSMENT.md",
    milestoneId: "M001",
    sliceId: "S01",
    status: "partial",
    scope: "run-uat",
    fullContent: "verdict: PARTIAL",
    createdAt,
  });
}

function openCloseoutFixture(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-uat-dispatch-closeout-"));
  assert.equal(openDatabase(join(base, "gsd.db")), true);
  insertMilestone({ id: "M001", title: "UAT dispatch", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "First slice", status: "complete", risk: "low", depends: [] });
  executeFixtureOp("test.fixture.adopt", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone",
      milestoneId: "M001",
      lifecycleStatus: "ready",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "slice",
      milestoneId: "M001",
      sliceId: "S01",
      lifecycleStatus: "completed",
    });
  });
  return base;
}

// #2470: validation persistence rejects any non-sha256 testedSourceRevision;
// fixtures use the same format-valid zero hash as the other lifecycle tests.
const FIXTURE_SOURCE_REVISION = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

function recordPassingValidation(): ValidateMilestoneReceipt {
  const runId = readDomainOperationFence().revision;
  return validateMilestone({
    invocation: {
      idempotencyKey: `canonical/${runId}/validate`,
      sourceTransport: "internal",
      actorType: "agent",
      actorId: "uat-dispatch-test",
    },
    milestoneId: "M001",
    testedSourceRevision: FIXTURE_SOURCE_REVISION,
    policyId: "test-policy",
    policyVersion: "1",
    verdict: "pass",
    rationale: "Validation recorded pass.",
    outcome: "succeeded",
    failureClass: "none",
    summary: "Focused proof completed.",
    output: { testedSourceRevision: FIXTURE_SOURCE_REVISION },
    criteria: [{
      criterionKey: "focused-proof",
      evidenceClass: "command",
      description: "Focused proof must pass",
      verdict: "pass",
      rationale: "Focused proof recorded pass.",
      evidence: [{
        evidenceClass: "command",
        commandOrTool: "node --test focused.test.ts",
        workingDirectory: ".",
        startedAt: SLICE_UAT_RECORDED_AT,
        endedAt: SLICE_UAT_RECORDED_AT,
        exitCode: 0,
        observation: "passed",
        durableOutputRef: `db://focused-proof/${runId}`,
        environment: { runner: "node-test" },
      }],
    }],
  });
}

test("checkNeedsRunUat skips a PARTIAL retry predating the accepted validation pass receipt", async (t) => {
  const base = openCloseoutFixture();
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });

  storeRuntimeUatSpec();
  insertPartialUatAssessmentRow(SLICE_UAT_RECORDED_AT);
  recordPassingValidation();

  assert.deepEqual(
    await checkNeedsRunUat(base, "M001", { uat_dispatch: true }, [], { retryNonPass: true }),
    null,
    "a UAT verdict the validator already saw must not be re-dispatched at closeout (#2347)",
  );
});

test("checkNeedsRunUat still retries a PARTIAL UAT when no validation receipt exists", async (t) => {
  const base = openCloseoutFixture();
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });

  storeRuntimeUatSpec();
  insertPartialUatAssessmentRow(SLICE_UAT_RECORDED_AT);

  assert.deepEqual(
    await checkNeedsRunUat(base, "M001", { uat_dispatch: true }, [], { retryNonPass: true }),
    { sliceId: "S01", uatType: "runtime-executable" },
  );
});

test("checkNeedsRunUat still retries a PARTIAL UAT recorded after the validation receipt", async (t) => {
  const base = openCloseoutFixture();
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });

  storeRuntimeUatSpec();
  recordPassingValidation();
  insertPartialUatAssessmentRow(new Date(Date.now() + 60_000).toISOString());

  assert.deepEqual(
    await checkNeedsRunUat(base, "M001", { uat_dispatch: true }, [], { retryNonPass: true }),
    { sliceId: "S01", uatType: "runtime-executable" },
    "a UAT verdict newer than the pass receipt is not covered by the acceptance",
  );
});

test("checkNeedsRunUat fails open on an unparseable UAT assessment timestamp", async (t) => {
  const base = openCloseoutFixture();
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });

  storeRuntimeUatSpec();
  insertPartialUatAssessmentRow(" ");
  recordPassingValidation();

  assert.deepEqual(
    await checkNeedsRunUat(base, "M001", { uat_dispatch: true }, [], { retryNonPass: true }),
    { sliceId: "S01", uatType: "runtime-executable" },
    "an unparseable assessment timestamp must not suppress the retry",
  );
});
