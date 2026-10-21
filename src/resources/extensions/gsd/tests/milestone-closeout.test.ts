// Project/App: gsd-pi
// File Purpose: Tests milestone closeout settlement helper.

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { adoptOrTransitionLifecycle } from "../db/writers/lifecycle-commands.js";
import {
  _getAdapter,
  closeDatabase,
  executeDomainOperation,
  getMilestone,
  insertAssessment,
  insertMilestone,
  insertSlice,
  openDatabase,
  readDomainOperationFence,
} from "../gsd-db.js";
import { reopenMilestone } from "../milestone-lifecycle-domain-operation.js";
import {
  isMilestoneCloseoutSettled,
  evaluateCompleteMilestoneDispatch,
  isCompletedMilestoneTerminal,
  repairMissingMilestoneSummaryProjection,
} from "../milestone-closeout.js";
import { _setCompleteMilestoneProjectionInterleaveForTest } from "../tools/complete-milestone.js";
import { _setManagedMutationBoundaryForTest } from "../atomic-write.js";
import { targetMilestoneFile } from "../paths.js";
import type { DispatchContext } from "../auto-dispatch.js";

/** Build a minimal DispatchContext for the dispatch-policy branches under test. */
function makeDispatchCtx(base: string, phase: string, mid = "M001"): DispatchContext {
  return {
    basePath: base,
    mid,
    midTitle: `${mid}: Test`,
    state: { phase } as DispatchContext["state"],
    prefs: undefined,
  } as DispatchContext;
}

const tmpDirs: string[] = [];
const ADOPTED_COMPLETED_AT = "2026-07-14T12:34:56.000Z";
const SUPERSEDING_COMPLETED_AT = "2026-07-14T12:35:56.000Z";

function operationCount(): number {
  return Number(_getAdapter()!.prepare(
    "SELECT COUNT(*) AS count FROM workflow_operations",
  ).get()!["count"]);
}

function completionEventPayload(milestoneId: string, completedAt: string) {
  return {
    completedAt,
    closeout: {
      title: `${milestoneId}: Durable Closeout`,
      oneLiner: "The durable closeout survived projection loss.",
      narrative: "Projection repair used the immutable completion event.",
      successCriteriaResults: "All success criteria passed.",
      definitionOfDoneResults: "Definition of done satisfied.",
      requirementOutcomes: "REQ-1 satisfied.",
      keyDecisions: ["Keep the database authoritative."],
      keyFiles: ["src/index.ts"],
      lessonsLearned: ["Repair projections without new authority."],
      followUps: "None.",
      deviations: "None.",
    },
  };
}

function seedAdoptedCompletedMilestone(milestoneId: string): void {
  insertMilestone({
    id: milestoneId,
    title: "Durable Closeout",
    status: "complete",
  });
  _getAdapter()!.prepare("UPDATE milestones SET completed_at = ? WHERE id = ?").run(
    ADOPTED_COMPLETED_AT,
    milestoneId,
  );

  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "milestone.complete",
    idempotencyKey: `test/milestone-closeout/${milestoneId}/adopted-completion`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { milestoneId },
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone",
      milestoneId,
      lifecycleStatus: "completed",
    });
    return {
      events: [{
        eventType: "milestone.completed",
        entityType: "milestone",
        entityId: milestoneId,
        payload: completionEventPayload(milestoneId, ADOPTED_COMPLETED_AT),
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: `lifecycle/${milestoneId}`.toLowerCase(),
        projectionKind: "milestone-lifecycle",
        rendererVersion: "1",
      }],
    };
  });
}

function supersedeAdoptedCompletion(milestoneId: string) {
  const preparationReopen = reopenMilestone({
    invocation: {
      idempotencyKey: `test/milestone-closeout/${milestoneId}/prepare-superseding-completion`,
      sourceTransport: "internal",
      actorType: "agent",
    },
    milestoneId,
    reason: "Prepare a canonical newer completion.",
  });
  const fence = readDomainOperationFence();
  const completion = executeDomainOperation({
    operationType: "milestone.complete",
    idempotencyKey: `test/milestone-closeout/${milestoneId}/superseding-completion`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { milestoneId },
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone",
      milestoneId,
      lifecycleStatus: "completed",
    });
    _getAdapter()!.prepare(
      "UPDATE milestones SET status = 'complete', completed_at = ? WHERE id = ?",
    ).run(SUPERSEDING_COMPLETED_AT, milestoneId);
    return {
      events: [{
        eventType: "milestone.completed",
        entityType: "milestone",
        entityId: milestoneId,
        payload: completionEventPayload(milestoneId, SUPERSEDING_COMPLETED_AT),
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: `lifecycle/${milestoneId}`.toLowerCase(),
        projectionKind: "milestone-lifecycle",
        rendererVersion: "1",
      }],
    };
  });
  return { preparationReopen, completion };
}

test.after(() => {
  closeDatabase();
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isMilestoneCloseoutSettled requires DB closed and summary artifact", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-milestone-closeout-"));
  tmpDirs.push(base);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Done", status: "complete" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Done Slice", status: "complete" });
  insertAssessment({
    path: "milestones/M001/M001-VALIDATION.md",
    milestoneId: "M001",
    status: "pass",
    scope: "milestone-validation",
    fullContent: "verdict: pass",
  });
  const milestoneDir = join(base, ".gsd", "milestones", "M001");
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(join(milestoneDir, "M001-SUMMARY.md"), "# Milestone Summary\n");

  const settled = await isMilestoneCloseoutSettled("M001", base);
  assert.equal(settled, true);
});

test("isMilestoneCloseoutSettled accepts summary artifacts in a live milestone worktree", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-milestone-closeout-worktree-"));
  tmpDirs.push(base);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Done", status: "complete" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Done Slice", status: "complete" });
  insertAssessment({
    path: "milestones/M001/M001-VALIDATION.md",
    milestoneId: "M001",
    status: "pass",
    scope: "milestone-validation",
    fullContent: "verdict: pass",
  });

  const worktreeRoot = join(base, ".gsd", "worktrees", "M001");
  const milestoneDir = join(worktreeRoot, ".gsd", "milestones", "M001");
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(join(worktreeRoot, ".git"), `gitdir: ${join(base, ".git", "worktrees", "M001")}\n`);
  writeFileSync(join(milestoneDir, "M001-SUMMARY.md"), "# Milestone Summary\n");

  const settled = await isMilestoneCloseoutSettled("M001", base);
  assert.equal(settled, true);
});

test("isMilestoneCloseoutSettled returns false when summary artifact is missing", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-milestone-closeout-missing-"));
  tmpDirs.push(base);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Open", status: "active" });

  const settled = await isMilestoneCloseoutSettled("M001", base);
  assert.equal(settled, false);
});

// ─── evaluateCompleteMilestoneDispatch: early-return branches ──────────────
// These two branches resolve before the git-commit step, so they are pure of
// any working-tree/git state and safe to unit test.

test("evaluateCompleteMilestoneDispatch returns null when phase is not completing-milestone", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-dispatch-phase-"));
  tmpDirs.push(base);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Open", status: "active" });

  const action = await evaluateCompleteMilestoneDispatch(makeDispatchCtx(base, "executing"));
  assert.equal(action, null, "non-closeout phase should not produce a dispatch action");
});

test("evaluateCompleteMilestoneDispatch skips when milestone is already closed", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-dispatch-closed-"));
  tmpDirs.push(base);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Done", status: "complete" });

  const action = await evaluateCompleteMilestoneDispatch(
    makeDispatchCtx(base, "completing-milestone"),
  );
  assert.ok(action, "an already-closed milestone in completing-milestone should yield an action");
  assert.equal(action!.action, "skip", "already-closed milestone should resolve to skip (idempotent)");
});

test("isCompletedMilestoneTerminal accepts DB complete without SUMMARY artifact", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-terminal-db-complete-"));
  tmpDirs.push(base);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M008", title: "Done", status: "complete" });
  insertSlice({ id: "S01", milestoneId: "M008", title: "Slice", status: "complete" });

  assert.equal(await isCompletedMilestoneTerminal(base, "M008"), true);
});

test("isCompletedMilestoneTerminal accepts validation-pass with all slices closed", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-terminal-validation-pass-"));
  tmpDirs.push(base);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M008", title: "Active", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M008", title: "Slice", status: "complete" });
  insertAssessment({
    path: "milestones/M008/M008-VALIDATION.md",
    milestoneId: "M008",
    status: "pass",
    scope: "milestone-validation",
    fullContent: "verdict: pass",
  });

  assert.equal(await isCompletedMilestoneTerminal(base, "M008"), true);
});

test("evaluateCompleteMilestoneDispatch repairs missing SUMMARY when DB is closed", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-dispatch-repair-summary-"));
  tmpDirs.push(base);
  const m008Dir = join(base, ".gsd", "milestones", "M008");
  mkdirSync(m008Dir, { recursive: true });
  // A content-bearing legacy milestone dir requires at least one non-META file
  // (dirIsContentBearingLegacyMilestone) so the layout sniffer treats it as a
  // real legacy milestone rather than a metadata-only placeholder.
  writeFileSync(join(m008Dir, "M008-CONTEXT.md"), "# M008\n");
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M008", title: "Live Text Search", status: "complete" });
  insertSlice({ id: "S01", milestoneId: "M008", title: "Slice", status: "complete" });
  insertAssessment({
    path: "milestones/M008/M008-VALIDATION.md",
    milestoneId: "M008",
    status: "pass",
    scope: "milestone-validation",
    fullContent: "verdict: pass",
  });

  const action = await evaluateCompleteMilestoneDispatch(
    makeDispatchCtx(base, "completing-milestone", "M008"),
  );
  assert.equal(action?.action, "skip");
  assert.ok(
    existsSync(join(base, ".gsd", "milestones", "M008", "M008-SUMMARY.md")),
    "repair should write the missing milestone SUMMARY projection",
  );
});

test("repairMissingMilestoneSummaryProjection succeeds when milestone dir does not exist yet", async () => {
  // Regression: resolveExpectedArtifactPath returns null before the milestone
  // directory exists. The post-write success check must use the handler's
  // returned summaryPath (the absolute path it just created), not the
  // pre-write resolver result, otherwise repair always reports failure and
  // dispatch falls back to re-dispatching complete-milestone.
  const base = mkdtempSync(join(tmpdir(), "gsd-repair-summary-new-dir-"));
  tmpDirs.push(base);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M042", title: "Done", status: "complete" });

  const repair = await repairMissingMilestoneSummaryProjection(base, "M042");
  assert.equal(repair.ok, true, "repair should report success when handler creates the SUMMARY");
  assert.ok(
    existsSync(targetMilestoneFile(base, "M042", "SUMMARY", "Done")),
    "repair should write the SUMMARY artifact to the canonical projection path",
  );
});

test("repairMissingMilestoneSummaryProjection rebuilds an adopted SUMMARY without new authority", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-repair-adopted-summary-"));
  tmpDirs.push(base);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  seedAdoptedCompletedMilestone("M043");

  const beforeFence = readDomainOperationFence();
  const beforeOperations = operationCount();

  const repair = await repairMissingMilestoneSummaryProjection(base, "M043");

  assert.deepEqual(repair, { ok: true });
  const summaryPath = targetMilestoneFile(base, "M043", "SUMMARY", "Durable Closeout");
  assert.match(readFileSync(summaryPath, "utf8"), /durable closeout survived projection loss/i);
  assert.deepEqual(readDomainOperationFence(), beforeFence, "projection repair must not advance authority");
  assert.equal(operationCount(), beforeOperations, "projection repair must not create a Domain Operation");
});

test("adopted SUMMARY repair cannot outlive a newer Milestone reopen", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-repair-adopted-summary-race-"));
  tmpDirs.push(base);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  seedAdoptedCompletedMilestone("M044");

  const summaryPath = targetMilestoneFile(base, "M044", "SUMMARY", "Durable Closeout");
  const beforeFence = readDomainOperationFence();
  const beforeOperations = operationCount();
  let reopenReceipt: ReturnType<typeof reopenMilestone> | undefined;

  t.after(() => _setManagedMutationBoundaryForTest(null));
  _setManagedMutationBoundaryForTest((boundary, target) => {
    if (boundary === "after-write" && !reopenReceipt && target === summaryPath) {
      reopenReceipt = reopenMilestone({
        invocation: {
          idempotencyKey: "test/milestone-closeout/M044/newer-reopen",
          sourceTransport: "internal",
          actorType: "agent",
        },
        milestoneId: "M044",
        reason: "A newer operation reopened the Milestone during projection repair.",
      });
    }
  });

  const repair = await repairMissingMilestoneSummaryProjection(base, "M044");

  const receipt = reopenReceipt;
  assert.ok(receipt, "the SUMMARY delivery must interleave a newer Milestone reopen");
  assert.equal(existsSync(summaryPath), false, "superseded completion must not leave a SUMMARY");
  assert.equal(getMilestone("M044")?.status, "active");
  assert.equal(operationCount(), beforeOperations + 1, "only the newer reopen may add authority");
  const finalFence = readDomainOperationFence();
  assert.equal(finalFence.projectId, beforeFence.projectId);
  assert.equal(finalFence.revision, receipt.resultingRevision);
  assert.equal(finalFence.authorityEpoch, receipt.resultingAuthorityEpoch);
  assert.equal(repair.ok, false, "superseded repair must not report a current SUMMARY");
});

test("adopted SUMMARY compensation cannot outlive a reopen after a newer completion", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-repair-adopted-summary-chained-race-"));
  tmpDirs.push(base);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  seedAdoptedCompletedMilestone("M045");

  const summaryPath = targetMilestoneFile(base, "M045", "SUMMARY", "Durable Closeout");
  const beforeOperations = operationCount();
  let projectionInterleaves = 0;
  let newerCompletion: ReturnType<typeof supersedeAdoptedCompletion> | undefined;
  let finalReopen: ReturnType<typeof reopenMilestone> | undefined;

  t.after(() => _setCompleteMilestoneProjectionInterleaveForTest(null));
  _setCompleteMilestoneProjectionInterleaveForTest(async () => {
    projectionInterleaves += 1;
    if (projectionInterleaves === 1) {
      newerCompletion = supersedeAdoptedCompletion("M045");
    } else if (projectionInterleaves === 2) {
      finalReopen = reopenMilestone({
        invocation: {
          idempotencyKey: "test/milestone-closeout/M045/final-reopen",
          sourceTransport: "internal",
          actorType: "agent",
        },
        milestoneId: "M045",
        reason: "A final reopen supersedes the compensation write.",
      });
    }
  });

  const repair = await repairMissingMilestoneSummaryProjection(base, "M045");

  const completion = newerCompletion;
  const reopen = finalReopen;
  assert.ok(
    completion,
    `the original repair must lose to a newer completion (${JSON.stringify(repair)})`,
  );
  assert.ok(reopen, "the newer completion compensation must interleave a final reopen");
  assert.equal(projectionInterleaves, 2);
  assert.equal(existsSync(summaryPath), false, "no SUMMARY may survive the final reopen");
  assert.equal(getMilestone("M045")?.status, "active");
  assert.equal(
    operationCount(),
    beforeOperations + 3,
    "only the canonical preparation reopen, completion B, and reopen C may add authority",
  );
  const finalFence = readDomainOperationFence();
  assert.equal(
    completion.preparationReopen.resultingRevision + 1,
    completion.completion.resultingRevision,
  );
  assert.equal(completion.completion.resultingRevision + 1, reopen.resultingRevision);
  assert.equal(finalFence.revision, reopen.resultingRevision);
  assert.equal(finalFence.authorityEpoch, reopen.resultingAuthorityEpoch);
  assert.equal(repair.ok, false, "superseded repair must not report a current SUMMARY");
});

test("repairMissingMilestoneSummaryProjection is idempotent when SUMMARY exists", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-repair-summary-idempotent-"));
  tmpDirs.push(base);
  const milestoneDir = join(base, ".gsd", "milestones", "M001");
  mkdirSync(milestoneDir, { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Done", status: "complete" });
  const summaryPath = join(milestoneDir, "M001-SUMMARY.md");
  writeFileSync(summaryPath, "# Existing summary\n");

  const repair = await repairMissingMilestoneSummaryProjection(base, "M001");
  assert.equal(repair.ok, true);
  assert.equal(readFileSync(summaryPath, "utf-8"), "# Existing summary\n");
});
