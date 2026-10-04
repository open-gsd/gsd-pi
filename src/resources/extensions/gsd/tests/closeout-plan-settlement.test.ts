// Project/App: gsd-pi
// File Purpose: Behavior contract for the Milestone Closeout Plan and its Settlement Receipts.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { verifyExpectedArtifact } from "../auto-recovery.ts";
import { mergeMilestoneToMain } from "../auto-worktree-merge.ts";
import {
  _resetPreTeardownSafetyDepsForTests,
  _setPreTeardownSafetyDepsForTests,
} from "../auto-worktree-merge-pre-teardown.ts";
import {
  pendingRequiredCloseoutEffects,
  prepareCloseout,
  readMilestoneCloseoutPlan,
  recordSettlementReceipt,
  settleCloseout,
} from "../closeout-domain-operation.ts";
import type { DomainOperationContext } from "../db/domain-operation.ts";
import { readMilestoneLifecycleStatus } from "../db/milestone-closeout-readiness.ts";
import { adoptOrTransitionLifecycle } from "../db/writers/lifecycle-commands.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";
import { clearParseCache } from "../files.ts";
import {
  _getAdapter,
  closeDatabase,
  executeDomainOperation,
  getMilestone,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
  readDomainOperationFence,
} from "../gsd-db.ts";
import {
  MergeConflictError,
  milestoneMetaPath,
  readIntegrationBranch,
  writeIntegrationBranch,
} from "../git-service.ts";
import {
  completeMilestone,
  reopenMilestone,
} from "../milestone-lifecycle-domain-operation.ts";
import { runMilestoneCloseoutGitHub } from "../milestone-closeout.ts";
import { evaluateAllCompleteSettlement } from "../milestone-settlement.ts";
import { _clearGsdRootCache, clearPathCache } from "../paths.ts";
import { publishMilestone } from "../publication.ts";
import { deriveState, invalidateStateCache } from "../state.ts";
import { handleCompleteMilestone } from "../tools/complete-milestone.ts";
import { handleValidateMilestone } from "../tools/validate-milestone.ts";
import { captureVerificationSourceSnapshot } from "../verification-source-integrity.ts";
import { closeUnit } from "../unit-closeout.ts";
import { findUnmergedCompletedMilestones } from "../unmerged-milestone-guard.ts";
import { _resetServiceCache } from "../worktree.ts";
import { mergeMilestoneStandalone } from "../worktree-lifecycle.ts";
import { worktreePath } from "../worktree-manager.ts";
import { WorktreeStateProjection } from "../worktree-state-projection.ts";
import {
  _resetGhCache,
  _setGhAvailableForTest,
  _setGhRateLimitOkForTest,
} from "../../github-sync/cli.ts";
import { createEmptyMapping, loadSyncMapping, setMilestoneRecord } from "../../github-sync/mapping.ts";
import { _resetConfigCache, _setGhCloseOverridesForTest } from "../../github-sync/sync.ts";

const tempDirs = new Set<string>();

const MERGE_EFFECT = { effectKind: "milestone-merge", required: true };
const PUSH_EFFECT = { effectKind: "integration-push", required: false };

const closeout = {
  title: "Closeout Plan",
  oneLiner: "Closed out one Milestone through a plan and receipts.",
  narrative: "The Milestone was prepared, its host effects settled, then it completed.",
  successCriteriaResults: "Passed.",
  definitionOfDoneResults: "Passed.",
  requirementOutcomes: "Covered.",
  keyDecisions: [],
  keyFiles: [],
  lessonsLearned: [],
  followUps: "None.",
  deviations: "None.",
};

function invocation(idempotencyKey: string): ExecutionInvocation {
  return { idempotencyKey, sourceTransport: "pi-tool", actorType: "agent" };
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

function atFence(idempotencyKey: string, write: (context: Readonly<DomainOperationContext>) => void): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.closeout.fixture",
    idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { idempotencyKey },
  }, (context) => {
    write(context);
    return {
      events: [{
        eventType: "test.closeout.fixture",
        entityType: "milestone",
        entityId: "M001",
        payload: { idempotencyKey },
        destinations: ["test"],
      }],
      projections: [{ projectionKey: `test/${idempotencyKey}`, projectionKind: "test", rendererVersion: "1" }],
    };
  });
}

function sourceRevision(basePath: string): string {
  const source = captureVerificationSourceSnapshot([{ id: "project", cwd: basePath }]);
  if (!source.ok) assert.fail(source.error);
  return source.snapshot.aggregateRevision;
}

/** An adopted, validated Milestone M001 whose only Slice and Task are complete. */
async function validatedMilestone(): Promise<{ basePath: string; sourceRevision: string }> {
  const basePath = realpathSync(mkdtempSync(join(tmpdir(), "gsd-closeout-plan-")));
  tempDirs.add(basePath);
  mkdirSync(join(basePath, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(join(basePath, ".gitignore"), ".gsd/\n");
  writeFileSync(join(basePath, "source.ts"), "export const source = 1;\n");
  git(["init", "-b", "main"], basePath);
  git(["config", "user.email", "test@example.com"], basePath);
  git(["config", "user.name", "Test"], basePath);
  git(["add", "."], basePath);
  git(["commit", "-m", "fixture"], basePath);

  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Closeout Plan", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "complete" });
  atFence("fixture/adopt", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "ready",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "slice", milestoneId: "M001", sliceId: "S01", lifecycleStatus: "completed",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01", lifecycleStatus: "completed",
    });
  });
  const validated = await handleValidateMilestone({
    milestoneId: "M001",
    verdict: "pass",
    remediationRound: 0,
    successCriteriaChecklist: "- [x] Complete",
    sliceDeliveryAudit: "| S01 | delivered |",
    crossSliceIntegration: "Passed",
    requirementCoverage: "Covered",
    verificationClasses: "| Class | Evidence | Verdict |\n| --- | --- | --- |\n| Contract | focused test | PASS |",
    verdictRationale: "All current database evidence passes.",
  }, basePath, { invocation: invocation("fixture/validate"), skipBrowserEvidenceGate: true });
  assert.ok(!("error" in validated), `validation fixture failed: ${"error" in validated ? validated.error : ""}`);
  return { basePath, sourceRevision: sourceRevision(basePath) };
}

function prepare(revision: string, key: string, effects = [MERGE_EFFECT, PUSH_EFFECT]) {
  return prepareCloseout({
    invocation: invocation(key),
    milestoneId: "M001",
    sourceRevision: revision,
    closeout,
    effects,
  });
}

function count(table: string): number {
  return Number(_getAdapter()!.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.["n"]);
}

const savedCwd = process.cwd();
const savedHome = process.env.HOME;
const savedGsdHome = process.env.GSD_HOME;

afterEach(() => {
  _setGhCloseOverridesForTest(null);
  _setGhAvailableForTest(null);
  _setGhRateLimitOkForTest(null);
  _resetGhCache();
  _resetConfigCache();
  _resetPreTeardownSafetyDepsForTests();
  process.chdir(savedCwd);
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  if (savedGsdHome === undefined) delete process.env.GSD_HOME; else process.env.GSD_HOME = savedGsdHome;
  _clearGsdRootCache();
  _resetServiceCache();
  invalidateStateCache();
  clearPathCache();
  clearParseCache();
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("prepareCloseout stores the plan and its effects while the Milestone stays open", async () => {
  const fixture = await validatedMilestone();

  const plan = prepare(fixture.sourceRevision, "closeout/prepare");

  assert.deepEqual(plan.effects.map((effect) => [effect.effectKind, effect.required, effect.receipt]), [
    ["milestone-merge", true, null],
    ["integration-push", false, null],
  ]);
  assert.equal(readMilestoneLifecycleStatus("M001"), "ready");
  assert.equal(getMilestone("M001")?.status, "active");
});

test("milestone.complete is refused until the required effect has a Settlement Receipt", async () => {
  const fixture = await validatedMilestone();
  prepare(fixture.sourceRevision, "closeout/prepare");

  assert.throws(
    () => completeMilestone({
      invocation: invocation("closeout/complete-early"),
      milestoneId: "M001",
      sourceRevision: fixture.sourceRevision,
      closeout,
    }),
    /closeout effect milestone-merge has no Settlement Receipt/,
  );
  assert.throws(() => settleCloseout("M001"), /closeout effect milestone-merge has no Settlement Receipt/);
  assert.equal(getMilestone("M001")?.status, "active");

  recordSettlementReceipt({
    milestoneId: "M001",
    effectKind: "milestone-merge",
    outcome: "performed",
    externalRef: "abc123",
    proof: { commitSha: "abc123" },
  });
  const completion = settleCloseout("M001");

  assert.equal(completion?.canonicalStatus, "completed");
  assert.equal(completion?.closeout.title, "Closeout Plan");
  assert.equal(getMilestone("M001")?.status, "complete");
  // The push effect is not required: it stays open for the next closeout to retry.
  const pushEffect = readMilestoneCloseoutPlan("M001")!.effects[1]!;
  assert.equal(pushEffect.receipt, null);
});

test("a Settlement Receipt is recorded once and survives a repeated prepare", async () => {
  const fixture = await validatedMilestone();
  const plan = prepare(fixture.sourceRevision, "closeout/prepare");
  const receipt = recordSettlementReceipt({
    milestoneId: "M001",
    effectKind: "milestone-merge",
    outcome: "performed",
    externalRef: "abc123",
    proof: { commitSha: "abc123" },
  });

  const again = recordSettlementReceipt({
    milestoneId: "M001",
    effectKind: "milestone-merge",
    outcome: "performed",
    externalRef: "def456",
    proof: { commitSha: "def456" },
  });
  const prepared = prepare(fixture.sourceRevision, "closeout/prepare-retry");

  assert.equal(again.settlementReceiptId, receipt.settlementReceiptId);
  assert.equal(again.externalRef, "abc123");
  assert.equal(prepared.closeoutPlanId, plan.closeoutPlanId);
  assert.deepEqual(pendingRequiredCloseoutEffects(prepared), []);
  assert.equal(count("workflow_closeout_plans"), 1);
  assert.equal(count("workflow_settlement_receipts"), 1);
});

test("a later effect cannot settle before the required effect ahead of it", async () => {
  const fixture = await validatedMilestone();
  prepare(fixture.sourceRevision, "closeout/prepare");

  assert.throws(
    () => recordSettlementReceipt({
      milestoneId: "M001",
      effectKind: "integration-push",
      outcome: "performed",
      externalRef: "origin/main",
      proof: { remote: "origin" },
    }),
    /settlement receipt requires current plan and prior ordinal receipts/,
  );
  assert.equal(count("workflow_settlement_receipts"), 0);
});

test("prepareCloseout refuses a Milestone whose validation does not cover the current source", async () => {
  const fixture = await validatedMilestone();
  writeFileSync(join(fixture.basePath, "source.ts"), "export const source = 2;\n");

  assert.throws(
    () => prepare(sourceRevision(fixture.basePath), "closeout/prepare-drifted"),
    /canonical validation is not current/,
  );
  assert.equal(count("workflow_closeout_plans"), 0);
});

test("receipts of a plan prepared before a reopen do not settle the reopened Milestone", async () => {
  const fixture = await validatedMilestone();
  prepare(fixture.sourceRevision, "closeout/prepare");
  recordSettlementReceipt({
    milestoneId: "M001",
    effectKind: "milestone-merge",
    outcome: "performed",
    externalRef: "abc123",
    proof: { commitSha: "abc123" },
  });
  settleCloseout("M001");

  reopenMilestone({
    invocation: invocation("closeout/reopen"),
    milestoneId: "M001",
    reason: "More work is needed.",
  });

  assert.equal(readMilestoneCloseoutPlan("M001"), null);
});

// ─── Host effects: merge, push, completion order ─────────────────────────────

const completionParams = {
  milestoneId: "M001",
  title: "Closeout Plan",
  oneLiner: "Closed out one Milestone through a plan and receipts.",
  narrative: "The Milestone was prepared, its host effects settled, then it completed.",
  verificationPassed: true,
};

function mergeEffectReceipt() {
  return readMilestoneCloseoutPlan("M001")?.effects
    .find((effect) => effect.effectKind === "milestone-merge")?.receipt ?? null;
}

/**
 * M001 runs in its own worktree on `milestone/M001` and is validated there.
 * M002 depends on M001. `autoPush` adds a remote the push can be pointed at.
 */
async function milestoneInWorktree(options: { autoPush?: boolean; githubSync?: boolean } = {}): Promise<{
  repo: string;
  worktree: string;
  remote: string;
}> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gsd-closeout-merge-")));
  tempDirs.add(root);
  process.env.HOME = join(root, "home");
  process.env.GSD_HOME = join(root, "home", ".gsd");
  mkdirSync(process.env.GSD_HOME, { recursive: true });
  _clearGsdRootCache();
  _resetServiceCache();

  const repo = join(root, "repo");
  const remote = join(root, "origin.git");
  mkdirSync(repo);
  git(["init", "-b", "main"], repo);
  git(["config", "user.email", "test@example.com"], repo);
  git(["config", "user.name", "Test"], repo);
  writeFileSync(join(repo, ".gitignore"), ".gsd/\n.gsd-worktrees/\n");
  writeFileSync(join(repo, "feature.txt"), "base\n");
  git(["add", "."], repo);
  git(["commit", "-m", "init"], repo);
  git(["init", "--bare", remote], root);
  git(["remote", "add", "origin", remote], repo);
  git(["push", "origin", "main"], repo);

  const worktree = worktreePath(repo, "M001");
  git(["worktree", "add", "-b", "milestone/M001", worktree], repo);
  writeFileSync(join(worktree, "feature.txt"), "milestone work\n");
  git(["commit", "-am", "feat: milestone work"], worktree);

  for (const base of [repo, worktree]) {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    if (options.autoPush || options.githubSync) {
      writeFileSync(
        join(base, ".gsd", "PREFERENCES.md"),
        "---\nversion: 1\n" +
          (options.autoPush ? "git:\n  auto_push: true\n" : "") +
          (options.githubSync ? "github:\n  enabled: true\n  repo: owner/repo\n" : "") +
          "---\n",
      );
    }
  }

  if (options.githubSync) {
    // `.gsd` is a real directory in the worktree, so the mapping the run
    // wrote there is not in the project root.
    const mapping = createEmptyMapping("owner/repo");
    setMilestoneRecord(mapping, "M001", {
      issueNumber: 10,
      ghMilestoneNumber: 3,
      lastSyncedAt: "2025-01-01T00:00:00Z",
      state: "open",
    });
    writeFileSync(join(worktree, ".gsd", "github-sync.json"), JSON.stringify(mapping));
  }

  assert.equal(openDatabase(join(repo, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Closeout Plan", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "complete" });
  insertMilestone({ id: "M002", title: "Dependent", status: "queued", depends_on: ["M001"] });
  atFence("fixture/adopt", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "ready",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "slice", milestoneId: "M001", sliceId: "S01", lifecycleStatus: "completed",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01", lifecycleStatus: "completed",
    });
  });
  const validated = await handleValidateMilestone({
    milestoneId: "M001",
    verdict: "pass",
    remediationRound: 0,
    successCriteriaChecklist: "- [x] Complete",
    sliceDeliveryAudit: "| S01 | delivered |",
    crossSliceIntegration: "Passed",
    requirementCoverage: "Covered",
    verificationClasses: "| Class | Evidence | Verdict |\n| --- | --- | --- |\n| Contract | focused test | PASS |",
    verdictRationale: "All current database evidence passes.",
  }, worktree, { invocation: invocation("fixture/validate"), skipBrowserEvidenceGate: true });
  assert.ok(!("error" in validated), `validation fixture failed: ${"error" in validated ? validated.error : ""}`);

  process.chdir(worktree);
  const prepared = await handleCompleteMilestone(completionParams, worktree, invocation("tool/complete"));
  assert.ok(!("error" in prepared), `closeout fixture failed: ${"error" in prepared ? prepared.error : ""}`);
  assert.deepEqual(prepared.pendingCloseoutEffects, ["milestone-merge"]);
  return { repo, worktree, remote };
}

function commitOnMain(repo: string, content: string): void {
  writeFileSync(join(repo, "feature.txt"), content);
  git(["commit", "-am", "chore: change on main"], repo);
}

const ROADMAP = "# M001: Closeout Plan\n- [x] **S01: Done**\n";

test("the Milestone stays open after gsd_complete_milestone and completes when the merge settles", async () => {
  const { repo, worktree } = await milestoneInWorktree();
  assert.equal(getMilestone("M001")?.status, "active");
  assert.equal(readMilestoneLifecycleStatus("M001"), "ready");
  // The prepared plan is the result of the complete-milestone unit, so the
  // auto loop goes on to the merge instead of dispatching the unit again.
  assert.equal(verifyExpectedArtifact("complete-milestone", "M001", worktree), true);

  mergeMilestoneToMain(repo, "M001", ROADMAP);

  assert.equal(git(["show", "main:feature.txt"], repo), "milestone work");
  const receipt = mergeEffectReceipt();
  assert.equal(receipt?.outcome, "performed");
  assert.equal(receipt?.externalRef, git(["rev-parse", "main"], repo));
  assert.equal(getMilestone("M001")?.status, "complete");
  assert.equal(readMilestoneLifecycleStatus("M001"), "completed");
  assert.equal(existsSync(worktree), false);
});

test("a merge conflict leaves the Milestone open and its dependent locked", async () => {
  const { repo, worktree } = await milestoneInWorktree();
  commitOnMain(repo, "conflicting change on main\n");

  assert.throws(() => mergeMilestoneToMain(repo, "M001", ROADMAP), MergeConflictError);

  assert.equal(mergeEffectReceipt(), null);
  assert.equal(getMilestone("M001")?.status, "active");
  assert.equal(readMilestoneLifecycleStatus("M001"), "ready");
  assert.equal(existsSync(worktree), true);
  invalidateStateCache();
  const state = await deriveState(repo);
  assert.equal(state.activeMilestone?.id, "M001");
  assert.notEqual(state.registry.find((entry) => entry.id === "M002")?.status, "active");
});

/** GitHub sync is on and every close call to GitHub is counted. */
function countGitHubCloses(): { calls: number } {
  const closes = { calls: 0 };
  _setGhAvailableForTest(true);
  _setGhRateLimitOkForTest(true);
  _setGhCloseOverridesForTest({
    closeIssue: () => { closes.calls++; return { ok: true }; },
    closeMilestone: () => { closes.calls++; return { ok: true }; },
  });
  return closes;
}

function githubCloseReceipt() {
  return readMilestoneCloseoutPlan("M001")?.effects
    .find((effect) => effect.effectKind === "github-milestone-close")?.receipt ?? null;
}

test("a merge conflict leaves the GitHub milestone open and the later merge closes it once", async () => {
  const { repo, worktree } = await milestoneInWorktree({ githubSync: true });
  const closes = countGitHubCloses();
  commitOnMain(repo, "conflicting change on main\n");

  // The post-unit step of complete-milestone runs before the merge.
  await runMilestoneCloseoutGitHub(worktree, "M001");
  assert.throws(() => mergeMilestoneToMain(repo, "M001", ROADMAP), MergeConflictError);

  assert.equal(getMilestone("M001")?.status, "active");
  assert.equal(closes.calls, 0);
  assert.equal(githubCloseReceipt(), null);
  assert.equal(loadSyncMapping(worktree)?.milestones.M001?.state, "open");

  // The user resolves the conflict by hand; the next run finishes the merge.
  git(["merge", "--no-ff", "-X", "theirs", "-m", "manual merge", "milestone/M001"], repo);
  mergeMilestoneToMain(repo, "M001", ROADMAP);

  assert.equal(getMilestone("M001")?.status, "complete");
  assert.equal(closes.calls, 2, "one issue close and one milestone close");
  assert.equal(githubCloseReceipt()?.outcome, "performed");

  await runMilestoneCloseoutGitHub(repo, "M001");
  assert.equal(closes.calls, 2);
});

test("the GitHub close finds the milestone when the mapping was only in the removed worktree", async () => {
  const { repo, worktree } = await milestoneInWorktree({ githubSync: true });
  const closes = countGitHubCloses();
  assert.equal(loadSyncMapping(repo), null);

  mergeMilestoneToMain(repo, "M001", ROADMAP);

  assert.equal(existsSync(worktree), false);
  assert.equal(closes.calls, 2, "one issue close and one milestone close");
  assert.equal(githubCloseReceipt()?.externalRef, "owner/repo#10");
  assert.equal(loadSyncMapping(repo)?.milestones.M001?.state, "closed");
});

test("a GitHub close that fails keeps no receipt and the resumed closeout closes it once", async () => {
  const { repo, worktree } = await milestoneInWorktree({ githubSync: true });
  const closes = countGitHubCloses();
  _setGhAvailableForTest(false);
  _setPreTeardownSafetyDepsForTests({
    existsSync: () => { throw new Error("process stopped before cleanup"); },
  });
  assert.throws(() => mergeMilestoneToMain(repo, "M001", ROADMAP), /process stopped before cleanup/);
  _resetPreTeardownSafetyDepsForTests();
  assert.equal(getMilestone("M001")?.status, "complete");
  assert.equal(githubCloseReceipt(), null);

  _setGhAvailableForTest(true);
  process.chdir(worktree);
  mergeMilestoneToMain(repo, "M001", ROADMAP);

  assert.equal(closes.calls, 2);
  assert.equal(githubCloseReceipt()?.outcome, "performed");
});

test("a GitHub close that fails keeps the push receipt and the next pass retries only the close", async () => {
  const { repo, worktree, remote } = await milestoneInWorktree({ autoPush: true, githubSync: true });
  const closes = countGitHubCloses();
  const effects = () => readMilestoneCloseoutPlan("M001")!.effects
    .map((effect) => [effect.effectKind, effect.receipt?.settlementReceiptId ?? null]);
  _setGhAvailableForTest(false);
  _setPreTeardownSafetyDepsForTests({
    existsSync: () => { throw new Error("process stopped before cleanup"); },
  });
  assert.throws(() => mergeMilestoneToMain(repo, "M001", ROADMAP), /process stopped before cleanup/);
  _resetPreTeardownSafetyDepsForTests();

  const [merge, push, close] = effects();
  assert.deepEqual([merge[0], push[0], close[0]], ["milestone-merge", "integration-push", "github-milestone-close"]);
  assert.equal(git(["rev-parse", "main"], remote), git(["rev-parse", "main"], repo));
  assert.ok(push[1], "the push receipt is recorded while the GitHub close is pending");
  assert.equal(close[1], null);
  assert.equal(closes.calls, 0);

  _setGhAvailableForTest(true);
  process.chdir(worktree);
  mergeMilestoneToMain(repo, "M001", ROADMAP);

  assert.equal(closes.calls, 2, "one issue close and one milestone close");
  assert.equal(githubCloseReceipt()?.outcome, "performed");
  assert.deepEqual(effects().slice(0, 2), [merge, push], "the merge and the push are not settled again");
});

test("the GitHub close waits for the push receipt and runs when a later push settles it", async () => {
  const { repo, remote } = await milestoneInWorktree({ autoPush: true, githubSync: true });
  const closes = countGitHubCloses();
  git(["remote", "set-url", "origin", join(remote, "missing")], repo);

  mergeMilestoneToMain(repo, "M001", ROADMAP);

  assert.equal(getMilestone("M001")?.status, "complete");
  assert.equal(closes.calls, 0);
  assert.equal(githubCloseReceipt(), null);

  git(["remote", "set-url", "origin", remote], repo);
  publishMilestone({
    basePath: repo,
    milestoneId: "M002",
    milestoneTitle: "Dependent",
    integrationBranch: "main",
    milestoneBranch: "milestone/M002",
    sliceSummaries: [],
    nothingToCommit: true,
    prefs: { autoPush: true, autoPr: false },
  });

  assert.equal(closes.calls, 2, "one issue close and one milestone close");
  assert.equal(githubCloseReceipt()?.outcome, "performed");
});

test("a recognized squash merge finishes cleanup when the integration branch has files of its own", async () => {
  const { repo, worktree } = await milestoneInWorktree();
  // Main has work the milestone branch never saw, then gets the milestone
  // work through a squash merge done by hand.
  writeFileSync(join(repo, "other.txt"), "work of another milestone\n");
  git(["add", "other.txt"], repo);
  git(["commit", "-m", "feat: other milestone"], repo);
  git(["merge", "--squash", "milestone/M001"], repo);
  git(["commit", "-m", "feat: milestone work by hand"], repo);
  const mainHead = git(["rev-parse", "main"], repo);

  _setPreTeardownSafetyDepsForTests({
    existsSync: () => { throw new Error("process stopped before cleanup"); },
  });
  assert.throws(() => mergeMilestoneToMain(repo, "M001", ROADMAP), /process stopped before cleanup/);
  _resetPreTeardownSafetyDepsForTests();
  assert.equal(mergeEffectReceipt()?.outcome, "recognized");
  assert.equal(getMilestone("M001")?.status, "complete");
  assert.equal(existsSync(worktree), true);

  process.chdir(worktree);
  mergeMilestoneToMain(repo, "M001", ROADMAP);

  assert.equal(git(["rev-parse", "main"], repo), mainHead);
  assert.equal(existsSync(worktree), false);
  assert.equal(git(["branch", "--list", "milestone/M001"], repo), "");
});

test("a run that stops after the merge commit finishes from the receipt without a second merge", async () => {
  const { repo, worktree } = await milestoneInWorktree();
  _setPreTeardownSafetyDepsForTests({
    existsSync: () => { throw new Error("process stopped before cleanup"); },
  });
  assert.throws(() => mergeMilestoneToMain(repo, "M001", ROADMAP), /process stopped before cleanup/);
  _resetPreTeardownSafetyDepsForTests();
  const mergeCommit = git(["rev-parse", "main"], repo);
  assert.equal(mergeEffectReceipt()?.externalRef, mergeCommit);
  assert.equal(getMilestone("M001")?.status, "complete");
  assert.equal(existsSync(worktree), true);
  // The receipt, not the leftover worktree, says whether the merge is done.
  assert.deepEqual(
    evaluateAllCompleteSettlement({
      milestoneId: "M001",
      statePhase: "complete",
      basePath: worktree,
      originalBasePath: repo,
      milestoneMerged: false,
    }),
    { ok: true, reason: "settled" },
  );

  // Main moves on. A second squash merge of the same branch would now conflict.
  commitOnMain(repo, "later change on main\n");
  const mainHead = git(["rev-parse", "main"], repo);
  process.chdir(worktree);

  mergeMilestoneToMain(repo, "M001", ROADMAP);

  assert.equal(git(["rev-parse", "main"], repo), mainHead);
  assert.equal(git(["show", "main:feature.txt"], repo), "later change on main");
  assert.equal(existsSync(worktree), false);
  assert.equal(git(["branch", "--list", "milestone/M001"], repo), "");
});

/** The merge commits and settles, then the process stops before the worktree and branch are removed. */
function mergeAndStopBeforeCleanup(repo: string): void {
  _setPreTeardownSafetyDepsForTests({
    existsSync: () => { throw new Error("process stopped before cleanup"); },
  });
  assert.throws(() => mergeMilestoneToMain(repo, "M001", ROADMAP), /process stopped before cleanup/);
  _resetPreTeardownSafetyDepsForTests();
  process.chdir(repo);
}

test("a leftover branch of a squash-merged Milestone is not reported as unmerged once main moves on", async () => {
  const { repo, worktree } = await milestoneInWorktree();
  mergeAndStopBeforeCleanup(repo);
  // Git has no record of the squash merge: after this commit the branch
  // differs from main and is not its ancestor.
  commitOnMain(repo, "later change on main\n");
  assert.notEqual(git(["diff", "--name-only", "main", "milestone/M001"], repo), "");

  assert.deepEqual(await findUnmergedCompletedMilestones(repo), []);

  // The receipt covers the branch only up to the merged commit.
  writeFileSync(join(worktree, "late.txt"), "work after the merge\n");
  git(["add", "late.txt"], worktree);
  git(["commit", "-m", "feat: work after the merge"], worktree);

  const [blocker] = await findUnmergedCompletedMilestones(repo);
  assert.equal(blocker?.milestoneId, "M001");
  assert.ok(blocker?.files.includes("late.txt"));
});

test("a merge commit dropped from the integration branch is reported as unmerged and the branch is kept", async () => {
  const { repo, worktree } = await milestoneInWorktree();
  mergeAndStopBeforeCleanup(repo);
  const branchTip = git(["rev-parse", "milestone/M001"], repo);
  // The receipt still names the merge commit, but main no longer has it.
  git(["reset", "--hard", "HEAD~1"], repo);
  assert.equal(git(["show", "main:feature.txt"], repo), "base");

  const [blocker] = await findUnmergedCompletedMilestones(repo);
  assert.equal(blocker?.milestoneId, "M001");
  assert.deepEqual(blocker?.files, ["feature.txt"]);

  process.chdir(worktree);
  assert.throws(() => mergeMilestoneToMain(repo, "M001", ROADMAP), /is not on main/);

  assert.equal(git(["rev-parse", "milestone/M001"], repo), branchTip);
  assert.equal(existsSync(worktree), true);
});

test("a failed push leaves the push effect without a receipt and the next closeout pushes again", async () => {
  const { repo, remote } = await milestoneInWorktree({ autoPush: true });
  const pushEffect = () => readMilestoneCloseoutPlan("M001")!.effects
    .find((effect) => effect.effectKind === "integration-push")!;
  git(["remote", "set-url", "origin", join(remote, "missing")], repo);

  const merged = mergeMilestoneToMain(repo, "M001", ROADMAP);

  assert.equal(merged.pushed, false);
  assert.equal(getMilestone("M001")?.status, "complete");
  assert.equal(pushEffect().receipt, null);

  git(["remote", "set-url", "origin", remote], repo);
  const retried = publishMilestone({
    basePath: repo,
    milestoneId: "M002",
    milestoneTitle: "Dependent",
    integrationBranch: "main",
    milestoneBranch: "milestone/M002",
    sliceSummaries: [],
    nothingToCommit: true,
    prefs: { autoPush: true, autoPr: false },
  });

  assert.equal(retried.pushed, true);
  assert.equal(git(["rev-parse", "main"], remote), git(["rev-parse", "main"], repo));
  assert.equal(pushEffect().receipt?.externalRef, "origin/main");
});

test("a branch that is already merged is recognized and the Milestone completes", async () => {
  const { repo } = await milestoneInWorktree();
  git(["merge", "--no-ff", "-m", "manual merge", "milestone/M001"], repo);
  const mainHead = git(["rev-parse", "main"], repo);

  mergeMilestoneToMain(repo, "M001", ROADMAP);

  assert.equal(git(["rev-parse", "main"], repo), mainHead);
  assert.equal(mergeEffectReceipt()?.outcome, "recognized");
  assert.equal(getMilestone("M001")?.status, "complete");
});

/** The merge is skipped the way a session with degraded isolation skips it. */
function skipMergeUnderDegradedIsolation(repo: string, worktree: string) {
  return mergeMilestoneStandalone(
    {
      gitServiceFactory: () => { throw new Error("not used"); },
      worktreeProjection: new WorktreeStateProjection(),
      mergeMilestone: () => { throw new Error("the merge must be skipped"); },
    },
    {
      originalBasePath: repo,
      worktreeBasePath: worktree,
      milestoneId: "M001",
      isolationDegraded: true,
      notify: () => {},
    },
  );
}

test("a skipped merge recognizes the effect when the milestone branch is already merged", async () => {
  const { repo, worktree } = await milestoneInWorktree();
  git(["merge", "--no-ff", "-m", "manual merge", "milestone/M001"], repo);

  const result = skipMergeUnderDegradedIsolation(repo, worktree);

  assert.equal(result.merged, false);
  assert.equal(mergeEffectReceipt()?.outcome, "recognized");
  assert.equal(getMilestone("M001")?.status, "complete");
});

test("a skipped merge keeps the Milestone open while the milestone branch has unmerged work", async () => {
  const { repo, worktree } = await milestoneInWorktree();
  const branchTip = git(["rev-parse", "milestone/M001"], repo);

  assert.throws(() => skipMergeUnderDegradedIsolation(repo, worktree), /milestone\/M001 is not merged/);

  assert.equal(mergeEffectReceipt(), null);
  assert.equal(getMilestone("M001")?.status, "active");
  assert.equal(readMilestoneLifecycleStatus("M001"), "ready");
  assert.equal(git(["rev-parse", "milestone/M001"], repo), branchTip);
  assert.equal(git(["show", "main:feature.txt"], repo), "base");

  // The later merge is a real merge: the work reaches main before the branch goes.
  process.chdir(worktree);
  mergeMilestoneToMain(repo, "M001", ROADMAP);

  assert.equal(git(["show", "main:feature.txt"], repo), "milestone work");
  assert.equal(mergeEffectReceipt()?.outcome, "performed");
  assert.equal(getMilestone("M001")?.status, "complete");
});

test("a recognized receipt does not let the merge delete a branch whose work is not on the integration branch", async () => {
  const { repo, worktree } = await milestoneInWorktree();
  const branchTip = git(["rev-parse", "milestone/M001"], repo);
  const mainHead = git(["rev-parse", "main"], repo);
  recordSettlementReceipt({
    milestoneId: "M001",
    effectKind: "milestone-merge",
    outcome: "recognized",
    externalRef: mainHead,
    proof: { commitSha: mainHead, integrationBranch: "main", milestoneBranchSha: branchTip, codeFilesChanged: true },
  });

  assert.throws(() => mergeMilestoneToMain(repo, "M001", ROADMAP), /recorded as already merged, but its work is not on main/);

  assert.equal(git(["rev-parse", "milestone/M001"], repo), branchTip);
  assert.equal(existsSync(worktree), true);
  assert.equal(git(["rev-parse", "main"], repo), mainHead);
});

test("a plan that waits for a branch merged and deleted by hand is superseded and the Milestone completes", async () => {
  const { repo, worktree } = await milestoneInWorktree();
  process.chdir(repo);
  git(["merge", "milestone/M001"], repo);
  git(["worktree", "remove", "--force", worktree], repo);
  git(["branch", "-D", "milestone/M001"], repo);

  assert.throws(
    () => mergeMilestoneToMain(repo, "M001", ROADMAP),
    /milestone\/M001 does not exist, so there is nothing to merge.*\/gsd dispatch complete-milestone M001/,
  );
  assert.equal(getMilestone("M001")?.status, "active");

  const completed = await handleCompleteMilestone(completionParams, repo, invocation("tool/complete-after-manual-merge"));

  assert.ok(!("error" in completed), `completion failed: ${"error" in completed ? completed.error : ""}`);
  assert.equal(completed.pendingCloseoutEffects, undefined);
  assert.deepEqual(readMilestoneCloseoutPlan("M001")?.effects, []);
  assert.equal(getMilestone("M001")?.status, "complete");
  assert.equal(readMilestoneLifecycleStatus("M001"), "completed");
  assert.equal(git(["show", "main:feature.txt"], repo), "milestone work");
});

// The fixture sets no isolation preference, so the mode is `none`: the plan
// has a merge effect only because the tool ran inside the worktree.

test("with isolation none, a call from the project root keeps the merge of the live worktree required", async () => {
  const { repo, worktree } = await milestoneInWorktree();
  process.chdir(repo);

  const result = await handleCompleteMilestone(completionParams, repo, invocation("tool/complete-root"));

  assert.ok(!("error" in result), `closeout failed: ${"error" in result ? result.error : ""}`);
  assert.deepEqual(result.pendingCloseoutEffects, ["milestone-merge"]);
  assert.equal(readMilestoneLifecycleStatus("M001"), "ready");
  assert.equal(getMilestone("M001")?.status, "active");
  assert.equal(git(["show", "main:feature.txt"], repo), "base");

  process.chdir(worktree);
  mergeMilestoneToMain(repo, "M001", ROADMAP);

  assert.equal(git(["show", "main:feature.txt"], repo), "milestone work");
  assert.equal(readMilestoneLifecycleStatus("M001"), "completed");
});

test("with isolation none and the worktree removed, the root completes only on a validation of its own source", async () => {
  const { repo, worktree } = await milestoneInWorktree();
  process.chdir(repo);
  git(["worktree", "remove", "--force", worktree], repo);
  const branchTip = git(["rev-parse", "milestone/M001"], repo);
  const mainHead = git(["rev-parse", "main"], repo);

  // The validation covers the source of the milestone branch, not of the root.
  const stale = await handleCompleteMilestone(completionParams, repo, invocation("tool/complete-root-stale"));
  assert.ok("error" in stale && /canonical validation is not current/.test(stale.error), JSON.stringify(stale));
  assert.equal(readMilestoneLifecycleStatus("M001"), "ready");

  const validated = await handleValidateMilestone({
    milestoneId: "M001",
    verdict: "pass",
    remediationRound: 0,
    successCriteriaChecklist: "- [x] Complete",
    sliceDeliveryAudit: "| S01 | delivered |",
    crossSliceIntegration: "Passed",
    requirementCoverage: "Covered",
    verificationClasses: "| Class | Evidence | Verdict |\n| --- | --- | --- |\n| Contract | focused test | PASS |",
    verdictRationale: "The source at the project root passes.",
  }, repo, { invocation: invocation("fixture/validate-root"), skipBrowserEvidenceGate: true });
  assert.ok(!("error" in validated), `validation failed: ${"error" in validated ? validated.error : ""}`);
  const completed = await handleCompleteMilestone(completionParams, repo, invocation("tool/complete-root"));

  assert.ok(!("error" in completed), `completion failed: ${"error" in completed ? completed.error : ""}`);
  assert.equal(completed.pendingCloseoutEffects, undefined);
  assert.deepEqual(readMilestoneCloseoutPlan("M001")?.effects, []);
  assert.equal(readMilestoneLifecycleStatus("M001"), "completed");
  assert.equal(git(["rev-parse", "milestone/M001"], repo), branchTip);
  assert.equal(git(["rev-parse", "main"], repo), mainHead);
});

test("after a conflict resolved by hand, a new validation lets the tool complete the Milestone", async () => {
  const { repo, worktree } = await milestoneInWorktree();
  commitOnMain(repo, "conflicting change on main\n");
  assert.throws(() => mergeMilestoneToMain(repo, "M001", ROADMAP), MergeConflictError);
  process.chdir(repo);
  commitOnMain(repo, "resolved by hand\n");
  git(["worktree", "remove", "--force", worktree], repo);
  git(["branch", "-D", "milestone/M001"], repo);

  const stale = await handleCompleteMilestone(completionParams, repo, invocation("tool/complete-stale"));
  assert.ok("error" in stale && /canonical validation is not current/.test(stale.error), JSON.stringify(stale));
  assert.equal(getMilestone("M001")?.status, "active");

  const validated = await handleValidateMilestone({
    milestoneId: "M001",
    verdict: "pass",
    remediationRound: 0,
    successCriteriaChecklist: "- [x] Complete",
    sliceDeliveryAudit: "| S01 | delivered |",
    crossSliceIntegration: "Passed",
    requirementCoverage: "Covered",
    verificationClasses: "| Class | Evidence | Verdict |\n| --- | --- | --- |\n| Contract | focused test | PASS |",
    verdictRationale: "The resolved merge passes.",
  }, repo, { invocation: invocation("fixture/validate-resolved"), skipBrowserEvidenceGate: true });
  assert.ok(!("error" in validated), `validation failed: ${"error" in validated ? validated.error : ""}`);
  const completed = await handleCompleteMilestone(completionParams, repo, invocation("tool/complete-resolved"));

  assert.ok(!("error" in completed), `completion failed: ${"error" in completed ? completed.error : ""}`);
  assert.equal(getMilestone("M001")?.status, "complete");
  assert.equal(readMilestoneLifecycleStatus("M001"), "completed");
});

test("the interactive closeout notice says a prepared Milestone is not complete yet", async () => {
  const { worktree } = await milestoneInWorktree();
  const notices: string[] = [];

  const result = closeUnit(
    { basePath: worktree, unitType: "complete-milestone", unitId: "M001", boundary: "milestone", outcome: "complete" },
    {
      isolationMode: () => "worktree",
      currentBranch: () => "milestone/M001",
      commit: () => null,
      notify: (message) => { notices.push(message); },
    },
  );

  assert.equal(result.gitVerdict, "milestone-branch");
  assert.match(notices[0] ?? "", /closeout is prepared on milestone\/M001.*\/gsd dispatch complete-milestone M001/);
});

test("deleting META.json does not change the branch the Milestone merges to", async () => {
  const { repo } = await milestoneInWorktree();
  git(["checkout", "-b", "release"], repo);
  writeIntegrationBranch(repo, "M001", "release");
  assert.equal(existsSync(milestoneMetaPath(repo, "M001")), true);

  rmSync(milestoneMetaPath(repo, "M001"));

  assert.equal(readIntegrationBranch(repo, "M001"), "release");
  mergeMilestoneToMain(repo, "M001", ROADMAP);
  assert.equal(git(["show", "release:feature.txt"], repo), "milestone work");
  assert.equal(git(["show", "main:feature.txt"], repo), "base");
});
