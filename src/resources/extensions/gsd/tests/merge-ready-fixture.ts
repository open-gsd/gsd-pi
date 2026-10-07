import { join } from "node:path";

import {
  _getAdapter,
  closeDatabase,
  getMilestone,
  insertAssessment,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../gsd-db.ts";
import { readMilestoneSlices, readSliceTasks } from "../db/lifecycle-read.ts";
import { executeDomainOperation } from "../db/domain-operation.ts";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
} from "../db/writers/lifecycle-commands.ts";
import { projectCanonicalStatusToLegacy } from "../db/writers/status.ts";
import { validateMilestone } from "../milestone-validation-domain-operation.ts";
import { captureMilestoneVerificationSourceRevision } from "../verification-source-integrity.ts";
import { invalidateStateCache } from "../state.ts";
import { seedLifecycles } from "./helpers/authority-cutover.ts";

const FIXTURE_COMPLETED_AT = "2026-07-14T12:00:00.000Z";

export function seedMergeReadyMilestone(repo: string, milestoneId: string): void {
  closeDatabase();
  try {
    if (!openDatabase(join(repo, ".gsd", "gsd.db"))) {
      throw new Error(`Could not open canonical DB for ${milestoneId}`);
    }
    insertMilestone({ id: milestoneId, title: `${milestoneId} Test Milestone`, status: "complete" });
    insertSlice({ id: "S01", milestoneId, title: "Test Slice", status: "complete" });
    insertTask({ id: "T01", sliceId: "S01", milestoneId, title: "Test Task", status: "complete" });
    insertAssessment({
      path: `milestones/${milestoneId}/${milestoneId}-VALIDATION.md`,
      milestoneId,
      status: "pass",
      scope: "milestone-validation",
      fullContent: "verdict: pass",
    });
  } finally {
    closeDatabase();
  }
}

export interface CanonicalMergeReadyOptions {
  /**
   * The tree whose content hash the validation receipt binds to. The merge
   * guards re-capture this snapshot from the milestone's canonical root (the
   * live worktree when one exists), so worktree-isolated fixtures pass the
   * worktree here. Defaults to the project root.
   */
  sourceTree?: string;
}

interface SeedAdoptedOptions extends CanonicalMergeReadyOptions {
  /** Ignored; a milestone with no slices always gets the closed S01/T01 pair. */
  withClosedSlice?: boolean;
}

const FIXTURE_VERDICT_PROFILES = {
  pass: {
    outcome: "succeeded" as const,
    failureClass: "none",
    observation: "passed" as const,
    exitCode: 0,
    rationale: "Fixture proof recorded.",
  },
  fail: {
    outcome: "failed" as const,
    failureClass: "validation-fail",
    observation: "failed" as const,
    exitCode: 1,
    rationale: "Fixture proof failed.",
  },
  inconclusive: {
    outcome: "interrupted" as const,
    failureClass: "validation-inconclusive",
    observation: "inconclusive" as const,
    exitCode: 1,
    rationale: "Fixture proof needs attention.",
  },
};

/**
 * Adopt the milestone (and any existing slice/task rows) under an open ready
 * lifecycle, then record one canonical validation receipt. The Milestone stays
 * open: completion is the caller's decision.
 */
function seedAdoptedMilestoneAndRecordValidation(
  repo: string,
  milestoneId: string,
  verdict: "pass" | "fail" | "inconclusive",
  options: SeedAdoptedOptions,
): void {
  if (!openDatabase(join(repo, ".gsd", "gsd.db"))) {
    throw new Error(`Could not open canonical DB for ${milestoneId}`);
  }
  if (!getMilestone(milestoneId)) {
    insertMilestone({ id: milestoneId, title: `${milestoneId} Test Milestone`, status: "active" });
  }
  // The closeout consistency gate requires slice rows, so an empty milestone
  // gets the closed S01/T01 pair.
  if (readMilestoneSlices(milestoneId).length === 0) {
    insertSlice({ id: "S01", milestoneId, title: "Test Slice", status: "complete" });
    insertTask({ id: "T01", sliceId: "S01", milestoneId, title: "Test Task", status: "complete" });
  }
  // seedLifecycles' projection keys are normalized lowercase.
  const lifecycleKey = milestoneId.toLowerCase();
  seedLifecycles(`merge-ready-fixture/${lifecycleKey}/adopt`, [
    { itemKind: "milestone", milestoneId, lifecycleStatus: "ready" },
    ...readMilestoneSlices(milestoneId).map((slice) => ({
      itemKind: "slice" as const,
      milestoneId,
      sliceId: slice.id,
      lifecycleStatus: slice.closed ? ("completed" as const) : ("ready" as const),
    })),
    ...readMilestoneSlices(milestoneId).flatMap((slice) =>
      readSliceTasks(milestoneId, slice.id).map((task) => ({
        itemKind: "task" as const,
        milestoneId,
        sliceId: slice.id,
        taskId: task.id,
        lifecycleStatus: task.done ? ("completed" as const) : ("ready" as const),
      })),
    ),
  ]);
  const source = captureMilestoneVerificationSourceRevision(options.sourceTree ?? repo, undefined);
  if (!source.ok) {
    throw new Error(`verification source snapshot failed for ${milestoneId}: ${source.error}`);
  }
  const profile = FIXTURE_VERDICT_PROFILES[verdict];
  const validation = validateMilestone({
    invocation: {
      idempotencyKey: `merge-ready-fixture/${lifecycleKey}/validate/${verdict}`,
      sourceTransport: "internal",
      actorType: "agent",
      actorId: "merge-ready-fixture",
    },
    milestoneId,
    testedSourceRevision: source.sourceRevision,
    policyId: "merge-ready-fixture",
    policyVersion: "1",
    verdict,
    rationale: `Fixture validation recorded through the canonical operation (${verdict}).`,
    outcome: profile.outcome,
    failureClass: profile.failureClass,
    summary: "Fixture checks completed.",
    output: { testedSourceRevision: source.sourceRevision },
    criteria: [{
      criterionKey: "fixture-proof",
      evidenceClass: "command",
      description: "Fixture proof passes.",
      verdict,
      rationale: profile.rationale,
      evidence: [{
        evidenceClass: "command",
        commandOrTool: "node --test fixture-proof",
        workingDirectory: ".",
        startedAt: FIXTURE_COMPLETED_AT,
        endedAt: FIXTURE_COMPLETED_AT,
        exitCode: profile.exitCode,
        observation: profile.observation,
        durableOutputRef: `db://merge-ready-fixture/${milestoneId}`,
        environment: { runner: "node-test" },
      }],
    }],
  });
  if (validation.verdict !== verdict) {
    throw new Error(`fixture validation failed for ${milestoneId}`);
  }
  invalidateStateCache();
}

/**
 * Seed an adopted, open Milestone with one recorded canonical validation
 * receipt. For the suites whose guards read the recorded verdict; the
 * Milestone stays open.
 */
export function seedCanonicalMilestoneValidation(
  repo: string,
  milestoneId: string,
  verdict: "pass" | "fail" | "inconclusive",
  options: CanonicalMergeReadyOptions & { withClosedSlice?: boolean } = {},
): void {
  closeDatabase();
  try {
    seedAdoptedMilestoneAndRecordValidation(repo, milestoneId, verdict, options);
  } finally {
    closeDatabase();
  }
}

/**
 * Seed a merge-ready Milestone through the canonical path: adopted lifecycle
 * rows, a recorded passing validation receipt, then terminal completion. The
 * merge and settlement guards read canonical closeout state only, so legacy
 * rows alone cannot prove a Milestone merge-ready.
 */
export function seedCanonicalMergeReadyMilestone(
  repo: string,
  milestoneId: string,
  options: CanonicalMergeReadyOptions = {},
): void {
  closeDatabase();
  try {
    // The canonical order records validation while the Milestone is open, so
    // the legacy row is pulled back until completion is recorded below.
    if (openDatabase(join(repo, ".gsd", "gsd.db")) && getMilestone(milestoneId)) {
      _getAdapter()!.prepare("UPDATE milestones SET status = 'active', completed_at = NULL WHERE id = :id")
        .run({ ":id": milestoneId });
      closeDatabase();
    }
    seedAdoptedMilestoneAndRecordValidation(repo, milestoneId, "pass", options);
    if (!openDatabase(join(repo, ".gsd", "gsd.db"))) {
      throw new Error(`Could not open canonical DB for ${milestoneId}`);
    }
    // A Milestone lifecycle reaches completed only through a real
    // milestone.complete Domain Operation (v43 transition trigger), which
    // also projects the legacy completion.
    const fence = readDomainOperationFence();
    executeDomainOperation({
      operationType: "milestone.complete",
      idempotencyKey: `merge-ready-fixture/${milestoneId.toLowerCase()}/complete`,
      expectedRevision: fence.revision,
      expectedAuthorityEpoch: fence.authorityEpoch,
      actorType: "test",
      sourceTransport: "test",
      payload: { milestoneId },
    }, (context) => {
      const lifecycle = adoptOrTransitionLifecycle(context, {
        itemKind: "milestone",
        milestoneId,
        lifecycleStatus: "completed",
      });
      projectCanonicalStatusToLegacy(context, {
        entity: "milestone",
        milestoneId,
        status: "complete",
        completedAt: FIXTURE_COMPLETED_AT,
      });
      return {
        events: [{
          eventType: "milestone.completed",
          entityType: "milestone",
          entityId: milestoneId,
          payload: {
            milestoneLifecycleId: lifecycle.lifecycleId,
            completedAt: FIXTURE_COMPLETED_AT,
            closeout: {
              title: `${milestoneId} Test Milestone`,
              oneLiner: "Complete",
              narrative: "Completed through the canonical fixture receipt.",
              successCriteriaResults: "Passed.",
              definitionOfDoneResults: "Passed.",
              requirementOutcomes: "Passed.",
              keyDecisions: [],
              keyFiles: [],
              lessonsLearned: [],
              followUps: "",
              deviations: "",
            },
          },
          destinations: ["projection"],
        }],
        projections: [{
          projectionKey: `merge-ready-fixture/${milestoneId.toLowerCase()}/complete`,
          projectionKind: "milestone-lifecycle",
          rendererVersion: "1",
        }],
      };
    });
    invalidateStateCache();
  } finally {
    closeDatabase();
  }
}
